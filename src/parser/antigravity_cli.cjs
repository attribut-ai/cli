'use strict';

// ATTRIBUT — Google Antigravity (`agy`) transcript parser (allowlist extractor).
//
// HARD CONSTRAINT (identical to the Claude parser): this module reads ONLY a
// local `transcript_full.jsonl` file and returns ONLY the allowlist of safe,
// signal-bearing fields named in the FROZEN contract (antigravityPayload in
// src/contract/envelope.schema.json). It NEVER reads or returns prompt text,
// model response bodies (`content`/`thinking`), file/diff contents, tool input
// args, or commit bodies. Structural line text is classified (code/comment/
// blank) and measured IN MEMORY, then DISCARDED — only the classification enum
// and the line LENGTH leave, as integers.
//
// Token usage is NOT in the transcript (it lives only in the per-conversation
// SQLite store). The collector fills payload.antigravity.usage_raw separately
// via the fail-safe token module; this parser sets it null.
//
// Transcript shape (one JSON object per line, verified against agy 1.0.8):
//   { type, source, status, step_index, created_at, content?, tool_calls?,
//     thinking?, error? }
//   - model turns: type "PLANNER_RESPONSE", source "MODEL", optional
//     tool_calls: [{ name, args:{...} }]
//   - tool results: typed steps (RUN_COMMAND, CODE_ACTION, LIST_DIRECTORY, ...),
//     whose `content` is the (string) tool output.

const fs = require('fs');
const path = require('path');

// Reuse the provider-agnostic primitives from the Claude parser: line
// classification, comment-syntax lookup, the structural accumulator, the git
// commit SHA regex, the bracket-branch helper, and ~ expansion.
const {
  cap,
  classify,
  syntaxForPath,
  isGeneratedPath,
  newStructAccumulator,
  SHA_RE,
  branchFromBracketLine,
  expandHome,
} = require('./claude_code.cjs');

const agyTokens = require('./antigravity_tokens.cjs');

// String caps, mirroring the schema's maxLength bounds (defense-in-depth).
const CAP_TITLE = 200;
const CAP_PATH = 256; // branch
const CAP_REPO = 2000; // repo — generous, absorbs very long cwd/folder paths
const CAP_LABEL = 128; // model / version / reason / agent_type / status

// Split content into lines, dropping the spurious empty element a trailing
// newline produces (so an N-line block counts as N lines).
function splitLines(content) {
  const parts = content.split('\n');
  if (parts.length > 0 && content.endsWith('\n')) parts.pop();
  return parts;
}

// Trim identical leading + trailing lines shared by `before` and `after`,
// returning [removedMiddle, addedMiddle] — the lines that actually changed. This
// turns agy's replace (a contiguous before/after block) into precise +/- counts,
// the analogue of Claude's structuredPatch +/- lines (vs. counting the whole
// block). Reads line text only to compare; never retains it.
function trimCommon(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }
  return [before.slice(start, endB), after.slice(start, endA)];
}

// Classify each line of `lines` and fold counts into `struct` as added or
// removed. Char stats are kept on ADDED lines only (mirrors the Claude parser).
function classifyInto(lines, syntax, kind /* 'add' | 'remove' */, struct) {
  const blockState = { open: null }; // fresh per block
  for (const text of lines) {
    if (typeof text !== 'string') continue;
    const cls = classify(text, syntax, blockState);
    if (kind === 'add') {
      if (cls === 'code') struct.lines_code_added += 1;
      else if (cls === 'comment') struct.lines_comment_added += 1;
      else struct.lines_blank_added += 1;
      const len = text.length;
      struct.added_char_n += 1;
      struct.added_char_sum += len;
      struct.added_char_sumsq += len * len;
    } else {
      if (cls === 'code') struct.lines_code_removed += 1;
      else if (cls === 'comment') struct.lines_comment_removed += 1;
      else struct.lines_blank_removed += 1;
    }
  }
}

