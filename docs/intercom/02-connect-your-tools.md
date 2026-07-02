# Connect your AI tools to ATTRIBUT

Connecting takes one command: `attribut connect` opens a browser device flow, installs the capture hook into each tool you pick, and stores one token per tool — nothing to copy by hand.

## Install ATTRIBUT first

Install the package globally before you connect:

```sh
npm i -g attribut
```

Install globally rather than running it via `npx`. The capture hook invokes the installed program by its absolute path and needs its dependencies on disk, so it must live in a durable location — an ephemeral `npx` copy disappears and the hook breaks. (The one exception is the cloud one-liner below, which pins a version.)

## Connect (recommended)

Run `connect` and follow the prompts:

```sh
attribut connect
```

It asks which tools to capture, prints a URL and a short code, opens your browser (best effort), and waits while you approve. On approval the server mints one token per tool and the hooks install themselves.

Skip the picker by naming tools, and control the browser:

```sh
attribut connect --agents=claude_code,agy,codex,cursor --no-browser
```

## No display / headless

With `--no-browser` (or when there's no display), `connect` just prints the URL and code and keeps polling. Open that URL and enter the code from any other device to approve.

## Remote and cloud sandboxes

For a cloud environment's Setup script, pair non-interactively from a pre-minted token. Copy the token from the web **App · Cloud** card:

```sh
npx attribut@latest connect --key=<token> --agent=claude_code
```

`--key` and `--token` are synonyms. The token is tool-scoped and the default agent is `claude_code`.

## After connecting

Restart any running sessions to pick up the hook. Some tools also need a one-time trust prompt the first time they load hooks — see **Supported tools & setup notes** for the exact per-tool step.

## Related

- Supported tools & setup notes
- Manual install & removing ATTRIBUT
- What ATTRIBUT captures — and what it never sends
- Troubleshooting & configuration
