import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES, runCli, tempDir } from "./harness.ts";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI JSON
type Any = any;

const SAMPLE = join(FIXTURES, "calibration", "synthetic-pairs.json");
const samplePairs = (): Any[] => JSON.parse(readFileSync(SAMPLE, "utf8")).pairs;

const calibrate = (dataDir: string, input: unknown) =>
  runCli(["employer", "calibrate", "--input", "-"], { dataDir, input });

test("calibration reports precision, recall and F1 at each threshold, and the current one", async (t) => {
  const dataDir = tempDir(t);
  const r = await calibrate(dataDir, { pairs: samplePairs() });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.pairs, 16);
  assert.equal(r.json.positives, 8);
  assert.equal(r.json.negatives, 8);
  assert.equal(typeof r.json.current_threshold, "number");
  const rows = r.json.rows as Any[];
  assert.ok(rows.length >= 20, "a sweep over the range, not one or two points");
  for (const row of rows) {
    for (const k of [
      "threshold",
      "true_positive",
      "false_positive",
      "false_negative",
      "true_negative",
      "precision",
      "recall",
      "f1",
    ]) {
      assert.ok(k in row, `row has ${k}`);
    }
    assert.equal(
      row.true_positive + row.false_positive + row.false_negative + row.true_negative,
      16,
      `counts add up at threshold ${row.threshold}`,
    );
    assert.equal(row.true_positive + row.false_negative, 8, "every positive is counted once");
    assert.equal(row.false_positive + row.true_negative, 8, "every negative is counted once");
  }
});

test("a higher threshold never predicts more matches than a lower one", async (t) => {
  const dataDir = tempDir(t);
  const rows = (await calibrate(dataDir, { pairs: samplePairs() })).json.rows as Any[];
  const predicted = rows.map((row) => row.true_positive + row.false_positive);
  for (let i = 1; i < predicted.length; i++) {
    assert.ok(predicted[i] <= predicted[i - 1], `threshold ${rows[i].threshold}`);
  }
});

test("the suggested threshold is the row with the best F1, the higher one on a tie", async (t) => {
  const dataDir = tempDir(t);
  const r = await calibrate(dataDir, { pairs: samplePairs() });
  const rows = r.json.rows as Any[];
  const best = Math.max(...rows.map((row) => row.f1));
  const suggested = rows.find((row) => row.threshold === r.json.suggested_threshold);
  assert.ok(suggested, "the suggestion is one of the swept thresholds");
  assert.equal(suggested.f1, best);
  const tied = rows.filter((row) => row.f1 === best);
  assert.equal(suggested.threshold, Math.max(...tied.map((row) => row.threshold)));
});

test("the sample says when it is too small to trust", async (t) => {
  const dataDir = tempDir(t);
  const all = samplePairs();
  const small = await calibrate(dataDir, { pairs: [...all.slice(0, 3), ...all.slice(8, 11)] });
  assert.equal(small.code, 0, small.stdout);
  assert.match(String(small.json.warning), /fewer than 30 pairs/);

  const enough = samplePairs();
  while (enough.length < 30) enough.push(...samplePairs().slice(0, 30 - enough.length));
  const big = await calibrate(dataDir, { pairs: enough });
  assert.equal(big.json.warning, null);
});

test("calibration refuses a sample without both kinds of label", async (t) => {
  const dataDir = tempDir(t);
  const onlyYes = samplePairs().filter((p) => p.same);
  const r = await calibrate(dataDir, { pairs: onlyYes });
  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "NEEDS_BOTH_LABELS");
  assert.match(r.json.error?.message, /same: true and same: false/);
});

test("calibration refuses a malformed pair and names it", async (t) => {
  const dataDir = tempDir(t);
  const bad = [...samplePairs(), { a: "Acme", b: "Acme Ltd" }];
  const r = await calibrate(dataDir, { pairs: bad });
  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "INVALID_PAIRS");
  assert.match(r.json.error?.message, /pairs\[16\]/);
});

test("calibration needs no pipeline records and writes nothing", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const r = await calibrate(dataDir, { pairs: samplePairs() });
  assert.equal(r.code, 0, r.stdout);
  // An unknown command prints the help listing with exit 0, so check the command really ran.
  assert.ok(Array.isArray(r.json.rows), "calibrate returned its sweep, not the help listing");
  assert.equal(existsSync(join(dataDir, "pipeline")), false, "no pipeline directory is created");
  assert.equal(existsSync(join(dataDir, "employer")), false);
});