// One replace: `before` (TargetContent) → `after` (ReplacementContent) on `target`.
function applyReplace(target, before, after, struct) {
  if (typeof target !== 'string') return;
  if (isGeneratedPath(target)) return; // skip generated/vendored
  const syntax = syntaxForPath(target);
  const beforeLines = typeof before === 'string' ? splitLines(before) : [];
  const afterLines = typeof after === 'string' ? splitLines(after) : [];
  const [removed, added] = trimCommon(beforeLines, afterLines);
  classifyInto(removed, syntax, 'remove', struct);
  classifyInto(added, syntax, 'add', struct);
}

// Accumulate structural line counts from a file-changing tool call into `struct`
// (the 9-key integer accumulator). Handles:
//   - write_to_file: whole new content (args.CodeContent) → all added.
//   - replace_file_content: before (args.TargetContent) → after
//     (args.ReplacementContent), diffed to precise +/- lines.
//   - multi_replace_file_content: an array of such chunks (best-effort).
// Reads content ONLY to classify + measure; never retains or emits it.
function accumulateFileChange(toolCall, struct) {
  if (!toolCall || typeof toolCall !== 'object') return;
  const args = toolCall.args;
  if (!args || typeof args !== 'object') return;

  if (toolCall.name === 'write_to_file') {
    if (
      typeof args.CodeContent === 'string' &&
      typeof args.TargetFile === 'string' &&
      !isGeneratedPath(args.TargetFile)
    ) {
      classifyInto(splitLines(args.CodeContent), syntaxForPath(args.TargetFile), 'add', struct);
    }
    return;
  }
  if (toolCall.name === 'replace_file_content') {
    applyReplace(args.TargetFile, args.TargetContent, args.ReplacementContent, struct);
    return;
  }
  if (toolCall.name === 'multi_replace_file_content') {
    // Best-effort: a list of replacement chunks under one of these keys. Each may
    // carry its own TargetFile, else inherit the call-level one.
    const chunks =
      args.ReplacementChunks || args.Replacements || args.replacements || args.chunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) {
        if (!c || typeof c !== 'object') continue;
        applyReplace(c.TargetFile || args.TargetFile, c.TargetContent, c.ReplacementContent, struct);
      }
    }
  }
}

// Extract git commit SHAs from a RUN_COMMAND result step's `content`. The
// content is command OUTPUT (stdout-equivalent); a `git commit` prints
// `[branch sha] subject`. Returns [{ sha, line }] — same contract as the Claude
// (extractShasFromToolResult) and Codex (extractShasFromOutput) siblings. Emits
// ONLY the SHA + its bracket line, never the surrounding content.
function extractShasFromRunCommand(content) {
  const found = [];
  if (typeof content !== 'string') return found;
  SHA_RE.lastIndex = 0;
  let m;
  while ((m = SHA_RE.exec(content)) !== null) {
    found.push({ sha: m[1], line: m[0] });
  }
  return found;
}

