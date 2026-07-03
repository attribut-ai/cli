# attribut — allowlist telemetry collector

The thin, **dumb** telemetry collector for ATTRIBUT. It runs as a hook for
**Claude Code**, **Google Antigravity**, **OpenAI Codex**, and **Cursor**,
extracts **only an allowlist** of safe, signal-bearing fields from the local
transcript/rollout/state DB, tags the payload with its provider/tool, gzips it,
and POSTs it to the ingest endpoint. That is all it does.

## What it does (and what it never does)

- Reads **only** the local Claude Code transcript `.jsonl`.
- Extracts **only** the fields named in the frozen contract (the vendored
  [`src/contract/envelope.schema.json`](src/contract/envelope.schema.json)):
  session id, **device id**, model, token counts, cache tokens, commit SHAs
  (from `git commit` stdout), branch, repo, timing, turn/tool-call counts,
  tool-use **names + counts only**, structural line metrics (counts only), and
  per-invocation subagent token/label metadata.
- **Never** reads or transmits: prompt text, assistant responses, file/diff
  contents, tool input args, or PR/commit message bodies. There is no denylist —
  if a field is not in the contract, it never leaves the machine. A golden test
  enforces this.
- **One authorized content exception — `title`.** Claude's short
  model-generated chat title (or a user's custom title) is the single
  content-derived field, added by explicit product decision (see the contract's
  "Content-derived exception"). It is read only from the `ai-title` /
  `custom-title` transcript rows — never from `last-prompt` or any message body.
  The privacy golden test excludes `title` from its leak sentinels while still
  asserting no *other* content leaks.
- **No interpretation client-side.** Pricing, attribution, identity, and any
  non-re-derivable aggregation happen server-side in `ingest_worker`.

## Fields sent

The complete payload — nothing outside this list leaves the machine. The
[schema](src/contract/envelope.schema.json) is the canonical definition; every
free-form string is length-capped before it is sent.

| field | meaning |
|---|---|
| `sessionId` | Claude Code session id |
| `device_uuid` | stable per-machine id (see below) — **not** identity |
| `title` | the one content-derived field (see below); capped at 200 chars |
| `model` | primary model id |
| `tokens_in` / `tokens_out` | summed input / output tokens |
| `started_at` / `ended_at` / `duration_ms` | session timing |
| `repo` | the working-directory path (the hook's `cwd`); capped at 256 chars |
| `branch` | git branch |
| `commitSHA` | deduped list of commit SHAs from `git commit` stdout |
| `num_turns` / `num_tool_calls` | assistant turn + tool-call counts |
| `tool_uses[]` | tool **name + count** only — never the tool args |
| `lines_{code,comment,blank}_{added,removed}` | structural line counts (content discarded) |
| `added_char_n` / `added_char_sum` / `added_char_sumsq` | added-line length moments (counts only) |
| `claude_code.cache_read_tokens` / `cache_creation_tokens` | cache token counts |
| `claude_code.service_tier` / `stop_reason` / `version` | transport labels |
| `claude_code.remoteSessionId` / `reason` | cloud session id + hook reason |
| `claude_code.subagents[]` | per-invocation subagent token + label metadata |

> `repo` is the absolute working-directory path, so it includes your OS
> username and directory layout. It is used server-side as repo identity.

### `device_uuid`

A random UUID generated **once** and persisted to
`${ATTRIBUT_CONFIG_DIR:-~/.attribut}/device_uuid` (file mode `0600`, dir created
if needed). Reused verbatim on every run, so it is stable across sessions on the
same machine. It is **not** identity — the user is resolved server-side from the
bearer token; `device_uuid` only distinguishes discrete machines. If the file
can't be written, the run falls back to an in-memory UUID and logs to stderr
(never blocks the session).

### `title`

Best-effort from the transcript: `custom-title` row's `.customTitle` (user-set,
takes precedence) else `ai-title` row's `.aiTitle` (Claude's generated summary);
last value wins. `null` when no title row exists yet.

Provider/tool tag is fixed: `provider="anthropic"`, `tool="claude_code"`,
`schema_version=1`.

## Layout

```
src/parser/claude_code.cjs   pure: transcript path -> contract `payload` object
src/envelope.cjs             assemble + validate envelope against the schema
src/collector.cjs            hook entrypoint (stdin -> envelope -> gzip -> POST);
                             also dispatches the install/uninstall/help commands
src/install.cjs              install/uninstall command logic (register-in-place)
src/settings.cjs             read/merge/remove hooks in ~/.claude/settings.json
src/device.cjs               stable per-machine device_uuid (0600 file)
src/token.cjs                ingest bearer token at rest (0600 file)
src/heartbeat.cjs            `attribut heartbeat` — one-off liveness POST
src/machine_id.cjs           stable hardware-derived machine id (0600 file)
src/state.cjs                local state (last_hook_invocation_at)
src/timer.cjs                installs/removes the hourly heartbeat OS timer
src/contract/envelope.schema.json  vendored frozen contract schema
test/                        privacy golden test + happy-path correctness tests
test/fixtures/synthetic.jsonl synthetic transcript (no real user data)
```

