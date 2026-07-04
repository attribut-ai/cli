'use strict';

// `attribut connect` — the browser device-flow client.
//
// The CLI can't ask the user to paste a token safely, so it uses the same
// OAuth-style DEVICE FLOW as `gh auth login`: pick which on-device tools to
// capture, get a short code + URL, the user approves in a browser where they are
// already signed in, and the CLI polls until the server hands back ONE ingest
// token per agent. The CLI then installs each agent's capture hook and emits a
// "connection established" telemetry event.
//
// The whole server/browser side already exists in the app:
//   POST <APP_BASE>/api/device/start  { deviceCode, hostname, agents } -> { userCode, verificationUrl, expireAt }
//   POST <APP_BASE>/api/device/poll   { deviceCode }                  -> { status, configs:[{agent,token,endpoint}], ... }
// On approval the app mints a per-agent token and provisions an `otel` connector
// (status: active) per agent. This module is the missing CLI half.
//
// FAILURE POLICY: connect is an explicit user action, so it fails LOUD (non-zero
// exit + stderr) on real errors — opposite of the collector hot path. The ONE
// exception is the closing telemetry emit: the connection itself already
// succeeded, so a failed emit is logged loudly but does not fail the command.
//
// Config (env, with flag overrides):
//   ATTRIBUT_APP_BASE / NEXT_PUBLIC_APP_URL   app origin (default https://attribut.ai)
//   INGEST_BASE                                ingest origin (default https://ingest.attribut.ai)
//   ATTRIBUT_NO_BROWSER=1                      never auto-open a browser
//   ATTRIBUT_POLL_INTERVAL_MS                  poll cadence (default 3000; tests set it low)
//   ATTRIBUT_ALLOW_INSECURE=1                  permit http:// bases (localhost tests only)

const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { URL } = require('url');

const { getOrCreateDeviceUuid } = require('./device.cjs');
const installer = require('./install.cjs');
const timer = require('./timer.cjs');
const { version: PKG_VERSION } = require('../package.json');

const DEFAULT_APP_BASE = 'https://attribut.ai';
const DEFAULT_INGEST_BASE = 'https://ingest.attribut.ai';

// The agents `connect` can actually wire up, in display order. Sourced from the
// installer so the two never drift (claude_code, agy today).
const AGENT_LABELS = { claude_code: 'Claude Code', agy: 'Antigravity (Gemini)', codex: 'Codex', cursor: 'Cursor' };
const AGENTS = installer.INSTALLABLE_AGENTS.map((slug) => ({
  slug,
  label: AGENT_LABELS[slug] || slug,
}));

function out(msg) {
  process.stdout.write(`${msg}\n`);
}
function err(msg) {
  process.stderr.write(`${msg}\n`);
}

const CONNECT_HELP = `
attribut connect — connect this device to ATTRIBUT

Two modes:

  Interactive (device flow) — the default for terminals:
    attribut connect [--agents=claude_code,agy] [--no-browser]
  Pick the tools to capture, approve in a browser (where you're signed in), and
  the hooks install themselves. No token to copy.

  Non-interactive (token) — for remote/cloud sandboxes with NO interactivity:
    attribut connect --key=<ingest-token> [--agent=claude_code]
  Pairs straight from a minted token (the one the web "App · Cloud" card hands
  you). Put it in the environment's Setup script — no browser, no prompts.

Options:
  --agents=<a,b>   Interactive: agents to connect, skips the prompt.
                   Installable: ${installer.INSTALLABLE_AGENTS.join(', ')}.
  --key=<token>    Non-interactive: the ingest token to pair with.
  --agent=<slug>   Non-interactive: the token's agent (default claude_code).
  --no-browser     Interactive: don't auto-open a browser — just print code+URL.
  --no-backfill    Skip the post-connect prompt to backfill prior local sessions.
  --app-base=<u>   Override the app origin (default ${DEFAULT_APP_BASE}).
  --endpoint=<u>   Override the ingest origin (default ${DEFAULT_INGEST_BASE}).
  -h, --help       Show this help.
`;

/**
 * Parse connect's args.
 * Returns { agents, key, agent, noBrowser, appBase, endpoint, help }.
 */
