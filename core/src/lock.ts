// Two lock files in the data directory, with the same stale rule (see core-conventions.md):
//  - pipeline.lock: held for one CLI call that writes pipeline state (withWriter).
//  - run.lock: held from `run start` to `run end` by the Claude Code session running a
//    Stage. While another session holds it, that session's writes refuse, Preferences and
//    Profile edits refuse, and a second `run start` refuses (a scheduled run skips its turn).
// A lock whose hostname is this machine and whose pid is gone is stale and is cleared.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";

export interface LockInfo {
  pid: number;
  hostname: string;
  acquired_at: string;
  command: string;
}

export interface RunLockInfo extends LockInfo {
  /** Returned by `run start`; `run end --run <id>` releases only a matching lock. */
  run_id: string;
}

export function lockPath(dataDir: string): string {
  return join(dataDir, "pipeline.lock");
}

export function runLockPath(dataDir: string): string {
  return join(dataDir, "run.lock");
}

async function readLockFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Read the current pipeline lock, or undefined when nothing holds it. */
export function readLock(dataDir: string): Promise<LockInfo | undefined> {
  return readLockFile<LockInfo>(lockPath(dataDir));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is stale when it was taken on this machine by a process that no longer exists. */
function isStale(lock: LockInfo): boolean {
  return lock.hostname === hostname() && !isAlive(lock.pid);
}

function lockedError(held: LockInfo, what: string): CoreError {
  return new CoreError(
    "LOCKED",
    `Another Job Butler run is ${what} (process ${held.pid} on ${held.hostname}, ` +
      `running "${held.command}" since ${held.acquired_at}). ` +
      "Wait for it to finish, then try again.",
    { lock: held },
  );
}

/**
 * Write `info` to `file` or refuse with LOCKED. The file is written in full to a temporary
 * file and then hard-linked into place, so it is never seen half-written.
 */
async function takeLockFile(file: string, info: LockInfo, what: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(tmp, file);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const held = await readLockFile<LockInfo>(file);
      if (held === undefined) continue; // released meanwhile
      if (!isStale(held)) throw lockedError(held, what);
      await unlink(file).catch(() => {});
    }
    throw new CoreError("LOCKED", "Could not take the pipeline lock. Try again.");
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Take the per-call pipeline lock or refuse with LOCKED. */
export async function acquireLock(dataDir: string, command: string): Promise<LockInfo> {
  const info: LockInfo = {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: timestamp(),
    command,
  };
  await takeLockFile(lockPath(dataDir), info, "writing");
  return info;
}

export async function releaseLock(dataDir: string): Promise<void> {
  const held = await readLock(dataDir);
  if (held?.pid === process.pid && held.hostname === hostname()) {
    await unlink(lockPath(dataDir)).catch(() => {});
  }
}

// ---- run lock ----

// Processes that sit between the Claude Code session and this CLI call and exit with it.
const WRAPPERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "env",
  "timeout",
  "nice",
  "nohup",
  "sandbox-exec",
  "bwrap",
]);

/**
 * The process that owns a run: the long-lived Claude Code session, found as the nearest
 * ancestor of this CLI call that isn't a shell or wrapper. JOB_BUTLER_SESSION_PID overrides
 * it (tests). Where `ps` isn't available (Windows), the parent process is used.
 */
export function sessionPid(): number {
  const fixed = process.env.JOB_BUTLER_SESSION_PID;
  if (fixed) return Number(fixed);
  let pid = process.ppid;
  for (let depth = 0; depth < 10; depth++) {
    const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const m = r.status === 0 ? /^\s*(\d+)\s+(.+?)\s*$/.exec(r.stdout) : null;
    if (!m) return pid;
    const name = basename(m[2] as string).replace(/^-/, "");
    if (!WRAPPERS.has(name)) return pid;
    pid = Number(m[1]);
  }
  return pid;
}

/** The live run lock, or undefined when none is held or the one on disk is stale. */
export async function readRunLock(dataDir: string): Promise<RunLockInfo | undefined> {
  const held = await readLockFile<RunLockInfo>(runLockPath(dataDir));
  return held && !isStale(held) ? held : undefined;
}

function ownedByThisSession(lock: LockInfo): boolean {
  return lock.hostname === hostname() && lock.pid === sessionPid();
}

/**
 * Start a run for this session. If this session already holds the run lock (the
 * orchestrator started it), join that run instead: `joined: true`, same run_id.
 */
export async function startRun(
  dataDir: string,
  command: string,
): Promise<{ run: RunLockInfo; joined: boolean }> {
  const held = await readRunLock(dataDir);
  if (held && ownedByThisSession(held)) return { run: held, joined: true };
  const info: RunLockInfo = {
    pid: sessionPid(),
    hostname: hostname(),
    acquired_at: timestamp(),
    command,
    run_id: randomUUID(),
  };
  await takeLockFile(runLockPath(dataDir), info, "in progress");
  return { run: info, joined: false };
}

/** Release the run lock if `runId` matches it. Returns whether it was released. */
export async function endRun(dataDir: string, runId: string): Promise<boolean> {
  const held = await readLockFile<RunLockInfo>(runLockPath(dataDir));
  if (held?.run_id !== runId) return false;
  await unlink(runLockPath(dataDir)).catch(() => {});
  return true;
}

/** Refuse with LOCKED while any run holds the run lock (Preferences and Profile edits). */
export async function assertNoRun(dataDir: string, what: string): Promise<void> {
  const held = await readRunLock(dataDir);
  if (held) {
    throw new CoreError(
      "LOCKED",
      `A Job Butler run is in progress (process ${held.pid} on ${held.hostname}, running ` +
        `"${held.command}" since ${held.acquired_at}), so ${what} can't change now. ` +
        "Wait for the run to finish, then try again.",
      { lock: held },
    );
  }
}

/** Refuse with LOCKED while another session's run holds the run lock (pipeline writes). */
export async function assertNoOtherRun(dataDir: string): Promise<void> {
  const held = await readRunLock(dataDir);
  if (held && !ownedByThisSession(held)) throw lockedError(held, "in progress");
}
