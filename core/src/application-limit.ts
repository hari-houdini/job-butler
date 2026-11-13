// Application limits (Screen step 6, ticket #42): a company's cap, or reapply cooldown, on how
// many Applications one person may make in a rolling window. The limit comes from the first
// source present (the job seeker's note on the company, then the advert's text with a quote,
// then the default cooldown in Preferences). Over a limit a Listing is flagged and sorts below
// the fit order; the last slot is a badge; more Shortlisted Listings than slots get suggestions.
// It warns and reorders; it never blocks a pick (an override is needed, and recorded).
// See docs/agents/core-conventions.md, "Application limits".

import { loadPreferences } from "./preferences.ts";
import { normaliseCompanyName, normaliseTitle, sameRole } from "./same-role.ts";
import type { Check, CheckSpec, ScreenStep, ScreenWorld } from "./screen-check.ts";
import { listRecords, type StoredRecord } from "./store.ts";
import { integer, isObject, oneOf, type Problems, string } from "./validate.ts";

export const LIMIT_CHECK = "application_limit.limit";
const DAY_MS = 86_400_000;

export type LimitScope = "same_role" | "company";
export type LimitSource = "note" | "advert" | "default";

export interface Limit {
  count: number;
  window_days?: number;
  window_months?: number;
  scope: LimitScope;
  source: LimitSource;
  /** The advert's words, for an advert limit. */
  quote?: string;
}

/** One Listing's standing against its limit, right now. */
export interface LimitEvaluation {
  limit: Limit;
  /** Applications already counted in the window. */
  existing: number;
  status: "pass" | "last_slot" | "over";
  /** Slots left before this Listing (limit.count - existing, at least 0). */
  slots_left: number;
  /** "would be your 2nd of 1 at Acme in 30 days for the same role (default cooldown)". */
  label: string;
  /** The counted Applications, newest first, for the evidence lines. */
  counted: { id: string; company: string; title: string; at: string; origin: string }[];
  /** Who the count is against: the Employer ID or the normalised company name (+ title). */
  group_key: string;
}

// ---------------------------------------------------------------------------------------
// Limits and where they come from

/** Validate the advert-limit judgment ({count, window_days|window_months, scope, quote}). */
export function checkAdvertLimit(v: unknown, path: string, problems: Problems): void {
  if (v === undefined || v === null) return; // the advert states no limit
  if (!isObject(v)) {
    problems.push(`${path} must be null or {count, window_days|window_months, scope, quote}`);
    return;
  }
  checkLimitShape(v, path, problems);
  string(v.quote, `${path}.quote`, problems);
}

function checkLimitShape(v: Record<string, unknown>, path: string, problems: Problems): void {
  integer(v.count, `${path}.count`, problems, 1, 100);
  oneOf(v.scope, `${path}.scope`, ["same_role", "company"], problems);
  const days = v.window_days !== undefined;
  const months = v.window_months !== undefined;
  if (days === months) problems.push(`${path} needs exactly one of window_days or window_months`);
  else if (days) integer(v.window_days, `${path}.window_days`, problems, 1, 3650);
  else integer(v.window_months, `${path}.window_months`, problems, 1, 120);
}

function limitFrom(v: unknown, source: LimitSource): Limit | undefined {
  if (!isObject(v)) return undefined;
  const problems: Problems = [];
  checkLimitShape(v, "limit", problems);
  if (problems.length > 0) return undefined;
  return {
    count: v.count as number,
    ...(v.window_days !== undefined ? { window_days: v.window_days as number } : {}),
    ...(v.window_months !== undefined ? { window_months: v.window_months as number } : {}),
    scope: v.scope as LimitScope,
    source,
    ...(source === "advert" && typeof v.quote === "string" ? { quote: v.quote } : {}),
  };
}

/** The job seeker's note on the Employer: by the Listing's Employer ID, else the company name. */
function noteFor(listing: StoredRecord, employers: StoredRecord[]): Limit | undefined {
  const byId =
    typeof listing.employer === "string"
      ? employers.find((e) => e.id === listing.employer)
      : undefined;
  const name = normaliseCompanyName(String(listing.company));
  const employer =
    byId ??
    employers.find((e) => typeof e.name === "string" && normaliseCompanyName(e.name) === name);
  return limitFrom(employer?.application_limit_note, "note");
}

function defaultLimit(prefs: ScreenWorld["preferences"]): Limit {
  const d = prefs.application_limits.default_reapply_cooldown;
  return {
    count: d.count,
    window_months: d.window_months,
    scope: d.scope as LimitScope,
    source: "default",
  };
}

/** Note, then the advert's limit (stored with the Listing's screen), then the default. */
export function resolveLimit(listing: StoredRecord, advert: unknown, world: ScreenWorld): Limit {
  return (
    noteFor(listing, world.employers) ??
    limitFrom(advert, "advert") ??
    defaultLimit(world.preferences)
  );
}

