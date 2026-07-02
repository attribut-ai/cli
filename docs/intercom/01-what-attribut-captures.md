# What ATTRIBUT captures — and what it never sends

ATTRIBUT captures metadata only. Your prompts, the model's responses, your code, and your diffs never leave your machine.

## The principle

The capture hook reads your AI coding sessions and sends structured metadata so your work can be attributed and measured. It never sends the *content* of your work. There is no denylist to trust: if a field isn't in the contract, it never leaves your machine, and a test enforces that.

## What is captured

| Captured | Detail |
|---|---|
| Session id | Identifies one chat session |
| `device_uuid` | Random, stable per machine — see below |
| Model | Primary model id used |
| Token counts | Input, output, and cache tokens |
| Timing | Session start, end, and duration |
| `repo` | Working-directory path and git branch |
| Commit SHAs | From `git commit` |
| Counts | Turn count and tool-call count |
| Tool use | Tool NAMES and how many times each ran |
| Line changes | Structural counts only — numbers, no content |

## The one content exception: `title`

`title` is your chat's short title — the model-generated (or custom) label for the session — capped at 200 characters. It is the only field derived from content, added by an explicit product decision. Nothing else about what you typed or the model returned is sent.

## Never sent

- Prompt text
- Assistant responses
- File or diff contents
- Tool input arguments
- PR and commit message bodies

## About `device_uuid`

`device_uuid` is a random value that is stable per machine. It is **not your identity** — you are resolved server-side from your token. It only groups activity by device.

## About `repo`

`repo` is the absolute working-directory path, so it includes your OS username and folder layout. It's used server-side as the repo's identity.

## How the data travels

The metadata is gzipped and sent over HTTPS with a bearer token. Your ingest token lives in an owner-only (`0600`) file, never in a settings file and never on the command line.

## Why you can trust this

ATTRIBUT's CLI is **source-available** under PolyForm Shield 1.0.0 — the full source is public at [github.com/attribut-ai/cli](https://github.com/attribut-ai/cli), so anyone can read exactly what is and isn't sent. You don't have to take our word for it: inspect the code, or prove it on your own machine.

## Related

- Verify it yourself with `attribut audit`
- Connect your AI tools to ATTRIBUT
- Supported tools & setup notes
