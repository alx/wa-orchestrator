/**
 * brain.ts — the pi brain(s), hard-locked in a Docker sandbox.
 *
 * Every ask spawns:
 *   docker run --rm -i -u 1000:1000 -v <workspace>:/workspace \
 *     -v <pi-config>:<pi-config> -e PI_CODING_AGENT_DIR=<pi-config> \
 *     ... wa-orchestrator-sandbox \
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
 * is logged. Published starting point: brain-prompts.template.json.
 */
import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, PROJECT_ROOT, BrainProfile, GroupEntry, Config } from './config';
import { groupSlug, sessionHostDir, sessionExists } from './session';

const CFG: Config = loadConfig();

function log(...a: unknown[]): void { console.log(new Date().toISOString(), '[brain]', ...a); }

/** A beads issue, as returned by `bd show --json`. */
interface Bead {
  id: string;
  title: string;
  description?: string;
  status?: string;
  labels?: string[];
  [k: string]: unknown;
}

/** Result of one sandboxed brain run. */
export interface BrainResult {
  text: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// gd-only, single-model pi config materialized from the host (org-b1g4.4).
// The container never sees any other provider or credential.
// ---------------------------------------------------------------------------
/**
 * pi packages the sandbox loads (local paths; pi loads them via settings.json):
 * - pi-provider-gd: the gd model provider (materialized above)
 * - pi-ask-questions: ask_questions tool → answered as a WhatsApp group dialog (org-lsv8)
 * - pi-subagents: in-process child agents (org-5mdy): scout/reviewer/worker/oracle/delegate
 * - pi-herdr: spawn/steer/wait/harvest agent panes in the HOST herdr server (org-5mdy)
 *
 * pi-herdr is loaded from the HOST install (herdrPkgDir) when set: its launch
 * plan injects `<pkg>/src/child.ts` as the child extension, and the child pi
 * runs in a HOST pane — so the package (like the agent dir, org-5mdy.1) must
 * live at a host-equal path, which brain.ts bind-mounts onto itself. Falls
 * back to the image-baked /opt/pi-herdr (child extension then cannot resolve
 * on the host).
 */
export function piPackages(): string[] {
  const herdrPkg = CFG.herdrPkgDir
    ? `${CFG.herdrPkgDir}/node_modules/@andrewjacop/pi-herdr`
    : '/opt/pi-herdr';
  return ['/opt/pi-provider-gd', '/opt/pi-ask-questions', '/opt/pi-subagents', herdrPkg];
}

/** Docker args mounting the host pi-herdr install onto itself (org-5mdy.1). */
export function herdrPkgArgs(dir?: string): string[] {
  const d = dir ?? (CFG.herdrPkgDir as string | undefined);
  return d ? ['-v', `${d}:${d}`] : [];
}

export function materializePiConfig(): void {
  const hostDir = CFG.hostPiAgentDir as string;
  const provider = CFG.provider as string;
  const readHost = (f: string): any => JSON.parse(fs.readFileSync(path.join(hostDir, f), 'utf8'));
  const readHostOpt = (f: string): any => {
    try { return JSON.parse(fs.readFileSync(path.join(hostDir, f), 'utf8')); } catch { return null; }
  };
  const hostAuth = readHost('auth.json');
  const hostStore = readHost('models-store.json');
  const hostModels = readHostOpt('models.json');
  const gdAuth = hostAuth[provider];
  if (!gdAuth || !gdAuth.key) throw new Error(`no "${provider}" credential in host auth.json`);
  const allModels = (hostStore[provider] && hostStore[provider].models) || [];
  const locked = allModels.filter((m: any) => m.id === CFG.modelLock);
  if (!locked.length) throw new Error(`model lock "${CFG.modelLock}" not in host models-store.json [${provider}]`);

  const cfgDir = CFG.piConfigDir as string;
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cfgDir, 0o700);
  fs.writeFileSync(path.join(cfgDir, 'auth.json'), JSON.stringify({ [provider]: gdAuth }, null, 1), { mode: 0o600 });
  fs.writeFileSync(path.join(cfgDir, 'models-store.json'), JSON.stringify({ [provider]: { models: locked, checkedAt: Date.now() } }, null, 1), { mode: 0o600 });
  const gdCfg = (hostModels && hostModels.providers && hostModels.providers[provider]) || {};
  fs.writeFileSync(path.join(cfgDir, 'models.json'), JSON.stringify({ providers: { [provider]: gdCfg } }, null, 1), { mode: 0o600 });
  const settings = {
    packages: piPackages(),
    defaultProvider: provider,
    defaultModel: CFG.modelLock,
  };
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify(settings, null, 1), { mode: 0o600 });
  // pi-subagents (org-5mdy):
  // - child agents must be BLOCKING by default — the one-shot RPC brain is
  //   SIGKILLed on agent_settled, so an async (detached) child would die
  //   mid-work. Explicit per-call async:true still works.
  // - toolActivation "eager": the default "auto" mode HIDES the `subagent`
  //   tool in any session that already has history (it relies on a
  //   `subagents_enable` loader call the model has to know to make) — verified
  //   in probes 2026-10-17: fresh sessions see the tool, resumed group
  //   sessions don't. The brain must always have it.
  const subagentCfgDir = path.join(cfgDir, 'extensions', 'subagent');
  fs.mkdirSync(subagentCfgDir, { recursive: true });
  fs.writeFileSync(path.join(subagentCfgDir, 'config.json'), JSON.stringify({ asyncByDefault: false, toolActivation: 'eager' }, null, 1));
}

