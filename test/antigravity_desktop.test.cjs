'use strict';

// The Antigravity DESKTOP app's transcript format. It differs from the terminal
// CLI's: every tool result is a GENERIC step (no typed RUN_COMMAND step), file
// tools are write_file {Path, Content, Overwrite?, Append?, ArtifactMetadata?} and
// edit_file {Path, Target, Replacement, ArtifactMetadata?}, and run_command has no
// Cwd. The SYNTHETIC fixture (test/fixtures/agy/transcript_desktop.jsonl) covers:
//   group 1  write_file (counted) + read_file whose result holds "[notes abcdef1]"
//   group 2  edit_file + run_command → "[feature/desk 1a2b3c4] …" git output, with
//            a SYSTEM_MESSAGE carrying "[sys 2222222]" in between
//   group 3  an ArtifactMetadata write (not counted) + an Append write (counted)
//   group 4  two run_command calls but ONE result "[main 3333333]" (unpairable)
// plus a CHECKPOINT and a final tool-less PLANNER_RESPONSE. DESK_*_SECRET strings
// sit in every free-text position and must never reach an envelope.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-desk-cfg-'));

const agy = require('../src/parser/antigravity_cli.cjs');
const tokens = require('../src/parser/antigravity_tokens.cjs');
const collector = require('../src/collector.cjs');
const { validateEnvelope } = require('../src/envelope.cjs');
const { newStructAccumulator } = require('../src/parser/claude_code.cjs');
const { buildSyntheticDb, writeBrainTranscript } = require('./fixtures/agy/build_db.cjs');

const DESK = path.join(__dirname, 'fixtures', 'agy', 'transcript_desktop.jsonl');
const DESK_TEXT = fs.readFileSync(DESK, 'utf8');
const SECRETS = DESK_TEXT.match(/DESK_[A-Z_]+_SECRET/g);

let nodeSqlite = false;
try {
  if (tokens.getDatabaseClass()) nodeSqlite = true;
} catch {
  nodeSqlite = false;
}

const PARENT = 'dddddddd-0000-4000-8000-000000000001';
const CHILD = 'dddddddd-0000-4000-8000-000000000002';

// A desktop-format child transcript: one edit + one commit of its own, plus a
// commit SHA it shares with the parent (must not be duplicated at session level).
function childTranscript() {
  const t = (s) => `2026-07-01T11:00:${String(s).padStart(2, '0')}Z`;
  return [
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      created_at: t(0),
      tool_calls: [
        { name: 'edit_file', args: { Path: '/tmp/agy_desk/lib.js', Target: 'const a = 1;\n', Replacement: 'const a = 2;\nconst b = 3;\n' } },
        { name: 'run_command', args: { CommandLine: 'git commit -am "CHILD_COMMAND_SECRET"', WaitMsBeforeAsync: 500, toolSummary: 'c' } },
        { name: 'run_command', args: { CommandLine: 'git cherry-pick x', WaitMsBeforeAsync: 500, toolSummary: 'p' } },
      ],
    },
    { type: 'GENERIC', source: 'MODEL', created_at: t(1), content: 'Edited' },
    { type: 'GENERIC', source: 'MODEL', created_at: t(2), content: '[feature/child 4d5e6f7] CHILD_SUBJECT_SECRET\n 1 file changed' },
    { type: 'GENERIC', source: 'MODEL', created_at: t(3), content: '[feature/child 1a2b3c4] same commit the parent saw' },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n');
}

