'use strict';

// ATTRIBUT — Claude Code transcript parser (allowlist extractor).
//
// HARD CONSTRAINT (the whole point of this collector): this module reads ONLY a
// local transcript .jsonl file and returns ONLY the allowlist of safe, signal-
// bearing fields named in the FROZEN contract (the vendored
// src/contract/envelope.schema.json). It NEVER reads or returns prompt text,
// assistant message bodies, file/diff contents, tool input args, or PR/commit
// bodies. If a field is not in the contract, it does not leave this function. No
// interpretation (pricing, attribution, identity, non-re-derivable aggregation)
// happens here — that is ingest_worker.
//
// Structural line metrics (counts only): edited/written line text is classified
// (code / comment / blank) and measured (length) IN MEMORY, then DISCARDED. Only
// the classification (an enum) and the line LENGTH ever leave, as integers.
//
// Output shape: the contract `payload` object — agnostic fields at the top plus
// a `claude_code` sub-struct. Ported from cli/src/parser.cjs with the new fields the
// field audit cleared as available + safe (duration_ms, num_turns,
// num_tool_calls, tool_uses, claude.service_tier/stop_reason/version, and the
// full per-invocation claude.subagents[] array).

const fs = require('fs');
const path = require('path');
const os = require('os');

// Hard caps on every free-form string field before it enters the payload.
// Defense-in-depth: even the one content-derived field (`title`) and any value
// echoed verbatim from the transcript can never carry an unbounded blob. Caps
// match the schema's maxLength so a truncated value always validates.
const CAP_TITLE = 200;
const CAP_PATH = 256; // repo / branch
const CAP_LABEL = 128; // model / service_tier / stop_reason / version / agent_type / status

// Truncate a string to n chars; pass through null/undefined unchanged.
function cap(s, n) {
  return typeof s === 'string' && s.length > n ? s.slice(0, n) : s;
}

// Capture group 1 is the short SHA from git's `[branch sha]` commit line.
// Global flag so we can collect 0..N per transcript.
const SHA_RE = /\[[\w./-]+ ([0-9a-f]{7,40})\]/g;

// A toolUseResult may carry file content (e.g. {"file":{"content":...}}). We
// only want SHAs that came from a `git commit` stdout, never from a file body.
// git's commit stdout looks like `[branch sha] subject\n N files changed`.
// Restrict matching to the stdout field when the result is an object; fall back
// to whole-string coercion only for plain-string results.
function extractShasFromToolResult(toolUseResult) {
  const found = [];
  if (toolUseResult == null) return found;

  let haystack;
  if (typeof toolUseResult === 'string') {
    haystack = toolUseResult;
  } else if (typeof toolUseResult === 'object') {
    // Prefer stdout (git commit output lands here per verified real data).
    if (typeof toolUseResult.stdout === 'string') {
      haystack = toolUseResult.stdout;
    } else {
      // No stdout field: some other tool result (often file content). Do NOT
      // scan file bodies — that risks false positives and reading content we
      // are forbidden to touch. Skip.
      return found;
    }
  } else {
    return found;
  }

  let m;
  SHA_RE.lastIndex = 0;
  while ((m = SHA_RE.exec(haystack)) !== null) {
    found.push({ sha: m[1], line: m[0] });
  }
  return found;
}

// Branch at commit time, taken from the `[branch sha]` bracket (more reliable
// than row-level .gitBranch when that reads HEAD/empty).
function branchFromBracketLine(line) {
  const m = /\[([\w./-]+) [0-9a-f]{7,40}\]/.exec(line || '');
  return m ? m[1] : null;
}

