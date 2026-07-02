# Verify it yourself with `attribut audit`

Don't take our word for it. `attribut audit` proves the metadata-only claim on your own data, and it sends nothing — it's read-only.

## What it does

`attribut audit` inspects your local sessions and shows you exactly what ATTRIBUT would send, then proves the sensitive content never appears in it. Nothing leaves your machine.

Sweep every local Claude Code session under `~/.claude/projects/` and print one aggregate PASS/FAIL:

```sh
attribut audit
```

Get full detail for a single session, including the exact metadata that would be sent for it:

```sh
attribut audit path/to/transcript.jsonl
```

## The three checks

For each session, `audit` runs three checks:

1. **Contract.** Validates the data against the frozen contract of allowed fields.
2. **Allowlist.** Confirms every field present is on the allowlist — nothing extra.
3. **Leak test.** Adversarially pulls the real sensitive content out of your transcript — prompts, responses, tool inputs, file contents — and confirms none of it appears in what would be sent.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | PASS |
| 1 | A leak or contract failure |
| 2 | Usage error |

You can wire these into a script or CI check if you want the guarantee enforced automatically.

## Inspect offline without posting

Two related commands let you see what would be sent without any network call:

```sh
attribut --parse path/to/transcript.jsonl   # print the parsed metadata
cat hook.json | attribut --dry-run          # print what would be sent
```

## Related

- What ATTRIBUT captures — and what it never sends
