'use strict';

// Collector hook→envelope path for Antigravity: maps agy's hook stdin
// (conversationId/transcriptPath/workspacePaths) into a validated
// google/antigravity envelope and injects usage_raw from the token store.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolate config side effects (device_uuid) before requiring the collector.
process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-coll-cfg-'));

const collector = require('../src/collector.cjs');
const { buildSyntheticDb, writeBrainTranscript } = require('./fixtures/agy/build_db.cjs');
const { startIngest, listen, close, runAgyCollector } = require('./fixtures/agy/harness.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'agy', 'transcript_full.jsonl');

let nodeSqlite = false;
try {
  const { getDatabaseClass } = require('../src/parser/antigravity_tokens.cjs');
  if (getDatabaseClass()) {
    nodeSqlite = true;
  }
} catch {
  nodeSqlite = false;
}

test('buildAntigravityEnvelopeFromHook tags google/antigravity + maps hook fields', () => {
  const hook = {
    conversationId: 'conv-xyz',
    transcriptPath: FIXTURE,
    workspacePaths: ['/work/repo'],
    stepIdx: 7,
    toolCall: null,
    error: '',
  };
  const env = collector.buildAntigravityEnvelopeFromHook(hook, {
    trigger: 'posttooluse',
    source: 'cli',
  });
  assert.strictEqual(env.provider, 'google');
  assert.strictEqual(env.tool, 'antigravity');
  assert.strictEqual(env._trigger, 'posttooluse');
  assert.strictEqual(env.payload.sessionId, 'conv-xyz');
  assert.strictEqual(env.payload.repo, '/work/repo');
  assert.deepStrictEqual(env.payload.commitSHA, ['a1b2c3d']);
});

test('missing transcriptPath throws (caller swallows on the hot path)', () => {
  assert.throws(() =>
    collector.buildAntigravityEnvelopeFromHook(
      { conversationId: 'x' },
      { trigger: 'posttooluse', source: 'cli' }
    )
  );
});

test('usage_raw is injected from the token store when the DB exists', { skip: !nodeSqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-coll-'));
  const prev = process.env.AGY_CONVERSATIONS_DIR;
  process.env.AGY_CONVERSATIONS_DIR = dir;
  try {
    buildSyntheticDb(dir, 'conv-coll', { input: 4321, output: 21 });
    const env = collector.buildAntigravityEnvelopeFromHook(
      { conversationId: 'conv-coll', transcriptPath: FIXTURE, workspacePaths: ['/r'] },
      { trigger: 'posttooluse', source: 'cli' }
    );
    assert.ok(env.payload.antigravity.usage_raw, 'usage_raw injected');
    assert.strictEqual(env.payload.antigravity.usage_raw['1.4.2'], 4321);
  } finally {
    if (prev === undefined) delete process.env.AGY_CONVERSATIONS_DIR;
    else process.env.AGY_CONVERSATIONS_DIR = prev;
  }
});

test('usage_raw is null (not fatal) when the DB is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-coll-none-'));
  const prev = process.env.AGY_CONVERSATIONS_DIR;
  process.env.AGY_CONVERSATIONS_DIR = dir;
  try {
    const env = collector.buildAntigravityEnvelopeFromHook(
      { conversationId: 'no-db', transcriptPath: FIXTURE, workspacePaths: ['/r'] },
      { trigger: 'posttooluse', source: 'cli' }
    );
    assert.strictEqual(env.payload.antigravity.usage_raw, null);
  } finally {
    if (prev === undefined) delete process.env.AGY_CONVERSATIONS_DIR;
    else process.env.AGY_CONVERSATIONS_DIR = prev;
  }
});

// --- Stop event ---------------------------------------------------------------
//
// agy's Stop fires when the execution loop terminates and pipes the common
// camelCase fields on stdin — INCLUDING `lastUserInput`, which is PROMPT TEXT —
// plus Stop extras. The collector must capture the final snapshot under the
// `stop` trigger, never read/log/forward lastUserInput, and keep stdout empty
// (a stdout {"decision":"continue"} would block the agent from stopping).

const PROMPT_SENTINEL = 'AGY_LAST_USER_INPUT_PROMPT_SENTINEL_7f3c';
const SP_PARENT = 'cccccccc-0000-4000-8000-000000000001';
const SP_CHILD = 'cccccccc-0000-4000-8000-000000000002';

function stopHook(conversationId, transcriptPath, extra = {}) {
  return {
    conversationId,
    transcriptPath,
    workspacePaths: ['/synthetic/repo'],
    artifactDirectoryPath: '/synthetic/artifacts',
    modelName: 'gemini-3-flash-a',
    hookEventName: 'Stop',
    cwd: '/synthetic/repo',
    lastUserInput: `${PROMPT_SENTINEL} please refactor the secret module`,
    executionNum: 1,
    terminationReason: 'NO_TOOL_CALL',
    error: '',
    fullyIdle: true,
    continuationActive: false,
    ...extra,
  };
}

