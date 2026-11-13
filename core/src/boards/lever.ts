// Lever Postings API (public, no key): https://github.com/lever/postings-api
//   GET https://api.lever.co/v0/postings/{site}?mode=json   (EU: api.eu.lever.co)
// The response is a bare array. `createdAt` (epoch ms) is undocumented but present; Screen's
// age still takes the earlier of it and Job Butler's own first Sighting.
import { htmlToText } from "../html-text.ts";
import { isObject } from "../validate.ts";
import {
  type Board,
  type BoardReader,
  changedShape,
  fetchBoardJson,
  type JobPosting,
} from "./reader.ts";

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function epochMs(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : null;
}

/** The full posting as HTML: opening and body, each list under its heading, then the closing. */
function descriptionHtml(job: Record<string, unknown>): string {
  const parts = [typeof job.description === "string" ? job.description : ""];
  if (Array.isArray(job.lists)) {
    for (const l of job.lists) {
      if (!isObject(l)) continue;
      parts.push(`<h3>${typeof l.text === "string" ? l.text : ""}</h3>`);
      parts.push(`<ul>${typeof l.content === "string" ? l.content : ""}</ul>`);
    }
  }
  if (typeof job.additional === "string") parts.push(`<div>${job.additional}</div>`);
  return parts.join("\n");
}

interface SalaryRange {
  min: number | null;
  max: number | null;
  currency: string | null;
  interval: string | null;
}

function salaryRange(v: unknown): SalaryRange {
  const r = isObject(v) ? v : {};
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);
  return {
    min: num(r.min),
    max: num(r.max),
    currency: text(r.currency),
    interval: text(r.interval),
  };
}

/** "USD 85,000–175,000 per year" from Lever's range; its own salaryDescription wins. */
function salaryText(job: Record<string, unknown>, r: SalaryRange): string | null {
  const stated = text(job.salaryDescriptionPlain) ?? text(job.salaryDescription);
  if (stated !== null) return htmlToText(stated);
  if (r.min === null && r.max === null) return null;
  const n = (x: number) => x.toLocaleString("en-US");
  const amount =
    r.min !== null && r.max !== null && r.min !== r.max
      ? `${n(r.min)}–${n(r.max)}`
      : n((r.min ?? r.max) as number);
  const per = r.interval?.replace(/-(salary|wage)$/, "").replace(/-/g, " ");
  return [r.currency, amount, per].filter((x) => x).join(" ");
}

export const lever: BoardReader = {
  async read(board: Board) {
    if (board.ats !== "lever") throw new Error(`not a Lever board: ${board.ats}`);
    const host = board.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
    const url = `https://${host}/v0/postings/${encodeURIComponent(board.token)}?mode=json`;
    const what = `The Lever board "${board.token}"`;
    const body = await fetchBoardJson(url, what);
    if (!Array.isArray(body)) throw changedShape(what, url, "no postings list");
    return body.map((job, i): JobPosting => {
      if (!isObject(job) || typeof job.id !== "string" || typeof job.text !== "string") {
        throw changedShape(what, url, `posting ${i} has no id or text`);
      }
      const c = isObject(job.categories) ? job.categories : {};
      const department = text(c.department);
      const all = Array.isArray(c.allLocations) ? c.allLocations.filter((l) => text(l)) : [];
      const r = salaryRange(job.salaryRange);
      return {
        source_job_id: job.id,
        title: job.text.trim(),
        location: text(c.location),
        url:
          typeof job.hostedUrl === "string"
            ? job.hostedUrl
            : `https://jobs.lever.co/${board.token}/${job.id}`,
        description: htmlToText(descriptionHtml(job)),
        departments: department === null ? [] : [department],
        employment_type: text(c.commitment),
        salary: salaryText(job, r),
        posted_at: epochMs(job.createdAt),
        deadline: null,
        source_fields: {
          team: text(c.team),
          country: text(job.country),
          workplace_type: text(job.workplaceType),
          all_locations: all.join("; ") || null,
          apply_url: text(job.applyUrl),
          salary_min: r.min,
          salary_max: r.max,
          salary_currency: r.currency,
          salary_interval: r.interval,
        },
      };
    });
  },
};