// ---------------------------------------------------------------------------
// CPO site-editing: materialize a minimal git home — identity + ONLY the
// github.com credential lines (never the whole host credential store).
// ---------------------------------------------------------------------------
function materializeGitHome(): void {
  const dir = CFG.gitHomeDir as string;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  let host = '';
  try { host = fs.readFileSync(CFG.hostGitCredentials as string, 'utf8'); } catch { /* no host store */ }
  const gh = host.split('\n').map((l) => l.trim()).filter((l) => l.includes('@github.com'));
  fs.writeFileSync(path.join(dir, '.git-credentials'), (gh.length ? gh.join('\n') + '\n' : ''), { mode: 0o600 });
  const id = CFG.gitIdentity as { name: string; email: string };
  fs.writeFileSync(path.join(dir, '.gitconfig'),
    `[user]\n\tname = ${id.name}\n\temail = ${id.email}\n[credential]\n\thelper = store\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Prompt templates — loaded from brain-prompts.json (gitignored, per-deploy),
// falling back to minimal generic prompts. {{placeholder}} rendering.
// ---------------------------------------------------------------------------
const PROMPTS_FILE: string = CFG.promptsFile as string || path.join(PROJECT_ROOT, 'brain-prompts.json');
let _prompts: Record<string, string> | null = null;

// Minimal safe defaults (no project names) used when no prompts file exists.
const GENERIC_PROMPTS: Record<string, string> = {
  'beads.ask.first':
    'You are "{{botName}}", a WhatsApp group assistant. You manage beads (issue tracker) using the `bd` CLI. Your working directory is /workspace — this group\'s own work area. The beads repo is mounted at /beads; the `bd` CLI works from any directory (BEADS_DIR is preset).\n' +
    'You may only: 1) LIST/SHOW beads with the label "{{label}}" (read-only), e.g. `bd list --label {{label}} -s open` or `bd show <id>`; 2) CREATE a bead: `bd create "<concise title>" -l {{label}} --no-inherit-labels --parent {{parentEpic}}`.\n' +
    'Use ONLY the `bd` CLI; never modify any files. Never touch beads without the "{{label}}" label.\n' +
    'MULTI-AGENT: for complex multi-part requests you may delegate to child agents (`subagent` tool: scout to find, reviewer to check, delegate for simple sub-tasks; parallel allowed) — children run in this same sandbox with the same constraints. Keep it to 1-3 children, then synthesise.\n' +
    'Reply with SHORT plain WhatsApp text only; lists: one item per line, each starting with "• ".\n\nRequest from a group member:\n{{ask}}',
  'beads.ask.turn':
    'Follow-up in the same WhatsApp group conversation — context from earlier turns is already in this session.\n\nRequest:\n{{ask}}\n\nUse what you already know from this conversation; only re-run bd commands when the data may have changed. Reply with SHORT plain WhatsApp text only (lists: one item per line, each starting with "• "). Your final chat message is posted verbatim to the group.',
  'beads.ask':
    'You are "{{botName}}", a WhatsApp group assistant. You manage beads (issue tracker) using the `bd` CLI. Your working directory is /workspace — this group\'s own work area. The beads repo is mounted at /beads; the `bd` CLI works from any directory (BEADS_DIR is preset).\n' +
    'You may only: 1) LIST/SHOW beads with the label "{{label}}" (read-only), e.g. `bd list --label {{label}} -s open` or `bd show <id>`; 2) CREATE a bead: `bd create "<concise title>" -l {{label}} --no-inherit-labels --parent {{parentEpic}}`.\n' +
    'Use ONLY the `bd` CLI; never modify any files. Never touch beads without the "{{label}}" label. Reply with SHORT plain WhatsApp text only; lists: one item per line, each starting with "• ".\n\nRequest from a group member:\n{{ask}}',
  'beads.run':
    'You are "{{botName}}" executing bead {{beadId}} INSIDE THIS SANDBOX. No user is present — finish the work end to end.\n' +
    'The bead (your spec):\n---\n{{beadSpec}}\n---\n' +
    'Environment: /task = your read-write work area (put ALL produced files here); /workspace = the group\'s work area (do not write there during a run); the beads repo is at /beads — `bd` works from any directory, and you may only bd show/comment/close on {{beadId}}.\n' +
    'Implement exactly what the bead asks; if it is code, actually RUN it to verify before finishing.\n' +
    'When done AND verified: bd comment {{beadId}} "<2-3 line summary>" then bd close {{beadId}}. If blocked: bd comment {{beadId}} "blocked: <why>" and do NOT close.\n' +
    'Final chat message (posted verbatim to the WhatsApp group): 1-3 short plain lines.',
  'cpo.ask.first':
    'You are "{{botName}}", a WhatsApp group assistant. You answer questions about the project\'s beads (issue tracker) using the `bd` CLI. Your working directory is /workspace — this group\'s own work area. The project beads repo is mounted at /beads; the `bd` CLI works from any directory (BEADS_DIR is preset).\n' +
    'The project beads are exactly the epics {{epics}} WITH ALL THEIR CHILDREN (an id belongs if it equals an epic id or starts with "<epic-id>."). To list them use this exact recipe (copy verbatim): {{recipe}}  — to show one: `bd show <id>`; one epic\'s subtree: `bd list --parent <epic-id> -s all`.\n' +
    'You are READ-ONLY: never create, update, close, claim, comment, sync or delete anything, and never modify any file. If a bd command fails with a lock/gate error, retry it once.\n' +
    'MULTI-AGENT: you have two delegation primitives — (a) `subagent` tool: in-process child agents (scout/reviewer/worker/oracle/delegate, parallel) that share this sandbox; (b) herdr tools: `herdr_spawn_agent` starts a VISIBLE agent pane on the operator\'s machine (survives this conversation; the human can watch and type in it), then `herdr_wait_output`/`herdr_get_agent_result` to collect, `herdr_message_agent` to steer later, `herdr_interrupt_agent` to stop. Use herdr only for clearly long-running or parallel sub-work.\n' +
    'Answer in the language of the request. SHORT plain WhatsApp text only; lists: one item per line, each starting with "• ".\n\nRequest from a group member:\n{{ask}}',
  'cpo.ask.turn':
    'Follow-up in the same WhatsApp group conversation — context from earlier turns is already in this session.\n\nRequest:\n{{ask}}\n\nUse what you already know from this conversation (the scoped-beads recipe was given at the start of the session); only re-run bd commands when the data may have changed. Reply with SHORT plain WhatsApp text only (lists: one item per line, each starting with "• "). Your final chat message is posted verbatim to the group.',
  'cpo.ask':
    'You are "{{botName}}", a WhatsApp group assistant. You answer questions about the project\'s beads (issue tracker) using the `bd` CLI. Your working directory is /workspace — this group\'s own work area. The project beads repo is mounted at /beads; the `bd` CLI works from any directory (BEADS_DIR is preset).\n' +
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

function getPrompts(): Record<string, string> {
  if (_prompts) return _prompts;
  let p: Record<string, string>;
  try {
    p = Object.assign({}, GENERIC_PROMPTS, JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8')));
    log('prompts loaded from', PROMPTS_FILE);
  } catch {
    p = GENERIC_PROMPTS;
    log('WARNING: no prompts file at', PROMPTS_FILE, '— using generic built-in prompts');
  }
  _prompts = p;
  return p;
}

function render(tpl: unknown, vars: Record<string, unknown>): string {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

/**
 * "ask" prompts come in two shapes (org-1v4b):
 *   *.first — full environment description, sent when the group's pi session
 *             is empty (turn 1); pi stores it in the session, later turns
 *             build on it instead of re-describing everything.
 *   *.turn  — slim continuation: the request + the output rule.
 * Templates without the split keys fall back to the legacy single prompt.
 */
function pickTurnTemplate(P: Record<string, unknown>, base: string, isFirstTurn: boolean): string {
  const key = isFirstTurn ? `${base}.first` : `${base}.turn`;
  if (typeof P[key] === 'string') return P[key] as string;
  console.warn(`[brain] prompts: no "${key}" template — falling back to legacy "${base}"`);
  return P[base] as string;
}

export function buildBeadsPrompt(ask: string, brain: BrainProfile, isFirstTurn: boolean): string {
  const P = getPrompts();
  const tpl = pickTurnTemplate(P, 'beads.ask', isFirstTurn);
  return render(tpl, {
    botName: brain.botName || 'Bot',
    label: brain.beadsLabel,
    parentEpic: brain.beadsParentEpic,
    ask,
  });
}

/** Exact one-liner the in-container agent uses to list the scoped beads. */
export function cpoListRecipe(epics: string[]): string {
  const epicsJson = JSON.stringify(epics); // double-quoted → safe inside shell single quotes
  return `bd list -s all --json --brief 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const a=JSON.parse(d);const E=${epicsJson};const x=a.filter(b=>E.some(e=>b.id===e||b.id.startsWith(e+".")));for(const b of x)console.log(b.id+" ["+b.status+"] P"+b.priority+" "+b.title)}catch(e){console.log("filter error:",e.message)}})'`;
}

