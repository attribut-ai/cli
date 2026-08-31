'use strict';

// Grok subagent attribution. Grok writes every worker TWICE — nested under its
// parent as `subagents/<childId>/{meta.json,output.json}` AND as a complete
// top-level session dir of its own. This suite covers both halves of the fix:
//   A. the parent's grok.subagents[] is populated from meta.json + the child's
//      own session dir (recursion bounded to exactly one level);
//   B. those child ids never surface as independent top-level sessions —
//      neither in backfill enumeration nor on the live collector hot path.
//
// Everything here is SYNTHETIC (staged from the sentinel fixture session); no
// real session data is committed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const grok = require('../src/parser/grok.cjs');
const { buildAndValidate } = require('../src/envelope.cjs');

const FIX_SESSION = path.join(__dirname, 'fixtures', 'grok', 'session');
const COLLECTOR = path.resolve(__dirname, '..', 'src', 'collector.cjs');

const PARENT_ID = '01990000-0000-7000-8000-00000000aaaa';
const PARENT_CWD = '/repo/grok-parent';
const UNRELATED_ID = '01990000-0000-7000-8000-00000000ffff';

// Three workers: two with a real child session dir on disk, one whose dir is
// deliberately absent (the degraded meta.json-only path).
const CHILDREN = [
  {
    id: '01990000-0000-7000-8000-00000000b001',
    cwd: '/repo/grok-parent/.worktrees/w1',
    type: 'general-purpose',
    description: 'U1 parser contract',
    model: 'grok-4.6',
    tool_calls: 7,
    duration_ms: 520088,
    started_at: '2026-08-29T19:50:19.855432Z',
    completed_at: '2026-08-29T19:59:02.505784Z',
    usage: { inputTokens: 9000, outputTokens: 1200, cachedReadTokens: 2500, cacheCreationTokens: 60 },
    onDisk: true,
  },
  {
    id: '01990000-0000-7000-8000-00000000b002',
    cwd: '/repo/grok-parent/.worktrees/w2',
    type: 'code-reviewer',
    description: 'U2 hook installer',
    model: 'grok-4.5',
    tool_calls: 3,
    duration_ms: 80922,
    started_at: '2026-08-29T19:51:07.460000Z',
    completed_at: '2026-08-29T19:52:28.382000Z',
    usage: { inputTokens: 4000, outputTokens: 300, cachedReadTokens: 900, cacheCreationTokens: 11 },
    onDisk: true,
  },
  {
    id: '01990000-0000-7000-8000-00000000b003',
    cwd: '/repo/grok-parent/.worktrees/gone',
    type: 'general-purpose',
    description: 'U3 vanished worker',
    model: 'grok-4.6',
    tool_calls: 5,
    duration_ms: 12345,
    started_at: '2026-08-29T20:00:31.392000Z',
    completed_at: '2026-08-29T20:00:43.737000Z',
    usage: null,
    onDisk: false, // child session dir never written — meta.json is all we get
  },
];

const SUB_PROMPT_SENTINEL = 'SECRET_SUBAGENT_PROMPT';
const SUB_OUTPUT_SENTINEL = 'SECRET_SUBAGENT_OUTPUT';

// Stage one Grok session dir cloned from the sentinel fixture, re-identified to
// `id`/`cwd` and (optionally) given a single deterministic usage line.
function stageSession(root, id, cwd, usage) {
  const dir = path.join(root, encodeURIComponent(cwd), id);
  fs.cpSync(FIX_SESSION, dir, { recursive: true });
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  summary.info.id = id;
  summary.info.cwd = cwd;
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary));
  if (usage) {
    fs.writeFileSync(
      path.join(dir, 'updates.jsonl'),
      JSON.stringify({ params: { update: { usage } } }) + '\n'
    );
  }
  return dir;
}

// Write `<parent>/subagents/<childId>/{meta.json,output.json}`. output.json is
// planted with a sentinel purely so the privacy assertions have something to
// catch — the parser must never open it.
function writeSubagentRecord(parentDir, child, overrides = {}) {
  const dir = path.join(parentDir, 'subagents', child.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      subagent_id: child.id,
      parent_session_id: PARENT_ID,
      child_session_id: child.id,
      subagent_type: child.type,
      description: child.description,
      prompt: `${SUB_PROMPT_SENTINEL} ${child.id} full task text that must never ship`,
      status: 'completed',
      started_at: child.started_at,
      completed_at: child.completed_at,
      duration_ms: child.duration_ms,
      tool_calls: child.tool_calls,
      turns: 1,
      effective_context_source: 'new',
      child_cwd: child.cwd,
      effective_model_id: child.model,
      ...overrides,
    })
  );
  fs.writeFileSync(
    path.join(dir, 'output.json'),
    JSON.stringify({ schema_version: 1, output: `${SUB_OUTPUT_SENTINEL} ${child.id}` })
  );
  return dir;
}

