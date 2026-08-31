# Supported tools & setup notes

ATTRIBUT captures five AI coding tools by installing a small capture hook in each tool's config file, and each tool has one quick step to switch the hook on.

## Supported tools

| Tool | Hooks registered in | One-time step to enable |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | Restart running Claude Code sessions |
| OpenAI Codex | `~/.codex/config.toml` | Run `codex` once, accept the `/hooks` trust prompt |
| Cursor | `~/.cursor/hooks.json` | Restart Cursor, accept the one-time hooks trust prompt |
| Google Antigravity (Gemini) | `~/.gemini/config/hooks.json` | Restart agy sessions / the Antigravity IDE |
| Grok Build | `~/.grok/hooks/attribut.json` (dedicated file) | Restart running Grok sessions |

## Claude Code

The hook is registered as soon as you connect. Restart any Claude Code sessions that are already running so they pick it up.

## OpenAI Codex

Run `codex` once and accept the `/hooks` trust prompt to activate the hook. Codex subagents each run as their own session; they nest into their parent session, and their tokens fold into the parent total.

## Cursor

Restart Cursor and accept the one-time hooks trust prompt. Cursor exposes no billed tokens locally, so ATTRIBUT sends raw numeric proxy components instead — numbers only, never text — and value or cost is derived server-side. Cursor subagents each run as their own session and nest into their parent, with their tokens folded into the parent total.

## Google Antigravity (Gemini)

Restart your agy sessions or the Antigravity IDE to activate the hook.

## Grok Build

The hook is registered as soon as you connect — no trust prompt to accept. It writes to its own dedicated `~/.grok/hooks/attribut.json` rather than merging into Claude's or Cursor's settings, since Grok also scans those files and a merged entry would dual-fire and mis-tag Grok sessions as another tool. Restart any running Grok sessions to pick it up.

## Existing hooks are preserved

ATTRIBUT never touches other hooks in these config files — they are always preserved. Re-running a connect or install never duplicates entries, so it is safe to run more than once.

## Related

- Connect your AI tools to ATTRIBUT
- Manual install & removing ATTRIBUT
- What ATTRIBUT captures — and what it never sends
- Troubleshooting & configuration
