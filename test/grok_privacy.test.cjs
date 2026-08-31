'use strict';

// GROK PRIVACY GOLDEN TEST — the load-bearing guard for the grok parser.
//
// The synthetic fixture plants sentinel strings in every prohibited location:
// user/assistant text and tool args / lastAssistantMessage in updates.jsonl
// (outside the usage object), tool input/output on events.jsonl, summary recap
// fields, and the forbidden files chat_history.jsonl / system_prompt.txt /
// prompt_context.json. This test asserts NONE of those sentinels appear in the
// produced envelope JSON.
//
// EXCEPTION: `title` is the one authorized content-derived field (generated_title).
// ALLOWED_TITLE_SENTINEL is therefore excluded from leak assertions; a positive
// control proves the title IS captured.
//
// The subagent plane gets the same treatment: `subagents/<childId>/meta.json` is
// allowlisted field-by-field (its `prompt` is the worker's full task text and is
// NEVER copied) and its sibling `output.json` — the worker's verbatim answer — is
// NEVER opened at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const grok = require('../src/parser/grok.cjs');
const { buildAndValidate } = require('../src/envelope.cjs');

const SESSION = path.join(__dirname, 'fixtures', 'grok', 'session');

const SENTINELS = [
  'SECRET_UPDATES_USER_PROMPT',
  'SECRET_UPDATES_ASSISTANT_BODY',
  'SECRET_UPDATES_TOOL_ARG',
  'SECRET_LAST_ASSISTANT',
  'SECRET_EVENTS_TOOL_ARG',
  'SECRET_EVENTS_TOOL_OUTPUT',
  'SECRET_CHAT_HISTORY_PROMPT',
  'SECRET_CHAT_HISTORY_RESPONSE',
  'SECRET_SYSTEM_PROMPT',
  'SECRET_PROMPT_CONTEXT',
  'SECRET_SUMMARY_RECAP',
  'SECRET_SESSION_RECAP',
  'SECRET_SUBAGENT_PROMPT',
  'SECRET_SUBAGENT_OUTPUT',
];

const FORBIDDEN_BASENAMES = ['chat_history.jsonl', 'system_prompt.txt', 'prompt_context.json'];

// output.json lives beside the one allowlisted subagent file (meta.json) and is
// content end-to-end — opening it at all is a failure.
const FORBIDDEN_SUBAGENT_BASENAMES = ['output.json'];

const CHILD_ID = '01990000-0000-7000-8000-0000000000c1';
const CHILD_CWD = '/repo/grok-worker';
const PARENT_CWD = '/repo/grok-demo';
const PARENT_ID = '01990000-0000-7000-8000-000000000001';

// Stage a sessions root holding the sentinel fixture as the parent PLUS one
// worker: a `subagents/<childId>/` record whose meta.json carries a sentinel
// `prompt` and whose output.json is pure sentinel, and the worker's own
// top-level session dir (the second copy Grok writes).
function stageParentWithSubagent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-grok-priv-'));
  const parentDir = path.join(root, encodeURIComponent(PARENT_CWD), PARENT_ID);
  fs.cpSync(SESSION, parentDir, { recursive: true });

  const childDir = path.join(root, encodeURIComponent(CHILD_CWD), CHILD_ID);
  fs.cpSync(SESSION, childDir, { recursive: true });
  const childSummary = JSON.parse(fs.readFileSync(path.join(childDir, 'summary.json'), 'utf8'));
  childSummary.info.id = CHILD_ID;
  childSummary.info.cwd = CHILD_CWD;
  fs.writeFileSync(path.join(childDir, 'summary.json'), JSON.stringify(childSummary));

  const recDir = path.join(parentDir, 'subagents', CHILD_ID);
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(
    path.join(recDir, 'meta.json'),
    JSON.stringify({
      subagent_id: CHILD_ID,
      parent_session_id: PARENT_ID,
      child_session_id: CHILD_ID,
      subagent_type: 'general-purpose',
      description: 'ALLOWED_ROLE_SENTINEL audit the widget',
      prompt: 'SECRET_SUBAGENT_PROMPT the full task text handed to the worker',
      status: 'completed',
      started_at: '2026-08-29T10:00:10.000Z',
      completed_at: '2026-08-29T10:01:00.000Z',
      duration_ms: 50000,
      tool_calls: 4,
      turns: 1,
      child_cwd: CHILD_CWD,
      effective_model_id: 'grok-4.6',
    })
  );
  fs.writeFileSync(
    path.join(recDir, 'output.json'),
    JSON.stringify({ schema_version: 1, output: 'SECRET_SUBAGENT_OUTPUT the worker answer' })
  );
  return { root, parentDir };
}

