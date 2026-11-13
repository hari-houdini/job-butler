// Track: read new mail through the read-only Gmail worker, match each message to an
// Application, and propose Status changes the job seeker approves in the digest.
// The core never calls Gmail or a model: the track worker's classifications come in through
// `track record --input`. Only the main session runs these commands.
//
//   track window            -> the Gmail date window to read, from the Sync record
//   track record            -> dedupe, match (the ladder), propose; write the Sync record
//   track propose           -> a proposal that isn't from mail (Withdrawn, No response)
//   track digest            -> the numbered proposals and the unmatched messages
//   track dismiss <n>...    -> drop proposals the job seeker doesn't want
//   application status      -> the digest-status Checkpoint command (see `approveStatus`)
// See docs/agents/core-conventions.md, "Track tracer (set by #48)".
import { join } from "node:path";
import { type EventLogEntry, STATUSES, type Status, statusLabel } from "./application.ts";
import { approvalUsedFor, normaliseAction } from "./approval.ts";
import { writeTrees } from "./decision-tree.ts";
import { atsPostingId } from "./dedupe.ts";
import { now, timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { getRecord, listRecords, type StoredRecord, withWriter } from "./store.ts";
import { isObject, type Problems } from "./validate.ts";

export const CONNECTOR = "gmail";
/** The first sync has no last-synced time: read this many days back. */
export const FIRST_SYNC_DAYS = 30;
/** `after:` is a midnight date, so each window starts a day early; the Sync record dedupes. */
export const OVERLAP_DAYS = 1;

/** Mail from these senders only hints that an ATS sent it. It never matches an Application. */
export const VENDOR_DOMAINS = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "ashbyhq.com",
  "myworkday.com",
  "calendly.com",
  "goodtime.io",
];

/** True when the sender's domain is a vendor domain or a subdomain of one. */
export function isVendorSender(from: string): boolean {
  const domain = from.toLowerCase().match(/@([a-z0-9.-]+)/)?.[1];
  if (domain === undefined) return false;
  return VENDOR_DOMAINS.some((v) => domain === v || domain.endsWith(`.${v}`));
}

export const CLASSIFICATIONS = [
  "acknowledgement",
  "rejection",
  "interview_invite",
  "offer",
  "other_job_mail",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** The Status a classification proposes, and the Statuses it may move from. */
const PRE_SUBMIT: Status[] = ["picked", "tailored", "ready_to_apply", "paused", "handover"];
const PROPOSES: Partial<Record<Classification, { to: Status; from: Status[] }>> = {
  acknowledgement: { to: "submitted", from: PRE_SUBMIT },
  rejection: {
    to: "rejected",
    from: [...PRE_SUBMIT, "submitted", "interview", "offer", "no_response"],
  },
  interview_invite: { to: "interview", from: [...PRE_SUBMIT, "submitted", "no_response"] },
  offer: { to: "offer", from: [...PRE_SUBMIT, "submitted", "interview", "no_response"] },
};
const REASON_LEAD: Record<Classification, string> = {
  acknowledgement: "Acknowledgement email",
  rejection: "Rejection email",
  interview_invite: "Interview invite",
  offer: "Offer email",
  other_job_mail: "Job email",
};
/** Proposals the job seeker or Track raises without a message. */
const MANUAL: Partial<Record<Status, Status[]>> = {
  withdrawn: [...PRE_SUBMIT, "submitted", "interview", "offer", "no_response"],
  no_response: ["submitted"],
};

// ---------------------------------------------------------------------------------------
// The Sync record

export interface Ats {
  job_url?: string;
  job_id?: string;
  board_slug?: string;
  workday_tenant?: string;
}

/** One message as the track worker classified it. */
export interface ClassifiedMessage {
  message_id: string;
  thread_id: string;
  from: string;
  subject: string;
  received_at: string;
  classification: Classification;
  ats?: Ats;
}

export interface MessageRef {
  id: string;
  thread_id: string;
  from: string;
  subject: string;
  received_at: string;
  classification: string;
  matched_by: string;
}

export interface Proposal {
  n: number;
  application_id: string;
  from: Status;
  to: Status;
  reason: string;
  /** "sure" when the ladder matched on the thread or an ATS ID. */
  confidence: "sure";
  message: MessageRef | null;
  state: "pending" | "approved" | "dismissed";
  proposed_at: string;
  decided_at: string | null;
}

export interface Unmatched {
  message: ClassifiedMessage;
  /** Application IDs the ladder left, when it found several. Empty when it found none. */
  candidates: string[];
  at: string;
}

export interface SyncFields {
  connector: string;
  last_synced_at: string | null;
  processed_ids: string[];
  dismissed_ids: string[];
  proposals: Proposal[];
  next_n: number;
  unmatched: Unmatched[];
  /** When the LinkedIn alert reader last ran (#51); Track's `last_synced_at` is not touched. */
  alerts_synced_at?: string | null;
}

export type SyncRecord = StoredRecord & SyncFields;

const EMPTY_SYNC = {
  connector: CONNECTOR,
  last_synced_at: null,
  processed_ids: [] as string[],
  dismissed_ids: [] as string[],
  proposals: [] as Proposal[],
  next_n: 1,
  unmatched: [] as Unmatched[],
};

export async function readSync(dataDir: string): Promise<SyncRecord | undefined> {
  return (await getRecord(dataDir, "sync", CONNECTOR)) as SyncRecord | undefined;
}

export function syncFields(s: SyncRecord | undefined): SyncFields {
  const {
    schema_version: _v,
    id: _i,
    created_at: _c,
    updated_at: _u,
    ...rest
  } = (s ?? EMPTY_SYNC) as SyncRecord;
  return rest as SyncFields;
}

export const DAY_MS = 86_400_000;

export function gmailDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replaceAll("-", "/");
}

