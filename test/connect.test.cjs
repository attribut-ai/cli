'use strict';

// CONNECT TEST — the device-flow client. Exercises runConnect end to end against
// a local http server standing in for BOTH the app (/api/device/start|poll) and
// the ingest edge (/v1/connect): agent selection, start payload, poll-until-
// approved, per-agent token persistence + hook install, and the closing connect
// emit. Also covers the pure arg/normalize helpers and the headless default.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

// Isolate every on-disk side effect into temp dirs BEFORE requiring the modules.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-connect-'));
process.env.ATTRIBUT_CONFIG_DIR = path.join(TMP, 'config');
process.env.CLAUDE_SETTINGS_PATH = path.join(TMP, 'claude', 'settings.json');
process.env.AGY_HOOKS_PATH = path.join(TMP, 'gemini', 'hooks.json');
process.env.CODEX_CONFIG_PATH = path.join(TMP, 'codex', 'config.toml');
process.env.CURSOR_HOOKS_PATH = path.join(TMP, 'cursor', 'hooks.json');
process.env.ATTRIBUT_ALLOW_INSECURE = '1'; // permit the localhost http server
process.env.ATTRIBUT_NO_BROWSER = '1'; // never spawn a browser in tests
process.env.ATTRIBUT_POLL_INTERVAL_MS = '5'; // fast polling
// runConnect now also installs the heartbeat timer (timer.cjs) on success —
// sandbox its OS-specific paths into TMP too and skip the real
// launchctl/systemctl/schtasks activation call so the suite never touches the
// dev machine's or CI runner's actual scheduler.
process.env.ATTRIBUT_LAUNCHD_DIR = path.join(TMP, 'LaunchAgents');
process.env.ATTRIBUT_SYSTEMD_USER_DIR = path.join(TMP, 'systemd-user');
process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION = '1';
fs.mkdirSync(path.dirname(process.env.CLAUDE_SETTINGS_PATH), { recursive: true });

const connect = require('../src/connect.cjs');
const tokenStore = require('../src/token.cjs');

// A server that plays app + edge. `pollScript` is an array of responses returned
// by successive /api/device/poll calls. Records every request for assertions.
function startServer(pollScript) {
  const calls = { start: [], poll: [], connect: [] };
  let pollIdx = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        const reply = (code, obj) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.url === '/api/device/start') {
          calls.start.push(body);
          return reply(200, {
            userCode: 'WDJB-MJHT',
            verificationUrl: 'http://example.test/connect/device?code=WDJB-MJHT',
            expireAt: new Date(Date.now() + 60000).toISOString(),
          });
        }
        if (req.url === '/api/device/poll') {
          calls.poll.push(body);
          const r = pollScript[Math.min(pollIdx, pollScript.length - 1)];
          pollIdx += 1;
          return reply(200, r);
        }
        if (req.url === '/v1/connect') {
          calls.connect.push({ headers: req.headers, body });
          return reply(200, { status: 'ok' });
        }
        reply(404, { error: 'not found' });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('parseConnectArgs parses agents, flags, and overrides', () => {
  const a = connect.parseConnectArgs(['--agents=claude_code,agy', '--no-browser', '--app-base=https://x', '--endpoint=https://y']);
  assert.deepEqual(a.agents, ['claude_code', 'agy']);
  assert.equal(a.noBrowser, true);
  assert.equal(a.appBase, 'https://x');
  assert.equal(a.endpoint, 'https://y');
});

test('normalizeConfigs prefers configs[], falls back to legacy single token', () => {
  assert.deepEqual(
    connect.normalizeConfigs({ configs: [{ agent: 'agy', token: 't', endpoint: 'e' }] }),
    [{ agent: 'agy', token: 't', endpoint: 'e' }]
  );
  assert.deepEqual(connect.normalizeConfigs({ token: 'leg', endpoint: 'e' }), [
    { agent: 'claude_code', token: 'leg', endpoint: 'e' },
  ]);
  assert.deepEqual(connect.normalizeConfigs({ status: 'approved' }), []);
});

test('ingestBaseFrom: explicit override wins, then sample endpoint origin', () => {
  assert.equal(connect.ingestBaseFrom({ endpoint: 'https://ing.example/' }, null), 'https://ing.example');
  const prev = process.env.INGEST_BASE;
  delete process.env.INGEST_BASE;
  try {
    assert.equal(connect.ingestBaseFrom({}, 'https://srv.example/v1/hook'), 'https://srv.example');
    assert.equal(connect.ingestBaseFrom({}, null), 'https://ingest.attribut.ai');
  } finally {
    if (prev !== undefined) process.env.INGEST_BASE = prev;
  }
});

test('runConnect: start -> poll -> install hook + persist token + emit', async () => {
  const srv = await startServer([
    { status: 'pending' },
    { status: 'approved', configs: [{ agent: 'claude_code', token: 'tok-cc', endpoint: null }] },
  ]);
  try {
    const code = await connect.runConnect([
      '--agents=claude_code',
      `--app-base=${srv.origin}`,
      `--endpoint=${srv.origin}`,
    ]);
    assert.equal(code, 0);

    // start carried the selected agents + a deviceCode + hostname
    assert.equal(srv.calls.start.length, 1);
    assert.deepEqual(srv.calls.start[0].agents, ['claude_code']);
    assert.ok(srv.calls.start[0].deviceCode && srv.calls.start[0].deviceCode.length >= 32);

    // polled until approved (pending then approved)
    assert.ok(srv.calls.poll.length >= 2);

    // token persisted under the agent
    assert.equal(tokenStore.readToken('claude_code'), 'tok-cc');

    // hook registered into the (temp) claude settings file
    const settings = fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8');
    assert.match(settings, /collector\.cjs/);

    // emit hit /v1/connect once, with the agent's bearer + the right body shape
    assert.equal(srv.calls.connect.length, 1);
    const emit = srv.calls.connect[0];
    assert.equal(emit.headers['authorization'], 'Bearer tok-cc');
    assert.equal(emit.body.connector_type, 'otel');
    assert.equal(emit.body.agent, 'claude_code');
    assert.equal(emit.body.status, 'active');
    assert.ok(emit.body.event_id);
    assert.ok(emit.body.established_at);
  } finally {
    await srv.close();
  }
});

