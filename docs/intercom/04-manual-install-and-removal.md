# Manual install & removing ATTRIBUT

`attribut install` is the scripted alternative to `connect`, and `attribut uninstall` cleanly removes ATTRIBUT whenever you want it gone.

## When to use `install` instead of `connect`

Use `attribut connect` normally — it handles the browser sign-in and installs the hooks for you (see "Connect your AI tools to ATTRIBUT").

Reach for `attribut install` only when you already hold an ingest token or you're scripting setup and don't want an interactive flow.

## Installing manually

```sh
attribut install --key=<ingest-token> [--endpoint=<origin>]
```

By default this registers the capture hook for Claude Code. To target a different tool, add `--provider`:

| Provider | Tool |
|---|---|
| `anthropic` | Claude Code (default) |
| `antigravity` | Google Antigravity (Gemini) |
| `openai` | OpenAI Codex |
| `cursor` | Cursor |

Your token is written to an owner-only (`0600`) file — never into a settings file, and never left on the command line.

Re-running is safe. `install` replaces our hooks in place rather than duplicating them, and backs up the settings file first. Any unrelated hooks you already have are preserved.

After installing, enable capture the same way `connect` requires: restart your running sessions, or accept the tool's one-time trust prompt. The exact step per tool is in "Supported tools & setup notes".

## Removing ATTRIBUT

```sh
attribut uninstall
```

This strips only ATTRIBUT's hooks, deletes the stored token, and cleans up any legacy files. Everything else — your own hooks and settings — is left untouched.

To remove a specific tool's hook, use the matching `--provider` value:

```sh
attribut uninstall --provider=cursor
```

`uninstall` is idempotent and safe to run anytime; if nothing is installed, it simply does nothing.

## Related

- Connect your AI tools to ATTRIBUT
- Supported tools & setup notes
- Troubleshooting & configuration