export async function trackWindow(dataDir: string) {
  const sync = await readSync(dataDir);
  const last = sync?.last_synced_at ? Date.parse(sync.last_synced_at) : undefined;
  const from =
    last !== undefined ? last - OVERLAP_DAYS * DAY_MS : now().getTime() - FIRST_SYNC_DAYS * DAY_MS;
  const after = gmailDate(from);
  return {
    connector: CONNECTOR,
    last_synced_at: sync?.last_synced_at ?? null,
    after,
    query: `after:${after}`,
    processed_ids: sync?.processed_ids ?? [],
    inbox_file: join(dataDir, "inbox", "track-messages.json"),
  };
}

// ---------------------------------------------------------------------------------------
// The matching ladder (spec, "Track"). The first step to leave exactly one candidate wins.
// #49 adds steps 3 to 5 (learned domain, named sender, body) to LADDER; nothing else changes.

export interface LadderContext {
  /** Every Application, and for each the aliases of its Listing. */
  apps: { app: StoredRecord; aliases: AliasInfo[] }[];
}

interface AliasInfo {
  id: string;
  url: string | null;
  board: string | null;
  source_job_id: string | null;
}

export interface LadderStep {
  step: number;
  name: string;
  /** The Applications this step finds for the message; empty when it has no signal. */
  find(message: ClassifiedMessage, ctx: LadderContext): StoredRecord[];
}

const lower = (s: string | undefined | null): string => (s ?? "").trim().toLowerCase();

const byThread: LadderStep = {
  step: 1,
  name: "thread",
  find: (m, ctx) =>
    ctx.apps
      .filter(
        ({ app }) => Array.isArray(app.gmail_threads) && app.gmail_threads.includes(m.thread_id),
      )
      .map((x) => x.app),
};

function slugOf(a: AliasInfo): string {
  return lower(a.board?.split(":")[1] ?? a.id.split(":")[1]);
}

function tenantOf(a: AliasInfo): string {
  if (a.board?.startsWith("workday:")) return lower(a.board.split(":")[1]);
  if (a.id.startsWith("workday:")) return lower(a.id.split(":")[1]);
  try {
    const host = new URL(a.url ?? "").hostname;
    return host.endsWith(".myworkdayjobs.com") ? lower(host.split(".")[0]) : "";
  } catch {
    return "";
  }
}

/** A job URL or job ID narrows to the posting; a board slug or Workday tenant to the board. */
const byAtsId: LadderStep = {
  step: 2,
  name: "ATS ID",
  find(m, ctx) {
    const ats = m.ats;
    if (ats === undefined) return [];
    const urlId = atsPostingId(ats.job_url);
    const jobId = lower(ats.job_id);
    const slug = lower(ats.board_slug);
    const exact = ctx.apps.filter(({ aliases }) =>
      aliases.some((a) => {
        if (urlId !== null && (a.id === urlId || atsPostingId(a.url) === urlId)) return true;
        if (ats.job_url && a.url !== null && lower(a.url) === lower(ats.job_url)) return true;
        const ownId = lower(a.source_job_id ?? a.id.split(":").at(-1));
        return jobId !== "" && ownId === jobId && (slug === "" || slugOf(a) === slug);
      }),
    );
    if (exact.length > 0) return exact.map((x) => x.app);
    const board = (pick: (a: AliasInfo) => string, want: string) =>
      want === ""
        ? []
        : ctx.apps.filter(({ aliases }) => aliases.some((a) => pick(a) === want)).map((x) => x.app);
    const bySlug = board(slugOf, slug);
    return bySlug.length > 0 ? bySlug : board(tenantOf, lower(ats.workday_tenant));
  },
};

