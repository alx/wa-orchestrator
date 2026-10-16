'use strict';
/**
 * session.test.js — unit tests for dist/session.js (org-1v4b).
 * Pure functions + tmp dirs; no docker, no network, no PII.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { groupSlug, sessionHostDir, sessionExists, resetSession } = require('../dist/session.js');

// --- groupSlug -------------------------------------------------------------

test('groupSlug: real-shape group JID', () => {
  assert.strictEqual(groupSlug('120363412696556300@g.us'), '120363412696556300-g.us');
});

test('groupSlug: lowercases, maps invalid chars to -, collapses runs, trims edges', () => {
  assert.strictEqual(groupSlug('A@@b.c/d e'), 'a-b.c-d-e');
  assert.strictEqual(groupSlug('.-..x..-'), 'x');
  assert.strictEqual(groupSlug('---'), '');
  assert.strictEqual(groupSlug(''), '');
});

test('groupSlug: idempotent on already-slugged input', () => {
  const once = groupSlug('120363412696556300@g.us');
  assert.strictEqual(groupSlug(once), once);
});

// --- sessionHostDir --------------------------------------------------------

test('sessionHostDir joins conversationDir + slug', () => {
  assert.strictEqual(sessionHostDir({ conversationDir: '/x/convo' }, 'abc'), '/x/convo/abc');
});

test('sessionHostDir throws a clear error without conversationDir', () => {
  assert.throws(() => sessionHostDir({}, 'abc'), /conversationDir/);
});

// --- sessionExists / resetSession (tmp dirs) --------------------------------

test('sessionExists: false for empty dir, true once a session .jsonl appears', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sess-'));
  const d = path.join(root, 'g1');
  fs.mkdirSync(d, { recursive: true });
  assert.strictEqual(sessionExists(d), false);
  fs.writeFileSync(path.join(d, '2026-10-16T00-00-00-000Z_g1.jsonl'), '{}\n');
  assert.strictEqual(sessionExists(d), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sessionExists: missing dir → false (first turn)', () => {
  assert.strictEqual(sessionExists(path.join(os.tmpdir(), 'wo-nope-12345', 'x')), false);
});

test('resetSession: renames dir aside; second call is a no-op', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sess-'));
  const d = path.join(root, 'g2');
  fs.mkdirSync(d, { recursive: true });
  assert.strictEqual(resetSession(d), true);
  assert.ok(!fs.existsSync(d), 'original dir gone after reset');
  assert.strictEqual(resetSession(d), false, 'no second reset without a new session');
  fs.rmSync(root, { recursive: true, force: true });
});
