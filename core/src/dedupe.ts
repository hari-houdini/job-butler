// Dedupe (#37): the same job seen on several sources, or reposted, stays one Listing.
// Works on an in-memory Listing book that the caller loads and writes back in one withWriter.
//
// A posting is matched within its company scope (same-role.ts), in this order:
//   1. same alias            → a Sighting on that Listing
//   2. shared ATS link        → merged automatically: a new alias and a Sighting
//   3. repost                 → a Listing gone at most 60 days with the same title, location and
//                               a near-identical description: a Sighting, repost_count + 1
//   4. otherwise a new Listing. Title + location matches across boards are then put to the
//      LLM ("same job?", agents/discover-worker.md) and merged only on its confirmation;
//      two live postings for the same role stay apart, marked "similar role".
// A split (job seeker's override) moves an alias and its Sightings to their own Listing and
// keeps the pair apart for good. Record shapes: docs/agents/core-conventions.md.
import type { JobPosting } from "./boards/reader.ts";
import { CoreError } from "./errors.ts";
import { sameCompany, sameRole } from "./same-role.ts";
import { listRecords, type StoredRecord } from "./store.ts";
import { isObject } from "./validate.ts";

export const REPOST_WINDOW_DAYS = 60;
/** Word-trigram Jaccard similarity at or above which two adverts are "near-identical". */
export const NEAR_IDENTICAL = 0.8;

/** How an alias joined its Listing. */
export type AliasVia = "own" | "shared-ats-link" | "same-job" | "repost";

/** One copy of the job on a source. The first alias is the Listing's own posting. */
export interface Alias {
  id: string;
  url: string;
  /** The board (source) ID this copy is on, e.g. "greenhouse:acme". */
  board?: string;
  source?: string;
  source_job_id?: string;
  title?: string;
  location?: string | null;
  via?: AliasVia;
  added_at?: string;
}

export interface Sighting {
  discover_run: string;
  /** The alias (source ID) the Listing was seen as. */
  alias: string;
  seen_at: string;
  /** True on the Sighting that recorded a repost. */
  repost?: boolean;
}

/** A merge, as recorded on the Discover run (the digest reports "same-job" merges). */
export interface Merge {
  listing: string;
  alias: string;
  step: "shared-ats-link" | "same-job";
  reason: string | null;
}

export type ListingData = Record<string, unknown> & {
  id: string;
  company: string;
  title: string;
  location: string | null;
  board: string;
  source: string;
  aliases: Alias[];
  sightings: Sighting[];
};

/** Every Listing, the changes to write back, and which Listings have an Application. */
export interface Book {
  listings: Map<string, ListingData>;
  changed: Set<string>;
  removed: Set<string>;
  withApplication: Set<string>;
}

/** Load every Listing and the Listing IDs that Applications refer to (`application.listing`). */
export async function loadBook(dataDir: string): Promise<Book> {
  const listings = new Map<string, ListingData>();
  for (const r of await listRecords(dataDir, "listing")) {
    const { schema_version: _v, created_at: _c, updated_at: _u, ...rest } = r;
    listings.set(r.id, rest as ListingData);
  }
  const withApplication = new Set<string>();
  for (const a of await listRecords(dataDir, "application")) {
    if (typeof a.listing === "string") withApplication.add(a.listing);
  }
  return { listings, changed: new Set(), removed: new Set(), withApplication };
}

function touch(book: Book, l: ListingData): void {
  book.listings.set(l.id, l);
  book.changed.add(l.id);
}

const list = (l: ListingData, field: string): string[] =>
  Array.isArray(l[field]) ? (l[field] as string[]) : [];

function addTo(l: ListingData, field: string, id: string): boolean {
  const cur = list(l, field);
  if (cur.includes(id)) return false;
  l[field] = [...cur, id].sort();
  return true;
}

const isLive = (l: ListingData): boolean => l.gone !== true;

/** True once the job seeker split the pair or the LLM said they're different jobs. */
function keptApart(a: ListingData, bId: string): boolean {
  return list(a, "distinct_from").includes(bId);
}

// ---- ATS links ----------------------------------------------------------------------------

