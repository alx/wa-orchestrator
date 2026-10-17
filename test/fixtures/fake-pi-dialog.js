#!/usr/bin/env node
'use strict';
/**
 * fake-pi-dialog.js — test fixture speaking just enough of pi's RPC
 * protocol to exercise brain.runSandbox's extension-UI dialog handling
 * (org-lsv8.4). Flow:
 *
 *   get_state  → response (model from $FAKE_PI_MODEL, default "model-x")
 *   prompt     → success, then extension_ui_request select (id "ui-1")
 *   ui-1 reply → if cancelled: finish. Else extension_ui_request input ("ui-2")
 *   ui-2 reply → assistant message_end + agent_settled
 *
 * Every stdin record is appended (JSON line) to $FAKE_PI_LOG so tests can
 * assert the exact extension_ui_response records the brain wrote.
 */
const fs = require('fs');

const log = (rec) => {
  const f = process.env.FAKE_PI_LOG;
  if (f) fs.appendFileSync(f, JSON.stringify(rec) + '\n');
};
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const OPTIONS = [
  '1. Tree: nested by account',
  '2. Flat list: one row per item',
  '3. Type something.:',
];
let stage = 'wait-state';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    log(rec);
    handle(rec);
  }
});

function handle(rec) {
  if (stage === 'wait-state' && rec.type === 'get_state') {
    send({
      type: 'response', command: 'get_state', success: true,
      data: { model: { id: process.env.FAKE_PI_MODEL || 'model-x' } },
    });
    stage = 'wait-prompt';
    return;
  }
  if (stage === 'wait-prompt' && rec.type === 'prompt') {
    send({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    send({
      type: 'extension_ui_request', id: 'ui-1', method: 'select',
      title: 'Which layout should the demo section use?', options: OPTIONS,
    });
    stage = 'wait-ui1';
    return;
  }
  if (stage === 'wait-ui1' && rec.type === 'extension_ui_response' && rec.id === 'ui-1') {
    if (rec.cancelled) return finish('cancelled after select');
    send({ type: 'extension_ui_request', id: 'ui-2', method: 'input', title: 'Your answer:' });
    stage = 'wait-ui2';
    return;
  }
  if (stage === 'wait-ui2' && rec.type === 'extension_ui_response' && rec.id === 'ui-2') {
    return finish(rec.cancelled ? 'cancelled after input' : 'answered');
  }
}

function finish(note) {
  send({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done (' + note + ')' }] },
  });
  send({ type: 'agent_settled', aborted: false });
  process.exit(0);
}
