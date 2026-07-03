'use strict';

// ATTRIBUT backfill — send EXISTING local sessions through the live capture path.
//
// The CLI normally captures AI-coding sessions live via hooks: an event fires,
// the collector builds an envelope from the transcript, and POSTs it. That means
// everything BEFORE `attribut connect` was run is invisible to ATTRIBUT.
//
// Backfill closes that gap without inventing a second pipeline. For each
// connected tool it:
//   1. enumerates that tool's existing local sessions (audit.cjs / parser/*.cjs
//      — read-only, newest-first),
//   2. builds a synthetic "hook" payload pointing at each existing session, and
//   3. runs it through the SAME envelope-build + POST functions live capture
//      uses (collector.cjs) — so the payload shape, validation, and privacy
//      guarantees are identical to a live session.
//
// Re-sending is safe: the server reconciles by `sessionId` — "latest non-partial
// wins" — so a session that was already captured live, or backfilled twice, just
// overwrites in place. It never double-counts.
//
// Two entry points:
//   - runBackfillInteractive() — called by `connect` right after hooks install,
//     to offer backfilling pre-connect history in the same flow. Silent/no-op on
//     any non-interactive environment or error — connect must still succeed.
//   - runBackfill(argv) — the standalone `attribut backfill` command, for anyone
//     who skipped the offer or wants a wider/narrower window later.
//
// FAILURE POLICY: mirrors the collector's fail-safe philosophy on the hot path —
// a single session's build/post failure is logged to stderr and counted as
// failed, never fatal, never aborts the batch. Usage errors in the standalone
// command (bad flags, bad --since) fail loud with a non-zero exit, same as
// audit.cjs / connect.cjs.

const readline = require('readline');

const collector = require('./collector.cjs');
const { readToken } = require('./token.cjs');
const { allTranscripts } = require('./audit.cjs');

const AGENT_SLUGS = ['claude_code', 'codex', 'agy', 'cursor'];
const AGENT_LABELS = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  agy: 'Antigravity',
  cursor: 'Cursor',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE = '90d';

function out(msg) {
  process.stdout.write(`${msg}\n`);
}
function err(msg) {
  process.stderr.write(`${msg}\n`);
}

// ---------------------------------------------------------------------------
// since / window parsing
// ---------------------------------------------------------------------------

// Parse a --since spec into an epoch-ms cutoff, or null for "no cutoff".
//   "90d" / "30d"      -> N days ago
//   ISO date/datetime  -> Date.parse(arg)
//   null / "all"       -> null (no cutoff — full history)
//   undefined          -> defaults to "90d"
// Throws a clear Error on anything else (bad flag value = usage error).
function parseSince(arg) {
  if (arg === undefined) return parseSince(DEFAULT_SINCE);
  if (arg === null || arg === 'all') return null;
  const s = String(arg).trim();
  const days = /^(\d+)\s*d$/i.exec(s);
  if (days) return Date.now() - parseInt(days[1], 10) * DAY_MS;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  throw new Error(`invalid --since value: ${JSON.stringify(arg)} (expected "<N>d", an ISO date, or "all")`);
}

// ---------------------------------------------------------------------------
// enumeration — one entry point per agent, normalized to a common shape
// ---------------------------------------------------------------------------

// List agentSlug's existing local sessions, normalized to `{ ...raw, whenMs }`.
// Never throws — a missing/broken enumerator (tool not installed, parser error,
// db locked, ...) just yields an empty list, logged to stderr.
function enumerate(agentSlug) {
  try {
    switch (agentSlug) {
      case 'claude_code': {
        const fs = require('fs');
        return allTranscripts().map((p) => {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(p).mtimeMs;
          } catch {
            /* file vanished between listing and stat — mtimeMs stays 0 */
          }
          return { path: p, mtimeMs, whenMs: mtimeMs };
        });
      }
      case 'codex': {
        const { listSessionRollouts } = require('./parser/codex.cjs');
        return listSessionRollouts().map((d) => ({ ...d, whenMs: d.mtimeMs }));
      }
      case 'agy': {
        const { listConversationIds } = require('./parser/antigravity_tokens.cjs');
        return listConversationIds().map((d) => ({ ...d, whenMs: d.mtimeMs }));
      }
      case 'cursor': {
        const { openStateDb, listComposerIds } = require('./parser/cursor.cjs');
        const db = openStateDb();
        if (!db) return [];
        try {
          return listComposerIds(db).map((d) => ({ ...d, whenMs: d.lastUpdatedAt || d.createdAt || 0 }));
        } finally {
          if (db && typeof db.close === 'function') db.close();
        }
      }
      default:
        return [];
    }
  } catch (e) {
    err(`  (backfill: could not enumerate ${agentSlug} sessions: ${e.message})`);
    return [];
  }
}