// A full sessions root: parent + its three worker records + the two on-disk
// child session dirs + one unrelated real session that must survive every filter.
function stageRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sub-'));
  const parentDir = stageSession(root, PARENT_ID, PARENT_CWD, null);
  for (const c of CHILDREN) {
    writeSubagentRecord(parentDir, c);
    if (c.onDisk) stageSession(root, c.id, c.cwd, c.usage);
  }
  stageSession(root, UNRELATED_ID, '/repo/grok-unrelated', null);
  return { root, parentDir };
}

// GROK_SESSIONS_DIR points the parser at the staged tree. The child-id walk is
// memoized per root, so reset it around every staging.
function withRoot(fn) {
  const { root, parentDir } = stageRoot();
  const prev = process.env.GROK_SESSIONS_DIR;
  process.env.GROK_SESSIONS_DIR = root;
  grok._resetSubagentCache();
  try {
    return fn({ root, parentDir });
  } finally {
    if (prev === undefined) delete process.env.GROK_SESSIONS_DIR;
    else process.env.GROK_SESSIONS_DIR = prev;
    grok._resetSubagentCache();
  }
}

// ---------------------------------------------------------------------------
// A. subagents[] population
// ---------------------------------------------------------------------------

test('parent nests every worker in grok.subagents[] with labels and timings', () => {
  withRoot(({ parentDir }) => {
    const p = grok.parseGrokSession(parentDir);
    const subs = p.grok.subagents;
    assert.strictEqual(subs.length, CHILDREN.length);

    const byRole = new Map(subs.map((s) => [s.role, s]));
    for (const c of CHILDREN) {
      const s = byRole.get(c.description);
      assert.ok(s, `missing subagent for ${c.description}`);
      assert.strictEqual(s.agent_type, c.type);
      assert.strictEqual(s.model, c.model);
      assert.strictEqual(s.status, 'completed');
      assert.strictEqual(s.duration_ms, c.duration_ms);
      assert.strictEqual(s.started_at, new Date(c.started_at).toISOString());
      assert.strictEqual(s.ended_at, new Date(c.completed_at).toISOString());
      // Grok has no classified-diff source: line metrics stay NULL on workers too.
      assert.strictEqual(s.lines_code_added, null);
      assert.strictEqual(s.added_char_sumsq, null);
    }
  });
});

test('worker token totals reconcile against the child session dirs', () => {
  withRoot(({ root, parentDir }) => {
    const p = grok.parseGrokSession(parentDir);
    const byRole = new Map(p.grok.subagents.map((s) => [s.role, s]));

    for (const c of CHILDREN.filter((x) => x.onDisk)) {
      const childDir = path.join(root, encodeURIComponent(c.cwd), c.id);
      const direct = grok.parseGrokSession(childDir, { withSubagents: false });
      const s = byRole.get(c.description);
      assert.strictEqual(s.input_tokens, direct.tokens_in);
      assert.strictEqual(s.output_tokens, direct.tokens_out);
      assert.strictEqual(s.cache_read_tokens, direct.grok.cache_read_tokens);
      assert.strictEqual(s.cache_creation_tokens, direct.grok.cache_creation_tokens);
      assert.strictEqual(s.tool_use_count, direct.num_tool_calls);
      assert.deepStrictEqual(s.tool_uses, direct.tool_uses);
      // The disjoint-token contract: fresh input excludes the cached read.
      assert.strictEqual(s.input_tokens, c.usage.inputTokens - c.usage.cachedReadTokens);
      assert.strictEqual(s.output_tokens, c.usage.outputTokens);
    }
  });
});

test('a missing child session dir still emits the worker, with NULL tokens', () => {
  withRoot(({ parentDir }) => {
    const p = grok.parseGrokSession(parentDir);
    const s = p.grok.subagents.find((x) => x.role === 'U3 vanished worker');
    assert.ok(s, 'worker with no child dir must not be dropped');
    // Unknown, not zero — 0 would read as "ran and spent nothing".
    assert.strictEqual(s.input_tokens, null);
    assert.strictEqual(s.output_tokens, null);
    assert.strictEqual(s.cache_read_tokens, null);
    assert.strictEqual(s.cache_creation_tokens, null);
    assert.deepStrictEqual(s.tool_uses, []);
    // meta.json still supplies the labels, timings and the tool-call total.
    assert.strictEqual(s.model, 'grok-4.6');
    assert.strictEqual(s.status, 'completed');
    assert.strictEqual(s.tool_use_count, 5);
    assert.strictEqual(s.duration_ms, 12345);
  });
});

test('a session with no subagents dir keeps subagents []', () => {
  withRoot(({ root }) => {
    const dir = path.join(root, encodeURIComponent('/repo/grok-unrelated'), UNRELATED_ID);
    assert.deepStrictEqual(grok.parseGrokSession(dir).grok.subagents, []);
  });
});

test('a parent carrying subagents still validates against the envelope contract', () => {
  withRoot(({ parentDir }) => {
    const payload = grok.parseGrokSession(parentDir, { device_uuid: 'dev-grok' });
    const env = buildAndValidate(payload, {
      _trigger: 'sessionend',
      _source: 'cli',
      _provider: 'xai',
      _tool: 'grok',
    });
    assert.strictEqual(env.payload.grok.subagents.length, CHILDREN.length);
  });
});