// Subagent (Task/Agent tool) turns run OUT OF BAND: their conversation turns are
// NOT written into the parent transcript. The subagent's usage exists ONLY as a
// `usage` object on the Task result's `toolUseResult`. Since those turns are not
// inline, counting this usage does NOT double-count the parent. Shape (verified):
//   { agentId, agentType, status, totalTokens, totalToolUseCount,
//     usage: { input_tokens, cache_creation_input_tokens,
//              cache_read_input_tokens, output_tokens, ... }, ... }
// HARD CONSTRAINT: read ONLY numeric token metadata + the agent_type/status
// labels — never `content`, `prompt`, message bodies, or any free text.
//
// Timestamps are APPROXIMATE: subagent turns aren't inline, so there is no true
// child session window. `startedAt`/`endedAt` are the transcript row timestamps
// of the dispatching `Task` tool_use and its result row (passed by the caller).
// With parallel Task calls the start may pair to a different sibling dispatch.
function subagentFromToolResult(toolUseResult, startedAt = null, endedAt = null) {
  if (
    toolUseResult == null ||
    typeof toolUseResult !== 'object' ||
    typeof toolUseResult.usage !== 'object' ||
    toolUseResult.usage === null
  ) {
    return null;
  }
  const u = toolUseResult.usage;
  const sMs = startedAt ? Date.parse(startedAt) : NaN;
  const eMs = endedAt ? Date.parse(endedAt) : NaN;
  return {
    agent_type:
      typeof toolUseResult.agentType === 'string'
        ? cap(toolUseResult.agentType, CAP_LABEL)
        : null,
    // Subagents frequently run a DIFFERENT model than the parent; the resolved
    // model id lives on `.resolvedModel` (NOT `.model`). Label metadata only.
    model:
      typeof toolUseResult.resolvedModel === 'string'
        ? cap(toolUseResult.resolvedModel, CAP_LABEL)
        : null,
    status:
      typeof toolUseResult.status === 'string'
        ? cap(toolUseResult.status, CAP_LABEL)
        : null,
    tool_use_count:
      typeof toolUseResult.totalToolUseCount === 'number'
        ? toolUseResult.totalToolUseCount
        : 0,
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0,
    cache_creation_tokens: u.cache_creation_input_tokens || 0,
    started_at: !Number.isNaN(sMs) ? new Date(sMs).toISOString() : null,
    ended_at: !Number.isNaN(eMs) ? new Date(eMs).toISOString() : null,
    duration_ms: !Number.isNaN(sMs) && !Number.isNaN(eMs) ? eMs - sMs : null,
  };
}

// --- Structural line metrics (counts only; content discarded) ----------------
//
// Each syntax descriptor has shape { l: [linePrefixes...], b: [[open,close]...] }.
// `l` = line-comment prefixes; `b` = block-comment delimiter pairs. A bare
// string is an ALIAS for another extension, resolved once at load time.
const COMMENT_SYNTAX_RAW = {
  // C-family: line `//`, block `/* */`.
  '.js': { l: ['//'], b: [['/*', '*/']] },
  '.cjs': '.js',
  '.mjs': '.js',
  '.jsx': '.js',
  '.ts': '.js',
  '.tsx': '.js',
  '.c': '.js',
  '.h': '.js',
  '.cpp': '.js',
  '.cc': '.js',
  '.hpp': '.js',
  '.java': '.js',
  '.go': '.js',
  '.rs': '.js',
  '.swift': '.js',
  '.kt': '.js',
  '.scala': '.js',
  '.cs': '.js',
  '.php': '.js',
  '.scss': '.js',
  // CSS: block only.
  '.css': { l: [], b: [['/*', '*/']] },
  // Python: line `#`, approx block via triple quotes.
  '.py': { l: ['#'], b: [['"""', '"""'], ["'''", "'''"]] },
  '.rb': { l: ['#'], b: [] },
  // Shells / config: `#`.
  '.sh': { l: ['#'], b: [] },
  '.bash': '.sh',
  '.zsh': '.sh',
  '.yml': '.sh',
  '.yaml': '.sh',
  '.toml': '.sh',
  // Terraform: `#` and C-style.
  '.tf': { l: ['#', '//'], b: [['/*', '*/']] },
  // SQL: line `--`, block `/* */`.
  '.sql': { l: ['--'], b: [['/*', '*/']] },
  // Markup: block `<!-- -->`.
  '.html': { l: [], b: [['<!--', '-->']] },
  '.xml': '.html',
  '.vue': '.html',
  '.md': '.html',
};

