// Calibrating the register's fuzzy threshold (#40, the open calibration item in employer.ts).
//
// The matcher accepts a register name when its trigram similarity to the Listing's company
// reaches FUZZY_THRESHOLD. This module scores a hand-labelled sample of name pairs with that same
// similarity and reports precision, recall and F1 at each threshold. It is pure: it changes no
// state, and the threshold is still set by hand in employer.ts from what it reports.
import { FUZZY_THRESHOLD, similarity } from "./employer.ts";
import { CoreError } from "./errors.ts";
import { normaliseName } from "./sponsor.ts";

export interface LabelledPair {
  a: string;
  b: string;
  /** True when a and b name the same employer. */
  same: boolean;
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
  /** The swept threshold with the best F1; the higher one when several tie. */
  suggested_threshold: number;
  rows: ThresholdRow[];
  /** Set when the sample is too small to trust. */
  warning: string | null;
  note: string;
}

/** Below this many pairs the figures say little about the matcher. */
export const MIN_PAIRS = 30;

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
      typeof p.same !== "boolean"
    ) {
      throw new CoreError(
        "INVALID_PAIRS",
        `pairs[${i}] needs two non-empty names "a" and "b" and a boolean "same".`,
      );
    }
    return { a: p.a, b: p.b, same: p.same };
  });
}

/** Each swept threshold with the confusion counts and scores it gives on the sample. */
function sweep(scores: { score: number; same: boolean }[]): ThresholdRow[] {
  const positives = scores.filter((s) => s.same).length;
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
    const fn = positives - tp;
    const tn = negatives - fp;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = positives === 0 ? 0 : tp / positives;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    rows.push({
      threshold,
      true_positive: tp,
      false_positive: fp,
      false_negative: fn,
      true_negative: tn,
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
  const scores = pairs.map((p) => ({
    score: similarity(normaliseName(p.a), normaliseName(p.b)),
    same: p.same,
  }));
  const rows = sweep(scores);
  const best = Math.max(...rows.map((r) => r.f1));
  // Rows ascend, so the last one with the best F1 is the highest threshold among any ties.
  const suggested = rows.filter((r) => r.f1 === best).at(-1) as ThresholdRow;
  return {
    pairs: pairs.length,
    positives,
    negatives,
    current_threshold: FUZZY_THRESHOLD,
    suggested_threshold: suggested.threshold,
    rows,
    warning:
      pairs.length < MIN_PAIRS
        ? `fewer than ${MIN_PAIRS} pairs: the figures are indicative only`
        : null,
    note: "Nothing changes here. Set FUZZY_THRESHOLD in core/src/employer.ts by hand from these figures.",
  };
}
