// LinkedIn Listings (#38): a job the job seeker pasted (or, from #51, found in a LinkedIn
// job-alert email) becomes a Listing whose source is "linkedin", and is matched to the
// employer's ATS posting. LinkedIn is never fetched: its URL is only an identifier.
//
//   linkedin add      LinkedIn jobs in → LinkedIn Listings, the Target company's board read for
//                     same-title postings, and "LinkedIn match" questions for the worker
//   linkedin match    the same questions for LinkedIn-only Listings already stored, against the
//                     Listings on hand (no fetch): run after `discover boards`
//   linkedin confirm  the worker's answers: a match merges the two as aliases (step
//                     "linkedin-match"); "none of these" keeps them apart for good
//
// A LinkedIn-only Listing is `existence_unverified` (a ghost signal, #39) and Apply hands over
// its link (#45). Record shapes: docs/agents/core-conventions.md, "LinkedIn".
import { createHash, randomUUID } from "node:crypto";
import { boardId } from "./boards/index.ts";
import {
  addListing,
  type Book,
  bothApplied,
  findByAlias,
  keepApart,
  keptApart,
  LINKEDIN,
  type ListingData,
  linkedInOnly,
  loadBook,
  type Merge,
  markSimilarRoles,
  mergeListings,
  observe,
  sideOf,
  writeBook,
} from "./dedupe.ts";
import { type BoardResult, readBoard, type TargetCompany, targetCompanies } from "./discover.ts";
import { timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";
import { readRunLock } from "./lock.ts";
import {
  normaliseCompanyName,
  normaliseLocation,
  normaliseTitle,
  sameCompany,
} from "./same-role.ts";
import { getRecord, notFound, type StoredRecord, withWriter } from "./store.ts";
import { isObject } from "./validate.ts";

/** How the job reached Job Butler. */
export type Intake = "pasted" | "alert";

/** One LinkedIn job as `linkedin add` takes it (the skill or #51's alert reader fills it). */
export interface LinkedInJob {
  company: string;
  title: string;
  location: string | null;
  /** The LinkedIn job link, stored as an identifier and never fetched. */
  url: string | null;
  /** The advert text; may be empty (alert emails carry no description). */
  description: string;
  intake: Intake;
}

const JOB_KEYS = new Set(["company", "title", "location", "url", "description", "intake"]);

function invalid(detail: string): CoreError {
  return new CoreError(
    "LINKEDIN_JOB_INVALID",
    `The LinkedIn job isn't in the expected shape (${detail}). Nothing was changed.`,
  );
}

export function parseLinkedInJobs(input: unknown): LinkedInJob[] {
  if (!isObject(input) || !Array.isArray(input.jobs)) throw invalid("no jobs list");
  return input.jobs.map((j, i) => {
    if (!isObject(j)) throw invalid(`job ${i} isn't an object`);
    const extra = Object.keys(j).filter((k) => !JOB_KEYS.has(k));
    if (extra.length > 0) throw invalid(`job ${i} has unknown fields: ${extra.join(", ")}`);
    const text = (k: string) => (typeof j[k] === "string" ? (j[k] as string).trim() : "");
    if (text("company") === "" || text("title") === "") {
      throw invalid(`job ${i} needs a company and a title`);
    }
    for (const k of ["location", "url", "description"]) {
      if (j[k] !== undefined && j[k] !== null && typeof j[k] !== "string") {
        throw invalid(`job ${i}'s ${k} must be text`);
      }
    }
    if (j.intake !== undefined && j.intake !== "pasted" && j.intake !== "alert") {
      throw invalid(`job ${i}'s intake must be "pasted" or "alert"`);
    }
    return {
      company: text("company"),
      title: text("title"),
      location: text("location") || null,
      url: text("url") || null,
      description: text("description"),
      intake: (j.intake as Intake | undefined) ?? "pasted",
    };
  });
}

// ---- Identity ---------------------------------------------------------------------------------

/**
 * The LinkedIn job ID in a job link: `/jobs/view/<id>`, `/jobs/view/<slug>-<id>`,
 * `/comm/jobs/view/<id>` (alert emails) or `?currentJobId=<id>`. Null when the URL is a
 * LinkedIn page without one; throws when it isn't a LinkedIn URL at all.
 */
export function linkedInJobId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw notLinkedIn(url);
  }
  const host = u.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) throw notLinkedIn(url);
  const view = u.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d+)(?:\/|$)/);
  if (view) return view[1] as string;
  const current = u.searchParams.get("currentJobId");
  return current !== null && /^\d+$/.test(current) ? current : null;
}