// Resolve string aliases once so syntaxForPath is a plain map lookup.
const COMMENT_SYNTAX = (() => {
  const out = {};
  for (const [ext, val] of Object.entries(COMMENT_SYNTAX_RAW)) {
    out[ext] = typeof val === 'string' ? COMMENT_SYNTAX_RAW[val] : val;
  }
  return out;
})();

// Unknown extension → no comment syntax, so every non-blank line is `code`.
const NO_SYNTAX = { l: [], b: [] };

// Map a file path to its comment-syntax descriptor by extension (lower-cased).
function syntaxForPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return COMMENT_SYNTAX[ext] || NO_SYNTAX;
}

// Machine-generated / vendored files: their line counts are not human-authored
// effort, so they are EXCLUDED from the structural metrics entirely. Otherwise a
// single regenerated lockfile or build artifact inflates the downstream
// human-equivalent value estimate (see the app /methodology page). Matched on the
// lower-cased basename and on any intermediate path SEGMENT, so a vendored
// directory excludes everything under it. Deliberately conservative — only
// well-known generated artifacts, so genuine hand-authored source is never
// dropped. Paths arrive as absolute OS paths; backslashes are normalized first.
const GENERATED_BASENAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lockb', 'composer.lock', 'gemfile.lock', 'poetry.lock', 'pipfile.lock',
  'cargo.lock', 'go.sum', 'flake.lock',
]);
const GENERATED_DIR_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', 'vendor', 'target', '__pycache__', '.venv', 'venv',
  '__snapshots__', '.terraform',
]);
const GENERATED_SUFFIXES = [
  '.min.js', '.min.css', '.map', '.snap', '.lock', '_pb2.py', '.pb.go',
  '.generated.ts', '.generated.js',
];

// True when `filePath` is a machine-generated / vendored artifact whose lines
// must not be counted as human authoring effort.
function isGeneratedPath(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (norm === '') return false;
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (GENERATED_BASENAMES.has(base)) return true;
  for (const suf of GENERATED_SUFFIXES) {
    if (base.endsWith(suf)) return true;
  }
  // Intermediate directory segments only (exclude the basename itself, so a file
  // literally named e.g. 'build' is not treated as a build directory).
  const segments = norm.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (GENERATED_DIR_SEGMENTS.has(segments[i])) return true;
  }
  return false;
}

// Classify ONE line of source as 'code' | 'comment' | 'blank'.
//
// blockState is a per-hunk object { open: <closer string>|null } carried across
// calls so a block comment opened on a prior line keeps subsequent lines as
// comments until its closer is seen. LINE-ANCHORED approximation: a block is
// only detected when its opener is the FIRST non-whitespace token of a line.
function classify(text, syntax, blockState) {
  const s = syntax || NO_SYNTAX;
  const state = blockState || { open: null };

  // Inside an already-open block comment: this whole line is comment; close the
  // block if its closer appears anywhere on the line.
  if (state.open) {
    if (text.indexOf(state.open) !== -1) state.open = null;
    return 'comment';
  }

  const trimmed = text.trim();
  if (trimmed === '') return 'blank';

  // Block comment whose opener is the first non-whitespace token.
  for (const [open, close] of s.b) {
    if (trimmed.startsWith(open)) {
      const rest = trimmed.slice(open.length);
      if (rest.indexOf(close) === -1) state.open = close;
      return 'comment';
    }
  }

  // Line comment whose prefix is the first non-whitespace token.
  for (const prefix of s.l) {
    if (trimmed.startsWith(prefix)) return 'comment';
  }

  return 'code';
}

