# Intercom Help Center loader

Pushes the numbered Markdown articles in this directory into an Intercom Help
Center, grouped under a single Collection, as **drafts** by default.

The loader is `upload_to_intercom.mjs` — a self-contained Node 18+ ES module
with **no package dependencies** (uses global `fetch` and an inline
Markdown→HTML converter).

## What gets uploaded

Every `*.md` file here **except** `README.md` and the loader itself. Each
article's **title comes from the file's H1** (`# ...`); the rest of the file is
converted to HTML and becomes the article body (Intercom article bodies are
HTML).

Files → articles (in numeric order):

| File | Article title (from H1) |
|---|---|
| `01-what-attribut-captures.md` | What ATTRIBUT captures — and what it never sends |
| `02-connect-your-tools.md` | Connect your AI tools to ATTRIBUT |
| `03-supported-tools.md` | Supported tools & setup notes |
| `04-manual-install-and-removal.md` | Manual install & removing ATTRIBUT |
| `05-audit-verify-privacy.md` | Verify it yourself with `attribut audit` |
| `06-troubleshooting-and-config.md` | Troubleshooting & configuration |
| `07-connect-claude-code-cloud.md` | Connect Claude Code cloud environments to ATTRIBUT |
| `08-backfill-past-sessions.md` | Backfilling past sessions |

All articles are placed under one Collection (default **`ATTRIBUT CLI
Connector`**). In Intercom the hierarchy is *Help Center → Collection →
(optional Section) → Article*; our "folder" is a **Collection**, and articles
attach to it via `parent_type: "collection"` + `parent_id`.

## Prerequisites

- **Node 18+** (`node --version`).
- An **Intercom workspace access token**. Developer Hub → your app → *Configure
  → Authentication*. It is passed as `Authorization: Bearer <token>`.

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `INTERCOM_ACCESS_TOKEN` | yes (unless `--dry-run`) | — | Workspace access token. Never commit it. |
| `INTERCOM_COLLECTION_NAME` | no | `ATTRIBUT CLI Connector` | Help Center collection; created if it doesn't exist. Ignored when `INTERCOM_FOLDER_ID` is set. |
| `INTERCOM_FOLDER_ID` | no | — | Place articles in an existing **Knowledge Hub folder** by id (from the folder URL, e.g. `.../knowledge-hub/folder/4967632`). Uses the Unstable API and the article `folder_id` field. |
| `INTERCOM_ARTICLE_STATE` | no | `draft` | `draft` or `published`. |
| `INTERCOM_AUTHOR_ID` | no | resolved via `GET /me` | Must be an admin/teammate id. See `GET /admins` to list them. |
| `INTERCOM_VERSION` | no | `2.15` | `Intercom-Version` header (current stable). |

## Run

Preview without touching the API:

```bash
node docs/intercom/upload_to_intercom.mjs --dry-run
```

Upload for real (creates the Collection if missing, creates/updates each
article as a draft):

```bash
export INTERCOM_ACCESS_TOKEN=xxxxx
node docs/intercom/upload_to_intercom.mjs
```

Into an existing Knowledge Hub folder (recommended — pass the folder id from its
URL). The token can be pulled straight from GCP Secret Manager:

```bash
export INTERCOM_ACCESS_TOKEN=$(gcloud secrets versions access latest \
  --secret=app-intercom-access-token --project=attribut-ai)
INTERCOM_FOLDER_ID=4967632 node docs/intercom/upload_to_intercom.mjs
```

Publish instead of draft:

```bash
INTERCOM_ARTICLE_STATE=published node docs/intercom/upload_to_intercom.mjs
```

## Folders vs. collections (and making articles public)

Two different structures, and you usually want both:

- **Knowledge Hub folders** (`INTERCOM_FOLDER_ID`) are *internal* organization.
  They do **not** affect the public Help Center — an article in a folder but no
  collection shows "no collection" and is not visible to customers.
- **Collections** (and **sections**, which are just collections with a parent)
  are the *public* Help Center structure. An article is only visible on
  `help.attribut.ai` when it's in a collection.

An article can be in both at once. `upload_to_intercom.mjs` sets the folder;
`assign_collection.mjs` puts the same articles into a public collection/section:

```bash
export INTERCOM_ACCESS_TOKEN=$(gcloud secrets versions access latest \
  --secret=app-intercom-access-token --project=attribut-ai)
# default: collection "Connectors" > section "CLI"
node docs/intercom/assign_collection.mjs
```

It's **body-safe**: Intercom updates are partial, so it PUTs only the placement
(`parent_id` + `parent_type`) and leaves the article body — and its `folder_id`
— untouched. Idempotent (collection/section matched by name, articles by title).
Override names with `INTERCOM_COLLECTION_NAME` / `INTERCOM_SECTION_NAME`.

## ⚠️ Re-running the uploader overwrites article bodies

`upload_to_intercom.mjs` PUTs each article body from the local Markdown. Images
must be added in the Intercom editor (the API can't host repo-relative images),
so **any screenshots you inserted there are wiped on the next uploader run**.
`assign_collection.mjs` does not have this problem (it never writes the body).
If you re-run the uploader after adding screenshots, re-insert them — or host the
images at public URLs and embed those in the Markdown so runs stay idempotent.

## Idempotency

Safe to re-run. Before writing, the loader lists existing articles and matches
by **title**: an existing article is **updated** (`PUT /articles/{id}`),
otherwise a new one is **created** (`POST /articles`). Re-running does not
create duplicates. (If you rename an H1, the old article is left in place and a
new one is created — delete the stale one in the Intercom UI.)

## API endpoints used

- `GET /me` — resolve the author admin id.
- `GET /admins` — (reference) list teammates to pick an `INTERCOM_AUTHOR_ID`.
- `GET|POST /help_center/collections` — find/create the target Collection.
- `GET /articles`, `POST /articles`, `PUT /articles/{id}` — list/create/update.

All requests send `Authorization: Bearer <token>` and `Intercom-Version: 2.15`.

## Gotchas

- **Rate limit:** private apps get ~10,000 calls/min/app; overage returns `429`
  with `X-RateLimit-*` headers. This loader makes only a handful of calls and
  pauses 250 ms between writes, so it stays well under.
- Article body **must be HTML** — the inline converter handles headings,
  bold/italic/code, links, lists, tables, and fenced code. For richer Markdown,
  swap `mdToHtml` for the `marked` package (not added here to keep zero deps).
- No API exists to create admins; author must be an existing teammate.
