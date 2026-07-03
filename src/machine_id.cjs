'use strict';

// ATTRIBUT — stable, hardware-derived machine id.
//
// Distinct from device.cjs's device_uuid: device_uuid is a random id ATTRIBUT
// itself mints and owns, so it resets if ~/.attribut is ever wiped. machine_id
// ties back to an id the OS itself hands out, so the heartbeat can tell "same
// physical machine, config got wiped" apart from "genuinely new device" —
// useful for server-side gap detection. We never send the raw platform id,
// only its sha256 hash.
//
// Resolution order (never throws; always returns a string):
//   1) cached value in ${configDir}/machine_id — stable across runs even if
//      the underlying hardware id later becomes unreadable.
//   2) the OS-native hardware id, sha256-hashed:
//        - Linux:   /etc/machine-id
//        - macOS:   `ioreg -rd1 -c IOPlatformExpertDevice` IOPlatformUUID
//        - Windows: HKLM\SOFTWARE\Microsoft\Cryptography MachineGuid
//   3) a generated random UUID (persisted, same fallback shape as
//      device_uuid) when the hardware id can't be read — sandboxes,
//      containers, and platforms we don't special-case all land here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { configDir } = require('./device.cjs');

function machineIdPath() {
  return path.join(configDir(), 'machine_id');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function readCached() {
  try {
    const v = fs.readFileSync(machineIdPath(), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

function persist(id) {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(machineIdPath(), id + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[attribut] could not persist machine_id to ${machineIdPath()}: ${err.message}\n`);
  }
}

// Read the OS-native hardware id, RAW and unhashed (callers must hash before
// sending anywhere). Returns null on any failure — missing file, no ioreg/reg
// binary, sandboxed VM, unrecognized platform. Never throws.
function readRawHardwareId(platform = process.platform) {
  try {
    if (platform === 'linux') {
      const v = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      return v || null;
    }
    if (platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        timeout: 2000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      return m ? m[1] : null;
    }
    if (platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      return m ? m[1] : null;
    }
    return null; // unrecognized platform — fall through to the UUID fallback
  } catch {
    return null;
  }
}

// Get (or create + persist) this machine's id. `platform` is injectable for
// tests; production callers always take the default (process.platform).
function getOrCreateMachineId(platform = process.platform) {
  const cached = readCached();
  if (cached) return cached;

  const raw = readRawHardwareId(platform);
  const id = raw ? sha256Hex(raw) : crypto.randomUUID();
  persist(id);
  return id;
}

module.exports = {
  machineIdPath,
  sha256Hex,
  readRawHardwareId,
  getOrCreateMachineId,
};