// Accumulate structural line counts from ONE toolUseResult into `struct` (the
// 9-key integer accumulator). Mutates struct in place. Reads patch/content line
// text ONLY to classify + measure length, never retaining it.
function accumulateStructural(toolUseResult, struct) {
  if (!toolUseResult || typeof toolUseResult !== 'object') return;
  if (typeof toolUseResult.filePath !== 'string') return; // guard: need a path
  if (isGeneratedPath(toolUseResult.filePath)) return; // skip generated/vendored
  const syntax = syntaxForPath(toolUseResult.filePath);

  const bumpAdded = (kind, content) => {
    if (kind === 'code') struct.lines_code_added += 1;
    else if (kind === 'comment') struct.lines_comment_added += 1;
    else struct.lines_blank_added += 1;
    // Char-length stats on ADDED lines only.
    const len = content.length;
    struct.added_char_n += 1;
    struct.added_char_sum += len;
    struct.added_char_sumsq += len * len;
  };
  const bumpRemoved = (kind) => {
    if (kind === 'code') struct.lines_code_removed += 1;
    else if (kind === 'comment') struct.lines_comment_removed += 1;
    else struct.lines_blank_removed += 1;
  };

  const patch = toolUseResult.structuredPatch;
  if (Array.isArray(patch) && patch.length > 0) {
    // Edit / MultiEdit: walk each hunk; classify '+'/'-'/' ' tagged lines.
    for (const hunk of patch) {
      const lines = hunk && Array.isArray(hunk.lines) ? hunk.lines : [];
      const blockState = { open: null }; // fresh per hunk
      for (const raw of lines) {
        if (typeof raw !== 'string' || raw.length === 0) continue;
        const tag = raw[0];
        const content = raw.slice(1);
        const kind = classify(content, syntax, blockState);
        if (tag === '+') bumpAdded(kind, content);
        else if (tag === '-') bumpRemoved(kind);
        // ' ' (context): classify already ran to keep block state honest.
      }
    }
    return;
  }

  // Write / create: empty structuredPatch, whole content is added.
  if (toolUseResult.type === 'create' && typeof toolUseResult.content === 'string') {
    const content = toolUseResult.content;
    const parts = content.split('\n');
    // A file written with a trailing newline yields a spurious empty last
    // element; drop exactly one so an N-line file counts as N added lines.
    if (parts.length > 0 && content.endsWith('\n')) parts.pop();
    const blockState = { open: null };
    for (const lineText of parts) {
      const kind = classify(lineText, syntax, blockState);
      bumpAdded(kind, lineText);
    }
  }
}

// Fresh zeroed accumulator with the 9 contract keys.
function newStructAccumulator() {
  return {
    lines_code_added: 0,
    lines_comment_added: 0,
    lines_blank_added: 0,
    lines_code_removed: 0,
    lines_comment_removed: 0,
    lines_blank_removed: 0,
    added_char_n: 0,
    added_char_sum: 0,
    added_char_sumsq: 0,
  };
}