## Connect (recommended)

```sh
# pick the tools to capture, approve in a browser — hooks install themselves
attribut connect [--agents=claude_code,agy,codex,cursor] [--no-browser]
```

`connect` is the **device flow** (like `gh auth login`): it asks which on-device
tools to capture (`claude_code`, `agy`, `codex`, `cursor`), starts a request with the app,
prints a short code + URL (and best-effort opens your browser), then polls until
you approve. On approval the server mints **one ingest token per agent** and the
CLI installs each agent's capture hook and emits a *connection-established*
telemetry event. No token to copy by hand.

**Codex** registers `[[hooks.PostToolUse]]` + `[[hooks.Stop]]` in
`~/.codex/config.toml` (preserving any hooks you already have). Codex gates hooks
behind a one-time trust prompt — after connecting, run `codex` once and accept the
`/hooks` prompt to enable capture. Codex subagents (each its own rollout) are
nested into their parent session, and their tokens fold into the session total.

**Cursor** registers `sessionEnd` + `stop` + `afterShellExecution` hooks in
`~/.cursor/hooks.json` (preserving any hooks you already have). Cursor gates hooks
behind a one-time trust prompt — restart Cursor and accept it to enable capture.
Cursor exposes no billed tokens on disk, so the collector ships **raw proxy
components** — context-window occupancy, summed output tokens, an uncached
cumulative-input upper bound, session LOC totals, and Cursor's own exact
`costInCents` where it recorded a metered charge — read numbers-only from Cursor's
local `state.vscdb` (never prompt/response/code/summary text). The server derives
tokens/value/cost from those; cost is never fabricated client-side. Cursor
subagents (each its own composer) are nested into their parent session.

