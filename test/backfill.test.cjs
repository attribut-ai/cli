'use strict';

// BACKFILL TEST — send-existing-sessions-through-live-capture-path command.
// Exercises the pure helpers (parseSince, asyncPool, scan windowing) plus full
// end-to-end runs of `runBackfill` against a local HTTP server standing in for
// ingest: codex + claude_code sessions are built, POSTed, gzip-decoded, and
// asserted on. Also covers --dry-run (sends nothing), unknown-agent usage
// errors, and the non-interactive skip of runBackfillInteractive.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate on-disk side effects into a temp dir BEFORE requiring the modules
// (mirrors test/connect.test.cjs's ordering).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-backfill-'));
process.env.ATTRIBUT_CONFIG_DIR = path.join(TMP, 'config');
process.env.ATTRIBUT_ALLOW_INSECURE = '1'; // permit the localhost http ingest servers

const backfill = require('../src/backfill.cjs');
const tokenStore = require('../src/token.cjs');

const { runBackfill, runBackfillInteractive, scan, enumerate, parseSince, asyncPool, AGENT_SLUGS } = backfill;

const CODEX_FIX_DIR = path.join(__dirname, 'fixtures', 'codex');
const CLAUDE_FIXTURE = path.join(__dirname, 'fixtures', 'synthetic.jsonl');

let nodeSqlite = false;
try {
  const { getDatabaseClass } = require('../src/parser/antigravity_tokens.cjs');
  if (getDatabaseClass()) nodeSqlite = true;
} catch {
  nodeSqlite = false;
}

// --- shared local-ingest harness (proven pattern) ---------------------------

function startIngest() {
  const captured = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      captured.push({ url: req.url, auth: req.headers.authorization, json: JSON.parse(body.toString('utf8')) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return { srv, captured };
}

function listen(srv) {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

function close(srv) {
  return new Promise((resolve) => srv.close(resolve));
}

// =============================================================================
// parseSince
// =============================================================================

test('parseSince: "90d" is ~90 days before now', () => {
  const got = parseSince('90d');
  const expected = Date.now() - 90 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(got - expected) < 5000, `expected ~${expected}, got ${got}`);
});

test('parseSince: undefined defaults to a number (90d)', () => {
  const got = parseSince(undefined);
  assert.equal(typeof got, 'number');
  const expected = Date.now() - 90 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(got - expected) < 5000);
});

test('parseSince: "all" and null both mean no cutoff', () => {
  assert.equal(parseSince('all'), null);
  assert.equal(parseSince(null), null);
});

test('parseSince: a valid ISO date parses', () => {
  assert.equal(parseSince('2026-01-01'), Date.parse('2026-01-01'));
});

test('parseSince: an invalid string throws', () => {
  assert.throws(() => parseSince('not-a-date'));
});

// =============================================================================
// asyncPool
// =============================================================================

test('asyncPool: caps concurrency, resolves in item order, tolerates a rejecting worker', async () => {
  const items = [0, 1, 2, 3, 4, 5];
  let inFlight = 0;
  let maxInFlight = 0;

  const results = await asyncPool(2, items, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    if (item === 3) throw new Error('boom on item 3');
    return item;
  });

  assert.ok(maxInFlight <= 2, `never more than 2 concurrently in flight, got ${maxInFlight}`);
  assert.equal(results.length, items.length);
  results.forEach((r, i) => {
    if (i === 3) {
      assert.equal(r.ok, false);
      assert.ok(r.error instanceof Error);
    } else {
      assert.equal(r.ok, true);
    }
  });
});

test('asyncPool: empty items resolves an empty array immediately', async () => {
  const results = await asyncPool(4, [], async () => {});
  assert.deepEqual(results, []);
});

// =============================================================================
// scan windowing (codex fixture — no build step)
// =============================================================================

test('enumerate("codex") returns exactly the top-level rollout, excluding the subagent child', () => {
  const prev = process.env.CODEX_SESSIONS_DIR;
  process.env.CODEX_SESSIONS_DIR = CODEX_FIX_DIR;
  try {
    const descriptors = enumerate('codex');
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].sessionId, '00000000-0000-7000-8000-000000000001');
    assert.equal(typeof descriptors[0].whenMs, 'number');
  } finally {
    if (prev === undefined) delete process.env.CODEX_SESSIONS_DIR;
    else process.env.CODEX_SESSIONS_DIR = prev;
  }
});

