#!/usr/bin/env node
'use strict';

// ATTRIBUT collector — the DUMB allowlist telemetry hook.
//
// Runs as a Claude Code hook (SessionEnd / Stop / PostToolUse) or offline.
// Responsibilities, and ONLY these:
//   1. Read the hook JSON from stdin (session_id, transcript_path, cwd,
//      hook_event_name, reason, ...).
//   2. Parse the local transcript into the allowlist `payload` (parser does the
//      extraction; it NEVER reads prompt/response/code/diff text).
//   3. Wrap it in the frozen envelope, tag provider=anthropic/tool=claude_code,
//      and validate against the contract schema.
//   4. gzip, attach a Bearer token, POST to `${INGEST_BASE}/v1/hook`.
//
// NO interpretation here (pricing, attribution, identity, aggregation that can't
// be re-derived) — that is ingest_worker, server-side.
//
// FAILURE POLICY: a telemetry collector must NEVER block or break the user's
// Claude Code session. On ANY error (bad stdin, unreadable transcript, network
// failure, validation failure) we log to stderr and exit 0. The one thing we do
// loudly is log — we never silently swallow.
//
// Endpoint: env INGEST_BASE (default below) → `${INGEST_BASE}/v1/hook`. Must be
//   https unless ATTRIBUT_ALLOW_INSECURE=1 (localhost test escape hatch).
//   Legacy override: ATTRIBUT_COLLECTOR_URL sets the full URL directly.
// Auth: bearer token read from the 0600 token file (token.cjs) — sent as
//   `Authorization: Bearer <token>`. Written by `attribut install`.

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const parser = require('./parser/claude_code.cjs');
const agyParser = require('./parser/antigravity_cli.cjs');
const agyTokens = require('./parser/antigravity_tokens.cjs');
const codexParser = require('./parser/codex.cjs');
const cursorParser = require('./parser/cursor.cjs');
const { buildAndValidate } = require('./envelope.cjs');
const { getOrCreateDeviceUuid, configDir } = require('./device.cjs');
const { readToken } = require('./token.cjs');
const { touchHookInvocation } = require('./state.cjs');
const { version: PKG_VERSION } = require('../package.json');
const { GIT_SHA } = require('./version.cjs');

const DEFAULT_INGEST_BASE = 'https://ingest.attribut.ai';

function endpoint() {
  // Full-URL override wins (used by tests). Otherwise INGEST_BASE + path.
  if (process.env.ATTRIBUT_COLLECTOR_URL) return process.env.ATTRIBUT_COLLECTOR_URL;
  const base = (process.env.INGEST_BASE || DEFAULT_INGEST_BASE).replace(/\/+$/, '');
  return `${base}/v1/hook`;
}

// The bearer token for `agent`, read from its 0600 file (written by `attribut
// install` / `attribut connect`). `attribut connect` stores a DISTINCT token per
// agent; we resolve the right one from the hook's provider. A legacy single
// (bare) token serves any agent — see token.cjs.
function token(agent) {
  return readToken(agent);
}

// Map the collector's provider (the hook's --provider flag) to the device-flow
// agent slug the token store is keyed on. anthropic → claude_code (the default),
// antigravity → agy; anything else falls back to the provider string itself.
function agentForProvider(provider) {
  if (provider === 'anthropic') return 'claude_code';
  if (provider === 'antigravity') return 'agy';
  if (provider === 'openai') return 'codex';
  if (provider === 'cursor') return 'cursor';
  return provider || 'claude_code';
}

function log(msg) {
  process.stderr.write(`[attribut] ${msg}\n`);
}

// Read all of stdin into a string.
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// Map a Claude Code hook_event_name (or explicit arg) to the contract _trigger.
function triggerFor(hookEventName, explicit) {
  if (explicit) return explicit;
  switch (hookEventName) {
    case 'SessionEnd':
      return 'sessionend';
    case 'Stop':
      return 'stop';
    case 'PostToolUse':
      return 'posttooluse';
    default:
      return null;
  }
}

