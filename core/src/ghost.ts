// Screen step 3 (#39): the ghost score. Additive: each signal adds its points, the sum is
// banded Low, Medium or High, and every reason is kept. Only High flags the Listing (it sorts
// below the fit order; the Fit score never changes); Medium is a badge. No extra fetch:
// existence comes from the latest Discover run (a Listing missing from it is marked gone).
//
// The weights and band cut-offs below are the one place to tune. They follow the ranking in
// docs/research/ghost-job-signals.md (structural signals strongest, missing salary weakest)
// and are calibrated in a later pass; see core-conventions.md, "Screen exclusions and ghost score".
import { now as clock } from "./env.ts";
import type { Check, CheckSpec, ScreenStep } from "./screen-check.ts";
import { isObject } from "./validate.ts";

export const GHOST_WEIGHTS = {
  /** Points by age from first seen (or posted, if earlier): the highest tier reached counts. */
  age: [
    { days: 90, points: 4 },
    { days: 60, points: 3 },
    { days: 30, points: 2 },
  ],
  /** Per repost Discover recorded, up to the cap. */
  repostEach: 1,
  repostCap: 3,
  /** Greenhouse prospect post: `internal_job_id` is null, so no job backs it. */
  prospectPost: 4,
  /** `validThrough` or the application deadline is in the past. */
  expired: 4,
  /** Every copy is on LinkedIn, which Job Butler never fetches. */
  existenceUnverified: 2,
  /** Weak: no study ties it to ghost jobs. */
  missingSalary: 1,
};

/** Band cut-offs: score >= medium is Medium, >= high is High. */
export const GHOST_BANDS = { medium: 3, high: 6 };

export type GhostBand = "low" | "medium" | "high";

export interface GhostReason {
  signal: string;
  points: number;
  detail: string;
}

export function ghostBand(score: number): GhostBand {
  if (score >= GHOST_BANDS.high) return "high";
  if (score >= GHOST_BANDS.medium) return "medium";
  return "low";
}

const DAY = 86_400_000;

function earliest(...dates: unknown[]): number | null {
  const ms = dates
    .filter((d): d is string => typeof d === "string")
    .map((d) => Date.parse(d))
    .filter((n) => !Number.isNaN(n));
  return ms.length > 0 ? Math.min(...ms) : null;
}

export const GHOST_SPEC: CheckSpec = {
  check: "ghost.score",
  name: "Ghost score",
  rule:
    `Sum of signal points: Low under ${GHOST_BANDS.medium}, Medium ${GHOST_BANDS.medium}-` +
    `${GHOST_BANDS.high - 1}, High ${GHOST_BANDS.high}+; High sorts below the fit order`,
};

export const ghostStep: ScreenStep = {
  id: "ghost",
  checks: [GHOST_SPEC],
  run({ listing, now }) {
    const w = GHOST_WEIGHTS;
    const reasons: GhostReason[] = [];
    const add = (signal: string, points: number, detail: string) =>
      reasons.push({ signal, points, detail });

    const first = earliest(listing.first_seen_at, listing.posted_at);
    const asOf = Date.parse(now) || clock().getTime();
    if (first !== null) {
      const days = Math.floor((asOf - first) / DAY);
      const tier = w.age.find((a) => days >= a.days);
      if (tier) add("age", tier.points, `age: ${days} days since first seen or posted`);
    }
    const reposts = Number(listing.repost_count ?? 0);
    if (reposts > 0) {
      add(
        "repost",
        Math.min(reposts * w.repostEach, w.repostCap),
        `repost: reposted ${reposts} time${reposts === 1 ? "" : "s"}`,
      );
    }
    const fields = isObject(listing.source_fields) ? listing.source_fields : {};
    if (
      listing.source === "greenhouse" &&
      "internal_job_id" in fields &&
      fields.internal_job_id === null
    ) {
      add(
        "prospect_post",
        w.prospectPost,
        "prospect post: Greenhouse has no job behind this posting",
      );
    }
    const deadline =
      typeof listing.deadline === "string" ? Date.parse(listing.deadline) : Number.NaN;
    if (!Number.isNaN(deadline) && deadline < asOf) {
      add("expired", w.expired, `expired: validThrough or deadline ${listing.deadline} has passed`);
    }
    if (listing.existence_unverified === true) {
      add(
        "existence_unverified",
        w.existenceUnverified,
        "existence unverified: LinkedIn only, never fetched",
      );
    }
    if (listing.salary === null || listing.salary === undefined || listing.salary === "") {
      add("missing_salary", w.missingSalary, "missing salary (weak signal)");
    }

    const score = reasons.reduce((sum, r) => sum + r.points, 0);
    const band = ghostBand(score);
    const check: Check = {
      ...GHOST_SPEC,
      result: `${band} (${score})`,
      status: band === "low" ? "pass" : "warn",
      effect: band === "high" ? "flag" : band === "medium" ? "badge" : null,
      citation: reasons.length > 0 ? reasons.map((r) => r.signal).join(", ") : "no ghost signals",
      evidence: reasons.map((r) => `${r.detail} (+${r.points})`),
      label: band === "low" ? null : `Ghost risk: ${band}`,
    };
    return { checks: [check], stored: { ghost: { score, band, reasons } } };
  },
};