/**
 * The alias ID an ATS posting URL stands for, in the board readers' ID form
 * (`<ats>:<token>:<job id>`), or null for any other URL. Greenhouse, Lever and Ashby
 * (core-conventions.md, "Dedupe"); Workday IDs are added with its reader (#36).
 */
export function atsPostingId(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter((s) => s !== "");
  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") {
    const forToken = u.searchParams.get("for");
    const jobToken = u.searchParams.get("token");
    if (seg[0] === "embed" && forToken && jobToken) return `greenhouse:${forToken}:${jobToken}`;
    if (seg.length >= 3 && seg[1] === "jobs" && /^\d+$/.test(seg[2] as string)) {
      return `greenhouse:${seg[0]}:${seg[2]}`;
    }
    return null;
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    return seg.length >= 2 ? `lever:${seg[0]}:${seg[1]}` : null;
  }
  if (host === "jobs.ashbyhq.com") {
    return seg.length >= 2 ? `ashby:${seg[0]}:${seg[1]}` : null;
  }
  return null;
}

function keysOf(id: string, url: string | null | undefined): string[] {
  const linked = atsPostingId(url);
  return linked === null || linked === id ? [id] : [id, linked];
}

function aliasKeys(l: ListingData): Set<string> {
  return new Set(l.aliases.flatMap((a) => keysOf(a.id, a.url)));
}

// ---- Description similarity ----------------------------------------------------------------

function trigrams(text: string): Set<string> {
  const w = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  if (out.size === 0 && w.length > 0) out.add(w.join(" "));
  return out;
}

/** Jaccard similarity of the two texts' word trigrams, 0..1. */
export function descriptionSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 && y.size === 0) return 1;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

// ---- Observing a posting --------------------------------------------------------------------

/** A posting found on a board this run. */
export interface Seen {
  board: string;
  ats: string;
  company: string;
  posting: JobPosting;
}

export type Outcome =
  | { kind: "seen"; listing: string }
  | { kind: "merged"; listing: string; merge: Merge }
  | { kind: "repost"; listing: string }
  | { kind: "new"; listing: string };

function aliasFor(seen: Seen, id: string, via: AliasVia, at: string): Alias {
  const p = seen.posting;
  return {
    id,
    url: p.url,
    board: seen.board,
    source: seen.ats,
    source_job_id: p.source_job_id,
    title: p.title,
    location: p.location,
    via,
    added_at: at,
  };
}

function postingFields(seen: Seen): Record<string, unknown> {
  return { source: seen.ats, board: seen.board, company: seen.company, ...seen.posting };
}

/**
 * The earliest-seen Listing first. Ties (seen in the same run) keep the book's order, which
 * within a run is the order the boards were read (Target company order).
 */