test('recursion is bounded to one level: a grandchild is never nested', () => {
  withRoot(({ root, parentDir }) => {
    // Give the FIRST worker its own subagents/ dir pointing at a grandchild that
    // also exists as a real top-level session dir.
    const grandchild = {
      id: '01990000-0000-7000-8000-00000000c001',
      cwd: '/repo/grok-parent/.worktrees/g1',
      type: 'general-purpose',
      description: 'G1 GRANDCHILD SENTINEL',
      model: 'grok-4.6',
      tool_calls: 2,
      duration_ms: 999,
      started_at: '2026-08-29T19:52:00.000000Z',
      completed_at: '2026-08-29T19:52:00.999000Z',
      usage: { inputTokens: 77, outputTokens: 7, cachedReadTokens: 0, cacheCreationTokens: 0 },
      onDisk: true,
    };
    const childDir = path.join(root, encodeURIComponent(CHILDREN[0].cwd), CHILDREN[0].id);
    writeSubagentRecord(childDir, grandchild);
    stageSession(root, grandchild.id, grandchild.cwd, grandchild.usage);
    grok._resetSubagentCache();

    const p = grok.parseGrokSession(parentDir);
    assert.strictEqual(p.grok.subagents.length, CHILDREN.length, 'depth-1 workers only');
    assert.ok(
      !JSON.stringify(p).includes('G1 GRANDCHILD SENTINEL'),
      'grandchild must not appear anywhere in the parent payload'
    );
    // Parsing the CHILD directly still sees its own worker — discovery is
    // disabled only for the nested re-entry, not globally.
    const direct = grok.parseGrokSession(childDir);
    assert.strictEqual(direct.grok.subagents.length, 1);
    assert.strictEqual(direct.grok.subagents[0].role, 'G1 GRANDCHILD SENTINEL');
  });
});

test('buildGrokSubagents never throws and returns [] for a nonexistent dir', () => {
  assert.deepStrictEqual(grok.buildGrokSubagents('/no/such/grok/session', PARENT_ID), []);
  assert.deepStrictEqual(grok.buildGrokSubagents(null, PARENT_ID), []);
});

// ---------------------------------------------------------------------------
// B. suppression: a worker is never a top-level session
// ---------------------------------------------------------------------------

test('subagentChildIds collects every child id under the sessions root', () => {
  withRoot(() => {
    const ids = grok.subagentChildIds();
    for (const c of CHILDREN) assert.ok(ids.has(c.id), `missing child id ${c.id}`);
    assert.ok(!ids.has(PARENT_ID), 'a parent is not its own child');
    assert.ok(!ids.has(UNRELATED_ID), 'an unrelated session is not a child');
    for (const c of CHILDREN) assert.ok(grok.isSubagentSession(c.id));
    assert.ok(!grok.isSubagentSession(PARENT_ID));
    assert.ok(!grok.isSubagentSession(null));
  });
});

test('backfill enumeration returns the parent and the unrelated session, never a worker', () => {
  withRoot(() => {
    const { enumerate } = require('../src/backfill.cjs');
    const ids = enumerate('grok').map((d) => d.sessionId).sort();
    assert.deepStrictEqual(ids, [PARENT_ID, UNRELATED_ID].sort());
    for (const c of CHILDREN) {
      assert.ok(!ids.includes(c.id), `worker ${c.id} must not enumerate as a session`);
    }
  });
});

// The collector guard runs in a spawned process (that is where the hot path
// lives), so it needs a live ingest endpoint to prove NOTHING was POSTed.
function startIngest() {
  const captured = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      captured.push(JSON.parse(body.toString('utf8')));
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

// spawn (not spawnSync): the ingest server above lives in THIS process, so the
// event loop has to stay free to answer the collector's POST.
function runCollector(args, { input, env }) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sub-cli-'));
  fs.writeFileSync(path.join(configDir, 'token'), 'tok-grok\n', { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn('node', [COLLECTOR, ...args], {
      env: { ...process.env, ATTRIBUT_CONFIG_DIR: configDir, ATTRIBUT_ALLOW_INSECURE: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('collector refuses a worker Stop and POSTs nothing; the parent still posts', async () => {
  const { root } = stageRoot();
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  const env = { GROK_SESSIONS_DIR: root, INGEST_BASE: `http://127.0.0.1:${port}` };
  try {
    const child = CHILDREN[0];
    const res = await runCollector(['--provider', 'xai', 'stop'], {
      input: JSON.stringify({ hookEventName: 'Stop', sessionId: child.id, cwd: child.cwd }),
      env,
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /suppressing grok subagent/i);
    assert.strictEqual(captured.length, 0, 'a subagent Stop must not POST a top-level session');

    // Positive control: the parent on the same tree DOES post, with its workers nested.
    const ok = await runCollector(['--provider', 'xai', 'sessionend'], {
      input: JSON.stringify({ hookEventName: 'SessionEnd', sessionId: PARENT_ID, cwd: PARENT_CWD }),
      env,
    });
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].payload.sessionId, PARENT_ID);
    assert.strictEqual(captured[0].payload.grok.subagents.length, CHILDREN.length);
  } finally {
    await close(srv);
  }
});
