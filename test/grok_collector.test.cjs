'use strict';

// Grok collector dispatch: --provider xai builds a grok envelope; default/
// anthropic refuses Grok-shaped stdin (dual-install collision guard).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('node:child_process');

process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-grok-col-'));

const collector = require('../src/collector.cjs');

const FIX_SESSION = path.join(__dirname, 'fixtures', 'grok', 'session');
const COLLECTOR = path.resolve(__dirname, '..', 'src', 'collector.cjs');
const SID = '01990000-0000-7000-8000-000000000001';
const CWD = '/repo/grok-demo';
const LAST_MSG = 'SECRET_LAST_ASSISTANT_SHOULD_NEVER_POST';

function stageSessions() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sessions-'));
  fs.cpSync(FIX_SESSION, path.join(root, encodeURIComponent(CWD), SID), { recursive: true });
  return root;
}

function grokStdin(overrides = {}) {
  return JSON.stringify({
    hookEventName: 'SessionEnd',
    sessionId: SID,
    cwd: CWD,
    workspaceRoot: CWD,
    lastAssistantMessage: LAST_MSG,
    ...overrides,
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

function run(args, { input, env = {}, token = 'tok-grok' } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cli-'));
  if (token) fs.writeFileSync(path.join(configDir, 'token'), token + '\n', { mode: 0o600 });
  return spawnSync('node', [COLLECTOR, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ATTRIBUT_CONFIG_DIR: configDir, ATTRIBUT_ALLOW_INSECURE: '1', ...env },
  });
}

test('agentForProvider maps xai → grok', () => {
  assert.strictEqual(collector.agentForProvider('xai'), 'grok');
});

test('triggerFor accepts Grok camelCase event names', () => {
  assert.strictEqual(collector.triggerFor('SessionEnd'), 'sessionend');
  assert.strictEqual(collector.triggerFor('sessionEnd'), 'sessionend');
  assert.strictEqual(collector.triggerFor('Stop'), 'stop');
  assert.strictEqual(collector.triggerFor('stop'), 'stop');
});

test('buildGrokEnvelopeFromHook tags xai/grok and ignores lastAssistantMessage', () => {
  const sessions = stageSessions();
  const prev = process.env.GROK_SESSIONS_DIR;
  process.env.GROK_SESSIONS_DIR = sessions;
  try {
    const env = collector.buildGrokEnvelopeFromHook(
      {
        hookEventName: 'Stop',
        sessionId: SID,
        cwd: CWD,
        lastAssistantMessage: LAST_MSG,
        reason: 'end_turn',
      },
      { trigger: 'stop', source: 'cli' }
    );
    assert.strictEqual(env.provider, 'xai');
    assert.strictEqual(env.tool, 'grok');
    assert.strictEqual(env._trigger, 'stop');
    assert.strictEqual(env.payload.sessionId, SID);
    assert.strictEqual(env.payload.repo, CWD);
    assert.strictEqual(env.payload.grok.reason, 'end_turn');
    assert.ok(!JSON.stringify(env).includes(LAST_MSG), 'lastAssistantMessage must not enter the envelope');
  } finally {
    if (prev === undefined) delete process.env.GROK_SESSIONS_DIR;
    else process.env.GROK_SESSIONS_DIR = prev;
  }
});

test('anthropic provider + Grok-shaped stdin → no POST (AE3 dual-install guard)', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  try {
    const res = run(['--provider', 'anthropic', 'sessionend'], {
      input: grokStdin(),
      env: { INGEST_BASE: `http://127.0.0.1:${port}` },
    });
    assert.strictEqual(res.status, 0);
    assert.match(res.stderr, /refus/i);
    assert.strictEqual(captured.length, 0, 'Claude collector must not POST Grok stdin');
  } finally {
    await close(srv);
  }
});

test('default provider (no --provider) also refuses Grok stdin', async () => {
  const { srv, captured } = startIngest();
  const port = await listen(srv);
  try {
    const res = run(['sessionend'], {
      input: grokStdin(),
      env: { INGEST_BASE: `http://127.0.0.1:${port}` },
    });
    assert.strictEqual(res.status, 0);
    assert.match(res.stderr, /refus/i);
    assert.strictEqual(captured.length, 0);
  } finally {
    await close(srv);
  }
});

test('dry-run xai Stop builds a grok envelope; lastAssistantMessage absent', () => {
  const sessions = stageSessions();
  const res = run(['--provider', 'xai', '--dry-run', 'stop'], {
    input: grokStdin({ hookEventName: 'Stop' }),
    env: { GROK_SESSIONS_DIR: sessions },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const env = JSON.parse(res.stdout);
  assert.strictEqual(env.provider, 'xai');
  assert.strictEqual(env.tool, 'grok');
  assert.ok(!res.stdout.includes(LAST_MSG));
});

test('unresolvable grok session fails quietly (exit 0)', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-empty-'));
  const res = run(['--provider', 'xai', 'stop'], {
    input: grokStdin({ sessionId: 'no-such-session' }),
    env: { GROK_SESSIONS_DIR: empty },
  });
  assert.strictEqual(res.status, 0);
  assert.match(res.stderr, /could not build grok envelope|No Grok session found/);
});