function byFirstSeen(a: ListingData, b: ListingData): number {
  const x = String(a.first_seen_at ?? "");
  const y = String(b.first_seen_at ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}

function inScope(book: Book, seen: Seen, id: string): ListingData[] {
  const ref = { company: seen.company, title: seen.posting.title };
  return [...book.listings.values()]
    .filter((l) => sameCompany(l, ref) && !keptApart(l, id))
    .sort(byFirstSeen);
}

function findByAlias(book: Book, id: string): ListingData | undefined {
  for (const l of book.listings.values()) if (l.aliases.some((a) => a.id === id)) return l;
  return undefined;
}

/**
 * Record one posting seen this run against the book, matching it to an existing Listing
 * (alias, shared ATS link, repost) or creating a new one.
 */
export function observe(book: Book, seen: Seen, runId: string, now: string): Outcome {
  const id = `${seen.board}:${seen.posting.source_job_id}`;
  const sighting: Sighting = { discover_run: runId, alias: id, seen_at: now };

  // 1. Same alias.
  const known = findByAlias(book, id);
  if (known !== undefined) {
    sight(book, known, seen, sighting);
    return { kind: "seen", listing: known.id };
  }

  const candidates = inScope(book, seen, id);

  // 2. Shared ATS link, either way round.
  const keys = keysOf(id, seen.posting.url);
  const linked = candidates.find((l) => {
    const theirs = aliasKeys(l);
    return keys.some((k) => theirs.has(k));
  });
  if (linked !== undefined) {
    linked.aliases = [...linked.aliases, aliasFor(seen, id, "shared-ats-link", now)];
    sight(book, linked, seen, sighting);
    const merge: Merge = { listing: linked.id, alias: id, step: "shared-ats-link", reason: null };
    return { kind: "merged", listing: linked.id, merge };
  }

  // 3. Repost: gone at most 60 days ago, same role and location, near-identical advert.
  const cutoff = Date.parse(now) - REPOST_WINDOW_DAYS * 86_400_000;
  const reposted = candidates.find(
    (l) =>
      !isLive(l) &&
      typeof l.gone_at === "string" &&
      Date.parse(l.gone_at) >= cutoff &&
      sameRole(l, { ...seen.posting, company: seen.company }, { location: true }) &&
      descriptionSimilarity(String(l.description ?? ""), seen.posting.description) >=
        NEAR_IDENTICAL,
  );
  if (reposted !== undefined) {
    reposted.aliases = [...reposted.aliases, aliasFor(seen, id, "repost", now)];
    reposted.repost_count = Number(reposted.repost_count ?? 0) + 1;
    sight(book, reposted, seen, { ...sighting, repost: true });
    return { kind: "repost", listing: reposted.id };
  }

  // 4. A new Listing.
  const listing = {
    ...postingFields(seen),
    aliases: [aliasFor(seen, id, "own", now)],
    sightings: [sighting],
    first_seen_at: now,
    last_seen_at: now,
    gone: false,
    gone_at: null,
    repost_count: 0,
    similar_roles: [],
    distinct_from: [],
    merges: [],
    overrides: [],
    id,
  } as unknown as ListingData;
  touch(book, listing);
  return { kind: "new", listing: id };
}

/** Add a Sighting; refresh the posting fields when it's a copy on the Listing's own board. */
function sight(book: Book, l: ListingData, seen: Seen, s: Sighting): void {
  if (seen.board === l.board) {
    const { id: _id, ...fields } = { id: l.id, ...postingFields(seen) };
    Object.assign(l, fields);
  }
  l.sightings = [...l.sightings, s];
  l.first_seen_at = l.first_seen_at ?? s.seen_at;
  l.last_seen_at = s.seen_at;
  l.gone = false;
  l.gone_at = null;
  touch(book, l);
}

// ---- Similar roles and "same job?" candidates ------------------------------------------------

function pairs(book: Book): [ListingData, ListingData][] {
  const live = [...book.listings.values()].filter(isLive).sort(byFirstSeen);
  const out: [ListingData, ListingData][] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i] as ListingData;
      const b = live[j] as ListingData;
      if (sameRole(a, b, { location: true })) out.push([a, b]);
    }
  }
  return out;
}

/**
 * Mark "similar role" on every pair of live Listings for the same role that are known to be
 * different jobs: on the same board, or kept apart by the LLM or a split. Marks are kept once
 * set. Returns the newly marked pairs.
 */
export function markSimilarRoles(book: Book): [string, string][] {
  const marked: [string, string][] = [];
  for (const [a, b] of pairs(book)) {
    if (a.board !== b.board && !keptApart(a, b.id) && !bothApplied(book, a, b)) continue;
    const added = addTo(a, "similar_roles", b.id);
    addTo(b, "similar_roles", a.id);
    if (added) {
      touch(book, a);
      touch(book, b);
      marked.push([a.id, b.id]);
    }
  }
  return marked;
}

function bothApplied(book: Book, a: ListingData, b: ListingData): boolean {
  return book.withApplication.has(a.id) && book.withApplication.has(b.id);
}

/** What the worker needs to judge one side of a "same job?" pair. */
function sideOf(l: ListingData): Record<string, unknown> {
  return {
    id: l.id,
    company: l.company,
    title: l.title,
    location: l.location,
    source: l.source,
    url: l.url ?? null,
    description: l.description ?? "",
  };
}

/** A pair for the LLM: `listing` is the later-seen one. */
export interface SameJobCandidate {
  listing: Record<string, unknown>;
  other: Record<string, unknown>;
}

/**
 * Live Listings for the same role (title + location) on different boards that nothing has
 * judged yet. Both having an Application rules a pair out.
 */