function parseConnectArgs(argv) {
  const r = {
    agents: null,
    key: null,
    agent: null,
    noBrowser: false,
    appBase: null,
    endpoint: null,
    // null = default (offer the interactive backfill prompt on a TTY); false =
    // --no-backfill (skip it). We never force backfill on a non-TTY here — a
    // scripted import should call `attribut backfill --yes` explicitly.
    backfill: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agents') r.agents = splitAgents(argv[++i]);
    else if (a.startsWith('--agents=')) r.agents = splitAgents(a.slice('--agents='.length));
    // --key / --token are synonyms for the non-interactive ingest token.
    else if (a === '--key' || a === '--token') r.key = argv[++i];
    else if (a.startsWith('--key=')) r.key = a.slice('--key='.length);
    else if (a.startsWith('--token=')) r.key = a.slice('--token='.length);
    else if (a === '--agent') r.agent = argv[++i];
    else if (a.startsWith('--agent=')) r.agent = a.slice('--agent='.length);
    else if (a === '--no-browser') r.noBrowser = true;
    else if (a === '--no-backfill') r.backfill = false;
    else if (a === '--backfill') r.backfill = true;
    else if (a === '--app-base') r.appBase = argv[++i];
    else if (a.startsWith('--app-base=')) r.appBase = a.slice('--app-base='.length);
    else if (a === '--endpoint') r.endpoint = argv[++i];
    else if (a.startsWith('--endpoint=')) r.endpoint = a.slice('--endpoint='.length);
    else if (a === '-h' || a === '--help') r.help = true;
  }
  return r;
}