export function buildCpoPrompt(ask: string, brain: BrainProfile, isFirstTurn: boolean): string {
  const P = getPrompts();
  const epics: string[] = brain.epics ?? [];
  const tpl = pickTurnTemplate(P, 'cpo.ask', isFirstTurn);
  return render(tpl, {
    botName: brain.botName || 'Bot',
    epics: epics.join(' and '),
    recipe: cpoListRecipe(epics),
    ask,
  });
}

export function buildSitePrompt(instruction: string, brain: BrainProfile): string {
  const P = getPrompts();
  return render(P['cpo.edit'], {
    botName: brain.botName || 'Bot',
    instruction,
    siteBuildCmd: brain.siteBuildCmd,
    siteLiveUrl: brain.siteLiveUrl,
  });
}

function textOfAssistant(msg: any): string {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
  return '';
}

// ---------------------------------------------------------------------------
// Core docker/pi RPC driver.
// ---------------------------------------------------------------------------
/** A group's conversation session (org-1v4b): id for pi, host dir for the volume. */
export interface GroupSession {
  id: string;
  hostDir: string;
}

/**
 * Extension UI dialog request from pi (org-lsv8). Wire records are pi's,
 * intentionally minimally typed. Dialog methods (select/input/confirm/editor)
 * block until an extension_ui_response with the same id is written back.
 */
