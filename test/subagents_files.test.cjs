'use strict';

// File-based subagent plane: named / backgrounded / worktree-isolated Agent workers
// write their OWN transcripts under <projectsRoot>/<proj>/<sessionId>/subagents/
// agent-<name>-<hex>.jsonl. The parser must discover them, fold their tokens into the
// session totals, expose them per-invocation (role from filename), and prefer the
// LARGEST copy when a worker appears in both the main and a worktree project dir.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parser = require('../src/parser/claude_code.cjs');

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// One assistant row with usage + a tool_use block, as a single-line transcript.
function assistantRow(ts, usage, toolName) {
  const content = [{ type: 'text', text: 'ok' }];
  if (toolName) content.push({ type: 'tool_use', name: toolName, input: {} });
  return JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    cwd: '/Users/test/repo',
    timestamp: ts,
    message: { role: 'assistant', model: 'claude-opus-4-8', usage, content },
  });
}

// Build a temp ~/.claude/projects-style tree. Returns { parentPath, cleanup }.
function buildTree({ workers }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-subs-'));
  const projects = path.join(root, 'projects');
  const proj = path.join(projects, '-Users-test-repo');
  const subDir = path.join(proj, SID, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });

  // Parent transcript: 1 assistant row, 1000 in / 400 out.
  const parentPath = path.join(proj, `${SID}.jsonl`);
  fs.writeFileSync(
    parentPath,
    assistantRow('2026-06-15T10:00:00.000Z', { input_tokens: 1000, output_tokens: 400 }, 'Agent') + '\n'
  );

  for (const w of workers) {
    const lines = w.rows.map((r) => assistantRow(r.ts, r.usage, r.tool)).join('\n') + '\n';
    fs.writeFileSync(path.join(w.dir ? mkProj(projects, w.dir, subDir) : subDir, w.file), lines);
  }
  return { parentPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Create an alternate (worktree) project dir's subagents folder and return it.
function mkProj(projects, name, _main) {
  const d = path.join(projects, name, SID, 'subagents');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('file-plane subagents are discovered, folded, and labelled by filename role', () => {
  const { parentPath, cleanup } = buildTree({
    workers: [
      {
        file: 'agent-gen3-eval-build-deadbeef0000.jsonl',
        rows: [
          { ts: '2026-06-15T10:05:00.000Z', usage: { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 }, tool: 'Bash' },
          { ts: '2026-06-15T10:20:00.000Z', usage: { input_tokens: 1000, output_tokens: 200 }, tool: 'Read' },
        ],
      },
    ],
  });
  try {
    const p = parser.parseClaudeCodeTranscript(parentPath, { sessionId: SID });
    const subs = p.claude_code.subagents;
    assert.strictEqual(subs.length, 1, 'one file-plane subagent');
    const s = subs[0];
    assert.strictEqual(s.role, 'gen3-eval-build', 'role recovered from filename');
    assert.strictEqual(s.agent_type, null, 'agent_type not read from forbidden tool input');
    assert.strictEqual(s.status, 'completed');
    assert.strictEqual(s.model, 'claude-opus-4-8');
    assert.strictEqual(s.input_tokens, 3000);
    assert.strictEqual(s.output_tokens, 1000);
    assert.strictEqual(s.cache_read_tokens, 5000);
    assert.strictEqual(s.duration_ms, 15 * 60 * 1000, 'real child window from first/last row');
    // tool_uses breakdown is per-subagent and real.
    assert.deepStrictEqual(
      s.tool_uses.sort((a, b) => a.name.localeCompare(b.name)),
      [{ name: 'Bash', count: 1 }, { name: 'Read', count: 1 }]
    );
    // Session totals fold parent (1000/400) + worker (3000/1000).
    assert.strictEqual(p.tokens_in, 4000);
    assert.strictEqual(p.tokens_out, 1400);
    assert.strictEqual(p.claude_code.cache_read_tokens, 5000);
  } finally {
    cleanup();
  }
});

test('duplicate worker copies: the LARGEST (complete) transcript wins, not first-seen', () => {
  const { parentPath, cleanup } = buildTree({
    workers: [
      // Stub copy in the main project dir (1 short row).
      {
        file: 'agent-hm2-sweep-cafef00d1234.jsonl',
        rows: [{ ts: '2026-06-15T10:05:00.000Z', usage: { input_tokens: 10, output_tokens: 5 }, tool: 'Bash' }],
      },
      // Complete copy in a worktree project dir (many bigger rows → larger file).
      {
        dir: '-Users-test-repo--claude-worktrees-hm2',
        file: 'agent-hm2-sweep-cafef00d1234.jsonl',
        rows: Array.from({ length: 6 }, (_, i) => ({
          ts: `2026-06-15T10:1${i}:00.000Z`,
          usage: { input_tokens: 5000, output_tokens: 3000 },
          tool: 'Bash',
        })),
      },
    ],
  });
  try {
    const p = parser.parseClaudeCodeTranscript(parentPath, { sessionId: SID });
    assert.strictEqual(p.claude_code.subagents.length, 1, 'deduped to one');
    // The complete worktree copy: 6 rows × 3000 out = 18000 (not the 5-token stub).
    assert.strictEqual(p.claude_code.subagents[0].output_tokens, 18000);
  } finally {
    cleanup();
  }
});

test('no subagent files → fall back to inline plane (back-compat, no regression)', () => {
  // A parent with an inline Task result but NO subagents/ dir keeps the legacy path.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-subs-'));
  const proj = path.join(root, 'projects', '-Users-test-repo');
  fs.mkdirSync(proj, { recursive: true });
  const parentPath = path.join(proj, `${SID}.jsonl`);
  const inlineResult = JSON.stringify({
    type: 'user',
    sessionId: SID,
    timestamp: '2026-06-15T10:00:30.000Z',
    toolUseResult: {
      agentType: 'general-purpose',
      resolvedModel: 'claude-haiku-4-5-20251001',
      status: 'completed',
      usage: { input_tokens: 4000, output_tokens: 600 },
    },
  });
  fs.writeFileSync(
    parentPath,
    assistantRow('2026-06-15T10:00:00.000Z', { input_tokens: 100, output_tokens: 50 }, 'Task') + '\n' + inlineResult + '\n'
  );
  try {
    const p = parser.parseClaudeCodeTranscript(parentPath, { sessionId: SID });
    assert.strictEqual(p.claude_code.subagents.length, 1, 'inline subagent still captured');
    assert.strictEqual(p.claude_code.subagents[0].agent_type, 'general-purpose');
    // inline tokens folded: in 100+4000=4100, out 50+600=650.
    assert.strictEqual(p.tokens_in, 4100);
    assert.strictEqual(p.tokens_out, 650);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
