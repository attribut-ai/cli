'use strict';

// Read/merge/write helpers for Google Antigravity's hook config —
// ~/.gemini/config/hooks.json. Sibling to settings.cjs (Claude), but a DIFFERENT
// on-disk shape, so it owns its own merge/remove logic.
//
// agy's hooks.json is a MAP of named-hook → spec, where each spec is itself
// keyed by event name → array of groups → handlers (verified against agy 1.0.8;
// the loader logs "N named hooks, M total handlers"):
//
//   { "<hook-name>": { "<Event>": [ { "matcher": "*",
//       "hooks": [ { "type": "command", "command": "…", "timeout": 30 } ] } ] } }
//
// Because we own a whole NAMED entry (default "attribut"), idempotency is trivial:
// install replaces our named key in place; uninstall deletes it. Other named
// hooks (user's / other tools') are preserved verbatim. We reuse settings.cjs's
// generic read/backup/write fs helpers (they take an explicit path).

const os = require('os');
const path = require('path');

const {
  readSettings,
  backupSettings,
  writeSettings,
} = require('./settings.cjs');

// The named-hook key we own in hooks.json. Stable so re-install/uninstall target
// the same entry.
const AGY_HOOK_NAME = 'attribut';

/** Default agy hooks.json path. Override via AGY_HOOKS_PATH (used in tests). */
function agyHooksPath() {
  return (
    process.env.AGY_HOOKS_PATH ||
    path.join(os.homedir(), '.gemini', 'config', 'hooks.json')
  );
}

/**
 * Merge our named hook spec into an existing hooks.json map WITHOUT mutating the
 * input. Replaces our named entry in place (idempotent); preserves every other
 * named hook. Returns a NEW object. Pure — no I/O.
 */
function mergeAgyHook(existing, spec, name = AGY_HOOK_NAME) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  return { ...base, [name]: spec };
}

/**
 * Remove our named hook from an existing hooks.json map. Returns
 * { settings, removed } where `removed` is 1 if our entry was present, else 0.
 * Other named hooks are preserved. Pure — no I/O.
 */
function removeAgyHook(existing, name = AGY_HOOK_NAME) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  if (!(name in base)) return { settings: base, removed: 0 };
  const next = { ...base };
  delete next[name];
  return { settings: next, removed: 1 };
}

/**
 * Full install apply: read → backup → merge → write. Returns
 * { backupPath, settingsPath, merged }.
 */
function applyAgyHook(spec, p = agyHooksPath(), name = AGY_HOOK_NAME) {
  const existing = readSettings(p);
  const backupPath = backupSettings(p);
  const merged = mergeAgyHook(existing, spec, name);
  writeSettings(merged, p);
  return { backupPath, settingsPath: p, merged };
}

/**
 * Full uninstall apply: read → (backup + write only if our entry was present).
 * Returns { backupPath, settingsPath, removed, settings }. A no-op (no backup,
 * no rewrite) when our entry is absent or the file is missing.
 */
function applyAgyUninstall(p = agyHooksPath(), name = AGY_HOOK_NAME) {
  const existing = readSettings(p);
  const { settings, removed } = removeAgyHook(existing, name);
  if (removed === 0) {
    return { backupPath: null, settingsPath: p, removed: 0, settings: existing };
  }
  const backupPath = backupSettings(p);
  writeSettings(settings, p);
  return { backupPath, settingsPath: p, removed, settings };
}

module.exports = {
  AGY_HOOK_NAME,
  agyHooksPath,
  mergeAgyHook,
  removeAgyHook,
  applyAgyHook,
  applyAgyUninstall,
};
