'use strict';

// `attribut heartbeat` — a fire-and-forget liveness signal, distinct from the
// hook-triggered /v1/hook envelope. Installed as an hourly OS timer (see
// timer.cjs) by `attribut connect`, so the server can tell "this connector
// went quiet because the editor/agent stopped firing hooks" apart from "this
// device is gone / uninstalled ATTRIBUT" — gap detection needs SOME signal
// that isn't gated on the agent actually running.
//
// FAILURE POLICY: opposite of connect/install (which fail loud — explicit user
// actions). A background timer job must never hang a cron/launchd slot or spam
// stderr on a flaky network: one POST attempt, a ~5s timeout, and exit 0 on ANY
// send failure. The absence of a heartbeat IS the signal the server acts on —
// local retries would only mask that signal from the system built to detect
// it. The ONE case that exits non-zero is "no token configured at all", which
// is a real not-connected state, not a network blip — that keeps `attribut
// heartbeat` useful as a standalone smoke test.
//
// PAYLOAD: exactly the allowlist below — no paths, no prompts, no content.
// IP/geo is derived server-side from the request; never sent by the client.

const os = require('os');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const { getOrCreateDeviceUuid } = require('./device.cjs');
const { getOrCreateMachineId } = require('./machine_id.cjs');
const { readLastHookInvocationAt } = require('./state.cjs');
const { readToken } = require('./token.cjs');
const { version: PKG_VERSION } = require('../package.json');

const DEFAULT_INGEST_BASE = 'https://ingest.attribut.ai';

function endpoint() {
  const base = (process.env.INGEST_BASE || DEFAULT_INGEST_BASE).replace(/\/+$/, '');
  return `${base}/v1/heartbeat`;
}

function out(msg) {
  process.stdout.write(`${msg}\n`);
}
function log(msg) {
  process.stderr.write(`[attribut] ${msg}\n`);
}

/**
 * Build the heartbeat JSON body. Pure given its inputs — the default
 * arguments do the (cached, cheap) id/state lookups so production callers can
 * just call buildHeartbeatPayload(), while tests inject every field.
 */
function buildHeartbeatPayload({
  now = new Date(),
  deviceUuid = getOrCreateDeviceUuid(),
  machineId = getOrCreateMachineId(),
  lastHookInvocationAt = readLastHookInvocationAt(),
  source = 'timer',
} = {}) {
  return {
    kind: 'heartbeat',
    schema_version: 1,
    sent_at: now.toISOString(),
    device_uuid: deviceUuid,
    machine_id: machineId,
    cli_version: PKG_VERSION,
    platform: process.platform,
    os_release: os.release(),
    source,
    last_hook_invocation_at: lastHookInvocationAt,
  };
}

// POST `body` to `urlStr` with a hard timeout. Resolves on 2xx, rejects
// otherwise — runHeartbeat is the one that decides to swallow the rejection.
// Warn (don't block) when a token-bearing POST resolves to a host outside the
// expected attribut.ai family — the endpoint is env-overridable, so this is
// defense-in-depth against silently redirecting the token to another origin.
function isExpectedHost(hostname) {
  return hostname === 'attribut.ai' || hostname.endsWith('.attribut.ai');
}

function postJson(urlStr, body, { bearer, timeoutMs = 5000 } = {}) {
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
      Authorization: `Bearer ${bearer}`,
    };
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: data });
        else reject(new Error(`heartbeat POST returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', (e) => reject(new Error(`heartbeat POST failed: ${e.message}`)));
    req.on('timeout', () => req.destroy(new Error(`heartbeat POST timed out after ${timeoutMs}ms`)));
    req.write(payload);
    req.end();
  });
}

const HEARTBEAT_HELP = `
attribut heartbeat — send a one-off liveness signal to ATTRIBUT

Usage:
  attribut heartbeat [--dry-run]

Fires a single, best-effort POST to \${INGEST_BASE:-${DEFAULT_INGEST_BASE}}/v1/heartbeat
so the server can detect a silently stalled connector even between real hook
events. Installed automatically by \`attribut connect\` as an hourly OS timer —
running it by hand is mainly for diagnostics.

  --dry-run   Print the payload instead of sending it (exit 0 regardless).
  -h, --help  Show this help.

Exit codes: 0 on success OR any network/HTTP failure (by design — the absence
of a heartbeat is itself the signal ingest acts on, so this never blocks a
cron/launchd slot or prints noise). Exits 1 only when no ingest token is
configured at all (run \`attribut connect\` first).
`;

/**
 * `attribut heartbeat [--dry-run]`. Returns an exit code.
 */
async function runHeartbeat(argv) {
  const args = argv || [];
  if (args.includes('-h') || args.includes('--help')) {
    out(HEARTBEAT_HELP.trimStart());
    return 0;
  }
  const dryRun = args.includes('--dry-run');

  // --dry-run is a payload-construction diagnostic — it works with or without
  // a configured token (nothing is sent), so it's checked before the token
  // gate below.
  if (dryRun) {
    out(JSON.stringify(buildHeartbeatPayload(), null, 2));
    return 0;
  }

  // Device-level signal, not agent-scoped — resolves the claude_code/first
  // token the same way the collector does when no --provider is given.
  const tok = readToken();
  if (!tok) {
    log('no ingest token configured — run `attribut connect` first.');
    return 1;
  }

  const payload = buildHeartbeatPayload();

  try {
    const res = await postJson(endpoint(), payload, { bearer: tok });
    log(`heartbeat sent → ${endpoint()}`);
    // The response may carry a server-pinned CLI version (the fleet
    // rollout/rollback lever) — apply it AFTER the POST so telemetry is never
    // delayed, and inside the same never-fail-loud envelope as the POST.
    await handleUpdateDirective(res.body);
  } catch (e) {
    // Never fail loud here — see FAILURE POLICY above.
    log(`heartbeat failed (non-fatal): ${e.message}`);
  }
  return 0;
}

/**
 * Act on the heartbeat response body: `{ "update_to": "<exact version>" }`
 * triggers the guardrailed self-update (update.cjs decides whether it may
 * act). Anything else — empty body, non-JSON, missing/odd field — is a
 * silent no-op: old servers return nothing and that must stay fine forever.
 * NEVER throws. `autoUpdate` is injectable for tests.
 */
async function handleUpdateDirective(bodyText, { autoUpdate } = {}) {
  let updateTo;
  try {
    const parsed = JSON.parse(bodyText);
    updateTo = parsed && typeof parsed === 'object' ? parsed.update_to : undefined;
  } catch {
    return null;
  }
  if (typeof updateTo !== 'string' || updateTo === '') return null;
  try {
    const run = autoUpdate || require('./update.cjs').maybeAutoUpdate;
    const result = await run({ updateTo });
    // One line for launchd/systemd logs — except the hourly steady state
    // (server pins the version we already run), which isn't worth the noise.
    if (result.reason !== 'already current') {
      log(`auto-update (server pinned ${updateTo}): ${result.reason}`);
    }
    return result;
  } catch (e) {
    log(`auto-update failed (non-fatal): ${e && e.message ? e.message : e}`);
    return null;
  }
}

module.exports = {
  runHeartbeat,
  buildHeartbeatPayload,
  handleUpdateDirective,
  postJson,
  endpoint,
  HEARTBEAT_HELP,
};
