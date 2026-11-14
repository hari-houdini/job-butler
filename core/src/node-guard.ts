// Startup guard: refuses to run on a Node older than 26. cli.ts imports this module first, so
// this body runs before any command module is evaluated. Keep it plain code that also runs on
// Node 22 (the version it must refuse), so it can print the refusal.
import { writeSync } from "node:fs";
import { nodeVersionOverride } from "./env.ts";

const REQUIRED_MAJOR = 26;

const found = nodeVersionOverride() ?? process.versions.node;
if (!(Number.parseInt(found, 10) >= REQUIRED_MAJOR)) {
  const message =
    `Job Butler needs Node ${REQUIRED_MAJOR}.0.0 or later, but this is Node ${found}. ` +
    "Install Node 26 (LTS), then run the command again.";
  // writeSync, then exit at once: nothing after this import may run.
  writeSync(1, `${JSON.stringify({ ok: false, error: { code: "NODE_TOO_OLD", message } })}\n`);
  process.exit(1);
}
