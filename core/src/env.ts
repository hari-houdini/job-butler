// Everything the core reads from its environment, in one place.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The private data directory: --data-dir, else JOB_BUTLER_DATA_DIR, else ~/.job-butler. */
export function resolveDataDir(flag: string | undefined): string {
  const dir = flag ?? process.env.JOB_BUTLER_DATA_DIR ?? join(homedir(), ".job-butler");
  return resolve(dir);
}

/** The current time. JOB_BUTLER_NOW (ISO 8601) fixes the clock for tests. */
export function now(): Date {
  const fixed = process.env.JOB_BUTLER_NOW;
  return fixed ? new Date(fixed) : new Date();
}

/** ISO 8601 UTC timestamp, e.g. 2026-01-15T09:00:00.000Z. */
export function timestamp(): string {
  return now().toISOString();
}

/** The `gh` executable. JOB_BUTLER_GH points tests at a fixture script. */
export function ghCommand(): string {
  return process.env.JOB_BUTLER_GH ?? "gh";
}

/** Directory of recorded network responses, when set (tests). */
export function networkFixturesDir(): string | undefined {
  return process.env.JOB_BUTLER_NETWORK_FIXTURES;
}

/**
 * The Claude Code session a command runs in: --session, else JOB_BUTLER_SESSION_ID (set for
 * Bash by the SessionStart hook through CLAUDE_ENV_FILE). Undefined when neither is given.
 */
export function sessionId(flag: string | undefined): string | undefined {
  const id = flag ?? process.env.JOB_BUTLER_SESSION_ID;
  return id === undefined || id === "" ? undefined : id;
}

/** Fault injection for tests, e.g. JOB_BUTLER_FAULT=crash-before-replace. */
export function fault(name: string): boolean {
  return process.env.JOB_BUTLER_FAULT === name;
}

/** The program that opens a file in the browser: JOB_BUTLER_OPENER (tests), else the platform's. */
export function openerCommand(): string {
  if (process.env.JOB_BUTLER_OPENER) return process.env.JOB_BUTLER_OPENER;
  return process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "explorer"
      : "xdg-open";
}

/** Which page driver Apply fills with: "fake" (tests: a scripted page) or the real browser. */
export function browserDriver(): "fake" | "playwright" {
  return process.env.JOB_BUTLER_BROWSER === "fake" ? "fake" : "playwright";
}

/** The scripted page the fake driver plays (tests). */
export function fakePageFile(): string | undefined {
  return process.env.JOB_BUTLER_FAKE_PAGE;
}

/** Path to an existing `playwright-core` entry file, used instead of the bare package name. */
export function playwrightEntry(): string | undefined {
  return process.env.JOB_BUTLER_PLAYWRIGHT || undefined;
}

/** Run the browser without a window (tests, CI). Apply's default is a visible window. */
export function browserHeadless(): boolean {
  return process.env.JOB_BUTLER_BROWSER_HEADLESS === "1";
}
