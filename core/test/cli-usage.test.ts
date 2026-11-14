import assert from "node:assert/strict";
import { test } from "node:test";
import { RECORD_TYPES } from "../src/store.ts";
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

test("on the Approval hook path a Node older than 26 is a deny decision, exit 0", async (t) => {
  // Claude Code reads hook JSON only on exit 0 (exit 1 is a non-blocking error: the tool runs).
  const dataDir = tempDir(t);
  const r = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: "s", tool_name: "Bash", tool_input: { command: "ls" } },
    env: { JOB_BUTLER_NODE_VERSION: "22.18.0" },
  });
  assert.equal(r.code, 0, r.stdout);
  const out = r.json.hookSpecificOutput as Record<string, unknown>;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "deny");
  assert.match(String(out.permissionDecisionReason), /Node 26/);
  assert.match(String(out.permissionDecisionReason), /22\.18\.0/);
  assert.equal(r.json.ok, undefined, "no CLI envelope on the hook path");
});

test("on the SessionStart hook path a Node older than 26 is a system message, exit 0", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["hook", "session-start"], {
    dataDir,
    input: { session_id: "s" },
    env: { JOB_BUTLER_NODE_VERSION: "22.18.0" },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.match(String(r.json.systemMessage), /Node 26/);
  assert.match(String(r.json.systemMessage), /22\.18\.0/);
  assert.equal(r.json.ok, undefined, "no CLI envelope on the hook path");
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

// A bad or missing positional is refused with the same USAGE code and message as before the
// usage lines were generated from the registry's declarations (#67, D3). A sample across the
// shapes: a required positional, an id after a validated type, a pair, a stage, a flag and input.
const badPositionals: [string[], string][] = [
  [["fetch"], "fetch: <url> is required"],
  [["record", "get", "listing"], "record get: <id> is required"],
  [
    ["record", "put"],
    `Unknown record type "undefined". Expected one of: ${RECORD_TYPES.join(", ")}`,
  ],
  [["employer", "confirm"], "<id> is required"],
  [
    ["preferences", "set", "schedule.enabled"],
    "preferences set: <setting> and <value> are required",
  ],
  [["listing", "split", "one"], "listing split: <listing_id> and <alias_id> are required"],
  [
    ["run", "start", "nope"],
    "run start: <stage> must be one of: pipeline, discover, screen, tailor, apply, track",
  ],
  [["run", "end"], "run end: --run <run_id> is required"],
  [["discover", "confirm"], "discover confirm: <discover_run_id> is required"],
  [["resume", "import"], "resume import: <file> is required"],
];

for (const [args, message] of badPositionals) {
  test(`"${args.join(" ")}" with a bad positional is refused as before: ${message}`, async (t) => {
    const r = await runCli(args, { dataDir: tempDir(t) });
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error?.code, "USAGE");
    assert.equal(r.json.error?.message, message);
  });
}

test("a file input missing on the command line is refused with the usage line in the message", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["employer", "calibrate"], { dataDir });
  assert.equal(r.code, 2, r.stdout);
  assert.equal(
    r.json.error?.message,
    'employer calibrate --input <file>|- ({"pairs": [{"a", "b", "same"}]}): --input <file> or --input - is required',
  );
});

test("an inline input missing on the command line is refused with the usage line in the message", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["track", "record"], { dataDir });
  assert.equal(r.code, 2, r.stdout);
  assert.equal(
    r.json.error?.message,
    'track record --input {"messages": [...]}: --input <file> or --input - is required',
  );
});