export interface UiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  [k: string]: unknown;
}

export interface UiResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

interface RunSandboxOpts {
  /** full prompt message */
  prompt: string;
  /**
   * host dir mounted at /workspace — the GROUP'S OWN work area (org-lsv8.17
   * decision: never a shared project repo like /home/alx/org; one workspace
   * per group, e.g. workspaces/<brain>/). Falls back to beadsRepoDir when
   * unset (legacy brains).
   */
  workspace: string;
  /** host beads repo dir mounted at /beads; BEADS_DIR points `bd` at it from any cwd */
  beadsDir?: string;
  timeoutMs: number;
  /** the group's conversation session (org-1v4b) */
  session: GroupSession;
  /** [hostPath, containerPath] pairs */
  extraVolumes?: [string, string][];
  /** Answer an extension UI dialog (brain questions over WhatsApp, org-lsv8). */
  onUiRequest?: (req: UiRequest) => Promise<UiResponse> | UiResponse;
}

/**
 * Docker args wiring the in-sandbox herdr client to the HOST herdr server
 * (org-5mdy): bind-mount the single server socket file + point the client at
 * it. Panes spawned this way are host-owned: they survive `docker --rm` brain
 * runs and the human can see/attach to them in the herdr TUI. No-op when
 * herdrSocketPath is unset or the socket is absent (herdr tools will simply
 * fail in-sandbox, brain falls back to in-process subagents).
 */