**Headless / no browser:** pass `--no-browser` (or run where there's no display)
and the CLI just prints the URL + code — approve it from your phone or laptop.

**Remote / cloud sandboxes (no interactivity at all):** a remote env (e.g. Claude
Code's App·Cloud) can't run the device flow — there's no human at startup. Mint a
token in the web ("App · Cloud" card) and pair non-interactively from the
environment's Setup script:

```sh
npx attribut@latest connect --key=<ingest-token> [--agent=claude_code]
```

This writes the token, installs that agent's hook, and emits the
connection-established event — no browser, no prompts, no polling. (`--key` and
`--token` are synonyms; the token is agent-scoped, default `claude_code`.)

Per-agent tokens are stored in `${ATTRIBUT_CONFIG_DIR:-~/.attribut}/token` as a
`0600` JSON map (`{ "<agent>": "<token>" }`); the collector resolves its agent
from the hook's `--provider` flag. `ATTRIBUT_APP_BASE` overrides the app origin;
`--endpoint` / `INGEST_BASE` override the ingest origin.

`connect` also installs an **hourly heartbeat timer** (see below) — a small
liveness signal so ATTRIBUT can tell "the connector stopped firing hooks"
apart from "this device is gone." Timer install is best-effort: a sandbox
without a working scheduler backend does not fail `connect` — the hooks (the
part that matters) are already live.

## Heartbeat (connector liveness signal)

```sh
attribut heartbeat [--dry-run]
```

Separate from the hook-triggered `/v1/hook` envelope: a minimal, fire-and-
forget POST to `${INGEST_BASE:-https://ingest.attribut.ai}/v1/heartbeat` that
tells the server "this device is still here," even during long stretches with
no Claude Code / Codex / Cursor / Antigravity session running. `attribut
connect` installs this to run **hourly** as an OS-native timer:

| OS | mechanism |
|---|---|
| macOS | a launchd user LaunchAgent (`~/Library/LaunchAgents/ai.attribut.heartbeat.plist`, `StartInterval=3600`, `RunAtLoad`) |
| Linux | a systemd `--user` service + timer (`~/.config/systemd/user/attribut-heartbeat.{service,timer}`, `OnUnitActiveSec=1h`, `Persistent=true`) |
| Windows | a Task Scheduler task (`schtasks /create ... /sc hourly`) |

Each is idempotent (re-running `connect` replaces the same named unit/task in
place, never stacking duplicates) and invokes the durably-installed
`collector.cjs` by absolute path — the same register-in-place approach `install`
uses for hooks, so the timer survives a sparse PATH. If ATTRIBUT is only ever
run via ephemeral `npx` (no durable global install), the timer instead runs
`npx -y attribut@latest heartbeat` on each fire.

**Payload** — nothing outside this list is ever sent; no paths, no prompts, no
content. IP/geo is derived server-side from the request:

| field | meaning |
|---|---|
| `kind` | always `"heartbeat"` |
| `schema_version` | `1` |
| `sent_at` | ISO 8601 send time |
| `device_uuid` | same random per-device id the hook envelope carries |
| `machine_id` | stable, **hashed** hardware id (see below) — not identity |
| `cli_version` | the installed package's `package.json` version |
| `platform` | `process.platform` (`darwin` / `linux` / `win32`) |
| `os_release` | `os.release()` |
| `source` | `"timer"` — the only value today |
| `last_hook_invocation_at` | ISO 8601 timestamp of the last real hook fire, or `null` |

**Failure policy is the opposite of `connect`/`install`:** one attempt, a ~5s
timeout, and exit `0` on *any* send failure — the absence of a heartbeat is
itself the signal ingest acts on, so local retries would only mask it. The one
non-zero exit is "no ingest token configured at all" (run `attribut connect`
first), which makes `attribut heartbeat` useful as a standalone smoke test.
`--dry-run` prints the payload instead of sending it (works with or without a
token configured).

### `machine_id`

Distinct from `device_uuid` (which ATTRIBUT itself mints): `machine_id` ties
back to an id the **OS** hands out — `/etc/machine-id` on Linux, the
`IOPlatformUUID` from `ioreg` on macOS, the registry `MachineGuid` on Windows —
so it survives a wiped `~/.attribut` config dir. The raw platform id is
**never sent**; only its `sha256` hash is, and that hash is itself cached at
`${ATTRIBUT_CONFIG_DIR:-~/.attribut}/machine_id` (`0600`). On a platform or
sandbox where the hardware id can't be read, it falls back to a generated,
persisted random UUID (same shape as `device_uuid`'s fallback).

### `last_hook_invocation_at`

The collector touches `${ATTRIBUT_CONFIG_DIR:-~/.attribut}/state.json` on
every real hook fire (cheap, best-effort, never blocks the hook). The
heartbeat reads it back so the server can distinguish "connector installed but
the agent hasn't run in days" from "connector installed and actively firing."

## Install (manual / scripted)

```sh
# register the capture hook (token stored in a 0600 file, NOT in settings.json)
attribut install --key=<ingest-token> [--endpoint=<origin>]

# remove it again (preserves unrelated hooks; cleans up legacy files + token)
attribut uninstall

attribut help            # list commands
```

`install` registers `PostToolUse(Bash)` + `SessionEnd` + `Stop` hooks in
`~/.claude/settings.json`, each invoking **this installed package's**
`collector.cjs` by absolute path. Nothing is copied — the collector needs its
`node_modules` (ajv), so the package must be durably installed (`npm i -g`, not
ephemeral `npx`) for the path to stay valid.

The **ingest token is never written into the hook command or `settings.json`** —
that would leave it world-readable and expose it in `ps`. Instead it is persisted
to `${ATTRIBUT_CONFIG_DIR:-~/.attribut}/token` (mode `0600`) and read back by the
collector at POST time. A custom `--endpoint` must be `https` (so the token never
travels cleartext); set `ATTRIBUT_ALLOW_INSECURE=1` only for a localhost test
server.

Re-running is idempotent (replaces our hooks in place, never duplicates) and the
previous settings file is backed up to `settings.json.bak.<timestamp>` (mode
`0600`, oldest pruned) before every write. `settings.json` is itself written
`0600`. `CLAUDE_SETTINGS_PATH` overrides the target file.

`uninstall` strips only ATTRIBUT's entries (matching our collector path, and the
legacy `attribut-collector.cjs` from old installs), prunes empty event arrays,
removes the stored token, and deletes any legacy collector files a previous
install copied into `~/.claude/hooks/`. The default (no `--provider`) form is a
full disconnect — it also removes the hourly heartbeat timer, since that timer
is device-level rather than tied to one agent's hooks.

## Transport

`POST ${INGEST_BASE}/v1/hook` (https-only unless `ATTRIBUT_ALLOW_INSECURE=1`) with:

- `Content-Type: application/json`
- `Content-Encoding: gzip`
- `Authorization: Bearer <token>` (read from the `0600` token file)

On `PostToolUse(Bash)` the collector only does the full parse + POST when a new
commit appeared since the last fire (tracked via a per-session byte cursor under
`${ATTRIBUT_CONFIG_DIR}/cursor/`); the common no-commit Bash calls are a cheap
tail-read. `SessionEnd` / `Stop` always reconcile the full session.

## Environment variables

| var | purpose | default |
|---|---|---|
| `INGEST_BASE` | ingest base URL; `/v1/hook` is appended | `https://ingest.attribut.ai` |
| `ATTRIBUT_COLLECTOR_URL` | full URL override (wins over `INGEST_BASE`) | — |
| `ATTRIBUT_ALLOW_INSECURE` | `1` permits a non-https endpoint (localhost testing only) | — |
| `ATTRIBUT_SOURCE` | `cli` or `cowork` → envelope `_source` | `cli` |
| `ATTRIBUT_CONFIG_DIR` | dir holding `device_uuid`, `token`, and the `cursor/` state | `~/.attribut` |
| `CLAUDE_SETTINGS_PATH` | override the `settings.json` install target | `~/.claude/settings.json` |
| `AGY_HOOKS_PATH` | override the Antigravity `hooks.json` install target | `~/.gemini/config/hooks.json` |
| `CODEX_CONFIG_PATH` | override the Codex `config.toml` install target | `~/.codex/config.toml` |
| `CODEX_SESSIONS_DIR` | override where Codex rollouts are resolved from | `~/.codex/sessions` |
| `CURSOR_HOOKS_PATH` | override the Cursor `hooks.json` install target | `~/.cursor/hooks.json` |
| `CURSOR_STATE_DB` | override the Cursor `state.vscdb` the parser reads (numbers-only) | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | set by Claude Code in cloud VMs; stamps `claude.remoteSessionId` + `_isCloud` | — |
| `ATTRIBUT_LAUNCHD_DIR` | override the launchd LaunchAgents dir the heartbeat timer installs into (macOS) | `~/Library/LaunchAgents` |
| `ATTRIBUT_SYSTEMD_USER_DIR` | override the systemd `--user` unit dir the heartbeat timer installs into (Linux) | `~/.config/systemd/user` |
| `ATTRIBUT_SKIP_TIMER_ACTIVATION` | `1` writes the heartbeat timer's unit/task file(s) but skips the real launchctl/systemctl/schtasks call (tests only) | — |

## Hook modes

Trigger is taken from the hook's `hook_event_name` (or an explicit arg):

| hook event | envelope `_trigger` |
|---|---|
| `SessionEnd` | `sessionend` |
| `Stop` | `stop` |
| `PostToolUse` | `posttooluse` |

The collector reads the hook JSON on stdin (`session_id`, `transcript_path`,
`cwd`, `reason`, ...), parses the full transcript, and posts the complete
envelope.

### Failure policy

A telemetry collector must **never** block the user's Claude Code session. On any
error (bad stdin, unreadable transcript, network/validation failure) the
collector logs to **stderr** and exits **0**. It never silently swallows — it
always logs — but it never breaks the session.

## Running the tests

```sh
npm install
npm test
```

The suite includes:

- **Privacy golden test** (`test/privacy.test.cjs`): a synthetic transcript
  plants sentinel strings in every prohibited location; the test asserts none
  appear anywhere in the produced envelope. Includes a positive control
  (commit SHA *is* extracted) so a clean result is meaningful.
- **Happy-path test** (`test/happy.test.cjs`): the envelope validates against
  the frozen schema and every extracted field carries the correct value.
- **Collector test** (`test/collector.test.cjs`): trigger mapping, endpoint
  derivation, cloud stamping, and envelope assembly from a hook object.
- **Network test** (`test/network.test.cjs`): gzip round-trip + bearer header,
  non-2xx / missing-token rejection, and https-only enforcement.
- **Bounds / token / cursor / classify / e2e tests**: string-length caps + schema
  rejection, the `0600` token store, the PostToolUse cursor gate, the comment
  classifier edge cases, and the exit-0-on-failure safety invariant.

### Offline / dry-run

```sh
# parse a transcript and print the payload (no envelope, no POST)
node src/collector.cjs --parse path/to/transcript.jsonl

# feed a hook JSON on stdin and print the envelope instead of posting
echo '{"hook_event_name":"SessionEnd","session_id":"x","transcript_path":"test/fixtures/synthetic.jsonl"}' \
  | node src/collector.cjs --dry-run
```

## Troubleshooting

The collector logs every action to **stderr** prefixed with `[attribut]`, and
**never blocks the session** (it exits `0` on any failure — see Failure policy).

- **Is it working?** A successful run logs
  `[attribut] posted <trigger> envelope for session <id> → HTTP <status>`.
- **Nothing is sent.** Check stderr for `[attribut] POST failed: …` or
  `no ingest token …`. The latter means the `0600` token file is missing —
  re-run `attribut install --key=<token>`.
- **Verify offline**, without posting, using `--parse` / `--dry-run` (above).
- After installing, **restart any running Claude Code sessions** to pick up the
  hook.

## License

**Source-available** under the [PolyForm Shield License 1.0.0](LICENSE) — © 2026 ATTRIBUT.

The source is published for **transparency and auditing**: you can read every line
to verify exactly what the collector does (and does not) send. You may install and
run the CLI freely. You may **not** use this code to build or operate a competing
product or service. This is not an open-source license, and ATTRIBUT retains all
ownership of the software.