function withSessionsRoot(root, fn) {
  const prev = process.env.GROK_SESSIONS_DIR;
  process.env.GROK_SESSIONS_DIR = root;
  grok._resetSubagentCache();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GROK_SESSIONS_DIR;
    else process.env.GROK_SESSIONS_DIR = prev;
    grok._resetSubagentCache();
  }
}

test('no prohibited content appears anywhere in the envelope', () => {
  const payload = grok.parseGrokSession(SESSION, { device_uuid: 'test-device-uuid' });
  const envelope = buildAndValidate(payload, {
    _trigger: 'sessionend',
    _source: 'cli',
    _provider: 'xai',
    _tool: 'grok',
  });

  const serialized = JSON.stringify(envelope);
  for (const sentinel of SENTINELS) {
    assert.ok(!serialized.includes(sentinel), `LEAK: sentinel "${sentinel}" found in produced envelope`);
  }
});

test('parser output (pre-envelope) also contains no prohibited sentinels', () => {
  const payload = grok.parseGrokSession(SESSION);
  const serialized = JSON.stringify(payload);
  for (const sentinel of SENTINELS) {
    assert.ok(!serialized.includes(sentinel), `LEAK: sentinel "${sentinel}" found in parser payload`);
  }
});

test('title IS captured — the authorized content-derived exception (positive control)', () => {
  const payload = grok.parseGrokSession(SESSION);
  assert.strictEqual(payload.title, 'ALLOWED_TITLE_SENTINEL Refactor grok widget');
  assert.ok(
    JSON.stringify(payload).includes('ALLOWED_TITLE_SENTINEL'),
    'expected the authorized title to be present in the payload'
  );
});

test('parser never opens chat_history.jsonl / system_prompt.txt / prompt_context.json', () => {
  const opened = [];
  const origRead = fs.readFileSync;
  const origOpen = fs.openSync;
  fs.readFileSync = function spyRead(p, ...args) {
    opened.push(path.basename(String(p)));
    return origRead.call(fs, p, ...args);
  };
  fs.openSync = function spyOpen(p, ...args) {
    opened.push(path.basename(String(p)));
    return origOpen.call(fs, p, ...args);
  };
  try {
    grok.parseGrokSession(SESSION);
  } finally {
    fs.readFileSync = origRead;
    fs.openSync = origOpen;
  }
  for (const name of FORBIDDEN_BASENAMES) {
    assert.ok(!opened.includes(name), `opened forbidden file ${name}: ${opened.join(',')}`);
  }
  assert.ok(opened.includes('summary.json'), 'expected to read summary.json');
  assert.ok(opened.includes('updates.jsonl'), 'expected to scan updates.jsonl for usage');
});

test('subagent meta.json `prompt` and output.json never reach the envelope', () => {
  const { root, parentDir } = stageParentWithSubagent();
  withSessionsRoot(root, () => {
    const payload = grok.parseGrokSession(parentDir, { device_uuid: 'test-device-uuid' });
    // Positive control: the worker IS captured, so the leak assertions below are
    // testing a populated payload rather than an empty one.
    assert.strictEqual(payload.grok.subagents.length, 1);
    assert.strictEqual(payload.grok.subagents[0].role, 'ALLOWED_ROLE_SENTINEL audit the widget');

    const envelope = buildAndValidate(payload, {
      _trigger: 'sessionend',
      _source: 'cli',
      _provider: 'xai',
      _tool: 'grok',
    });
    const serialized = JSON.stringify(envelope);
    for (const sentinel of SENTINELS) {
      assert.ok(!serialized.includes(sentinel), `LEAK: sentinel "${sentinel}" found in envelope`);
    }
  });
});

test('parser never opens a subagent output.json', () => {
  const { root, parentDir } = stageParentWithSubagent();
  withSessionsRoot(root, () => {
    const opened = [];
    const origRead = fs.readFileSync;
    const origOpen = fs.openSync;
    fs.readFileSync = function spyRead(p, ...args) {
      opened.push(path.basename(String(p)));
      return origRead.call(fs, p, ...args);
    };
    fs.openSync = function spyOpen(p, ...args) {
      opened.push(path.basename(String(p)));
      return origOpen.call(fs, p, ...args);
    };
    try {
      grok.parseGrokSession(parentDir);
    } finally {
      fs.readFileSync = origRead;
      fs.openSync = origOpen;
    }
    for (const name of [...FORBIDDEN_BASENAMES, ...FORBIDDEN_SUBAGENT_BASENAMES]) {
      assert.ok(!opened.includes(name), `opened forbidden file ${name}: ${opened.join(',')}`);
    }
    assert.ok(opened.includes('meta.json'), 'expected to read the allowlisted subagent meta.json');
  });
});
