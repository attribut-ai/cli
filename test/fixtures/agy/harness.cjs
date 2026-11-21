'use strict';

// Test harness: a local stand-in for ingest plus a runner that spawns the REAL
// collector hook entrypoint (non-dry-run) with an Antigravity hook JSON on stdin.
// The spawn is ASYNC so the in-process server can observe any POST it makes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const COLLECTOR = path.join(__dirname, '..', '..', '..', 'src', 'collector.cjs');

function startIngest() {
  const captured = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      captured.push({ url: req.url, raw: body.toString('utf8'), json: JSON.parse(body.toString('utf8')) });
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

// Spawn `node collector.cjs --provider antigravity [...args]` with `stdin` (an
// object is JSON-encoded; a string is sent verbatim) against the local ingest on
// `port`. Resolves { code, stdout, stderr }.
function runAgyCollector(stdin, port, args = ['posttooluse']) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-cfg-'));
  fs.writeFileSync(path.join(cfg, 'token'), 'tok-agy-test\n', { mode: 0o600 });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COLLECTOR, '--provider', 'antigravity', ...args], {
      env: {
        ...process.env,
        ATTRIBUT_CONFIG_DIR: cfg,
        ATTRIBUT_ALLOW_INSECURE: '1',
        INGEST_BASE: `http://127.0.0.1:${port}`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

module.exports = { startIngest, listen, close, runAgyCollector };
