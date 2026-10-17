#!/usr/bin/env node
/**
 * index.ts — unified WhatsApp bot (org-y05d, decision B1).
 *
 * ONE process, ONE WhatsApp account (the owner's; wwebjs + LocalAuth, headful
 * Chromium under Xvfb), MANY groups — a registry in config.json:
 *
 *   "groups": [{ "jid", "name", "brain" }, ...]
 *
 * Each entry names a brain profile in config.brains. Adding a new group =
 * adding one entry here (that is the whole contract).
 *
 * Per group:
 *   - trigger: body === "pi" or starts with "pi " (case-insensitive)
 *   - free text  → that brain's list/ask mode
 *   - "<runCmd> …" (brain.runCmd: e.g. "run" for beads work items, "edit"
 *     for site edits) → the brain's run mode
 *
 * Own-message filter: bot posts are prefixed "🤖 " (stateless) + rolling set
 * of sent remote message ids (self-learning secondary).
 *
 * Ops:
 *   - `node dist/index.js` under xvfb-run (headful required).
 *   - SELFTEST_GROUP=<name|jid> SELFTEST_ASK="<text>" env: after `ready`, the
 *     bot sends the ask to that group via its own client (no 🤖 prefix →
 *     it is processed like a member message) — full-loop test without a human.
 *   - On `ready` the account's groups are enumerated (raw store) and logged —
 *     this is how you discover a group JID for the registry.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import qrcode = require('qrcode-terminal');
import { loadConfig, Config, GroupEntry } from './config';
import { parseAsk, parseRun } from './trigger';
import { listAccountGroups } from './groups';
import { runAsk, runRunMode, UiRequest, UiResponse } from './brain';
import { formatQuestion, mapSelectReply } from './dialog';
import { groupSlug, sessionHostDir, resetSession } from './session';

const CFG: Config = loadConfig();

const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[bot]', ...a);

// ---------------- activity log ----------------
function activity(kind: string, extra: Record<string, unknown> = {}): void {
  try {
    const p = CFG.activityLog as string;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (fs.existsSync(p) && fs.statSync(p).size > (CFG.activityMaxBytes ?? 1048576)) {
      fs.renameSync(p, p + '.old');
    }
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), kind, ...extra }) + '\n');
  } catch (e) {
    log('activity log error:', (e as Error).message);
  }
}

// ---------------- group registry ----------------
const groupsByJid = new Map<string, GroupEntry>();
for (const g of CFG.groups) {
  const jid = (g.jid || '').trim();
  if (!jid || jid.startsWith('__')) { log('registry entry without JID (skipped):', g.name); continue; }
  if (!CFG.brains[g.brain]) { log('registry entry with unknown brain (skipped):', g.name, '→', g.brain); continue; }
  groupsByJid.set(jid, g);
  log('registry:', g.name, jid, '→ brain', g.brain);
}

// ---------------- own-message dedup (rolling, self-learning) ----------------
const sentIds = new Set<string>();
function rememberSent(id?: string): void {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > 200) {
    const first = sentIds.values().next().value;
    if (first !== undefined) sentIds.delete(first);
  }
}

// ---------------- brain-question bridge (org-lsv8) ----------------
// When the sandboxed brain asks a clarifying question (pi-ask-questions over
// RPC extension UI), the question is posted in the GROUP and the next member
// message in that group becomes the answer. One pending dialog per group.
type PendingAnswer = { resolve: (text: string) => void };
const pendingAnswers = new Map<string, PendingAnswer>(); // key: group JID
/** Free text to auto-answer the follow-up "Type something." input (per JID). */
const autoTypes = new Map<string, string>();

/**
 * The per-group onUiRequest handed to the brain: posts the question in the
 * group, waits for the next member message there, maps it back to the RPC
 * response. Owns the deadline (questionTimeoutMs) — brain just writes what
 * this returns.
 */
