'use strict';
/**
 * trigger.test.js — unit tests for pure trigger parsing (dist/trigger.js).
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseAsk, parseRun } = require('../dist/trigger.js');

test('parseAsk: bare "pi" → empty ask', () => {
  assert.strictEqual(parseAsk('pi'), '');
  assert.strictEqual(parseAsk('  pi  '), '');
});

test('parseAsk: "pi …" → the rest, trimmed', () => {
  assert.strictEqual(parseAsk('pi hello world'), 'hello world');
  assert.strictEqual(parseAsk('pi   spaced out   '), 'spaced out');
});

test('parseAsk: case-insensitive', () => {
  assert.strictEqual(parseAsk('PI x'), 'x');
  assert.strictEqual(parseAsk('Pi'), '');
});

test('parseAsk: multi-line ask preserved', () => {
  assert.strictEqual(parseAsk('pi\nline1\nline2'), 'line1\nline2');
});

test('parseAsk: non-triggers → null', () => {
  assert.strictEqual(parseAsk(''), null);
  assert.strictEqual(parseAsk('   '), null);
  assert.strictEqual(parseAsk('pipi'), null);
  assert.strictEqual(parseAsk('hello'), null);
  assert.strictEqual(parseAsk('pi'), ''); // control: IS a trigger
});

test('parseRun: "<runCmd> <rest>" → rest', () => {
  assert.strictEqual(parseRun('edit change the hero', 'edit'), 'change the hero');
  assert.strictEqual(parseRun('run org-abcd', 'run'), 'org-abcd');
});

test('parseRun: case-insensitive runCmd', () => {
  assert.strictEqual(parseRun('EDIT stuff', 'edit'), 'stuff');
});

test('parseRun: non-run asks → null', () => {
  assert.strictEqual(parseRun('list the beads', 'edit'), null);
  assert.strictEqual(parseRun('edit', 'edit'), null); // no argument
  assert.strictEqual(parseRun('editorial note', 'edit'), null); // "editorial" ≠ the runCmd word (no word boundary) — wait: ^edit\s+ requires whitespace right after "edit"; "editorial" has "o" → null
});
