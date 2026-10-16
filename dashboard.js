#!/usr/bin/env node
/**
 * dashboard.js — zero-dependency HTML dashboard for wa-orchestrator (org-y05d)
 *
 * Serves on :8093 (8092 = ai-slop-dashboard), bound to ALL interfaces
 * (reachable via lamai270's addresses; the box sits on a private tailnet):
 *   /            HTML page: CPO beads (live repo /home/alx/org) + latest bot activity
 *   /api/beads   raw JSON: last good beads snapshot
 *   /api/activity raw JSON: last N activity events
 *
 * Beads are refreshed in the background every REFRESH_MS by spawning
 * `bd list -s all --json --brief` in /home/alx/org, then filtering the CPO
 * trees (org-9s8 / org-a0s5 + descendants) in-process. If that call fails
 * (e.g. Dolt lock contention while the in-container brain is working), the
 * last good snapshot keeps being served.
 *
 * Auto-refresh is a plain <meta refresh> — no JS, no deps.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = 8093; // 8092 = ai-slop-dashboard
const HOST = process.env.DASHBOARD_HOST || '0.0.0.0'; // bind host-wide
const TOKEN = process.env.DASHBOARD_TOKEN || ''; // optional: require ?token=<TOKEN> when set
const REFRESH_MS = 30000; // beads snapshot refresh
const ACTIVITY_TAIL = 25; // events shown / served
const ACTIVITY_FILE = CFG.activityLog;
const BD_BIN = process.env.BD_BIN || 'bd';
const CPO_EPICS = (CFG.brains.cpo && CFG.brains.cpo.epics) || ['org-9s8', 'org-a0s5'];
const CPO_REPO = (CFG.brains.cpo && CFG.brains.cpo.beadsRepoDir) || '/home/alx/org';
const isCpo = (id) => CPO_EPICS.some((e) => id === e || id.startsWith(e + '.'));

// ---------------- beads snapshot ----------------
let beadsCache = { ts: 0, error: null, items: [] };
function refreshBeads() {
  const child = spawn(BD_BIN, ['list', '-s', 'all', '--json', '--brief'], {
    cwd: CPO_REPO,
    env: { ...process.env, NO_COLOR: '1' },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.on('error', (e) => onBdDone(null, `spawn: ${e.message}`));
  child.on('close', (code) => onBdDone(code === 0 ? out : null, code === 0 ? null : `bd exited ${code}`));
}
function onBdDone(out, err) {
  if (out) {
    try {
      const all = JSON.parse(out);
      const items = all.filter((b) => isCpo(b.id));
      beadsCache = { ts: Date.now(), error: null, items };
    } catch (e) {
      beadsCache = { ...beadsCache, error: `json: ${e.message}` };
    }
  } else if (err) {
    beadsCache = { ...beadsCache, error: err };
  }
}

// ---------------- activity tail ----------------
let actCache = { mtimeMs: -1, events: [] };
function activityTail() {
  let st;
  try { st = fs.statSync(ACTIVITY_FILE); } catch { return []; }
  if (st.mtimeMs === actCache.mtimeMs && st.size === actCache.size) return actCache.events;
  let text = '';
  try { text = fs.readFileSync(ACTIVITY_FILE, 'utf8'); } catch (e) { return actCache.events; }
  const lines = text.split('\n').filter(Boolean).slice(-ACTIVITY_TAIL);
  const events = [];
  for (const l of lines) {
    try { events.push(JSON.parse(l)); } catch { /* skip partial line */ }
  }
  actCache = { mtimeMs: st.mtimeMs, size: st.size, events };
  return events;
}

// ---------------- html ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_ICON = { open: '○', in_progress: '◐', closed: '✓', blocked: '●', deferred: '❄' };
const STATUS_CLASS = { open: 'st-open', in_progress: 'st-prog', closed: 'st-closed', blocked: 'st-blocked', deferred: 'st-defer' };

function beadRows(items) {
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

function activityRows(events) {
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

function render() {
  const b = beadsCache;
  const events = activityTail();
  const beadCount = b.items.length;
  const openCount = b.items.filter((x) => x.status === 'open' || x.status === 'in_progress').length;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>AI Slop — dashboard</title>
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
<h1>📷 CPO <span class="dim">— beads + bot activity (refreshes every 10s)</span></h1>
<div class="meta">
  beads: ${beadCount} total · ${openCount} open · snapshot ${b.ts ? new Date(b.ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : 'n/a'}
  ${b.error ? `<span class="err"> · beads refresh error: ${esc(b.error)} (showing last good snapshot)</span>` : ''}
</div>
<h2>beads CPO <span class="count">(repo /home/alx/org, arbres org-9s8 + org-a0s5)</span></h2>
<table><thead><tr><th>id</th><th>title</th><th>status</th><th>pri</th><th>type</th><th>updated</th></tr></thead>
<tbody>
${beadRows(b.items)}
</tbody></table>
<h2>latest activity <span class="count">(activity/activity.jsonl)</span></h2>
<table><thead><tr><th>time</th><th>kind</th><th>text</th></tr></thead>
<tbody>
${activityRows(events)}
</tbody></table>
</div></body></html>`;
}

// ---------------- server ----------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (TOKEN && url.searchParams.get('token') !== TOKEN) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  const u = url.pathname;
  if (u === '/api/beads') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(beadsCache, null, 1));
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

refreshBeads();
setInterval(refreshBeads, REFRESH_MS);
server.listen(PORT, HOST, () => console.log(`[dashboard] http://${HOST}:${PORT}/ (beads: ${CPO_REPO} [CPO filter], refresh ${REFRESH_MS / 1000}s, token ${TOKEN ? 'REQUIRED' : 'off'})`));