test('scan: sinceMs in the future windows out everything; sinceMs=null keeps it', () => {
  const prev = process.env.CODEX_SESSIONS_DIR;
  process.env.CODEX_SESSIONS_DIR = CODEX_FIX_DIR;
  try {
    const future = scan(['codex'], { sinceMs: Date.now() + 365 * 24 * 60 * 60 * 1000 });
    assert.equal(future.total, 0);
    assert.equal(future.perAgent[0].count, 0);

    const all = scan(['codex'], { sinceMs: null });
    assert.equal(all.total, 1);
    assert.equal(all.perAgent[0].count, 1);
    assert.equal(all.perAgent[0].agent, 'codex');
    assert.ok(all.perAgent[0].oldestMs != null);
    assert.ok(all.perAgent[0].newestMs != null);
  } finally {
    if (prev === undefined) delete process.env.CODEX_SESSIONS_DIR;
    else process.env.CODEX_SESSIONS_DIR = prev;
  }
});

test('AGENT_SLUGS exposes the four supported agents', () => {
  assert.deepEqual([...AGENT_SLUGS].sort(), ['agy', 'claude_code', 'codex', 'cursor']);
});

// =============================================================================
// runBackfill: codex end-to-end
// =============================================================================

test('runBackfill codex e2e: exactly 1 POST, correct auth/tool/trigger/payload', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  const prevSessDir = process.env.CODEX_SESSIONS_DIR;
  const prevIngest = process.env.INGEST_BASE;
  process.env.CODEX_SESSIONS_DIR = CODEX_FIX_DIR;
  process.env.INGEST_BASE = `http://127.0.0.1:${port}`;
  tokenStore.writeToken('tok-codex', 'codex');
  try {
    const code = await runBackfill(['--agents=codex', '--all', '--yes']);
    assert.equal(code, 0);
    assert.equal(captured.length, 1);
    const req = captured[0];
    assert.equal(req.url, '/v1/hook');
    assert.equal(req.auth, 'Bearer tok-codex');
    assert.equal(req.json.tool, 'codex');
    assert.equal(req.json._trigger, 'backfill');
    assert.equal(req.json._source, 'cli');
    assert.equal(req.json.payload.sessionId, '00000000-0000-7000-8000-000000000001');
  } finally {
    if (prevSessDir === undefined) delete process.env.CODEX_SESSIONS_DIR;
    else process.env.CODEX_SESSIONS_DIR = prevSessDir;
    if (prevIngest === undefined) delete process.env.INGEST_BASE;
    else process.env.INGEST_BASE = prevIngest;
    tokenStore.removeToken('codex');
    await close(srv);
  }
});

// =============================================================================
// runBackfill: claude_code end-to-end (monkeypatched homedir)
// =============================================================================

test('runBackfill claude_code e2e: 1 POST, tool=claude_code, trigger=backfill', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-claude-home-'));
  const projDir = path.join(tmpHome, '.claude', 'projects', 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.copyFileSync(CLAUDE_FIXTURE, path.join(projDir, '11111111-2222-3333-4444-555555555555.jsonl'));

  const origHomedir = os.homedir;
  os.homedir = () => tmpHome;
  const prevIngest = process.env.INGEST_BASE;
  process.env.INGEST_BASE = `http://127.0.0.1:${port}`;
  tokenStore.writeToken('tok-claude', 'claude_code');
  try {
    const code = await runBackfill(['--agents=claude_code', '--all', '--yes']);
    assert.equal(code, 0);
    assert.equal(captured.length, 1);
    const req = captured[0];
    assert.equal(req.json.tool, 'claude_code');
    assert.equal(req.json._trigger, 'backfill');
    assert.equal(req.json._source, 'cli');
  } finally {
    os.homedir = origHomedir;
    if (prevIngest === undefined) delete process.env.INGEST_BASE;
    else process.env.INGEST_BASE = prevIngest;
    tokenStore.removeToken('claude_code');
    await close(srv);
  }
});

// =============================================================================
// --dry-run sends nothing
// =============================================================================

test('runBackfill --dry-run: exit 0, nothing POSTed', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  const prevSessDir = process.env.CODEX_SESSIONS_DIR;
  const prevIngest = process.env.INGEST_BASE;
  process.env.CODEX_SESSIONS_DIR = CODEX_FIX_DIR;
  process.env.INGEST_BASE = `http://127.0.0.1:${port}`;
  tokenStore.writeToken('tok-codex-dry', 'codex');
  try {
    const code = await runBackfill(['--agents=codex', '--all', '--dry-run']);
    assert.equal(code, 0);
    assert.equal(captured.length, 0);
  } finally {
    if (prevSessDir === undefined) delete process.env.CODEX_SESSIONS_DIR;
    else process.env.CODEX_SESSIONS_DIR = prevSessDir;
    if (prevIngest === undefined) delete process.env.INGEST_BASE;
    else process.env.INGEST_BASE = prevIngest;
    tokenStore.removeToken('codex');
    await close(srv);
  }
});

// =============================================================================
// unknown agent -> usage error, no POST
// =============================================================================