export function herdrSocketArgs(sock?: string, spawnPane?: string): string[] {
  const p = sock ?? (CFG.herdrSocketPath as string | undefined);
  if (!p || !fs.existsSync(p)) return [];
  const args = ['-v', `${p}:/herdr/herdr.sock`, '-e', 'HERDR_SOCKET_PATH=/herdr/herdr.sock'];
  // pi-herdr resolves `--current` (herdr_spawn_agent's split target) from
  // HERDR_PANE_ID. The brain is not a real pane, so it presents the dedicated
  // "wa-bot" home pane as its own: spawned agents fan out inside that
  // workspace, away from the operator's live work.
  const home = spawnPane ?? (CFG.herdrSpawnPane as string | undefined);
  if (home) args.push('-e', `HERDR_PANE_ID=${home}`);
  return args;
}

/**
 * Docker args for the pi config/agent dir at a HOST-EQUAL path (org-5mdy.1).
 * pi-herdr seeds the child session file under <agentDir>/sessions/<cwd-encoded>
 * and passes that absolute path to the child pi, which runs in a HOST pane —
 * only a path that is textually identical on host and container resolves in
 * both. Mounts the same host dir onto itself and pins pi to it (instead of
 * $HOME/.pi/agent, where the seeded path would be container-only → EACCES
 * on the host).
 */
export function agentDirArgs(cfgDir: string): string[] {
  return ['-v', `${cfgDir}:${cfgDir}`, '-e', `PI_CODING_AGENT_DIR=${cfgDir}`];
}

