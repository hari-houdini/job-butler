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

test("help with no command still lists every command", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["help"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  const names = (r.json.commands as { name: string }[]).map((c) => c.name);
  assert.ok(names.includes("employer calibrate"));
  assert.ok(names.includes("record put"));
});
