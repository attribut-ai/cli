'use strict';

// Antigravity multi-store capture. The desktop app, the `agy` terminal CLI and
// the legacy IDE each keep a store with the SAME layout under a different root
// (<root>/conversations/<id>.db, <root>/brain/<id>/.system_generated/logs/
// transcript_full.jsonl, <root>/conversation_summaries.db). These tests stage
// SYNTHETIC stores under a temp dir (AGY_STORE_ROOTS) and cover: store resolution
// from the hook's transcriptPath + fallback across roots, the store-index title /
// label / workspace fallbacks (and that the index's content columns never leak),
// subagent cache-read tokens, child suppression in a non-default store, and
// multi-store enumeration with id de-dup for backfill.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

// Isolate config side effects (device_uuid, hook state) before requiring the collector.
process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stores-cfg-'));

const tokens = require('../src/parser/antigravity_tokens.cjs');
const agy = require('../src/parser/antigravity_cli.cjs');
const collector = require('../src/collector.cjs');
const backfill = require('../src/backfill.cjs');
const { validateEnvelope } = require('../src/envelope.cjs');
const { buildSyntheticDb, buildSummariesDb, writeBrainTranscript } = require('./fixtures/agy/build_db.cjs');

const COLLECTOR = path.join(__dirname, '..', 'src', 'collector.cjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'agy', 'transcript_full.jsonl');
const FIXTURE_TEXT = fs.readFileSync(FIXTURE, 'utf8'); // has a run_command Cwd of /tmp/agy_fix

let nodeSqlite = false;
try {
  if (tokens.getDatabaseClass()) nodeSqlite = true;
} catch {
  nodeSqlite = false;
}

// Synthetic, UUID-shaped ids (readParentId only accepts a UUID parent link).
const PARENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const KID_1 = 'aaaaaaaa-0000-4000-8000-000000000002';
const KID_2 = 'aaaaaaaa-0000-4000-8000-000000000003';
const KID_3 = 'aaaaaaaa-0000-4000-8000-000000000006';
const SOLO = 'aaaaaaaa-0000-4000-8000-000000000004';
const DUP = 'aaaaaaaa-0000-4000-8000-000000000005';

const STORE_ENV = ['AGY_STORE_ROOTS', 'AGY_CONVERSATIONS_DIR', 'AGY_BRAIN_DIR'];

// Stage `n` store roots under a temp dir and point AGY_STORE_ROOTS at them
// (clearing the single-store pins) for the duration of fn(roots).
async function withStores(n, fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stores-'));
  const roots = Array.from({ length: n }, (_, i) => path.join(base, `store-${i}`));
  const prev = Object.fromEntries(STORE_ENV.map((k) => [k, process.env[k]]));
  delete process.env.AGY_CONVERSATIONS_DIR;
  delete process.env.AGY_BRAIN_DIR;
  process.env.AGY_STORE_ROOTS = roots.join(path.delimiter);
  try {
    return await fn(roots);
  } finally {
    for (const k of STORE_ENV) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const conv = (root) => path.join(root, 'conversations');
const brain = (root) => path.join(root, 'brain');

// A live-hook-shaped object whose transcriptPath is the canonical brain path in `root`.
function hookFor(root, id, transcriptText = FIXTURE_TEXT) {
  return {
    conversationId: id,
    transcriptPath: writeBrainTranscript(brain(root), id, transcriptText),
    workspacePaths: ['/synthetic/repo'],
  };
}

function build(hook) {
  return collector.buildAntigravityEnvelopeFromHook(hook, { trigger: 'posttooluse', source: 'cli' });
}

// --- local ingest + collector process harness --------------------------------

function startIngest() {
  const captured = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      captured.push({ url: req.url, json: JSON.parse(body.toString('utf8')) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return { srv, captured };
}

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

function close(srv) {
  return new Promise((resolve) => srv.close(resolve));
}

// Run the real hook entrypoint (NOT --dry-run) asynchronously, so the in-process
// ingest server can observe any POST it makes.
function runCollector(hook, port) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stores-run-'));
  fs.writeFileSync(path.join(cfg, 'token'), 'tok-agy-test\n', { mode: 0o600 });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COLLECTOR, '--provider', 'antigravity', 'posttooluse'], {
      env: {
        ...process.env,
        ATTRIBUT_CONFIG_DIR: cfg,
        ATTRIBUT_ALLOW_INSECURE: '1',
        INGEST_BASE: `http://127.0.0.1:${port}`,
      },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.resume();
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(hook));
  });
}

// --- store resolution --------------------------------------------------------

test('default store roots: desktop app, terminal CLI, legacy IDE — never the backup copy', () => {
  const prev = Object.fromEntries(STORE_ENV.map((k) => [k, process.env[k]]));
  for (const k of STORE_ENV) delete process.env[k];
  try {
    const names = tokens.knownStores().map((s) => path.basename(s.root));
    assert.deepStrictEqual(names, ['antigravity', 'antigravity-cli', 'antigravity-ide']);
    assert.ok(!names.includes('antigravity-backup'));
  } finally {
    for (const k of STORE_ENV) if (prev[k] !== undefined) process.env[k] = prev[k];
  }
});

test('AGY_CONVERSATIONS_DIR still pins one store; transcript shape is then ignored', async () => {
  await withStores(2, (roots) => {
    process.env.AGY_CONVERSATIONS_DIR = conv(roots[0]); // restored by withStores
    const stores = tokens.knownStores();
    assert.strictEqual(stores.length, 1);
    assert.strictEqual(stores[0].conversationsDir, conv(roots[0]));
    const tp = path.join(brain(roots[1]), SOLO, '.system_generated', 'logs', 'transcript_full.jsonl');
    assert.strictEqual(tokens.storeFromTranscriptPath(tp, SOLO), null);
  });
});

test('the hook transcriptPath names the authoritative store', { skip: !nodeSqlite }, async () => {
  await withStores(2, (roots) => {
    // The same id in two stores, with different usage.
    buildSyntheticDb(conv(roots[0]), DUP, { input: 111, output: 1 });
    buildSyntheticDb(conv(roots[1]), DUP, { input: 222, output: 2 });
    const hook = hookFor(roots[1], DUP);
    const store = tokens.resolveStore(DUP, hook.transcriptPath);
    assert.strictEqual(store.root, roots[1]);
    assert.strictEqual(store.conversationsDir, conv(roots[1]));
    assert.strictEqual(build(hook).payload.antigravity.usage_raw['1.4.2'], 222);

    // A path without the store shape → the first known store holding the DB.
    assert.strictEqual(tokens.resolveStore(DUP, FIXTURE).root, roots[0]);
    const env = build({ ...hook, transcriptPath: FIXTURE });
    assert.strictEqual(env.payload.antigravity.usage_raw['1.4.2'], 111);
  });
});

test('falls back across store roots; a transcript of another conversation is not trusted', { skip: !nodeSqlite }, async () => {
  await withStores(3, (roots) => {
    buildSyntheticDb(conv(roots[2]), SOLO, { input: 333, output: 3, model: 'gemini-3-flash-a' });
    const env = build({ conversationId: SOLO, transcriptPath: FIXTURE, workspacePaths: ['/synthetic/repo'] });
    assert.strictEqual(env.payload.antigravity.usage_raw['1.4.2'], 333);
    assert.strictEqual(env.payload.model, 'gemini-3-flash-a');
    // brainTranscriptPath resolves inside the conversation's own store.
    assert.strictEqual(
      agy.brainTranscriptPath(SOLO),
      path.join(brain(roots[2]), SOLO, '.system_generated', 'logs', 'transcript_full.jsonl')
    );
    const other = writeBrainTranscript(brain(roots[0]), DUP, FIXTURE_TEXT);
    assert.strictEqual(tokens.storeFromTranscriptPath(other, SOLO), null);
    assert.strictEqual(tokens.resolveStore(SOLO, other).root, roots[2]);
    // Unknown everywhere → null store, and every reader degrades to null/[].
    const ghost = 'aaaaaaaa-0000-4000-8000-0000000000ff';
    assert.strictEqual(tokens.resolveStore(ghost, FIXTURE), null);
    assert.deepStrictEqual(tokens.findChildren(ghost), []);
  });
});

// --- store index (conversation_summaries.db) ----------------------------------

const INDEX_SENTINELS = ['PREVIEW_CONTENT_SENTINEL', 'RAW_SUMMARY_SENTINEL', 'FTS_CONTENT_SENTINEL'];

test('desktop store: title comes from the store index; its content columns never leak', { skip: !nodeSqlite }, async () => {
  await withStores(1, (roots) => {
    // No step title in the DB (the desktop app does not write path 30.4).
    buildSyntheticDb(conv(roots[0]), SOLO, { input: 10, output: 1 });
    buildSummariesDb(roots[0], [
      {
        conversation_id: SOLO,
        title: 'Synthetic Desktop Title',
        preview: 'PREVIEW_CONTENT_SENTINEL the user prompt text',
        raw_summary: 'RAW_SUMMARY_SENTINEL serialized summary',
        fts: 'FTS_CONTENT_SENTINEL indexed response text',
        workspace_uris: ['file:///synthetic/index-workspace'],
      },
    ]);
    const env = build(hookFor(roots[0], SOLO));
    assert.strictEqual(env.payload.title, 'Synthetic Desktop Title');
    // The hook's own workspacePaths stay ahead of the index's workspace.
    assert.strictEqual(env.payload.repo, '/synthetic/repo');
    const serialized = JSON.stringify(env);
    for (const s of INDEX_SENTINELS) assert.ok(!serialized.includes(s), `LEAK: ${s} in envelope`);
    const { valid, errors } = validateEnvelope(env);
    assert.ok(valid, JSON.stringify(errors));
  });
});

test('a step title (path 30.4) wins over the index; index titles are shape-guarded + capped', { skip: !nodeSqlite }, async () => {
  await withStores(1, (roots) => {
    const LONG = 'aaaaaaaa-0000-4000-8000-000000000007';
    buildSyntheticDb(conv(roots[0]), SOLO, { input: 1, output: 1, title: 'Step Path Title' });
    buildSyntheticDb(conv(roots[0]), DUP, { input: 1, output: 1 });
    buildSyntheticDb(conv(roots[0]), LONG, { input: 1, output: 1 });
    buildSummariesDb(roots[0], [
      { conversation_id: SOLO, title: 'Index Title' },
      { conversation_id: DUP, title: 'line one\nline two' },
      { conversation_id: LONG, title: 'T'.repeat(300) },
    ]);
    assert.strictEqual(tokens.readTitle(SOLO), 'Step Path Title');
    assert.strictEqual(tokens.readTitle(DUP), null); // multi-line → rejected
    assert.strictEqual(tokens.readTitle(LONG), 'T'.repeat(200));
  });
});

test('store-index reads are fail-safe: older schema, corrupt file, malformed value, unknown id', { skip: !nodeSqlite }, async () => {
  await withStores(2, (roots) => {
    buildSyntheticDb(conv(roots[0]), SOLO, { input: 1, output: 1 });
    buildSummariesDb(roots[0], [{ conversation_id: SOLO, title: 'Legacy Schema Title' }], { legacy: true });
    assert.strictEqual(tokens.readSummaryTitle(SOLO), 'Legacy Schema Title');
    assert.strictEqual(tokens.readSummaryAgentName(SOLO), null); // column absent
    assert.strictEqual(tokens.readSummaryWorkspacePath(SOLO), null); // column absent

    buildSyntheticDb(conv(roots[1]), DUP, { input: 1, output: 1 });
    fs.writeFileSync(path.join(roots[1], 'conversation_summaries.db'), 'not a sqlite file');
    assert.strictEqual(tokens.readSummaryTitle(DUP), null);

    buildSummariesDb(roots[1], [{ conversation_id: DUP, workspace_uris: 'not json [' }]);
    assert.strictEqual(tokens.readSummaryWorkspacePath(DUP), null);

    assert.strictEqual(tokens.readSummaryTitle('aaaaaaaa-0000-4000-8000-0000000000ff'), null);
    // Only these named columns are ever selected from the index.
    assert.deepStrictEqual([...tokens.SUMMARY_SAFE_COLUMNS].sort(), ['agent_name', 'title', 'workspace_uris']);
  });
});

// --- subagents ---------------------------------------------------------------

test('subagents in a non-default store: cache_read_tokens + index agent_name fallback', { skip: !nodeSqlite }, async () => {
  await withStores(2, (roots) => {
    const r = roots[1];
    buildSyntheticDb(conv(r), PARENT, { input: 100, output: 10, cacheRead: 5000 });
    buildSyntheticDb(conv(r), KID_1, {
      parentId: PARENT,
      rows: [
        { input: 40, output: 4, cacheRead: 1000 },
        { input: 60, output: 6, cacheRead: 1040 },
      ],
    });
    buildSyntheticDb(conv(r), KID_2, { parentId: PARENT, input: 7, output: 1 });
    buildSyntheticDb(conv(r), KID_3, { parentId: PARENT, input: 9, output: 1, agentType: 'declared-type' });
    // A child of the same parent id in ANOTHER store is not nested.
    buildSyntheticDb(conv(roots[0]), SOLO, { parentId: PARENT, input: 999, output: 9 });
    buildSummariesDb(r, [
      { conversation_id: PARENT, title: 'Synthetic Parent' },
      { conversation_id: KID_1, agent_name: 'synthetic-reviewer', parent_conversation_id: PARENT, preview: 'PREVIEW_CONTENT_SENTINEL' },
      { conversation_id: KID_2, agent_name: 'self', parent_conversation_id: PARENT },
      { conversation_id: KID_3, agent_name: 'index-label', parent_conversation_id: PARENT },
    ]);
    for (const k of [KID_1, KID_2, KID_3]) writeBrainTranscript(brain(r), k, FIXTURE_TEXT);
    // The parent declares one subagent type; that declared match beats the index label.
    const parentText =
      FIXTURE_TEXT.trimEnd() +
      '\n' +
      JSON.stringify({ tool_calls: [{ name: 'invoke_subagent', args: { Subagents: [{ TypeName: 'declared-type', Role: 'Declared Role' }] } }] }) +
      '\n';
    const env = build(hookFor(r, PARENT, parentText));

    // The parent's own usage_raw ships raw, cache-read path included.
    assert.strictEqual(env.payload.antigravity.usage_raw['1.4.5'], 5000);
    const subs = env.payload.antigravity.subagents;
    assert.strictEqual(subs.length, 3);
    const byInput = Object.fromEntries(subs.map((s) => [s.input_tokens, s]));
    const k1 = byInput[100];
    assert.strictEqual(k1.agent_type, 'synthetic-reviewer'); // index agent_name fallback
    assert.strictEqual(k1.output_tokens, 10);
    assert.strictEqual(k1.cache_read_tokens, 2040); // Σ 1.4.5
    assert.ok(k1.tool_use_count > 0, 'child transcript read from the same store');
    const k2 = byInput[7];
    assert.strictEqual(k2.agent_type, null); // `self` is not a type
    assert.strictEqual(k2.cache_read_tokens, 0);
    const k3 = byInput[9];
    assert.strictEqual(k3.agent_type, 'declared-type');
    assert.strictEqual(k3.role, 'Declared Role');
    assert.ok(!JSON.stringify(env).includes('PREVIEW_CONTENT_SENTINEL'));
    const { valid, errors } = validateEnvelope(env);
    assert.ok(valid, JSON.stringify(errors));
  });
});

test('findChildren is not capped at the old 64', { skip: !nodeSqlite }, async () => {
  await withStores(1, (roots) => {
    buildSyntheticDb(conv(roots[0]), PARENT, { input: 1, output: 1 });
    const kids = [];
    for (let i = 0; i < 70; i++) {
      const id = `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`;
      buildSyntheticDb(conv(roots[0]), id, { input: 1, output: 1, parentId: PARENT });
      kids.push(id);
    }
    assert.strictEqual(tokens.MAX_CHILDREN, 256);
    assert.deepStrictEqual(tokens.findChildren(PARENT).sort(), kids.sort());
  });
});

// --- child suppression -------------------------------------------------------

test('a child hook in a non-default store is suppressed (never posts); its parent posts', { skip: !nodeSqlite }, async () => {
  await withStores(2, async (roots) => {
    const r = roots[1];
    buildSyntheticDb(conv(r), PARENT, { input: 100, output: 10 });
    buildSyntheticDb(conv(r), KID_1, { parentId: PARENT, input: 5, output: 1, cacheRead: 50 });
    const childHook = hookFor(r, KID_1);
    const parentHook = hookFor(r, PARENT);

    // Resolver: the child's own store, where its parent link lives.
    const st = tokens.resolveStore(KID_1, childHook.transcriptPath);
    assert.strictEqual(st.root, r);
    assert.strictEqual(tokens.readParentId(KID_1, st), PARENT);

    const { srv, captured } = startIngest();
    const port = await listen(srv);
    try {
      const child = await runCollector(childHook, port);
      assert.strictEqual(child.code, 0);
      assert.match(child.stderr, /suppressing subagent child/);
      assert.strictEqual(captured.length, 0, 'a subagent child must not post');

      const parent = await runCollector(parentHook, port);
      assert.strictEqual(parent.code, 0, parent.stderr);
      assert.strictEqual(captured.length, 1, 'positive control: the parent posts');
      const subs = captured[0].json.payload.antigravity.subagents;
      assert.strictEqual(subs.length, 1);
      assert.strictEqual(subs[0].cache_read_tokens, 50);
    } finally {
      await close(srv);
    }
  });
});

// --- enumeration + backfill --------------------------------------------------

test('listConversationIds spans every store, drops children, de-dups ids by newest DB', { skip: !nodeSqlite }, async () => {
  await withStores(3, (roots) => {
    // roots[2] never gets a conversations dir — a missing store is skipped.
    buildSyntheticDb(conv(roots[0]), DUP, { input: 1, output: 1 });
    buildSyntheticDb(conv(roots[1]), DUP, { input: 2, output: 2 });
    buildSyntheticDb(conv(roots[0]), SOLO, { input: 1, output: 1 });
    buildSyntheticDb(conv(roots[1]), PARENT, { input: 1, output: 1 });
    buildSyntheticDb(conv(roots[1]), KID_1, { input: 1, output: 1, parentId: PARENT });
    // A copy of the child that lacks the parent link elsewhere is still a child.
    buildSyntheticDb(conv(roots[0]), KID_1, { input: 1, output: 1 });
    const at = (iso) => new Date(iso);
    fs.utimesSync(path.join(conv(roots[0]), `${DUP}.db`), at('2026-01-01T00:00:00Z'), at('2026-01-01T00:00:00Z'));
    fs.utimesSync(path.join(conv(roots[1]), `${DUP}.db`), at('2026-02-01T00:00:00Z'), at('2026-02-01T00:00:00Z'));

    let list = tokens.listConversationIds();
    assert.deepStrictEqual(list.map((d) => d.id).sort(), [DUP, PARENT, SOLO].sort());
    assert.strictEqual(list.find((d) => d.id === DUP).store.root, roots[1]);
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].mtimeMs >= list[i].mtimeMs, 'newest-first');

    fs.utimesSync(path.join(conv(roots[0]), `${DUP}.db`), at('2026-03-01T00:00:00Z'), at('2026-03-01T00:00:00Z'));
    list = tokens.listConversationIds();
    assert.strictEqual(list.find((d) => d.id === DUP).store.root, roots[0]);
  });
});

