# What ATTRIBUT collects from GitHub

When you connect GitHub, ATTRIBUT collects **repository and pull-request metadata only**. The GitHub App is **read-only** and requests **no access to your code** — it cannot read file contents, diffs, or commit history.

## How the connection works

You connect by installing the **ATTRIBUT GitHub App** — a one-click, **read-only** install. You choose whether it applies to **all repositories or a selected subset**, and you can install it across multiple GitHub organizations. You can change the repo selection or remove the App from GitHub at any time.

## What we collect

From the repositories you select, ATTRIBUT reads two things — and keeps only metadata:

**Repositories** — the list of repositories you've selected (names only), so your work can be grouped by repo.

**Pull requests:**

| Field | |
|---|---|
| PR number, title, state | Draft / merged status |
| Base & head branch refs + SHAs | Line-change **counts** (additions, deletions, changed files) |
| Commit count, labels | Author, merged-by |
| Created / updated / merged / closed timestamps | |

The **PR title** is the only free-form text kept — exactly what GitHub shows on the pull request. From a PR description we extract **only** a `claude.ai/code` session link (if present), to connect a merged PR back to the session that produced it; the rest of the description is never read.

## We don't read your commits from GitHub

ATTRIBUT links a pull request to the work behind it using the **commit hash**, which is captured locally by the ATTRIBUT CLI during your coding session — **not** pulled from GitHub. Because of that, the GitHub App does **not** request commit or code access at all. GitHub tells us about pull requests; your commit hashes come from your own session and are matched up by hash.

## What we never collect from GitHub

- Source code, file contents, or file paths
- Diffs or patches
- Commit contents or repository history
- Pull-request descriptions / bodies
- Anything outside the repositories you selected

We don't just avoid reading these — the GitHub App holds **no permission** to read your code in the first place.

## Permissions the GitHub App requests

The App is **read-only** and requests the minimum needed to see repositories and pull requests:

| Permission | Access | Why |
|---|---|---|
| **Metadata** | Read-only *(required by GitHub)* | List the repositories you've selected |
| **Pull requests** | Read-only | Pull-request metadata (title, state, line-change counts, timestamps) |

**Not requested:** `Contents` (repository code/commits), Issues, Actions, Deployments, Secrets, Members, or any write access. You can review the App's exact permissions any time on GitHub under **Settings → Applications → Installed GitHub Apps → ATTRIBUT**.

## How often it updates

ATTRIBUT refreshes pull-request data on a schedule (about every 30 minutes), pulling only what changed since the last check. Connecting a repository backfills recent pull requests so your data shows up right away.

## Removing access

Uninstall or edit the ATTRIBUT GitHub App from **GitHub → Settings → Applications**, or disconnect the connector in ATTRIBUT. Once removed, ATTRIBUT stops polling immediately.

## Related

- What ATTRIBUT captures — and what it never sends
- Connect your AI tools to ATTRIBUT
