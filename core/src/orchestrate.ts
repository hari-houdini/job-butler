// The orchestrator's core side (#52): the "what needs you" digest, reply routing, the
// notification verdict and the opt-in schedule's run-time checks. The skill calls these; it
// never decides by itself whether a notification is due or a scheduled turn runs.
// See docs/agents/core-conventions.md, "Orchestrator run and schedule".
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { now, timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";
import { startRun } from "./lock.ts";
import { loadPreferences } from "./preferences.ts";
import { rankShortlist, REPLIES as SCREEN_REPLIES, digest as screenDigest } from "./screen.ts";
import { listRecords, writeThenReplace } from "./store.ts";
import { REPLIES as TRACK_REPLIES, trackDigest } from "./track.ts";

type Reply = { reply: string; does: string };

/** Every reply the combined digest takes: the Screen and Track ones, then the extras. */
export const REPLIES: Reply[] = (() => {
  const all: Reply[] = [
    ...SCREEN_REPLIES,
    ...TRACK_REPLIES,
    { reply: "alerts", does: "take in LinkedIn job-alert emails" },
  ];
  const seen = new Set<string>();
  return all.filter((r) => !seen.has(r.reply) && seen.add(r.reply));
})();

export const SKIPPED_LINE = "skipped: another session was writing";

// ---------------------------------------------------------------------------------------
// digest

interface Counts {
  status_changes: number;
  external_offers: number;
  unmatched: number;
  shortlist: number;
  ready_to_apply: number;
  paused: number;
  failed_sources: number;
}

export async function pipelineDigest(dataDir: string) {
  const track = await trackDigest(dataDir);
  const screen = await screenDigest(dataDir);
  const apps = await listRecords(dataDir, "application");
  const ready = apps
    .filter((a) => a.status === "ready_to_apply")
    .map((a) => ({ id: a.id, company: String(a.company), title: String(a.title) }));
  const paused = apps
    .filter((a) => a.status === "paused")
    .map((a) => {
      const pause = a.pause as { reason?: string } | null | undefined;
      return {
        id: a.id,
        company: String(a.company),
        title: String(a.title),
        reason: pause?.reason ?? "Apply paused this form.",
      };
    });
  const runs = (await listRecords(dataDir, "discover-run")).sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at)),
  );
  const last = runs.at(-1);
  const sources =
    (last?.sources as { company: string; status: string; error: { message: string } | null }[]) ??
    [];
  const failed = sources
    .filter((s) => s.status === "failed")
    .map((s) => ({ company: s.company, message: s.error?.message ?? "The board failed." }));

  const counts: Counts = {
    status_changes: track.proposals.length,
    external_offers: track.external_offers.length,
    unmatched: track.unmatched,
    shortlist: screen.shortlist.length,
    ready_to_apply: ready.length,
    paused: paused.length,
    failed_sources: failed.length,
  };

  const lines = ["WHAT NEEDS YOU", "", track.text, "", screen.text, ""];
  lines.push(
    ready.length > 0
      ? `READY TO APPLY (${ready.length})  tailored and planned; Apply fills the form, you click Submit`
      : "READY TO APPLY (0)",
  );
  for (const a of ready) lines.push(`  ${a.id}: ${a.company} · ${a.title}`);
  if (paused.length > 0) {
    lines.push(`PAUSED FORMS (${paused.length})  Apply needs an answer from you`);
    for (const a of paused) lines.push(`  ${a.id}: ${a.company} · ${a.title}: ${a.reason}`);
  }
  if (failed.length > 0) {
    lines.push(`FAILED SOURCES (${failed.length})  not searched in the last Discover run`);
    for (const f of failed) lines.push(`  ${f.company}: ${f.message}`);
  }
  lines.push(`Reply: ${REPLIES.map((r) => r.reply).join(" · ")}`);
  return {
    track: { proposals: track.proposals, external_offers: track.external_offers },
    shortlist: screen.shortlist,
    ready_to_apply: ready,
    paused,
    failed_sources: failed,
    counts,
    text: lines.join("\n"),
    replies: REPLIES,
  };
}

// ---------------------------------------------------------------------------------------
// reply routing

export interface Route {
  recognised: boolean;
  reply: string | null;
  /** Core commands to run, in order, each as its own Bash call. */
  commands: string[][];
  /** The Checkpoint whose Approval must be recorded first; null for a plain command. */
  checkpoint: "shortlist-pick" | "digest-status" | null;
  /** For a reply the core can't run itself: where it goes. */
  skill: string | null;
  message?: string;
}

const NO_ROUTE: Route = {
  recognised: false,
  reply: null,
  commands: [],
  checkpoint: null,
  skill: null,
};

function numbers(rest: string): number[] {
  return rest
    .split(/[\s,]+/)
    .filter((x) => x !== "")
    .map(Number);
}

