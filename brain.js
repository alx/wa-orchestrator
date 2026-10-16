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
 *   kind "beads" — ai-slop: container-local beads repo, list/create by label,
 *                  run mode "run <bead-id>" → executes the bead, artifacts →
 *                  Gitea task/<id> branch (behavior inherited from ai-slop-wa).
 *   kind "cpo"   — Centre de la Photographie Ordinaire: the LIVE project beads
 *                  DB /home/alx/org mounted at /workspace (agent is READ-ONLY:
 *                  bd list/show on the org-9s8 + org-a0s5 trees), and run mode
 *                  "edit <instruction>" → edits the website-draft checkout
 *                  (/task-site), verifies with hugo, commits + pushes origin
 *                  main (→ GitHub Pages deploy).
 */
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
// Prompt builders
// ---------------------------------------------------------------------------

// Exact one-liner the in-container agent uses to list the CPO beads.
function cpoListRecipe(epics) {
  const epicsJson = JSON.stringify(epics); // double-quoted → safe inside shell single quotes
  return `bd list -s all --json --brief 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const a=JSON.parse(d);const E=${epicsJson};const x=a.filter(b=>E.some(e=>b.id===e||b.id.startsWith(e+".")));for(const b of x)console.log(b.id+" ["+b.status+"] P"+b.priority+" "+b.title)}catch(e){console.log("filter error:",e.message)}})'`;
}

function buildBeadsPrompt(ask, brain) {
  return [
    `You are "AI Slop Bot", a WhatsApp group assistant. You manage beads (issue tracker) for the AI Slop channel using the \`bd\` CLI. Your working directory (/workspace) IS the beads repository — run bd commands here.`,
    '',
    'You may only do these two things:',
    `1. LIST/SHOW beads with the label "${brain.beadsLabel}" (read-only), e.g. \`bd list --label ${brain.beadsLabel} -s open\` or \`bd show <id>\`.`,
    `2. CREATE a new bead: \`bd create "<concise title>" -l ${brain.beadsLabel} --no-inherit-labels --parent ${brain.beadsParentEpic}\`. Write the title yourself, concise, from the member's request.`,
    '',
    'Hard rules:',
    '- Use ONLY the `bd` CLI. Never modify any files. Never run any other command.',
    `- Never touch beads without the "${brain.beadsLabel}" label. Never close or edit existing beads.`,
    '- Reply with SHORT plain WhatsApp text only (no markdown tables, no code blocks). Your reply is posted verbatim to the group.',
    '- Lists: EXACTLY one item per line, each starting with "\u2022 ". Never pack two items on the same line. If a list has more than 5 items, list the first 5 and end with "\u2022 (\u2026and N more)".',
    '- If the request is unclear or out of scope, reply with one short clarifying line.',
    '',
    'Request from a group member:',
    ask,
  ].join('\n');
}

function buildCpoPrompt(ask, brain) {
  const recipe = cpoListRecipe(brain.epics);
  return [
    'You are "CPO Bot", the WhatsApp group assistant of the Centre de la Photographie Ordinaire. You answer questions about the project\'s beads (issue tracker) using the `bd` CLI. Your working directory (/workspace) is the project beads repository — run bd commands there.',
    '',
    `The CPO beads are exactly the epics ${brain.epics.join(' and ')} WITH ALL THEIR CHILDREN (an id belongs to CPO if it equals an epic id or starts with "<epic-id>.")`,
    '',
    'To list the CPO beads, use this exact recipe (copy it verbatim):',
    '  ' + recipe,
    'To show one bead:  bd show <id>',
    `To list one epic's subtree:  bd list --parent <epic-id> -s all`,
    '',
    'You are READ-ONLY: never create, update, close, claim, comment, sync or delete anything, and never modify any file. Only bd list/show.',
    'If a bd command fails with a lock/gate error, wait a moment and retry it once.',
    '',
    'Answer in the language of the request (French question → French answer). SHORT plain WhatsApp text only (no markdown tables, no code blocks). Your reply is posted verbatim to the group.',
    'Lists: EXACTLY one item per line, each starting with "\u2022 ". If more than 8 items, give the 8 most relevant and end with "\u2022 (\u2026et N autres)".',
    '',
    'Request from a group member:',
    ask,
  ].join('\n');
}

