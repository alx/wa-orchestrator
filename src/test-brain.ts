#!/usr/bin/env node
/**
 * test-brain.ts — standalone round-trip test of the sandboxed pi brains.
 *
 * Usage:
 *   node dist/test-brain.js [--profile <brain-key>] [ask text...]
 *   node dist/test-brain.js --profile <brain-key> --edit "change instruction..."
 */
import { runAsk, runRunMode } from './brain';
import { loadConfig, Config } from './config';

let profile = 'cpo';
let editMode = false;
const argv = process.argv.slice(2);
const args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--profile') {
    profile = argv[++i];
  } else if (a === '--edit') {
    editMode = true;
  } else {
    args.push(a);
  }
}
const CFG: Config = loadConfig();
const text = args.join(' ') || (CFG.brains[profile] ? (CFG.brains[profile].defaultAsk as string) : '');

// brain.js only reads group.brain
const group = { name: '(test-brain)', brain: profile };
const runner = editMode ? () => runRunMode(group, text) : () => runAsk(group, text);

runner()
  .then((r) => {
    console.log('=== REPLY ===');
    console.log(r.text);
    console.log(`=== OK in ${r.durationMs}ms ===`);
    process.exit(0);
  })
  .catch((e: Error) => {
    console.error('=== BRAIN TEST FAILED ===', e.message);
    process.exit(1);
  });
