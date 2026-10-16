'use strict';
/**
 * brain.js — the pi brain(s), hard-locked in a Docker sandbox.
 *
 * Every ask spawns:
 *   docker run --rm -i -u 1000:1000 -v <workspace>:/workspace \
 *     -v <pi-config>:/home/node/.pi/agent ... wa-orchestrator-sandbox \
 *     pi --mode rpc --no-session --provider gd --model <lock>
 *
 * The container's pi knows exactly ONE model (the lock) and ONE provider (gd).
 *
 * Brain profiles (config.brains):
 *   kind "beads" — a beads repo mounted at /workspace; list/create beads by
 *                  label, run mode "run <bead-id>" → executes the bead,
 *                  artifacts → task/<id> branch of the project remote.
 *   kind "cpo"   — a LIVE project beads DB mounted at /workspace (agent is
 *                  READ-ONLY: bd list/show scoped to a set of epics), plus
 *                  run mode "edit <instruction>" → edits the site checkout
 *                  (/task-site), verifies the build, commits + pushes origin main.
 *
 * Prompts are NOT hardcoded in this file: they are rendered from
 * brain-prompts.json (gitignored, per deployment). When that file is missing,
 * minimal generic built-in prompts (GENERIC_PROMPTS) are used and a warning
 * is logged. Published starting point: brain-prompts.template.json. */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CFG = require('./config.json');

function log(...a) { console.log(new Date().toISOString(), '[brain]', ...a); }

