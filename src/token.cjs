'use strict';

// ATTRIBUT — ingest bearer token at rest.
//
// The token authenticates the collector's POST to ingest. It is persisted to a
// per-user config file with mode 0600 — NEVER inlined into the hook command in
// settings.json (where it would land world-readable and show up in `ps` /
// /proc/<pid>/cmdline on every hook fire).
//
// Persistence path: ${ATTRIBUT_CONFIG_DIR or ~/.attribut}/token
//   (override the dir via ATTRIBUT_CONFIG_DIR — shared with device.cjs, used in tests).
//
// PER-AGENT TOKENS: `attribut connect` (the device flow) mints a DISTINCT ingest
// token per agent (claude_code, agy, …) — each token is stamped server-side with
// its agent. So the store supports two on-disk shapes, transparently:
//   - a bare token string  — the legacy single-token install (`install --key`),
//     which serves every agent (back-compat); and
//   - a JSON map { "<agent>": "<token>" } — written when a token is persisted for
//     a specific agent. The collector resolves its agent from the hook's
//     --provider flag and reads that agent's token.
// A legacy bare token is migrated into the map (under claude_code) on the first
// per-agent write.
//
// Reads never throw: a missing/unreadable token yields '' and the collector
// surfaces "no token" loudly at POST time, then exits 0 (never blocks a session).

const fs = require('fs');
const path = require('path');
const { configDir } = require('./device.cjs');

function tokenPath() {
  return path.join(configDir(), 'token');
}

// Atomically write `data` to `file` with `mode`: write a sibling temp (same dir →
// same filesystem, so rename is atomic), chmod to defeat the umask, then rename
// over the live file. A crash mid-write can only leave the temp behind, never a
// truncated real token file. Cleans up the temp on failure.
function writeFileAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may not exist — fine */
    }
    throw err;
  }
}

// Parse the on-disk token file into either a bare string or a map. Returns
// { bare } for a legacy single token, { map } for the JSON form, or null when
// absent/empty/unreadable.
function readRaw() {
  let raw;
  try {
    raw = fs.readFileSync(tokenPath(), 'utf8').trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  if (raw[0] === '{') {
    try {
      const map = JSON.parse(raw);
      if (map && typeof map === 'object') return { map };
    } catch {
      /* not JSON after all — fall through to bare */
    }
  }
  return { bare: raw };
}

// Read the persisted token for `agent` (optional). Returns '' on any error.
//   - bare file (legacy single token): returned for ANY agent — it serves all.
//   - map file, agent given: STRICTLY that agent's token, else '' (no cross-agent
//     fallback — a token is agent-scoped server-side; posting one agent's data
//     under another's token would misattribute it).
//   - map file, no agent: the claude_code primary, else the first present.
function readToken(agent) {
  const parsed = readRaw();
  if (!parsed) return '';
  if (parsed.bare != null) return parsed.bare;
  const map = parsed.map;
  if (agent) return typeof map[agent] === 'string' ? map[agent].trim() : '';
  if (typeof map.claude_code === 'string') return map.claude_code.trim();
  const first = Object.values(map).find((v) => typeof v === 'string');
  return first ? first.trim() : '';
}

// Persist a token 0600, creating the config dir if needed. Throws on failure
// (install/connect are explicit user actions and fail loud — see install.cjs).
//   - writeToken(key)         → legacy bare write (single token for all agents).
//   - writeToken(key, agent)  → upsert into the per-agent JSON map (migrating any
//                               existing bare token to claude_code first).
function writeToken(key, agent) {
  const file = tokenPath();
  fs.mkdirSync(configDir(), { recursive: true });
  if (!agent) {
    writeFileAtomic(file, String(key).trim() + '\n', 0o600);
    return file;
  }
  const parsed = readRaw();
  let map = {};
  if (parsed && parsed.map) map = parsed.map;
  else if (parsed && parsed.bare) map = { claude_code: parsed.bare };
  map[agent] = String(key).trim();
  writeFileAtomic(file, JSON.stringify(map) + '\n', 0o600);
  return file;
}

// Delete a stored token. With no agent (or when the file is a bare token), the
// whole file is removed. With an agent on a map file, only that agent's entry is
// dropped (the file is removed once empty). Returns true if anything was removed.
function removeToken(agent) {
  const parsed = readRaw();
  if (!parsed) return false;
  if (agent) {
    // Scoped removal applies only to the per-agent map (written by `connect`).
    // A bare token is a single shared credential we can't attribute to one
    // agent, so a scoped uninstall must leave it for the remaining agents — a
    // full `uninstall` (no agent) is what drops it. Return false = untouched.
    if (!parsed.map) return false;
    if (!(agent in parsed.map)) return false;
    delete parsed.map[agent];
    if (Object.keys(parsed.map).length === 0) {
      fs.unlinkSync(tokenPath());
    } else {
      writeFileAtomic(tokenPath(), JSON.stringify(parsed.map) + '\n', 0o600);
    }
    return true;
  }
  try {
    fs.unlinkSync(tokenPath());
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

module.exports = { tokenPath, readToken, writeToken, removeToken };
