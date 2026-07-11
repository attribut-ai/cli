# Backfilling past sessions

Live capture only sees sessions that happen *after* you connect. **Backfill** is the one-time import of the history from before — it re-sends your existing local sessions through the exact same path, and with the same metadata-only privacy guarantee, as live capture.

## Running a backfill

`attribut connect` runs it automatically right after it installs the hooks — no prompt. It imports your **last 90 days** of prior sessions, showing how many it found for each tool and a progress bar as it imports. (Scripted, non-interactive connects skip this — run `attribut backfill` yourself there.)

Run it yourself anytime:

```sh
attribut backfill              # re-import the last 90 days
attribut backfill --all --yes  # everything still on disk, no prompts
attribut backfill --since=30d  # a specific window
```

It is **safe to re-run**. The server reconciles by session id (latest non-partial wins), so a session already captured live — or backfilled twice — just overwrites in place. It never double-counts. `--dry-run` shows what it *would* send without posting anything.

## How far back it can reach

Backfill can only send sessions the tool still keeps on disk, and **each tool manages its own local history** — how far back you can reach is set by the tool, not by ATTRIBUT.

| Tool | Local session store | How far back backfill reaches |
|---|---|---|
| Claude Code | `~/.claude/projects/…/*.jsonl` | ~30 days by default — Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30) |
| Cursor | `state.vscdb` (local SQLite) | Long — typically many months |
| OpenAI Codex | `~/.codex/sessions/…/rollout-*.jsonl` | As far back as you've used it |
| Google Antigravity | `~/.gemini/antigravity-cli/conversations/*.db` | As far back as you've used it |

## "Why did `--all` only import the last month of Claude Code?"

This is expected, not a bug. Claude Code automatically deletes chat transcripts older than **`cleanupPeriodDays`** (default **30 days**), so those older sessions are already gone from disk before backfill runs. A result like `Claude Code: 76 sessions (last 30 days)` is faithfully sending everything that still exists.

To keep more history **going forward**, raise the setting in `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 365 }
```

This affects only new sessions — transcripts Claude Code has already deleted cannot be recovered.

## Bottom line

- Live capture is never affected — every new session is captured at session-end regardless of how a tool prunes old history.
- Backfill only matters for the window *before* you connected, and only as far back as the tool still has the data.
- If long Claude Code history matters to you, raise `cleanupPeriodDays` early.

## Related

- Connect your AI tools to ATTRIBUT
- Supported tools & setup notes
- What ATTRIBUT captures — and what it never sends
- Troubleshooting & configuration
