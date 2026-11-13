// The board-reader seam: one reader per ATS turns a Target company's board into JobPostings.
// Readers fetch (through httpGet) and normalise; they never write pipeline state. Discover
// (discover.ts) turns postings into Listings, Sightings and the Discover run record.
// Add an ATS by writing a reader in this folder and registering it in boards/index.ts.
import { CoreError } from "../errors.ts";
import { httpGet, httpPostJson } from "../net.ts";

/** A Target company's confirmed board, as stored in the Profile (filters.target_companies). */
export type Board =
  | { ats: "greenhouse" | "ashby"; token: string }
  | { ats: "lever"; token: string; region?: "global" | "eu" }
  | { ats: "workday"; tenant: string; instance: string; site: string };

export type Ats = Board["ats"];

/** What a reader may use besides the board itself. Never personal Profile data. */
export interface BoardContext {
  /** The Target company's name from the Profile. */
  company: string;
  /** The Profile's target roles (Workday searches with them). */
  target_roles: string[];
}

/** One job as its board shows it, already normalised. Every field is present. */
export interface JobPosting {
  /** The board's own job ID, as text. The Listing ID is `<board id>:<source_job_id>`. */
  source_job_id: string;
  title: string;
  location: string | null;
  /** The posting's public page. */
  url: string;
  /** Plain text: entities decoded, tags removed, paragraphs kept as blank lines. */
  description: string;
  departments: string[];
  employment_type: string | null;
  /** Pay as the board states it, or null when the board gives none. */
  salary: string | null;
  /** The source's own publish date (ISO 8601 UTC), or null. Can reset on republish. */
  posted_at: string | null;
  /** Closing date (ISO 8601 UTC), or null. */
  deadline: string | null;
  /** Source-specific scalars later Stages read, e.g. Greenhouse `internal_job_id`. */
  source_fields: Record<string, string | number | boolean | null>;
}

export interface BoardReader {
  /** Every job on the board. Throws BoardFailure when the board can't be read. */
  read(board: Board, context: BoardContext): Promise<JobPosting[]>;
}

/** A board that couldn't be read. Discover records it on the run as a failed source. */
export class BoardFailure extends CoreError {}

/**
 * GET a JSON document (or POST `postBody` as JSON), turning a non-2xx status or a non-JSON
 * body into a BoardFailure.
 */
export async function fetchBoardJson(
  url: string,
  what: string,
  postBody?: unknown,
): Promise<unknown> {
  const body = await fetchBoard(url, what, postBody);
  try {
    return JSON.parse(body);
  } catch {
    throw changedShape(what, url, "the response isn't JSON");
  }
}

/** GET a page (or POST `postBody` as JSON); a non-2xx status is a BoardFailure. */
export async function fetchBoard(url: string, what: string, postBody?: unknown): Promise<string> {
  const res = postBody === undefined ? await httpGet(url) : await httpPostJson(url, postBody);
  if (res.status === 404) {
    throw new BoardFailure(
      "BOARD_NOT_FOUND",
      `${what} doesn't exist (404 from ${url}). Check the board in your Profile's Target companies.`,
      { status: res.status },
    );
  }
  if (res.status < 200 || res.status > 299) {
    throw new BoardFailure(
      "BOARD_UNAVAILABLE",
      `${what} couldn't be read (HTTP ${res.status} from ${url}). Discover will try again next run.`,
      { status: res.status },
    );
  }
  return res.body;
}

export function changedShape(what: string, url: string, detail: string): BoardFailure {
  return new BoardFailure(
    "BOARD_CHANGED_SHAPE",
    `${what} answered in a shape Discover doesn't recognise (${detail}, from ${url}).`,
  );
}

/** An ISO 8601 date with any offset, as UTC; null when absent or unparseable. */
export function utc(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
