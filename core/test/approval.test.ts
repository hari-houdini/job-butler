import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { hostEnv, runCli, tempDir } from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CORE = "node /plugins/job-butler/core/src/cli.ts";
const SESSION = "session-1";

interface HookResult {
  decision: "allow" | "deny";
  reason: string;
  message: string;
}

/** Run the PreToolUse hook the way Claude Code does, with the tool call on stdin. */
async function hook(
  dataDir: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  session = SESSION,
): Promise<HookResult> {
  const r = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: {
      session_id: session,
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
    },
  });
  assert.equal(r.code, 0, r.stdout);
  return parse(r.json);
}

function parse(json: Record<string, unknown>): HookResult {
  const out = json.hookSpecificOutput as Record<string, string> | undefined;
  return {
    decision: out?.permissionDecision === "deny" ? "deny" : "allow",
    reason: out?.permissionDecisionReason ?? "",
    message: (json.systemMessage as string | undefined) ?? "",
  };
}

const bash = (dataDir: string, command: string, session = SESSION) =>
  hook(dataDir, "Bash", { command }, session);

const recordApproval = (
  dataDir: string,
  checkpoint: string,
  actions: string[],
  session = SESSION,
) =>
  runCli(["approval", "record", checkpoint, "--session", session, "--input", "-"], {
    dataDir,
    input: { actions },
  });

test("a Shortlist pick without an Approval is denied with the reason", async (t) => {
  const dataDir = tempDir(t);
  const r = await bash(dataDir, `${CORE} application pick greenhouse:acme:1`);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /Shortlist pick/);
  assert.match(r.reason, /no Approval/i);
});

const checkpoints = [
  { checkpoint: "shortlist-pick", action: "application pick greenhouse:acme:1" },
  { checkpoint: "digest-status", action: "application status app-1 interview" },
  { checkpoint: "handover", action: "application submitted app-1" },
];

for (const { checkpoint, action } of checkpoints) {
  test(`${checkpoint}: the Approval lets its action through once, then it is spent`, async (t) => {
    const dataDir = tempDir(t);
    assert.equal((await bash(dataDir, `${CORE} ${action}`)).decision, "deny");

    const recorded = await recordApproval(dataDir, checkpoint, [action]);
    assert.equal(recorded.code, 0, recorded.stdout);
    const approval = recorded.json.approval as Record<string, unknown>;
    assert.equal(approval.checkpoint, checkpoint);
    assert.equal(approval.session_id, SESSION);
    assert.equal(approval.approved_at, "2026-01-15T09:00:00.000Z");
    assert.deepEqual(approval.actions, [{ action, spent_at: null }]);

    const allowed = await bash(dataDir, `${CORE} ${action} --data-dir "${dataDir}"`);
    assert.equal(allowed.decision, "allow", allowed.reason);

    const again = await bash(dataDir, `${CORE} ${action}`);
    assert.equal(again.decision, "deny");
    assert.match(again.reason, /already used/);

    const listed = await runCli(["approval", "list", "--session", SESSION], { dataDir });
    const [only] = listed.json.approvals as Record<string, unknown>[];
    assert.equal(only?.state, "spent");
  });
}

test("an Approval covers only the actions it lists", async (t) => {
  const dataDir = tempDir(t);
  await recordApproval(dataDir, "digest-status", ["application status app-1 interview"]);
  const other = await bash(dataDir, `${CORE} application status app-1 rejected`);
  assert.equal(other.decision, "deny");
  const listed = await bash(dataDir, `${CORE} application status app-1 interview`);
  assert.equal(listed.decision, "allow");
});

test("an Approval from an earlier session has expired", async (t) => {
  const dataDir = tempDir(t);
  await recordApproval(dataDir, "shortlist-pick", ["application pick greenhouse:acme:1"], "old");
  const r = await bash(dataDir, `${CORE} application pick greenhouse:acme:1`, "new");
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /earlier session and has expired/);
});

test("an Approval only lists its own Checkpoint's actions and needs a session", async (t) => {
  const dataDir = tempDir(t);
  const wrong = await recordApproval(dataDir, "shortlist-pick", ["application submitted app-1"]);
  assert.equal(wrong.json.error?.code, "ACTION_NOT_AT_CHECKPOINT");
  const noSession = await runCli(["approval", "record", "handover", "--input", "-"], {
    dataDir,
    input: { actions: ["application submitted app-1"] },
  });
  assert.equal(noSession.json.error?.code, "NO_SESSION");
});

