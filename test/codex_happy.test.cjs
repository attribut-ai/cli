'use strict';

// Field-coverage for the Codex rollout parser: every contract field the rollout
// can supply is asserted here against a synthetic, real-shaped fixture
// (test/fixtures/codex/rollout.jsonl) plus its subagent child (subagent.jsonl).
// Also proves the metadata-only guarantee: no prompt/reasoning/assistant/diff
// body ever reaches the payload.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const codex = require('../src/parser/codex.cjs');
const { buildAndValidate, validateEnvelope } = require('../src/envelope.cjs');

const FIX_DIR = path.join(__dirname, 'fixtures', 'codex');
const PARENT = path.join(FIX_DIR, 'rollout.jsonl');
const CHILD = path.join(FIX_DIR, 'subagent.jsonl');

// Parse the parent WITHOUT the subagent plane for deterministic base assertions.
function parseBase() {
  return codex.parseCodexRollout(PARENT, {
    device_uuid: 'dev-abcd',
    withSubagents: false,
  });
}

test('sessionId / device_uuid / repo / model / effort / cli_version', () => {
  const p = parseBase();
  assert.strictEqual(p.sessionId, '00000000-0000-7000-8000-000000000001');
  assert.strictEqual(p.device_uuid, 'dev-abcd');
  assert.strictEqual(p.repo, '/repo');
  assert.strictEqual(p.model, 'gpt-5.4-mini');
  assert.strictEqual(p.codex.effort, 'low');
  assert.strictEqual(p.codex.cli_version, '0.139.0');
  assert.strictEqual(p.title, null);
});

test('DISJOINT token contract: in = input − cached, out whole, cache_read = cached', () => {
  const p = parseBase();
  assert.strictEqual(p.tokens_in, 600); // 1000 − 400
  assert.strictEqual(p.tokens_out, 200);
  assert.strictEqual(p.codex.cache_read_tokens, 400);
  assert.strictEqual(p.codex.cache_creation_tokens, null);
  assert.strictEqual(p.codex.reasoning_output_tokens, 50);
});

test('branch + commit SHA extracted from git meta / bracket', () => {
  const p = parseBase();
  assert.strictEqual(p.branch, 'main');
  assert.deepStrictEqual(p.commitSHA, ['a1b2c3d']);
});

test('timestamps + duration derive from row timestamp min/max', () => {
  const p = parseBase();
  assert.strictEqual(p.started_at, '2026-06-14T15:09:11.000Z');
  assert.strictEqual(p.ended_at, '2026-06-14T15:10:00.000Z');
  assert.strictEqual(p.duration_ms, 49000);
});

test('num_turns counts agent_message; tool_uses are names+counts only', () => {
  const p = parseBase();
  assert.strictEqual(p.num_turns, 1);
  assert.deepStrictEqual(
    p.tool_uses.map((t) => [t.name, t.count]),
    [['exec_command', 1], ['apply_patch', 1]]
  );
  assert.strictEqual(p.num_tool_calls, 2);
});

test('structural line metrics from patch_apply_end unified_diff', () => {
  const p = parseBase();
  // diff: +comment, +code, +blank, -code
  assert.strictEqual(p.lines_comment_added, 1);
  assert.strictEqual(p.lines_code_added, 1);
  assert.strictEqual(p.lines_blank_added, 1);
  assert.strictEqual(p.lines_code_removed, 1);
  assert.strictEqual(p.lines_comment_removed, 0);
  assert.strictEqual(p.added_char_n, 3);
  assert.ok(p.added_char_sum > 0);
  assert.ok(p.added_char_sumsq > 0);
});

test('METADATA-ONLY: no prompt/reasoning/assistant/diff body leaks into payload', () => {
  const p = parseBase();
  const serialized = JSON.stringify(p);
  for (const secret of [
    'SECRET_PROMPT_TEXT',
    'SECRET_REASONING_BODY',
    'SECRET_ASSISTANT_BODY',
    'SECRET_DIFF_COMMENT',
    'oldsecret',
  ]) {
    assert.ok(!serialized.includes(secret), `LEAK: ${secret} in ${serialized}`);
  }
});

test('payload builds + validates as an openai/codex envelope', () => {
  const p = parseBase();
  p.ended_at = p.ended_at || new Date().toISOString();
  const env = buildAndValidate(p, {
    _trigger: 'stop',
    _source: 'cli',
    _provider: 'openai',
    _tool: 'codex',
  });
  assert.strictEqual(env.provider, 'openai');
  assert.strictEqual(env.tool, 'codex');
  const { valid, errors } = validateEnvelope(env);
  assert.ok(valid, `envelope invalid: ${JSON.stringify(errors)}`);
});

