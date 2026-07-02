'use strict';

// Field-coverage for the Antigravity transcript parser: every agnostic contract
// field the agy transcript can supply is asserted here. The synthetic fixture
// (test/fixtures/agy/transcript_full.jsonl) exercises USER_INPUT, model turns,
// a write_to_file, a git commit, and tool calls.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const agy = require('../src/parser/antigravity_cli.cjs');
const { buildAndValidate, validateEnvelope } = require('../src/envelope.cjs');

let nodeSqlite = false;
try {
  const { getDatabaseClass } = require('../src/parser/antigravity_tokens.cjs');
  if (getDatabaseClass()) {
    nodeSqlite = true;
  }
} catch {
  nodeSqlite = false;
}

const FIXTURE = path.join(__dirname, 'fixtures', 'agy', 'transcript_full.jsonl');

function parse() {
  return agy.parseAntigravityTranscript(FIXTURE, {
    sessionId: 'conv-1234',
    repo: '/tmp/agy_fix',
    device_uuid: 'dev-abcd',
  });
}

test('sessionId / device_uuid / repo come from extra', () => {
  const p = parse();
  assert.strictEqual(p.sessionId, 'conv-1234');
  assert.strictEqual(p.device_uuid, 'dev-abcd');
  assert.strictEqual(p.repo, '/tmp/agy_fix');
});

test('timestamps + duration derive from step created_at min/max', () => {
  const p = parse();
  assert.strictEqual(p.started_at, '2026-06-13T00:58:12.000Z');
  assert.strictEqual(p.ended_at, '2026-06-13T00:58:21.000Z');
  assert.strictEqual(p.duration_ms, 9000);
});

test('num_turns counts model PLANNER_RESPONSE steps', () => {
  const p = parse();
  // steps 2,4,6,8,10 are PLANNER_RESPONSE/MODEL
  assert.strictEqual(p.num_turns, 5);
});

test('tool_uses are names + counts only; num_tool_calls is their sum', () => {
  const p = parse();
  assert.deepStrictEqual(
    p.tool_uses.map((t) => [t.name, t.count]),
    [['list_dir', 1], ['write_to_file', 1], ['run_command', 1], ['replace_file_content', 1]]
  );
  assert.strictEqual(p.num_tool_calls, 4);
});

test('commit SHA + branch are extracted from RUN_COMMAND output', () => {
  const p = parse();
  assert.deepStrictEqual(p.commitSHA, ['a1b2c3d']);
  assert.strictEqual(p.branch, 'feature/agy-test');
});

test('line metrics: write (creates) + replace (edit diff) → added/removed', () => {
  const p = parse();
  // write_to_file: "# comment"(comment), "def say_hello():"(code),
  //   "    print(...)"(code), ""(blank) → +1 comment, +2 code, +1 blank, 4 chars.
  // replace_file_content: before [def, print-before], after [def, print-after,
  //   return]. trimCommon drops the shared "def say_hello():" → -1 code (print
  //   before), +2 code (print after, return) → +2 char rows.
  assert.strictEqual(p.lines_comment_added, 1);
  assert.strictEqual(p.lines_code_added, 4); // 2 (write) + 2 (replace)
  assert.strictEqual(p.lines_blank_added, 1);
  assert.strictEqual(p.lines_code_removed, 1); // 1 (replace)
  assert.strictEqual(p.added_char_n, 6); // 4 (write) + 2 (replace added)
  assert.ok(p.added_char_sum > 0);
  assert.ok(p.added_char_sumsq > 0);
});

test('tokens stay null in the parser; antigravity sub-struct is present', () => {
  const p = parse();
  assert.strictEqual(p.tokens_in, null);
  assert.strictEqual(p.tokens_out, null);
  assert.strictEqual(p.model, null);
  assert.ok(p.antigravity && typeof p.antigravity === 'object');
  assert.strictEqual(p.antigravity.usage_raw, null); // collector injects later
  assert.deepStrictEqual(p.antigravity.subagents, []);
});

