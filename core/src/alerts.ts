// LinkedIn job-alert emails (#51). The alert worker reads the mail through the read-only Gmail
// tools and returns JSON; the core never calls Gmail. Each job in an alert becomes a LinkedIn
// Listing through the same intake as a pasted job (`addLinkedInJobs`, intake "alert"), so it is
// matched to the employer's ATS posting the same way. Processed alert message IDs go into the
// Track Sync record's `processed_ids`, the one dedupe store, so no alert is read twice.
//
//   linkedin alerts window   -> the Gmail query to read and the IDs already processed
//   linkedin alerts record   -> dedupe, add the jobs as Listings, record the messages
// See docs/agents/core-conventions.md, "LinkedIn job-alert emails (set by #51)".
import { join } from "node:path";
import { addLinkedInJobs, type LinkedInJob, linkedInIdentity } from "./linkedin.ts";
import { now, timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";
import { withWriter } from "./store.ts";
import {
  CONNECTOR,
  DAY_MS,
  FIRST_SYNC_DAYS,
  gmailDate,
  OVERLAP_DAYS,
  readSync,
  syncFields,
} from "./track.ts";
import { isObject, type Problems } from "./validate.ts";

/** LinkedIn sends job alerts from this address. */
export const ALERT_SENDER = "jobalerts-noreply@linkedin.com";

/** One alert email as the alert worker returns it. */
export interface Alert {
  message_id: string;
  thread_id: string;
  received_at: string;
  from?: string;
  subject?: string;
  jobs: { company: string; title: string; location: string | null; url: string | null }[];
}

export async function alertsWindow(dataDir: string) {
  const sync = await readSync(dataDir);
  const last = sync?.alerts_synced_at ? Date.parse(sync.alerts_synced_at) : undefined;
  const from =
    last !== undefined ? last - OVERLAP_DAYS * DAY_MS : now().getTime() - FIRST_SYNC_DAYS * DAY_MS;
  const after = gmailDate(from);
  return {
    connector: CONNECTOR,
    alerts_synced_at: sync?.alerts_synced_at ?? null,
    after,
    query: `after:${after} from:${ALERT_SENDER}`,
    processed_ids: sync?.processed_ids ?? [],
  };
}

function parseAlerts(input: unknown): Alert[] {
  const list = isObject(input) ? input.alerts : undefined;
  if (!Array.isArray(list)) {
    throw new CoreError(
      "ALERT_INVALID",
      'The alert worker\'s reply isn\'t {"alerts": [...]}, so nothing was recorded. Run the worker again.',
    );
  }
  const problems: Problems = [];
  const text = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const maybe = (v: unknown) => v === undefined || v === null || typeof v === "string";
  const alerts = list.map((a, i) => {
    const at = `alerts[${i}]`;
    if (!isObject(a)) {
      problems.push(`${at} must be an object`);
      return undefined;
    }
    for (const k of ["message_id", "thread_id", "received_at"]) {
      if (!text(a[k])) problems.push(`${at}.${k} must be non-empty text`);
    }
    if (!Array.isArray(a.jobs)) problems.push(`${at}.jobs must be a list`);
    else {
      a.jobs.forEach((j, n) => {
        if (!isObject(j) || !text(j.company) || !text(j.title)) {
          problems.push(`${at}.jobs[${n}] needs a company and a title`);
        } else if (!maybe(j.location) || !maybe(j.url)) {
          problems.push(`${at}.jobs[${n}]'s location and url must be text or null`);
        }
      });
    }
    return a as unknown as Alert;
  });
  if (problems.length > 0) {
    throw new CoreError(
      "ALERT_INVALID",
      `The alert worker's reply isn't usable, so nothing was recorded: ${problems.join("; ")}.`,
      { problems },
    );
  }
  return alerts as Alert[];
}

export async function recordAlerts(dataDir: string, input: unknown) {
  const alerts = parseAlerts(input);
  const sync = await readSync(dataDir);
  const seen = new Set([
    ...(sync?.processed_ids ?? []),
    ...(sync?.dismissed_ids ?? []),
  ]);
  const fresh: Alert[] = [];
  for (const a of alerts) {
    if (seen.has(a.message_id)) continue;
    seen.add(a.message_id);
    fresh.push(a);
  }

  // One LinkedIn job listed in several alerts is one job.
  const jobs = new Map<string, LinkedInJob>();
  for (const a of fresh) {
    for (const j of a.jobs) {
      const job: LinkedInJob = {
        company: j.company.trim(),
        title: j.title.trim(),
        location: j.location?.trim() || null,
        url: j.url?.trim() || null,
        description: "",
        intake: "alert",
      };
      const { id } = linkedInIdentity(job);
      if (!jobs.has(id)) jobs.set(id, job);
    }
  }

  // The Listings first: if the intake refuses, no alert is marked processed.
  const added =
    jobs.size > 0
      ? await addLinkedInJobs(dataDir, { jobs: [...jobs.values()] })
      : { discover_run: null, listings: [], linkedin_match: [], new_companies: [] };

  await withWriter(dataDir, "linkedin alerts record", async (w) => {
    const fields = syncFields(await readSync(dataDir));
    const processed = new Set(fields.processed_ids);
    for (const a of fresh) processed.add(a.message_id);
    await w.put("sync", CONNECTOR, {
      ...fields,
      processed_ids: [...processed],
      alerts_synced_at: timestamp(),
    });
  });
  return { alerts_new: fresh.length, alerts_skipped: alerts.length - fresh.length, ...added };
}
