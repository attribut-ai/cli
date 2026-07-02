#!/usr/bin/env node
// upload_to_intercom.mjs
//
// Push the numbered Markdown articles in this directory into an Intercom
// Help Center, grouped under one Collection, as DRAFT articles.
//
// Zero dependencies: Node 18+ (global fetch), ES module. Markdown->HTML is a
// minimal inline converter (Intercom article `body` must be HTML). If you want
// full Markdown fidelity, install `marked` and swap `mdToHtml` for it — but do
// NOT add deps to this project; keep this script self-contained.
//
// Intercom REST API (verified against docs, current stable version 2.15):
//   Auth ...... header  Authorization: Bearer <token>          (workspace/app access token)
//   Version ... header  Intercom-Version: 2.15
//   Admin id .. GET  https://api.intercom.io/me                -> admin object with `id`
//               GET  https://api.intercom.io/admins            -> list all teammates
//   Collection  POST https://api.intercom.io/help_center/collections   {name, description}
//               GET  https://api.intercom.io/help_center/collections   (list, paginated)
//   Article ... POST https://api.intercom.io/articles          {title, body(HTML), author_id,
//                                                               state, parent_id, parent_type}
//               PUT  https://api.intercom.io/articles/{id}      (update existing)
//               GET  https://api.intercom.io/articles           (list, paginated)
//   Docs: https://developers.intercom.com/docs/guides/help-center/create-an-article
//
// Idempotency: we list existing articles once, index them by title, and PUT
// (update) any whose title already exists under the collection; otherwise POST
// (create). Re-running does not create duplicates.
//
// Rate limits: private apps default 10,000 req/min per app (429 with
// X-RateLimit-* headers on overage). This script makes only a handful of calls,
// so it stays well under. We add a tiny delay between writes as a courtesy.
//
// Usage:
//   INTERCOM_ACCESS_TOKEN=xxx node docs/intercom/upload_to_intercom.mjs
//   node docs/intercom/upload_to_intercom.mjs --dry-run
//
// Env:
//   INTERCOM_ACCESS_TOKEN    (required unless --dry-run) workspace access token
//   INTERCOM_COLLECTION_NAME (optional) default "ATTRIBUT CLI Connector"
//   INTERCOM_VERSION         (optional) default "2.15"
//   INTERCOM_AUTHOR_ID       (optional) admin id to author articles; defaults to /me
//   INTERCOM_ARTICLE_STATE   (optional) "draft" (default) or "published"

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";

const API = "https://api.intercom.io";
const DRY_RUN = process.argv.includes("--dry-run");

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));
// Which directory of .md articles to load. Defaults to this script's dir; set
// INTERCOM_SRC_DIR (relative to it, e.g. "github") to publish a connector's
// subfolder of articles to its own Knowledge Hub folder.
const SRC = process.env.INTERCOM_SRC_DIR ? resolve(HERE, process.env.INTERCOM_SRC_DIR) : HERE;

const TOKEN = process.env.INTERCOM_ACCESS_TOKEN;
// Knowledge Hub "folders" are only exposed on the Unstable API (article `folder_id`
// + GET /folders); classic Help Center Collections use the stable version. So when
// a folder is targeted we default to Unstable, otherwise 2.15.
const FOLDER_ID = process.env.INTERCOM_FOLDER_ID || null;
const VERSION = process.env.INTERCOM_VERSION || (FOLDER_ID ? "Unstable" : "2.15");
const COLLECTION_NAME =
  process.env.INTERCOM_COLLECTION_NAME || "ATTRIBUT CLI Connector";
const STATE = process.env.INTERCOM_ARTICLE_STATE || "draft";
let AUTHOR_ID = process.env.INTERCOM_AUTHOR_ID || null;

// --- fail loud on missing config ------------------------------------------
if (!DRY_RUN && !TOKEN) {
  console.error(
    "[intercom] ERROR: INTERCOM_ACCESS_TOKEN is not set. " +
      "Export your workspace access token, or use --dry-run to preview."
  );
  process.exit(1);
}
if (STATE !== "draft" && STATE !== "published") {
  console.error(
    `[intercom] ERROR: INTERCOM_ARTICLE_STATE must be "draft" or "published", got "${STATE}".`
  );
  process.exit(1);
}

