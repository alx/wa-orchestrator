'use strict';
/**
 * dialog.test.js — unit tests for src/dialog.ts (compiled dist/dialog.js):
 * the reply→response mapping between WhatsApp text and pi extension-UI
 * dialog records (org-lsv8.4).
 */
const test = require('node:test');
const assert = require('node:assert');

const { mapSelectReply, formatQuestion } = require('../dist/dialog.js');

const OPTIONS = [
  '1. Tree: nested by account',
  '2. Flat list: one row per item',
  '3. Type something.:',
];

test('mapSelectReply: valid number picks that exact option line', () => {
  assert.deepStrictEqual(mapSelectReply(OPTIONS, '2'), { value: OPTIONS[1] });
  assert.deepStrictEqual(mapSelectReply(OPTIONS, ' 1 '), { value: OPTIONS[0] });
  assert.deepStrictEqual(mapSelectReply(OPTIONS, '3'), { value: OPTIONS[2] });
});

test('mapSelectReply: number out of range → hint', () => {
  for (const r of ['0', '4', '99']) {
    const m = mapSelectReply(OPTIONS, r);
    assert.strictEqual(m.value, undefined);
    assert.ok(m.hint.includes('between 1 and 3'), `hint for "${r}"`);
  }
});

test('mapSelectReply: non-numeric text is free text (auto-typed), not a number', () => {
  const m = mapSelectReply(OPTIONS, '-1');
  assert.strictEqual(m.value, OPTIONS[2]);
  assert.strictEqual(m.autoType, '-1');
});

test('mapSelectReply: free text → "Type something." line + autoType', () => {
  const m = mapSelectReply(OPTIONS, 'a kanban board');
  assert.strictEqual(m.value, OPTIONS[2]);
  assert.strictEqual(m.autoType, 'a kanban board');
  assert.strictEqual(m.hint, undefined);
});

test('mapSelectReply: free text with no typed row → hint', () => {
  const m = mapSelectReply(['1. A: x', '2. B: y'], 'something else');
  assert.strictEqual(m.value, undefined);
  assert.ok(m.hint);
});

test('mapSelectReply: empty reply → hint', () => {
  const m = mapSelectReply(OPTIONS, '   ');
  assert.strictEqual(m.value, undefined);
  assert.ok(m.hint);
});

test('formatQuestion: select shows title + numbered options + instruction', () => {
  const q = formatQuestion({
    method: 'select', title: 'Which layout?', options: OPTIONS,
  });
  assert.ok(q.startsWith('Which layout?'));
  for (const o of OPTIONS) assert.ok(q.includes(o));
  assert.ok(q.includes('Reply with the number of your choice.'));
});

test('formatQuestion: input shows title + answer instruction', () => {
  const q = formatQuestion({ method: 'input', title: 'Your answer:' });
  assert.ok(q.startsWith('Your answer:'));
  assert.ok(q.includes('Reply with your answer.'));
  assert.ok(!q.includes('number'));
});