function expandHome(p) {
  if (p && p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// Worker transcript filenames are `agent-<name>-<hex>.jsonl`, where <name> is the
// instance label the orchestrator chose (e.g. "gen3-eval-build") and <hex> a random
// suffix. Recover <name> for the subagent `role` label. The name is a filesystem
// label (not message/prompt content), so it is allowlist-safe; callers cap it.
function subagentNameFromFile(fileName) {
  const base = path.basename(String(fileName || '')).replace(/\.jsonl$/i, '');
  const m = /^agent-(.+)-[0-9a-f]+$/i.exec(base);
  if (m) return m[1];
  return base.replace(/^agent-/, '') || null;
}

// Build the parent's nested subagents[] from the on-disk worker transcripts (the
// file plane). Named / backgrounded / worktree-isolated Agent workers run OUT OF
// BAND: their turns are written to their own transcript at
//   <projectsRoot>/<projectDir>/<parentSessionId>/subagents/agent-<name>-<hex>.jsonl
// and, for `isolation:worktree` workers, under the worktree's own project dir. We
// therefore scan EVERY project dir for a `<sessionId>/subagents/` folder and dedup
// worker files by basename (a worktree worker can appear in both places).
//
// Each worker file IS a complete Claude Code transcript, so it is parsed by the same
// parseClaudeCodeTranscript (with file-subagent discovery DISABLED to bound recursion
// to one level) and its totals reshaped into the subagent struct. Numbers + the
// filename-derived role label only — never message/prompt/diff content. Returns []
// on any failure; never throws (mirrors antigravity_cli.buildSubagents).
function subagentsFromFiles(transcriptPath, sessionId) {
  try {
    if (!sessionId) return [];
    const abs = expandHome(transcriptPath);
    const projectsRoot = path.dirname(path.dirname(abs)); // .../projects
    let projectDirs;
    try {
      projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    // A worktree-isolated worker's transcript is written under BOTH the worktree's
    // project dir AND the parent project dir, and the two copies can differ: one is
    // the complete transcript, the other a short stub. Dedup by basename keeping the
    // LARGEST file (the complete one) — never first-seen, which can pick the stub.
    const byBase = new Map(); // basename -> { path, size }
    for (const ent of projectDirs) {
      if (!ent.isDirectory()) continue;
      const subDir = path.join(projectsRoot, ent.name, sessionId, 'subagents');
      let files;
      try {
        files = fs.readdirSync(subDir);
      } catch {
        continue; // no subagents dir under this project for this session
      }
      for (const f of files) {
        if (!/^agent-.*\.jsonl$/i.test(f)) continue;
        const full = path.join(subDir, f);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        const prev = byBase.get(f);
        if (!prev || size > prev.size) byBase.set(f, { path: full, size });
      }
    }

    const out = [];
    for (const [fname, { path: fpath }] of byBase) {
      let p;
      try {
        p = parseClaudeCodeTranscript(fpath, { withFileSubagents: false });
      } catch {
        continue; // unreadable/empty worker file — skip, never fail the parent
      }
      const cc = p.claude_code || {};
      out.push({
        // subagent_type lives in the Agent tool's INPUT args, which the allowlist
        // forbids reading; the instance name (filename) is the safe label.
        agent_type: null,
        role: cap(subagentNameFromFile(fname), CAP_LABEL),
        model: p.model, // already capped by the inner parse
        status: 'completed', // a written transcript means the worker ran to a stop
        tool_use_count: p.num_tool_calls || 0,
        input_tokens: p.tokens_in || 0,
        output_tokens: p.tokens_out || 0,
        cache_read_tokens: cc.cache_read_tokens || 0,
        cache_creation_tokens: cc.cache_creation_tokens || 0,
        started_at: p.started_at,
        ended_at: p.ended_at,
        duration_ms: p.duration_ms,
        tool_uses: p.tool_uses || [],
        // Worker workers commit in their own (often worktree-isolated) checkout;
        // those SHAs/branch are NEVER observed in the parent transcript. Keep them
        // on the subagent record so the session-level union below can recover them.
        commit_shas: Array.isArray(p.commitSHA) ? p.commitSHA : [],
        branch: p.branch,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Parse a single Claude Code .jsonl transcript into the contract `payload`
// object. `extra` may override { sessionId, repo } from the hook. THROWS on
// unreadable/garbage input (fail loud) — the collector decides whether to
// swallow.
function parseClaudeCodeTranscript(transcriptPath, extra = {}) {
  const abs = expandHome(transcriptPath);
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Transcript is empty: ${abs}`);
  }

  let sessionId = null;
  let repo = null;
  const rowBranches = new Set(); // non-HEAD/non-empty .gitBranch values
  const models = new Set();
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheCreate = 0;
  let cacheRead = 0;
  let tMin = null;
  let tMax = null;
  const shaSet = new Set(); // dedup SHAs in insertion order (contract is an array)
  const bracketBranches = new Set();
  const struct = newStructAccumulator();

  let numTurns = 0; // count of assistant rows
  const toolUseCounts = new Map(); // tool name -> count (names only)
  const inlineSubagents = []; // inline Task subagent records (legacy/fallback plane)
  // Approx subagent start: timestamp of the most recent assistant row carrying a
  // `Task` tool_use block, consumed by the next subagent result row (its end).
  let lastTaskTs = null;
  let serviceTier = null; // last seen assistant service_tier
  let stopReason = null; // last seen assistant stop_reason
  let version = null; // Claude Code version (.version)

  // Chat title — CONTENT-DERIVED (the one authorized allowlist exception, see
  // the contract's "Content-derived exception"). Empirically the title lives in two
  // row types keyed by sessionId, each repeated on every update so the LAST
  // value is the latest:
  //   type:"custom-title" → .customTitle  (user-set; explicit override)
  //   type:"ai-title"     → .aiTitle      (Claude's model-generated summary)
  // A user override wins over the AI title. We read ONLY these two label fields,
  // never `last-prompt`/`lastPrompt` or any other conversation content.
  let aiTitle = null;
  let customTitle = null;

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch (err) {
      // Fail loud: a corrupt transcript line is a real problem.
      throw new Error(
        `Malformed JSON in ${abs}: ${err.message} :: ${line.slice(0, 120)}`
      );
    }

    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (o.cwd && !repo) repo = o.cwd; // CLI .cwd IS the real repo
    if (o.gitBranch && o.gitBranch !== 'HEAD') rowBranches.add(o.gitBranch);
    if (typeof o.version === 'string' && o.version) version = o.version;

    // Title rows (label fields only; never lastPrompt/content). Last value wins.
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle) {
      aiTitle = o.aiTitle;
    } else if (
      o.type === 'custom-title' &&
      typeof o.customTitle === 'string' &&
      o.customTitle
    ) {
      customTitle = o.customTitle;
    }

    if (o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) {
        if (tMin === null || t < tMin) tMin = t;
        if (tMax === null || t > tMax) tMax = t;
      }
    }

    if (o.type === 'assistant' && o.message) {
      numTurns += 1;
      const msg = o.message;
      // `<synthetic>` is Claude Code's placeholder model on interrupt/error stub
      // rows (all-zero usage) — not a real model. Exclude it.
      if (msg.model && msg.model !== '<synthetic>') models.add(msg.model);
      if (typeof msg.stop_reason === 'string' && msg.stop_reason) {
        stopReason = msg.stop_reason; // last non-null wins
      }
      const u = msg.usage;
      if (u) {
        tokensIn += u.input_tokens || 0;
        tokensOut += u.output_tokens || 0;
        cacheCreate += u.cache_creation_input_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        if (typeof u.service_tier === 'string' && u.service_tier) {
          serviceTier = u.service_tier; // last non-null wins
        }
      }
      // Tool-use NAMES + counts only — never the tool input args. tool_use
      // blocks live in the assistant message content array as {type:'tool_use',
      // name, input}. We read `name` only.
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool_use' && typeof block.name === 'string') {
            toolUseCounts.set(block.name, (toolUseCounts.get(block.name) || 0) + 1);
            // Remember when a subagent was dispatched, to approximate its start.
            if (block.name === 'Task' && o.timestamp) lastTaskTs = o.timestamp;
          }
        }
      }
    }

    if (o.toolUseResult) {
      for (const hit of extractShasFromToolResult(o.toolUseResult)) {
        shaSet.add(hit.sha);
        const b = branchFromBracketLine(hit.line);
        if (b) bracketBranches.add(b);
      }
      // Inline Task subagent usage lives ONLY on this result (its turns are not in
      // this transcript). Collect the per-invocation record now; folding it into the
      // session token totals is DEFERRED to after the loop, where the richer
      // FILE-based subagent plane (when present) supersedes this inline one.
      const sub = subagentFromToolResult(o.toolUseResult, lastTaskTs, o.timestamp || null);
      if (sub) {
        inlineSubagents.push(sub);
        lastTaskTs = null; // consume the paired dispatch timestamp
      }

      // Structural line counts from Edit/MultiEdit/Write results (counts only;
      // content classified in-memory then discarded — never returned).
      accumulateStructural(o.toolUseResult, struct);
    }
  }

  // Branch precedence: row .gitBranch (non-HEAD) → bracket branch.
  let branch = null;
  if (rowBranches.size > 0) branch = [...rowBranches][0];
  else if (bracketBranches.size > 0) branch = [...bracketBranches][0];

  // Primary model: first seen (contract `model` is a single string).
  // `<synthetic>` already excluded above.
  const model = models.size ? [...models][0] : null;

  const startedAt = tMin !== null ? new Date(tMin).toISOString() : null;
  const endedAt = tMax !== null ? new Date(tMax).toISOString() : null;
  const durationMs = tMin !== null && tMax !== null ? tMax - tMin : null;

  // Subagent plane. Named / backgrounded / worktree-isolated Agent workers write
  // their OWN transcripts to <projectsRoot>/*/<sessionId>/subagents/agent-*.jsonl;
  // their turns are NEVER inline in this transcript. Capture them from those files.
  // The file plane is a STRICT SUPERSET of the inline-Task plane (every inline Task
  // subagent also has a file, plus backgrounded workers that emit no inline usage),
  // so whenever any files exist they SUPERSEDE the inline records — preventing the
  // double counting that summing both planes would cause. Fall back to the inline
  // plane only when no files exist (older Claude Code that didn't write subagent
  // transcripts). `extra.withFileSubagents === false` (set when parsing the worker
  // files themselves) bounds discovery to ONE level.
  const fileSubs =
    extra.withFileSubagents === false
      ? []
      : subagentsFromFiles(transcriptPath, extra.sessionId || sessionId);
  const subagents = fileSubs.length ? fileSubs : inlineSubagents;

  // Fold the chosen plane's tokens into the session totals. Additive (those turns
  // are not inline here), so the materialized session cost_usd reflects the WHOLE
  // body of work — orchestrator parent + every subagent — not just the conductor.
  for (const sa of subagents) {
    tokensIn += sa.input_tokens || 0;
    tokensOut += sa.output_tokens || 0;
    cacheCreate += sa.cache_creation_tokens || 0;
    cacheRead += sa.cache_read_tokens || 0;
  }

  // Union subagent-observed commit SHAs into the session-level commitSHA. Worker
  // commits (often in worktree-isolated checkouts) never appear in the parent
  // transcript, so without this they are lost to attribution. PREPEND them, before
  // the parent-observed SHAs: ingest derives the primary git_commit_id from
  // commitSHA[-1] (the session's landed commit), so a subagent SHA must never
  // displace the parent's most-recent commit as primary. Dedup preserves order and
  // keeps the parent SHAs' relative order (and thus the primary) intact.
  const parentShas = [...shaSet];
  const subagentShas = [];
  const seenShas = new Set(parentShas);
  for (const sa of subagents) {
    for (const sha of sa.commit_shas || []) {
      if (typeof sha === 'string' && sha && !seenShas.has(sha)) {
        seenShas.add(sha);
        subagentShas.push(sha);
      }
    }
  }
  const commitSHA = subagentShas.length ? [...subagentShas, ...parentShas] : parentShas;

  const tool_uses = [...toolUseCounts.entries()].map(([name, count]) => ({
    name,
    count,
  }));
  const num_tool_calls = tool_uses.reduce((acc, t) => acc + t.count, 0);

  // Title precedence: a user-set custom title overrides Claude's AI title.
  const title = cap(customTitle || aiTitle || null, CAP_TITLE);

  const payload = {
    sessionId: extra.sessionId || sessionId,
    device_uuid: extra.device_uuid != null ? extra.device_uuid : null,
    title,
    model: cap(model, CAP_LABEL),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    repo: extra.repo || repo,   // UNBOUNDED: full cwd/path (folder->org attribution)
    branch: cap(branch, CAP_PATH),
    commitSHA,
    num_turns: numTurns,
    num_tool_calls,
    tool_uses,
    ...struct,
    claude_code: {
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreate,
      service_tier: cap(serviceTier, CAP_LABEL),
      stop_reason: cap(stopReason, CAP_LABEL),
      version: cap(version, CAP_LABEL),
      subagents,
    },
  };

  return payload;
}

module.exports = {
  SHA_RE,
  extractShasFromToolResult,
  branchFromBracketLine,
  subagentFromToolResult,
  classify,
  syntaxForPath,
  isGeneratedPath,
  accumulateStructural,
  newStructAccumulator,
  expandHome,
  subagentNameFromFile,
  subagentsFromFiles,
  parseClaudeCodeTranscript,
};
