'use strict';

// ATTRIBUT — stable per-device id.
//
// Identifies a discrete machine across all sessions. Generated ONCE as a random
// UUID, persisted to a per-user config file, and reused verbatim on every run.
// This is NOT identity (the user is resolved server-side from the bearer token);
// it only distinguishes devices belonging to the same user.
//
// Persistence path: ${ATTRIBUT_CONFIG_DIR or ~/.attribut}/device_uuid
//   (override the dir via ATTRIBUT_CONFIG_DIR — used in tests).
//
// Failure policy mirrors the collector: this must never break the user's
// session. If the file cannot be read or written, we fall back to an in-memory
// UUID for this run and return it (caller still gets a value; persistence just
// didn't stick). We never throw to the hot path.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function configDir() {
  return process.env.ATTRIBUT_CONFIG_DIR || path.join(os.homedir(), '.attribut');
}

function deviceUuidPath() {
  return path.join(configDir(), 'device_uuid');
}

// A persisted value is valid only if it parses as a canonical UUID — guards
// against a truncated/garbage file silently becoming the device id forever.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read the persisted device uuid, generating + persisting one on first use.
// Returns a string. Never throws.
function getOrCreateDeviceUuid() {
  const file = deviceUuidPath();

  // Read existing (one syscall; ENOENT/unreadable → (re)generate).
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (UUID_RE.test(existing)) return existing;
    // else fall through and regenerate (corrupt/legacy content)
  } catch {
    // absent or unreadable — fall through to (re)generate
  }

  const uuid = crypto.randomUUID();

  // Persist best-effort. A write failure is logged to stderr but does not block.
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(file, uuid + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    process.stderr.write(
      `[attribut] could not persist device_uuid to ${file}: ${err.message}\n`
    );
  }

  return uuid;
}

module.exports = {
  configDir,
  deviceUuidPath,
  getOrCreateDeviceUuid,
};