test('runBackfill: unknown agent returns exit 2 and posts nothing', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  const prevIngest = process.env.INGEST_BASE;
  process.env.INGEST_BASE = `http://127.0.0.1:${port}`;
  try {
    const code = await runBackfill(['--agents=bogus']);
    assert.equal(code, 2);
    assert.equal(captured.length, 0);
  } finally {
    if (prevIngest === undefined) delete process.env.INGEST_BASE;
    else process.env.INGEST_BASE = prevIngest;
    await close(srv);
  }
});

// =============================================================================
// fail-safe: a session's POST failure is counted, never aborts the batch
// =============================================================================

// Ingest stand-in that 500s every request (records that the POST was attempted).
function startFailingIngest() {
  const captured = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured.push({ url: req.url });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"nope"}');
    });
  });
  return { srv, captured };
}

test('runBackfill: a failing POST is fail-safe — batch still exits 0, POST was attempted', async () => {
  const { srv, captured } = startFailingIngest();
  const port = await listen(srv);
  const prevSessDir = process.env.CODEX_SESSIONS_DIR;
  const prevIngest = process.env.INGEST_BASE;
  process.env.CODEX_SESSIONS_DIR = CODEX_FIX_DIR;
  process.env.INGEST_BASE = `http://127.0.0.1:${port}`;
  tokenStore.writeToken('tok-fail', 'codex');
  try {
    const code = await runBackfill(['--agents=codex', '--all', '--yes']);
    assert.equal(code, 0); // one session's POST failure must never fail the command
    assert.equal(captured.length, 1); // the POST was attempted (not aborted before sending)
  } finally {
    if (prevSessDir === undefined) delete process.env.CODEX_SESSIONS_DIR;
    else process.env.CODEX_SESSIONS_DIR = prevSessDir;
    if (prevIngest === undefined) delete process.env.INGEST_BASE;
    else process.env.INGEST_BASE = prevIngest;
    tokenStore.removeToken('codex');
    await close(srv);
  }
});

// =============================================================================
// --since with no value → usage error (fail loud, like --agents)
// =============================================================================

test('runBackfill: --since with no value returns exit 2 (usage error), posts nothing', async () => {
  // Exits at the --since guard before any scan/enumerate/POST — no server needed.
  const code = await runBackfill(['--agents=codex', '--since']);
  assert.equal(code, 2);
});

// =============================================================================
// runBackfillInteractive: non-TTY skip (the case under `node --test`)
// =============================================================================

test('runBackfillInteractive: skips silently on non-TTY, posts nothing', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  try {
    // Under `node --test`, stdout/stdin are not TTYs — runBackfillInteractive
    // must return silently without prompting or uploading.
    await assert.doesNotReject(
      runBackfillInteractive({ connected: [{ agent: 'codex' }], ingestBase: `http://127.0.0.1:${port}` })
    );
    assert.equal(captured.length, 0);
  } finally {
    await close(srv);
  }
});

// =============================================================================
// enumerator exclusion — agy / cursor (sqlite-backed, skip if no driver)
// =============================================================================

test('enumerate("agy") excludes subagent children (only the parent conversation)', { skip: !nodeSqlite }, () => {
  const { buildSyntheticDb } = require('./fixtures/agy/build_db.cjs');
  const conv = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-agy-conv-'));
  const PARENT = '11111111-1111-1111-1111-111111111111';
  const CHILD = '22222222-2222-2222-2222-222222222222';
  const prev = process.env.AGY_CONVERSATIONS_DIR;
  process.env.AGY_CONVERSATIONS_DIR = conv;
  try {
    buildSyntheticDb(conv, PARENT, { input: 100, output: 10 });
    buildSyntheticDb(conv, CHILD, { input: 200, output: 20, parentId: PARENT });
    const descriptors = enumerate('agy');
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].id, PARENT);
  } finally {
    if (prev === undefined) delete process.env.AGY_CONVERSATIONS_DIR;
    else process.env.AGY_CONVERSATIONS_DIR = prev;
  }
});

test('enumerate("cursor") excludes sub-composers referenced in a parent\'s subComposerIds', { skip: !nodeSqlite }, () => {
  const { buildCursorFixture } = require('./fixtures/cursor/build_db.cjs');
  const fixture = buildCursorFixture({
    composerId: 'parent-composer',
    model: 'gpt-5',
    bubbles: [],
    subagents: [{ composerId: 'child-composer', model: 'gpt-5', bubbles: [] }],
  });
  const prev = process.env.CURSOR_STATE_DB;
  process.env.CURSOR_STATE_DB = fixture.dbPath;
  try {
    const descriptors = enumerate('cursor');
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].composerId, 'parent-composer');
  } finally {
    if (prev === undefined) delete process.env.CURSOR_STATE_DB;
    else process.env.CURSOR_STATE_DB = prev;
  }
});

