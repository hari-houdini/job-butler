// Ashby Public Job Posting API (no key): https://developers.ashbyhq.com/docs/public-job-posting-api
//   GET https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true
// The board name is case-sensitive. `publishedAt` resets on republish, so Screen's age also
// reads Job Butler's own first Sighting. Pay is needed for the missing-salary ghost signal
// and the Sponsorship pay check, hence includeCompensation.
import { htmlToText } from "../html-text.ts";
import { isObject } from "../validate.ts";
import {
  type Board,
  type BoardReader,
  changedShape,
  fetchBoardJson,
  type JobPosting,
  utc,
} from "./reader.ts";

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** The salary as the posting shows it, or null when the board hides or has none. */
function salary(job: Record<string, unknown>): string | null {
  if (job.shouldDisplayCompensationOnJobPostings === false) return null;
  const c = isObject(job.compensation) ? job.compensation : {};
  return text(c.scrapeableCompensationSalarySummary);
}

export const ashby: BoardReader = {
  async read(board: Board) {
    if (board.ats !== "ashby") throw new Error(`not an Ashby board: ${board.ats}`);
    const name = board.token;
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(name)}?includeCompensation=true`;
    const what = `The Ashby board "${name}"`;
    const body = await fetchBoardJson(url, what);
    if (!isObject(body) || !Array.isArray(body.jobs)) throw changedShape(what, url, "no jobs list");
    return body.jobs.map((job, i): JobPosting => {
      if (!isObject(job) || typeof job.id !== "string" || typeof job.title !== "string") {
        throw changedShape(what, url, `job ${i} has no id or title`);
      }
      const department = text(job.department);
      const secondary = Array.isArray(job.secondaryLocations)
        ? job.secondaryLocations.flatMap((l) =>
            isObject(l) && text(l.location) ? [text(l.location)] : [],
          )
        : [];
      const c = isObject(job.compensation) ? job.compensation : {};
      return {
        source_job_id: job.id,
        title: job.title.trim(),
        location: text(job.location),
        url:
          typeof job.jobUrl === "string"
            ? job.jobUrl
            : `https://jobs.ashbyhq.com/${name}/${job.id}`,
        description:
          typeof job.descriptionHtml === "string"
            ? htmlToText(job.descriptionHtml)
            : (text(job.descriptionPlain) ?? ""),
        departments: department === null ? [] : [department],
        employment_type: text(job.employmentType),
        salary: salary(job),
        posted_at: utc(job.publishedAt),
        deadline: null,
        source_fields: {
          team: text(job.team),
          is_listed: bool(job.isListed),
          is_remote: bool(job.isRemote),
          workplace_type: text(job.workplaceType),
          secondary_locations: secondary.join("; ") || null,
          compensation_summary: text(c.compensationTierSummary),
          apply_url: text(job.applyUrl),
        },
      };
    });
  },
};
