'use strict';

// Read/merge/write helpers for Cursor's agent-hooks config — ~/.cursor/hooks.json.
// Sibling to settings.cjs (Claude), settings_agy.cjs (Antigravity), and
// settings_codex.cjs (Codex), but Cursor's on-disk shape is its own, so it owns
// its merge/remove logic. We reuse settings.cjs's generic JSON read/backup/write
// fs helpers (they take an explicit path).
//
// Cursor's hooks.json (verified schema, Cursor 1.7+/3.9.x) is a versioned object
// whose `hooks` maps an EVENT name to an array of hook specs:
//
//   { "version": 1,
//     "hooks": {
//       "sessionEnd":          [ { "command": "…", "type": "command" } ],
//       "stop":                [ { "command": "…", "type": "command" } ],
//       "afterShellExecution": [ { "command": "…", "type": "command" } ] } }
//
// We OWN the entries whose `command` runs our collector; upsert replaces those in
// place per event and preserves every user-authored hook + the `version` + all
// other events verbatim. `afterShellExecution` exists only so the collector can
// capture a `git commit` SHA into the per-session sidecar (folded in at
// sessionEnd) — it never posts. Cursor gates hooks behind a one-time trust prompt;
// this writer does not automate that.

const os = require('os');
const path = require('path');

const { readSettings, backupSettings, writeSettings } = require('./settings.cjs');

// The Cursor hook events we register, in write order.
const CURSOR_EVENTS = ['sessionEnd', 'stop', 'afterShellExecution'];

/** Default Cursor hooks.json path. Override via CURSOR_HOOKS_PATH (used in tests). */
function cursorHooksPath() {
  return process.env.CURSOR_HOOKS_PATH || path.join(os.homedir(), '.cursor', 'hooks.json');
}

// Normalize an existing hooks.json into { version, hooks:{} } without mutating it.
function normalize(existing) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const hooks = base.hooks && typeof base.hooks === 'object' && !Array.isArray(base.hooks) ? base.hooks : {};
  return { version: typeof base.version === 'number' ? base.version : 1, base, hooks };
}

/**
 * Merge our per-event specs into an existing hooks.json WITHOUT mutating the input.
 * For each event, drops our prior entries (ownership by `isOurs(command)`) and
 * appends the new ones; preserves user hooks, `version`, and untouched events.
 * `specsByEvent` maps event → [{ command, type }]. Returns a NEW object. Pure.
 */
function mergeCursorHooks(existing, specsByEvent, isOurs) {
  const { base, hooks } = normalize(existing);
  const nextHooks = { ...hooks };
  for (const event of CURSOR_EVENTS) {
    const prior = Array.isArray(nextHooks[event]) ? nextHooks[event] : [];
    const kept = prior.filter(
      (h) => !(h && typeof h === 'object' && isOurs(h.command))
    );
    const ours = specsByEvent[event] || [];
    const combined = [...kept, ...ours];
    if (combined.length) nextHooks[event] = combined;
    else delete nextHooks[event];
  }
  return { ...base, version: typeof base.version === 'number' ? base.version : 1, hooks: nextHooks };
}

/**
 * Remove our entries from every event. Returns { settings, removed } (removed =
 * count of entries dropped). User hooks + version preserved. Pure — no I/O.
 */
function removeCursorHooks(existing, isOurs) {
  const { base, hooks } = normalize(existing);
  const nextHooks = { ...hooks };
  let removed = 0;
  for (const event of Object.keys(nextHooks)) {
    const prior = Array.isArray(nextHooks[event]) ? nextHooks[event] : [];
    const kept = prior.filter((h) => {
      const ours = h && typeof h === 'object' && isOurs(h.command);
      if (ours) removed += 1;
      return !ours;
    });
    if (kept.length) nextHooks[event] = kept;
    else delete nextHooks[event];
  }
  return { settings: { ...base, version: typeof base.version === 'number' ? base.version : 1, hooks: nextHooks }, removed };
}

/**
 * Full install apply: read → backup → merge → write. Returns
 * { backupPath, settingsPath }.
 */
function applyCursorHooks(specsByEvent, isOurs, p = cursorHooksPath()) {
  const existing = readSettings(p);
  const backupPath = backupSettings(p);
  const merged = mergeCursorHooks(existing, specsByEvent, isOurs);
  writeSettings(merged, p);
  return { backupPath, settingsPath: p };
}

/**
 * Full uninstall apply: read → (backup + write only if our entries were present).
 * Returns { backupPath, settingsPath, removed }. A no-op when nothing matched.
 */
function applyCursorUninstall(isOurs, p = cursorHooksPath()) {
  const existing = readSettings(p);
  const { settings, removed } = removeCursorHooks(existing, isOurs);
  if (removed === 0) return { backupPath: null, settingsPath: p, removed: 0 };
  const backupPath = backupSettings(p);
  writeSettings(settings, p);
  return { backupPath, settingsPath: p, removed };
}

module.exports = {
  CURSOR_EVENTS,
  cursorHooksPath,
  mergeCursorHooks,
  removeCursorHooks,
  applyCursorHooks,
  applyCursorUninstall,
};
