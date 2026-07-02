'use strict';

// NETWORK TEST — the one part that talks to the outside world. Exercises
// postEnvelope against a local http server (ATTRIBUT_ALLOW_INSECURE=1): gzip
// round-trip + bearer header, non-2xx rejection, missing-token rejection, and
// the https-only enforcement.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

// Isolate config dir so readToken() uses our test token, not a real ~/.attribut.
process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-net-'));
process.env.ATTRIBUT_ALLOW_INSECURE = '1'; // permit the localhost http test server

const tokenStore = require('../src/token.cjs');
tokenStore.writeToken('test-bearer');

const collector = require('../src/collector.cjs');

const ENVELOPE = { provider: 'anthropic', tool: 'claude_code', schema_version: 1, payload: { sessionId: 's' } };

// Start a one-shot server with the given handler; returns { url, close, received }.
function startServer(handler) {
  return new Promise((resolve) => {
    const received = {};
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.headers = req.headers;
        received.body = Buffer.concat(chunks);
        handler(req, res, received);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1/hook`,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function withEndpoint(url, fn) {
  const prev = process.env.ATTRIBUT_COLLECTOR_URL;
  process.env.ATTRIBUT_COLLECTOR_URL = url;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.ATTRIBUT_COLLECTOR_URL;
    else process.env.ATTRIBUT_COLLECTOR_URL = prev;
  });
}

test('postEnvelope gzips the body, sets the bearer header, resolves on 2xx', async () => {
  const srv = await startServer((req, res, rec) => {
    rec.json = JSON.parse(zlib.gunzipSync(rec.body).toString('utf8'));
    res.writeHead(200);
    res.end('ok');
  });
  try {
    await withEndpoint(srv.url, async () => {
      const res = await collector.postEnvelope(ENVELOPE);
      assert.equal(res.status, 200);
    });
    assert.equal(srv.received.headers['content-encoding'], 'gzip');
    assert.equal(srv.received.headers['authorization'], 'Bearer test-bearer');
    assert.deepEqual(srv.received.json, ENVELOPE);
  } finally {
    await srv.close();
  }
});

test('postEnvelope rejects on a non-2xx response', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  try {
    await withEndpoint(srv.url, async () => {
      await assert.rejects(() => collector.postEnvelope(ENVELOPE), /HTTP 500/);
    });
  } finally {
    await srv.close();
  }
});

test('postEnvelope rejects when no token file is present', async () => {
  tokenStore.removeToken();
  try {
    await withEndpoint('http://127.0.0.1:1/v1/hook', async () => {
      await assert.rejects(() => collector.postEnvelope(ENVELOPE), /no ingest token/);
    });
  } finally {
    tokenStore.writeToken('test-bearer'); // restore for any later test
  }
});

test('postEnvelope refuses a non-https endpoint without the insecure flag', async () => {
  const prev = process.env.ATTRIBUT_ALLOW_INSECURE;
  delete process.env.ATTRIBUT_ALLOW_INSECURE;
  try {
    await withEndpoint('http://127.0.0.1:1/v1/hook', async () => {
      await assert.rejects(() => collector.postEnvelope(ENVELOPE), /non-https/);
    });
  } finally {
    process.env.ATTRIBUT_ALLOW_INSECURE = prev;
  }
});

test('agentForProvider maps provider → device-flow agent slug', () => {
  assert.equal(collector.agentForProvider('anthropic'), 'claude_code');
  assert.equal(collector.agentForProvider('antigravity'), 'agy');
  assert.equal(collector.agentForProvider(undefined), 'claude_code');
});

test('postEnvelope(envelope, agent) sends THAT agent’s token from a per-agent map', async () => {
  // Per-agent store: claude_code vs agy carry distinct tokens.
  tokenStore.writeToken('cc-token', 'claude_code');
  tokenStore.writeToken('agy-token', 'agy');
  const srv = await startServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  try {
    await withEndpoint(srv.url, async () => {
      await collector.postEnvelope(ENVELOPE, 'agy');
    });
    assert.equal(srv.received.headers['authorization'], 'Bearer agy-token');
  } finally {
    await srv.close();
    tokenStore.removeToken(); // back to a clean slate
    tokenStore.writeToken('test-bearer'); // restore the bare token other tests rely on
  }
});