function makeUiHandler(jid: string, groupName: string) {
  return async (req: UiRequest): Promise<UiResponse> => {
    const method = req.method;
    if (method !== 'select' && method !== 'input') {
      log('dialog method without WA equivalent, cancelling:', method);
      return { cancelled: true };
    }
    // Follow-up input after the member picked "Type something.": the free text
    // already sits in autoTypes — answer instantly, the group never sees it.
    const auto = autoTypes.get(jid);
    if (method === 'input' && auto !== undefined) {
      autoTypes.delete(jid);
      log('auto-answered typed question for', groupName);
      activity('question_answered', { group: groupName, method, autoTyped: true, text: auto.slice(0, 300) });
      return { value: auto };
    }
    const qTimeout = CFG.questionTimeoutMs ?? 1800000;
    const deadline = Date.now() + qTimeout;
    for (;;) {
      if (CFG.dryRun) return { cancelled: true };
      const question = formatQuestion(req);
      safeSend(jid, (CFG.botPrefix ?? '') + question);
      activity('question_asked', { group: groupName, method, question: question.slice(0, 500) });
      const answer: string | null = await new Promise<string | null>((resolve) => {
        // Identity-guarded: a stale deadline timer from a previous dialog must
        // never clobber a newer pending entry for the same group.
        let timer: NodeJS.Timeout;
        const entry: PendingAnswer = {
          resolve: (text: string) => {
            clearTimeout(timer);
            if (pendingAnswers.get(jid) === entry) pendingAnswers.delete(jid);
            resolve(text);
          },
        };
        pendingAnswers.set(jid, entry);
        timer = setTimeout(() => {
          if (pendingAnswers.get(jid) === entry) pendingAnswers.delete(jid);
          resolve(null); // deadline — release the waiter
        }, Math.max(0, deadline - Date.now()));
      });
      if (answer === null) {
        log('question deadline reached — cancelling dialog for', groupName);
        activity('question_timeout', { group: groupName, method });
        return { cancelled: true };
      }
      if (method === 'input') {
        activity('question_answered', { group: groupName, method, text: answer.slice(0, 300) });
        if (!CFG.dryRun) safeSend(jid, (CFG.botPrefix ?? '') + '✅ Got it — continuing…');
        return { value: answer };
      }
      // select
      const mapped = mapSelectReply((req.options || []) as string[], answer);
      if (mapped.value !== undefined) {
        if (mapped.autoType !== undefined) autoTypes.set(jid, mapped.autoType);
        activity('question_answered', { group: groupName, method, text: answer.slice(0, 300) });
        if (!CFG.dryRun) safeSend(jid, (CFG.botPrefix ?? '') + '✅ Got it — continuing…');
        return { value: mapped.value };
      }
      // hint and ask again (the deadline still bounds the loop)
      if (!CFG.dryRun) safeSend(jid, (CFG.botPrefix ?? '') + (mapped.hint || 'Please pick one of the numbered options.'));
    }
  };
}

// ---------------- serial queue (one brain run at a time, bot-wide) ----------------
let chain: Promise<unknown> = Promise.resolve();
function enqueue(fn: () => Promise<void>): Promise<void> {
  const run = () => fn();
  const p = chain.then(run, run) as Promise<void>;
  chain = p.then(() => {}, () => {});
  return p;
}

// ---------------- client ----------------
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: CFG.sessionsDir }),
  puppeteer: {
    executablePath: CFG.chromiumPath,
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  },
});

function safeSend(jid: string, text: string): Promise<unknown> {
  // send works but the return-value path sometimes throws non-fatally (spike finding).
  return client.sendMessage(jid, text).catch((e: Error) => {
    log('sendMessage threw (message may still have delivered):', e.message);
  });
}

