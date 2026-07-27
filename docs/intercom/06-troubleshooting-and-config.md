# Troubleshooting & configuration

If something looks wrong, start here: the connector never blocks your work, and every problem it hits is logged to stderr with an `[attribut]` prefix.

## It never breaks your session

The capture hook is fail-safe by design. On any error — bad input, an unreadable transcript, a network or validation failure — it logs to stderr prefixed `[attribut]` and exits cleanly. It never blocks or breaks your coding session, and it never silently swallows a problem: if something goes wrong, you will see it in the logs.

## Is it working?

A successful run logs a line like this:

```sh
[attribut] posted <trigger> envelope for session <id> → HTTP <status>
```

If you see that, data is being sent.

## Common issues

- **Nothing is being sent.** Check stderr. A `[attribut] POST failed: …` line points to a network or endpoint problem. A `no ingest token …` line means no token is stored — re-run `attribut connect` (or `attribut install`) to store one.
- **Just installed, but no data.** Restart any running sessions so they pick up the hook. For Codex and Cursor you must also accept the one-time trust prompt the first time you run the tool. See "Supported tools & setup notes".
- **The hook path broke.** The package must stay durably installed — the hook invokes the installed collector by absolute path. Do not run it via ephemeral `npx`. Reinstall globally:

```sh
npm i -g attribut
```

If that fails with `EACCES`, run `npx attribut connect` instead — it installs durably under `~/.attribut/npm` and re-points every hook there, without sudo.

## Configuration

The connector reads these environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `INGEST_BASE` | Ingest base URL (`/v1/hook` appended) | `https://ingest.attribut.ai` |
| `ATTRIBUT_CONFIG_DIR` | Dir holding device_uuid, token, cursor state | `~/.attribut` |
| `ATTRIBUT_APP_BASE` | App origin for the `connect` device flow | `https://attribut.ai` |
| `ATTRIBUT_NO_BROWSER` | `1` = never auto-open a browser | — |
| `CLAUDE_SETTINGS_PATH` | Override Claude settings.json target | `~/.claude/settings.json` |
| `CODEX_CONFIG_PATH` | Override Codex config.toml target | `~/.codex/config.toml` |
| `CURSOR_HOOKS_PATH` | Override Cursor hooks.json target | `~/.cursor/hooks.json` |
| `AGY_HOOKS_PATH` | Override Antigravity hooks.json target | `~/.gemini/config/hooks.json` |
| `ATTRIBUT_ALLOW_INSECURE` | `1` permits a non-https endpoint (localhost testing only) | — |

## Related

- Supported tools & setup notes
- Connect your AI tools to ATTRIBUT
- Manual install & removing ATTRIBUT
- Verify it yourself with `attribut audit`