// ---------------------------------------------------------------------------
// gd-only, single-model pi config materialized from the host (org-b1g4.4).
// The container never sees any other provider or credential.
// ---------------------------------------------------------------------------
function materializePiConfig() {
  const readHost = (f) => JSON.parse(fs.readFileSync(path.join(CFG.hostPiAgentDir, f), 'utf8'));
  const readHostOpt = (f) => { try { return JSON.parse(fs.readFileSync(path.join(CFG.hostPiAgentDir, f), 'utf8')); } catch { return null; } };
  const hostAuth = readHost('auth.json');
  const hostStore = readHost('models-store.json');
  const hostModels = readHostOpt('models.json');
  const gdAuth = hostAuth[CFG.provider];
  if (!gdAuth || !gdAuth.key) throw new Error(`no "${CFG.provider}" credential in host auth.json`);
  const allModels = (hostStore[CFG.provider] && hostStore[CFG.provider].models) || [];
  const locked = allModels.filter((m) => m.id === CFG.modelLock);
  if (!locked.length) throw new Error(`model lock "${CFG.modelLock}" not in host models-store.json [${CFG.provider}]`);

  fs.mkdirSync(CFG.piConfigDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(CFG.piConfigDir, 0o700);
  fs.writeFileSync(path.join(CFG.piConfigDir, 'auth.json'), JSON.stringify({ [CFG.provider]: gdAuth }, null, 1), { mode: 0o600 });
  fs.writeFileSync(path.join(CFG.piConfigDir, 'models-store.json'), JSON.stringify({ [CFG.provider]: { models: locked, checkedAt: Date.now() } }, null, 1), { mode: 0o600 });
  const gdCfg = (hostModels && hostModels.providers && hostModels.providers[CFG.provider]) || {};
  fs.writeFileSync(path.join(CFG.piConfigDir, 'models.json'), JSON.stringify({ providers: { [CFG.provider]: gdCfg } }, null, 1), { mode: 0o600 });
  const settings = {
    packages: ['/opt/pi-provider-gd'],
    defaultProvider: CFG.provider,
    defaultModel: CFG.modelLock,
  };
  fs.writeFileSync(path.join(CFG.piConfigDir, 'settings.json'), JSON.stringify(settings, null, 1), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// CPO site-editing: materialize a minimal git home — identity + ONLY the
// github.com credential lines (never the whole host credential store).
// ---------------------------------------------------------------------------
function materializeGitHome() {
  const dir = CFG.gitHomeDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  let host = '';
  try { host = fs.readFileSync(CFG.hostGitCredentials, 'utf8'); } catch { /* no host store */ }
  const gh = host.split('\n').map((l) => l.trim()).filter((l) => l.includes('@github.com'));
  fs.writeFileSync(path.join(dir, '.git-credentials'), (gh.length ? gh.join('\n') + '\n' : ''), { mode: 0o600 });
  const id = CFG.gitIdentity;
  fs.writeFileSync(path.join(dir, '.gitconfig'),
    `[user]\n\tname = ${id.name}\n\temail = ${id.email}\n[credential]\n\thelper = store\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Prompt templates — loaded from brain-prompts.json (gitignored, per-deploy),
// falling back to minimal generic prompts. {{placeholder}} rendering.
// ---------------------------------------------------------------------------
const PROMPTS_FILE = CFG.promptsFile || path.join(__dirname, 'brain-prompts.json');
let _prompts = null;

// Minimal safe defaults (no project names) used when no prompts file exists.
const GENERIC_PROMPTS = {
  'beads.ask':
    'You are "{{botName}}", a WhatsApp group assistant. You manage beads (issue tracker) using the `bd` CLI. Your working directory (/workspace) IS the beads repository — run bd commands here.\n' +
    'You may only: 1) LIST/SHOW beads with the label "{{label}}" (read-only), e.g. `bd list --label {{label}} -s open` or `bd show <id>`; 2) CREATE a bead: `bd create "<concise title>" -l {{label}} --no-inherit-labels --parent {{parentEpic}}`.\n' +
    'Use ONLY the `bd` CLI; never modify any files. Never touch beads without the "{{label}}" label. Reply with SHORT plain WhatsApp text only; lists: one item per line, each starting with "• ".\n\nRequest from a group member:\n{{ask}}',
  'beads.run':
    'You are "{{botName}}" executing bead {{beadId}} INSIDE THIS SANDBOX. No user is present — finish the work end to end.\n' +
    'The bead (your spec):\n---\n{{beadSpec}}\n---\n' +
    'Environment: /task = your read-write work area (put ALL produced files here); /workspace = the beads repo (read-only, except bd show/comment/close on {{beadId}}).\n' +
    'Implement exactly what the bead asks; if it is code, actually RUN it to verify before finishing.\n' +
    'When done AND verified: bd comment {{beadId}} "<2-3 line summary>" then bd close {{beadId}}. If blocked: bd comment {{beadId}} "blocked: <why>" and do NOT close.\n' +
    'Final chat message (posted verbatim to the WhatsApp group): 1-3 short plain lines.',
  'cpo.ask':
    'You are "{{botName}}", a WhatsApp group assistant. You answer questions about the project\'s beads (issue tracker) using the `bd` CLI. Your working directory (/workspace) is the project beads repository — run bd commands there.\n' +
    'The project beads are exactly the epics {{epics}} WITH ALL THEIR CHILDREN (an id belongs if it equals an epic id or starts with "<epic-id>."). To list them use this exact recipe (copy verbatim): {{recipe}}  — to show one: `bd show <id>`; one epic\'s subtree: `bd list --parent <epic-id> -s all`.\n' +
    'You are READ-ONLY: never create, update, close, claim, comment, sync or delete anything, and never modify any file. If a bd command fails with a lock/gate error, retry it once.\n' +
    'Answer in the language of the request. SHORT plain WhatsApp text only; lists: one item per line, each starting with "• ".\n\nRequest from a group member:\n{{ask}}',
  'cpo.edit':
    'You are "{{botName}}" editing the project website (Hugo site). You are inside a sandbox. The site checkout is at /task-site — a git repository, branch main, remote origin = the production repository.\n' +
    "Member's request (from the WhatsApp group):\n---\n{{instruction}}\n---\n" +
    'Environment: /task-site = the Hugo website (read-write); `hugo` is installed (same extended version as the deploy workflow); git is configured; use `git -C /task-site ...`.\n' +
    'Workflow (do ALL steps yourself, in order):\n' +
    '1. Understand the request. If it is AMBIGUOUS or DESTRUCTIVE, do NOT touch git — reply with ONE short clarifying question instead.\n' +
    '2. Read the relevant files first.\n' +
    '3. Make the MINIMAL correct change(s), keeping the existing structure, language and visual style.\n' +
    '4. Verify the build: cd /task-site && {{siteBuildCmd}} — if it fails, FIX your change before going further. Never push a broken build.\n' +
    '5. git -C /task-site add -A && git -C /task-site commit -m "<short summary>" && git -C /task-site push origin main\n' +
    '6. SHA: git -C /task-site rev-parse --short HEAD\n' +
    'Hard rules: NEVER force-push; never push any branch but main; never modify .github/ or the deploy workflow; never git reset/rebase; never change the baseURL.\n' +
    'If the push fails, retry ONCE, then report the error. If blocked, do NOT commit — reply with one short line explaining why.\n' +
    'Final chat message (posted verbatim to the WhatsApp group, plain text), 2-4 short lines: what you changed, commit <SHA>, live at {{siteLiveUrl}} in ~1 minute.',
};

function getPrompts() {
  if (_prompts) return _prompts;
  try {
    _prompts = Object.assign({}, GENERIC_PROMPTS, JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8')));
    log('prompts loaded from', PROMPTS_FILE);
  } catch {
    _prompts = GENERIC_PROMPTS;
    log('WARNING: no prompts file at', PROMPTS_FILE, '— using generic built-in prompts');
  }
  return _prompts;
}

function render(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

function buildBeadsPrompt(ask, brain) {
  const P = getPrompts();
  return render(P['beads.ask'], { botName: brain.botName || 'Bot', label: brain.beadsLabel, parentEpic: brain.beadsParentEpic, ask });
}

// Exact one-liner the in-container agent uses to list the scoped beads.
function cpoListRecipe(epics) {
  const epicsJson = JSON.stringify(epics); // double-quoted → safe inside shell single quotes
  return `bd list -s all --json --brief 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const a=JSON.parse(d);const E=${epicsJson};const x=a.filter(b=>E.some(e=>b.id===e||b.id.startsWith(e+".")));for(const b of x)console.log(b.id+" ["+b.status+"] P"+b.priority+" "+b.title)}catch(e){console.log("filter error:",e.message)}})'`;
}

function buildCpoPrompt(ask, brain) {
  const P = getPrompts();
  return render(P['cpo.ask'], { botName: brain.botName || 'Bot', epics: brain.epics.join(' and '), recipe: cpoListRecipe(brain.epics), ask });
}

function buildSitePrompt(instruction, brain) {
  const P = getPrompts();
  return render(P['cpo.edit'], { botName: brain.botName || 'Bot', instruction, siteBuildCmd: brain.siteBuildCmd, siteLiveUrl: brain.siteLiveUrl });
}
function textOfAssistant(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
  return '';
}

// ---------------------------------------------------------------------------
// Core docker/pi RPC driver.
// @param {object} o
// @param {string} o.prompt        full prompt message
// @param {string} o.workspace     host dir mounted at /workspace
// @param {number} o.timeoutMs
// @param {Array<[string,string]>} [o.extraVolumes]  [hostPath, containerPath]
// ---------------------------------------------------------------------------
async function runSandbox({ prompt, workspace, timeoutMs, extraVolumes = [] }) {
  const t0 = Date.now();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  const args = [
    'run', '--rm', '-i',
    '-u', `${uid}:${gid}`,
    '-e', 'PI_OFFLINE=1',
    '-e', 'HOME=/home/node',
    '-v', `${workspace}:/workspace`,
    '-v', `${CFG.piConfigDir}:/home/node/.pi/agent`,
    ...extraVolumes.flatMap(([h, c]) => ['-v', `${h}:${c}`]),
    CFG.sandboxImage,
    '--mode', 'rpc', '--no-session',
    '--provider', CFG.provider,
    '--model', CFG.modelLock,
  ];
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000); });

  return await new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    let lastAssistantText = '';
    let promptSent = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`brain timeout after ${timeoutMs}ms`)), timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = lastAssistantText.trim();
      if (!text) return fail(new Error('agent_settled but no assistant text'));
      try { child.kill('SIGKILL'); } catch {}
      resolve({ text, durationMs: Date.now() - t0 });
    };

    const sendCommand = (obj) => { child.stdin.write(JSON.stringify(obj) + '\n'); };

    const onRecord = (rec) => {
      if (rec.type === 'response' && rec.command === 'get_state') {
        if (!rec.success) return fail(new Error('get_state failed: ' + (rec.error || 'unknown')));
        const modelId = rec.data && rec.data.model && rec.data.model.id;
        if (modelId !== CFG.modelLock) return fail(new Error(`MODEL LOCK VIOLATION: container model is "${modelId}", expected "${CFG.modelLock}"`));
        log('model lock verified:', modelId);
        sendCommand({ id: 'p1', type: 'prompt', message: prompt });
        promptSent = true;
        return;
      }
      if (rec.type === 'response' && rec.command === 'prompt') {
        if (!rec.success) return fail(new Error('prompt rejected: ' + (rec.error || 'unknown')));
        if (rec.data && rec.data.disposition && rec.data.disposition !== 'started') {
          return fail(new Error('prompt disposition was "' + rec.data.disposition + '", run did not start'));
        }
        return;
      }
      if (rec.type === 'message_end' && rec.message && rec.message.role === 'assistant') {
        const t = textOfAssistant(rec.message);
        if (t.trim()) lastAssistantText = t;
        return;
      }
      if (rec.type === 'agent_settled') {
        if (rec.aborted) return fail(new Error('agent run aborted'));
        if (!promptSent) return fail(new Error('agent_settled before prompt was accepted'));
        return finish();
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); }
        catch { log('non-JSON stdout line:', line.slice(0, 200)); continue; }
        try { onRecord(rec); } catch (e) { fail(e); }
      }
    });

    child.on('error', (e) => fail(new Error('failed to start docker: ' + e.message)));
    child.on('exit', (code, sig) => {
      if (!settled) fail(new Error(`docker/pi exited (code=${code} sig=${sig}) before agent_settled. stderr: ${stderrBuf.slice(-800)}`));
    });
    child.stdin.on('error', (e) => { if (e.code !== 'EPIPE') fail(e); });

    sendCommand({ id: 's1', type: 'get_state' });
  });
}

