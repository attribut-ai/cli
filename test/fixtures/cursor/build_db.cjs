'use strict';

// Test helper: fabricate a Cursor state.vscdb (cursorDiskKV) + an agent transcript
// from a compact spec, so the parser/privacy tests exercise the real SQLite +
// JSONL read paths without depending on a live Cursor install.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getDatabaseClass } = require('../../../src/parser/antigravity_tokens.cjs');

// Build a state.vscdb + transcript for one composer (and optional subagents).
// Returns { dir, dbPath, transcriptPath, composerId }.
//
// spec = {
//   composerId, model, usageData?, contextTokensUsed?, contextTokenLimit?,
//   contextUsagePercent?, totalLinesAdded?, totalLinesRemoved?, filesChangedCount?,
//   createdAt?, lastUpdatedAt?, extra?  (extra content merged into composerData),
//   bubbles: [{ type, inputTokens, outputTokens }],  // in conversation order
//   transcript: [ raw JSONL objects ],
//   subagents?: [ nested spec-like { composerId, model, bubbles, ... } ],
// }
function buildCursorFixture(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-fx-'));
  const dbPath = path.join(dir, 'state.vscdb');
  const DB = getDatabaseClass();
  if (!DB) throw new Error('no SQLite driver available for fixture build');
  const db = new DB(dbPath);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  const ins = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');

  const writeComposer = (s) => {
    const headers = (s.bubbles || []).map((b, i) => ({ bubbleId: `b${i}`, type: b.type }));
    const composer = Object.assign(
      {
        composerId: s.composerId,
        modelConfig: { modelName: s.model, maxMode: false },
        contextTokensUsed: s.contextTokensUsed,
        contextTokenLimit: s.contextTokenLimit,
        contextUsagePercent: s.contextUsagePercent,
        totalLinesAdded: s.totalLinesAdded,
        totalLinesRemoved: s.totalLinesRemoved,
        filesChangedCount: s.filesChangedCount,
        createdAt: s.createdAt,
        lastUpdatedAt: s.lastUpdatedAt,
        fullConversationHeadersOnly: headers,
        subComposerIds: (s.subagents || []).map((x) => x.composerId),
      },
      s.usageData ? { usageData: s.usageData } : {},
      s.extra || {}
    );
    ins.run(`composerData:${s.composerId}`, JSON.stringify(composer));
    (s.bubbles || []).forEach((b, i) => {
      ins.run(
        `bubbleId:${s.composerId}:b${i}`,
        JSON.stringify({ type: b.type, tokenCount: { inputTokens: b.inputTokens, outputTokens: b.outputTokens } })
      );
    });
  };

  writeComposer(spec);
  for (const sub of spec.subagents || []) writeComposer(sub);
  db.close();

  const transcriptPath = path.join(dir, `${spec.composerId}.jsonl`);
  const lines = (spec.transcript || []).map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(transcriptPath, lines + (lines ? '\n' : ''));

  return { dir, dbPath, transcriptPath, composerId: spec.composerId };
}

module.exports = { buildCursorFixture };