// Scan agentSlugs and window each agent's descriptors to sinceMs (null = all
// history). Returns { perAgent: [{ agent, count, oldestMs, newestMs,
// descriptors }], total }.
function scan(agentSlugs, { sinceMs } = {}) {
  const perAgent = [];
  let total = 0;
  for (const agent of agentSlugs) {
    const all = enumerate(agent);
    const kept = sinceMs == null ? all : all.filter((d) => d.whenMs >= sinceMs);
    const oldestMs = kept.length ? Math.min(...kept.map((d) => d.whenMs)) : null;
    const newestMs = kept.length ? Math.max(...kept.map((d) => d.whenMs)) : null;
    perAgent.push({ agent, count: kept.length, oldestMs, newestMs, descriptors: kept });
    total += kept.length;
  }
  return { perAgent, total };
}

// ---------------------------------------------------------------------------
// concurrency helper
// ---------------------------------------------------------------------------

// Run worker(item, index) over items with at most `concurrency` in flight.
// Resolves an array of { ok, error? } — one entry per item, in item order. A
// worker rejection is captured as { ok:false, error }; it never aborts the pool.
function asyncPool(concurrency, items, worker) {
  return new Promise((resolve) => {
    const results = new Array(items.length);
    if (items.length === 0) return resolve(results);
    const n = Math.max(1, concurrency);
    let nextIndex = 0;
    let completed = 0;

    const launchNext = () => {
      if (nextIndex >= items.length) return;
      const idx = nextIndex++;
      Promise.resolve()
        .then(() => worker(items[idx], idx))
        .then(() => {
          results[idx] = { ok: true };
        })
        .catch((error) => {
          results[idx] = { ok: false, error };
        })
        .finally(() => {
          completed++;
          if (completed === items.length) resolve(results);
          else launchNext();
        });
    };

    for (let i = 0; i < n && i < items.length; i++) launchNext();
  });
}

// ---------------------------------------------------------------------------
// synthetic hook + builder wiring per agent
// ---------------------------------------------------------------------------

function builderFor(agentSlug) {
  switch (agentSlug) {
    case 'claude_code':
      return collector.buildEnvelopeFromHook;
    case 'codex':
      return collector.buildCodexEnvelopeFromHook;
    case 'agy':
      return collector.buildAntigravityEnvelopeFromHook;
    case 'cursor':
      return collector.buildCursorEnvelopeFromHook;
    default:
      throw new Error(`unknown agent: ${agentSlug}`);
  }
}

function syntheticHook(agentSlug, d) {
  switch (agentSlug) {
    case 'claude_code':
      return { transcript_path: d.path, session_id: null, cwd: null, reason: 'backfill' };
    case 'codex':
      return { transcript_path: d.path, session_id: d.sessionId || null, cwd: null, reason: 'backfill' };
    case 'agy': {
      const { brainTranscriptPath } = require('./parser/antigravity_cli.cjs');
      return { transcriptPath: brainTranscriptPath(d.id), conversationId: d.id, workspacePaths: [] };
    }
    case 'cursor':
      return {
        conversation_id: d.composerId,
        transcript_path: null,
        workspace_roots: [],
        user_email: null,
        cursor_version: null,
        reason: 'backfill',
        duration_ms: null,
      };
    default:
      throw new Error(`unknown agent: ${agentSlug}`);
  }
}

// ---------------------------------------------------------------------------
// upload core
// ---------------------------------------------------------------------------