// ---------------------------------------------------------------------------------------
// Counting

const SUBMITTED_OR_LATER = new Set(["submitted", "interview", "rejected", "offer", "no_response"]);

interface Dated {
  app: StoredRecord;
  at: string;
}

function events(app: StoredRecord): { at: string; to: string }[] {
  return Array.isArray(app.event_log) ? (app.event_log as { at: string; to: string }[]) : [];
}

/**
 * The date an Application counts at, or null when it doesn't count. Counted: Submitted (and
 * anything after), Picked-but-not-submitted, External. Not counted: a pick withdrawn before
 * Submit (which is how an Application abandoned before Submit ends). Dated by submit date,
 * else pick date; External applications by `applied_at` (their earliest confirmation mail,
 * set by #50), else their first event.
 */
export function countedAt(app: StoredRecord): string | null {
  const log = events(app);
  const submit = log.find((e) => e.to === "submitted")?.at;
  const wasSubmitted =
    submit !== undefined ||
    log.some((e) => SUBMITTED_OR_LATER.has(e.to)) ||
    (typeof app.status === "string" && SUBMITTED_OR_LATER.has(app.status));
  if (app.origin !== "external" && app.status === "withdrawn" && !wasSubmitted) return null;
  if (submit !== undefined) return submit;
  if (app.origin === "external" && typeof app.applied_at === "string") return app.applied_at;
  const pick = log.find((e) => e.to === "picked")?.at ?? log[0]?.at;
  return pick ?? (typeof app.created_at === "string" ? app.created_at : null);
}

/** The start of the rolling window: today minus the window. */
export function windowStart(limit: Limit, now: string): Date {
  const d = new Date(now);
  if (limit.window_days !== undefined) return new Date(d.getTime() - limit.window_days * DAY_MS);
  d.setUTCMonth(d.getUTCMonth() - (limit.window_months ?? 0));
  return d;
}

function appEmployer(app: StoredRecord, listings: Map<string, StoredRecord>): string | null {
  if (typeof app.employer === "string") return app.employer;
  const l = typeof app.listing === "string" ? listings.get(app.listing) : undefined;
  return typeof l?.employer === "string" ? l.employer : null;
}

/** Applications that count against this Listing under the limit, newest first. */
export function countApplications(
  listing: StoredRecord,
  limit: Limit,
  applications: StoredRecord[],
  listings: Map<string, StoredRecord>,
  now: string,
): LimitEvaluation["counted"] {
  const start = windowStart(limit, now).getTime();
  const target = {
    company: String(listing.company),
    employer: typeof listing.employer === "string" ? listing.employer : null,
    title: String(listing.title),
  };
  const counted: Dated[] = [];
  for (const app of applications) {
    if (app.listing === listing.id) continue; // the Listing itself is the one being weighed
    const at = countedAt(app);
    if (at === null || new Date(at).getTime() < start || new Date(at).getTime() > Date.parse(now))
      continue;
    const ref = {
      company: String(app.company ?? ""),
      employer: appEmployer(app, listings),
      title: String(app.title ?? ""),
    };
    if (!sameRole(ref, target, { location: false }) && limit.scope === "same_role") continue;
    if (limit.scope === "company" && !companyMatch(ref, target)) continue;
    counted.push({ app, at });
  }
  return counted
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map(({ app, at }) => ({
      id: app.id,
      company: String(app.company ?? ""),
      title: String(app.title ?? ""),
      at,
      origin: String(app.origin ?? "picked"),
    }));
}

function companyMatch(
  a: { company: string; employer: string | null },
  b: { company: string; employer: string | null },
): boolean {
  if (a.employer !== null && b.employer !== null) return a.employer === b.employer;
  return normaliseCompanyName(a.company) === normaliseCompanyName(b.company);
}

// ---------------------------------------------------------------------------------------
// Evaluating a Listing

function ordinal(n: number): string {
  const v = n % 100;
  const suffix =
    v >= 11 && v <= 13
      ? "th"
      : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th");
  return `${n}${suffix}`;
}

export function windowText(limit: Limit): string {
  return limit.window_days !== undefined
    ? `${limit.window_days} day${limit.window_days === 1 ? "" : "s"}`
    : `${limit.window_months} month${limit.window_months === 1 ? "" : "s"}`;
}

export function sourceText(limit: Limit): string {
  if (limit.source === "note") return "your note";
  if (limit.source === "advert") return `the advert: "${limit.quote ?? ""}"`;
  return "default cooldown";
}

