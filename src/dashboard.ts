#!/usr/bin/env node
/**
 * dashboard.ts — zero-dependency HTML dashboard for wa-orchestrator
 *
 * Serves on :8093 by default (override with DASHBOARD_PORT), bound to ALL
 * interfaces (box sits on a private tailnet; optional bearer via DASHBOARD_TOKEN):
 *   /             HTML page: scoped beads (every brain profile with kind
 *                 "cpo", each filtered to its own epics) + latest bot activity
 *   /api/beads    raw JSON: last good beads snapshots (one per scope)
 *   /api/activity raw JSON: last N activity events
 *
 * Beads are refreshed in the background every REFRESH_MS by spawning
 * `bd list -s all --json --brief` in each scope's repo, then filtering to the
 * scope's epics in-process. If a call fails (e.g. Dolt lock contention while
 * an in-container brain is working), the last good snapshot keeps being served.
 *
 * Auto-refresh is a plain <meta refresh> — no JS, no deps.
 */
import * as http from 'http';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { loadConfig, Config, BrainProfile } from './config';

const CFG: Config = loadConfig();
const PORT = Number(process.env.DASHBOARD_PORT || 8093);
const HOST = process.env.DASHBOARD_HOST || '0.0.0.0'; // bind host-wide
const TOKEN = process.env.DASHBOARD_TOKEN || ''; // optional: require ?token=<TOKEN> when set
const REFRESH_MS = 30000; // beads snapshot refresh
const ACTIVITY_TAIL = 25; // events shown / served
const ACTIVITY_FILE = CFG.activityLog as string;
const BD_BIN = process.env.BD_BIN || 'bd';

// One "scope" per brain profile of kind "cpo": its beads repo + epic filter.
interface Scope {
  name: string;
  repo: string;
  epics: string[];
}

const SCOPES: Scope[] = Object.entries(CFG.brains ?? {})
  .filter(([, v]) => v && v.kind === 'cpo' && v.beadsRepoDir)
  .map(([name, v]) => ({ name, repo: v.beadsRepoDir as string, epics: (v.epics as string[]) ?? [] }));

const inScope = (scope: Scope, id: string): boolean =>
  scope.epics.some((e) => id === e || id.startsWith(e + '.'));

// ---------------- beads snapshots (per scope) ----------------
interface BeadItem {
  id: string;
  title: string;
  status: string;
  priority?: number | string;
  issue_type?: string;
  updated_at?: string;
  [k: string]: unknown;
}
interface Snapshot {
  ts: number;
  error: string | null;
  items: BeadItem[];
}
const caches = new Map<string, Snapshot>(); // scope.name → snapshot
for (const s of SCOPES) caches.set(s.name, { ts: 0, error: null, items: [] });

