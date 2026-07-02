'use strict';

// CURSOR GATE TEST — posttooluseCanSkip must skip the full parse+POST when no
// new commit appeared in the bytes appended since the last fire, and must NOT
// skip once a `[branch sha]` commit line shows up.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-cursor-'));
const collector = require('../src/collector.cjs');

function freshTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-tx-'));
  return path.join(dir, 'transcript.jsonl');
}

test('skips when the appended tail has no new commit, fires when one appears', () => {
  const tp = freshTranscript();
  fs.writeFileSync(tp, '{"type":"user"}\n{"type":"assistant"}\n', 'utf8');
  const hook = { transcript_path: tp, session_id: 'sess-1' };

  // No commit in the transcript yet → safe to skip.
  assert.equal(collector.posttooluseCanSkip(hook), true);

  // A git commit lands → the new tail carries `[branch sha]` → must NOT skip.
  fs.appendFileSync(tp, '{"toolUseResult":{"stdout":"[main a1b2c3d] subject"}}\n', 'utf8');
  assert.equal(collector.posttooluseCanSkip(hook), false);

  // Nothing further appended → back to skipping (cursor advanced past the commit).
  assert.equal(collector.posttooluseCanSkip(hook), true);
});

test('a transcript that already contains a commit fires on first sight', () => {
  const tp = freshTranscript();
  fs.writeFileSync(tp, '{"toolUseResult":{"stdout":"[feature 0fedcba] x"}}\n', 'utf8');
  assert.equal(
    collector.posttooluseCanSkip({ transcript_path: tp, session_id: 'sess-2' }),
    false
  );
});

test('a missing transcript_path does not skip (do the full, loud-failing work)', () => {
  assert.equal(collector.posttooluseCanSkip({ session_id: 'sess-3' }), false);
});
