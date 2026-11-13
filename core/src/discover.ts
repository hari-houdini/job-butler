// Discover over the Target companies' boards: read every board through its reader, then in
// one write record the Discover run, add a Sighting to every Listing seen (creating new
// Listings), and mark gone every Listing missing from a board that was read successfully.
// Discover's writes need no Approval. Record shapes: docs/agents/core-conventions.md.
import { randomUUID } from "node:crypto";
import { ATS_NAMES, BOARD_READERS, boardId } from "./boards/index.ts";
import type { Board, JobPosting } from "./boards/reader.ts";
import { timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";
import { readRunLock } from "./lock.ts";
import { assertProfileComplete, readProfile } from "./profile.ts";
import { listRecords, type StoredRecord, withWriter } from "./store.ts";
import { isObject } from "./validate.ts";

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

export interface Sighting {
  discover_run: string;
  /** The alias (source ID) the Listing was seen as. */
  alias: string;
  seen_at: string;
}

interface TargetCompany {
  name: string;
  board: Board;
}

async function targetCompanies(dataDir: string): Promise<TargetCompany[]> {
  await assertProfileComplete(dataDir);
  const profile = await readProfile(dataDir);
  const filters = isObject(profile?.filters) ? profile.filters : {};
  return (filters.target_companies as TargetCompany[] | undefined) ?? [];
}

async function targetRoles(dataDir: string): Promise<string[]> {
  const profile = await readProfile(dataDir);
  const targets = isObject(profile?.targets) ? profile.targets : {};
  return (targets.roles as string[] | undefined) ?? [];
}

interface BoardResult {
  source: RunSource;
  postings: JobPosting[];
}

async function readBoard(company: TargetCompany, roles: string[]): Promise<BoardResult> {
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
export async function discoverBoards(
  dataDir: string,
): Promise<{ discover_run: StoredRecord; new: NewListing[] }> {
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
    const existing = new Map((await listRecords(dataDir, "listing")).map((l) => [l.id, l]));
    const seen = new Set<string>();
    const created: string[] = [];
    const named: NewListing[] = [];
    const gone: string[] = [];

    for (const { source, postings } of results) {
      for (const posting of postings) {
        const id = `${source.id}:${posting.source_job_id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const prev = existing.get(id);
        if (prev === undefined) {
          created.push(id);
          const { title, location } = posting;
          named.push({ id, company: source.company, title, location });
        }
        const sighting: Sighting = { discover_run: runId, alias: id, seen_at: now };
        await w.put("listing", id, {
          ...prev,
          source: source.ats,
          board: source.id,
          company: source.company,
          ...posting,
          aliases: prev?.aliases ?? [{ id, url: posting.url }],
          sightings: [...((prev?.sightings as Sighting[] | undefined) ?? []), sighting],
          first_seen_at: prev?.first_seen_at ?? now,
          last_seen_at: now,
          gone: false,
          gone_at: null,
        });
      }
    }

    const readBoards = new Set(
      results.filter((r) => r.source.status === "ok").map((r) => r.source.id),
    );
    for (const listing of existing.values()) {
      if (seen.has(listing.id) || listing.gone === true) continue;
      if (typeof listing.board !== "string" || !readBoards.has(listing.board)) continue;
      gone.push(listing.id);
      await w.put("listing", listing.id, { ...listing, gone: true, gone_at: now });
    }

    const lockRun = await readRunLock(dataDir);
    const discoverRun = await w.put("discover-run", runId, {
      started_at: startedAt,
      finished_at: now,
      run_id: lockRun?.run_id ?? null,
      sources: results.map((r) => r.source),
      new_listings: created,
      gone_listings: gone,
      listings_seen: seen.size,
    });
    return { discover_run: discoverRun, new: named };
  });
}