async function onMessage(m: Message): Promise<void> {
  const chat: any = (m as any).chat; // populated at runtime, absent from type defs
  const remote: string | null =
    (m.id && m.id.remote) || (chat && chat.id && chat.id._serialized) || null;
  const group = remote ? groupsByJid.get(remote) : undefined;
  if (!group) return;                                  // not a registered group
  const brain = CFG.brains[group.brain];
  if (m.type && m.type !== 'chat') return;             // skip reactions & co.
  const body = (m.body || '').trim();
  if (!body) return;
  if (body.startsWith('🤖')) { rememberSent(m.id && m.id.id); return; } // own (stateless)
  if (m.id && m.id.id && sentIds.has(m.id.id)) return; // own (id dedup)

  // Pending brain question (org-lsv8): while the brain is asking THIS group a
  // clarifying question, any member message is the answer — not a trigger.
  const pending = remote ? pendingAnswers.get(remote) : undefined;
  if (pending && remote) {
    pendingAnswers.delete(remote);
    log('DIALOG ANSWER', `[${group.name}]`, 'from', m.from, ':', body.slice(0, 200));
    pending.resolve(body);
    return;
  }

  const ask = parseAsk(body);
  if (ask === null) return;
  const sessionId = groupSlug(remote ?? group.name);

  // Conversation reset (org-1v4b): "new" — rename this group's pi session dir
  // aside so the next message starts a fresh conversation. Queued so it can
  // never race an in-flight brain call for the same group.
  if (ask.trim().toLowerCase() === 'new') {
    enqueue(async () => {
      const hostDir = sessionHostDir(brain, sessionId);
      const did = resetSession(hostDir);
      log('SESSION RESET', `[${group.name}]`, did ? 'session moved aside' : '(no active session)');
      activity('session_reset', { group: group.name, from: m.from, sessionId, reset: did });
      if (!CFG.dryRun) safeSend(remote as string, (CFG.botPrefix ?? '') + (did
        ? '🧹 conversation reset — starting fresh.'
        : '🧹 (no active conversation to reset)'));
    });
    return;
  }

  // run mode: "<runCmd> <rest>" — e.g. "run org-xxxx" / "edit change X"
  const runArg = parseRun(ask, brain.runCmd as string);
  const isRun = runArg !== null;
  const effectiveAsk: string = isRun ? (runArg as string) : (ask === '' ? (brain.defaultAsk ?? '') : ask);

  log(isRun ? 'RUN' : 'ASK', `[${group.name}]`, 'from', m.from, ':', effectiveAsk.slice(0, 200));
  activity(isRun ? 'run_start' : 'ask', {
    group: group.name, from: m.from, sessionId,
    ...(isRun ? { runCmd: brain.runCmd, text: effectiveAsk.slice(0, 300) } : { text: effectiveAsk }),
  });

  if (!CFG.dryRun) safeSend(remote as string, (CFG.botPrefix ?? '') + (isRun
    ? `⏳ ${brain.runCmd}ing — this can take a while…`
    : 'on it — the brain is thinking…'));

  enqueue(async () => {
    const t0 = Date.now();
    try {
      const uiHandler = remote ? makeUiHandler(remote, group.name) : undefined;
      const res = isRun
        ? await runRunMode(group, effectiveAsk, uiHandler)
        : await runAsk(group, ask === '' ? (brain.defaultAsk ?? '') : ask, uiHandler);
      // Keep newlines (one-item-per-line list format!) — only squeeze spaces.
      const pretty = res.text.replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
      const reply = (CFG.botPrefix ?? '') + pretty;
      if (CFG.dryRun) log('DRY-RUN reply:', reply);
      else safeSend(remote as string, reply);
      if (isRun) activity('run_done', { group: group.name, from: m.from, sessionId, ms: Date.now() - t0, meta: res.meta });
      activity('reply', { group: group.name, from: m.from, sessionId, text: res.text.slice(0, 500), ms: Date.now() - t0 });
    } catch (e) {
      log('BRAIN FAILED [', group.name, ']:', (e as Error).message);
      activity('error', { group: group.name, from: m.from, sessionId, ask: effectiveAsk, error: (e as Error).message.slice(0, 500) });
      if (!CFG.dryRun) safeSend(remote as string, (CFG.botPrefix ?? '') + '⚠️ something broke in the brain: ' + (e as Error).message.slice(0, 160));
    }
  });
}

// ---------------- lifecycle ----------------
client.on('qr', (qr: string) => {
  log('QR NEEDED — scan with the linked device flow:');
  qrcode.generate(qr, { small: true });
  activity('error', { error: 'qr_required' });
});
client.on('auth_failure', (msg: unknown) => { log('AUTH FAILURE:', msg); activity('error', { error: 'auth_failure: ' + String(msg) }); });
client.on('authenticated', () => log('authenticated'));
client.on('ready', async () => {
  log('CLIENT READY — registered groups:');
  for (const g of CFG.groups) log('  -', g.name || '(no JID yet)', g.jid || '—');
  activity('info', { text: 'bot ready', groups: CFG.groups.map((g) => g.name) });
  // Discover/log the account's real groups (JIDs) — ops + registry check.
  try {
    const acc = await listAccountGroups(client);
    log('account groups (raw store):', JSON.stringify(acc));
    activity('info', { text: 'account groups', groups: acc });
  } catch (e) { log('group enumeration failed:', (e as Error).message); }

  // Optional full-loop self test: send a member-style message to group(s).
  // SELFTEST_GROUP="name1,name2" (comma-separated); the group's
  // brain.defaultAsk (or SELFTEST_ASK) is used.
  const stGroups = String(process.env.SELFTEST_GROUP || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const stName of stGroups) {
    const g = CFG.groups.find((x) => x.name === stName || x.jid === stName);
    if (g && g.jid && !g.jid.startsWith('__')) {
      const text = 'pi ' + (process.env.SELFTEST_ASK || (CFG.brains[g.brain].defaultAsk ?? ''));
      log('SELFTEST →', g.name, ':', text.slice(0, 120));
      await new Promise((r) => setTimeout(r, 2000)); // let the client settle
      safeSend(g.jid, text); // no 🤖 prefix → processed as a member ask
    } else {
      log('SELFTEST group not resolvable:', stName);
    }
  }
});
client.on('disconnected', (reason: unknown) => {
  log('DISCONNECTED:', reason);
  activity('error', { error: 'disconnected: ' + String(reason) });
  process.exit(2); // let systemd restart
});
client.on('message_create', (m) => {
  try { onMessage(m).catch((e: Error) => log('onMessage error:', e.message)); }
  catch (e) { log('onMessage sync error:', (e as Error).message); }
});

client.initialize().catch((e: Error) => log('INIT ERROR:', e.message));