export async function runSandbox(o: RunSandboxOpts): Promise<{ text: string; durationMs: number }> {
  const { prompt, workspace, beadsDir, timeoutMs, session, extraVolumes = [] } = o;
  const t0 = Date.now();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  // The beads repo is a SEPARATE mount from the group workspace (org-lsv8.17):
  // /workspace is the group's own dir, /beads is the shared beads DB. BEADS_DIR
  // makes the bare `bd` CLI resolve the DB from any cwd.
  const beadsArgs = beadsDir
    ? ['-v', `${beadsDir}:/beads`, '-e', 'BEADS_DIR=/beads/.beads']
    : [];
  const args = [
    'run', '--rm', '-i',
    '-u', `${uid}:${gid}`,
    '-e', 'PI_OFFLINE=1',
    '-e', 'HOME=/home/node',
    '-v', `${workspace}:/workspace`,
    ...beadsArgs, // beads repo at /beads (org-lsv8.17)
    ...agentDirArgs(CFG.piConfigDir as string), // host-equal pi agent dir (org-5mdy.1)
    ...herdrPkgArgs(), // host pi-herdr install, host-equal (org-5mdy.1)
    '-v', `${session.hostDir}:/sessions`, // per-group conversation volume (org-1v4b)
    ...herdrSocketArgs(), // herdr socket → HOST server (org-5mdy)
    ...extraVolumes.flatMap(([h, c]) => ['-v', `${h}:${c}`]),
    CFG.sandboxImage as string,
    '--mode', 'rpc',
    // persistent conversation: pi resumes the same session file per group.
    // (Anything after the image name is passed to pi, not to docker.)
    '--session-id', session.id, '--session-dir', '/sessions',
    '--provider', CFG.provider as string,
    '--model', CFG.modelLock as string,
  ];
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderrBuf = '';
  child.stderr.on('data', (d: Buffer) => {
    stderrBuf += d.toString('utf8');
    if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
  });

  return await new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    let lastAssistantText = '';
    let promptSent = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(err);
    };
    let timer: NodeJS.Timeout;
    const armTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(`brain timeout after ${timeoutMs}ms`)), timeoutMs);
    };
    armTimer();

    const finish = (): void => {
      if (settled) return;
      // Check BEFORE settling: fail() no-ops when settled is already true,
      // so a no-text finish would otherwise leave the promise hanging.
      const text = lastAssistantText.trim();
      if (!text) return fail(new Error('agent_settled but no assistant text'));
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ text, durationMs: Date.now() - t0 });
    };

    const sendCommand = (obj: Record<string, unknown>): void => { child.stdin.write(JSON.stringify(obj) + '\n'); };

    // pi RPC wire records — intentionally untyped (wire format is pi's, not ours).
    const onRecord = async (rec: any): Promise<void> => {
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
        if (rec.aborted) return fail(new Error('agent run aborted: ' + JSON.stringify(rec.data || {}).slice(0, 300)));
        if (!promptSent) return fail(new Error('agent_settled before prompt was accepted'));
        return finish();
      }
      // Diagnostic: never swallow wire records we don't act on — silent
      // settlements without assistant text were invisible without this.
      if (rec.type !== 'extension_ui_request') {
        log('unhandled record:', rec.type, JSON.stringify(rec).slice(0, 400));
      }
      if (rec.type === 'extension_ui_request') {
        // Brain clarifying questions (org-lsv8): pi's extension UI sub-protocol.
        // Dialog methods block the agent until we write extension_ui_response
        // with the matching id; the WhatsApp bridge (index.ts) answers them.
        const method = String(rec.method || '');
        const isDialog = method === 'select' || method === 'input' || method === 'confirm' || method === 'editor';
        if (!isDialog) {
          log('extension ui (fire-and-forget):', method, JSON.stringify(rec).slice(0, 200));
          return;
        }
        const id = String(rec.id);
        log('extension ui dialog:', method, 'id=', id);
        clearTimeout(timer); // pause the run timeout while the group is being asked
        let resp: UiResponse | undefined;
        try {
          resp = o.onUiRequest ? await o.onUiRequest(rec as UiRequest) : { cancelled: true };
        } catch (e) {
          log('onUiRequest threw — cancelling dialog:', (e as Error).message);
          resp = { cancelled: true };
        }
        const out: Record<string, unknown> = { type: 'extension_ui_response', id };
        if (resp && resp.cancelled) out.cancelled = true;
        else if (resp && resp.value !== undefined) out.value = String(resp.value);
        else if (resp && typeof resp.confirmed === 'boolean') out.confirmed = resp.confirmed;
        else out.cancelled = true;
        try { sendCommand(out); } catch (e) { log('failed to write extension_ui_response:', (e as Error).message); }
        log('extension ui response:', method, JSON.stringify(out).slice(0, 300));
        armTimer();
        return;
      }
    };

    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let rec: any;
        try { rec = JSON.parse(line); }
        catch { log('non-JSON stdout line:', line.slice(0, 200)); continue; }
        void onRecord(rec).catch((e) => fail(e as Error));
      }
    });

    child.on('error', (e: Error) => fail(new Error('failed to start docker: ' + e.message)));
    child.on('exit', (code, sig) => {
      if (!settled) fail(new Error(`docker/pi exited (code=${code} sig=${sig}) before agent_settled. stderr: ${stderrBuf.slice(-800)}`));
    });
    child.stdin.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') fail(e); });

    sendCommand({ id: 's1', type: 'get_state' });
  });
}

// ---------------------------------------------------------------------------
// Public API — routed by group brain profile.
// ---------------------------------------------------------------------------
/** Resolve a group's session: slug from JID + per-group host dir (created). */
export function groupSession(group: GroupEntry, brain: BrainProfile): GroupSession {
  const id = groupSlug(group.jid ?? group.name);
  const hostDir = sessionHostDir(brain, id);
  // Must exist before docker mounts it (a docker-created dir would be root-owned).
  fs.mkdirSync(hostDir, { recursive: true });
  return { id, hostDir };
}

