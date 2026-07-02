#!/usr/bin/env node
// assign_collection.mjs
//
// Places the CLI help articles into a public Help Center **collection** (and a
// nested **section**) so they're grouped and visible on the customer-facing site.
//
// Why this is separate from upload_to_intercom.mjs:
//   - Knowledge Hub *folders* (what the uploader's INTERCOM_FOLDER_ID sets) are
//     INTERNAL organization only — they do NOT affect the public Help Center.
//   - *Collections* (and sections) are the PUBLIC structure. An article is only
//     visible to customers when it's in a collection.
//   An article can have both at once (folder_id + collection parent), so this
//   script leaves folder_id — and the article BODY — untouched. Intercom updates
//   are partial: we PUT only {parent_id, parent_type}, so any screenshots you
//   added in the Intercom editor are preserved.
//
// Model note: a "section" is just a collection with a parent_id. Articles attach
// to it with parent_type:"collection" pointing at the section's id. Collections
// live on the stable API, so this script uses Intercom-Version 2.15.
//
// Idempotent: collection/section are matched by name (created if missing);
// articles are matched by title (the H1 of each local .md) and re-assigned.
//
// Usage:
//   INTERCOM_ACCESS_TOKEN=xxx node docs/intercom/assign_collection.mjs
//   node docs/intercom/assign_collection.mjs --dry-run
//
// Env:
//   INTERCOM_ACCESS_TOKEN    (required unless --dry-run)
//   INTERCOM_COLLECTION_NAME (optional) default "Connectors"  (top-level collection)
//   INTERCOM_SECTION_NAME    (optional) default "CLI"          (section under it)
//   INTERCOM_HELP_CENTER_ID  (optional) default = the workspace's default help center
//   INTERCOM_VERSION         (optional) default "2.15"

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";

const API = "https://api.intercom.io";
const DRY_RUN = process.argv.includes("--dry-run");
const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));
const SRC = process.env.INTERCOM_SRC_DIR ? resolve(HERE, process.env.INTERCOM_SRC_DIR) : HERE;

const TOKEN = process.env.INTERCOM_ACCESS_TOKEN;
const VERSION = process.env.INTERCOM_VERSION || "2.15";
const COLLECTION_NAME = process.env.INTERCOM_COLLECTION_NAME || "Connectors";
const SECTION_NAME = process.env.INTERCOM_SECTION_NAME || "CLI";
let HELP_CENTER_ID = process.env.INTERCOM_HELP_CENTER_ID || null;

if (!DRY_RUN && !TOKEN) {
  console.error("[intercom] ERROR: INTERCOM_ACCESS_TOKEN is not set (or use --dry-run).");
  process.exit(1);
}

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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Intercom API ${res.status} on ${method} ${path}: ${text}`);
  }
  return res.json();
}

async function apiList(path, key = "data") {
  const items = [];
  let next = path;
  while (next) {
    const page = await api("GET", next);
    for (const it of page[key] || page.data || []) items.push(it);
    const np = page.pages && page.pages.next;
    if (!np) break;
    if (typeof np === "string") next = np.replace(API, "");
    else if (np.starting_after) {
      const sep = path.includes("?") ? "&" : "?";
      next = `${path}${sep}starting_after=${encodeURIComponent(np.starting_after)}`;
    } else break;
  }
  return items;
}

// Titles this script manages = the H1 of every article .md alongside it.
function localTitles() {
  const titles = [];
  for (const f of readdirSync(SRC)) {
    if (!f.endsWith(".md") || f.toLowerCase() === "readme.md" || f === SELF) continue;
    const m = readFileSync(join(SRC, f), "utf8").match(/^\s*#\s+(.+?)\s*$/m);
    if (m) titles.push(m[1].trim());
  }
  return titles;
}

async function defaultHelpCenterId() {
  if (HELP_CENTER_ID) return HELP_CENTER_ID;
  const hcs = await apiList("/help_center/help_centers");
  const def = hcs.find((h) => h.default) || hcs[0];
  if (!def) throw new Error("[intercom] no help center found; set INTERCOM_HELP_CENTER_ID.");
  return def.id;
}

// Find a collection by name (+ optional parent), create it if missing.
async function ensureCollection(name, parentId, helpCenterId) {
  const cols = await apiList("/help_center/collections");
  const match = cols.find(
    (c) => c.name === name && String(c.parent_id || "") === String(parentId || "")
  );
  if (match) return match.id;
  const body = { name, help_center_id: helpCenterId };
  if (parentId) body.parent_id = parentId; // a collection with a parent IS a section
  const created = await api("POST", "/help_center/collections", body);
  return created.id;
}

async function main() {
  const titles = localTitles();
  console.log(
    `[intercom] ${titles.length} article(s) -> collection "${COLLECTION_NAME}" / section "${SECTION_NAME}".`
  );

  if (DRY_RUN) {
    console.log("[intercom] --dry-run: no API calls.\n");
    titles.forEach((t) => console.log(`  - ${t}`));
    console.log(`\n[intercom] Would ensure "${COLLECTION_NAME}" > "${SECTION_NAME}" and assign each by title (body untouched).`);
    return;
  }

  const helpCenterId = await defaultHelpCenterId();
  const collectionId = await ensureCollection(COLLECTION_NAME, null, helpCenterId);
  console.log(`[intercom] collection "${COLLECTION_NAME}" = ${collectionId}`);
  const sectionId = await ensureCollection(SECTION_NAME, collectionId, helpCenterId);
  console.log(`[intercom] section "${SECTION_NAME}" = ${sectionId}`);

  const existing = await apiList("/articles");
  const byTitle = new Map(existing.map((a) => [a.title, a]));

  let assigned = 0,
    missing = 0;
  for (const title of titles) {
    const art = byTitle.get(title);
    if (!art) {
      console.error(`  ! no Intercom article titled "${title}" — run upload_to_intercom.mjs first.`);
      missing++;
      continue;
    }
    // Partial update: only placement. Body + folder_id are preserved.
    await api("PUT", `/articles/${art.id}`, { parent_id: Number(sectionId), parent_type: "collection" });
    console.log(`  ✓ ${title} (${art.id}) -> section ${sectionId}`);
    assigned++;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[intercom] Done. Assigned ${assigned}, missing ${missing}.`);
  if (missing) process.exit(1);
}

main().catch((err) => {
  console.error(`[intercom] FAILED: ${err.message}`);
  process.exit(1);
});