function splitAgents(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function stripSlash(u) {
  return String(u).replace(/\/+$/, '');
}

function appBaseFrom(opts) {
  return stripSlash(
    opts.appBase || process.env.ATTRIBUT_APP_BASE || process.env.NEXT_PUBLIC_APP_URL || DEFAULT_APP_BASE
  );
}

// Resolve the ingest origin used for BOTH the installed hooks and the connect
// emit: an explicit override wins, then INGEST_BASE, then the origin the server
// told us to post to (sampleEndpoint), then the default.
function ingestBaseFrom(opts, sampleEndpoint) {
  if (opts.endpoint) return stripSlash(opts.endpoint);
  if (process.env.INGEST_BASE) return stripSlash(process.env.INGEST_BASE);
  if (sampleEndpoint) {
    try {
      return new URL(sampleEndpoint).origin;
    } catch {
      /* not a URL — fall through */
    }
  }
  return DEFAULT_INGEST_BASE;
}

// POST JSON to `urlStr`; resolve { status, json } for ANY HTTP status (the caller
// decides), reject only on transport error/timeout or a non-https base without
// the insecure escape hatch. `bearer` adds an Authorization header.
// Warn (don't block) when a token-bearing POST resolves to a host outside the
// expected attribut.ai family — the endpoint is env/flag-overridable, so this is
// defense-in-depth against silently redirecting the token to another origin.
function isExpectedHost(hostname) {
  return hostname === 'attribut.ai' || hostname.endsWith('.attribut.ai');
}

function postJson(urlStr, body, { bearer, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return reject(new Error(`not a valid URL: ${urlStr}`));
    }
    const allowInsecure = process.env.ATTRIBUT_ALLOW_INSECURE === '1';
    if (url.protocol !== 'https:' && !allowInsecure) {
      return reject(
        new Error(
          `refusing to POST to non-https endpoint ${url.href} ` +
            '(set ATTRIBUT_ALLOW_INSECURE=1 only for local testing).'
        )
      );
    }
    if (bearer && !allowInsecure && !isExpectedHost(url.hostname)) {
      process.stderr.write(
        `[attribut] warning: sending token to non-default host ${url.hostname} ` +
          `(expected the attribut.ai host family).\n`
      );
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      'User-Agent': `attribut-cli/${PKG_VERSION}`,
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {
          /* leave json null — caller can still inspect status */
        }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', (e) => reject(new Error(`POST ${url.href} failed: ${e.message}`)));
    req.on('timeout', () => req.destroy(new Error(`POST ${url.href} timed out after ${timeoutMs}ms`)));
    req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve which agents to connect: an explicit --agents list (validated), else an
// interactive numbered prompt, else (non-TTY, no flag) a logged default. Returns
// a deduped list of installable slugs, or [] if the user picked nothing.
async function resolveAgents(opts) {
  if (opts.agents) return validateAgents(opts.agents);

  if (!process.stdin.isTTY) {
    out('No TTY and no --agents given; defaulting to: claude_code');
    out('  (re-run with --agents=claude_code,agy to choose explicitly.)');
    return ['claude_code'];
  }

  out('Which tools on this device should ATTRIBUT capture?');
  AGENTS.forEach((a, i) => out(`  ${i + 1}) ${a.label}  [${a.slug}]`));
  const answer = await prompt(
    `Enter numbers to connect (comma-separated, default all = 1-${AGENTS.length}): `
  );
  const picked = answer.trim()
    ? answer
        .split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= AGENTS.length)
        .map((n) => AGENTS[n - 1].slug)
    : AGENTS.map((a) => a.slug);
  return [...new Set(picked)];
}

function validateAgents(list) {
  const ok = [];
  for (const a of list) {
    if (installer.INSTALLABLE_AGENTS.includes(a)) ok.push(a);
    else err(`  Skipping "${a}" — no hook installer (installable: ${installer.INSTALLABLE_AGENTS.join(', ')}).`);
  }
  return [...new Set(ok)];
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

// Best-effort open the verification URL in a browser. Never throws; returns true
// only if a launcher was spawned. Suppressed by --no-browser / ATTRIBUT_NO_BROWSER
// / a non-interactive stdout / (on Linux) no DISPLAY.
function openBrowser(url, opts) {
  if (opts.noBrowser || process.env.ATTRIBUT_NO_BROWSER === '1') return false;
  if (process.platform === 'linux' && !process.env.DISPLAY) return false;
  let cmd, args;
  if (process.platform === 'darwin') [cmd, args] = ['open', [url]];
  else if (process.platform === 'win32') [cmd, args] = ['cmd', ['/c', 'start', '', url]];
  else [cmd, args] = ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * `attribut connect [...]`. Returns an exit code (0 ok, non-zero on failure).
 */
async function runConnect(argv) {
  const opts = parseConnectArgs(argv || []);
  if (opts.help) {
    out(CONNECT_HELP.trimStart());
    return 0;
  }

  // Non-interactive token mode: pair straight from a minted token. This is the
  // remote/cloud-sandbox path — no browser, no prompts, no polling.
  if (opts.key) return runTokenConnect(opts);

  const agents = await resolveAgents(opts);
  if (agents.length === 0) {
    err('No installable tools selected — nothing to connect.');
    return 2;
  }

  const appBase = appBaseFrom(opts);
  const deviceCode = crypto.randomBytes(32).toString('base64url');
  const hostname = os.hostname();

  // 1) Start the device flow.
  let start;
  try {
    start = await postJson(`${appBase}/api/device/start`, { deviceCode, hostname, agents });
  } catch (e) {
    err(`Could not reach ${appBase}: ${e.message}`);
    return 1;
  }
  if (start.status < 200 || start.status >= 300 || !start.json || !start.json.userCode) {
    err(`Device start failed (HTTP ${start.status}): ${(start.json && start.json.error) || start.text || 'unknown error'}`);
    return 1;
  }
  const { userCode, verificationUrl, expireAt } = start.json;

  // 2) Tell the user where to approve (and try to open it for them).
  out('');
  out(`  Open:  ${verificationUrl}`);
  out(`  Code:  ${userCode}`);
  if (openBrowser(verificationUrl, opts)) out('  (opened your browser…)');
  else out('  (open the link above on any device and enter the code)');
  out('');
  out('Waiting for approval…');

  // 3) Poll until approved / expired / deadline.
  const interval = parseInt(process.env.ATTRIBUT_POLL_INTERVAL_MS || '3000', 10);
  const deadline = Date.parse(expireAt) || Date.now() + 10 * 60 * 1000;
  let configs = null;
  while (Date.now() < deadline) {
    await sleep(interval);
    let poll;
    try {
      poll = await postJson(`${appBase}/api/device/poll`, { deviceCode });
    } catch (e) {
      err(`Poll failed: ${e.message}`);
      return 1;
    }
    const status = poll.json && poll.json.status;
    if (status === 'approved') {
      configs = normalizeConfigs(poll.json);
      break;
    }
    if (status === 'expired') {
      err('The request expired before it was approved. Re-run `attribut connect`.');
      return 1;
    }
    // 'pending' (or anything else) → keep waiting.
  }
  if (!configs) {
    err('Timed out waiting for approval. Re-run `attribut connect`.');
    return 1;
  }

  // 4) Install each agent's hook (persisting its per-agent token) + emit.
  const sampleEndpoint = configs.find((c) => c.endpoint)?.endpoint || null;
  const ingestBase = ingestBaseFrom(opts, sampleEndpoint);
  const deviceUuid = getOrCreateDeviceUuid();
  const connected = [];

  for (const cfg of configs) {
    if (!installer.INSTALLABLE_AGENTS.includes(cfg.agent)) {
      err(`  Skipping "${cfg.agent}" — no hook installer on this CLI version.`);
      continue;
    }
    try {
      installer.registerAgent({ agent: cfg.agent, token: cfg.token, ingestBase });
      connected.push(cfg);
      out(`  ✓ Installed capture hook for ${cfg.agent}`);
    } catch (e) {
      err(`  ✗ Could not install ${cfg.agent}: ${e.message}`);
      return 1; // a real install failure is fatal
    }
  }
  if (connected.length === 0) {
    err('No connectable tools were returned by the server.');
    return 1;
  }

  // 5) Emit the "connection established" telemetry line (loud but non-fatal).
  for (const cfg of connected) {
    await emitConnected({ agent: cfg.agent, token: cfg.token, ingestBase, deviceUuid, hostname });
  }

  // 6) Install the hourly heartbeat timer (best-effort — see timer.cjs). Runs
  // once per connect, not per agent: it's a device-level liveness signal.
  timer.installTimer();

  out('');
  out(`✓ Connection established for: ${connected.map((c) => c.agent).join(', ')}`);
  out('  (Restart any running sessions to pick up the hook.)');

  // 7) Offer a one-time backfill of pre-connect local history (opt-in, default
  // yes, TTY only). --no-backfill skips it. Never fatal — the connection already
  // succeeded, so a backfill hiccup must not fail `connect`.
  if (opts.backfill !== false) {
    try {
      await require('./backfill.cjs').runBackfillInteractive({ connected, ingestBase });
    } catch (e) {
      err(`  (note: backfill skipped: ${e.message})`);
    }
  }
  return 0;
}

/**
 * Non-interactive pairing from a pre-minted token. Installs ONE agent's hook
 * (the token is agent-scoped server-side; default claude_code) and emits the
 * connection-established event. Built for remote/cloud sandboxes where there is
 * no browser and no interactivity — drop it in the environment's Setup script.
 * Returns an exit code.
 */
async function runTokenConnect(opts) {
  const agent = opts.agent || 'claude_code';
  if (!installer.INSTALLABLE_AGENTS.includes(agent)) {
    err(`Cannot connect agent "${agent}" — installable: ${installer.INSTALLABLE_AGENTS.join(', ')}.`);
    return 2;
  }
  const ingestBase = ingestBaseFrom(opts, null);
  try {
    installer.registerAgent({ agent, token: opts.key, ingestBase });
  } catch (e) {
    err(`Could not install ${agent}: ${e.message}`);
    return 1;
  }
  out(`✓ Installed capture hook for ${agent}`);
  await emitConnected({
    agent,
    token: opts.key,
    ingestBase,
    deviceUuid: getOrCreateDeviceUuid(),
    hostname: os.hostname(),
  });
  timer.installTimer();
  out(`✓ Connection established for: ${agent}`);
  return 0;
}

// Normalize the poll response into [{ agent, token, endpoint }]. Prefers the
// per-agent `configs[]`; falls back to the legacy single token/endpoint (treated
// as claude_code) so older app deployments still work.
function normalizeConfigs(json) {
  if (Array.isArray(json.configs) && json.configs.length) {
    return json.configs
      .filter((c) => c && c.agent && c.token)
      .map((c) => ({ agent: c.agent, token: c.token, endpoint: c.endpoint || null }));
  }
  if (json.token) {
    return [{ agent: 'claude_code', token: json.token, endpoint: json.endpoint || null }];
  }
  return [];
}

// POST the connection-established event to <ingestBase>/v1/connect. The edge tags
// it kind=connect; the worker writes a connector_events row. Best-effort: a
// failure here is logged but does not fail `connect` (the hook is already live).
async function emitConnected({ agent, token, ingestBase, deviceUuid, hostname }) {
  const now = new Date().toISOString();
  const body = {
    event_id: crypto.randomUUID(),
    connector_type: 'otel',
    agent,
    status: 'active',
    device_uuid: deviceUuid,
    cli_version: PKG_VERSION,
    hostname,
    established_at: now,
  };
  try {
    const res = await postJson(`${ingestBase}/v1/connect`, body, { bearer: token });
    if (res.status < 200 || res.status >= 300) {
      err(`  (note: connect event for ${agent} returned HTTP ${res.status} — the connection still works.)`);
    }
  } catch (e) {
    err(`  (note: could not send connect event for ${agent}: ${e.message} — the connection still works.)`);
  }
}

module.exports = {
  runConnect,
  parseConnectArgs,
  normalizeConfigs,
  ingestBaseFrom,
  appBaseFrom,
  AGENTS,
};
