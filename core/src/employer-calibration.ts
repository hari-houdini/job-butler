// Calibrating the register's fuzzy threshold (#40, the open calibration item in employer.ts).
//
// The matcher accepts a register name when its name score reaches FUZZY_THRESHOLD and the towns
// agree. This module scores a hand-labelled sample of pairs the same way and reports precision,
// recall and F1 at each threshold. It is pure: it changes no state, and the threshold is still set
// by hand in employer.ts from what it reports.
import { FUZZY_THRESHOLD, nameScore } from "./employer.ts";
import { CoreError } from "./errors.ts";
import { townsAgree } from "./sponsor.ts";

export interface LabelledPair {
  a: string;
  b: string;
  /** True when a and b name the same employer. */
  same: boolean;
  /** Both towns, when the pair should be judged with the matcher's town rule too. */
  town_a?: string;
  town_b?: string;
}

export interface ThresholdRow {
  threshold: number;
  true_positive: number;
  false_positive: number;
  false_negative: number;
  true_negative: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CalibrationReport {
  pairs: number;
  positives: number;
  negatives: number;
  current_threshold: number;
  /** The swept threshold with the best F1 (the higher one on a tie), or null when none finds a true match. */
  suggested_threshold: number | null;
  rows: ThresholdRow[];
  /** Set when the sample is too small to trust, or no threshold finds a true match. */
  warning: string | null;
  note: string;
}

/** Below this many pairs the figures say little about the matcher. */
const MIN_PAIRS = 30;

const SWEEP_FROM = 0.5;
const SWEEP_TO = 0.99;
const SWEEP_STEP = 0.01;

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function parsePairs(input: unknown): LabelledPair[] {
  const list =
    input !== null &&
    typeof input === "object" &&
    Array.isArray((input as { pairs?: unknown }).pairs)
      ? (input as { pairs: unknown[] }).pairs
      : undefined;
  if (list === undefined) {
    throw new CoreError(
      "INVALID_PAIRS",
      'The sample is a JSON object with a "pairs" list of {"a", "b", "same"} objects.',
    );
  }
  return list.map((item, i) => {
    const p = item as Partial<LabelledPair> | null;
    if (
      p === null ||
      typeof p !== "object" ||
      typeof p.a !== "string" ||
      p.a.trim() === "" ||
      typeof p.b !== "string" ||
      p.b.trim() === "" ||
      typeof p.same !== "boolean" ||
      (p.town_a !== undefined && typeof p.town_a !== "string") ||
      (p.town_b !== undefined && typeof p.town_b !== "string")
    ) {
      throw new CoreError(
        "INVALID_PAIRS",
        `pairs[${i}] needs two non-empty names "a" and "b", a boolean "same", and optional string towns.`,
      );
    }
    return { a: p.a, b: p.b, same: p.same, town_a: p.town_a, town_b: p.town_b };
  });
}

/** The matcher's score for a pair: the name score, or -1 (never a match) when both towns are given and disagree. */
function pairScore(p: LabelledPair): number {
  if (p.town_a !== undefined && p.town_b !== undefined && !townsAgree(p.town_a, p.town_b)) {
    return -1;
  }
  return nameScore(p.a, p.b);
}

/** Each swept threshold with the confusion counts and scores it gives on the sample. */
function sweep(scores: { score: number; same: boolean }[], positives: number): ThresholdRow[] {
  const negatives = scores.length - positives;
  const rows: ThresholdRow[] = [];
  for (let t = SWEEP_FROM; t <= SWEEP_TO + 1e-9; t += SWEEP_STEP) {
    const threshold = round(t, 2);
    let tp = 0;
    let fp = 0;
    for (const s of scores) {
      if (s.score < threshold) continue;
      if (s.same) tp++;
      else fp++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = positives === 0 ? 0 : tp / positives;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    rows.push({
      threshold,
      true_positive: tp,
      false_positive: fp,
      false_negative: positives - tp,
      true_negative: negatives - fp,
      precision: round(precision, 3),
      recall: round(recall, 3),
      f1: round(f1, 3),
    });
  }
  return rows;
}

/** Score a labelled sample the way the matcher scores names, and report every threshold. */
export function calibrateFuzzy(input: unknown): CalibrationReport {
  const pairs = parsePairs(input);
  const positives = pairs.filter((p) => p.same).length;
  const negatives = pairs.length - positives;
  if (positives === 0 || negatives === 0) {
    throw new CoreError(
      "NEEDS_BOTH_LABELS",
      "The sample needs pairs with same: true and same: false, or there is nothing to tell apart.",
    );
  }
  const rows = sweep(
    pairs.map((p) => ({ score: pairScore(p), same: p.same })),
    positives,
  );
  const best = Math.max(...rows.map((r) => r.f1));
  // Rows ascend, so the last row with the best F1 is the highest threshold among any ties.
  const suggested =
    best === 0 ? null : (rows.filter((r) => r.f1 === best).at(-1)?.threshold ?? null);

  const warnings: string[] = [];
  if (best === 0) {
    warnings.push(
      `no threshold finds a true match: no same pair scores at or above ${SWEEP_FROM}, so none is suggested`,
    );
  }
  if (pairs.length < MIN_PAIRS) {
    warnings.push(`fewer than ${MIN_PAIRS} pairs: the figures are indicative only`);
  }
  return {
    pairs: pairs.length,
    positives,
    negatives,
    current_threshold: FUZZY_THRESHOLD,
    suggested_threshold: suggested,
    rows,
    warning: warnings.length === 0 ? null : warnings.join("; "),
    note: "Nothing changes here. Set FUZZY_THRESHOLD in core/src/employer.ts by hand from these figures.",
  };
}
