// The Screen check pipeline's seam. Screen runs SCREEN_STEPS (screen.ts) in order on each
// Listing; each step records one or more Checks. A failed Check whose effect is "exclude"
// stops the pipeline: every later Check is recorded as "not reached". See
// docs/agents/core-conventions.md, "Screen check pipeline".
import type { StoredRecord } from "./store.ts";
import type { Problems } from "./validate.ts";

/** How a Check came out. "warn" is amber: it down-ranks or adds a badge. */
export type CheckStatus = "pass" | "warn" | "fail" | "not_reached";

/**
 * What a non-passing Check does to the Listing:
 *  - "exclude": off the Shortlist (scam gate, deny list); stops the pipeline.
 *  - "flag": sorts below the fit order, Fit score unchanged (ghost High, failed required
 *    Sponsorship, over an Application limit).
 *  - "badge": shown next to the Listing only (unknown Sponsorship, last slot).
 *  - null: recorded only (e.g. a failed Fit rule, which already caps the score).
 */
export type CheckEffect = "exclude" | "flag" | "badge" | null;

/** One node of the Decision tree and one line of `why`, stored on the Listing. */
export interface Check {
  /** Stable ID, "<step>.<check>", e.g. "fit.location". */
  check: string;
  /** Shown to the job seeker, e.g. "Location". */
  name: string;
  /** The threshold or rule, one line. */
  rule: string;
  /** Short result, e.g. "pass", "83/100", "High", "not reached". */
  result: string;
  status: CheckStatus;
  effect: CheckEffect;
  /** One-line citation for the Decision tree node. */
  citation: string;
  /** Every evidence line for `why` and the page's node panel. */
  evidence: string[];
  /** What the job seeker sees in the Shortlist for a flag or badge, else null. */
  label: string | null;
}

/** What a step declares for each Check it records, shown when it is not reached. */
export interface CheckSpec {
  check: string;
  name: string;
  rule: string;
}

export interface StepContext {
  /** The Listing as stored (Discover's fields plus anything later Stages added). */
  listing: StoredRecord;
  /** The Profile, validated complete. */
  profile: Record<string, unknown>;
  /** This step's section of the screen worker's judgment for this Listing, if it has one. */
  judgment: unknown;
  /** Screen's clock (ISO 8601 UTC). */
  now: string;
}

export interface StepResult {
  /** One Check per entry of the step's `checks`, in the same order. */
  checks: Check[];
  /** Fields merged into `screen` on the Listing, e.g. {fit: {...}}. */
  stored?: Record<string, unknown>;
}

export interface ScreenStep {
  /** Step ID; its Checks are "<id>.<check>". */
  id: string;
  /** Every Check this step records, in order. */
  checks: CheckSpec[];
  /**
   * The key of this step's section in each Listing's worker judgment
   * (e.g. "skills_rating"), with its validator. Omit for a step that needs no LLM judgment.
   */
  judgment?: { key: string; check(v: unknown, path: string, problems: Problems): void };
  run(ctx: StepContext): StepResult;
}

export function notReached(spec: CheckSpec): Check {
  return {
    ...spec,
    result: "not reached",
    status: "not_reached",
    effect: null,
    citation: "cut off by an earlier check",
    evidence: [],
    label: null,
  };
}

/** The flags or badges a set of Checks shows: failed or amber Checks with that effect. */
export function marksFor(
  checks: Check[],
  effect: "flag" | "badge",
): { check: string; label: string }[] {
  return checks
    .filter((c) => c.effect === effect && (c.status === "fail" || c.status === "warn"))
    .map((c) => ({ check: c.check, label: c.label ?? `${c.name}: ${c.result}` }));
}