// One synthetic store (AGY_STORE_ROOTS) with a parent + one subagent child, each
// with its canonical brain transcript. Returns { parentHook, childHook }.
function withStopStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stop-store-'));
  const keys = ['AGY_STORE_ROOTS', 'AGY_CONVERSATIONS_DIR', 'AGY_BRAIN_DIR'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  delete process.env.AGY_CONVERSATIONS_DIR;
  delete process.env.AGY_BRAIN_DIR;
  process.env.AGY_STORE_ROOTS = root;
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const conv = path.join(root, 'conversations');
  const brain = path.join(root, 'brain');
  buildSyntheticDb(conv, SP_PARENT, { input: 700, output: 70, cacheRead: 7000 });
  buildSyntheticDb(conv, SP_CHILD, { input: 30, output: 3, parentId: SP_PARENT });
  const parentHook = stopHook(SP_PARENT, writeBrainTranscript(brain, SP_PARENT, text));
  const childHook = stopHook(SP_CHILD, writeBrainTranscript(brain, SP_CHILD, text));
  return Promise.resolve()
    .then(() => fn({ parentHook, childHook }))
    .finally(() => {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
}

test('Stop resolves to the stop trigger by explicit arg AND by hookEventName; not mistaken for Grok', () => {
  const hook = stopHook('conv-stop', FIXTURE);
  assert.strictEqual(collector.triggerFor(hook.hookEventName, undefined), 'stop');
  assert.strictEqual(collector.triggerFor(undefined, 'stop'), 'stop');
  assert.strictEqual(collector.looksLikeGrokStdin(hook), false);
});

test('Stop envelope never contains lastUserInput (builder)', { skip: !nodeSqlite }, async () => {
  await withStopStore(({ parentHook }) => {
    const env = collector.buildAntigravityEnvelopeFromHook(parentHook, { trigger: 'stop', source: 'cli' });
    assert.strictEqual(env._trigger, 'stop');
    // Positive controls: the final snapshot carries the session's tokens + subagent.
    assert.strictEqual(env.payload.antigravity.usage_raw['1.4.5'], 7000);
    assert.strictEqual(env.payload.antigravity.subagents.length, 1);
    assert.ok(!JSON.stringify(env).includes(PROMPT_SENTINEL), 'LEAK: lastUserInput in envelope');
  });
});

test('Stop hook process: posts a stop snapshot, stdout stays empty, prompt never posted or logged', { skip: !nodeSqlite }, async () => {
  await withStopStore(async ({ parentHook }) => {
    const { srv, captured } = startIngest();
    const port = await listen(srv);
    try {
      // As installed: explicit `stop` trigger arg.
      const explicit = await runAgyCollector(parentHook, port, ['stop']);
      // Event-name path: no trigger arg, resolved from hookEventName "Stop".
      const byEvent = await runAgyCollector(parentHook, port, []);
      for (const r of [explicit, byEvent]) {
        assert.strictEqual(r.code, 0, r.stderr);
        assert.strictEqual(r.stdout, '', 'nothing on stdout (would be read as a Stop decision)');
        assert.ok(!r.stderr.includes(PROMPT_SENTINEL), 'LEAK: lastUserInput logged');
      }
      assert.strictEqual(captured.length, 2);
      for (const c of captured) {
        assert.strictEqual(c.json._trigger, 'stop');
        assert.strictEqual(c.json.payload.sessionId, SP_PARENT);
        assert.ok(!c.raw.includes(PROMPT_SENTINEL), 'LEAK: lastUserInput posted');
      }
    } finally {
      await close(srv);
    }
  });
});

test('Stop for a subagent child is suppressed (no POST, empty stdout)', { skip: !nodeSqlite }, async () => {
  await withStopStore(async ({ childHook }) => {
    const { srv, captured } = startIngest();
    const port = await listen(srv);
    try {
      const r = await runAgyCollector(childHook, port, ['stop']);
      assert.strictEqual(r.code, 0);
      assert.match(r.stderr, /suppressing subagent child/);
      assert.strictEqual(r.stdout, '');
      assert.strictEqual(captured.length, 0);
    } finally {
      await close(srv);
    }
  });
});

test('malformed hook stdin never echoes its content (JSON errors quote input)', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  try {
    // Unquoted value: V8's JSON.parse error message would quote this fragment.
    const r = await runAgyCollector(`{"lastUserInput":${PROMPT_SENTINEL}}`, port, ['stop']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stdout, '');
    assert.match(r.stderr, /could not parse hook JSON/);
    assert.ok(!r.stderr.includes(PROMPT_SENTINEL.slice(0, 8)), 'LEAK: stdin fragment logged');
    assert.strictEqual(captured.length, 0);
  } finally {
    await close(srv);
  }
});