// Build + send every descriptor in perAgent (the `scan()` shape). dryRun
// collects the built envelopes instead of posting them. Calls
// onProgress({ agent, done, total }) after each session (success or failure).
// Returns { summary: [{ agent, total, sent, failed }], envelopes }. A single
// session's build/post failure is logged and counted as failed — never fatal.
async function uploadAll(perAgent, { concurrency = 8, dryRun = false, onProgress } = {}) {
  const summary = [];
  const envelopes = [];

  for (const entry of perAgent) {
    const { agent, descriptors } = entry;
    const total = descriptors.length;
    let done = 0;
    let sent = 0;
    let failed = 0;
    const build = builderFor(agent);

    const worker = async (d) => {
      try {
        const hook = syntheticHook(agent, d);
        const envelope = build(hook, { trigger: 'backfill', source: 'cli' });
        if (dryRun) {
          envelopes.push({ agent, envelope });
        } else {
          await collector.postEnvelope(envelope, agent);
        }
        sent++;
      } catch (e) {
        failed++;
        err(`  (backfill: ${agent} session failed: ${e.message})`);
        throw e;
      } finally {
        done++;
        if (onProgress) onProgress({ agent, done, total });
      }
    };

    await asyncPool(concurrency, descriptors, worker);
    summary.push({ agent, total, sent, failed });
  }

  return { summary, envelopes };
}

// ---------------------------------------------------------------------------
// shared presentation helpers
// ---------------------------------------------------------------------------

function dateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function printScanSummary(result) {
  for (const p of result.perAgent) {
    if (p.count === 0) continue;
    out(`  ${AGENT_LABELS[p.agent] || p.agent}: ${p.count} sessions (${dateStr(p.oldestMs)} → ${dateStr(p.newestMs)})`);
  }
}

function progressWriter() {
  return ({ agent, done, total }) => {
    if (!process.stdout.isTTY) return;
    const pct = total ? Math.round((done / total) * 100) : 100;
    process.stdout.write(`\r  Backfilling ${AGENT_LABELS[agent] || agent}… ${done}/${total} (${pct}%)`);
    if (done === total) process.stdout.write('\n');
  };
}