export function sameJobCandidates(book: Book): SameJobCandidate[] {
  return pairs(book)
    .filter(([a, b]) => a.board !== b.board && !keptApart(a, b.id) && !bothApplied(book, a, b))
    .map(([older, newer]) => ({ listing: sideOf(newer), other: sideOf(older) }));
}

// ---- Merge and split -----------------------------------------------------------------------

/**
 * Merge two Listings into one. The survivor is the one with an Application, else the
 * first seen, so a late duplicate never makes a second Application or a Shortlist return.
 */
export function mergeListings(
  book: Book,
  aId: string,
  bId: string,
  reason: string,
  now: string,
): Merge {
  const a = book.listings.get(aId) as ListingData;
  const b = book.listings.get(bId) as ListingData;
  const [keep, drop] =
    book.withApplication.has(b.id) && !book.withApplication.has(a.id)
      ? [b, a]
      : book.withApplication.has(a.id) && !book.withApplication.has(b.id)
        ? [a, b]
        : byFirstSeen(a, b) <= 0
          ? [a, b]
          : [b, a];
  keep.aliases = [
    ...keep.aliases,
    ...drop.aliases.map((al, i) => ({
      ...al,
      board: al.board ?? (i === 0 ? drop.board : undefined),
      source: al.source ?? (i === 0 ? drop.source : undefined),
      title: al.title ?? (i === 0 ? drop.title : undefined),
      location: al.location !== undefined ? al.location : i === 0 ? drop.location : undefined,
      via: "same-job" as const,
      added_at: now,
    })),
  ];
  keep.sightings = [...keep.sightings, ...drop.sightings].sort((x, y) =>
    x.seen_at < y.seen_at ? -1 : x.seen_at > y.seen_at ? 1 : 0,
  );
  keep.first_seen_at = [keep.first_seen_at, drop.first_seen_at].filter(Boolean).sort()[0];
  keep.last_seen_at = [keep.last_seen_at, drop.last_seen_at].filter(Boolean).sort().at(-1);
  if (isLive(drop)) {
    keep.gone = false;
    keep.gone_at = null;
  }
  keep.repost_count = Number(keep.repost_count ?? 0) + Number(drop.repost_count ?? 0);
  const merge: Merge = { listing: keep.id, alias: drop.id, step: "same-job", reason };
  keep.merges = [...((keep.merges as unknown[]) ?? []), { ...merge, merged_at: now }];
  for (const field of ["similar_roles", "distinct_from"]) {
    keep[field] = [...new Set([...list(keep, field), ...list(drop, field)])]
      .filter((x) => x !== keep.id && x !== drop.id)
      .sort();
  }
  book.listings.delete(drop.id);
  book.changed.delete(drop.id);
  book.removed.add(drop.id);
  touch(book, keep);
  // Other Listings that named the dropped one now name the survivor.
  for (const l of book.listings.values()) {
    for (const field of ["similar_roles", "distinct_from"]) {
      if (!list(l, field).includes(drop.id)) continue;
      l[field] = [...new Set(list(l, field).map((x) => (x === drop.id ? keep.id : x)))]
        .filter((x) => x !== l.id)
        .sort();
      touch(book, l);
    }
  }
  return merge;
}

/** Record the LLM's "different jobs" verdict: the pair is never asked about again. */
export function keepApart(book: Book, aId: string, bId: string): void {
  const a = book.listings.get(aId) as ListingData;
  const b = book.listings.get(bId) as ListingData;
  addTo(a, "distinct_from", b.id);
  addTo(b, "distinct_from", a.id);
  touch(book, a);
  touch(book, b);
}

/**
 * Split an alias, with its Sightings, off a merged Listing into its own Listing (ID = the
 * alias). Records a split override on both and keeps the pair apart for good.
 */