export const LADDER: LadderStep[] = [byThread, byAtsId];

export type Match =
  | { kind: "matched"; app: StoredRecord; step: LadderStep }
  | { kind: "ambiguous"; candidates: StoredRecord[] }
  | { kind: "unmatched" };

export function matchMessage(message: ClassifiedMessage, ctx: LadderContext): Match {
  let several: StoredRecord[] = [];
  for (const step of LADDER) {
    const found = [...new Map(step.find(message, ctx).map((a) => [a.id, a])).values()];
    if (found.length === 1) return { kind: "matched", app: found[0] as StoredRecord, step };
    if (found.length > 1 && several.length === 0) several = found;
  }
  return several.length > 0 ? { kind: "ambiguous", candidates: several } : { kind: "unmatched" };
}

async function ladderContext(dataDir: string): Promise<LadderContext> {
  const listings = new Map((await listRecords(dataDir, "listing")).map((l) => [l.id, l]));
  const apps = (await listRecords(dataDir, "application")).map((app) => {
    const listing = typeof app.listing === "string" ? listings.get(app.listing) : undefined;
    const aliases = ((listing?.aliases as Record<string, unknown>[] | undefined) ?? []).map(
      (a) => ({
        id: String(a.id),
        url: typeof a.url === "string" ? a.url : null,
        board: typeof a.board === "string" ? a.board : null,
        source_job_id: typeof a.source_job_id === "string" ? a.source_job_id : null,
      }),
    );
    return { app, aliases };
  });
  return { apps };
}

// ---------------------------------------------------------------------------------------
// track record

function parseMessages(input: unknown): ClassifiedMessage[] {
  const list = isObject(input) ? input.messages : undefined;
  if (!Array.isArray(list)) {
    throw usageError('track record: --input must be {"messages": [{"message_id", ...}, ...]}');
  }
  const problems: Problems = [];
  list.forEach((m, i) => {
    const at = `messages[${i}]`;
    if (!isObject(m)) {
      problems.push(`${at} must be an object`);
      return;
    }
    for (const key of ["message_id", "thread_id", "from", "subject", "received_at"]) {
      if (typeof m[key] !== "string" || m[key].trim() === "") {
        problems.push(`${at}.${key} must be non-empty text`);
      }
    }
    if (!CLASSIFICATIONS.includes(m.classification as Classification)) {
      problems.push(`${at}.classification must be one of: ${CLASSIFICATIONS.join(", ")}`);
    }
    if (m.ats !== undefined) {
      if (!isObject(m.ats)) {
        problems.push(`${at}.ats must be an object`);
        return;
      }
      for (const [k, v] of Object.entries(m.ats)) {
        if (!["job_url", "job_id", "board_slug", "workday_tenant"].includes(k)) {
          problems.push(`${at}.ats.${k} is not a known field`);
        } else if (v !== null && typeof v !== "string") {
          problems.push(`${at}.ats.${k} must be text`);
        }
      }
    }
  });
  if (problems.length > 0) {
    throw new CoreError(
      "CLASSIFICATION_INVALID",
      `The track worker's classifications aren't usable, so nothing was recorded: ${problems.join("; ")}.`,
      { problems },
    );
  }
  return list as ClassifiedMessage[];
}

export async function trackRecord(dataDir: string, input: unknown) {
  const messages = parseMessages(input);
  return withWriter(dataDir, "track record", async (w) => {
    const at = timestamp();
    const sync = await readSync(dataDir);
    const fields = syncFields(sync);
    const seen = new Set([...fields.processed_ids, ...fields.dismissed_ids]);
    const ctx = await ladderContext(dataDir);
    const proposals = [...fields.proposals];
    const unmatched = [...fields.unmatched];
    const processed = [...fields.processed_ids];
    let next = fields.next_n;
    const result = {
      new: 0,
      skipped_seen: 0,
      proposed: [] as number[],
      no_change: 0,
      unmatched: 0,
    };

    for (const message of messages) {
      if (seen.has(message.message_id)) {
        result.skipped_seen++;
        continue;
      }
      seen.add(message.message_id);
      processed.push(message.message_id);
      result.new++;
      const match = matchMessage(message, ctx);
      if (match.kind !== "matched") {
        result.unmatched++;
        const candidates = match.kind === "ambiguous" ? match.candidates.map((a) => a.id) : [];
        unmatched.push({ message, candidates, at });
        continue;
      }
      const rule = PROPOSES[message.classification];
      const current = match.app.status as Status;
      const alreadyPending = proposals.some(
        (p) => p.state === "pending" && p.application_id === match.app.id && p.to === rule?.to,
      );
      if (rule === undefined || !rule.from.includes(current) || alreadyPending) {
        result.no_change++;
        continue;
      }
      proposals.push({
        n: next,
        application_id: match.app.id,
        from: current,
        to: rule.to,
        reason: `${REASON_LEAD[message.classification]} from ${message.from}: "${message.subject}".`,
        confidence: "sure",
        message: {
          id: message.message_id,
          thread_id: message.thread_id,
          from: message.from,
          subject: message.subject,
          received_at: message.received_at,
          classification: message.classification,
          matched_by: `${match.step.name} (step ${match.step.step})`,
        },
        state: "pending",
        proposed_at: at,
        decided_at: null,
      });
      result.proposed.push(next++);
    }
    await w.put("sync", CONNECTOR, {
      ...fields,
      last_synced_at: at,
      processed_ids: processed,
      proposals,
      unmatched,
      next_n: next,
    });
    return { ...(await trackDigest(dataDir)), ...result };
  });
}