test("when an Approval record can't be read, the hook denies and says why", async (t) => {
  const dataDir = tempDir(t);
  await recordApproval(dataDir, "handover", ["application submitted app-1"]);
  writeFileSync(join(dataDir, "pipeline", "approval", "broken.json"), "{not json");
  const r = await bash(dataDir, `${CORE} application submitted app-1`);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /Couldn't read the Approval records/);
});

test("a tool call the hook can't read is denied", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["hook", "pre-tool-use"], { dataDir, input: "not json" });
  assert.equal(r.code, 0);
  assert.equal(parse(r.json).decision, "deny");
});

test("a core command hidden behind shell substitution is denied", async (t) => {
  const dataDir = tempDir(t);
  const r = await bash(dataDir, `${CORE} $(echo application pick) greenhouse:acme:1`);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /shell substitution/);
});

test("ordinary core commands and other Bash calls aren't blocked", async (t) => {
  const dataDir = tempDir(t);
  assert.equal((await bash(dataDir, `${CORE} status`)).decision, "allow");
  assert.equal((await bash(dataDir, "ls -la")).decision, "allow");
});

// ---- connector tools and standing grants ----

const GMAIL = "mcp__claude_ai_Gmail__";

/** Start Job Butler in a session the way a Stage skill does: its first core call. */
const startJobButler = (dataDir: string, session = SESSION) =>
  bash(dataDir, `${CORE} status`, session);

const addGrant = (dataDir: string, scope: string, session = SESSION) =>
  runCli(["grant", "add", scope, "--session", session], { dataDir });

test("in a Job Butler session, read-only mail tools run and outward ones are denied", async (t) => {
  const dataDir = tempDir(t);
  await startJobButler(dataDir);
  for (const tool of ["search_threads", "get_thread", "get_message", "list_labels"]) {
    assert.equal((await hook(dataDir, GMAIL + tool, {})).decision, "allow", tool);
  }
  const calendar = await hook(dataDir, "mcp__claude_ai_Google_Calendar__list_events", {});
  assert.equal(calendar.decision, "allow");
  for (const tool of [
    `${GMAIL}send_message`,
    `${GMAIL}label_message`,
    "mcp__claude_ai_Google_Calendar__create_event",
    `${GMAIL}some_future_tool`,
  ]) {
    const r = await hook(dataDir, tool, {});
    assert.equal(r.decision, "deny", tool);
    assert.match(r.reason, /no Approval or standing grant covers it/);
  }
});

test("connector tools in a session that never ran Job Butler are left alone", async (t) => {
  const dataDir = tempDir(t);
  await startJobButler(dataDir, "job-butler-session");
  const r = await hook(dataDir, `${GMAIL}send_message`, {}, "unrelated-session");
  assert.equal(r.decision, "allow");
});

test("a standing grant persists across sessions, is reported when reused, and can be revoked", async (t) => {
  const dataDir = tempDir(t);
  const added = await addGrant(dataDir, `${GMAIL}label_message`, "first");
  assert.equal(added.code, 0, added.stdout);
  const grant = added.json.grant as Record<string, unknown>;
  assert.equal(grant.kind, "standing");
  assert.equal(grant.session_id, "first");
  assert.equal(grant.granted_at, "2026-01-15T09:00:00.000Z");

  await startJobButler(dataDir, "second");
  const reused = await hook(dataDir, `${GMAIL}label_message`, {}, "second");
  assert.equal(reused.decision, "allow");
  assert.match(reused.message, /used your standing grant for mcp__claude_ai_Gmail__label_message/);
  assert.match(reused.message, new RegExp(`grant revoke ${grant.id}`));

  const listed = await runCli(["grant", "list", "--session", "second"], { dataDir });
  const [row] = listed.json.grants as Record<string, unknown>[];
  assert.equal(row?.state, "active");
  assert.equal(row?.uses, 1);

  const revoked = await runCli(["grant", "revoke", String(grant.id)], { dataDir });
  assert.equal(revoked.code, 0);
  assert.equal((await hook(dataDir, `${GMAIL}label_message`, {}, "second")).decision, "deny");
});

