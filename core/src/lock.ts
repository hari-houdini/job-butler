// The pipeline lock: <data dir>/pipeline.lock guards every pipeline-state write against a
// second writer (another session, a scheduled run). A lock whose owning process is gone
// is stale and is cleared on the next acquire.
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";

export interface LockInfo {
  pid: number;
  hostname: string;
  acquired_at: string;
  command: string;
}

export function lockPath(dataDir: string): string {
  return join(dataDir, "pipeline.lock");
}

/** Read the current lock, or undefined when nothing holds it. */
export async function readLock(dataDir: string): Promise<LockInfo | undefined> {
  try {
    return JSON.parse(await readFile(lockPath(dataDir), "utf8")) as LockInfo;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
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

/**
 * Take the lock or refuse with LOCKED. The lock file is written in full to a temporary
 * file and then hard-linked into place, so it is never seen half-written.
 */
export async function acquireLock(dataDir: string, command: string): Promise<LockInfo> {
  const info: LockInfo = {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: timestamp(),
    command,
  };
  const tmp = `${lockPath(dataDir)}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(tmp, lockPath(dataDir));
        return info;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const held = await readLock(dataDir);
      if (held === undefined) continue; // released meanwhile
      if (!isStale(held)) {
        throw new CoreError(
          "LOCKED",
          `Another Job Butler run is writing (process ${held.pid} on ${held.hostname}, ` +
            `running "${held.command}" since ${held.acquired_at}). ` +
            "Wait for it to finish, then try again.",
          { lock: held },
        );
      }
      await unlink(lockPath(dataDir)).catch(() => {});
    }
    throw new CoreError("LOCKED", "Could not take the pipeline lock. Try again.");
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function releaseLock(dataDir: string): Promise<void> {
  const held = await readLock(dataDir);
  if (held?.pid === process.pid && held.hostname === hostname()) {
    await unlink(lockPath(dataDir)).catch(() => {});
  }
}
