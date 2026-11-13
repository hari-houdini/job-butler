import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

async function setUp(dataDir: string): Promise<void> {
  await runCli(["profile", "put", "--input", judgment("setup-profile")], { dataDir });
  await runCli(["preferences", "init"], { dataDir });
}

/** A running process standing in for another Claude Code session. */
function otherSession(t: TestContext): Record<string, string> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  return { JOB_BUTLER_SESSION_PID: String(child.pid) };
}

const prefsFile = (dataDir: string) => join(dataDir, "preferences.yaml");

test("setup creates Preferences with every default written out", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["preferences", "init"], { dataDir });

  assert.equal(r.json.created, true);
  const yaml = readFileSync(prefsFile(dataDir), "utf8");
  for (const line of [
    /^schedule:\n(?:\s*#.*\n)* {2}enabled: false$/m,
    /^ {4}every_hours: 2$/m,
    /^ {4}at: "08:00"$/m,
    /^ {2}desktop: true$/m,
    /^external_applications:\n(?:\s*#.*\n)* {2}enabled: false\n {2}backfill_months: 6$/m,
    /^ {4}count: 1\n {4}window_months: 6\n {4}scope: same_role$/m,
  ]) {
    assert.match(yaml, line);
  }
  const again = await runCli(["preferences", "init"], { dataDir });
  assert.equal(again.json.created, false);
});

test("preferences set changes one setting and keeps the rest", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);

  const r = await runCli(["preferences", "set", "schedule.enabled", "true"], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  const got = await runCli(["preferences", "get"], { dataDir });
  const prefs = got.json.preferences as Record<string, Record<string, unknown>>;
  assert.equal(prefs.schedule?.enabled, true);
  assert.equal((prefs.external_applications as { backfill_months: number }).backfill_months, 6);
});

test("preferences set refuses a value that would make Preferences invalid", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const before = readFileSync(prefsFile(dataDir), "utf8");

  const r = await runCli(["preferences", "set", "schedule.track.every_hours", "0"], { dataDir });

  assert.equal(r.json.error?.code, "PREFERENCES_INVALID");
  assert.match(r.json.error?.message ?? "", /schedule\.track\.every_hours must be a whole number/);
  assert.equal(readFileSync(prefsFile(dataDir), "utf8"), before);
});

test("preferences set refuses while a run holds the lock, even this session's", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const before = readFileSync(prefsFile(dataDir), "utf8");

  for (const env of [otherSession(t), {}]) {
    const run = await runCli(["run", "start", "track"], { dataDir, env });
    assert.equal(run.code, 0, run.stdout);

    const r = await runCli(["preferences", "set", "schedule.enabled", "true"], { dataDir });

    assert.equal(r.json.error?.code, "LOCKED");
    assert.match(r.json.error?.message ?? "", /run is in progress.*"track".*Preferences/);
    assert.equal(readFileSync(prefsFile(dataDir), "utf8"), before);
    await runCli(["run", "end", "--run", String(run.json.run_id)], { dataDir, env });
  }

  const after = await runCli(["preferences", "set", "schedule.enabled", "true"], { dataDir });
  assert.equal(after.code, 0, after.stdout);
});

test("the Profile can't change while a run is in progress either", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  await runCli(["run", "start", "discover"], { dataDir, env: otherSession(t) });

  const r = await runCli(["profile", "put", "--section", "answer_bank", "--input", "-"], {
    dataDir,
    input: [],
  });

  assert.equal(r.json.error?.code, "LOCKED");
});

test("every run validates Preferences at start and stops on a bad hand edit", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const yaml = readFileSync(prefsFile(dataDir), "utf8");
  writeFileSync(prefsFile(dataDir), yaml.replace("backfill_months: 6", "backfill_months: six"));

  const r = await runCli(["run", "start", "track"], { dataDir });

  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "PREFERENCES_INVALID");
  assert.match(
    r.json.error?.message ?? "",
    /external_applications\.backfill_months must be a whole number/,
  );
  assert.equal((await runCli(["run", "status"], { dataDir })).json.run, null);
});

test("a deleted setting is an error, never a silent default", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const yaml = readFileSync(prefsFile(dataDir), "utf8");
  writeFileSync(prefsFile(dataDir), yaml.replace(/^ {4}every_hours: 2\n/m, ""));

  const r = await runCli(["run", "start", "discover"], { dataDir });

  assert.equal(r.json.error?.code, "PREFERENCES_INVALID");
  assert.match(
    r.json.error?.message ?? "",
    /schedule\.track\.every_hours must be a whole number .*missing/,
  );
});

test("a misspelt setting is an error", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const yaml = readFileSync(prefsFile(dataDir), "utf8");
  writeFileSync(prefsFile(dataDir), yaml.replace("desktop: true", "dekstop: true"));

  const r = await runCli(["run", "start", "discover"], { dataDir });

  assert.equal(r.json.error?.code, "PREFERENCES_INVALID");
  assert.match(r.json.error?.message ?? "", /notifications\.dekstop is not a known setting/);
});