// =============================================================================
// failureSummary — friendly, categorized, no raw paths (UX)
// =============================================================================

const { uploadAll, failureSummary, defaultConcurrency } = backfill;

test('failureSummary: null when there are no failures', () => {
  assert.equal(failureSummary([]), null);
  assert.equal(failureSummary(undefined), null);
});

test('failureSummary: all-ENOENT reads as "no longer on disk", pluralized, no raw path', () => {
  const one = failureSummary([
    { agent: 'agy', message: "ENOENT: no such file or directory, open '/Users/x/.gemini/brain/z/transcript_full.jsonl'" },
  ]);
  assert.match(one, /1 session was skipped/);
  assert.match(one, /no longer on disk/);
  assert.doesNotMatch(one, /ENOENT|\/Users\/|transcript_full/); // never leak the raw error/path
  const two = failureSummary([
    { agent: 'agy', message: 'ENOENT: no such file or directory' },
    { agent: 'agy', message: 'ENOENT: no such file or directory' },
  ]);
  assert.match(two, /2 sessions were skipped/);
});

test('failureSummary: a non-ENOENT cause reads as "could not be read locally"', () => {
  const s = failureSummary([{ agent: 'codex', message: 'unexpected token in JSON' }]);
  assert.match(s, /could not be read locally/);
  assert.doesNotMatch(s, /unexpected token/);
});

// =============================================================================
// uploadAll — phased (preprocess → transmit); failures collected, not thrown
// =============================================================================

test('uploadAll: a build failure is collected (not thrown), counted, and still ticks both phases', async () => {
  // A claude_code descriptor pointing at a nonexistent transcript: the PREPARE
  // phase build throws, so it never reaches transmit — no network needed.
  const perAgent = [{ agent: 'claude_code', descriptors: [{ path: '/nonexistent/nope.jsonl', whenMs: 0 }] }];
  const ticks = [];
  const { summary, failures } = await uploadAll(perAgent, {
    onProgress: (p) => ticks.push(p),
  });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].sent, 0);
  assert.equal(summary[0].failed, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].agent, 'claude_code');
  // A build failure spends BOTH its ticks up front (it can never transmit) so the
  // 2-per-session count stays exact and a 2×total bar still fills.
  assert.equal(ticks.length, 2);
  assert.deepEqual(ticks[0], { agent: 'claude_code', phase: 'prepare', done: 1, total: 1 });
  assert.deepEqual(ticks[1], { agent: 'claude_code', phase: 'transmit', done: 1, total: 1 });
});

test('uploadAll --dry-run: collects built envelopes, POSTs nothing, ticks twice per session', async () => {
  const prevSessDir = process.env.CODEX_SESSIONS_DIR;
  process.env.CODEX_SESSIONS_DIR = CODEX_FIX_DIR;
  try {
    const result = scan(['codex'], { sinceMs: null });
    assert.ok(result.total >= 1);
    const phases = { prepare: 0, transmit: 0 };
    const { summary, envelopes, failures } = await uploadAll(result.perAgent, {
      dryRun: true,
      onProgress: ({ phase }) => (phases[phase] += 1),
    });
    assert.equal(failures.length, 0);
    assert.equal(envelopes.length, result.total); // one built envelope per session
    assert.equal(summary[0].sent, result.total);
    // Two ticks per session: one prepare, one transmit — a 2×total bar fills.
    assert.equal(phases.prepare, result.total);
    assert.equal(phases.transmit, result.total);
    assert.ok(envelopes[0].envelope && envelopes[0].agent === 'codex');
  } finally {
    if (prevSessDir === undefined) delete process.env.CODEX_SESSIONS_DIR;
    else process.env.CODEX_SESSIONS_DIR = prevSessDir;
  }
});

test('defaultConcurrency: 16 by default, env-overridable, capped at 64, ignores junk', () => {
  const prev = process.env.ATTRIBUT_BACKFILL_CONCURRENCY;
  try {
    delete process.env.ATTRIBUT_BACKFILL_CONCURRENCY;
    assert.equal(defaultConcurrency(), 16);
    process.env.ATTRIBUT_BACKFILL_CONCURRENCY = '8';
    assert.equal(defaultConcurrency(), 8);
    process.env.ATTRIBUT_BACKFILL_CONCURRENCY = '999';
    assert.equal(defaultConcurrency(), 64);
    process.env.ATTRIBUT_BACKFILL_CONCURRENCY = 'nonsense';
    assert.equal(defaultConcurrency(), 16);
    process.env.ATTRIBUT_BACKFILL_CONCURRENCY = '0';
    assert.equal(defaultConcurrency(), 16);
  } finally {
    if (prev === undefined) delete process.env.ATTRIBUT_BACKFILL_CONCURRENCY;
    else process.env.ATTRIBUT_BACKFILL_CONCURRENCY = prev;
  }
});
