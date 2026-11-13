// Discover over the Target companies' boards: read every board through its reader, then in
// one write record the Discover run, match every posting to a Listing (dedupe.ts: same
// alias, shared ATS link, repost) or create a new one, mark gone every Listing missing from
// the boards that were read successfully, and mark similar roles. "Same job?" pairs go back to
// the skill for the LLM; `discover confirm` applies its verdicts.
// Discover's writes need no Approval. Record shapes: docs/agents/core-conventions.md.
import { randomUUID } from "node:crypto";
import { ATS_NAMES, BOARD_READERS, boardId } from "./boards/index.ts";
import type { Board, JobPosting } from "./boards/reader.ts";
import {
  keepApart,
  type ListingData,
  loadBook,
  type Merge,
  markSimilarRoles,
  mergeListings,
  observe,
  parseJudgments,
  type SameJobCandidate,
  sameJobCandidates,
  splitListing,
  writeBook,
} from "./dedupe.ts";
import { timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";
import { readRunLock } from "./lock.ts";
import { assertProfileComplete, readProfile } from "./profile.ts";
import { getRecord, notFound, type StoredRecord, withWriter } from "./store.ts";
import { isObject } from "./validate.ts";

export type { Sighting } from "./dedupe.ts";

export type SourceStatus = "ok" | "failed" | "skipped";

/** One board as the Discover run saw it. */
export interface RunSource {
  /** The board ID, e.g. "greenhouse:acme"; Listing IDs from it start with it. */
  id: string;
  ats: Board["ats"];
  company: string;
  status: SourceStatus;
  /** Jobs on the board; null unless status is "ok". */
  jobs: number | null;
  /** Why the board failed or was skipped; null when ok. */
  error: { code: string; message: string } | null;
}

export interface TargetCompany {
  name: string;
  board: Board;
}

export async function targetCompanies(dataDir: string): Promise<TargetCompany[]> {
  await assertProfileComplete(dataDir);
  const profile = await readProfile(dataDir);
  const filters = isObject(profile?.filters) ? profile.filters : {};
  return (filters.target_companies as TargetCompany[] | undefined) ?? [];
}

export async function targetRoles(dataDir: string): Promise<string[]> {
  const profile = await readProfile(dataDir);
  const targets = isObject(profile?.targets) ? profile.targets : {};
  return (targets.roles as string[] | undefined) ?? [];
}

export interface BoardResult {
  source: RunSource;
  postings: JobPosting[];
}

export async function readBoard(company: TargetCompany, roles: string[]): Promise<BoardResult> {
  const { board } = company;
  const base = { id: boardId(board), ats: board.ats, company: company.name };
  const reader = BOARD_READERS[board.ats];
  if (reader === undefined) {
    const error = {
      code: "BOARD_NOT_SUPPORTED",
      message: `Discover can't read ${ATS_NAMES[board.ats]} boards yet, so ${company.name} wasn't searched.`,
    };
    return { source: { ...base, status: "skipped", jobs: null, error }, postings: [] };
  }
  try {
    const postings = await reader.read(board, { company: company.name, target_roles: roles });
    return { source: { ...base, status: "ok", jobs: postings.length, error: null }, postings };
  } catch (e) {
    // A BoardFailure, or a network failure (NETWORK_ERROR), fails this source only.
    if (!(e instanceof CoreError)) throw e;
    const error = { code: e.code, message: e.message };
    return { source: { ...base, status: "failed", jobs: null, error }, postings: [] };
  }
}

/** A new Listing as `discover boards` names it, so the skill reports without more reads. */
interface NewListing {
  id: string;
  company: string;
  title: string;
  location: string | null;
}

/** Read every Target company's board and write the Discover run, Listings and Sightings. */
export async function discoverBoards(dataDir: string): Promise<{
  discover_run: StoredRecord;
  new: NewListing[];
  same_job: SameJobCandidate[];
}> {
  const companies = await targetCompanies(dataDir);
  const roles = await targetRoles(dataDir);
  const startedAt = timestamp();

  const results: BoardResult[] = [];
  const seenBoards = new Set<string>();
  for (const company of companies) {
    if (seenBoards.has(boardId(company.board))) continue;
    seenBoards.add(boardId(company.board));
    results.push(await readBoard(company, roles));
  }

  return withWriter(dataDir, "discover boards", async (w) => {
    const now = timestamp();
    const runId = randomUUID();
    const book = await loadBook(dataDir);
    const seenAliases = new Set<string>();
    const seen = new Set<string>();
    const created: string[] = [];
    const merges: Merge[] = [];
    const reposts: { listing: string; alias: string }[] = [];

    for (const { source, postings } of results) {
      for (const posting of postings) {
        const alias = `${source.id}:${posting.source_job_id}`;
        if (seenAliases.has(alias)) continue;
        seenAliases.add(alias);
        const at = { board: source.id, ats: source.ats, company: source.company, posting };
        const outcome = observe(book, at, runId, now);
        seen.add(outcome.listing);
        if (outcome.kind === "new") created.push(outcome.listing);
        if (outcome.kind === "merged") merges.push(outcome.merge);
        if (outcome.kind === "repost") reposts.push({ listing: outcome.listing, alias });
      }
    }

    // Gone: not seen, and every board it is on that this run covered was read successfully.
    const status = new Map(results.map((r) => [r.source.id, r.source.status]));
    const gone: string[] = [];
    for (const listing of book.listings.values()) {
      if (seen.has(listing.id) || listing.gone === true) continue;
      const boards = new Set([listing.board, ...listing.aliases.map((a) => a.board)]);
      const covered = [...boards].filter((b): b is string => b !== undefined && status.has(b));
      if (covered.length === 0 || covered.some((b) => status.get(b) !== "ok")) continue;
      gone.push(listing.id);
      listing.gone = true;
      listing.gone_at = now;
      book.changed.add(listing.id);
    }

    const similar = markSimilarRoles(book);
    await writeBook(book, w);

    const named: NewListing[] = created.map((id) => {
      const l = book.listings.get(id) as ListingData;
      return { id, company: l.company, title: l.title, location: l.location };
    });
    const lockRun = await readRunLock(dataDir);
    const discoverRun = await w.put("discover-run", runId, {
      started_at: startedAt,
      finished_at: now,
      run_id: lockRun?.run_id ?? null,
      sources: results.map((r) => r.source),
      new_listings: created,
      gone_listings: gone,
      listings_seen: seen.size,
      merges,
      reposts,
      similar_roles: similar,
    });
    return { discover_run: discoverRun, new: named, same_job: sameJobCandidates(book) };
  });
}

/**
 * Apply the worker's "same job?" verdicts: merge confirmed pairs (recorded on the Discover
 * run for the digest) and keep the others apart as "similar role". A pair that is no longer a
 * candidate (merged, split or judged since) is skipped.
 */
export async function confirmSameJob(
  dataDir: string,
  discoverRunId: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const judgments = parseJudgments(input);
  return withWriter(dataDir, "discover confirm", async (w) => {
    const run = await getRecord(dataDir, "discover-run", discoverRunId);
    if (run === undefined) throw notFound("discover-run", discoverRunId);
    const now = timestamp();
    const book = await loadBook(dataDir);
    const merged: Merge[] = [];
    const keptApart: [string, string][] = [];
    const skipped: { listing: string; other: string; why: string }[] = [];
    for (const j of judgments) {
      const open = sameJobCandidates(book).some(
        (c) =>
          (c.listing.id === j.listing && c.other.id === j.other) ||
          (c.listing.id === j.other && c.other.id === j.listing),
      );
      if (!open) {
        skipped.push({ listing: j.listing, other: j.other, why: "no longer a same-job candidate" });
        continue;
      }
      if (j.same_job) {
        merged.push(mergeListings(book, j.other, j.listing, j.reason, now));
      } else {
        keepApart(book, j.listing, j.other);
        keptApart.push([j.listing, j.other]);
      }
    }
    const similar = markSimilarRoles(book);
    await writeBook(book, w);
    const { schema_version: _v, id: _i, created_at: _c, updated_at: _u, ...fields } = run;
    await w.put("discover-run", run.id, {
      ...fields,
      merges: [...((run.merges as Merge[] | undefined) ?? []), ...merged],
      similar_roles: [...((run.similar_roles as unknown[] | undefined) ?? []), ...similar],
    });
    return { merged, kept_apart: keptApart, similar_roles: similar, skipped };
  });
}

/** The job seeker's split of a wrong merge, recorded as an override on both Listings. */
export async function splitMerged(
  dataDir: string,
  listingId: string,
  aliasId: string,
): Promise<Record<string, unknown>> {
  return withWriter(dataDir, "listing split", async (w) => {
    const book = await loadBook(dataDir);
    const { listing, split } = splitListing(book, listingId, aliasId, timestamp());
    markSimilarRoles(book);
    await writeBook(book, w);
    return { listing: book.listings.get(listing.id), split: book.listings.get(split.id) };
  });
}