test('subagent plane: child nests with role/model/tokens; totals fold', () => {
  const prev = process.env.CODEX_SESSIONS_DIR;
  process.env.CODEX_SESSIONS_DIR = FIX_DIR; // both rollout + subagent live here
  try {
    const p = codex.parseCodexRollout(PARENT, { device_uuid: 'dev-abcd' });
    assert.strictEqual(p.codex.subagents.length, 1);
    const sa = p.codex.subagents[0];
    assert.strictEqual(sa.agent_type, 'Chandrasekhar');
    assert.strictEqual(sa.role, 'explorer');
    assert.strictEqual(sa.model, 'gpt-5.5');
    assert.strictEqual(sa.input_tokens, 4000); // 5000 − 1000
    assert.strictEqual(sa.output_tokens, 300);
    assert.strictEqual(sa.cache_read_tokens, 1000);
    // exec_command + apply_patch (the latter added to exercise the structural
    // line-count privacy assertions below).
    assert.strictEqual(sa.tool_use_count, 2);
    // Folded session totals = parent base + child.
    assert.strictEqual(p.tokens_in, 4600); // 600 + 4000
    assert.strictEqual(p.tokens_out, 500); // 200 + 300
    assert.strictEqual(p.codex.cache_read_tokens, 1400); // 400 + 1000
    // No child body leaks either.
    assert.ok(!JSON.stringify(p).includes('CHILD_SECRET_BODY'));

    // PRIVACY: subagent.jsonl's patch_apply_end carries CHILD_DIFF_SECRET_CODE_7b2c
    // on an added code line, plus a blank added line and a removed code line. The
    // child's own _struct (spread onto the public subagent record via `_struct` in
    // buildCodexSubagents, surfaced by cleanSubagents) must reflect that content as
    // INTEGER counts — while the code text itself must never appear anywhere.
    assert.strictEqual(sa.lines_code_added, 1, 'subagent code-added derived from its own diff');
    assert.strictEqual(sa.lines_blank_added, 1, 'subagent blank-added derived from its own diff');
    assert.strictEqual(sa.lines_code_removed, 1, 'subagent code-removed derived from its own diff');
    assert.ok(sa.added_char_n > 0, 'subagent added_char_n derived from its own diff');
    assert.ok(sa.added_char_sum > 0, 'subagent added_char_sum derived from its own diff');
    assert.ok(
      !JSON.stringify(p).includes('CHILD_DIFF_SECRET_CODE_7b2c'),
      'LEAK: subagent diff code sentinel found in parser payload'
    );

    // Also prove it survives full envelope build+validation without leaking.
    const env = buildAndValidate(p, {
      _trigger: 'stop',
      _source: 'cli',
      _provider: 'openai',
      _tool: 'codex',
    });
    assert.ok(
      !JSON.stringify(env).includes('CHILD_DIFF_SECRET_CODE_7b2c'),
      'LEAK: subagent diff code sentinel found in produced envelope'
    );
  } finally {
    if (prev === undefined) delete process.env.CODEX_SESSIONS_DIR;
    else process.env.CODEX_SESSIONS_DIR = prev;
  }
});

test('isCodexSubagentRollout: true for child, false for parent', () => {
  assert.strictEqual(codex.isCodexSubagentRollout(CHILD), true);
  assert.strictEqual(codex.isCodexSubagentRollout(PARENT), false);
});

test('disjointTokens clamps and maps buckets', () => {
  assert.deepStrictEqual(
    codex.disjointTokens({ input_tokens: 100, cached_input_tokens: 30, output_tokens: 40, reasoning_output_tokens: 5 }),
    { tokens_in: 70, cache_read_tokens: 30, cache_creation_tokens: null, tokens_out: 40, reasoning_output_tokens: 5 }
  );
  // cached > input never goes negative.
  assert.strictEqual(codex.disjointTokens({ input_tokens: 10, cached_input_tokens: 50 }).tokens_in, 0);
  // null usage → all zero.
  assert.strictEqual(codex.disjointTokens(null).tokens_in, 0);
});

test('empty rollout throws (fail loud)', () => {
  const tmp = path.join(os.tmpdir(), `codex-empty-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, '');
  try {
    assert.throws(() => codex.parseCodexRollout(tmp, {}));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('resolveRolloutPath prefers an existing transcript_path', () => {
  assert.strictEqual(codex.resolveRolloutPath({ transcriptPath: PARENT }), PARENT);
});

test('resolveRolloutPath globs by session_id under CODEX_SESSIONS_DIR', () => {
  // Real Codex rollout filenames embed the session id, e.g.
  // rollout-<ts>-<sessionId>.jsonl. Stage such a file in a temp sessions tree.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sessions-'));
  const day = path.join(root, '2026', '06', '14');
  fs.mkdirSync(day, { recursive: true });
  const sid = '00000000-0000-7000-8000-000000000002';
  const named = path.join(day, `rollout-2026-06-14T15-09-30-${sid}.jsonl`);
  fs.copyFileSync(CHILD, named);
  const prev = process.env.CODEX_SESSIONS_DIR;
  process.env.CODEX_SESSIONS_DIR = root;
  try {
    const got = codex.resolveRolloutPath({ sessionId: sid });
    assert.strictEqual(got, named);
  } finally {
    if (prev === undefined) delete process.env.CODEX_SESSIONS_DIR;
    else process.env.CODEX_SESSIONS_DIR = prev;
  }
});