// ---------------------------------------------------------------------------------------
// track propose, dismiss, digest

export async function trackPropose(dataDir: string, args: string[], input: unknown) {
  const [appId, statusArg] = args;
  if (appId === undefined || statusArg === undefined) {
    throw usageError("track propose: <application-id> and <status> are required");
  }
  const to = statusArg as Status;
  const allowed = MANUAL[to];
  if (allowed === undefined) {
    throw usageError(
      `track propose: <status> must be one of: ${Object.keys(MANUAL).join(", ")} (mail proposes the rest)`,
    );
  }
  const reason = isObject(input) ? input.reason : undefined;
  if (typeof reason !== "string" || reason.trim() === "") {
    throw usageError('track propose: --input must be {"reason": "<why>"}');
  }
  return withWriter(dataDir, "track propose", async (w) => {
    const app = await getRecord(dataDir, "application", appId);
    if (app === undefined) {
      throw new CoreError("NOT_FOUND", `There's no Application "${appId}".`, {
        application_id: appId,
      });
    }
    const from = app.status as Status;
    if (!allowed.includes(from)) {
      throw new CoreError(
        "STATUS_NOT_ALLOWED",
        `${app.company} · ${app.title} is ${statusLabel(from)}, which can't move to ${statusLabel(to)}.`,
        { application_id: appId },
      );
    }
    const fields = syncFields(await readSync(dataDir));
    const n = fields.next_n;
    const at = timestamp();
    await w.put("sync", CONNECTOR, {
      ...fields,
      next_n: n + 1,
      proposals: [
        ...fields.proposals,
        {
          n,
          application_id: appId,
          from,
          to,
          reason: reason.trim(),
          confidence: "sure",
          message: null,
          state: "pending",
          proposed_at: at,
          decided_at: null,
        } satisfies Proposal,
      ],
    });
    return { proposed: [n], ...(await trackDigest(dataDir)) };
  });
}

export async function trackDismiss(dataDir: string, args: string[]) {
  const wanted = args.map((a) => Number(a));
  if (wanted.length === 0 || wanted.some((n) => !Number.isInteger(n))) {
    throw usageError("track dismiss: give proposal numbers, e.g. track dismiss 2 3");
  }
  return withWriter(dataDir, "track dismiss", async (w) => {
    const fields = syncFields(await readSync(dataDir));
    const at = timestamp();
    const dismissed = [...fields.dismissed_ids];
    const proposals = fields.proposals.map((p) => {
      if (!wanted.includes(p.n) || p.state !== "pending") return p;
      if (p.message) dismissed.push(p.message.id);
      return { ...p, state: "dismissed" as const, decided_at: at };
    });
    for (const n of wanted) {
      if (!proposals.some((p) => p.n === n && p.state === "dismissed")) {
        throw new CoreError("NOT_FOUND", `There's no pending proposal ${n} to dismiss.`, { n });
      }
    }
    await w.put("sync", CONNECTOR, { ...fields, proposals, dismissed_ids: dismissed });
    return { dismissed: wanted, ...(await trackDigest(dataDir)) };
  });
}

export const REPLIES = [
  { reply: "approve <n>[, <n>]", does: "approve those Status changes (asks for your Approval)" },
  { reply: "dismiss <n>", does: "drop a proposal and don't raise that message again" },
  { reply: "help", does: "list these replies" },
];

