// The pipeline store (ADR 0001): one JSON file per record under <data dir>/pipeline/<type>/.
// Every write happens under the pipeline lock, goes to a temporary file, and then
// replaces the real file with a rename, so a crash never leaves a half-written record.
import { mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureSafeDataDir } from "./data-dir.ts";
import { fault, timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { acquireLock, assertNoOtherRun, assertNoRun, releaseLock } from "./lock.ts";

export const SCHEMA_VERSION = 1;

export const RECORD_TYPES = [
  "listing",
  "application",
  "employer",
  "discover-run",
  "sync",
  "approval",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Every stored record carries these fields; the core sets all four. */
export interface StoredRecord {
  schema_version: number;
  id: string;
  created_at: string;
  updated_at: string;
  [field: string]: unknown;
}

/** Marks a temporary file from `writeThenReplace`: `<file>.tmp-<pid>`. */
export const TMP_MARKER = ".tmp-";

export function assertRecordType(type: string | undefined): RecordType {
  if (!RECORD_TYPES.includes(type as RecordType)) {
    throw usageError(`Unknown record type "${type}". Expected one of: ${RECORD_TYPES.join(", ")}`);
  }
  return type as RecordType;
}

function typeDir(dataDir: string, type: RecordType): string {
  return join(dataDir, "pipeline", type);
}

function recordFile(dataDir: string, type: RecordType, id: string): string {
  if (id === "" || id === "." || id === "..") throw usageError(`Invalid record id "${id}"`);
  // encodeURIComponent keeps ids like "greenhouse:acme:123" safe on every filesystem.
  return join(typeDir(dataDir, type), `${encodeURIComponent(id)}.json`);
}

export async function getRecord(
  dataDir: string,
  type: RecordType,
  id: string,
): Promise<StoredRecord | undefined> {
  try {
    return JSON.parse(await readFile(recordFile(dataDir, type, id), "utf8")) as StoredRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** All records of a type, sorted by id. Leftover temporary files are never read. */
export async function listRecords(dataDir: string, type: RecordType): Promise<StoredRecord[]> {
  let names: string[];
  try {
    names = await readdir(typeDir(dataDir, type));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const records = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => JSON.parse(await readFile(join(typeDir(dataDir, type), n), "utf8"))),
  );
  return (records as StoredRecord[]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface StoreWriter {
  /** Create or replace a record. `data` holds the record's own fields. */
  put(type: RecordType, id: string, data: Record<string, unknown>): Promise<StoredRecord>;
  delete(type: RecordType, id: string): Promise<boolean>;
}

/**
 * Run `fn` holding the pipeline lock; refuses while another session's run holds the run
 * lock. Checks the data directory is safe first, clears
 * temporary files left by an interrupted write, and releases the lock afterwards.
 * Put all of one command's writes in one `withWriter` call.
 */
export async function withWriter<T>(
  dataDir: string,
  command: string,
  fn: (w: StoreWriter) => Promise<T>,
): Promise<T> {
  await ensureSafeDataDir(dataDir);
  await acquireLock(dataDir, command);
  let result: T;
  try {
    await assertNoOtherRun(dataDir);
    await sweepTemporaryFiles(dataDir);
    result = await fn({
      put: (type, id, data) => putRecord(dataDir, type, id, data),
      delete: (type, id) => deleteRecord(dataDir, type, id),
    });
  } finally {
    await releaseLock(dataDir);
  }
  await refreshView(dataDir);
  return result;
}

/**
 * Regenerate the pipeline view (#43) after a write, with the lock already released. It only
 * reads records and replaces files outside `pipeline/`, so it never calls `withWriter` and
 * can't recurse. A failure is reported on stderr and never fails the write that triggered it.
 */
async function refreshView(dataDir: string): Promise<void> {
  try {
    await (await import("./view.ts")).regenerateView(dataDir);
  } catch (e) {
    process.stderr.write(
      `Job Butler: the pipeline view was not regenerated: ${(e as Error).message}\n`,
    );
  }
}

/**
 * Run `fn` holding the pipeline lock, for a file that must not change mid-run (Profile,
 * Preferences): refuses with LOCKED while any run holds the run lock, this session's too.
 */
export async function withEditLock<T>(
  dataDir: string,
  command: string,
  what: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureSafeDataDir(dataDir);
  await acquireLock(dataDir, command);
  try {
    await assertNoRun(dataDir, what);
    return await fn();
  } finally {
    await releaseLock(dataDir);
  }
}

async function putRecord(
  dataDir: string,
  type: RecordType,
  id: string,
  data: Record<string, unknown>,
): Promise<StoredRecord> {
  const file = recordFile(dataDir, type, id);
  const existing = await getRecord(dataDir, type, id);
  const now = timestamp();
  const record: StoredRecord = {
    schema_version: SCHEMA_VERSION,
    id,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    ...withoutReservedFields(data),
  };
  await mkdir(typeDir(dataDir, type), { recursive: true });
  await writeThenReplace(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function deleteRecord(dataDir: string, type: RecordType, id: string): Promise<boolean> {
  try {
    await unlink(recordFile(dataDir, type, id));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

function withoutReservedFields(data: Record<string, unknown>): Record<string, unknown> {
  const { schema_version: _v, id: _i, created_at: _c, updated_at: _u, ...rest } = data;
  return rest;
}

/** Write to <file>.tmp-<pid>, flush to disk, then rename over the real file. */
export async function writeThenReplace(file: string, content: string | Buffer): Promise<void> {
  const tmp = `${file}${TMP_MARKER}${process.pid}`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (fault("crash-before-replace")) process.exit(137);
  await rename(tmp, file);
}

async function sweepTemporaryFiles(dataDir: string): Promise<void> {
  for (const type of RECORD_TYPES) {
    let names: string[];
    try {
      names = await readdir(typeDir(dataDir, type));
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.includes(TMP_MARKER)) await rm(join(typeDir(dataDir, type), n), { force: true });
    }
  }
}

export function notFound(type: string, id: string): CoreError {
  return new CoreError("NOT_FOUND", `No ${type} record with id "${id}".`, { type, id });
}