// ---------------------------------------------------------------------------
// Public API — routed by group brain profile.
// ---------------------------------------------------------------------------
async function runAsk(group, ask) {
  const brain = CFG.brains[group.brain];
  if (!brain) throw new Error(`unknown brain profile "${group.brain}"`);
  materializePiConfig();
  const prompt = brain.kind === 'cpo' ? buildCpoPrompt(ask, brain) : buildBeadsPrompt(ask, brain);
  return await runSandbox({ prompt, workspace: brain.beadsRepoDir, timeoutMs: CFG.replyTimeoutMs });
}

async function runRunMode(group, arg) {
  const brain = CFG.brains[group.brain];
  if (!brain) throw new Error(`unknown brain profile "${group.brain}"`);
  if (brain.kind === 'cpo') return runSiteEdit(arg, brain);
  return runBead(arg, brain);
}

// ---------------------------------------------------------------------------
// kind "beads" — execute an open bead in the sandbox (inherited from ai-slop).
// ---------------------------------------------------------------------------
function bdShow(repoDir, id) {
  const out = execFileSync('bd', ['show', id, '--json'], { cwd: repoDir, encoding: 'utf8', timeout: 20000 });
  const arr = JSON.parse(out);
  const b = Array.isArray(arr) ? arr[0] : arr;
  if (!b || b.id !== id) return null;
  return b;
}