export async function trackDigest(dataDir: string) {
  const sync = await readSync(dataDir);
  const pending = (sync?.proposals ?? []).filter((p) => p.state === "pending");
  const apps = new Map((await listRecords(dataDir, "application")).map((a) => [a.id, a]));
  const lines = [
    pending.length > 0
      ? `STATUS CHANGES (${pending.length})  from your inbox`
      : "STATUS CHANGES (0)  nothing to approve right now",
  ];
  const items = pending.map((p) => {
    const app = apps.get(p.application_id);
    const name = app ? `${app.company} · ${app.title}` : p.application_id;
    lines.push(
      `  ${p.n}) ${name}: ${statusLabel(p.from)} → ${statusLabel(p.to)}  [${p.confidence}]`,
    );
    lines.push(`       ${p.reason}${p.message ? ` Matched by ${p.message.matched_by}.` : ""}`);
    return { ...p, application: name };
  });
  const unmatched = sync?.unmatched ?? [];
  if (unmatched.length > 0) {
    lines.push(`UNMATCHED (${unmatched.length})  job mail no Application claims yet`);
  }
  lines.push(`Reply: ${REPLIES.map((r) => r.reply).join(" · ")}`);
  return {
    proposals: items,
    unmatched: unmatched.length,
    text: lines.join("\n"),
    replies: REPLIES,
  };
}

// ---------------------------------------------------------------------------------------
// application status: the digest-status Checkpoint command

/**
 * `application status <application-id> <status> <n>`: apply proposal `n`. Runs only under
 * an Approval for this exact action (the hook spends it first). Writes the Event log entry
 * with the reason, the Approval and the matched message, and rewrites the Decision tree.
 */
export async function approveStatus(dataDir: string, args: string[]) {
  const [appId, statusArg, nArg] = args;
  if (appId === undefined || statusArg === undefined || nArg === undefined) {
    throw usageError("application status: <application-id> <status> <n> are required");
  }
  if (!(statusArg in STATUSES)) {
    throw usageError(`application status: unknown Status "${statusArg}"`);
  }
  const to = statusArg as Status;
  const n = Number(nArg);
  const action = normaliseAction(`application status ${args.join(" ")}`);
  const approval = await approvalUsedFor(dataDir, action);
  if (approval === undefined) {
    throw new CoreError(
      "APPROVAL_MISSING",
      `There's no digest-status Approval for "${action}", so no Status changed. Show the digest, ` +
        "record the job seeker's yes with `approval record digest-status`, then run it.",
      { action },
    );
  }
  return withWriter(dataDir, "application status", async (w) => {
    const sync = await readSync(dataDir);
    const fields = syncFields(sync);
    const proposal = fields.proposals.find(
      (p) => p.n === n && p.state === "pending" && p.application_id === appId && p.to === to,
    );
    if (proposal === undefined) {
      throw new CoreError(
        "NO_PROPOSAL",
        `Track has no pending proposal ${nArg} moving ${appId} to ${statusLabel(to)}, so no Status changed.`,
        { action },
      );
    }
    const app = await getRecord(dataDir, "application", appId);
    if (app === undefined) {
      throw new CoreError("NOT_FOUND", `There's no Application "${appId}".`, {
        application_id: appId,
      });
    }
    if (app.status !== proposal.from) {
      throw new CoreError(
        "STALE_PROPOSAL",
        `${app.company} · ${app.title} is now ${statusLabel(String(app.status))}, not ` +
          `${statusLabel(proposal.from)} as when this was proposed, so nothing changed.`,
        { application_id: appId },
      );
    }
    const at = timestamp();
    const entry: EventLogEntry = {
      at,
      stage: "track",
      from: proposal.from,
      to,
      reason: proposal.reason,
      approval: {
        id: approval.id,
        checkpoint: approval.checkpoint,
        approved_at: approval.approved_at,
        action,
      },
      ...(proposal.message ? { message: proposal.message } : {}),
    };
    const threads = (app.gmail_threads as string[] | undefined) ?? [];
    const threadId = proposal.message?.thread_id;
    const updated = await w.put("application", appId, {
      ...app,
      status: to,
      event_log: [...((app.event_log as EventLogEntry[]) ?? []), entry],
      gmail_threads: threadId && !threads.includes(threadId) ? [...threads, threadId] : threads,
    });
    await w.put("sync", CONNECTOR, {
      ...fields,
      proposals: fields.proposals.map((p) =>
        p.n === n ? { ...p, state: "approved" as const, decided_at: at } : p,
      ),
    });
    if (typeof updated.listing === "string") {
      const listing = await getRecord(dataDir, "listing", updated.listing);
      if (listing) await writeTrees(dataDir, [listing], [updated]);
    }
    return { application: updated, event: entry };
  });
}
