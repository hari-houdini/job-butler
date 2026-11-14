// Startup guard: refuses to run on a Node older than 26. cli.ts imports this module first, so
// this body runs before any command module is evaluated. Keep it plain code that also runs on
// Node 22 (the version it must refuse), so it can print the refusal.
//
// The refusal follows the output contract for the command being run (core-conventions.md, CLI):
// the Approval hook (`hook pre-tool-use`) and the SessionStart hook (`hook session-start`) print
// Claude Code's hook JSON on exit 0, because Claude Code reads hook JSON only on exit 0 (any
// other exit is a non-blocking error, and the tool runs). Every other command prints the CLI
// error envelope and exits 1.
import { writeSync } from "node:fs";
import { nodeVersionOverride } from "./env.ts";

const REQUIRED_MAJOR = 26;

const found = nodeVersionOverride() ?? process.versions.node;
if (!(Number.parseInt(found, 10) >= REQUIRED_MAJOR)) {
  const message =
    `Job Butler needs Node ${REQUIRED_MAJOR}.0.0 or later, but this is Node ${found}. ` +
    "Install Node 26 (LTS), then run the command again.";
  const [command, subcommand] = process.argv.slice(2);
  // writeSync, then exit at once: nothing after this import may run.
  if (command === "hook" && subcommand === "pre-tool-use") {
    writeSync(
      1,
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      })}\n`,
    );
    process.exit(0);
  }
  if (command === "hook" && subcommand === "session-start") {
    writeSync(1, `${JSON.stringify({ systemMessage: message })}\n`);
    process.exit(0);
  }
  writeSync(1, `${JSON.stringify({ ok: false, error: { code: "NODE_TOO_OLD", message } })}\n`);
  process.exit(1);
}
