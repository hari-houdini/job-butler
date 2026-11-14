import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { CLI, deadPid, hostEnv, judgment, runCli, tempDir } from "./harness.ts";

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

const putListing = (dataDir: string, env: Record<string, string> = {}) =>
  runCli(["record", "put", "listing", "a", "--input", "-"], {
    dataDir,
    input: { title: "x" },
    env,
  });

test("a second session can't start a run while another session's run holds the lock", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const first = await runCli(["run", "start", "track"], { dataDir, env: otherSession(t) });
  assert.equal(first.code, 0, first.stdout);

  const r = await runCli(["run", "start", "pipeline"], { dataDir });

  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "LOCKED");
  assert.match(r.json.error?.message ?? "", /"track".*Wait for it to finish/);
});

test("a run lock whose session has gone is stale and the next run takes it", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const env = { JOB_BUTLER_SESSION_PID: String(deadPid()) };
  await runCli(["run", "start", "discover"], { dataDir, env });

  assert.equal((await runCli(["run", "status"], { dataDir })).json.run, null);
  const r = await runCli(["run", "start", "discover"], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.joined, false);
});

test("a Stage started inside this session's run joins it, and only the starter ends it", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const outer = await runCli(["run", "start", "pipeline"], { dataDir });

  const inner = await runCli(["run", "start", "discover"], { dataDir });

  assert.equal(inner.json.joined, true);
  assert.equal(inner.json.run_id, outer.json.run_id);
  const wrong = await runCli(["run", "end", "--run", "not-this-run"], { dataDir });
  assert.equal(wrong.json.released, false);
  assert.equal(existsSync(join(dataDir, "run.lock")), true);
  const end = await runCli(["run", "end", "--run", String(outer.json.run_id)], { dataDir });
  assert.equal(end.json.released, true);
  assert.equal(existsSync(join(dataDir, "run.lock")), false);
});

test("another session's run blocks pipeline writes; the running session still writes", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const runner = otherSession(t);
  await runCli(["run", "start", "discover"], { dataDir, env: runner });

  const blocked = await putListing(dataDir);
  const own = await putListing(dataDir, runner);

  assert.equal(blocked.json.error?.code, "LOCKED");
  assert.equal(own.code, 0, own.stdout);
});

test("the run belongs to the session process, not the shell that runs each command", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);

  // As Claude Code's Bash tool does: a shell between the session and the CLI.
  const r = spawnSync("sh", ["-c", `"${process.execPath}" "${CLI}" run start discover; true`], {
    env: { ...hostEnv(), JOB_BUTLER_DATA_DIR: dataDir, JOB_BUTLER_SESSION_PID: "" },
    encoding: "utf8",
  });

  const lock = JSON.parse(readFileSync(join(dataDir, "run.lock"), "utf8"));
  assert.equal(JSON.parse(r.stdout).ok, true, r.stdout);
  assert.equal(lock.pid, process.pid);
});