// --- minimal Markdown -> HTML converter -----------------------------------
// Handles the subset used in our docs: headings, bold/italic/inline-code,
// links, unordered/ordered lists, GitHub-style tables, fenced code,
// paragraphs. Good enough for help-center prose; swap for `marked` if you
// need more.
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(s) {
  // order matters: escape first, then re-introduce our own tags
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  let para = [];

  const flushParagraph = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line)) {
      flushParagraph();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; // skip closing fence
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushParagraph();
      const level = Math.min(h[1].length, 6);
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // GitHub table: header row, separator row, then body rows
    if (
      /\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])
    ) {
      flushParagraph();
      const cells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const header = cells(line);
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(cells(lines[i]));
        i++;
      }
      let tbl = "<table><thead><tr>";
      tbl += header.map((c) => `<th>${inline(c)}</th>`).join("");
      tbl += "</tr></thead><tbody>";
      for (const r of rows) {
        tbl += "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      }
      tbl += "</tbody></table>";
      out.push(tbl);
      continue;
    }

    // standalone image line: ![alt](src). Intercom article bodies can't host
    // repo-relative images via the API, so we emit a labeled placeholder the
    // author fills by dragging the screenshot into Intercom's editor. (On
    // GitHub the same Markdown renders the real image.)
    const img = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      flushParagraph();
      out.push(`<p><em>[Screenshot: ${escapeHtml(img[1] || img[2])}]</em></p>`);
      i++;
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // blank line = paragraph break
    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    // accumulate paragraph text
    para.push(line.trim());
    i++;
  }
  flushParagraph();
  return out.join("\n");
}

// --- HTTP helper: fail loud, never swallow --------------------------------
async function api(method, path, body) {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Intercom-Version": VERSION,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    const reset = res.headers.get("X-RateLimit-Reset");
    throw new Error(
      `Intercom rate limit hit (429) on ${method} ${path}. X-RateLimit-Reset=${reset}`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Intercom API error ${res.status} on ${method} ${path}: ${text}`
    );
  }
  return res.json();
}

// paginate GET endpoints that return {data|<key>, pages:{next}}
async function apiList(path, key) {
  const items = [];
  let next = path;
  while (next) {
    const page = await api("GET", next);
    for (const it of page[key] || page.data || []) items.push(it);
    // Intercom pagination: pages.next may be a URL string or {starting_after}
    const np = page.pages && page.pages.next;
    if (!np) break;
    if (typeof np === "string") {
      next = np.replace(API, "");
    } else if (np.starting_after) {
      const sep = path.includes("?") ? "&" : "?";
      next = `${path}${sep}starting_after=${encodeURIComponent(np.starting_after)}`;
    } else {
      break;
    }
  }
  return items;
}

// --- load local Markdown articles -----------------------------------------
function loadArticles() {
  const files = readdirSync(SRC)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => f.toLowerCase() !== "readme.md")
    .filter((f) => f !== SELF)
    .sort(); // numbered prefixes -> stable order

  return files.map((file) => {
    const raw = readFileSync(join(SRC, file), "utf8");
    const h1 = raw.match(/^\s*#\s+(.+?)\s*$/m);
    if (!h1) {
      throw new Error(
        `[intercom] ${file}: no H1 (# Title) found — cannot derive article title.`
      );
    }
    const title = h1[1].trim();
    // body = the raw Markdown after the H1 (HTML is rendered at send time, once
    // sibling article ids are known so "Related" titles can be linked).
    const md = raw.slice(raw.indexOf(h1[0]) + h1[0].length).trim();
    return { file, title, md };
  });
}

