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

/** Fault injection for tests, e.g. JOB_BUTLER_FAULT=crash-before-replace. */
export function fault(name: string): boolean {
  return process.env.JOB_BUTLER_FAULT === name;
}
