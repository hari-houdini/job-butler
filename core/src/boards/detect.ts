// Board detection for setup: find which ATS board a Target company's career page uses, so the
// job seeker confirms a board instead of typing a token. A URL that is itself a board link is
// read without fetching; otherwise the page is fetched once and every ATS link in it (hrefs,
// script sources, preloads, and URLs inside inline JSON) is collected. Nothing is written:
// setup stores the board the job seeker confirms on the Target company.
import { CoreError } from "../errors.ts";
import { decodeEntities } from "../html-text.ts";
import { httpGet } from "../net.ts";
import { boardId } from "./index.ts";
import type { Board } from "./reader.ts";

export interface DetectedBoard {
  ats: Board["ats"];
  /** In the Profile's `board` shape, ready to store on the Target company. */
  board: Board;
  board_id: string;
  /** Distinct links to this board found. */
  links: number;
  /** Up to three of those links, so the job seeker can see where the board came from. */
  evidence: string[];
}

export interface Detection {
  url: string;
  /** The page read after redirects; null when the URL was itself a board link. */
  page_url: string | null;
  fetched: boolean;
  /** Most-linked first. Empty when no board was found: the job seeker enters it by hand. */
  boards: DetectedBoard[];
}

const WORKDAY_HOST = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i;
const LOCALE = /^[a-z]{2}(-[a-z]{2,4})?$/i;

function segments(u: URL): string[] {
  return u.pathname
    .split("/")
    .filter((s) => s !== "")
    .map((s) => decodeURIComponent(s));
}

/** The board a URL belongs to, or null when it isn't a job-board link. */
export function boardFromUrl(raw: string): Board | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const s = segments(u);
  const after = (...prefix: string[]) =>
    prefix.every((p, i) => s[i] === p) && s[prefix.length] ? (s[prefix.length] as string) : null;

  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") {
    const token = s[0] === "embed" ? u.searchParams.get("for") : (s[0] ?? null);
    return token ? { ats: "greenhouse", token } : null;
  }
  if (host === "boards-api.greenhouse.io" || host === "api.greenhouse.io") {
    const token = after("v1", "boards");
    return token ? { ats: "greenhouse", token } : null;
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    if (!s[0]) return null;
    return host === "jobs.eu.lever.co"
      ? { ats: "lever", token: s[0], region: "eu" }
      : { ats: "lever", token: s[0] };
  }
  if (host === "api.lever.co" || host === "api.eu.lever.co") {
    const token = after("v0", "postings");
    if (!token) return null;
    return host === "api.eu.lever.co"
      ? { ats: "lever", token, region: "eu" }
      : { ats: "lever", token };
  }
  if (host === "jobs.ashbyhq.com") {
    return s[0] && s[0] !== "api" ? { ats: "ashby", token: s[0] } : null;
  }
  if (host === "api.ashbyhq.com") {
    const token = after("posting-api", "job-board");
    return token ? { ats: "ashby", token } : null;
  }
  const wd = WORKDAY_HOST.exec(host);
  if (wd) {
    const [, tenant, instance] = wd as unknown as [string, string, string];
    if (s[0] === "wday" && s[1] === "cxs") {
      return s[3] ? { ats: "workday", tenant: s[2] ?? tenant, instance, site: s[3] } : null;
    }
    const site = s[0] !== undefined && LOCALE.test(s[0]) ? s[1] : s[0];
    return site ? { ats: "workday", tenant, instance, site } : null;
  }
  return null;
}

/** Every URL in a page, with HTML entities and JSON escapes (`\/`, `/`) undone. */
function urlsIn(html: string): string[] {
  const text = decodeEntities(html)
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/");
  const found = text.match(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>\\`]*)?/gi) ?? [];
  return found.map((u) => (u.startsWith("//") ? `https:${u}` : u).replace(/[.,;:)\]}]+$/, ""));
}

/** The boards linked from a page, most-linked first. */
export function boardsInPage(html: string): DetectedBoard[] {
  const byId = new Map<string, { board: Board; urls: string[] }>();
  for (const url of urlsIn(html)) {
    const board = boardFromUrl(url);
    if (board === null) continue;
    const id = boardId(board);
    const entry = byId.get(id) ?? { board, urls: [] };
    if (!entry.urls.includes(url)) entry.urls.push(url);
    byId.set(id, entry);
  }
  return [...byId.entries()]
    .map(([id, { board, urls }]) => ({
      ats: board.ats,
      board,
      board_id: id,
      links: urls.length,
      evidence: urls.slice(0, 3),
    }))
    .sort((a, b) => b.links - a.links);
}

function single(url: string, board: Board): DetectedBoard {
  return { ats: board.ats, board, board_id: boardId(board), links: 1, evidence: [url] };
}

export async function detectBoard(url: string): Promise<Detection> {
  const direct = boardFromUrl(url);
  if (direct !== null) {
    return { url, page_url: null, fetched: false, boards: [single(url, direct)] };
  }
  const manual =
    "Open the company's job listings in a browser and give the board URL instead " +
    "(e.g. jobs.lever.co/<company>), or enter the board by hand.";
  let res: Awaited<ReturnType<typeof httpGet>>;
  try {
    res = await httpGet(url);
  } catch (e) {
    if (e instanceof CoreError && e.code === "NETWORK_ERROR") {
      throw new CoreError("CAREERS_PAGE_UNAVAILABLE", `${e.message}. ${manual}`);
    }
    throw e;
  }
  if (res.status < 200 || res.status > 299) {
    throw new CoreError(
      "CAREERS_PAGE_UNAVAILABLE",
      `The career page ${url} couldn't be read (HTTP ${res.status}). ${manual}`,
      { status: res.status },
    );
  }
  const redirected = res.url !== url ? boardFromUrl(res.url) : null;
  const boards = redirected !== null ? [single(res.url, redirected)] : boardsInPage(res.body);
  return { url, page_url: res.url, fetched: true, boards };
}
