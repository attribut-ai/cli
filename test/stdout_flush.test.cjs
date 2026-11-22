'use strict';

// Printed payloads larger than a pipe buffer must arrive WHOLE. Pipe writes are
// asynchronous on POSIX, and the CLI used to process.exit() straight after a
// large stdout write, so a piped `--dry-run` / `--parse` / `backfill --dry-run`
// was cut at 65536 bytes (invalid JSON). Each test spawns the real CLI with stdout
// as a PIPE (as `| jq` would), reads it to EOF and parses it. SYNTHETIC data only.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');

const tokens = require('../src/parser/antigravity_tokens.cjs');
const { buildSyntheticDb, writeBrainTranscript } = require('./fixtures/agy/build_db.cjs');

const COLLECTOR = path.join(__dirname, '..', 'src', 'collector.cjs');
const FIXTURE_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy', 'transcript_full.jsonl'), 'utf8');
const PIPE_BUFFER = 65536;

let nodeSqlite = false;
try {
  if (tokens.getDatabaseClass()) nodeSqlite = true;
} catch {
  nodeSqlite = false;
}

// Spawn the CLI with piped stdio; resolve { code, stdout, stderr } at close.
function runCli(args, { stdin = '', env = {} } = {}) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-cfg-'));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COLLECTOR, ...args], {
      env: { ...process.env, ATTRIBUT_CONFIG_DIR: cfg, ...env },
    });
    const out = [];
    let stderr = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr }));
    child.stdin.end(stdin);
  });
}

// A synthetic store whose one parent nests `n` children, so its envelope is big.
function bigStore(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-store-'));
  const conv = path.join(root, 'conversations');
  const brain = path.join(root, 'brain');
  const parent = 'ffffffff-0000-4000-8000-000000000000';
  buildSyntheticDb(conv, parent, { input: 1, output: 1 });
  const transcriptPath = writeBrainTranscript(brain, parent, FIXTURE_TEXT);
  for (let i = 1; i <= n; i++) {
    const id = `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`;
    buildSyntheticDb(conv, id, { input: 1, output: 1, parentId: parent });
    writeBrainTranscript(brain, id, FIXTURE_TEXT);
  }
  return { root, hook: { conversationId: parent, transcriptPath, workspacePaths: ['/synthetic/repo'] } };
}

test('a piped --dry-run envelope larger than the pipe buffer arrives whole', { skip: !nodeSqlite }, async () => {
  const { root, hook } = bigStore(80);
  try {
    const r = await runCli(['--provider', 'antigravity', '--dry-run', 'posttooluse'], {
      stdin: JSON.stringify(hook),
      env: { AGY_STORE_ROOTS: root },
    });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(Buffer.byteLength(r.stdout) > PIPE_BUFFER, `only ${Buffer.byteLength(r.stdout)} bytes — not a >64 KB case`);
    const env = JSON.parse(r.stdout);
    assert.strictEqual(env.payload.antigravity.subagents.length, 80);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a piped --parse payload larger than the pipe buffer arrives whole', async () => {
  // Many distinct tool names → a long tool_uses[] (names + counts only).
  const tx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flush-tx-')), 'transcript_full.jsonl');
  const lines = [];
  for (let i = 0; i < 3000; i++) {
    lines.push(JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-07-01T00:00:00Z', tool_calls: [{ name: `synthetic_tool_${i}` }] }));
  }
  fs.writeFileSync(tx, lines.join('\n'));
  const r = await runCli(['--provider', 'antigravity', '--parse', tx]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout) > PIPE_BUFFER);
  assert.strictEqual(JSON.parse(r.stdout).tool_uses.length, 3000);
});

test('a piped `backfill --dry-run` larger than the pipe buffer arrives whole', { skip: !nodeSqlite }, async () => {
  const { root } = bigStore(80);
  try {
    const r = await runCli(['backfill', '--agents=agy', '--all', '--dry-run'], { env: { AGY_STORE_ROOTS: root } });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(Buffer.byteLength(r.stdout) > PIPE_BUFFER);
    const marker = 'Envelopes that WOULD be sent (dry run — nothing was posted):\n';
    const at = r.stdout.indexOf(marker);
    assert.ok(at !== -1, 'dry-run header printed');
    const envelopes = JSON.parse(r.stdout.slice(at + marker.length));
    assert.strictEqual(envelopes.length, 1);
    assert.strictEqual(envelopes[0].envelope.payload.antigravity.subagents.length, 80);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