/** Turn one job seeker reply into the core commands it means. Writes nothing. */
export async function routeReply(dataDir: string, text: string): Promise<Route> {
  const line = text.trim();
  const [word = "", ...restWords] = line.split(/\s+/);
  const rest = restWords.join(" ");
  const route = (r: Partial<Route>): Route => ({
    ...NO_ROUTE,
    recognised: true,
    reply: word,
    ...r,
  });
  switch (word.toLowerCase()) {
    case "why":
      return route({ commands: [["screen", "why", ...restWords]] });
    case "show":
      if (rest.toLowerCase() === "excluded") {
        return route({ reply: "show excluded", commands: [["show", "excluded"]] });
      }
      break;
    case "restore":
      return route({ commands: [["restore", ...restWords]] });
    case "help":
      return route({ message: "These replies work.", commands: [] });
    case "pick": {
      const letters = rest.split(/[\s,]+/).filter((x) => x !== "");
      const shortlist = await rankShortlist(dataDir);
      const ids = letters.map((l) => shortlist.find((s) => s.letter === l)?.id);
      if (letters.length === 0 || ids.includes(undefined)) {
        return route({ message: "Pick letters from the current Shortlist, e.g. pick a, b." });
      }
      return route({
        checkpoint: "shortlist-pick",
        commands: [["application", "pick", ...(ids as string[])]],
      });
    }
    case "approve": {
      const wanted = numbers(rest);
      const sync = await trackDigest(dataDir);
      const commands: string[][] = [];
      for (const n of wanted) {
        const p = sync.proposals.find((x) => x.n === n);
        const o = sync.external_offers.find((x) => x.n === n);
        if (p) commands.push(["application", "status", p.application_id, p.to, String(n)]);
        else if (o) commands.push(["application", "external", String(n)]);
        else return route({ message: `There's no item ${n} to approve.` });
      }
      if (commands.length === 0) return route({ message: "Say which numbers, e.g. approve 1, 3." });
      return route({ checkpoint: "digest-status", commands });
    }
    case "dismiss":
      return route({ commands: [["track", "dismiss", ...numbers(rest).map(String)]] });
    case "dismiss-mail":
      return route({ commands: [["track", "dismiss-mail", ...restWords]] });
    case "assign":
      return route({ commands: [["track", "assign", ...restWords]] });
    case "link":
      return route({ commands: [["application", "link-external", ...restWords]] });
    case "alerts":
      return route({ skill: "discover" });
  }
  return { ...NO_ROUTE, message: `"${line}" isn't one of the replies.` };
}

// ---------------------------------------------------------------------------------------
// notification verdict

export async function notifyVerdict(dataDir: string) {
  const prefs = await loadPreferences(dataDir);
  const d = await pipelineDigest(dataDir);
  const c = d.counts;
  const needs: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) needs.push(`${n} ${n === 1 ? one : many}`);
  };
  add(
    c.status_changes + c.external_offers,
    "status change to approve",
    "status changes to approve",
  );
  add(c.unmatched, "unmatched email", "unmatched emails");
  add(c.shortlist, "Listing on your Shortlist", "Listings on your Shortlist");
  add(c.ready_to_apply, "application ready to apply", "applications ready to apply");
  add(c.paused, "paused form", "paused forms");
  add(c.failed_sources, "failed source", "failed sources");
  if (needs.length === 0) {
    return { notify: false, reason: "nothing needs the job seeker", title: null, message: null };
  }
  if (!prefs.notifications.desktop) {
    return {
      notify: false,
      reason: "desktop notifications are off in Preferences",
      title: null,
      message: null,
    };
  }
  return {
    notify: true,
    reason: "something needs the job seeker",
    title: "Job Butler needs you",
    message: needs.join(", "),
  };
}

// ---------------------------------------------------------------------------------------
// schedule

const STATE_FILE = "schedule-state.json";
const LOG_FILE = "schedule.log";
const SLACK_MS = 5 * 60_000;

interface ScheduleState {
  track_at?: string;
  discover_screen_at?: string;
}

async function readState(dataDir: string): Promise<ScheduleState> {
  try {
    return JSON.parse(await readFile(join(dataDir, STATE_FILE), "utf8"));
  } catch {
    return {};
  }
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const localMinutes = (d: Date) => d.getHours() * 60 + d.getMinutes();
const localDay = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * One turn of the schedule, called by the `/loop` prompt. Decides which tasks are due (local
 * time, Preferences), takes the run lock, and records that they started. A held lock skips the
 * turn and logs it. Never crosses a Checkpoint: it only decides and locks.
 */
export async function scheduleTick(dataDir: string) {
  const prefs = await loadPreferences(dataDir);
  const s = prefs.schedule;
  if (!s.enabled) return { action: "off", tasks: [] as string[] };
  const at = now();
  const state = await readState(dataDir);
  const due: string[] = [];
  const mins = localMinutes(at);
  const lastTrack = state.track_at ? new Date(state.track_at).getTime() : undefined;
  if (
    mins >= minutes(s.track.from) &&
    mins <= minutes(s.track.until) &&
    (lastTrack === undefined ||
      at.getTime() - lastTrack >= s.track.every_hours * 3_600_000 - SLACK_MS)
  ) {
    due.push("track");
  }
  const lastDs = state.discover_screen_at ? new Date(state.discover_screen_at) : undefined;
  if (
    mins >= minutes(s.discover_screen.at) &&
    (lastDs === undefined || localDay(lastDs) !== localDay(at))
  ) {
    due.push("discover-screen");
  }
  if (due.length === 0) return { action: "idle", tasks: [] as string[] };
  try {
    const { run, joined } = await startRun(dataDir, "pipeline");
    const next = { ...state };
    if (due.includes("track")) next.track_at = timestamp();
    if (due.includes("discover-screen")) next.discover_screen_at = timestamp();
    await writeThenReplace(join(dataDir, STATE_FILE), JSON.stringify(next));
    return { action: "run", tasks: due, run_id: run.run_id, joined };
  } catch (e) {
    if (!(e instanceof CoreError) || e.code !== "LOCKED") throw e;
    const log = `${timestamp()} ${SKIPPED_LINE}`;
    await appendFile(join(dataDir, LOG_FILE), `${log}\n`);
    return { action: "skipped", tasks: [] as string[], log: SKIPPED_LINE };
  }
}
