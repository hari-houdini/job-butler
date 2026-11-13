// The UK sponsor register (#40): a local copy of the Home Office CSV, refreshed at most once a
// day, and the parsing and name helpers the Employer matcher in employer.ts uses.
//
// The register link changes with every release, so it is scraped from the GOV.UK publication
// page. A failed refresh keeps the last good copy and marks it stale; it never deletes it.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { now, timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";
import { httpGet } from "./net.ts";
import { writeThenReplace } from "./store.ts";

export const REGISTER_PAGE =
  "https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers";

/** One licence row, as published. An organisation has one row per route. */
export interface RegisterRow {
  type_rating: string;
  route: string;
}

/** One licence holder: a name and a town, with every row published for them. */
export interface RegisterGroup {
  /** Stable key: normalised name and town. */
  key: string;
  organisation_name: string;
  town: string;
  county: string;
  entries: RegisterRow[];
  /** Normalised names this holder answers to (the name, and each side of "t/a"). */
  names: string[];
}

export interface RegisterMeta {
  /** When the CSV was last downloaded successfully (ISO 8601 UTC). */
  downloaded_at: string;
  csv_url: string;
  /** The last failed refresh since then, or null. */
  last_error: { at: string; message: string } | null;
}

export interface RegisterStatus {
  /** Date (YYYY-MM-DD) of the copy in use, or null when there is none. */
  as_of: string | null;
  stale: boolean;
  stale_note: string | null;
}

const LEGAL_WORDS = new Set(["ltd", "limited", "plc", "llp"]);

/** Lower-case, drop punctuation and legal suffixes (Ltd, Limited, PLC, LLP). */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w !== "" && !LEGAL_WORDS.has(w))
    .join(" ");
}

export function normaliseTown(town: string): string {
  return town
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Two towns agree when one's words are all in the other ("London" and "Greater London"). */
export function townsAgree(a: string, b: string): boolean {
  const x = normaliseTown(a).split(" ").filter(Boolean);
  const y = normaliseTown(b).split(" ").filter(Boolean);
  if (x.length === 0 || y.length === 0) return false;
  const [small, large] = x.length <= y.length ? [x, y] : [y, x];
  return small.every((w) => large.includes(w));
}

/** A quoted-field CSV parser (RFC 4180): quotes, doubled quotes, commas and newlines in fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** "X Ltd t/a Y" answers to X and to Y. */
function tradingNames(name: string): string[] {
  const parts = name.split(/\s+(?:t\/a|trading as)\s+/i);
  return [...new Set(parts.map(normaliseName).filter((n) => n !== ""))];
}

/** Group the register's rows by licence holder. Refuses a CSV whose columns have changed. */
export function parseRegister(csv: string): RegisterGroup[] {
  const rows = parseCsv(csv);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const iName = header.indexOf("organisation name");
  const iTown = header.indexOf("town/city");
  const iCounty = header.indexOf("county");
  const iType = header.indexOf("type & rating");
  const iRoute = header.indexOf("route");
  if (iName < 0 || iTown < 0 || iType < 0 || iRoute < 0) {
    throw new CoreError(
      "REGISTER_CHANGED_SHAPE",
      "The sponsor register CSV doesn't have the columns Job Butler expects.",
    );
  }
  const groups = new Map<string, RegisterGroup>();
  for (const r of rows.slice(1)) {
    const name = (r[iName] ?? "").trim();
    if (name === "") continue;
    const town = (r[iTown] ?? "").trim();
    const key = `${normaliseName(name)}|${normaliseTown(town)}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        key,
        organisation_name: name,
        town,
        county: (r[iCounty] ?? "").trim(),
        entries: [],
        names: tradingNames(name),
      };
      groups.set(key, g);
    }
    g.entries.push({ type_rating: (r[iType] ?? "").trim(), route: (r[iRoute] ?? "").trim() });
  }
  return [...groups.values()];
}

// --- the local copy ---------------------------------------------------------------------

const csvPath = (dataDir: string) => join(dataDir, "cache", "sponsor-register.csv");
const metaPath = (dataDir: string) => join(dataDir, "cache", "sponsor-register.json");

export async function readRegisterMeta(dataDir: string): Promise<RegisterMeta | undefined> {
  try {
    return JSON.parse(await readFile(metaPath(dataDir), "utf8")) as RegisterMeta;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export async function loadRegister(dataDir: string): Promise<RegisterGroup[]> {
  try {
    return parseRegister(await readFile(csvPath(dataDir), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CoreError(
        "REGISTER_MISSING",
        "There is no copy of the sponsor register yet. Run `sponsor refresh` to download it.",
      );
    }
    throw e;
  }
}

export function registerStatus(meta: RegisterMeta | undefined): RegisterStatus {
  if (meta === undefined) return { as_of: null, stale: false, stale_note: null };
  const as_of = meta.downloaded_at.slice(0, 10);
  const stale = meta.last_error !== null;
  return { as_of, stale, stale_note: stale ? `data may be stale (as of ${as_of})` : null };
}

export interface RefreshOutcome {
  refreshed: boolean;
  csv_url: string | null;
  organisations: number | null;
  status: RegisterStatus;
}

async function saveMeta(dataDir: string, meta: RegisterMeta): Promise<void> {
  await writeThenReplace(metaPath(dataDir), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Download the register unless a copy was already downloaded today (UTC). Call inside
 * `withWriter`. A failure keeps the last good copy and records the error (so results say
 * "data may be stale"); with no copy at all it refuses with REGISTER_UNAVAILABLE.
 */
export async function refreshRegister(dataDir: string): Promise<RefreshOutcome> {
  const meta = await readRegisterMeta(dataDir);
  if (meta !== undefined && meta.downloaded_at.slice(0, 10) === now().toISOString().slice(0, 10)) {
    return {
      refreshed: false,
      csv_url: meta.csv_url,
      organisations: null,
      status: registerStatus(meta),
    };
  }
  try {
    const page = await httpGet(REGISTER_PAGE);
    if (page.status < 200 || page.status >= 300) {
      throw new Error(`the GOV.UK register page answered ${page.status}`);
    }
    const link = /href="([^"]+\.csv)"/i.exec(page.body);
    if (link === null) throw new Error("no CSV link was found on the GOV.UK register page");
    const csvUrl = new URL(link[1] as string, REGISTER_PAGE).toString();
    const csv = await httpGet(csvUrl);
    if (csv.status < 200 || csv.status >= 300) throw new Error(`the CSV answered ${csv.status}`);
    const groups = parseRegister(csv.body);
    if (groups.length === 0) throw new Error("the CSV was empty");
    await mkdir(join(dataDir, "cache"), { recursive: true });
    await writeThenReplace(csvPath(dataDir), csv.body);
    const fresh: RegisterMeta = { downloaded_at: timestamp(), csv_url: csvUrl, last_error: null };
    await saveMeta(dataDir, fresh);
    return {
      refreshed: true,
      csv_url: csvUrl,
      organisations: groups.length,
      status: registerStatus(fresh),
    };
  } catch (e) {
    const message = (e as Error).message;
    if (meta === undefined) {
      throw new CoreError(
        "REGISTER_UNAVAILABLE",
        `Couldn't download the sponsor register (${message}) and there is no earlier copy. Try again later.`,
      );
    }
    const failed: RegisterMeta = { ...meta, last_error: { at: timestamp(), message } };
    await saveMeta(dataDir, failed);
    return {
      refreshed: false,
      csv_url: meta.csv_url,
      organisations: null,
      status: registerStatus(failed),
    };
  }
}