// One synthetic store (AGY_STORE_ROOTS) holding the parent + child in desktop format.
async function withDesktopStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-desk-store-'));
  const keys = ['AGY_STORE_ROOTS', 'AGY_CONVERSATIONS_DIR', 'AGY_BRAIN_DIR'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  delete process.env.AGY_CONVERSATIONS_DIR;
  delete process.env.AGY_BRAIN_DIR;
  process.env.AGY_STORE_ROOTS = root;
  try {
    const conv = path.join(root, 'conversations');
    const brain = path.join(root, 'brain');
    buildSyntheticDb(conv, PARENT, { input: 100, output: 10 });
    buildSyntheticDb(conv, CHILD, { input: 20, output: 2, parentId: PARENT });
    writeBrainTranscript(brain, CHILD, childTranscript());
    const hook = {
      conversationId: PARENT,
      transcriptPath: writeBrainTranscript(brain, PARENT, DESK_TEXT),
      workspacePaths: ['/synthetic/repo'],
      hookEventName: 'PostToolUse',
    };
    return await fn(hook);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('desktop format: write_file / edit_file / Append line counts; artifact writes excluded', () => {
  const p = agy.parseAntigravityTranscript(DESK, { sessionId: 'desk' });
  // write_file: "# …"(comment) "def f():"(code) "    return 1"(code) ""(blank)
  // edit_file:  -"    return 1"(code), +"    return 2"(code) +"    # …"(comment)
  // Append:     +"x = 3"(code)      ArtifactMetadata write: not counted.
  assert.strictEqual(p.lines_code_added, 4);
  assert.strictEqual(p.lines_comment_added, 2);
  assert.strictEqual(p.lines_blank_added, 1);
  assert.strictEqual(p.lines_code_removed, 1);
  assert.strictEqual(p.lines_comment_removed, 0);
  assert.strictEqual(p.added_char_n, 7);
  assert.strictEqual(p.num_turns, 5);
  assert.deepStrictEqual(
    Object.fromEntries(p.tool_uses.map((t) => [t.name, t.count])),
    { write_file: 3, read_file: 1, edit_file: 1, run_command: 3 }
  );
});

test('accumulateFileChange (desktop tools): Overwrite counted, generated paths + artifacts skipped', () => {
  const s = newStructAccumulator();
  agy.accumulateFileChange({ name: 'write_file', args: { Path: '/r/a.js', Content: 'a();\nb();\n', Overwrite: true } }, s);
  agy.accumulateFileChange({ name: 'write_file', args: { Path: '/r/node_modules/x/index.js', Content: 'gen();\n' } }, s);
  agy.accumulateFileChange({ name: 'edit_file', args: { Path: '/r/plan.md', Target: 'a\n', Replacement: 'b\nc\n', ArtifactMetadata: {} } }, s);
  agy.accumulateFileChange({ name: 'edit_file', args: { Path: '/r/b.js', Target: 'x();\n', Replacement: 'y();\n' } }, s);
  assert.strictEqual(s.lines_code_added, 3); // 2 (overwrite) + 1 (edit)
  assert.strictEqual(s.lines_code_removed, 1);
});

test('desktop format: SHAs come only from run_command results, paired in call order', () => {
  const p = agy.parseAntigravityTranscript(DESK, { sessionId: 'desk' });
  assert.deepStrictEqual(p.commitSHA, ['1a2b3c4']);
  assert.strictEqual(p.branch, 'feature/desk');
  // Negative controls: bracket-shaped text in a FILE READ result, in a
  // SYSTEM_MESSAGE, and in an unpairable group's output is never a SHA.
  for (const notSha of ['abcdef1', '2222222', '3333333']) {
    assert.ok(!p.commitSHA.includes(notSha), `captured ${notSha} from a non-command result`);
  }
});

test('commit tracker: positional pairing — the same text under a non-command call is ignored', () => {
  const run = (calls, results) => {
    const t = agy.newCommitTracker();
    t.step({ type: 'PLANNER_RESPONSE', tool_calls: calls.map((name) => ({ name })) });
    for (const content of results) t.step({ type: 'GENERIC', content });
    return t.finish().shas;
  };
  const out = '[main 1234567] subject';
  assert.deepStrictEqual(run(['run_command', 'read_file'], [out, 'x']), ['1234567']);
  assert.deepStrictEqual(run(['read_file', 'run_command'], [out, 'x']), []); // the read produced it
  assert.deepStrictEqual(run(['run_command'], [out, out]), []); // count mismatch → not guessed
  // Terminal-CLI typed step still works.
  const t = agy.newCommitTracker();
  t.step({ type: 'RUN_COMMAND', content: '[dev 89abcde] s' });
  assert.deepStrictEqual(t.finish(), { shas: ['89abcde'], branches: ['dev'] });
});

test('desktop subagents carry their own commit_shas + branch; the session folds them in ahead of the parent', { skip: !nodeSqlite }, async () => {
  await withDesktopStore(async (hook) => {
    const env = collector.buildAntigravityEnvelopeFromHook(hook, { trigger: 'posttooluse', source: 'cli' });
    const [sa] = env.payload.antigravity.subagents;
    assert.deepStrictEqual(sa.commit_shas, ['4d5e6f7', '1a2b3c4']);
    assert.strictEqual(sa.branch, 'feature/child');
    assert.strictEqual(sa.lines_code_added, 2); // its own edit_file
    assert.strictEqual(sa.lines_code_removed, 1);
    // Child-only SHA prepended; the parent's own (shared) SHA stays last = primary.
    assert.deepStrictEqual(env.payload.commitSHA, ['4d5e6f7', '1a2b3c4']);
    assert.strictEqual(env.payload.branch, 'feature/desk'); // session branch: the parent's own
    const { valid, errors } = validateEnvelope(env);
    assert.ok(valid, JSON.stringify(errors));
  });
});

test('desktop format: no free text (prompt, command line, output, file bodies, artifacts) reaches the envelope', { skip: !nodeSqlite }, async () => {
  assert.ok(SECRETS.length >= 12, 'fixture plants a sentinel in every free-text position');
  await withDesktopStore(async (hook) => {
    const s = JSON.stringify(collector.buildAntigravityEnvelopeFromHook(hook, { trigger: 'stop', source: 'cli' }));
    for (const secret of [...SECRETS, 'CHILD_COMMAND_SECRET', 'CHILD_SUBJECT_SECRET']) {
      assert.ok(!s.includes(secret), `LEAK: ${secret}`);
    }
  });
});

test('foldSubagentShas de-dups and keeps the parent order (primary = last)', () => {
  assert.deepStrictEqual(
    agy.foldSubagentShas(['aaaaaaa', 'bbbbbbb'], [{ commit_shas: ['ccccccc', 'aaaaaaa'] }, { commit_shas: ['ccccccc'] }, {}]),
    ['ccccccc', 'aaaaaaa', 'bbbbbbb']
  );
  assert.deepStrictEqual(agy.foldSubagentShas(['aaaaaaa'], []), ['aaaaaaa']);
});