function refreshScope(scope: Scope): void {
  const child = spawn(BD_BIN, ['list', '-s', 'all', '--json', '--brief'], {
    cwd: scope.repo,
    env: { ...process.env, NO_COLOR: '1' },
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.on('error', (e: Error) => onBdDone(scope, null, `spawn: ${e.message}`));
  child.on('close', (code) => onBdDone(scope, code === 0 ? out : null, code === 0 ? null : `bd exited ${code}`));
}
function onBdDone(scope: Scope, out: string | null, err: string | null): void {
  const prev = caches.get(scope.name) as Snapshot;
  if (out) {
    try {
      const all: BeadItem[] = JSON.parse(out);
      const items = all.filter((b) => inScope(scope, b.id));
      caches.set(scope.name, { ts: Date.now(), error: null, items });
    } catch (e) {
      caches.set(scope.name, { ...prev, error: `json: ${(e as Error).message}` });
    }
  } else if (err) {
    caches.set(scope.name, { ...prev, error: err });
  }
}

// ---------------- activity tail ----------------
interface ActivityCache {
  mtimeMs: number;
  size: number;
  events: any[];
}
let actCache: ActivityCache = { mtimeMs: -1, size: -1, events: [] };
function activityTail(): any[] {
  let st: fs.Stats;
  try { st = fs.statSync(ACTIVITY_FILE); } catch { return []; }
  if (st.mtimeMs === actCache.mtimeMs && st.size === actCache.size) return actCache.events;
  let text = '';
  try { text = fs.readFileSync(ACTIVITY_FILE, 'utf8'); } catch { return actCache.events; }
  const lines = text.split('\n').filter(Boolean).slice(-ACTIVITY_TAIL);
  const events: any[] = [];
  for (const l of lines) {
    try { events.push(JSON.parse(l)); } catch { /* skip partial line */ }
  }
  actCache = { mtimeMs: st.mtimeMs, size: st.size, events };
  return events;
}

// ---------------- html ----------------
const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const STATUS_ICON: Record<string, string> = { open: '○', in_progress: '◐', closed: '✓', blocked: '●', deferred: '❄' };
const STATUS_CLASS: Record<string, string> = { open: 'st-open', in_progress: 'st-prog', closed: 'st-closed', blocked: 'st-blocked', deferred: 'st-defer' };

function beadRows(items: BeadItem[]): string {
  return items
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .map(
      (b) => `<tr class="${esc(b.status)}">
      <td class="id">${esc(b.id)}</td>
      <td class="title">${esc(b.title)}</td>
      <td class="st ${STATUS_CLASS[b.status] || ''}">${STATUS_ICON[b.status] || '?'} ${esc(b.status)}</td>
      <td class="pri">P${esc(b.priority)}</td>
      <td class="type">${esc(b.issue_type || 'task')}</td>
      <td class="upd">${esc((b.updated_at || '').slice(0, 16).replace('T', ' '))}</td>
    </tr>`
    )
    .join('\n');
}

function activityRows(events: any[]): string {
  return events
    .slice()
    .reverse()
    .map(
      (e) => `<tr>
      <td class="ts">${esc((e.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td class="kind kind-${esc(e.kind)}">${esc(e.kind)}</td>
      <td class="atext">${esc(String(e.text || '').slice(0, 160))}</td>
    </tr>`
    )
    .join('\n') || '<tr><td colspan="3" class="empty">no activity yet</td></tr>';
}

function scopeSection(scope: Scope): string {
  const b = caches.get(scope.name) as Snapshot;
  const openCount = b.items.filter((x) => x.status === 'open' || x.status === 'in_progress').length;
  return `<h2>beads — ${esc(scope.name)} <span class="count">(${b.items.length} total · ${openCount} open · repo ${esc(scope.repo)}, epics ${scope.epics.map(esc).join(' + ')}${scope.epics.length ? ' + descendants' : ''})</span></h2>
<table><thead><tr><th>id</th><th>title</th><th>status</th><th>pri</th><th>type</th><th>updated</th></tr></thead>
<tbody>
${beadRows(b.items)}
</tbody></table>
<div class="meta">snapshot ${b.ts ? new Date(b.ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : 'n/a'}${b.error ? ` <span class="err">· beads refresh error: ${esc(b.error)} (showing last good snapshot)</span>` : ''}</div>`;
}

function render(): string {
  const totalBeads = [...caches.values()].reduce((n, c) => n + c.items.length, 0);
  const scopesHtml = SCOPES.map(scopeSection).join('\n');
  const events = activityTail();
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>wa-orchestrator — dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; color: #c9d1d9; margin: 0; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 18px 20px 60px; }
  h1 { font-size: 18px; margin: 0 0 4px; } h1 .dim { color: #57606a; font-weight: normal; }
  .meta { color: #57606a; font-size: 12px; margin-bottom: 18px; }
  .meta .err { color: #f85149; }
  h2 { font-size: 14px; margin: 26px 0 8px; color: #79c0ff; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #57606a; font-weight: normal; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; padding: 4px 10px 4px 0; border-bottom: 1px solid #21262d; }
  td { padding: 5px 10px 5px 0; vertical-align: top; border-bottom: 1px solid #161b22; }
  tr:last-child td { border-bottom: none; }
  td.id, td.ts { color: #57606a; white-space: nowrap; }
  td.title { max-width: 46%; }
  td.st { white-space: nowrap; }
  .st-open { color: #3fb950; } .st-prog { color: #d29922; } .st-closed { color: #57606a; } .st-blocked { color: #f85149; } .st-defer { color: #8b949e; }
  .kind-ask { color: #d29922; } .kind-reply { color: #3fb950; } .kind-error { color: #f85149; }
  td.atext { max-width: 60%; color: #8b949e; }
  .empty { color: #57606a; }
  .count { color: #57606a; font-weight: normal; font-size: 12px; }
</style></head><body><div class="wrap">
<h1>📡 wa-orchestrator <span class="dim">— scoped beads + bot activity (refreshes every 10s)</span></h1>
<div class="meta">
  beads: ${totalBeads} total across ${SCOPES.length} scope(s)
</div>
${scopesHtml}
<h2>latest activity <span class="count">(activity/activity.jsonl)</span></h2>
<table><thead><tr><th>time</th><th>kind</th><th>text</th></tr></thead>
<tbody>
${activityRows(events)}
</tbody></table>
</div></body></html>`;
}

// ---------------- server ----------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (TOKEN && url.searchParams.get('token') !== TOKEN) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  const u = (req.url ?? '').split('?')[0];
  if (u === '/api/beads') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const out: Record<string, unknown> = {};
    for (const s of SCOPES) out[s.name] = { repo: s.repo, epics: s.epics, ...(caches.get(s.name) as Snapshot) };
    return res.end(JSON.stringify(out, null, 1));
  }
  if (u === '/api/activity') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(activityTail(), null, 1));
  }
  if (u === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(render());
});

for (const s of SCOPES) refreshScope(s);
setInterval(() => { for (const s of SCOPES) refreshScope(s); }, REFRESH_MS);
server.listen(PORT, HOST, () => console.log(`[dashboard] http://${HOST}:${PORT}/ (scopes: ${SCOPES.map((s) => s.name).join(', ') || 'none'}, refresh ${REFRESH_MS / 1000}s, token ${TOKEN ? 'REQUIRED' : 'off'})`));