function buildSitePrompt(instruction, brain) {
  return [
    'You are "CPO Bot" editing the website of the Centre de la Photographie Ordinaire (Hugo site). You are inside a sandbox. The site checkout is at /task-site — a git repository, branch main, remote origin = the production GitHub repository.',
    '',
    "Member's request (from the WhatsApp group):",
    '---',
    instruction,
    '---',
    '',
    'Environment:',
    '- /task-site = the Hugo website (read-write). Pages in content/, templates in layouts/, assets in static/.',
    '- `hugo` is installed (same extended version as the deploy workflow).',
    '- git is configured (identity + github credential); use `git -C /task-site ...`.',
    '',
    'Workflow (do ALL steps yourself, in order):',
    '1. Understand the request. If it is AMBIGUOUS or DESTRUCTIVE (deleting content/pages, restructuring the site), do NOT touch git — reply with ONE short clarifying question instead.',
    '2. Read the relevant files first (content/*.md, layouts/, static/style.css, config).',
    '3. Make the MINIMAL correct change(s). This is a live French client site: keep the existing structure, French language, and visual style (CSS variables, DIN titles, yellow #FAB617 accent).',
    `4. Verify the site still builds: cd /task-site && ${CFG.brains.cpo.siteBuildCmd}`,
    '   If the build fails, FIX your change before going further. Never push a broken build.',
    '5. git -C /task-site add -A && git -C /task-site commit -m "<short French summary>" && git -C /task-site push origin main',
    '6. SHA: git -C /task-site rev-parse --short HEAD',
    '',
    'Hard rules:',
    '- NEVER force-push. NEVER push any branch but main. NEVER modify .github/ or the deploy workflow. NEVER git reset/rebase.',
    '- Never change the baseURL or the deploy configuration.',
    '- If the push fails, retry ONCE, then report the error (no workarounds).',
    '- If the request is impossible or blocked, do NOT commit — reply with one short line explaining why.',
    '',
    'Final chat message (posted verbatim to the WhatsApp group — plain text, French if the request was in French), 2-4 short lines:',
    '- what you changed (which files, one-line why)',
    '- commit <SHA>',
    `- \u2192 observable sur ${CFG.brains.cpo.siteLiveUrl} dans ~1 minute (build GitHub Pages)`,
  ].join('\n');
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

function buildRunPrompt(bead) {
  const spec = [bead.title, bead.description ? '\n' + bead.description : ''].join('\n').trim();
  return [
    `You are "AI Slop Bot" executing bead ${bead.id} INSIDE THIS SANDBOX. No user is present — you must finish the work yourself, end to end.`,
    '',
    'The bead (your spec):',
    '---',
    spec,
    '---',
    '',
    'Environment:',
    '- /task = your read-write work area. Put ALL produced files here.',
    '- /workspace = the beads repo; the `bd` CLI works here. Treat it as read-only.',
    '',
    'Rules:',
    '- Work ONLY in /task. Never write anywhere else in the container.',
    `- In /workspace you may ONLY run bd show/comment/close on bead ${bead.id}. Never touch any other bead.`,
    '- Implement exactly what the bead asks. Keep it small, correct and self-contained. If it is code, actually RUN it to verify before finishing.',
    `- When done AND verified: bd comment ${bead.id} "<2-3 line summary: what was built, which files in /task, how to verify>" then bd close ${bead.id}.`,
    `- If the spec is impossible or you get genuinely blocked: bd comment ${bead.id} "blocked: <why>" and stop. Do NOT close.`,
    '',
    'Final chat message (posted verbatim to the WhatsApp group): 1-3 short plain lines — what you did and (if you produced files) that they are in /task. One item per line if you list anything, each starting with "• ".',
  ].join('\n');
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
    prompt: buildRunPrompt(bead),
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