function buildRunPrompt(bead, brain) {
  const P = getPrompts();
  const nl = String.fromCharCode(10);
  const spec = [bead.title, bead.description ? nl + bead.description : ""].join(nl).trim();
  return render(P["beads.run"], { botName: brain.botName || "Bot", beadId: bead.id, beadSpec: spec });

}

function countFiles(dir) {
  let n = 0;
  (function walk(d) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) n++;
    }
  })(dir);
  return n;
}

/**
 * After a bead run: if /task has artifacts, push them to Gitea branch task/<id>.
 * Never touches main; nothing is auto-deployed.
 */
function collectTaskArtifacts(id, title, brain) {
  const dir = path.join(CFG.workDir, id);
  if (!fs.existsSync(dir) || countFiles(dir) === 0) return null;
  const repoDir = brain.artifactRepoDir || __dirname;
  let origin;
  try {
    origin = execFileSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 10000 }).trim();
  } catch {}
  if (!origin) { log('no git origin on project repo — artifacts left in', dir); return null; }
  const branch = `task/${id}`;
  const g = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    try { g(['init', '-q', '-b', 'main']); } catch { /* already a repo (re-run) */ }
    g(['add', '-A']);
    g(['-c', 'user.name=Alexandre Girard Davila', '-c', 'user.email=gitea-lamai270@alexgirard.com', 'commit', '-q', '-m', `task/${id}: ${title}`]);
    g(['push', '--force', '-q', origin, `main:refs/heads/${branch}`]);
    log('artifacts for', id, 'pushed to branch', branch);
    return branch;
  } catch (e) {
    log('artifact push failed for', id, ':', String(e.message || e).slice(0, 200));
    return null;
  }
}