export async function runAsk(
  group: GroupEntry, ask: string,
  onUiRequest?: (req: UiRequest) => Promise<UiResponse> | UiResponse,
): Promise<BrainResult> {
  const brain = CFG.brains[group.brain];
  if (!brain) throw new Error(`unknown brain profile "${group.brain}"`);
  materializePiConfig();
  const session = groupSession(group, brain);
  const isFirstTurn = !sessionExists(session.hostDir);
  const prompt = brain.kind === 'cpo'
    ? buildCpoPrompt(ask, brain, isFirstTurn)
    : buildBeadsPrompt(ask, brain, isFirstTurn);
  const res = await runSandbox({
    prompt,
    // per-group workspace, NOT the shared beads repo (org-lsv8.17 decision)
    workspace: (brain.workspaceDir as string) || (brain.beadsRepoDir as string),
    beadsDir: brain.beadsRepoDir as string,
    timeoutMs: CFG.replyTimeoutMs as number,
    session,
    onUiRequest,
  });
  return { text: res.text, durationMs: res.durationMs };
}

export async function runRunMode(
  group: GroupEntry, arg: string,
  onUiRequest?: (req: UiRequest) => Promise<UiResponse> | UiResponse,
): Promise<BrainResult> {
  const brain = CFG.brains[group.brain];
  if (!brain) throw new Error(`unknown brain profile "${group.brain}"`);
  const session = groupSession(group, brain);
  if (brain.kind === 'cpo') return runSiteEdit(arg, brain, session, onUiRequest);
  return runBead(arg, brain, session, onUiRequest);
}

// ---------------------------------------------------------------------------
// kind "beads" — execute an open bead in the sandbox (inherited from ai-slop).
// ---------------------------------------------------------------------------
function bdShow(repoDir: string, id: string): Bead | null {
  const out = execFileSync('bd', ['show', id, '--json'], { cwd: repoDir, encoding: 'utf8', timeout: 20000 });
  const arr = JSON.parse(out);
  const b: any = Array.isArray(arr) ? arr[0] : arr;
  if (!b || b.id !== id) return null;
  return b as Bead;
}

function buildRunPrompt(bead: Bead, brain: BrainProfile): string {
  const P = getPrompts();
  const nl = String.fromCharCode(10);
  const spec = [bead.title, bead.description ? nl + bead.description : ''].join(nl).trim();
  return render(P['beads.run'], { botName: brain.botName || 'Bot', beadId: bead.id, beadSpec: spec });
}

function countFiles(dir: string): number {
  let n = 0;
  (function walk(d: string): void {
    let entries: fs.Dirent[] = [];
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
function collectTaskArtifacts(id: string, title: string, brain: BrainProfile): string | null {
  const dir = path.join(CFG.workDir as string, id);
  if (!fs.existsSync(dir) || countFiles(dir) === 0) return null;
  const repoDir = brain.artifactRepoDir || PROJECT_ROOT;
  let origin = '';
  try {
    origin = execFileSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 10000 }).trim();
  } catch { /* no origin */ }
  if (!origin) { log('no git origin on project repo — artifacts left in', dir); return null; }
  const branch = `task/${id}`;
  const g = (a: string[]): string =>
    execFileSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    try { g(['init', '-q', '-b', 'main']); } catch { /* already a repo (re-run) */ }
    g(['add', '-A']);
    g(['-c', 'user.name=Alexandre Girard Davila', '-c', 'user.email=gitea-lamai270@alexgirard.com', 'commit', '-q', '-m', `task/${id}: ${title}`]);
    g(['push', '--force', '-q', origin, `main:refs/heads/${branch}`]);
    log('artifacts for', id, 'pushed to branch', branch);
    return branch;
  } catch (e) {
    log('artifact push failed for', id, ':', String((e as Error).message || e).slice(0, 200));
    return null;
  }
}

