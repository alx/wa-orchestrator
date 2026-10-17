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

// ---------------------------------------------------------------------------
// Extension-UI dialogs over the real runSandbox (org-lsv8.4): a fake `docker`
// on PATH execs a fixture pi that speaks the RPC protocol — get_state,
// prompt, extension_ui_request (select, then input), agent_settled — and
// logs every stdin record so we can assert the exact extension_ui_response
// records the brain wrote back.
// ---------------------------------------------------------------------------

function withFakePi(logFile, fn) {
  const prev = { PATH: process.env.PATH, FAKE_PI: process.env.FAKE_PI, FAKE_PI_LOG: process.env.FAKE_PI_LOG };
  const bin = path.join(tmp, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const dockerShim = path.join(bin, 'docker');
  fs.writeFileSync(dockerShim, '#!/bin/sh\nexec node "$FAKE_PI" "$@"\n');
  fs.chmodSync(dockerShim, 0o755);
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.FAKE_PI = path.join(__dirname, 'fixtures', 'fake-pi-dialog.js');
  process.env.FAKE_PI_LOG = logFile;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = prev.PATH;
      if (prev.FAKE_PI === undefined) delete process.env.FAKE_PI; else process.env.FAKE_PI = prev.FAKE_PI;
      if (prev.FAKE_PI_LOG === undefined) delete process.env.FAKE_PI_LOG; else process.env.FAKE_PI_LOG = prev.FAKE_PI_LOG;
    });
}

function stdinRecords(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('runSandbox: select→input dialog round-trips with exact response records', async () => {
  const logFile = path.join(tmp, 'dialog-answered.log');
  const hostDir = path.join(tmp, 'dlg-sess-1');
  fs.mkdirSync(hostDir, { recursive: true });
  await withFakePi(logFile, async () => {
    const res = await brain.runSandbox({
      prompt: 'please demo',
      workspace: tmp,
      timeoutMs: 30000,
      session: { id: 'dlg-1', hostDir },
      onUiRequest: (req) => {
        if (req.method === 'select') return { value: req.options[0] }; // member picks option 1
        if (req.method === 'input') return { value: 'the typed text' };
        return { cancelled: true };
      },
    });
    assert.match(res.text, /done \(answered\)/);
    const recs = stdinRecords(logFile);
    const ui1 = recs.find((r) => r.type === 'extension_ui_response' && r.id === 'ui-1');
    const ui2 = recs.find((r) => r.type === 'extension_ui_response' && r.id === 'ui-2');
    assert.strictEqual(ui1.value, '1. Tree: nested by account', 'select echoes the exact option line');
    assert.strictEqual(ui2.value, 'the typed text', 'input carries the raw reply text');
  });
});

test('runSandbox: cancelled select still resolves the run', async () => {
  const logFile = path.join(tmp, 'dialog-cancelled.log');
  const hostDir = path.join(tmp, 'dlg-sess-2');
  fs.mkdirSync(hostDir, { recursive: true });
  await withFakePi(logFile, async () => {
    const res = await brain.runSandbox({
      prompt: 'please demo',
      workspace: tmp,
      timeoutMs: 30000,
      session: { id: 'dlg-2', hostDir },
      onUiRequest: () => ({ cancelled: true }),
    });
    assert.match(res.text, /done \(cancelled after select\)/);
    const recs = stdinRecords(logFile);
    const ui1 = recs.find((r) => r.type === 'extension_ui_response' && r.id === 'ui-1');
    assert.strictEqual(ui1.cancelled, true);
  });
});

test('runSandbox: no onUiRequest handler → dialog cancelled, run resolves', async () => {
  const logFile = path.join(tmp, 'dialog-nocb.log');
  const hostDir = path.join(tmp, 'dlg-sess-3');
  fs.mkdirSync(hostDir, { recursive: true });
  await withFakePi(logFile, async () => {
    const res = await brain.runSandbox({
      prompt: 'please demo',
      workspace: tmp,
      timeoutMs: 30000,
      session: { id: 'dlg-3', hostDir },
    });
    assert.match(res.text, /done \(cancelled after select\)/);
    const recs = stdinRecords(logFile);
    assert.strictEqual(recs.find((r) => r.type === 'extension_ui_response' && r.id === 'ui-1').cancelled, true);
  });
});

// --- Multi-agent primitives (org-5mdy) ---

test('piPackages: provider + three brain extensions, in load order', () => {
  assert.deepEqual(brain.piPackages(), [
    '/opt/pi-provider-gd',
    '/opt/pi-ask-questions',
    '/opt/pi-subagents',
    '/opt/pi-herdr',
  ]);
});

test('herdrSocketArgs: live socket → mount + env; absent/unset → none', () => {
  const live = path.join(tmp, 'herdr-live.sock');
  fs.writeFileSync(live, '');
  assert.deepEqual(brain.herdrSocketArgs(live), [
    '-v', `${live}:/herdr/herdr.sock`,
    '-e', 'HERDR_SOCKET_PATH=/herdr/herdr.sock',
  ]);
  assert.deepEqual(brain.herdrSocketArgs(path.join(tmp, 'nope.sock')), []);
  assert.deepEqual(brain.herdrSocketArgs(undefined), []); // unset in synthetic config
});

test('herdrSocketArgs: spawn pane → HERDR_PANE_ID env for --current resolution', () => {
  const live = path.join(tmp, 'herdr-live.sock');
  fs.writeFileSync(live, '');
  assert.deepEqual(brain.herdrSocketArgs(live, 'w2:p1'), [
    '-v', `${live}:/herdr/herdr.sock`,
    '-e', 'HERDR_SOCKET_PATH=/herdr/herdr.sock',
    '-e', 'HERDR_PANE_ID=w2:p1',
  ]);
});

test('agentDirArgs: host-equal pi agent dir mount (org-5mdy.1)', () => {
  const d = '/home/alx/code/wa-orchestrator/sandbox/pi-config';
  // same host dir mounted onto ITSELF + PI_CODING_AGENT_DIR, so the session
  // path pi-herdr seeds under <agentDir>/sessions resolves on the host too
  assert.deepEqual(brain.agentDirArgs(d), [
    '-v', `${d}:${d}`,
    '-e', `PI_CODING_AGENT_DIR=${d}`,
  ]);
});

test('herdrPkgArgs: host pi-herdr install mounted host-equal (org-5mdy.1)', () => {
  // the child extension path <pkg>/src/child.ts must resolve on the HOST
  const d = '/home/alx/.local/share/wa-orchestrator/pi-herdr';
  assert.deepEqual(brain.herdrPkgArgs(d), ['-v', `${d}:${d}`]);
  assert.deepEqual(brain.herdrPkgArgs(undefined), []); // unset in synthetic config
});
