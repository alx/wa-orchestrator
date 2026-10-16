'use strict';
/**
 * brain.test.js — unit tests for the compiled brain module (dist/brain.js).
 * Runs against a SYNTHETIC config (temp dir, no real paths/JIDs/names).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- synthetic deployment, built BEFORE requiring dist (top-level loadConfig) ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-test-'));
const templatePrompts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brain-prompts.template.json'), 'utf8'));
fs.writeFileSync(path.join(tmp, 'prompts.json'), JSON.stringify(templatePrompts));
const cfg = {
  groups: [
    { jid: '111@g.us', name: 'Group One', brain: 'demo' },
    { jid: '222@g.us', name: 'Group Two', brain: 'demo' },
  ],
  brains: {
    demo: {
      kind: 'cpo',
      botName: 'Demo Bot',
      beadsRepoDir: path.join(tmp, 'beads'),
      epics: ['org-aaaa', 'org-bbbb'],
      siteDir: path.join(tmp, 'site'),
      siteBuildCmd: 'hugo -v',
      siteLiveUrl: 'https://example.invalid',
      defaultAsk: 'What is open?',
      runCmd: 'edit',
      conversationDir: path.join(tmp, 'conversations', 'demo'),
    },
  },
  promptsFile: path.join(tmp, 'prompts.json'),
  provider: 'gd',
  modelLock: 'model-x',
  sessionsDir: path.join(tmp, 'sessions'),
  workDir: path.join(tmp, 'work'),
  sandboxImage: 'wa-orchestrator-sandbox',
  activityLog: path.join(tmp, 'activity.jsonl'),
  replyTimeoutMs: 60000,
  runTimeoutMs: 120000,
};
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
process.env.WO_CONFIG = path.join(tmp, 'config.json');

const brain = require('../dist/brain.js');
const { loadConfig } = require('../dist/config.js');

const DEMO = cfg.brains.demo;

test('loadConfig reads WO_CONFIG', () => {
  const c = loadConfig();
  assert.strictEqual(c.groups.length, 2);
  assert.strictEqual(c.brains.demo.kind, 'cpo');
});

test('loadConfig is cached (same object on repeat calls)', () => {
  assert.strictEqual(loadConfig(), loadConfig());
});

test('cpoListRecipe emits the exact scoped-list one-liner', () => {
  const expected =
    'bd list -s all --json --brief 2>/dev/null | node -e ' +
    '\'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const a=JSON.parse(d);' +
    'const E=["org-aaaa","org-bbbb"];const x=a.filter(b=>E.some(e=>b.id===e||b.id.startsWith(e+".")));' +
    'for(const b of x)console.log(b.id+" ["+b.status+"] P"+b.priority+" "+b.title)}catch(e){console.log("filter error:",e.message)}})\''.replace(/\n/g, '');
  assert.strictEqual(brain.cpoListRecipe(['org-aaaa', 'org-bbbb']), expected);
});

test('buildSitePrompt renders instruction/build-cmd/url, no placeholders left', () => {
  const p = brain.buildSitePrompt('make the hero bigger', DEMO);
  assert.ok(p.includes('make the hero bigger'));
  assert.ok(p.includes('hugo -v'));
  assert.ok(p.includes('https://example.invalid'));
  assert.ok(!p.includes('{{'), 'unrendered placeholder remains');
});

test('buildBeadsPrompt renders label/parentEpic/botName (first turn)', () => {
  const b2 = { kind: 'beads', botName: 'Beads Bot', beadsLabel: 'demo', beadsParentEpic: 'org-epic1' };
  const p = brain.buildBeadsPrompt('what is open?', b2, true);
  assert.ok(p.includes('demo'));
  assert.ok(p.includes('org-epic1'));
  assert.ok(p.includes('Beads Bot'));
  assert.ok(p.includes('what is open?'));
  assert.ok(!p.includes('{{'));
});

test('buildCpoPrompt renders epics + recipe, no placeholders left (first turn)', () => {
  const p = brain.buildCpoPrompt('status?', DEMO, true);
  assert.ok(p.includes('org-aaaa and org-bbbb'));
  assert.ok(p.includes(brain.cpoListRecipe(DEMO.epics)));
  assert.ok(p.includes('status?'));
  assert.ok(!p.includes('{{'));
});

test('buildCpoPrompt: first vs turn differ; turn is slim and carries the request', () => {
  const first = brain.buildCpoPrompt('status?', DEMO, true);
  const turn = brain.buildCpoPrompt('and the open ones?', DEMO, false);
  assert.notStrictEqual(first, turn);
  assert.ok(first.includes('org-aaaa and org-bbbb'), 'first turn keeps the environment description');
  assert.ok(turn.includes('and the open ones?'), 'turn prompt carries the request');
  assert.ok(!first.includes('{{') && !turn.includes('{{'));
  assert.ok(first.length > turn.length, 'turn template should be slimmer than first-turn');
});

test('legacy prompt file without .first/.turn keys falls back to the base key', () => {
  // Separate process: getPrompts() caches per-process.
  const { execFileSync } = require('child_process');
  const legacy = Object.assign({}, templatePrompts);
  delete legacy['cpo.ask.first'];
  delete legacy['cpo.ask.turn'];
  const f2 = path.join(tmp, 'prompts-legacy.json');
  fs.writeFileSync(f2, JSON.stringify(legacy));
  const cf2 = path.join(tmp, 'config-legacy.json');
  fs.writeFileSync(cf2, JSON.stringify(Object.assign({}, cfg, { promptsFile: f2 })));
  const script = [
    'process.env.WO_CONFIG=' + JSON.stringify(cf2) + ';',
    'const b=require(' + JSON.stringify(path.join(__dirname, '..', 'dist', 'brain.js')) + ');',
    'const c=require(' + JSON.stringify(cf2) + ');',
    'const P=c.brains.demo;',
    'const first=b.buildCpoPrompt("x?",P,true), turn=b.buildCpoPrompt("y?",P,false);',
    'console.log(JSON.stringify({hasEpics:first.includes("org-aaaa and org-bbbb"),turnHasAsk:turn.includes("y?")}));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.ok(r.hasEpics, 'fallback rendered the legacy cpo.ask template');
  assert.ok(r.turnHasAsk, 'fallback still renders the request');
});

test('groupSession: slug id + creates the per-group host dir', () => {
  const g = cfg.groups[0]; // 111@g.us → demo brain
  const s = brain.groupSession(g, DEMO);
  assert.strictEqual(s.id, '111-g.us');
  assert.strictEqual(s.hostDir, path.join(DEMO.conversationDir, '111-g.us'));
  assert.ok(fs.existsSync(s.hostDir) && fs.statSync(s.hostDir).isDirectory());
});

test('every published template key renders placeholder-free with full vars', () => {
  const vars = {
    botName: 'Demo Bot', label: 'demo', parentEpic: 'org-epic1', ask: 'a?',
    beadId: 'org-1234', beadSpec: 'spec text',
    epics: DEMO.epics.join(' and '), recipe: brain.cpoListRecipe(DEMO.epics),
    instruction: 'do X', siteBuildCmd: 'hugo -v', siteLiveUrl: 'https://example.invalid',
  };
  for (const key of ['beads.ask.first', 'beads.ask.turn', 'beads.ask', 'beads.run',
                     'cpo.ask.first', 'cpo.ask.turn', 'cpo.ask', 'cpo.edit']) {
    const out = String(templatePrompts[key]).replace(/\{\{(\w+)\}\}/g, (m, k) =>
      vars[k] !== undefined ? String(vars[k]) : ''
    );
    assert.ok(!out.includes('{{'), `${key} left an unrendered placeholder`);
  }
});
