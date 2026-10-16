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
import { listAccountGroups } from './groups';
import { runAsk, runRunMode } from './brain';

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

// ---------------- trigger parsing ----------------
function parseAsk(body: string): string | null {
  const t = (body || '').trim();
  if (!t) return null;
  const m = t.match(/^pi(?:\s+([\s\S]+))?$/i);
  if (!m) return null;
  return m[1] ? m[1].trim() : '';
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

  const ask = parseAsk(body);
  if (ask === null) return;
  // run mode: "<runCmd> <rest>" — e.g. "run org-xxxx" / "edit change X"
  const runM = ask.match(new RegExp(`^${brain.runCmd}\\s+(\\S[\\s\\S]*)$`, 'i'));
  const isRun = !!runM;
  const effectiveAsk: string = isRun ? (runM[1] as string).trim() : (ask === '' ? (brain.defaultAsk ?? '') : ask);

  log(isRun ? 'RUN' : 'ASK', `[${group.name}]`, 'from', m.from, ':', effectiveAsk.slice(0, 200));
  activity(isRun ? 'run_start' : 'ask', {
    group: group.name, from: m.from,
    ...(isRun ? { runCmd: brain.runCmd, text: effectiveAsk.slice(0, 300) } : { text: effectiveAsk }),
  });

  if (!CFG.dryRun) safeSend(remote as string, (CFG.botPrefix ?? '') + (isRun
    ? `⏳ ${brain.runCmd}ing — this can take a while…`
    : 'on it — the brain is thinking…'));

  enqueue(async () => {
    const t0 = Date.now();
    try {
      const res = isRun
        ? await runRunMode(group, effectiveAsk)
        : await runAsk(group, ask === '' ? (brain.defaultAsk ?? '') : ask);
      // Keep newlines (one-item-per-line list format!) — only squeeze spaces.
      const pretty = res.text.replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
      const reply = (CFG.botPrefix ?? '') + pretty;
      if (CFG.dryRun) log('DRY-RUN reply:', reply);
      else safeSend(remote as string, reply);
      if (isRun) activity('run_done', { group: group.name, from: m.from, ms: Date.now() - t0, meta: res.meta });
      activity('reply', { group: group.name, from: m.from, text: res.text.slice(0, 500), ms: Date.now() - t0 });
    } catch (e) {
      log('BRAIN FAILED [', group.name, ']:', (e as Error).message);
      activity('error', { group: group.name, from: m.from, ask: effectiveAsk, error: (e as Error).message.slice(0, 500) });
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
