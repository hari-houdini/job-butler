// The advisory login-type check (#60, decision #12): reports how Claude Code is signed in, so a
// missing claude.ai connector is explained rather than silent. It is deterministic (no network,
// no token is read or printed) and it never blocks: anything it cannot tell is "unknown", and
// nothing it finds makes a run or a hook fail.
//
// Order of detection, first match wins (Claude Code prefers an API key when one is set):
//   1. CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX  -> bedrock / vertex
//   2. ANTHROPIC_API_KEY                                 -> api-key
//   3. CLAUDE_CODE_OAUTH_TOKEN                           -> setup-token
//   4. <config dir>/.credentials.json has a claudeAiOauth object -> claude.ai
//   5. macOS keychain item "Claude Code-credentials" (checked only when CLAUDE_CONFIG_DIR is unset) -> claude.ai
//   6. otherwise                                         -> unknown
// The config dir is CLAUDE_CONFIG_DIR, else ~/.claude.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeCodeVar } from "./env.ts";

export type LoginType = "claude.ai" | "api-key" | "setup-token" | "bedrock" | "vertex" | "unknown";

export interface LoginReport {
  type: LoginType;
  /** How it was decided, for the job seeker. Never a token or a path to one. */
  method: string;
}

const KEYCHAIN_SERVICE = "Claude Code-credentials";

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "0" && value.toLowerCase() !== "false";
}

/** True when the credentials file exists and holds a claudeAiOauth object. Only the key is checked. */
async function hasCredentialsFile(configDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(configDir, ".credentials.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  const parsed = JSON.parse(raw) as { claudeAiOauth?: unknown };
  return typeof parsed.claudeAiOauth === "object" && parsed.claudeAiOauth !== null;
}

/** True when the macOS keychain holds the Claude Code credentials item. Exit status only; no secret is read. */
function hasKeychainItem(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE],
      { timeout: 3000 },
      (error) => resolve(error === null),
    );
  });
}

/** Detect the login type. Never throws: an unexpected failure reports "unknown". */
export async function detectLoginType(): Promise<LoginReport> {
  try {
    if (isSet(claudeCodeVar("CLAUDE_CODE_USE_BEDROCK"))) {
      return { type: "bedrock", method: "CLAUDE_CODE_USE_BEDROCK is set" };
    }
    if (isSet(claudeCodeVar("CLAUDE_CODE_USE_VERTEX"))) {
      return { type: "vertex", method: "CLAUDE_CODE_USE_VERTEX is set" };
    }
    if (claudeCodeVar("ANTHROPIC_API_KEY")) {
      return { type: "api-key", method: "ANTHROPIC_API_KEY is set" };
    }
    if (claudeCodeVar("CLAUDE_CODE_OAUTH_TOKEN")) {
      return { type: "setup-token", method: "CLAUDE_CODE_OAUTH_TOKEN is set" };
    }

    const override = claudeCodeVar("CLAUDE_CONFIG_DIR");
    const configDir = override ?? join(homedir(), ".claude");
    if (await hasCredentialsFile(configDir)) {
      return { type: "claude.ai", method: "claudeAiOauth credentials file" };
    }
    if (override === undefined && process.platform === "darwin" && (await hasKeychainItem())) {
      return { type: "claude.ai", method: `macOS keychain item "${KEYCHAIN_SERVICE}"` };
    }
    return { type: "unknown", method: "no login signal found" };
  } catch {
    return { type: "unknown", method: "login could not be checked" };
  }
}