test('runConnect: a failed connect emit does NOT fail the command', async () => {
  // Server 404s /v1/connect (emit fails) but the flow still succeeds.
  const srv = await startServer([
    { status: 'approved', configs: [{ agent: 'claude_code', token: 'tok-2', endpoint: null }] },
  ]);
  const origConnect = srv;
  try {
    // Point ingest at a dead port so the emit POST errors out.
    const code = await connect.runConnect([
      '--agents=claude_code',
      `--app-base=${srv.origin}`,
      '--endpoint=http://127.0.0.1:1',
    ]);
    assert.equal(code, 0); // emit failure is non-fatal
    assert.equal(tokenStore.readToken('claude_code'), 'tok-2'); // still installed
  } finally {
    await origConnect.close();
  }
});

test('runConnect: expired before approval returns non-zero', async () => {
  const srv = await startServer([{ status: 'expired' }]);
  try {
    const code = await connect.runConnect([
      '--agents=claude_code',
      `--app-base=${srv.origin}`,
      `--endpoint=${srv.origin}`,
    ]);
    assert.equal(code, 1);
  } finally {
    await srv.close();
  }
});

test('runConnect: unknown agent is filtered, none left -> exit 2', async () => {
  const srv = await startServer([{ status: 'pending' }]);
  try {
    const code = await connect.runConnect(['--agents=bogus', `--app-base=${srv.origin}`]);
    assert.equal(code, 2); // bogus has no installer; nothing to connect
    assert.equal(srv.calls.start.length, 0); // never even started
  } finally {
    await srv.close();
  }
});

// --- non-interactive token mode (remote/cloud sandboxes) --------------------

test('parseConnectArgs reads --key/--token and --agent', () => {
  assert.equal(connect.parseConnectArgs(['--key=abc']).key, 'abc');
  assert.equal(connect.parseConnectArgs(['--token', 'xyz']).key, 'xyz');
  assert.equal(connect.parseConnectArgs(['--agent=agy']).agent, 'agy');
});

test('runConnect --key: non-interactive installs ALL tools + emits, no device flow', async () => {
  const srv = await startServer([{ status: 'pending' }]);
  try {
    const code = await connect.runConnect(['--key=cloud-tok', `--endpoint=${srv.origin}`]);
    assert.equal(code, 0);

    // NO device-flow calls — pure token pairing.
    assert.equal(srv.calls.start.length, 0);
    assert.equal(srv.calls.poll.length, 0);

    // Default (no --agent) wires up EVERY installable tool under the ONE token —
    // proven by codex/cursor/agy getting it without being named. Hooks written.
    for (const a of ['claude_code', 'agy', 'codex', 'cursor']) {
      assert.equal(tokenStore.readToken(a), 'cloud-tok');
    }
    assert.match(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'), /collector\.cjs/);
    assert.match(fs.readFileSync(process.env.CODEX_CONFIG_PATH, 'utf8'), /--provider openai/);

    // One connection event per connected tool, each bearing the shared token.
    assert.equal(srv.calls.connect.length, 4);
    assert.equal(srv.calls.connect[0].headers['authorization'], 'Bearer cloud-tok');
    assert.equal(srv.calls.connect[0].body.agent, 'claude_code');
    assert.equal(srv.calls.connect[0].body.connector_type, 'otel');
    assert.deepEqual(
      srv.calls.connect.map((c) => c.body.agent).sort(),
      ['agy', 'claude_code', 'codex', 'cursor'],
    );
  } finally {
    await srv.close();
  }
});

test('runConnect --key --agent: respects the agent; codex now installs; rejects unknown', async () => {
  const srv = await startServer([{ status: 'pending' }]);
  try {
    const ok = await connect.runConnect(['--key=ag-tok', '--agent=agy', `--endpoint=${srv.origin}`]);
    assert.equal(ok, 0);
    assert.equal(tokenStore.readToken('agy'), 'ag-tok');
    assert.equal(srv.calls.connect.at(-1).body.agent, 'agy');

    // codex is now installable: token persisted, hooks written to config.toml.
    const cx = await connect.runConnect(['--key=cx-tok', '--agent=codex', `--endpoint=${srv.origin}`]);
    assert.equal(cx, 0);
    assert.equal(tokenStore.readToken('codex'), 'cx-tok');
    assert.equal(srv.calls.connect.at(-1).body.agent, 'codex');
    assert.match(fs.readFileSync(process.env.CODEX_CONFIG_PATH, 'utf8'), /--provider openai/);

    // A genuinely non-installable agent is still rejected.
    const bad = await connect.runConnect(['--key=t', '--agent=windsurf', `--endpoint=${srv.origin}`]);
    assert.equal(bad, 2);
  } finally {
    await srv.close();
  }
});