// Parse a single agy `transcript_full.jsonl` into the contract antigravity
// payload. `extra` may override { sessionId, repo, device_uuid } (the collector
// passes conversationId + workspace from the hook). THROWS on unreadable/garbage
// input (fail loud) — the collector decides whether to swallow.
function parseAntigravityTranscript(transcriptPath, extra = {}) {
  const abs = expandHome(transcriptPath);
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Transcript is empty: ${abs}`);
  }

  let tMin = null;
  let tMax = null;
  let numTurns = 0; // count of model PLANNER_RESPONSE steps
  const toolUseCounts = new Map(); // tool name -> count (names only)
  const shaSet = new Set();
  const bracketBranches = new Set();
  const struct = newStructAccumulator();
  let cwdFromCommand = null; // fallback repo: a run_command Cwd

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      // Tolerate a single unparseable line rather than losing the whole session.
      // transcript_full.jsonl is live-appended by the agent, so a hook routinely
      // observes a partial final line; skip it and keep going. A missing/unreadable
      // FILE still surfaces (fs.readFileSync above throws).
      continue;
    }

    if (o.created_at) {
      const t = Date.parse(o.created_at);
      if (!Number.isNaN(t)) {
        if (tMin === null || t < tMin) tMin = t;
        if (tMax === null || t > tMax) tMax = t;
      }
    }

    if (o.type === 'PLANNER_RESPONSE' && o.source === 'MODEL') {
      numTurns += 1;
    }

    // Tool-use NAMES + counts only (never the args). Also: classify write line
    // metrics, and remember a Cwd as a repo fallback. All from tool_calls.
    if (Array.isArray(o.tool_calls)) {
      for (const call of o.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        if (typeof call.name === 'string') {
          toolUseCounts.set(call.name, (toolUseCounts.get(call.name) || 0) + 1);
        }
        if (
          !cwdFromCommand &&
          call.args &&
          typeof call.args.Cwd === 'string' &&
          call.args.Cwd
        ) {
          cwdFromCommand = call.args.Cwd;
        }
        accumulateFileChange(call, struct);
      }
    }

    // git commit SHAs live in RUN_COMMAND result content (command output).
    if (o.type === 'RUN_COMMAND') {
      for (const hit of extractShasFromRunCommand(o.content)) {
        shaSet.add(hit.sha);
        const b = branchFromBracketLine(hit.line);
        if (b) bracketBranches.add(b);
      }
    }
  }

  const startedAt = tMin !== null ? new Date(tMin).toISOString() : null;
  const endedAt = tMax !== null ? new Date(tMax).toISOString() : null;
  const durationMs = tMin !== null && tMax !== null ? tMax - tMin : null;

  const tool_uses = [...toolUseCounts.entries()].map(([name, count]) => ({
    name: cap(name, CAP_LABEL),
    count,
  }));
  const num_tool_calls = tool_uses.reduce((acc, t) => acc + t.count, 0);

  const branch = bracketBranches.size > 0 ? [...bracketBranches][0] : null;
  const repo = extra.repo || cwdFromCommand || null;

  const payload = {
    sessionId: extra.sessionId || null,
    device_uuid: extra.device_uuid != null ? extra.device_uuid : null,
    // Title + model are not safely present in the transcript (model id lives in
    // the SQLite store; no allowlisted title row observed). Left null here; the
    // collector/token path may supply model later.
    title: cap(extra.title || null, CAP_TITLE),
    model: cap(extra.model || null, CAP_LABEL),
    // Tokens are NOT in the transcript — the collector injects usage_raw into
    // the antigravity sub-struct; these agnostic counters stay null (the server
    // derives semantic input/output from usage_raw).
    tokens_in: null,
    tokens_out: null,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    repo: cap(repo, CAP_REPO),   // full cwd/path (folder->org attribution)
    branch: cap(branch, CAP_PATH),
    commitSHA: [...shaSet],
    num_turns: numTurns,
    num_tool_calls,
    tool_uses,
    ...struct,
    antigravity: {
      usage_raw: null, // filled by the collector via the fail-safe token module
      version: null,
      reason: null,
      remoteSessionId: null,
      subagents: [],
    },
  };

  return payload;
}

// Brain transcript path for a conversation id (sibling of the conversations dir).
// AGY_BRAIN_DIR overrides for tests.
function brainTranscriptPath(conversationId) {
  const base =
    process.env.AGY_BRAIN_DIR ||
    path.join(path.dirname(agyTokens.conversationsDir()), 'brain');
  return path.join(
    base,
    path.basename(String(conversationId || '')),
    '.system_generated',
    'logs',
    'transcript_full.jsonl'
  );
}

// Parse a PARENT transcript for the subagent declarations: the names it defined
// (define_subagent.args.name) and the {TypeName → Role} labels it invoked with
// (invoke_subagent.args.Subagents[]). These are short, content-safe labels — we
// never read the subagent's system_prompt/Prompt. Returns { names, roleByName }.
function extractSubagentDecls(parentTranscriptPath) {
  const names = new Set();
  const roleByName = {};
  let raw;
  try {
    raw = fs.readFileSync(expandHome(parentTranscriptPath), 'utf8');
  } catch {
    return { names: [], roleByName };
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(o.tool_calls)) continue;
    for (const call of o.tool_calls) {
      if (!call || typeof call !== 'object') continue;
      const args = call.args || {};
      if (call.name === 'define_subagent' && typeof args.name === 'string') {
        names.add(cap(args.name, CAP_LABEL));
      }
      const subs = args.Subagents || args.subagents;
      if (Array.isArray(subs)) {
        for (const s of subs) {
          if (!s || typeof s !== 'object') continue;
          if (typeof s.TypeName === 'string') {
            const t = cap(s.TypeName, CAP_LABEL);
            names.add(t);
            if (typeof s.Role === 'string') roleByName[t] = cap(s.Role, CAP_LABEL);
          }
        }
      }
    }
  }
  return { names: [...names], roleByName };
}

// Derive a child's stats from its own transcript in a single pass: the per-tool
// tool_uses breakdown (same { name, count } shape as a regular session) + total,
// and the session window (started_at/ended_at/duration_ms from min/max per-line
// `created_at`, mirroring the parent's own time derivation). Names, counts, and
// timestamps only. Fail-safe: returns empty/null fields on any error.
function childStats(childTranscriptPath) {
  const counts = new Map(); // tool name -> count (names only)
  let tMin = null;
  let tMax = null;
  let raw;
  try {
    raw = fs.readFileSync(expandHome(childTranscriptPath), 'utf8');
  } catch {
    return { tool_uses: [], tool_use_count: 0, started_at: null, ended_at: null, duration_ms: null };
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.created_at) {
        const t = Date.parse(o.created_at);
        if (!Number.isNaN(t)) {
          if (tMin === null || t < tMin) tMin = t;
          if (tMax === null || t > tMax) tMax = t;
        }
      }
      if (!Array.isArray(o.tool_calls)) continue;
      for (const call of o.tool_calls) {
        if (call && typeof call.name === 'string') {
          const name = cap(call.name, CAP_LABEL);
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
    } catch {
      /* skip */
    }
  }
  const tool_uses = [...counts.entries()].map(([name, count]) => ({ name, count }));
  const tool_use_count = tool_uses.reduce((acc, t) => acc + t.count, 0);
  return {
    tool_uses,
    tool_use_count,
    started_at: tMin !== null ? new Date(tMin).toISOString() : null,
    ended_at: tMax !== null ? new Date(tMax).toISOString() : null,
    duration_ms: tMin !== null && tMax !== null ? tMax - tMin : null,
  };
}

// Build the parent's nested subagents[] (Claude-style). For each child of
// `parentConversationId` (found by reverse parent-link): its agent_type (matched
// from the parent's declared names), role, model, per-tool tool_uses breakdown +
// total tool_use_count, semantic input/output tokens, and the child's session
// window (started_at/ended_at/duration_ms from its own transcript). Numbers +
// content-safe labels only. Returns [] if none / on any failure (never throws).
function buildAntigravitySubagents(parentTranscriptPath, parentConversationId) {
  try {
    const children = agyTokens.findChildren(parentConversationId);
    if (!children.length) return [];
    const { names, roleByName } = extractSubagentDecls(parentTranscriptPath);
    const out = [];
    for (const childId of children) {
      const agentType = agyTokens.readAgentType(childId, names);
      // One combined gen_metadata read for both usage and model, instead of
      // readUsageInputOutput()+readModel() each re-opening/re-scanning the DB.
      const gen = agyTokens.readGenMetadata(childId);
      const usage = agyTokens.usageInputOutput(gen.usageRaw) || { input: 0, output: 0 };
      const { tool_uses, tool_use_count, started_at, ended_at, duration_ms } = childStats(
        brainTranscriptPath(childId)
      );
      out.push({
        agent_type: agentType ? cap(agentType, CAP_LABEL) : null,
        role: agentType && roleByName[agentType] ? roleByName[agentType] : null,
        model: cap(gen.model, CAP_LABEL),
        status: 'completed',
        tool_uses,
        tool_use_count,
        input_tokens: usage.input,
        output_tokens: usage.output,
        started_at,
        ended_at,
        duration_ms,
      });
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = {
  accumulateFileChange,
  applyReplace,
  trimCommon,
  extractShasFromRunCommand,
  parseAntigravityTranscript,
  extractSubagentDecls,
  brainTranscriptPath,
  buildAntigravitySubagents,
};
