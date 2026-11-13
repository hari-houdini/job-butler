import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempDir } from "./harness.ts";

test("status with no Profile reports it missing and points to setup", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["status"], { dataDir });

  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.profile, "missing");
  assert.equal(r.json.next, "setup");
  assert.match(String(r.json.message), /\/job-butler setup/);
});
