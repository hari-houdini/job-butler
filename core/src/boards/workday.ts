// Workday has no documented public job API (#16, #36). Discover:
//   1. searches the career site's undocumented cxs endpoint once per target role:
//        POST https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//        {"appliedFacets": {}, "limit": 20, "offset": n, "searchText": "<role>"}
//      → {total, jobPostings: [{title, externalPath, locationsText, postedOn, remoteType}]}
//      `total` is only reliable on the first page (later pages answer 0).
//   2. reads each job's details from the JSON-LD JobPosting in its server-rendered page,
//      https://{tenant}.{instance}.myworkdayjobs.com/{site}{externalPath}, with a plain GET.
// cxs can change without notice, so anything unexpected fails the source loudly
// (BOARD_CHANGED_SHAPE) rather than returning a partial board.
import { htmlToText } from "../html-text.ts";
import { isObject } from "../validate.ts";
import {
  type Board,
  BoardFailure,
  type BoardReader,
  changedShape,
  fetchBoard,
  fetchBoardJson,
  type JobPosting,
  utc,
} from "./reader.ts";

/** cxs refuses pages larger than 20. */
const PAGE = 20;
/** More matches than this for one role means the search is too broad to read whole. */
const MAX_RESULTS = 2000;
/** Job pages fetched at once. */
const CONCURRENCY = 4;

type WorkdayBoard = Extract<Board, { ats: "workday" }>;

function workdayBoard(board: Board): WorkdayBoard {
  if (board.ats !== "workday") throw new Error(`not a Workday board: ${board.ats}`);
  return board;
}

/** One cxs search result. */
interface Hit {
  externalPath: string;
  locationsText: string | null;
  postedOn: string | null;
  remoteType: string | null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

async function search(listUrl: string, what: string, searchText: string): Promise<Hit[]> {
  const hits: Hit[] = [];
  let total = 0;
  let offset = 0;
  do {
    const body = { appliedFacets: {}, limit: PAGE, offset, searchText };
    const page = await fetchBoardJson(listUrl, what, body);
    if (!isObject(page) || !Array.isArray(page.jobPostings) || typeof page.total !== "number") {
      throw changedShape(what, listUrl, "no jobPostings or total");
    }
    if (offset === 0) total = page.total;
    if (total > MAX_RESULTS) {
      throw new BoardFailure(
        "BOARD_SEARCH_TOO_BROAD",
        `${what} has ${total} jobs matching "${searchText}", more than Discover reads (${MAX_RESULTS}). Make that target role more specific in your Profile.`,
      );
    }
    for (const [i, p] of page.jobPostings.entries()) {
      if (!isObject(p) || typeof p.externalPath !== "string" || typeof p.title !== "string") {
        throw changedShape(what, listUrl, `job ${offset + i} has no externalPath or title`);
      }
      hits.push({
        externalPath: p.externalPath,
        locationsText: text(p.locationsText),
        postedOn: text(p.postedOn),
        remoteType: text(p.remoteType),
      });
    }
    if (page.jobPostings.length === 0) break;
    offset += PAGE;
  } while (offset < total);
  return hits;
}

/** Every JSON-LD object on a page, flattening arrays and @graph. */
function jsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  for (const [, body] of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? "");
    } catch {
      continue;
    }
    const stack = [parsed];
    while (stack.length > 0) {
      const v = stack.pop();
      if (Array.isArray(v)) stack.push(...v);
      else if (isObject(v)) {
        out.push(v);
        if (Array.isArray(v["@graph"])) stack.push(...v["@graph"]);
      }
    }
  }
  return out;
}

function isJobPosting(v: unknown): v is Record<string, unknown> {
  if (!isObject(v)) return false;
  const type = v["@type"];
  return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
}

/** "USA, OH, Mason" from each jobLocation's address; several joined with "; ". */
function location(v: unknown): string | null {
  const places = Array.isArray(v) ? v : [v];
  const names = places.flatMap((place) => {
    const address = isObject(place) ? place.address : undefined;
    if (typeof address === "string") return text(address) ?? [];
    if (!isObject(address)) return [];
    return text(address.addressLocality) ?? text(address.addressCountry) ?? [];
  });
  return names.length > 0 ? [...new Set(names)].join("; ") : null;
}

function identifier(v: unknown): string | null {
  if (typeof v === "string" || typeof v === "number") return text(String(v));
  if (isObject(v) && (typeof v.value === "string" || typeof v.value === "number")) {
    return text(String(v.value));
  }
  return null;
}

async function readJob(base: string, site: string, hit: Hit, what: string): Promise<JobPosting> {
  const url = `${base}/${site}${hit.externalPath}`;
  const page = jsonLd(await fetchBoard(url, what)).find(isJobPosting);
  if (page === undefined) throw changedShape(what, url, "the job page has no JSON-LD JobPosting");
  const title = text(page.title);
  const id = identifier(page.identifier);
  if (title === null || id === null) {
    throw changedShape(what, url, "the JSON-LD JobPosting has no title or identifier");
  }
  const org = page.hiringOrganization;
  return {
    source_job_id: id,
    title,
    location: location(page.jobLocation),
    url,
    description: typeof page.description === "string" ? htmlToText(page.description) : "",
    departments: [],
    employment_type: Array.isArray(page.employmentType)
      ? page.employmentType.filter((t) => typeof t === "string").join(", ") || null
      : text(page.employmentType),
    salary: null,
    posted_at: utc(page.datePosted),
    deadline: utc(page.validThrough),
    source_fields: {
      hiring_organization: isObject(org) ? text(org.name) : text(org),
      external_path: hit.externalPath,
      locations_text: hit.locationsText,
      posted_on: hit.postedOn,
      remote_type: hit.remoteType,
      job_location_type: text(page.jobLocationType),
    },
  };
}

/** Map with at most `limit` calls in flight, keeping order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const workday: BoardReader = {
  async read(board, context) {
    const { tenant, instance, site } = workdayBoard(board);
    const base = `https://${tenant}.${instance}.myworkdayjobs.com`;
    const listUrl = `${base}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`;
    const what = `The Workday board "${tenant}/${site}"`;

    // One search per target role; with none, the whole board.
    const roles = [...new Set(context.target_roles.map((r) => r.trim()).filter((r) => r))];
    const hits = new Map<string, Hit>();
    for (const role of roles.length > 0 ? roles : [""]) {
      for (const hit of await search(listUrl, what, role)) {
        if (!hits.has(hit.externalPath)) hits.set(hit.externalPath, hit);
      }
    }

    const postings = await mapLimited([...hits.values()], CONCURRENCY, (hit) =>
      readJob(base, encodeURIComponent(site), hit, what),
    );
    // Two postings of one requisition share its JSON-LD identifier: keep the first.
    const byId = new Map<string, JobPosting>();
    for (const p of postings) if (!byId.has(p.source_job_id)) byId.set(p.source_job_id, p);
    return [...byId.values()];
  },
};