async function runBead(rawId, brain) {
  const id = String(rawId || '').trim();
  if (!/^[a-z]+-[a-z0-9]{3,10}(\.\d+)?$/i.test(id)) {
    return { text: `That doesn't look like a bead id ("${rawId}"). Usage: pi ${brain.runCmd} <bead-id>` };
  }
  let bead;
  try { bead = bdShow(brain.beadsRepoDir, id); } catch { bead = null; }
  if (!bead) return { text: `No bead found with id ${id}. Send "pi" alone to list the open ones.` };
  const labels = bead.labels || [];
  if (!labels.includes(brain.beadsLabel)) {
    return { text: `${id} is not a ${brain.beadsLabel} bead — I only run beads labelled ${brain.beadsLabel}.` };
  }
  if (bead.status !== 'open') {
    return { text: `${id} is already ${bead.status} — nothing to run. Reopen it to retry.` };
  }

  materializePiConfig();
  const taskDir = path.join(CFG.workDir, id);
  fs.mkdirSync(taskDir, { recursive: true });

  const res = await runSandbox({
    prompt: buildRunPrompt(bead, brain),
    workspace: brain.beadsRepoDir,
    timeoutMs: CFG.runTimeoutMs,
    extraVolumes: [[taskDir, '/task']],
  });

  const branch = collectTaskArtifacts(id, bead.title, brain);
  let closed = false;
  try { closed = bdShow(brain.beadsRepoDir, id).status === 'closed'; } catch {}

  const parts = [res.text.trim()];
  if (branch) parts.push(`📦 artifacts → Gitea branch ${branch}`);
  if (!closed) parts.push(`⚠️ ${id} left open (blocked or unfinished)`);
  return { text: parts.join('\n'), meta: { id, closed, branch } };
}

// ---------------------------------------------------------------------------
// kind "cpo" — run mode "edit": edit the website-draft checkout inside the
// sandbox, verify with hugo, commit + push origin main (→ GitHub Pages).
// Host-side verification: main must actually have moved, otherwise warn.
// ---------------------------------------------------------------------------
async function runSiteEdit(instruction, brain) {
  const instr = String(instruction || '').trim();
  if (!instr) return { text: 'Usage: pi edit <what to change on the site>' };
  const preSha = '';
  try { preSha = execFileSync('git', ['-C', brain.siteDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}

  materializePiConfig();
  materializeGitHome();

  const res = await runSandbox({
    prompt: buildSitePrompt(instr, brain),
    workspace: brain.beadsRepoDir, // live CPO beads DB (agent is prompt-scoped read-only)
    timeoutMs: CFG.runTimeoutMs,
    extraVolumes: [
      [brain.siteDir, '/task-site'],
      [path.join(CFG.gitHomeDir, '.gitconfig'), '/home/node/.gitconfig'],
      [path.join(CFG.gitHomeDir, '.git-credentials'), '/home/node/.git-credentials'],
    ],
  });

  let postSha = null;
  try { postSha = execFileSync('git', ['-C', brain.siteDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  const parts = [res.text.trim()];
  if (postSha && postSha !== preSha) {
    log('site main moved:', preSha.slice(0, 8), '→', postSha.slice(0, 8));
  } else {
    parts.push('⚠️ aucun commit n\u2019est apparu sur main côté serveur — vérifie avant de regarder le site.');
  }
  return { text: parts.join('\n'), durationMs: res.durationMs, meta: { preSha: preSha || null, postSha } };
}

module.exports = {
  runAsk,
  runRunMode,
  materializePiConfig,
  cpoListRecipe,
  buildSitePrompt,
};
