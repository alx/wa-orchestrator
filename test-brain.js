#!/usr/bin/env node
/**
 * test-brain.js — standalone round-trip test of the sandboxed pi brains.
 *
 * Usage:
 *   node test-brain.js [--profile cpo|ai-slop] [ask text...]
 *   node test-brain.js --profile cpo --edit "change instruction..."
 */
'use strict';
const { runAsk, runRunMode } = require('./brain');
const CFG = require('./config.json');

let profile = 'cpo';
let editMode = false;
const argv = process.argv.slice(2);
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--profile') { profile = argv[++i]; }
  else if (argv[i] === '--edit') { editMode = true; }
  else args.push(argv[i]);
}
const text = args.join(' ') || (CFG.brains[profile] ? CFG.brains[profile].defaultAsk : '');

const group = { brain: profile }; // brain.js only reads group.brain
const runner = editMode ? () => runRunMode(group, text) : () => runAsk(group, text);

runner()
  .then((r) => {
    console.log('=== REPLY ===');
    console.log(r.text);
    console.log(`=== OK in ${r.durationMs}ms ===`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('=== BRAIN TEST FAILED ===', e.message);
    process.exit(1);
  });