export function evaluateLimit(
  listing: StoredRecord,
  advert: unknown,
  world: ScreenWorld,
  now: string,
): LimitEvaluation {
  const limit = resolveLimit(listing, advert, world);
  const byId = new Map(world.listings.map((l) => [l.id, l]));
  const counted = countApplications(listing, limit, world.applications, byId, now);
  const existing = counted.length;
  const status: LimitEvaluation["status"] =
    existing + 1 > limit.count
      ? "over"
      : existing + 1 === limit.count && limit.count > 1
        ? "last_slot" // a one-application limit would badge every Listing, so it stays quiet
        : "pass";
  const where = `at ${listing.company} in ${windowText(limit)}${limit.scope === "same_role" ? " for the same role" : ""}`;
  const label =
    status === "over"
      ? `would be your ${ordinal(existing + 1)} of ${limit.count} ${where} (${sourceText(limit)})`
      : status === "last_slot"
        ? `uses your last slot ${where} (${sourceText(limit)})`
        : `${existing} of ${limit.count} used ${where} (${sourceText(limit)})`;
  const employer =
    typeof listing.employer === "string"
      ? `employer:${listing.employer}`
      : `company:${normaliseCompanyName(String(listing.company))}`;
  return {
    limit,
    existing,
    status,
    slots_left: Math.max(0, limit.count - existing),
    label,
    counted,
    group_key:
      limit.scope === "same_role"
        ? `${employer}|${normaliseTitle(String(listing.title))}`
        : employer,
  };
}

// ---------------------------------------------------------------------------------------
// The Screen step

const SPEC: CheckSpec = {
  check: LIMIT_CHECK,
  name: "Application limit",
  rule: "Applications at this company in the window stay within its limit (your note, else the advert, else the default cooldown)",
};

export const limitStep: ScreenStep = {
  id: "application_limit",
  checks: [SPEC],
  judgment: { key: "application_limit", check: checkAdvertLimit },
  run({ listing, judgment, world, now }) {
    const advert = judgment ?? null;
    const ev = evaluateLimit(listing, advert, world, now);
    const l = ev.limit;
    const evidence = [
      `Limit: ${l.count} per ${windowText(l)}, ${l.scope === "same_role" ? "same role" : "whole company"}, from ${sourceText(l)}.`,
      ...(l.quote ? [`Advert quote: "${l.quote}"`] : []),
      `Counted in the window: ${ev.existing}.`,
      ...ev.counted.map(
        (c) =>
          `${c.origin === "external" ? "External" : "Application"}: ${c.company} · ${c.title} (${c.at.slice(0, 10)})`,
      ),
    ];
    const check: Check = {
      ...SPEC,
      rule: `${l.count} per ${windowText(l)} (${l.scope === "same_role" ? "same role" : "whole company"}), from ${sourceText(l)}`,
      result: ev.status === "over" ? `over: ${ev.label}` : `${ev.existing} of ${l.count} used`,
      status: ev.status === "pass" ? "pass" : "warn",
      effect: ev.status === "over" ? "flag" : ev.status === "last_slot" ? "badge" : null,
      citation: `${sourceText(l)}; ${ev.existing} counted in ${windowText(l)}`,
      evidence,
      label: ev.status === "pass" ? null : ev.label,
    };
    return { checks: [check], stored: { advert_limit: advert } };
  },
};

// ---------------------------------------------------------------------------------------
// The world a limit is judged against

export async function loadLimitWorld(dataDir: string): Promise<ScreenWorld> {
  return {
    applications: await listRecords(dataDir, "application"),
    listings: await listRecords(dataDir, "listing"),
    employers: await listRecords(dataDir, "employer"),
    preferences: await loadPreferences(dataDir),
  };
}

/** A Listing's live standing, using the advert limit Screen stored on it. */
export function liveEvaluation(
  listing: StoredRecord,
  world: ScreenWorld,
  now: string,
): LimitEvaluation {
  const advert = isObject(listing.screen)
    ? (listing.screen as Record<string, unknown>).advert_limit
    : null;
  return evaluateLimit(listing, advert, world, now);
}

// ---------------------------------------------------------------------------------------
// Suggestions

export interface LimitGroup {
  company: string;
  slots: number;
  members: number;
}

/**
 * For Listings on the Shortlist (already in rank order): a company with more Listings than
 * slots left gets them grouped, and the top-fit `slots` (by rank order) marked suggested.
 */
export function suggestSlots(
  ranked: { id: string; company: string }[],
  evals: Map<string, LimitEvaluation>,
): Map<string, { suggested: boolean; group: LimitGroup }> {
  const groups = new Map<string, string[]>();
  for (const item of ranked) {
    const ev = evals.get(item.id);
    if (ev === undefined || ev.status === "over") continue;
    groups.set(ev.group_key, [...(groups.get(ev.group_key) ?? []), item.id]);
  }
  const out = new Map<string, { suggested: boolean; group: LimitGroup }>();
  for (const ids of groups.values()) {
    const slots = Math.min(...ids.map((id) => (evals.get(id) as LimitEvaluation).slots_left));
    if (ids.length <= slots) continue;
    const company = ranked.find((r) => r.id === ids[0])?.company ?? "";
    ids.forEach((id, i) => {
      out.set(id, { suggested: i < slots, group: { company, slots, members: ids.length } });
    });
  }
  return out;
}