test('payload builds + validates as a google/antigravity envelope', () => {
  const p = parse();
  const env = buildAndValidate(p, {
    _trigger: 'posttooluse',
    _source: 'cli',
    _provider: 'google',
    _tool: 'antigravity',
  });
  assert.strictEqual(env.provider, 'google');
  assert.strictEqual(env.tool, 'antigravity');
  const { valid, errors } = validateEnvelope(env);
  assert.ok(valid, `envelope invalid: ${JSON.stringify(errors)}`);
});

test('usage_raw with dotted-path keys validates against the schema', () => {
  const p = parse();
  p.antigravity.usage_raw = { '1': 4, '10.1.1': 1020, '10.1.13.25.4.2': 1018 };
  const env = buildAndValidate(p, {
    _trigger: 'posttooluse',
    _source: 'cli',
    _provider: 'google',
    _tool: 'antigravity',
  });
  const { valid, errors } = validateEnvelope(env);
  assert.ok(valid, `envelope invalid: ${JSON.stringify(errors)}`);
});

test('empty transcript throws (fail loud)', () => {
  const os = require('os');
  const fs = require('fs');
  const tmp = path.join(os.tmpdir(), `agy-empty-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, '');
  try {
    assert.throws(() => agy.parseAntigravityTranscript(tmp, {}));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('trimCommon drops shared prefix/suffix → only changed lines', () => {
  // before: [a, OLD, c]  after: [a, NEW1, NEW2, c] → removed [OLD], added [NEW1,NEW2]
  const [removed, added] = agy.trimCommon(['a', 'OLD', 'c'], ['a', 'NEW1', 'NEW2', 'c']);
  assert.deepStrictEqual(removed, ['OLD']);
  assert.deepStrictEqual(added, ['NEW1', 'NEW2']);
  // identical → nothing changed
  assert.deepStrictEqual(agy.trimCommon(['x', 'y'], ['x', 'y']), [[], []]);
});

test('extractSubagentDecls pulls names + roles, never the prompt', () => {
  const os = require('os');
  const fs = require('fs');
  const tx = path.join(os.tmpdir(), `agy-parent-${process.pid}.jsonl`);
  fs.writeFileSync(
    tx,
    [
      JSON.stringify({ tool_calls: [{ name: 'define_subagent', args: { name: 'security-reviewer', system_prompt: 'SECRET_PROMPT_DO_NOT_READ' } }] }),
      JSON.stringify({ tool_calls: [{ name: 'invoke_subagent', args: { Subagents: [{ TypeName: 'security-reviewer', Role: 'Security Sentinel', Prompt: 'ALSO_SECRET' }] } }] }),
    ].join('\n')
  );
  try {
    const d = agy.extractSubagentDecls(tx);
    assert.deepStrictEqual(d.names, ['security-reviewer']);
    assert.strictEqual(d.roleByName['security-reviewer'], 'Security Sentinel');
    assert.ok(!JSON.stringify(d).includes('SECRET'));
  } finally {
    fs.unlinkSync(tx);
  }
});

test('buildSubagents nests children with type/role/model/tokens', { skip: !nodeSqlite }, () => {
  const os = require('os');
  const fs = require('fs');
  const { buildSyntheticDb } = require('./fixtures/agy/build_db.cjs');
  const conv = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sa-conv-'));
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sa-brain-'));
  const prevC = process.env.AGY_CONVERSATIONS_DIR;
  const prevB = process.env.AGY_BRAIN_DIR;
  process.env.AGY_CONVERSATIONS_DIR = conv;
  process.env.AGY_BRAIN_DIR = brain;
  // readParentId requires a real UUID at path 5.
  const PA = '11111111-1111-1111-1111-111111111111';
  const K1 = '22222222-2222-2222-2222-222222222222';
  const K2 = '33333333-3333-3333-3333-333333333333';
  try {
    buildSyntheticDb(conv, PA, { input: 100, output: 10 });
    buildSyntheticDb(conv, K1, { input: 5000, output: 800, parentId: PA, agentType: 'security-reviewer' });
    buildSyntheticDb(conv, K2, { input: 3000, output: 400, parentId: PA, agentType: 'performance-reviewer' });
    // child transcripts (for tool_uses breakdown + tool_use_count + window). K1
    // mixes tool names across multiple calls/lines; K2 repeats one tool. Each line
    // carries a `created_at` so started_at/ended_at derive from min/max.
    const childCalls = {
      [K1]: [
        { tools: ['view_file', 'run_command'], created_at: '2026-06-13T00:58:12Z' },
        { tools: ['view_file'], created_at: '2026-06-13T00:58:21Z' },
      ], // view_file x2, run_command x1; window 12→21
      [K2]: [
        { tools: ['view_file'], created_at: '2026-06-13T00:59:05Z' },
        { tools: ['view_file'], created_at: '2026-06-13T00:59:07Z' },
      ], // view_file x2
    };
    for (const [id, lineSpecs] of Object.entries(childCalls)) {
      const dir = path.join(brain, id, '.system_generated', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const lines = lineSpecs.map((spec) =>
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          created_at: spec.created_at,
          tool_calls: spec.tools.map((name) => ({ name })),
        })
      );
      fs.writeFileSync(path.join(dir, 'transcript_full.jsonl'), lines.join('\n'));
    }
    // parent transcript declaring the subagents
    const ptx = path.join(brain, 'parent.jsonl');
    fs.writeFileSync(
      ptx,
      [
        JSON.stringify({ tool_calls: [{ name: 'define_subagent', args: { name: 'security-reviewer' } }] }),
        JSON.stringify({ tool_calls: [{ name: 'invoke_subagent', args: { Subagents: [{ TypeName: 'security-reviewer', Role: 'Security Sentinel' }, { TypeName: 'performance-reviewer', Role: 'Performance Oracle' }] } }] }),
      ].join('\n')
    );
    const subs = agy.buildSubagents(ptx, PA).sort((a, b) => a.agent_type.localeCompare(b.agent_type));
    assert.strictEqual(subs.length, 2);
    const sec = subs.find((s) => s.agent_type === 'security-reviewer');
    assert.strictEqual(sec.role, 'Security Sentinel');
    assert.strictEqual(sec.input_tokens, 5000);
    assert.strictEqual(sec.output_tokens, 800);
    assert.strictEqual(sec.tool_use_count, 3);
    // per-tool breakdown (same { name, count } shape as a regular session)
    assert.deepStrictEqual(
      [...sec.tool_uses].sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'run_command', count: 1 },
        { name: 'view_file', count: 2 },
      ]
    );
    // session window from the child's own transcript created_at (min/max)
    assert.strictEqual(sec.started_at, '2026-06-13T00:58:12.000Z');
    assert.strictEqual(sec.ended_at, '2026-06-13T00:58:21.000Z');
    assert.strictEqual(sec.duration_ms, 9000);
    const perf = subs.find((s) => s.agent_type === 'performance-reviewer');
    assert.deepStrictEqual(perf.tool_uses, [{ name: 'view_file', count: 2 }]);
    assert.strictEqual(perf.tool_use_count, 2);
    assert.strictEqual(perf.started_at, '2026-06-13T00:59:05.000Z');
    assert.strictEqual(perf.ended_at, '2026-06-13T00:59:07.000Z');
    assert.strictEqual(perf.duration_ms, 2000);
  } finally {
    if (prevC === undefined) delete process.env.AGY_CONVERSATIONS_DIR;
    else process.env.AGY_CONVERSATIONS_DIR = prevC;
    if (prevB === undefined) delete process.env.AGY_BRAIN_DIR;
    else process.env.AGY_BRAIN_DIR = prevB;
  }
});

test('multi_replace_file_content accumulates each chunk', () => {
  const { newStructAccumulator } = require('../src/parser/claude_code.cjs');
  const struct = newStructAccumulator();
  agy.accumulateFileChange(
    {
      name: 'multi_replace_file_content',
      args: {
        TargetFile: '/x/a.js',
        replacements: [
          { TargetContent: 'const x = 1;\n', ReplacementContent: 'const x = 2;\nconst y = 3;\n' },
        ],
      },
    },
    struct
  );
  // before [const x=1], after [const x=2, const y=3] (no shared lines) →
  // -1 code, +2 code.
  assert.strictEqual(struct.lines_code_removed, 1);
  assert.strictEqual(struct.lines_code_added, 2);
});