export function splitListing(
  book: Book,
  listingId: string,
  aliasId: string,
  now: string,
): { listing: ListingData; split: ListingData } {
  const from = book.listings.get(listingId);
  if (from === undefined) {
    throw new CoreError("NOT_FOUND", `There's no Listing "${listingId}".`, { listing: listingId });
  }
  const alias = from.aliases.find((a) => a.id === aliasId);
  if (alias === undefined) {
    throw new CoreError(
      "ALIAS_NOT_FOUND",
      `"${aliasId}" isn't one of ${from.title} at ${from.company}'s aliases, so there's nothing to split. Its aliases: ${from.aliases.map((a) => a.id).join(", ")}.`,
      { listing: listingId, alias: aliasId },
    );
  }
  if (aliasId === from.id) {
    throw new CoreError(
      "SPLIT_OWN_ALIAS",
      `"${aliasId}" is the Listing's own posting. Split off the other alias instead; the result is the same two Listings.`,
      { listing: listingId, alias: aliasId },
    );
  }
  if (book.listings.has(aliasId)) {
    throw new CoreError("SPLIT_CONFLICT", `A Listing "${aliasId}" already exists.`, {
      alias: aliasId,
    });
  }
  const moved = from.sightings.filter((s) => s.alias === aliasId);
  const kept = from.sightings.filter((s) => s.alias !== aliasId);
  const seenAt = moved.map((s) => s.seen_at).sort();
  const split = {
    ...from,
    id: aliasId,
    source: alias.source ?? aliasId.split(":")[0],
    board: alias.board ?? aliasId.split(":").slice(0, -1).join(":"),
    source_job_id: alias.source_job_id ?? aliasId.split(":").at(-1),
    title: alias.title ?? from.title,
    location: alias.location !== undefined ? alias.location : from.location,
    url: alias.url,
    aliases: [{ ...alias, via: "own" as const }],
    sightings: moved,
    first_seen_at: seenAt[0] ?? alias.added_at ?? now,
    last_seen_at: seenAt.at(-1) ?? alias.added_at ?? now,
    repost_count: moved.filter((s) => s.repost === true).length,
    similar_roles: [],
    distinct_from: [from.id],
    merges: [],
    overrides: [{ kind: "split", from: from.id, alias: aliasId, at: now }],
  } as ListingData;
  for (const field of ["screen", "shortlist", "decision_tree"]) delete split[field];
  from.aliases = from.aliases.filter((a) => a.id !== aliasId);
  from.sightings = kept;
  from.repost_count = Math.max(0, Number(from.repost_count ?? 0) - Number(split.repost_count));
  from.merges = ((from.merges as Merge[] | undefined) ?? []).filter((m) => m.alias !== aliasId);
  from.overrides = [
    ...((from.overrides as unknown[]) ?? []),
    { kind: "split", into: aliasId, alias: aliasId, at: now },
  ];
  addTo(from, "distinct_from", aliasId);
  touch(book, from);
  touch(book, split);
  return { listing: from, split };
}

/** Write the book's changes through a StoreWriter. */
export async function writeBook(
  book: Book,
  w: {
    put(type: "listing", id: string, data: Record<string, unknown>): Promise<StoredRecord>;
    delete(type: "listing", id: string): Promise<boolean>;
  },
): Promise<void> {
  for (const id of [...book.changed].sort()) {
    const l = book.listings.get(id);
    if (l !== undefined) await w.put("listing", id, l);
  }
  for (const id of book.removed) await w.delete("listing", id);
}

/** The judgment `discover confirm` takes, as the worker returns it. */
export interface SameJobJudgment {
  listing: string;
  other: string;
  same_job: boolean;
  reason: string;
}

export function parseJudgments(input: unknown): SameJobJudgment[] {
  const bad = (detail: string) =>
    new CoreError(
      "JUDGMENT_INVALID",
      `The "same job?" judgment isn't in the expected shape (${detail}). Nothing was changed; run the judgment again.`,
    );
  if (!isObject(input) || !Array.isArray(input.judgments)) throw bad("no judgments list");
  return input.judgments.map((j, i) => {
    if (
      !isObject(j) ||
      typeof j.listing !== "string" ||
      typeof j.other !== "string" ||
      typeof j.same_job !== "boolean" ||
      typeof j.reason !== "string" ||
      j.reason.trim() === ""
    ) {
      throw bad(`judgment ${i} needs listing, other, same_job and a reason`);
    }
    return { listing: j.listing, other: j.other, same_job: j.same_job, reason: j.reason.trim() };
  });
}
