// Retention (#53): keep pipeline state bounded and let the job seeker delete any record.
//
//  - Prune: a Listing that never became an Application is removed 90 days after its latest
//    Sighting, together with its Decision tree.
//  - Delete: any record, on the job seeker's request.
//
// Both are destructive: `prune` and `record delete` are in GATED_COMMANDS, so the hook runs
// them only under a destructive grant, which expires with its session.
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TREE_DIR, treePath, writeTrees } from "./decision-tree.ts";
import { now } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import {
  assertRecordType,
  getRecord,
  listRecords,
  notFound,
  type StoredRecord,
  TMP_MARKER,
  withWriter,
} from "./store.ts";

export const PRUNE_AFTER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The time of a Listing's latest Sighting (falling back to its last-seen or creation time). */
export function latestSighting(listing: StoredRecord): string {
  const times: string[] = [];
  if (Array.isArray(listing.sightings)) {
    for (const s of listing.sightings as { seen_at?: unknown }[]) {
      if (typeof s?.seen_at === "string") times.push(s.seen_at);
    }
  }
  for (const field of ["last_seen_at", "first_seen_at"]) {
    if (typeof listing[field] === "string") times.push(listing[field] as string);
  }
  if (times.length === 0) times.push(listing.created_at);
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

export interface PruneCandidate {
  id: string;
  company: unknown;
  title: unknown;
  latest_sighting_at: string;
}

/** Listings due for pruning now: no Application and latest Sighting ≥ 90 days ago. */
function dueForPruning(
  listings: StoredRecord[],
  applications: StoredRecord[],
): { cutoff: string; due: PruneCandidate[] } {
  const cutoff = new Date(now().getTime() - PRUNE_AFTER_DAYS * DAY_MS).toISOString();
  const applied = new Set(applications.map((a) => a.listing));
  const due = listings
    .filter((l) => !applied.has(l.id) && typeof l.application_id !== "string")
    .map((l) => ({ l, at: latestSighting(l) }))
    .filter(({ at }) => Date.parse(at) <= Date.parse(cutoff))
    .map(({ l, at }) => ({ id: l.id, company: l.company, title: l.title, latest_sighting_at: at }));
  return { cutoff, due };
}

/**
 * Files in decision-trees/ that no Listing owns: `.mmd` trees whose Listing is gone (a
 * dedupe merge deletes the Listing record but not its tree) and temp files left by an
 * interrupted write. Paths are relative to the data directory. Other files are left alone.
 */
async function strayTreeFiles(
  dataDir: string,
  listings: StoredRecord[],
): Promise<{ orphan_trees: string[]; temp_files: string[] }> {
  let names: string[];
  try {
    names = await readdir(join(dataDir, TREE_DIR));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { orphan_trees: [], temp_files: [] };
    throw e;
  }
  const owned = new Set(listings.map((l) => treePath(l.id)));
  const orphan_trees: string[] = [];
  const temp_files: string[] = [];
  for (const name of names.sort()) {
    const rel = `${TREE_DIR}/${name}`;
    if (name.includes(TMP_MARKER)) temp_files.push(rel);
    else if (name.endsWith(".mmd") && !owned.has(rel)) orphan_trees.push(rel);
  }
  return { orphan_trees, temp_files };
}

/** Everything `prune` would remove now, without removing it. */
export async function previewPrune(dataDir: string) {
  const listings = await listRecords(dataDir, "listing");
  const { cutoff, due } = dueForPruning(listings, await listRecords(dataDir, "application"));
  return { cutoff, pruned: due, ...(await strayTreeFiles(dataDir, listings)) };
}

/**
 * Remove every Listing due for pruning with its Decision tree, every orphan tree, and every
 * temp file left in decision-trees/.
 */
export async function prune(dataDir: string) {
  return withWriter(dataDir, "prune", async (w) => {
    const plan = await previewPrune(dataDir);
    for (const c of plan.pruned) {
      await w.delete("listing", c.id);
      await rm(join(dataDir, treePath(c.id)), { force: true });
    }
    for (const rel of [...plan.orphan_trees, ...plan.temp_files]) {
      await rm(join(dataDir, rel), { force: true });
    }
    return plan;
  });
}

// ---------------------------------------------------------------------------------------
// Delete: the job seeker's request to remove records.

/**
 * Delete records of one type, all or nothing, with the files that belong to them:
 *  - a Listing takes its Decision tree. One with an Application refuses
 *    LISTING_HAS_APPLICATION: delete the Application first.
 *  - an Application takes its Tailor folder (`tailor.folder`, relative to the data
 *    directory). Its Listing loses `application_id` and its tree is redrawn without the
 *    Event log, so the Listing is back on the Shortlist if Screen put it there.
 *  - any other type is just the record.
 */
export async function deleteRecords(dataDir: string, typeArg: string | undefined, ids: string[]) {
  const type = assertRecordType(typeArg);
  if (ids.length === 0) throw usageError("record delete: at least one <id> is required");
  return withWriter(dataDir, "record delete", async (w) => {
    const records: StoredRecord[] = [];
    for (const id of new Set(ids)) {
      const record = await getRecord(dataDir, type, id);
      if (record === undefined) throw notFound(type, id);
      records.push(record);
    }
    let applications = await listRecords(dataDir, "application");
    if (type === "listing") {
      for (const listing of records) {
        const app = applications.find((a) => a.listing === listing.id);
        if (app !== undefined) {
          throw new CoreError(
            "LISTING_HAS_APPLICATION",
            `${listing.company} · ${listing.title} has an Application (${app.id}), so its ` +
              "Listing wasn't deleted and nothing else was. Delete the Application first with " +
              `\`record delete application ${app.id}\`, then the Listing.`,
            { listing_id: listing.id, application_id: app.id },
          );
        }
      }
    }

    const filesRemoved: string[] = [];
    const removeFile = async (rel: string) => {
      const file = resolve(dataDir, rel);
      const inside = relative(dataDir, file);
      if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return;
      if (!existsSync(file)) return;
      await rm(file, { recursive: true, force: true });
      filesRemoved.push(inside.split(sep).join("/"));
    };

    for (const record of records) {
      await w.delete(type, record.id);
      if (type === "listing") await removeFile(treePath(record.id));
      if (type !== "application") continue;
      applications = applications.filter((a) => a.id !== record.id);
      const folder = (record.tailor as { folder?: unknown } | null | undefined)?.folder;
      if (typeof folder === "string" && folder !== "") await removeFile(folder);
      if (typeof record.listing !== "string") continue;
      const listing = await getRecord(dataDir, "listing", record.listing);
      if (listing === undefined) continue;
      const { schema_version: _v, id, created_at: _c, updated_at: _u, ...fields } = listing;
      if (fields.application_id === record.id) delete fields.application_id;
      const updated = await w.put("listing", id, fields);
      await writeTrees(dataDir, [updated], applications);
    }
    return { deleted: records.map((r) => ({ type, id: r.id })), files_removed: filesRemoved };
  });
}
