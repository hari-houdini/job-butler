// Screen: run the check pipeline on each new Listing, store the results on it, rank the
// Shortlist, and write each Listing's Decision tree. The core never calls a model: the
// screen worker's judgments come in through `screen record --input`.
//
//   screen pending   -> the Listings to judge and the Profile parts the worker needs
//   screen record    -> validate the worker's judgments, run SCREEN_STEPS, write in one go
//   screen rescore   -> mark Listings to be scored again (only when the job seeker asks)
//   screen digest    -> the ranked Shortlist, lettered, with the terminal text
//   screen why <x>   -> one Listing's Checks with evidence
// See docs/agents/core-conventions.md, "Screen".
import { join } from "node:path";
import { applicationsByListing } from "./application.ts";
import { treePath, writeTrees } from "./decision-tree.ts";
import { timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { fitStep } from "./fit.ts";
import { ghostStep } from "./ghost.ts";
import { readRunLock } from "./lock.ts";
import { assertProfileComplete, readProfile } from "./profile.ts";
import { reapplyRestore } from "./restore.ts";
import { denyStep, scamStep } from "./scam-gate.ts";
import { type Check, marksFor, notReached, type ScreenStep } from "./screen-check.ts";
import { loadSponsorshipContext, type SponsorshipContext, sponsorshipStep } from "./sponsorship.ts";
import { getRecord, listRecords, type StoredRecord, withWriter } from "./store.ts";
import { isObject, type Problems } from "./validate.ts";

/**
 * The Screen checks, in the spec's order. Later tickets slot their steps in here:
 *   scam gate and deny list (#39, effect "exclude"), ghost score (#39, "flag"),
 *   Sponsorship (#41, "flag"/"badge"), fit (#34), Application limit (#42, "flag"/"badge").
 */
export const SCREEN_STEPS: ScreenStep[] = [scamStep, denyStep, ghostStep, sponsorshipStep, fitStep];

/** What `screen` holds on a Listing. */
export interface ScreenResult {
  screened_at: string;
  run_id: string | null;
  outcome: "shortlist" | "excluded";
  /** The Check that excluded the Listing, else null. */
  excluded_by: string | null;
  checks: Check[];
  flags: { check: string; label: string }[];
  badges: { check: string; label: string }[];
  /** Set by `screen rescore`; cleared when the Listing is scored again. */
  rescore_requested_at: string | null;
  fit?: { score: number; band: string };
  [stored: string]: unknown;
}

function screenOf(listing: StoredRecord): ScreenResult | undefined {
  return isObject(listing.screen) ? (listing.screen as ScreenResult) : undefined;
}

function needsScreen(listing: StoredRecord): boolean {
  if (listing.gone === true || typeof listing.application_id === "string") return false;
  const screen = screenOf(listing);
  return screen === undefined || screen.rescore_requested_at !== null;
}

export function judgmentsFile(dataDir: string): string {
  return join(dataDir, "inbox", "screen-judgments.json");
}

async function profileFor(dataDir: string): Promise<Record<string, unknown>> {
  await assertProfileComplete(dataDir);
  return (await readProfile(dataDir)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------
// screen pending

export async function screenPending(dataDir: string) {
  const profile = await profileFor(dataDir);
  const listings = (await listRecords(dataDir, "listing")).filter(needsScreen);
  return {
    listings: listings.map((l) => ({
      id: l.id,
      company: l.company,
      title: l.title,
      location: l.location ?? null,
      description: l.description ?? "",
    })),
    // Only what the skills rating needs; never identity or contact details.
    profile: { base_resume: profile.base_resume, targets: profile.targets },
    judgment_keys: SCREEN_STEPS.flatMap((s) => (s.judgment ? [s.judgment.key] : [])),
    judgments_file: judgmentsFile(dataDir),
  };
}

// ---------------------------------------------------------------------------------------
// screen record

interface Judgment {
  listing_id: string;
  [key: string]: unknown;
}

function parseJudgments(input: unknown): Judgment[] {
  const problems: Problems = [];
  const list = isObject(input) ? input.judgments : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    throw usageError('screen record: --input must be {"judgments": [{"listing_id", ...}, ...]}');
  }
  list.forEach((j, i) => {
    const at = `judgments[${i}]`;
    if (!isObject(j) || typeof j.listing_id !== "string") {
      problems.push(`${at}.listing_id must name the Listing`);
      return;
    }
    for (const step of SCREEN_STEPS) {
      if (step.judgment)
        step.judgment.check(j[step.judgment.key], `${at}.${step.judgment.key}`, problems);
    }
  });
  if (problems.length > 0) {
    throw new CoreError(
      "JUDGMENT_INVALID",
      `The screen worker's judgments aren't usable, so nothing was recorded: ${problems.join("; ")}.`,
      { problems },
    );
  }
  return list as Judgment[];
}

/** Run every step in order; an excluding failure turns the rest into "not reached". */
function runSteps(
  listing: StoredRecord,
  profile: Record<string, unknown>,
  judgment: Judgment,
  now: string,
  sponsorship?: SponsorshipContext,
): Pick<ScreenResult, "outcome" | "excluded_by" | "checks" | "flags" | "badges"> &
  Record<string, unknown> {
  const checks: Check[] = [];
  const stored: Record<string, unknown> = {};
  const afterExclusion: Check[] = [];
  let excludedBy: string | null = null;
  for (const step of SCREEN_STEPS) {
    const result = step.run({
      listing,
      profile,
      judgment: step.judgment ? judgment[step.judgment.key] : undefined,
      now,
      sponsorship,
    });
    Object.assign(stored, result.stored);
    if (excludedBy !== null) {
      // Not reached, but kept for a restore (restore.ts), which puts the Listing back at its fit.
      checks.push(...step.checks.map(notReached));
      afterExclusion.push(...result.checks);
      continue;
    }
    for (const c of result.checks) {
      checks.push(c);
      if (excludedBy === null && c.status === "fail" && c.effect === "exclude")
        excludedBy = c.check;
    }
  }
  return {
    ...stored,
    ...(excludedBy === null ? {} : { after_exclusion: afterExclusion }),
    outcome: excludedBy === null ? "shortlist" : "excluded",
    excluded_by: excludedBy,
    checks,
    flags: marksFor(checks, "flag"),
    badges: marksFor(checks, "badge"),
  };
}

export async function screenRecord(dataDir: string, input: unknown) {
  const judgments = parseJudgments(input);
  const profile = await profileFor(dataDir);
  return withWriter(dataDir, "screen record", async (w) => {
    const now = timestamp();
    const runId = (await readRunLock(dataDir))?.run_id ?? null;
    const todo: { listing: StoredRecord; judgment: Judgment }[] = [];
    for (const judgment of judgments) {
      const listing = await getRecord(dataDir, "listing", judgment.listing_id);
      if (listing === undefined) {
        throw new CoreError("NOT_FOUND", `There's no Listing "${judgment.listing_id}" to screen.`);
      }
      const screen = screenOf(listing);
      if (screen !== undefined && screen.rescore_requested_at === null) {
        throw new CoreError(
          "ALREADY_SCREENED",
          `${listing.company} · ${listing.title} already has a Fit score, so nothing was ` +
            "recorded. Scores change only when the job seeker asks for a rescore (`screen rescore`).",
          { listing_id: listing.id },
        );
      }
      if (typeof listing.application_id === "string") {
        throw new CoreError(
          "ALREADY_PICKED",
          `${listing.company} · ${listing.title} is already an Application, so Screen leaves it alone.`,
          { listing_id: listing.id },
        );
      }
      todo.push({ listing, judgment });
    }
    const recorded: string[] = [];
    const sponsorship = await loadSponsorshipContext(dataDir, profile);
    for (const { listing, judgment } of todo) {
      const screen = reapplyRestore(listing, {
        screened_at: now,
        run_id: runId,
        rescore_requested_at: null,
        ...runSteps(listing, profile, judgment, now, sponsorship),
      } as ScreenResult) as ScreenResult;
      await w.put("listing", listing.id, {
        ...listing,
        screen,
        decision_tree: treePath(listing.id),
      });
      recorded.push(listing.id);
    }
    // Regenerate every screened Listing's tree: Discover may have marked some gone.
    const apps = await listRecords(dataDir, "application");
    await writeTrees(dataDir, await listRecords(dataDir, "listing"), apps);
    return { recorded, ...(await digest(dataDir)) };
  });
}

// ---------------------------------------------------------------------------------------
// screen rescore

export async function screenRescore(dataDir: string, args: string[]) {
  if (args.length === 0) throw usageError("screen rescore: give <listing-id>... or all");
  return withWriter(dataDir, "screen rescore", async (w) => {
    const listings = await listRecords(dataDir, "listing");
    const chosen =
      args.length === 1 && args[0] === "all"
        ? listings.filter((l) => screenOf(l) && l.gone !== true && !l.application_id)
        : args.map((id) => {
            const l = listings.find((x) => x.id === id);
            if (l === undefined || screenOf(l) === undefined) {
              throw new CoreError("NOT_FOUND", `There's no screened Listing "${id}" to rescore.`);
            }
            if (typeof l.application_id === "string") {
              throw new CoreError(
                "ALREADY_PICKED",
                `${l.company} · ${l.title} is already an Application, so its score stays.`,
              );
            }
            return l;
          });
    const now = timestamp();
    for (const l of chosen) {
      await w.put("listing", l.id, {
        ...l,
        screen: { ...(l.screen as ScreenResult), rescore_requested_at: now },
      });
    }
    return { rescore: chosen.map((l) => l.id) };
  });
}

// ---------------------------------------------------------------------------------------
// The Shortlist, the digest and why

export interface ShortlistItem {
  letter: string;
  id: string;
  company: string;
  title: string;
  location: string | null;
  fit: number;
  band: string;
  flags: string[];
  badges: string[];
}

function letter(i: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  return i < 26 ? (a[i] as string) : `${a[Math.floor(i / 26) - 1]}${a[i % 26]}`;
}

/**
 * The Shortlist in rank order: fit order first, then flagged Listings below it (each group
 * by Fit score, highest first). Gone, excluded and already-picked Listings are off it.
 */
export async function rankShortlist(dataDir: string): Promise<ShortlistItem[]> {
  const listings = await listRecords(dataDir, "listing");
  const picked = await applicationsByListing(dataDir);
  const on = listings.filter((l) => {
    const s = screenOf(l);
    return s?.outcome === "shortlist" && l.gone !== true && !picked.has(l.id) && !l.application_id;
  });
  const key = (l: StoredRecord) => screenOf(l) as ScreenResult;
  on.sort((x, y) => {
    const fx = key(x).flags.length > 0 ? 1 : 0;
    const fy = key(y).flags.length > 0 ? 1 : 0;
    if (fx !== fy) return fx - fy;
    const d = (key(y).fit?.score ?? 0) - (key(x).fit?.score ?? 0);
    if (d !== 0) return d;
    return `${x.company} ${x.title} ${x.id}` < `${y.company} ${y.title} ${y.id}` ? -1 : 1;
  });
  return on.map((l, i) => ({
    letter: letter(i),
    id: l.id,
    company: String(l.company),
    title: String(l.title),
    location: (l.location as string | null) ?? null,
    fit: key(l).fit?.score ?? 0,
    band: key(l).fit?.band ?? "weak",
    flags: key(l).flags.map((f) => f.label),
    badges: key(l).badges.map((b) => b.label),
  }));
}

/** The replies the digest takes in #34; later tickets add theirs (approve, show excluded, restore). */
export const REPLIES = [
  { reply: "why <letter>", does: "show every check on that Listing, with its evidence" },
  { reply: "pick a, b", does: "pick Listings from the Shortlist (asks for your Approval)" },
  { reply: "show excluded", does: "list the excluded Listings with the reasons" },
  { reply: "restore <name>", does: "put an excluded Listing back at its fit position, flagged" },
  { reply: "help", does: "list these replies" },
];

export async function digest(dataDir: string) {
  const shortlist = await rankShortlist(dataDir);
  const listings = await listRecords(dataDir, "listing");
  const excluded = listings.filter((l) => screenOf(l)?.outcome === "excluded").length;
  const pending = listings.filter(needsScreen).length;
  const lines: string[] = [];
  lines.push(
    shortlist.length > 0
      ? `SHORTLIST (${shortlist.length})  ranked by Fit score`
      : "SHORTLIST (0)  nothing to pick right now",
  );
  for (const s of shortlist) {
    const marks = [...s.flags, ...s.badges].map((m) => `[${m}]`).join(" ");
    lines.push(
      `  ${s.letter}) ${String(s.fit).padStart(2)} ${s.band.padEnd(8)} ${s.company.padEnd(18)} ` +
        `${s.title.padEnd(34)} ${s.location ?? ""}${marks ? `  ${marks}` : ""}`.trimEnd(),
    );
  }
  lines.push(`EXCLUDED (${excluded})${excluded > 0 ? "  collapsed · reply: show excluded" : ""}`);
  if (pending > 0) lines.push(`${pending} Listing${pending === 1 ? "" : "s"} waiting for Screen`);
  lines.push(`Reply: ${REPLIES.map((r) => r.reply).join(" · ")}`);
  return { shortlist, excluded, pending, text: lines.join("\n"), replies: REPLIES };
}

const MARK = { pass: "✓", warn: "!", fail: "✗", not_reached: "·" } as const;

/** One Listing's Checks with evidence, by Shortlist letter, Listing ID or Application ID. */
export async function why(dataDir: string, target: string | undefined) {
  if (target === undefined) throw usageError("screen why: give a Shortlist letter or Listing ID");
  let listing: StoredRecord | undefined;
  if (/^[a-z]{1,2}$/.test(target)) {
    const item = (await rankShortlist(dataDir)).find((s) => s.letter === target);
    if (item) listing = await getRecord(dataDir, "listing", item.id);
  } else {
    listing = await getRecord(dataDir, "listing", target);
    if (listing === undefined) {
      const app = await getRecord(dataDir, "application", target);
      if (typeof app?.listing === "string") {
        listing = await getRecord(dataDir, "listing", app.listing);
      }
    }
  }
  if (listing === undefined) {
    throw new CoreError(
      "NOT_FOUND",
      `Nothing on the Shortlist or in the pipeline matches "${target}".`,
    );
  }
  const screen = screenOf(listing);
  if (screen === undefined) {
    throw new CoreError(
      "NOT_SCREENED",
      `${listing.company} · ${listing.title} hasn't been screened yet.`,
    );
  }
  const tree = join(dataDir, treePath(listing.id));
  const head = [listing.company, listing.title, listing.location].filter(Boolean).join(" · ");
  const fit = screen.fit ? ` · Fit ${screen.fit.score} ${screen.fit.band}` : "";
  const lines = [`${head}${fit}`];
  for (const c of screen.checks) {
    lines.push(`${MARK[c.status]} ${c.name.padEnd(22)} ${c.result}`);
    if (c.status === "not_reached") continue;
    lines.push(`    rule: ${c.rule}`);
    for (const e of c.evidence) lines.push(`    ${e}`);
  }
  lines.push(`Full diagram: ${tree}`);
  return {
    listing_id: listing.id,
    outcome: screen.outcome,
    checks: screen.checks,
    decision_tree: tree,
    text: lines.join("\n"),
  };
}