function notLinkedIn(url: string): CoreError {
  return new CoreError(
    "NOT_A_LINKEDIN_URL",
    `"${url}" isn't a LinkedIn job link. Paste the LinkedIn job's link, or leave the link out; jobs on an employer's own board come in through its Target company.`,
    { url },
  );
}

/**
 * The alias ID and stored link of a LinkedIn job: `linkedin:<job id>` with the bare job link
 * (tracking parameters dropped), or, with no job link, `linkedin:p-<hash>` of the company,
 * title and location, so pasting the same job again finds the same Listing.
 */
export function linkedInIdentity(job: LinkedInJob): { id: string; url: string | null } {
  if (job.url !== null) {
    const jobId = linkedInJobId(job.url);
    if (jobId !== null) {
      return { id: `${LINKEDIN}:${jobId}`, url: `https://www.linkedin.com/jobs/view/${jobId}/` };
    }
    throw new CoreError(
      "NOT_A_LINKEDIN_URL",
      `"${job.url}" is a LinkedIn page but not a job's link (it has no job number). Open the job itself and copy its link, or leave the link out.`,
      { url: job.url },
    );
  }
  const key = [
    normaliseCompanyName(job.company),
    normaliseTitle(job.title),
    normaliseLocation(job.location),
  ].join("|");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return { id: `${LINKEDIN}:p-${hash}`, url: null };
}

// ---- Matching ---------------------------------------------------------------------------------

/**
 * The Target company a LinkedIn company name stands for: the same normalised name, else one
 * name being the other's leading words ("Greenhouse Software, Inc." → "Greenhouse").
 */
export function findTargetCompany(
  targets: TargetCompany[],
  company: string,
): TargetCompany | undefined {
  const name = normaliseCompanyName(company);
  const exact = targets.find((t) => normaliseCompanyName(t.name) === name);
  if (exact !== undefined) return exact;
  const leading = (long: string, short: string) => long.startsWith(`${short} `);
  return targets.find((t) => {
    const target = normaliseCompanyName(t.name);
    return target !== "" && (leading(name, target) || leading(target, name));
  });
}

/**
 * LinkedIn writes locations its own way ("London, England, United Kingdom" for "London").
 * Two locations overlap when either is missing, both say remote, or one's first part (the
 * city) appears in the other.
 */
