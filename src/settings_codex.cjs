'use strict';

// Read/merge/write helpers for Codex CLI's hook config — ~/.codex/config.toml.
// Sibling to settings.cjs (Claude) and settings_agy.cjs (Antigravity), but a TOML
// text file, so it owns its own read/backup/write + merge logic (no JSON parse).
//
// Codex registers hooks as TOML arrays-of-tables (verified against codex-cli
// 0.139.0 and the official docs). One PostToolUse entry is:
//
//   [[hooks.PostToolUse]]
//   matcher = ".*"
//   [[hooks.PostToolUse.hooks]]
//   type = "command"
//   command = "node '/abs/collector.cjs' --provider openai posttooluse"
//
// We own the entries whose command runs OUR collector; upsert replaces those in
// place and preserves every user-authored hook + all other TOML verbatim (see
// toml.cjs). Codex gates hooks behind a one-time `/hooks` trust prompt — this
// writer does not automate that.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { upsertArrayTables, removeArrayTables } = require('./toml.cjs');

// The two Codex hook events we register, in write order.
const CODEX_EVENTS = ['hooks.PostToolUse', 'hooks.Stop'];

/** Default Codex config path. Override via CODEX_CONFIG_PATH (used in tests). */
function codexConfigPath() {
  return process.env.CODEX_CONFIG_PATH || path.join(os.homedir(), '.codex', 'config.toml');
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Read config.toml as text. Returns '' when absent. */
function readConfig(p = codexConfigPath()) {
  if (!exists(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

const MAX_BACKUPS = 3;

/** Remove all but the newest MAX_BACKUPS `<p>.bak.*` files. Best-effort. */
function pruneBackups(p) {
  try {
    const dir = path.dirname(p);
    const prefix = `${path.basename(p)}.bak.`;
    const backups = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort();
    for (const name of backups.slice(0, -MAX_BACKUPS)) {
      fs.unlinkSync(path.join(dir, name));
    }
  } catch {
    /* nothing to prune / dir gone — fine */
  }
}

/**
 * Back up config.toml to config.toml.bak.<timestamp> (mode 0600). Returns the
 * backup path, or null when there was nothing to back up. Prunes to MAX_BACKUPS.
 */
function backupConfig(p = codexConfigPath()) {
  if (!exists(p)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${p}.bak.${ts}`;
  fs.copyFileSync(p, backup);
  fs.chmodSync(backup, 0o600);
  pruneBackups(p);
  return backup;
}

/**
 * Atomically write `data` to `file` with the given mode: write a sibling temp
 * (same dir → same filesystem, so rename is atomic), chmod it to defeat the umask,
 * then rename over the live file. A crash mid-write can only leave the temp behind,
 * never a truncated real config. Cleans up the temp on failure.
 */
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

/** Write config.toml text (mode 0600 — it sits beside secrets in ~/.codex).
 * Atomic (temp + rename) so a crash mid-write can never truncate the live file. */
function writeConfig(text, p = codexConfigPath()) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, text, 0o600);
}

/**
 * Full install apply: read → backup → upsert each event's array-of-tables →
 * write. `specsByEvent` maps "hooks.PostToolUse"/"hooks.Stop" → [spec]. `isOurs`
 * identifies our prior entries to replace (ownership by collector path in the
 * command text). Returns { backupPath, settingsPath }.
 */
function applyCodexHooks(specsByEvent, isOurs, p = codexConfigPath()) {
  const existing = readConfig(p);
  const backupPath = backupConfig(p);
  let next = existing;
  for (const event of CODEX_EVENTS) {
    const specs = specsByEvent[event] || [];
    next = upsertArrayTables(next, event, specs, isOurs);
  }
  writeConfig(next, p);
  return { backupPath, settingsPath: p };
}

/**
 * Full uninstall apply: read → (backup + write only if our entries were present).
 * Returns { backupPath, settingsPath, removed }. A no-op when nothing matched.
 */
function applyCodexUninstall(isOurs, p = codexConfigPath()) {
  const existing = readConfig(p);
  let next = existing;
  let removed = 0;
  for (const event of CODEX_EVENTS) {
    const res = removeArrayTables(next, event, isOurs);
    next = res.text;
    removed += res.removed;
  }
  if (removed === 0) {
    return { backupPath: null, settingsPath: p, removed: 0 };
  }
  const backupPath = backupConfig(p);
  writeConfig(next, p);
  return { backupPath, settingsPath: p, removed };
}

module.exports = {
  CODEX_EVENTS,
  codexConfigPath,
  readConfig,
  backupConfig,
  writeConfig,
  applyCodexHooks,
  applyCodexUninstall,
};
