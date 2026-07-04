'use strict';

// ATTRIBUT — small local state file (currently: last_hook_invocation_at).
//
// Kept separate from device_uuid/token/machine_id so a corrupt or racing write
// to this file can never risk those. The collector touches this on EVERY hook
// fire, so the write path must be cheap and must never throw/block the hook —
// same failure policy as the collector itself (see collector.cjs's header).
//
// Persistence path: ${ATTRIBUT_CONFIG_DIR or ~/.attribut}/state.json

const fs = require('fs');
const path = require('path');
const { configDir } = require('./device.cjs');

function statePath() {
  return path.join(configDir(), 'state.json');
}

// Read the state file. Returns {} on any error (absent, corrupt, not an
// object) — never throws.
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Atomically write `data` to `file` with `mode`: sibling temp (same filesystem →
// atomic rename), chmod to defeat the umask, then rename over the live file. A
// crash mid-write can only leave the temp behind, never a truncated real file.
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

function writeState(state) {
  fs.mkdirSync(configDir(), { recursive: true });
  writeFileAtomic(statePath(), JSON.stringify(state) + '\n', 0o600);
}

// Record "a hook fired just now". Called on every collector invocation —
// best-effort: a write failure here must never affect the hook it's riding
// along with.
function touchHookInvocation(now = new Date()) {
  try {
    const state = readState();
    state.last_hook_invocation_at = now.toISOString();
    writeState(state);
  } catch {
    /* best-effort — never block the hook */
  }
}

// The ISO timestamp of the last hook invocation, or null if none recorded yet.
function readLastHookInvocationAt() {
  const v = readState().last_hook_invocation_at;
  return typeof v === 'string' ? v : null;
}

module.exports = { statePath, readState, writeState, touchHookInvocation, readLastHookInvocationAt };