export function locationsOverlap(a: string | null, b: string | null): boolean {
  const x = normaliseLocation(a);
  const y = normaliseLocation(b);
  if (x === "" || y === "" || x === y) return true;
  const remote = (s: string) => ` ${s} `.includes(" remote ");
  if (remote(x) && remote(y)) return true;
  const city = (loc: string | null) => normaliseLocation((loc ?? "").split(/[,(|/–-]/)[0]);
  const within = (part: string, whole: string) => part !== "" && ` ${whole} `.includes(` ${part} `);
  return within(city(a), y) || within(city(b), x);
}

/**
 * The ATS Listings a LinkedIn-only Listing may be: live, in the same company scope, same
 * title, overlapping location, on an ATS board, and not yet ruled a different job.
 */
function candidatesFor(book: Book, l: ListingData): ListingData[] {
  return [...book.listings.values()].filter(
    (o) =>
      o.id !== l.id &&
      o.gone !== true &&
      !linkedInOnly(o) &&
      sameCompany(o, l) &&
      normaliseTitle(o.title) === normaliseTitle(l.title) &&
      locationsOverlap(o.location, l.location) &&
      !keptApart(l, o.id) &&
      !keptApart(o, l.id) &&
      !bothApplied(book, l, o),
  );
}

/** One "LinkedIn match" question for the worker. */
export interface LinkedInMatchQuestion {
  linkedin: Record<string, unknown>;
  candidates: Record<string, unknown>[];
}

/** What the job seeker sees at the Shortlist pick for a Listing with a LinkedIn copy. */
export interface LinkedInPairing {
  listing: string;
  linkedin: { id: string; url: string | null }[];
  /** The employer's ATS posting; null while the Listing is LinkedIn-only. */
  ats: { id: string; source: string; url: string | null } | null;
  /** The worker's reason for the pairing; null when not paired. */
  reason: string | null;
  existence_unverified: boolean;
}

/** The LinkedIn ↔ ATS pairing of a Listing, or null when it has no LinkedIn copy. */
export function linkedInPairing(l: ListingData): LinkedInPairing | null {
  const source = (a: { id: string; source?: string }) => a.source ?? a.id.split(":")[0] ?? "";
  const linkedin = l.aliases.filter((a) => source(a) === LINKEDIN);
  if (linkedin.length === 0) return null;
  const ats = l.aliases.find((a) => source(a) !== LINKEDIN);
  const merges = (l.merges as Merge[] | undefined) ?? [];
  const merge = merges.filter((m) => m.step === "linkedin-match").at(-1);
  return {
    listing: l.id,
    linkedin: linkedin.map((a) => ({ id: a.id, url: a.url })),
    ats: ats === undefined ? null : { id: ats.id, source: source(ats), url: ats.url },
    reason: merge?.reason ?? null,
    existence_unverified: ats === undefined,
  };
}

/** How one LinkedIn job ended up, as `linkedin add` and `linkedin match` report it. */
export interface IntakeResult {
  /** The Listing that holds the LinkedIn copy (the ATS Listing once paired). */
  listing: string;
  company: string;
  title: string;
  location: string | null;
  /** matched: paired with an ATS posting; to_confirm: candidates await the worker;
   *  unmatched: LinkedIn-only, existence unverified. */
  status: "matched" | "unmatched" | "to_confirm";
  /** The Target company it belongs to; null means ask the job seeker "add this company?". */
  target_company: string | null;
  new_company: boolean;
  pairing: LinkedInPairing | null;
}

function assess(
  book: Book,
  l: ListingData,
  targets: TargetCompany[],
  questions: LinkedInMatchQuestion[],
): IntakeResult {
  const target = findTargetCompany(targets, l.company) ?? null;
  let status: IntakeResult["status"] = "matched";
  if (linkedInOnly(l)) {
    const candidates = candidatesFor(book, l);
    status = candidates.length > 0 ? "to_confirm" : "unmatched";
    if (candidates.length > 0) {
      questions.push({ linkedin: sideOf(l), candidates: candidates.map(sideOf) });
    }
  }
  return {
    listing: l.id,
    company: l.company,
    title: l.title,
    location: l.location,
    status,
    target_company: target?.name ?? null,
    new_company: target === null,
    pairing: status === "matched" ? linkedInPairing(l) : null,
  };
}

// ---- Commands ---------------------------------------------------------------------------------

interface IntakeOutput {
  discover_run: StoredRecord;
  listings: IntakeResult[];
  linkedin_match: LinkedInMatchQuestion[];
  new_companies: string[];
}

function report(
  results: IntakeResult[],
  questions: LinkedInMatchQuestion[],
): Omit<IntakeOutput, "discover_run"> {
  const newCompanies = [...new Set(results.filter((r) => r.new_company).map((r) => r.company))];
  return { listings: results, linkedin_match: questions, new_companies: newCompanies };
}

/**
 * Take LinkedIn jobs in: read each Target company's board for postings with the same title,
 * record a Discover run (`intake: "linkedin"`), add or sight each job's LinkedIn Listing, and
 * return the "LinkedIn match" questions for the worker.
 */
export async function addLinkedInJobs(dataDir: string, input: unknown): Promise<IntakeOutput> {
  const jobs = parseLinkedInJobs(input);
  const identities = jobs.map(linkedInIdentity);
  const targets = await targetCompanies(dataDir);
  const startedAt = timestamp();

  // Read each Target company's board once, searching (Workday) for the jobs' titles.
  const byBoard = new Map<string, { company: TargetCompany; titles: string[] }>();
  for (const job of jobs) {
    const target = findTargetCompany(targets, job.company);
    if (target === undefined) continue;
    const entry = byBoard.get(boardId(target.board)) ?? { company: target, titles: [] };
    entry.titles.push(job.title);
    byBoard.set(boardId(target.board), entry);
  }
  const reads: (BoardResult & { titles: string[] })[] = [];
  for (const { company, titles } of byBoard.values()) {
    reads.push({ ...(await readBoard(company, titles)), titles });
  }

  return withWriter(dataDir, "linkedin add", async (w) => {
    const now = timestamp();
    const runId = randomUUID();
    const book = await loadBook(dataDir);
    const created: string[] = [];
    const seen = new Set<string>();

    // The board's postings for these titles, matched like any Discover Sighting.
    for (const { source, postings, titles } of reads) {
      const wanted = new Set(titles.map(normaliseTitle));
      for (const posting of postings) {
        if (!wanted.has(normaliseTitle(posting.title))) continue;
        const at = { board: source.id, ats: source.ats, company: source.company, posting };
        const outcome = observe(book, at, runId, now);
        seen.add(outcome.listing);
        if (outcome.kind === "new") created.push(outcome.listing);
      }
    }

    const results: IntakeResult[] = [];
    const questions: LinkedInMatchQuestion[] = [];
    jobs.forEach((job, i) => {
      const { id, url } = identities[i] as { id: string; url: string | null };
      const company = findTargetCompany(targets, job.company)?.name ?? job.company;
      const posting = {
        source_job_id: id.slice(LINKEDIN.length + 1),
        title: job.title,
        location: job.location,
        url,
        description: job.description,
        departments: [],
        employment_type: null,
        salary: null,
        posted_at: null,
        deadline: null,
        source_fields: { intake: job.intake },
      };
      const at = { board: LINKEDIN, ats: LINKEDIN, company, posting } as unknown as Parameters<
        typeof addListing
      >[1];
      let l = findByAlias(book, id);
      if (l === undefined) {
        l = addListing(book, at, id, runId, now);
        l.existence_unverified = true;
        created.push(l.id);
      } else {
        // Seen again: a Sighting; a LinkedIn-only Listing takes the latest text.
        if (linkedInOnly(l)) Object.assign(l, { company, ...posting, url });
        l.sightings = [...l.sightings, { discover_run: runId, alias: id, seen_at: now }];
        l.last_seen_at = now;
        book.changed.add(l.id);
      }
      seen.add(l.id);
      results.push(assess(book, l, targets, questions));
    });

    const similar = markSimilarRoles(book);
    await writeBook(book, w);
    const lockRun = await readRunLock(dataDir);
    const discoverRun = await w.put("discover-run", runId, {
      started_at: startedAt,
      finished_at: now,
      run_id: lockRun?.run_id ?? null,
      intake: LINKEDIN,
      sources: reads.map((r) => r.source),
      new_listings: created,
      gone_listings: [],
      listings_seen: seen.size,
      merges: [],
      reposts: [],
      similar_roles: similar,
      linkedin: results.map((r) => ({ listing: r.listing, status: r.status })),
    });
    return { discover_run: discoverRun, ...report(results, questions) };
  });
}

/**
 * The "LinkedIn match" questions for stored LinkedIn-only Listings (the given IDs, or all),
 * against the Listings on hand: run after `discover boards` so a board read since, or a
 * company added since, gets its chance to pair. Writes nothing.
 */
export async function matchLinkedIn(
  dataDir: string,
  ids: string[],
): Promise<Omit<IntakeOutput, "discover_run">> {
  const targets = await targetCompanies(dataDir);
  const book = await loadBook(dataDir);
  const chosen =
    ids.length > 0
      ? ids.map((id) => {
          const l = book.listings.get(id);
          if (l === undefined) throw notFound("listing", id);
          return l;
        })
      : [...book.listings.values()].filter((l) => linkedInOnly(l) && l.gone !== true);
  const questions: LinkedInMatchQuestion[] = [];
  const results = chosen.map((l) => assess(book, l, targets, questions));
  return report(results, questions);
}

/** The worker's answer to one "LinkedIn match" question. */
export interface LinkedInMatchJudgment {
  linkedin: string;
  match: string | null;
  reason: string;
}

export function parseMatchJudgments(input: unknown): LinkedInMatchJudgment[] {
  const bad = (detail: string) =>
    new CoreError(
      "JUDGMENT_INVALID",
      `The "LinkedIn match" judgment isn't in the expected shape (${detail}). Nothing was changed; run the judgment again.`,
    );
  if (!isObject(input) || !Array.isArray(input.matches)) throw bad("no matches list");
  return input.matches.map((j, i) => {
    if (
      !isObject(j) ||
      typeof j.linkedin !== "string" ||
      (j.match !== null && typeof j.match !== "string") ||
      typeof j.reason !== "string" ||
      j.reason.trim() === ""
    ) {
      throw bad(`match ${i} needs linkedin, match (an ID or null) and a reason`);
    }
    return { linkedin: j.linkedin, match: j.match as string | null, reason: j.reason.trim() };
  });
}

/**
 * Apply the worker's "LinkedIn match" answers: a match merges the LinkedIn Listing into the
 * ATS Listing as an alias (recorded on the Discover run, shown at the Shortlist pick); null
 * keeps it apart from every candidate it was offered, so it stays LinkedIn-only.
 */
export async function confirmLinkedInMatch(
  dataDir: string,
  discoverRunId: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const judgments = parseMatchJudgments(input);
  return withWriter(dataDir, "linkedin confirm", async (w) => {
    const run = await getRecord(dataDir, "discover-run", discoverRunId);
    if (run === undefined) throw notFound("discover-run", discoverRunId);
    const now = timestamp();
    const book = await loadBook(dataDir);
    const matched: Merge[] = [];
    const unmatched: string[] = [];
    const skipped: { linkedin: string; match: string | null; why: string }[] = [];
    for (const j of judgments) {
      const l = book.listings.get(j.linkedin);
      if (l === undefined || !linkedInOnly(l)) {
        skipped.push({ ...j, why: "no longer a LinkedIn-only Listing" });
        continue;
      }
      const candidates = candidatesFor(book, l);
      if (j.match === null) {
        for (const c of candidates) keepApart(book, l.id, c.id);
        unmatched.push(l.id);
        continue;
      }
      if (!candidates.some((c) => c.id === j.match)) {
        skipped.push({ ...j, why: "not one of its candidates" });
        continue;
      }
      matched.push(mergeListings(book, j.match, l.id, j.reason, now, "linkedin-match"));
    }
    const similar = markSimilarRoles(book);
    await writeBook(book, w);
    const { schema_version: _v, id: _i, created_at: _c, updated_at: _u, ...fields } = run;
    await w.put("discover-run", run.id, {
      ...fields,
      merges: [...((run.merges as Merge[] | undefined) ?? []), ...matched],
      similar_roles: [...((run.similar_roles as unknown[] | undefined) ?? []), ...similar],
    });
    const pairings = matched.map((m) =>
      linkedInPairing(book.listings.get(m.listing) as ListingData),
    );
    return { matched, pairings, unmatched, skipped };
  });
}
