import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, tempDir } from "./harness.ts";

test("an unknown command is refused with a usage error, not reported as success", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["employer", "calibrat"], { dataDir });
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error?.code, "USAGE");
  assert.match(String(r.json.error?.message), /unknown command "employer calibrat"/);
  assert.match(String(r.json.error?.message), /help/);
});

test("a Node older than 26 is refused with NODE_TOO_OLD before any command runs", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["status"], {
    dataDir,
    env: { JOB_BUTLER_NODE_VERSION: "22.18.0" },
  });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error?.code, "NODE_TOO_OLD");
  assert.match(String(r.json.error?.message), /26/);
  assert.match(String(r.json.error?.message), /22\.18\.0/);
});

test("a Node just below the minimum (25.9.0) is still refused", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["status"], {
    dataDir,
    env: { JOB_BUTLER_NODE_VERSION: "25.9.0" },
  });
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.error?.code, "NODE_TOO_OLD");
  assert.match(String(r.json.error?.message), /25\.9\.0/);
});

test("Node 26.0.0, or no override, runs a read-only command normally", async (t) => {
  const dataDir = tempDir(t);
  for (const env of [{ JOB_BUTLER_NODE_VERSION: "26.0.0" }, {}]) {
    const r = await runCli(["status"], { dataDir, env });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.ok, true);
  }
});

test("help with no command still lists every command", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["help"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  const names = (r.json.commands as { name: string }[]).map((c) => c.name);
  assert.ok(names.includes("employer calibrate"));
  assert.ok(names.includes("record put"));
});