test('backfill: transcripts resolve per store; repo from the index workspace_uris ahead of Cwd', { skip: !nodeSqlite }, async () => {
  await withStores(2, async (roots) => {
    buildSyntheticDb(conv(roots[1]), SOLO, { input: 1, output: 1 });
    buildSyntheticDb(conv(roots[0]), DUP, { input: 1, output: 1 });
    writeBrainTranscript(brain(roots[1]), SOLO, FIXTURE_TEXT);
    writeBrainTranscript(brain(roots[0]), DUP, FIXTURE_TEXT);
    buildSummariesDb(roots[1], [
      {
        conversation_id: SOLO,
        workspace_uris: ['https://example.invalid/not-a-folder', 'file:///synthetic/work/space%20dir', 'file:///synthetic/second'],
      },
    ]);

    const { perAgent } = backfill.scan(['agy'], { sinceMs: null });
    assert.strictEqual(perAgent[0].count, 2);
    const { envelopes, summary, failures } = await backfill.uploadAll(perAgent, { dryRun: true });
    assert.deepStrictEqual(failures, []);
    assert.strictEqual(summary[0].sent, 2);
    const byId = Object.fromEntries(envelopes.map((e) => [e.envelope.payload.sessionId, e.envelope.payload]));
    assert.strictEqual(byId[SOLO].repo, '/synthetic/work/space dir'); // first file:// URI, decoded
    assert.strictEqual(byId[DUP].repo, '/tmp/agy_fix'); // no index row → transcript Cwd fallback
    assert.ok(byId[SOLO].num_tool_calls > 0 && byId[DUP].num_tool_calls > 0, 'transcripts read from each store');
  });
});
