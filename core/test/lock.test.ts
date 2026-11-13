import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { deadPid, runCli, tempDir } from "./harness.ts";

// The lock file format is a contract (docs/agents/core-conventions.md), so tests seed it directly.
function seedLock(dataDir: string, pid: number, host = hostname()): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "pipeline.lock"),
    JSON.stringify({
      pid,
      hostname: host,
      acquired_at: "2026-01-15T08:00:00.000Z",
      command: "discover",
    }),
  );
}

function liveProcess(t: TestContext): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  return child.pid as number;
}

const put = (dataDir: string, id: string, input: unknown, env: Record<string, string> = {}) =>
  runCli(["record", "put", "listing", id, "--input", "-"], { dataDir, input, env });

test("a lock held by a running process blocks a second writer with a clear message", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const pid = liveProcess(t);
  seedLock(dataDir, pid);

  const r = await put(dataDir, "a", { title: "x" });

  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "LOCKED");
  assert.match(
    r.json.error?.message ?? "",
    new RegExp(`process ${pid}.*"discover".*try again`, "i"),
  );
  assert.equal(existsSync(join(dataDir, "pipeline", "listing", "a.json")), false);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "pipeline.lock"), "utf8")).pid, pid);
});

test("a stale lock whose process is gone is cleared and the write goes ahead", async (t) => {
  const dataDir = join(tempDir(t), "data");
  seedLock(dataDir, deadPid());

  const r = await put(dataDir, "a", { title: "x" });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(existsSync(join(dataDir, "pipeline", "listing", "a.json")), true);
  assert.equal(existsSync(join(dataDir, "pipeline.lock")), false);
});

test("a lock taken on another machine is never treated as stale", async (t) => {
  const dataDir = join(tempDir(t), "data");
  seedLock(dataDir, deadPid(), "some-other-laptop");

  const r = await put(dataDir, "a", { title: "x" });

  assert.equal(r.json.error?.code, "LOCKED");
});

test("a successful write releases the lock", async (t) => {
  const dataDir = join(tempDir(t), "data");

  await put(dataDir, "a", { title: "x" });

  assert.equal(existsSync(join(dataDir, "pipeline.lock")), false);
});

test("an interrupted write leaves the old record intact and the next write recovers", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const listingDir = join(dataDir, "pipeline", "listing");
  await put(dataDir, "a", { title: "Original" });

  const crashed = await runCli(["record", "put", "listing", "a", "--input", "-"], {
    dataDir,
    input: { title: "Half-written" },
    env: { JOB_BUTLER_FAULT: "crash-before-replace" },
  }).catch((e: Error) => e);

  // The process died mid-write: no JSON result, old record intact, its temp file and lock left behind.
  assert.ok(crashed instanceof Error);
  assert.equal(JSON.parse(readFileSync(join(listingDir, "a.json"), "utf8")).title, "Original");
  assert.equal(readdirSync(listingDir).length, 2);
  assert.equal(existsSync(join(dataDir, "pipeline.lock")), true);
  const list = await runCli(["record", "list", "listing"], { dataDir });
  assert.deepEqual(
    (list.json.records as { title: string }[]).map((x) => x.title),
    ["Original"],
  );

  const next = await put(dataDir, "a", { title: "Rewritten" });

  assert.equal(next.code, 0, next.stdout);
  assert.deepEqual(readdirSync(listingDir), ["a.json"]);
  assert.equal(JSON.parse(readFileSync(join(listingDir, "a.json"), "utf8")).title, "Rewritten");
});