// Turn "Related" bullet lines whose text is another article's title into links.
// Runs on Markdown before HTML conversion. `idByTitle` maps title -> Intercom
// article id; `base` is the help-center origin. A title we don't recognise is
// left as plain text (no dead link).
function linkRelated(md, idByTitle, base) {
  const lines = md.split(/\r?\n/);
  let inRelated = false;
  return lines
    .map((line) => {
      if (/^#{1,6}\s+/.test(line)) inRelated = /^#{1,6}\s+related\b/i.test(line);
      if (!inRelated) return line;
      const m = line.match(/^(\s*[-*]\s+)(.+?)\s*$/);
      if (!m) return line;
      const id = idByTitle.get(m[2].trim());
      return id ? `${m[1]}[${m[2].trim()}](${base}/en/articles/${id})` : line;
    })
    .join("\n");
}

// The default help center's public origin (e.g. https://docs.attribut.ai), used
// to build cross-links. Falls back to null (links then skipped) on any failure.
async function helpCenterBase() {
  try {
    const hcs = await apiList("/help_center/help_centers", "data");
    const def = hcs.find((h) => h.default) || hcs[0];
    const u = def && (def.url || (def.custom_domain && `https://${def.custom_domain}`));
    return u ? u.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

// --- ensure the target collection exists (create if missing) --------------
async function ensureCollection() {
  const existing = await apiList("/help_center/collections", "data");
  const match = existing.find((c) => c.name === COLLECTION_NAME);
  if (match) {
    console.log(`[intercom] Using existing collection "${COLLECTION_NAME}" (${match.id}).`);
    return match.id;
  }
  console.log(`[intercom] Creating collection "${COLLECTION_NAME}".`);
  const created = await api("POST", "/help_center/collections", {
    name: COLLECTION_NAME,
    description: "ATTRIBUT CLI connector help articles.",
  });
  return created.id;
}

// --- resolve author_id (admin/teammate id) --------------------------------
async function resolveAuthorId() {
  if (AUTHOR_ID) return AUTHOR_ID;
  const me = await api("GET", "/me"); // the token's own admin
  if (!me || !me.id) {
    throw new Error(
      "[intercom] Could not resolve author_id from /me. Set INTERCOM_AUTHOR_ID (see GET /admins)."
    );
  }
  console.log(`[intercom] Authoring as admin ${me.id} (${me.email || "unknown"}).`);
  return me.id;
}

// --- main ------------------------------------------------------------------
async function main() {
  const articles = loadArticles();
  const target = FOLDER_ID
    ? `Knowledge Hub folder ${FOLDER_ID}`
    : `collection "${COLLECTION_NAME}"`;
  console.log(
    `[intercom] Found ${articles.length} article(s) in ${SRC} -> ${target} as ${STATE} (API ${VERSION}).`
  );

  if (DRY_RUN) {
    console.log("[intercom] --dry-run: no API calls will be made.\n");
    for (const a of articles) {
      const html = mdToHtml(a.md);
      console.log(`  - ${a.file}`);
      console.log(`      title: ${a.title}`);
      console.log(`      html : ${html.length} chars`);
      console.log(`      preview: ${html.slice(0, 120).replace(/\n/g, " ")}...`);
    }
    console.log(
      `\n[intercom] Would place each article in ${target}, resolve author via ` +
        `${AUTHOR_ID ? "INTERCOM_AUTHOR_ID" : "GET /me"}, cross-link "Related", then create/update each.`
    );
    return;
  }

  // Placement: a Knowledge Hub folder (article `folder_id`, Unstable API) OR a
  // classic Help Center collection (`parent_type: collection`, stable API).
  const collectionId = FOLDER_ID ? null : await ensureCollection();
  if (FOLDER_ID) console.log(`[intercom] Placing articles in Knowledge Hub folder ${FOLDER_ID}.`);
  AUTHOR_ID = await resolveAuthorId();
  const placement = FOLDER_ID
    ? { folder_id: Number(FOLDER_ID) }
    : { parent_id: collectionId, parent_type: "collection" };

  // index existing articles by title for idempotent update-or-create
  const existing = await apiList("/articles", "data");
  const byTitle = new Map(existing.map((a) => [a.title, a]));

  // Pass 1 — ensure every article exists so we know all sibling ids. New ones are
  // created with their (unlinked) body; existing ones keep their current id.
  const idByTitle = new Map();
  for (const a of articles) {
    const prior = byTitle.get(a.title);
    if (prior) {
      idByTitle.set(a.title, prior.id);
      continue;
    }
    const created = await api("POST", "/articles", {
      title: a.title,
      body: mdToHtml(a.md),
      author_id: AUTHOR_ID,
      state: STATE,
      ...placement,
    });
    idByTitle.set(a.title, created.id);
    console.log(`[intercom] Created "${a.title}" (${created.id}).`);
    await new Promise((r) => setTimeout(r, 250));
  }

  // Pass 2 — render each body with "Related" titles linked to their siblings and
  // PUT the final version. Idempotent: re-runs converge on the same content.
  const base = await helpCenterBase();
  if (!base) console.log(`[intercom] (help-center domain unavailable — leaving "Related" unlinked.)`);
  for (const a of articles) {
    const id = idByTitle.get(a.title);
    const md = base ? linkRelated(a.md, idByTitle, base) : a.md;
    await api("PUT", `/articles/${id}`, {
      title: a.title,
      body: mdToHtml(md),
      author_id: AUTHOR_ID,
      state: STATE,
      ...placement,
    });
    console.log(`[intercom] Wrote "${a.title}" (${id}).`);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("[intercom] Done.");
}

main().catch((err) => {
  console.error(`[intercom] FAILED: ${err.message}`);
  process.exit(1);
});