// gzip + POST the envelope. Resolves on 2xx, rejects otherwise. The caller is
// responsible for turning a rejection into a quiet (exit-0) failure.
function postEnvelope(envelope, agent) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(endpoint());
    } catch {
      return reject(new Error(`ingest endpoint is not a valid URL: ${endpoint()}`));
    }
    // Never send the token (or payload) over cleartext http. The only escape
    // hatch is an explicit ATTRIBUT_ALLOW_INSECURE=1 for localhost test servers.
    const allowInsecure = process.env.ATTRIBUT_ALLOW_INSECURE === '1';
    if (url.protocol !== 'https:' && !allowInsecure) {
      return reject(
        new Error(
          `refusing to POST to non-https endpoint ${url.href} ` +
            '(set ATTRIBUT_ALLOW_INSECURE=1 only for local testing).'
        )
      );
    }
    const tok = token(agent);
    if (!tok) {
      return reject(
        new Error(
          'no ingest token — cannot authenticate the POST. ' +
            'Re-run `attribut install --key=<token>` to persist one.'
        )
      );
    }

    const json = Buffer.from(JSON.stringify(envelope), 'utf8');
    zlib.gzip(json, { level: zlib.constants.Z_BEST_SPEED }, (gzErr, body) => {
      if (gzErr) return reject(new Error(`gzip failed: ${gzErr.message}`));

      const lib = url.protocol === 'http:' ? http : https;
      const req = lib.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': body.length,
            'User-Agent': `attribut-cli/${PKG_VERSION}`,
            Authorization: `Bearer ${tok}`,
          },
          timeout: 10000,
        },
        (res) => {
          let resp = '';
          res.on('data', (c) => {
            resp += c;
          });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, body: resp });
            } else {
              reject(
                new Error(`ingest returned HTTP ${res.statusCode}: ${resp.slice(0, 300)}`)
              );
            }
          });
        }
      );
      req.on('error', (err) => reject(new Error(`POST to ${url.href} failed: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy(new Error('request timed out after 10s'));
      });
      req.write(body);
      req.end();
    });
  });
}

// Stamp cloud session id from env. In a cloud VM, Claude Code sets
// CLAUDE_CODE_REMOTE_SESSION_ID — the `session_01…` id that also appears in the
// auto-generated PR body, reconciling our local UUID with the PR/identity path.
function cloudContext() {
  const rsid = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || null;
  return { remoteSessionId: rsid, isCloud: !!rsid };
}

// --- PostToolUse cursor gate -------------------------------------------------
//
// PostToolUse(Bash) fires after EVERY Bash command. A full transcript re-parse +
// POST on each one is O(N²) over a long session. But we must not miss the rare
// command that matters: a `git commit` (the per-commit attribution signal). So we
// persist a per-session byte cursor and, on each posttooluse, read ONLY the bytes
// appended since last fire. If that tail contains no new commit line (the same
// `[branch sha]` signal the parser keys on — parser.SHA_RE), we advance the
// cursor and skip the parse+POST entirely. SessionEnd/Stop always full-parse, so
// anything skipped here is still reconciled at session end.

function cursorPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(configDir(), 'cursor', safe);
}

function readCursor(sessionId) {
  try {
    const n = parseInt(fs.readFileSync(cursorPath(sessionId), 'utf8').trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursor(sessionId, offset) {
  try {
    const file = cursorPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(offset) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Cursor is an optimization, not correctness — a write failure just means the
    // next posttooluse re-reads more of the tail. Never block.
  }
}

function clearCursor(sessionId) {
  try {
    fs.unlinkSync(cursorPath(sessionId));
  } catch {
    /* absent — fine */
  }
}

// Returns true if the posttooluse can SKIP the full parse+POST (no new commit in
// the appended tail). Advances the cursor as a side effect. On ANY error, returns
// false (do the full work) — we never skip in a way that could drop a commit.
function posttooluseCanSkip(hook) {
  const tp = hook.transcript_path;
  if (!tp) return false;
  let fd;
  try {
    const abs = parser.expandHome(tp);
    const size = fs.statSync(abs).size;
    let offset = readCursor(hook.session_id);
    if (offset > size) offset = 0; // transcript shrank/rotated → re-read from start
    if (size <= offset) {
      // Nothing new appended since last fire — nothing could have changed.
      writeCursor(hook.session_id, size);
      return true;
    }
    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buf, 0, len, offset);
    const tail = buf.toString('utf8');
    writeCursor(hook.session_id, size);
    // Same trigger the parser uses: a `[branch sha]` commit line in the new bytes.
    parser.SHA_RE.lastIndex = 0;
    return !parser.SHA_RE.test(tail);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// --- Commit-SHA capture (format-independent) ---------------------------------
//
// The parser can only learn a commit SHA by scraping git's DEFAULT `[branch sha]`
// summary out of a Bash stdout. That line is suppressed by `git commit -q`
// (and absent for GUI/editor commits), so any quiet commit produces NO SHA and
// the session never links to its PR. Here, on the PostToolUse(Bash) hook, when
// the command is a real `git commit` we read the SHA straight from git's plumbing
// (`git rev-parse HEAD`) in the directory the command ran in — immune to -q,
// heredoc messages, and --amend. Captured SHAs are persisted to a per-session
// sidecar and merged into payload.commitSHA at envelope build (so SessionEnd/Stop
// also carry them). Correctness over coverage: when the commit directory can't be
// determined unambiguously we DON'T guess — we skip and let the parser's
// (non-quiet) bracket path remain the fallback.

function commitSidecarPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(configDir(), 'commits', safe);
}

function readCapturedShas(sessionId) {
  try {
    return fs
      .readFileSync(commitSidecarPath(sessionId), 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Append a SHA to the session sidecar. Returns true only if it was NOT already
// recorded (a genuinely new commit) — the caller uses that to force a POST.
function appendCapturedSha(sessionId, sha) {
  try {
    if (readCapturedShas(sessionId).includes(sha)) return false;
    const file = commitSidecarPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, sha + '\n', { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function clearCapturedShas(sessionId) {
  try {
    fs.unlinkSync(commitSidecarPath(sessionId));
  } catch {
    /* absent — fine */
  }
}

// True if the shell command is a real `git commit` invocation (the SHA-producing
// kind). Matches `git … commit` within a single statement (so `git add x && git
// commit` matches on the second clause), rejects the `commit-graph`/`commit-tree`
// plumbing subcommands, and excludes the non-mutating --dry-run / help forms.
function isGitCommitCommand(command) {
  if (typeof command !== 'string') return false;
  if (!/\bgit\b[^|&;\n]*?\bcommit\b(?![\w-])/.test(command)) return false;
  if (/\bcommit\b[^|&;\n]*--dry-run/.test(command)) return false;
  if (/\bcommit\b[^|&;\n]*(?:--help|\s-h\b)/.test(command)) return false;
  return true;
}

function unquote(tok) {
  const m = /^(['"])([\s\S]*)\1$/.exec(tok || '');
  return m ? m[2] : tok;
}

// Resolve a (possibly ~/relative) dir against the hook cwd.
function resolveDir(dir, baseCwd) {
  if (!dir) return baseCwd || null;
  let d = dir;
  if (d === '~' || d.startsWith('~/')) d = path.join(os.homedir(), d.slice(1));
  if (!path.isAbsolute(d) && baseCwd) d = path.resolve(baseCwd, d);
  return d;
}

// The directory a `git commit` command actually ran in: an explicit `git -C <dir>`,
// else a single leading `cd <dir> && …`, else the hook cwd. Returns null when the
// command cd's in a way we can't pin down (multiple cds) — caller then skips
// capture rather than attribute the wrong repo's HEAD.
function commitDirFromCommand(command, baseCwd) {
  if (typeof command !== 'string') return baseCwd || null;
  const cflag = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command);
  if (cflag) return resolveDir(unquote(cflag[1]), baseCwd);
  const cds = [...command.matchAll(/(?:^|&&|;|\n)\s*cd\s+("[^"]+"|'[^']+'|\S+)/g)];
  if (cds.length === 1) return resolveDir(unquote(cds[0][1]), baseCwd);
  if (cds.length > 1) return null; // ambiguous — don't guess
  return baseCwd || null;
}

// Read HEAD via git plumbing in `dir`. Returns a full 40-hex SHA or null.
function revParseHead(dir) {
  if (!dir) return null;
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

// The invoked shell command string from a hook's tool_input. Claude puts it at
// tool_input.command (a string); Codex's exec tool may carry it at .command/.cmd
// as a string OR an argv array (["git","commit",…]). Returns null when absent.
function commandFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const c = toolInput.command != null ? toolInput.command : toolInput.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length && c.every((x) => typeof x === 'string')) return c.join(' ');
  return null;
}

// On a PostToolUse shell `git commit`, capture HEAD into the session sidecar.
// Returns true iff a NEW SHA was recorded (so the caller forces the parse+POST
// instead of skipping). Never throws — capture must never break the session.
//
// `shellTools` bounds the guess to shell/exec tools (an optimization). Claude's
// shell tool is `Bash` (the default). Codex names its exec tool differently
// (exec_command / local_shell / …) and may omit tool_name entirely, so callers
// pass `shellTools: null` to try regardless — isGitCommitCommand still filters
// out anything that isn't a real `git commit`.
function captureCommitSha(hook, { shellTools = ['Bash'] } = {}) {
  try {
    if (shellTools && hook.tool_name && !shellTools.includes(hook.tool_name)) return false;
    const command = commandFromToolInput(hook.tool_input);
    if (!isGitCommitCommand(command)) return false;
    const sha = revParseHead(commitDirFromCommand(command, hook.cwd));
    if (!sha) return false;
    return appendCapturedSha(hook.session_id, sha);
  } catch {
    return false;
  }
}

// Merge plumbing-captured SHAs into the parser's bracket-derived list, deduping
// by prefix-containment so the same commit isn't listed as both its short and
// full form (parser yields git's abbreviated SHA; rev-parse yields the full 40).
function mergeShas(parserShas, capturedShas) {
  const out = [...(parserShas || [])];
  for (const sha of capturedShas || []) {
    const dup = out.some(
      (e) => e === sha || (e.length !== sha.length && (e.startsWith(sha) || sha.startsWith(e)))
    );
    if (!dup) out.push(sha);
  }
  return out;
}

// Build the envelope from a hook object. Pure-ish: parses the transcript and
// assembles + validates the envelope. THROWS on parse/validation failure (the
// caller decides whether to swallow).
function buildEnvelopeFromHook(hook, { trigger, source }) {
  const tp = hook.transcript_path;
  if (!tp) {
    throw new Error(`hook has no transcript_path (event=${hook.hook_event_name}).`);
  }
  const payload = parser.parseClaudeCodeTranscript(tp, {
    sessionId: hook.session_id,
    repo: hook.cwd, // hook cwd preferred for CLI; parser keeps its own if absent
    device_uuid: getOrCreateDeviceUuid(), // stable per-machine id (collector-side)
  });

  // Fold in any plumbing-captured commit SHAs (the -q / GUI-commit cases the
  // transcript-scraping parser can't see). Cumulative per session, so every POST
  // — including SessionEnd/Stop — carries the full set.
  const captured = readCapturedShas(hook.session_id);
  if (captured.length) payload.commitSHA = mergeShas(payload.commitSHA, captured);

  const { remoteSessionId, isCloud } = cloudContext();
  // Claude-specific transport context lands in the `claude_code` sub-struct.
  // Cap both — they come from env / the hook and must respect the schema bounds.
  payload.claude_code.remoteSessionId =
    remoteSessionId != null ? String(remoteSessionId).slice(0, 128) : null;
  payload.claude_code.reason = hook.reason != null ? String(hook.reason).slice(0, 128) : null;

  // ended_at fallback: hook fire time is the most precise end when the
  // transcript lacked timestamps. duration stays null in that case.
  if (!payload.ended_at) payload.ended_at = new Date().toISOString();

  return buildAndValidate(payload, {
    _trigger: trigger,
    _source: source || 'cli',
    _isCloud: isCloud,
    _cli_version: GIT_SHA,
  });
}

// Build the envelope from a Google Antigravity hook object. agy's hook stdin is
// shaped differently from Claude's: { conversationId, transcriptPath, toolCall,
// workspacePaths, artifactDirectoryPath, stepIdx, error }. Token usage is NOT in
// the hook or the transcript — we read it (fail-safe, numbers-only) from the
// per-conversation SQLite store and inject usage_raw. THROWS on parse/validation
// failure (the caller swallows on the hot path).
function buildAntigravityEnvelopeFromHook(hook, { trigger, source }) {
  const tp = hook.transcriptPath;
  if (!tp) {
    throw new Error('antigravity hook has no transcriptPath.');
  }
  const conversationId = hook.conversationId || null;
  const repo =
    Array.isArray(hook.workspacePaths) && hook.workspacePaths.length
      ? hook.workspacePaths[0]
      : null;

  const payload = agyParser.parseAntigravityTranscript(tp, {
    sessionId: conversationId,
    repo,
    device_uuid: getOrCreateDeviceUuid(),
  });

  // Inject raw token usage + the resolved model id from the SQLite store (null on
  // any failure — token/model capture must never break the rest). The server maps
  // usage_raw → input/output and prices by model.
  if (conversationId) {
    payload.antigravity.usage_raw = agyTokens.readUsageRaw(conversationId);
    if (!payload.model) payload.model = agyTokens.readModel(conversationId);
    // The generated session title (agy's content-derived summary; readTitle caps
    // to the schema's 200) — same allowlisted exception as Claude's ai-title.
    if (!payload.title) payload.title = agyTokens.readTitle(conversationId);
    // Nest this session's subagents (agy runs each as a separate conversation;
    // their standalone posts are suppressed in main()). Folds in their tokens
    // server-side. tp is the parent transcript.
    payload.antigravity.subagents = agyParser.buildSubagents(tp, conversationId);
  } else {
    payload.antigravity.usage_raw = null;
  }

  if (!payload.ended_at) payload.ended_at = new Date().toISOString();

  return buildAndValidate(payload, {
    _trigger: trigger,
    _source: source || 'cli',
    _provider: 'google',
    _tool: 'antigravity',
    _cli_version: GIT_SHA,
  });
}

// Build the envelope from a Codex hook object. Codex's hook stdin is field-for-
// field Claude-compatible ({ session_id, transcript_path, cwd, hook_event_name,
// tool_name, tool_input, tool_response, reason, model, turn_id }). Unlike Claude,
// the session record is a ~/.codex/sessions rollout .jsonl, resolved from the
// hook's transcript_path (else globbed by session_id). Token usage lives IN the
// rollout (cumulative), so the parser fills tokens directly. THROWS on parse/
// validation failure (the caller swallows on the hot path).
function buildCodexEnvelopeFromHook(hook, { trigger, source }) {
  const rolloutPath = codexParser.resolveRolloutPath({
    transcriptPath: hook.transcript_path,
    sessionId: hook.session_id,
  });

  const payload = codexParser.parseCodexRollout(rolloutPath, {
    sessionId: hook.session_id,
    repo: hook.cwd, // hook cwd preferred for CLI; parser keeps its own if absent
    device_uuid: getOrCreateDeviceUuid(),
  });

  // Fold in any plumbing-captured commit SHAs (the -q / GUI-commit cases the
  // rollout-scraping parser can't see). Cumulative per session, so every POST
  // carries the full set.
  const captured = readCapturedShas(hook.session_id);
  if (captured.length) payload.commitSHA = mergeShas(payload.commitSHA, captured);

  const { remoteSessionId, isCloud } = cloudContext();
  payload.codex.remoteSessionId =
    remoteSessionId != null ? String(remoteSessionId).slice(0, 128) : null;
  payload.codex.reason = hook.reason != null ? String(hook.reason).slice(0, 128) : null;

  if (!payload.ended_at) payload.ended_at = new Date().toISOString();

  return buildAndValidate(payload, {
    _trigger: trigger,
    _source: source || 'cli',
    _provider: 'openai',
    _tool: 'codex',
    _isCloud: isCloud,
    _cli_version: GIT_SHA,
  });
}

// A workspace root may arrive as a plain path or a file:// URI (Cursor stores
// URIs internally); normalize to a filesystem path. Returns null when absent.
function normalizeWorkspacePath(p) {
  if (typeof p !== 'string' || !p) return null;
  if (p.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(p).pathname);
    } catch {
      return p.slice('file://'.length);
    }
  }
  return p;
}

// The first workspace root from a Cursor hook (falls back to cwd). Normalized.
function firstWorkspaceRoot(hook) {
  const roots = hook && Array.isArray(hook.workspace_roots) ? hook.workspace_roots : null;
  return normalizeWorkspacePath(roots && roots.length ? roots[0] : hook && hook.cwd);
}

// Current git branch in `dir` via plumbing (labels the branch this session worked
// on — it does NOT fabricate a commit link). Returns the branch name or null.
function gitCurrentBranch(dir) {
  if (!dir) return null;
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

// Build the envelope from a Cursor hook object. Cursor's hook stdin carries
// { conversation_id, model, user_email, cursor_version, workspace_roots[],
// transcript_path, duration_ms, reason, hook_event_name }. The rich per-session
// signal is NOT in the hook/transcript — the parser reads it (fail-safe,
// numbers-only) from Cursor's state.vscdb keyed by conversation_id, using the
// transcript only for tool-use names. THROWS on validation failure (caller
// swallows on the hot path).
function buildCursorEnvelopeFromHook(hook, { trigger, source }) {
  const composerId = cursorParser.resolveComposerId({
    conversationId: hook.conversation_id,
    transcriptPath: hook.transcript_path,
  });
  const workspaceRoot = firstWorkspaceRoot(hook);

  const payload = cursorParser.parseCursorSession({
    composerId,
    transcriptPath: hook.transcript_path,
    repo: workspaceRoot,
    branch: gitCurrentBranch(workspaceRoot),
    device_uuid: getOrCreateDeviceUuid(),
    user_email: hook.user_email,
    cursor_version: hook.cursor_version,
    reason: hook.reason,
  });

  // Fold in any plumbing-captured commit SHAs (keyed by the composer/session id).
  const captured = readCapturedShas(composerId);
  if (captured.length) payload.commitSHA = mergeShas(payload.commitSHA, captured);

  // ended_at / duration fallbacks: composerData timestamps are preferred; the hook
  // fire time / hook duration fill in when the DB row was unavailable.
  if (!payload.ended_at) payload.ended_at = new Date().toISOString();
  if (payload.duration_ms == null && typeof hook.duration_ms === 'number') {
    payload.duration_ms = Math.max(0, Math.trunc(hook.duration_ms));
  }

  return buildAndValidate(payload, {
    _trigger: trigger,
    _source: source || 'cli',
    _provider: 'cursor',
    _tool: 'cursor',
    _cli_version: GIT_SHA,
  });
}

// The hook triggers the collector understands when invoked on the hot path.
const RUNTIME_TRIGGERS = ['sessionend', 'stop', 'posttooluse'];

function printHelp() {
  process.stdout.write(
    `
attribut — Claude Code capture collector for ATTRIBUT

Usage:
  attribut <command> [options]

Commands:
  connect      Connect this device via the browser (device flow): pick which
               tools to capture, approve in a browser, hooks install themselves.
                 attribut connect [--agents=claude_code,agy] [--no-browser]
  install      Register the capture hook in ~/.claude/settings.json (manual token)
                 attribut install --key=<token> [--endpoint=<origin>]
  uninstall    Remove the capture hook (and any legacy collector files)
  heartbeat    Send a one-off liveness signal (installed hourly by connect)
                 attribut heartbeat [--dry-run]
  audit        Prove metadata-only on your own data: validate every payload
               against the frozen contract and scan it for content leaks.
                 attribut audit                 sweep ALL local sessions (summary)
                 attribut audit <transcript>    full payload for one session
  help         Show this help

As a Claude Code hook the collector is invoked with a trigger
(${RUNTIME_TRIGGERS.join(' | ')}) and reads the hook JSON on stdin.

Offline:
  attribut --parse <transcript.jsonl>   Print the parsed payload (no POST)
  <hook-json> | attribut --dry-run      Print the envelope (no POST)
`.trimStart()
  );
}

async function main() {
  const argv = process.argv.slice(2);

  // Management subcommands run BEFORE any stdin/hook handling.
  const sub = argv[0];
  if (sub === 'install') return require('./install.cjs').runInstall(argv.slice(1));
  if (sub === 'uninstall') return require('./install.cjs').runUninstall(argv.slice(1));
  if (sub === 'connect') return require('./connect.cjs').runConnect(argv.slice(1));
  if (sub === 'heartbeat') return require('./heartbeat.cjs').runHeartbeat(argv.slice(1));
  if (sub === 'audit') return require('./audit.cjs').runAudit(argv.slice(1));
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp();
    return 0;
  }
  // An unknown bare word (not a flag, not a runtime trigger) → show help, exit 2.
  if (sub && !sub.startsWith('-') && !RUNTIME_TRIGGERS.includes(sub)) {
    log(`unknown command: ${sub}`);
    printHelp();
    return 2;
  }

  const dryRun = argv.includes('--dry-run');
  const source = process.env.ATTRIBUT_SOURCE === 'cowork' ? 'cowork' : 'cli';

  // Which provider's hook are we handling? Default anthropic (Claude Code);
  // antigravity installs pass `--provider antigravity` in the hook command.
  const provider = (() => {
    const i = argv.indexOf('--provider');
    if (i !== -1 && argv[i + 1]) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith('--provider='));
    return eq ? eq.slice('--provider='.length) : 'anthropic';
  })();

  // Offline parse mode: --parse <file> prints the payload (no envelope/POST).
  const pi = argv.indexOf('--parse');
  if (pi !== -1) {
    const file = argv[pi + 1];
    if (!file) {
      log('--parse requires a file path argument.');
      return 2; // explicit user CLI misuse → fail loud
    }
    const payload =
      provider === 'openai'
        ? codexParser.parseCodexRollout(file, { device_uuid: getOrCreateDeviceUuid() })
        : parser.parseClaudeCodeTranscript(file, { device_uuid: getOrCreateDeviceUuid() });
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }

  const explicit = argv.find((a) => RUNTIME_TRIGGERS.includes(a));

  const stdinRaw = await readStdin();
  if (!stdinRaw.trim()) {
    log('no hook JSON on stdin; nothing to do.');
    return 0;
  }
  let hook;
  try {
    hook = JSON.parse(stdinRaw);
  } catch (err) {
    log(`could not parse hook JSON from stdin: ${err.message}`);
    return 0;
  }

  // A real hook fired — record it for the heartbeat's last_hook_invocation_at.
  // Skipped on --dry-run (offline inspection of a hook payload isn't a live
  // firing and shouldn't feed gap detection). Cheap, best-effort, never
  // throws — see state.cjs.
  if (!dryRun) touchHookInvocation();

  const trigger = triggerFor(hook.hook_event_name, explicit);
  if (!trigger) {
    log(`unsupported hook_event_name: ${hook.hook_event_name}; nothing to do.`);
    return 0;
  }

  let envelope;
  if (provider === 'antigravity') {
    // Subagents run as their OWN conversations and fire their own hooks. Suppress
    // a subagent child's standalone post — it is nested into its parent's session
    // (payload.antigravity.subagents[]) instead, so it doesn't surface as a
    // separate session. Detection: the child stores its parent id in the DB.
    if (!dryRun) {
      const parentId = agyTokens.readParentId(hook.conversationId);
      if (parentId) {
        log(`suppressing subagent child ${hook.conversationId} (parent ${parentId})`);
        return 0;
      }
    }
    // agy posts a cumulative snapshot on each PostToolUse (no payload-bearing
    // session-end event exists); the server reconciles by sessionId. No Claude
    // cursor gate — the transcript + token DB are small.
    try {
      envelope = buildAntigravityEnvelopeFromHook(hook, { trigger, source });
    } catch (err) {
      log(`could not build antigravity envelope (${trigger}): ${err.message}`);
      return 0; // never block the session
    }
  } else if (provider === 'openai') {
    // Codex. Resolve the rollout up front to (a) suppress subagent children and
    // (b) drive the posttooluse skip gate. Resolution failure is quiet (exit 0).
    let rolloutPath;
    try {
      rolloutPath = codexParser.resolveRolloutPath({
        transcriptPath: hook.transcript_path,
        sessionId: hook.session_id,
      });
    } catch (err) {
      log(`could not resolve codex rollout (${trigger}): ${err.message}`);
      return 0;
    }
    // A subagent runs as its OWN rollout and fires its own hooks. Suppress its
    // standalone post — it is nested into its parent's session (codex.subagents[])
    // instead. Dry-run still builds so offline inspection is unaffected.
    if (!dryRun && codexParser.isCodexSubagentRollout(rolloutPath)) {
      log(`suppressing codex subagent child ${hook.session_id}`);
      return 0;
    }
    // On posttooluse, capture a quiet `git commit -q` SHA via git plumbing BEFORE
    // the skip gate (a quiet commit leaves no `[branch sha]` in the rollout tail).
    let committedNow = false;
    if (trigger === 'posttooluse' && !dryRun) {
      committedNow = captureCommitSha(hook, { shellTools: null });
    }
    // Hot-path optimization: skip the full parse+POST when no new commit appeared
    // in the rollout tail since the last fire (SHA_RE matches the `[branch sha]`
    // inside the rollout JSONL). Codex Stop always full-parses.
    if (trigger === 'posttooluse' && !dryRun && !committedNow && posttooluseCanSkip(hook)) {
      return 0;
    }
    try {
      envelope = buildCodexEnvelopeFromHook(hook, { trigger, source });
    } catch (err) {
      log(`could not build codex envelope (${trigger}): ${err.message}`);
      return 0; // never block the session
    }
  } else if (provider === 'cursor') {
    // Cursor. Session id is the hook's conversation_id (== the on-disk composerId).
    const composerId = cursorParser.resolveComposerId({
      conversationId: hook.conversation_id,
      transcriptPath: hook.transcript_path,
    });
    if (!composerId) {
      log('cursor hook has no conversation_id/transcript_path; nothing to do.');
      return 0;
    }
    // afterShellExecution fires the collector as `posttooluse`: its ONLY job is to
    // capture a `git commit` SHA into the per-session sidecar (folded into the next
    // sessionEnd). It never posts. captureCommitSha is fail-safe — if Cursor's shell
    // stdin doesn't expose the command, it simply captures nothing.
    if (trigger === 'posttooluse') {
      if (!dryRun) {
        const normHook = {
          ...hook,
          session_id: composerId,
          cwd: firstWorkspaceRoot(hook),
        };
        captureCommitSha(normHook, { shellTools: null });
      }
      return 0;
    }
    // sessionEnd / stop: build + post the full session snapshot (server reconciles
    // by sessionId, latest non-partial wins).
    try {
      envelope = buildCursorEnvelopeFromHook(hook, { trigger, source });
    } catch (err) {
      log(`could not build cursor envelope (${trigger}): ${err.message}`);
      return 0; // never block the session
    }
  } else {
    // On posttooluse, capture the commit SHA from git plumbing BEFORE the skip
    // gate — a `git commit -q` leaves no `[branch sha]` line for
    // posttooluseCanSkip to detect, so without this it would be skipped and the
    // SHA lost. A newly captured SHA forces the parse+POST so it actually ships.
    let committedNow = false;
    if (trigger === 'posttooluse' && !dryRun) {
      committedNow = captureCommitSha(hook);
    }
    // Hot-path optimization: on posttooluse, skip the full parse+POST when no new
    // commit appeared since the last fire (see posttooluseCanSkip). Dry-run always
    // builds the envelope so offline inspection is unaffected.
    if (trigger === 'posttooluse' && !dryRun && !committedNow && posttooluseCanSkip(hook)) {
      return 0;
    }
    try {
      envelope = buildEnvelopeFromHook(hook, { trigger, source });
    } catch (err) {
      log(`could not build envelope (${trigger}): ${err.message}`);
      return 0; // never block the session
    }
  }

  if (dryRun) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
    return 0;
  }

  try {
    const res = await postEnvelope(envelope, agentForProvider(provider));
    log(`posted ${trigger} envelope for session ${envelope.payload.sessionId} → HTTP ${res.status}`);
    // Session is done — drop its cursor and captured-SHA sidecar so a reused
    // session id starts clean. (Claude/Codex/Cursor; agy has no cursor/sidecar.)
    // Cursor keys its sidecar by the composer/session id (== payload.sessionId),
    // which the hook carries as conversation_id, not session_id.
    if (provider !== 'antigravity' && (trigger === 'sessionend' || trigger === 'stop')) {
      const sessionKey = provider === 'cursor' ? envelope.payload.sessionId : hook.session_id;
      clearCursor(sessionKey);
      clearCapturedShas(sessionKey);
    }
  } catch (err) {
    log(`POST failed (${trigger}): ${err.message}`);
    return 0; // never block the session
  }
  return 0;
}

// Top-level: any uncaught error is logged and exits 0 — telemetry must never
// break the user's session.
if (require.main === module) {
  main()
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => {
      log(`unexpected error: ${err && err.message ? err.message : err}`);
      process.exit(0);
    });
}

module.exports = {
  endpoint,
  agentForProvider,
  triggerFor,
  cloudContext,
  buildEnvelopeFromHook,
  buildAntigravityEnvelopeFromHook,
  buildCodexEnvelopeFromHook,
  buildCursorEnvelopeFromHook,
  postEnvelope,
  cursorPath,
  posttooluseCanSkip,
  clearCursor,
  isGitCommitCommand,
  commitDirFromCommand,
  revParseHead,
  captureCommitSha,
  readCapturedShas,
  clearCapturedShas,
  mergeShas,
};
