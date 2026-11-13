// Greenhouse Job Board API (public, no key): https://docs.greenhouse.io/job-board.html
//   GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
// `content` is entity-encoded HTML. `internal_job_id: null` marks a prospect post (Screen's
// ghost check reads it from source_fields).
import { decodeEntities, htmlToText } from "../html-text.ts";
import { isObject } from "../validate.ts";
import {
  type Board,
  type BoardReader,
  changedShape,
  fetchBoardJson,
  type JobPosting,
  utc,
} from "./reader.ts";

function token(board: Board): string {
  if (board.ats !== "greenhouse") throw new Error(`not a Greenhouse board: ${board.ats}`);
  return board.token;
}

function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d) => (isObject(d) && typeof d.name === "string" ? [d.name.trim()] : []));
}

function scalar(v: unknown): string | number | boolean | null {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
}

export const greenhouse: BoardReader = {
  async read(board) {
    const t = token(board);
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=true`;
    const what = `The Greenhouse board "${t}"`;
    const body = await fetchBoardJson(url, what);
    if (!isObject(body) || !Array.isArray(body.jobs)) {
      throw changedShape(what, url, "no jobs list");
    }
    return body.jobs.map((job, i): JobPosting => {
      if (!isObject(job) || typeof job.id !== "number" || typeof job.title !== "string") {
        throw changedShape(what, url, `job ${i} has no id or title`);
      }
      const location = isObject(job.location) ? job.location.name : undefined;
      return {
        source_job_id: String(job.id),
        title: job.title.trim(),
        location: typeof location === "string" && location.trim() !== "" ? location.trim() : null,
        url:
          typeof job.absolute_url === "string"
            ? job.absolute_url
            : `https://job-boards.greenhouse.io/${t}/jobs/${job.id}`,
        description: typeof job.content === "string" ? htmlToText(decodeEntities(job.content)) : "",
        departments: names(job.departments),
        employment_type: null,
        salary: null,
        posted_at: utc(job.first_published),
        deadline: utc(job.application_deadline),
        source_fields: {
          internal_job_id: scalar(job.internal_job_id),
          requisition_id: scalar(job.requisition_id),
          updated_at: scalar(job.updated_at),
          offices: names(job.offices).join("; ") || null,
        },
      };
    });
  },
};