async function runBead(
  rawId: string, brain: BrainProfile, session: GroupSession,
  onUiRequest?: (req: UiRequest) => Promise<UiResponse> | UiResponse,
): Promise<BrainResult> {
  const id = String(rawId || '').trim();
  if (!/^[a-z]+-[a-z0-9]{3,10}(\.\d+)?$/i.test(id)) {
    return { text: `That doesn't look like a bead id ("${rawId}"). Usage: pi ${brain.runCmd} <bead-id>` };
  }
  let bead: Bead | null;
  try { bead = bdShow(brain.beadsRepoDir as string, id); } catch { bead = null; }
  if (!bead) return { text: `No bead found with id ${id}. Send "pi" alone to list the open ones.` };
  const labels = bead.labels || [];
  if (!labels.includes(brain.beadsLabel as string)) {
    return { text: `${id} is not a ${brain.beadsLabel} bead — I only run beads labelled ${brain.beadsLabel}.` };
  }
  if (bead.status !== 'open') {
    return { text: `${id} is already ${bead.status} — nothing to run. Reopen it to retry.` };
  }

  materializePiConfig();
  const taskDir = path.join(CFG.workDir as string, id);
  fs.mkdirSync(taskDir, { recursive: true });

  const res = await runSandbox({
    prompt: buildRunPrompt(bead, brain),
    workspace: (brain.workspaceDir as string) || (brain.beadsRepoDir as string),
    beadsDir: brain.beadsRepoDir as string,
    timeoutMs: CFG.runTimeoutMs as number,
    session,
    extraVolumes: [[taskDir, '/task']],
    onUiRequest,
  });

  const branch = collectTaskArtifacts(id, bead.title, brain);
  let closed = false;
  try { closed = (bdShow(brain.beadsRepoDir as string, id) as Bead).status === 'closed'; } catch { /* leave open */ }

  const parts = [res.text.trim()];
  if (branch) parts.push(`📦 artifacts → Gitea branch ${branch}`);
  if (!closed) parts.push(`⚠️ ${id} left open (blocked or unfinished)`);
  return { text: parts.join('\n'), durationMs: res.durationMs, meta: { id, closed, branch } };
}

// ---------------------------------------------------------------------------
// kind "cpo" — run mode "edit": edit the website-draft checkout inside the
// sandbox, verify with hugo, commit + push origin main (→ GitHub Pages).
// Host-side verification: main must actually have moved, otherwise warn.
// ---------------------------------------------------------------------------
async function runSiteEdit(
  instruction: string, brain: BrainProfile, session: GroupSession,
  onUiRequest?: (req: UiRequest) => Promise<UiResponse> | UiResponse,
): Promise<BrainResult> {
  const instr = String(instruction || '').trim();
  if (!instr) return { text: 'Usage: pi edit <what to change on the site>' };
  let preSha = '';
  try { preSha = execFileSync('git', ['-C', brain.siteDir as string, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* no repo yet */ }

  materializePiConfig();
  materializeGitHome();

  const res = await runSandbox({
    prompt: buildSitePrompt(instr, brain),
    workspace: (brain.workspaceDir as string) || (brain.beadsRepoDir as string),
    beadsDir: brain.beadsRepoDir as string, // live CPO beads DB (agent is prompt-scoped read-only)
    timeoutMs: CFG.runTimeoutMs as number,
    session,
    extraVolumes: [
      [brain.siteDir as string, '/task-site'],
      [path.join(CFG.gitHomeDir as string, '.gitconfig'), '/home/node/.gitconfig'],
      [path.join(CFG.gitHomeDir as string, '.git-credentials'), '/home/node/.git-credentials'],
    ],
    onUiRequest,
  });

  let postSha = '';
  try { postSha = execFileSync('git', ['-C', brain.siteDir as string, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* no repo yet */ }
  const parts = [res.text.trim()];
  if (postSha && postSha !== preSha) {
    log('site main moved:', preSha.slice(0, 8), '→', postSha.slice(0, 8));
  } else {
    parts.push('⚠️ aucun commit n\u2019est apparu sur main côté serveur — vérifie avant de regarder le site.');
  }
  return { text: parts.join('\n'), durationMs: res.durationMs, meta: { preSha: preSha || null, postSha: postSha || null } };
}