function finalLine(summary) {
  const totalSent = summary.reduce((n, s) => n + s.sent, 0);
  const totalFailed = summary.reduce((n, s) => n + s.failed, 0);
  const agentsList = summary
    .filter((s) => s.total > 0)
    .map((s) => AGENT_LABELS[s.agent] || s.agent)
    .join(', ');
  return `✓ Backfilled ${totalSent} sessions (${totalFailed} failed) across ${agentsList}`;
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

// ---------------------------------------------------------------------------
// interactive entry point — called by `connect` after hooks install
// ---------------------------------------------------------------------------

// Offer to backfill pre-connect history right after `connect` installs hooks.
// `connected` is [{ agent, token, endpoint }] (connect.cjs's normalized configs).
// Silent no-op when not interactive, when there's nothing to backfill, or on any
// internal error — connect's success must never depend on this. `ingestBase`,
// if given, temporarily overrides INGEST_BASE for the duration of this call.
async function runBackfillInteractive({ connected, ingestBase } = {}) {
  try {
    if (!process.stdout.isTTY || !process.stdin.isTTY) return; // non-interactive / cloud — skip silently

    const agentSlugs = (connected || [])
      .map((c) => c.agent)
      .filter((a) => AGENT_SLUGS.includes(a));
    if (agentSlugs.length === 0) return;

    const prevIngestBase = process.env.INGEST_BASE;
    if (ingestBase) process.env.INGEST_BASE = ingestBase;
    try {
      let result = scan(agentSlugs, { sinceMs: parseSince('90d') });
      if (result.total === 0) {
        out('No prior sessions found to backfill.');
        return;
      }
      printScanSummary(result);

      const answer = (
        await promptLine('Backfill these to ATTRIBUT? [Y = last 90 days / a = all history / n = skip]: ')
      )
        .trim()
        .toLowerCase();

      if (answer === 'n') return;
      if (answer === 'a') {
        result = scan(agentSlugs, { sinceMs: null });
        if (result.total === 0) {
          out('No prior sessions found to backfill.');
          return;
        }
      }

      const { summary } = await uploadAll(result.perAgent, { onProgress: progressWriter() });
      out(finalLine(summary));
    } finally {
      if (ingestBase) {
        if (prevIngestBase === undefined) delete process.env.INGEST_BASE;
        else process.env.INGEST_BASE = prevIngestBase;
      }
    }
  } catch (e) {
    err(`  (backfill: skipped due to error: ${e.message})`);
  }
}

// ---------------------------------------------------------------------------
// standalone command — `attribut backfill`
// ---------------------------------------------------------------------------

const BACKFILL_HELP = `
attribut backfill — send existing local sessions through the live capture path

Enumerates your existing local sessions for each connected tool and re-sends
them through the same envelope-build + POST path live capture uses, so
pre-connect history shows up in ATTRIBUT. Safe to re-run: the server reconciles
by sessionId (latest non-partial wins) — duplicates overwrite, never double-count.

Usage: attribut backfill [--agents=a,b] [--since=90d|<ISO>] [--all] [--yes] [--dry-run]

Options:
  --agents=<a,b>   Agents to backfill (default: every connected agent — has a
                   stored token). One or more of: ${AGENT_SLUGS.join(', ')}.
  --since=<spec>   Only sessions at/after this cutoff: "<N>d" (N days ago) or an
                   ISO date. Default: 90d.
  --all            No cutoff — backfill full history. Overrides --since.
  -y, --yes        Skip the confirmation prompt.
  --dry-run        Print the scan summary and the envelopes that WOULD be sent
                   (pretty JSON) — sends nothing.
  -h, --help       Show this help.
`;

function splitList(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseBackfillArgs(argv) {
  const r = { agents: null, since: DEFAULT_SINCE, all: false, yes: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agents') r.agents = splitList(argv[++i]);
    else if (a.startsWith('--agents=')) r.agents = splitList(a.slice('--agents='.length));
    else if (a === '--since') r.since = argv[++i];
    else if (a.startsWith('--since=')) r.since = a.slice('--since='.length);
    else if (a === '--all') r.all = true;
    else if (a === '--yes' || a === '-y') r.yes = true;
    else if (a === '--dry-run') r.dryRun = true;
    else if (a === '-h' || a === '--help') r.help = true;
  }
  return r;
}

// `attribut backfill [...]`. Returns an exit code (0 ok, 2 usage error).
async function runBackfill(argv) {
  const opts = parseBackfillArgs(argv || []);
  if (opts.help) {
    out(BACKFILL_HELP.trimStart());
    return 0;
  }

  let agents;
  if (opts.agents) {
    if (opts.agents.length === 0) {
      err('--agents given with no value.');
      return 2;
    }
    agents = [];
    for (const a of opts.agents) {
      if (!AGENT_SLUGS.includes(a)) {
        err(`Unknown agent "${a}" — valid: ${AGENT_SLUGS.join(', ')}.`);
        return 2;
      }
      agents.push(a);
    }
    agents = [...new Set(agents)];
  } else {
    agents = AGENT_SLUGS.filter((slug) => !!readToken(slug));
  }
  if (agents.length === 0) {
    err('No connected agents to backfill (nothing has a stored token). Run `attribut connect` first, or pass --agents.');
    return 2;
  }

  let sinceMs;
  try {
    sinceMs = opts.all ? null : parseSince(opts.since);
  } catch (e) {
    err(e.message);
    return 2;
  }

  const result = scan(agents, { sinceMs });
  if (result.total === 0) {
    out('No prior sessions found to backfill.');
    return 0;
  }
  printScanSummary(result);

  if (opts.dryRun) {
    const { envelopes } = await uploadAll(result.perAgent, { dryRun: true });
    out('');
    out('Envelopes that WOULD be sent (dry run — nothing was posted):');
    out(JSON.stringify(envelopes, null, 2));
    return 0;
  }

  if (!opts.yes) {
    if (process.stdout.isTTY && process.stdin.isTTY) {
      const answer = (await promptLine(`Backfill ${result.total} sessions to ATTRIBUT? [Y/n]: `))
        .trim()
        .toLowerCase();
      if (answer === 'n' || answer === 'no') {
        out('Skipped.');
        return 0;
      }
    } else {
      out('(non-interactive: proceeding without confirmation — pass --yes to silence this notice)');
    }
  }

  const { summary } = await uploadAll(result.perAgent, { onProgress: progressWriter() });
  out(finalLine(summary));
  return 0;
}

module.exports = {
  runBackfill,
  runBackfillInteractive,
  scan,
  enumerate,
  parseSince,
  asyncPool,
  AGENT_SLUGS,
};
