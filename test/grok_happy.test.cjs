'use strict';

// Grok happy path: xai collector POSTs one gzip envelope; missing token is
// fail-open; backfill walks session dirs and skips a dir with no summary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-grok-happy-'));
process.env.ATTRIBUT_CONFIG_DIR = path.join(TMP, 'config');
process.env.ATTRIBUT_ALLOW_INSECURE = '1';
fs.mkdirSync(process.env.ATTRIBUT_CONFIG_DIR, { recursive: true });

const backfill = require('../src/backfill.cjs');
const tokenStore = require('../src/token.cjs');

const COLLECTOR = path.resolve(__dirname, '..', 'src', 'collector.cjs');
const FIX_SESSION = path.join(__dirname, 'fixtures', 'grok', 'session');
const SID = '01990000-0000-7000-8000-000000000001';
const CWD = '/repo/grok-demo';
const LAST_MSG = 'SECRET_LAST_ASSISTANT_SHOULD_NEVER_POST';

function stageTree({ missingSummary = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-tree-'));
  const good = path.join(root, encodeURIComponent(CWD), SID);
  fs.cpSync(FIX_SESSION, good, { recursive: true });
  if (missingSummary) {
    const bad = path.join(root, encodeURIComponent(CWD), '01990000-0000-7000-8000-missing');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'events.jsonl'), '');
  }
  return root;
}

function grokStdin() {
  return JSON.stringify({
    hookEventName: 'Stop',
    sessionId: SID,
    cwd: CWD,
    workspaceRoot: CWD,
    lastAssistantMessage: LAST_MSG,
  });
}

function startIngest() {
  const captured = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      captured.push({
        url: req.url,
        auth: req.headers.authorization,
        encoding: req.headers['content-encoding'],
        json: JSON.parse(body.toString('utf8')),
      });
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

function runCollector(args, { input, env = {}, token = 'tok-grok' } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-happy-cli-'));
  if (token) fs.writeFileSync(path.join(configDir, 'token'), token + '\n', { mode: 0o600 });
  return spawnSync('node', [COLLECTOR, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ATTRIBUT_CONFIG_DIR: configDir, ATTRIBUT_ALLOW_INSECURE: '1', ...env },
  });
}

// Async spawn so this process's HTTP ingest server can accept the POST
// (spawnSync would block the event loop and the request would time out).
function runCollectorAsync(args, { input, env = {}, token = 'tok-grok' } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-happy-cli-'));
  if (token) fs.writeFileSync(path.join(configDir, 'token'), token + '\n', { mode: 0o600 });
  return new Promise((resolve) => {
    const child = spawn('node', [COLLECTOR, ...args], {
      env: { ...process.env, ATTRIBUT_CONFIG_DIR: configDir, ATTRIBUT_ALLOW_INSECURE: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input || '');
  });
}

test('xai provider + fixture session → one gzip POST, tool=grok, provider=xai', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  const sessions = stageTree();
  try {
    const res = await runCollectorAsync(['--provider', 'xai', 'stop'], {
      input: grokStdin(),
      env: {
        INGEST_BASE: `http://127.0.0.1:${port}`,
        GROK_SESSIONS_DIR: sessions,
      },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(captured.length, 1);
    const req = captured[0];
    assert.equal(req.url, '/v1/hook');
    assert.equal(req.encoding, 'gzip');
    assert.equal(req.auth, 'Bearer tok-grok');
    assert.equal(req.json.provider, 'xai');
    assert.equal(req.json.tool, 'grok');
    assert.equal(req.json.payload.sessionId, SID);
    assert.ok(!JSON.stringify(req.json).includes(LAST_MSG));
  } finally {
    await close(srv);
  }
});

test('missing token → exit 0, log, no POST', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  const sessions = stageTree();
  try {
    const res = runCollector(['--provider', 'xai', 'stop'], {
      input: grokStdin(),
      token: null,
      env: {
        INGEST_BASE: `http://127.0.0.1:${port}`,
        GROK_SESSIONS_DIR: sessions,
      },
    });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /token/i);
    assert.equal(captured.length, 0);
  } finally {
    await close(srv);
  }
});

test('backfill: two session dirs, one missing summary → one envelope, other skipped', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  const sessions = stageTree({ missingSummary: true });
  const prevSess = process.env.GROK_SESSIONS_DIR;
  const prevIngest = process.env.INGEST_BASE;
  process.env.GROK_SESSIONS_DIR = sessions;
  process.env.INGEST_BASE = `http://127.0.0.1:${port}`;
  tokenStore.writeToken('tok-grok', 'grok');
  try {
    const descriptors = backfill.enumerate('grok');
    assert.equal(descriptors.length, 2, 'both session dirs enumerated');

    const code = await backfill.runBackfill(['--agents=grok', '--all', '--yes']);
    assert.equal(code, 0);
    assert.equal(captured.length, 1, 'only the complete session is posted');
    assert.equal(captured[0].json.tool, 'grok');
    assert.equal(captured[0].json.provider, 'xai');
    assert.equal(captured[0].json._trigger, 'backfill');
    assert.equal(captured[0].json.payload.sessionId, SID);
  } finally {
    if (prevSess === undefined) delete process.env.GROK_SESSIONS_DIR;
    else process.env.GROK_SESSIONS_DIR = prevSess;
    if (prevIngest === undefined) delete process.env.INGEST_BASE;
    else process.env.INGEST_BASE = prevIngest;
    tokenStore.removeToken('grok');
    await close(srv);
  }
});