for (const [kind, tool] of [
  ["sensitive", `${GMAIL}send_message`],
  ["destructive", `${GMAIL}trash_message`],
] as const) {
  test(`a ${kind} grant works in its own session and expires with it`, async (t) => {
    const dataDir = tempDir(t);
    const added = await addGrant(dataDir, tool, "first");
    assert.equal((added.json.grant as Record<string, unknown>).kind, kind);

    await startJobButler(dataDir, "first");
    assert.equal((await hook(dataDir, tool, {}, "first")).decision, "allow");

    await startJobButler(dataDir, "second");
    assert.equal((await hook(dataDir, tool, {}, "second")).decision, "deny");
    const listed = await runCli(["grant", "list", "--session", "second"], { dataDir });
    const [row] = listed.json.grants as Record<string, unknown>[];
    assert.equal(row?.state, "expired");
  });
}

test("a Checkpoint can't be a standing grant, and only gated tools can be granted", async (t) => {
  const dataDir = tempDir(t);
  const checkpoint = await addGrant(dataDir, "application pick");
  assert.equal(checkpoint.json.error?.code, "CHECKPOINT_NEEDS_APPROVAL");
  const readOnly = await addGrant(dataDir, `${GMAIL}search_threads`);
  assert.equal(readOnly.json.error?.code, "GRANT_SCOPE_UNKNOWN");
});

test("when the grants file can't be read, outward tools are denied with the reason", async (t) => {
  const dataDir = tempDir(t);
  await startJobButler(dataDir);
  writeFileSync(join(dataDir, "grants.json"), "{broken");
  const r = await hook(dataDir, `${GMAIL}label_message`, {});
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /Couldn't read your standing grants/);
});

test("session start exports the session id to later Bash calls", async (t) => {
  const dir = tempDir(t);
  const envFile = join(dir, "env.sh");
  const r = await runCli(["hook", "session-start"], {
    dataDir: dir,
    input: { session_id: "abc-123", hook_event_name: "SessionStart" },
    env: { CLAUDE_ENV_FILE: envFile },
  });
  assert.equal(r.code, 0);
  assert.equal(readFileSync(envFile, "utf8"), "export JOB_BUTLER_SESSION_ID=abc-123\n");
});

test("session start writes nothing when Claude Code gives no env file", async (t) => {
  const dir = tempDir(t);
  const r = await runCli(["hook", "session-start"], {
    dataDir: dir,
    input: { session_id: "abc-123", hook_event_name: "SessionStart" },
    env: { CLAUDE_ENV_FILE: undefined },
  });
  assert.equal(r.code, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test("the plugin's hook command blocks the tool even when the core can't run", async (t) => {
  const dir = tempDir(t);
  const config = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  const command: string = config.hooks.PreToolUse[0].hooks[0].command;
  const run = (pluginRoot: string, stdin: string) =>
    spawnSync("sh", ["-c", command], {
      input: stdin,
      encoding: "utf8",
      env: { ...hostEnv(), CLAUDE_PLUGIN_ROOT: pluginRoot, JOB_BUTLER_DATA_DIR: dir },
    });

  const pick = JSON.stringify({
    session_id: SESSION,
    tool_name: "Bash",
    tool_input: { command: `${CORE} application pick greenhouse:acme:1` },
  });
  const denied = run(ROOT, pick);
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");

  const broken = run(join(dir, "no-such-plugin"), pick);
  assert.equal(broken.status, 2, "exit 2 makes Claude Code block the tool call");
  assert.match(broken.stderr, /blocked/);
});

test("Write and Edit can't touch pipeline state or grants, only other files", async (t) => {
  const dataDir = tempDir(t);
  for (const file of ["pipeline/approval/x.json", "grants.json", "pipeline/application/a.json"]) {
    const r = await hook(dataDir, "Write", { file_path: join(dataDir, file), content: "{}" });
    assert.equal(r.decision, "deny", file);
  }
  const other = await hook(dataDir, "Edit", { file_path: join(dataDir, "notes.md") });
  assert.equal(other.decision, "allow");
});
