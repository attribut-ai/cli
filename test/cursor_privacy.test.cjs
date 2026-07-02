'use strict';

// CURSOR PRIVACY GOLDEN TEST — the collector reads Cursor's content-rich
// composerData/bubbles/transcript but must emit ONLY the numeric + model-id
// allowlist. Seed sentinel prompt/response/code/summary/todo/rule/path strings
// into every place Cursor stores content and assert NONE reach the envelope,
// while the allowlisted signal DOES.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCursorFixture } = require('./fixtures/cursor/build_db.cjs');

const CID = '22222222-2222-2222-2222-222222222222';

// Distinct sentinels, one per content channel Cursor persists.
const LEAKS = {
  title: 'LEAK_TITLE_a1',
  summary: 'LEAK_SUMMARY_b2',
  todo: 'LEAK_TODO_c3',
  rule: 'LEAK_RULE_d4',
  filepath: 'LEAK_FILEPATH_e5',
  prompt: 'LEAK_PROMPT_f6',
  response: 'LEAK_RESPONSE_g7',
  toolinput: 'LEAK_TOOLINPUT_h8',
  bubbletext: 'LEAK_BUBBLETEXT_i9',
};

test('no content leaks; only the numeric + model-id allowlist is emitted', () => {
  const fx = buildCursorFixture({
    composerId: CID,
    model: 'gemini-3-pro',
    usageData: { 'gemini-3-pro': { costInCents: 42, amount: 3 } },
    contextTokensUsed: 9000,
    contextTokenLimit: 200000,
    contextUsagePercent: 4.5,
    totalLinesAdded: 33,
    totalLinesRemoved: 4,
    filesChangedCount: 1,
    createdAt: 1762653135831,
    lastUpdatedAt: 1762653999999,
    bubbles: [
      { type: 1, inputTokens: 0, outputTokens: 0 },
      { type: 2, inputTokens: 4000, outputTokens: 500 },
    ],
    // content-bearing fields that MUST be ignored by the numbers-only reader:
    extra: {
      name: LEAKS.title,
      latestConversationSummary: { summary: LEAKS.summary },
      todos: [{ content: LEAKS.todo }],
      context: { cursorRules: [LEAKS.rule] },
      originalFileStates: { [`file:///Users/x/${LEAKS.filepath}.py`]: { content: 'x' } },
    },
    transcript: [
      { role: 'user', message: { content: [{ type: 'text', text: LEAKS.prompt }] } },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: LEAKS.response },
            { type: 'tool_use', name: 'Shell', input: { command: LEAKS.toolinput } },
          ],
        },
      },
    ],
  });

  // Seed a sentinel into a bubble's (unread) text field too.
  const { getDatabaseClass } = require('../src/parser/antigravity_tokens.cjs');
  const db = new (getDatabaseClass())(fx.dbPath);
  db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
    JSON.stringify({ type: 2, text: LEAKS.bubbletext, tokenCount: { inputTokens: 4000, outputTokens: 500 } }),
    `bubbleId:${CID}:b1`
  );
  db.close();

  const prevDb = process.env.CURSOR_STATE_DB;
  const prevCfg = process.env.ATTRIBUT_CONFIG_DIR;
  process.env.CURSOR_STATE_DB = fx.dbPath;
  process.env.ATTRIBUT_CONFIG_DIR = path.join(fx.dir, 'cfg');
  try {
    const collector = require('../src/collector.cjs');
    const env = collector.buildCursorEnvelopeFromHook(
      {
        conversation_id: CID,
        transcript_path: fx.transcriptPath,
        user_email: 'dev@example.com',
        cursor_version: '3.9.16',
        workspace_roots: ['/tmp/ws'],
        reason: 'completed',
      },
      { trigger: 'sessionend', source: 'cli' }
    );
    const blob = JSON.stringify(env);

    for (const [chan, sentinel] of Object.entries(LEAKS)) {
      assert.ok(!blob.includes(sentinel), `LEAK via ${chan}: ${sentinel} appeared in the envelope`);
    }

    // allowlisted signal survived
    assert.strictEqual(env.payload.model, 'gemini-3-pro');
    assert.strictEqual(env.payload.cursor.cost_cents, 42);
    assert.strictEqual(env.payload.cursor.context_tokens, 9000);
    assert.strictEqual(env.payload.cursor.output_tokens, 500);
    assert.strictEqual(env.payload.cursor.lines_added, 33);
    assert.strictEqual(env.payload.cursor.user_email, 'dev@example.com');
    assert.deepStrictEqual(env.payload.tool_uses, [{ name: 'Shell', count: 1 }]);
  } finally {
    if (prevDb === undefined) delete process.env.CURSOR_STATE_DB;
    else process.env.CURSOR_STATE_DB = prevDb;
    if (prevCfg === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
    else process.env.ATTRIBUT_CONFIG_DIR = prevCfg;
    try {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
