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
import { citeSpentApproval, normaliseAction } from "./approval.ts";
import { now, timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import {
  addToOffers,
  type ExternalBackfill,
  type ExternalOffer,
  type ExternalSettings,
  externalSettings,
} from "./external.ts";
import { moveStatus } from "./status-move.ts";
import {
  getRecord,
  listRecords,
  type StoredRecord,
  type StoreWriter,
  withWriter,
} from "./store.ts";
import {
  isVendorSender,
  type LadderContext,
  learnableDomains,
  matchMessage,
} from "./track-ladder.ts";
import { isObject, type Problems } from "./validate.ts";

export const CONNECTOR = "gmail";
/** The first sync has no last-synced time: read this many days back. */
export const FIRST_SYNC_DAYS = 30;
/** `after:` is a midnight date, so each window starts a day early; the Sync record dedupes. */
export const OVERLAP_DAYS = 1;

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
  /** The Reply-To header, when the message sets one: step 3 tries it after the sender. */
  reply_to?: string;
  subject: string;
  received_at: string;
  classification: Classification;
  ats?: Ats;
  /** "calendar" for a Calendar event: `message_id` is its event ID, `from` its organizer. */
  source?: "email" | "calendar";
  /** What the body names, for ladder step 5, and the sender's signature, for step 4. */
  company?: string;
  role?: string;
  signature?: string;
}

export interface MessageRef {
  id: string;
  thread_id: string;
  from: string;
  reply_to?: string;
  subject: string;
  received_at: string;
  classification: string;
  matched_by: string;
  source?: "email" | "calendar";
}

export interface Proposal {
  n: number;
  application_id: string;
  from: Status;
  to: Status;
  reason: string;
  /** "sure": thread, ATS ID, or a domain with one open Application; else "probable". */
  confidence: "sure" | "probable";
  /** For a probable match: the one-line reason it is only probable. */
  note?: string;
  message: MessageRef | null;
  state: "pending" | "approved" | "dismissed";
  proposed_at: string;
  decided_at: string | null;
}

export interface Unmatched {
  message: ClassifiedMessage;
  /** Application IDs the ladder left, when it found several. Empty when it found none. */
  candidates: string[];
  /** The candidates, ranked best first, each with why. */
  ranking?: { application_id: string; reason: string }[];
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
  /** External applications (#50): what Track offers to track, and whether the backfill ran. */
  external_offers?: ExternalOffer[];
  external_backfill?: ExternalBackfill | null;
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

/** The backfill reads back over the Preferences window (months by calendar month). */
function backfillFrom(months: number): number {
  const start = new Date(now().getTime());
  start.setUTCMonth(start.getUTCMonth() - months);
  return start.getTime();
}

/** The one-off External backfill is due: the opt-in is on and it has never run. */
const backfillDue = (settings: ExternalSettings, sync: SyncRecord | undefined) =>
  settings.enabled && (sync?.external_backfill ?? null) === null;

export async function trackWindow(dataDir: string) {
  const sync = await readSync(dataDir);
  const settings = await externalSettings(dataDir);
  const last = sync?.last_synced_at ? Date.parse(sync.last_synced_at) : undefined;
  let from =
    last !== undefined ? last - OVERLAP_DAYS * DAY_MS : now().getTime() - FIRST_SYNC_DAYS * DAY_MS;
  const due = backfillDue(settings, sync);
  if (due) {
    from = Math.min(from, backfillFrom(settings.backfill_months));
  }
  const after = gmailDate(from);
  return {
    backfill: { pending: due, months: settings.backfill_months },
    connector: CONNECTOR,
    last_synced_at: sync?.last_synced_at ?? null,
    after,
    query: `after:${after}`,
    processed_ids: sync?.processed_ids ?? [],
    inbox_file: join(dataDir, "inbox", "track-messages.json"),
  };
}

async function ladderContext(dataDir: string): Promise<LadderContext> {
  const listings = new Map((await listRecords(dataDir, "listing")).map((l) => [l.id, l]));
  const employers = new Map((await listRecords(dataDir, "employer")).map((e) => [e.id, e]));
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
    const employerId = listing?.employer ?? app.employer;
    const employer = typeof employerId === "string" ? employers.get(employerId) : undefined;
    return {
      app,
      aliases,
      ...(employer ? { employer } : {}),
      ...(typeof employerId === "string" ? { employerId } : {}),
    };
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
    if (m.source !== undefined && m.source !== "email" && m.source !== "calendar") {
      problems.push(`${at}.source must be "email" or "calendar"`);
    }
    for (const key of ["reply_to", "company", "role", "signature"]) {
      if (m[key] !== undefined && m[key] !== null && typeof m[key] !== "string") {
        problems.push(`${at}.${key} must be text`);
      }
    }
    if (m.source === "calendar") {
      // A Calendar event is an interview invite, whatever the worker says.
      m.classification = "interview_invite";
    } else if (!CLASSIFICATIONS.includes(m.classification as Classification)) {
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

function messageRef(message: ClassifiedMessage, matchedBy: string): MessageRef {
  return {
    id: message.message_id,
    thread_id: message.thread_id,
    from: message.from,
    subject: message.subject,
    received_at: message.received_at,
    classification: message.classification,
    matched_by: matchedBy,
    ...(message.reply_to ? { reply_to: message.reply_to } : {}),
    ...(message.source === "calendar" ? { source: "calendar" as const } : {}),
  };
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
    let unmatched = [...fields.unmatched];
    const processed = [...fields.processed_ids];
    const counter = { n: fields.next_n, at, backfill: false };
    // External applications (#50): offer unmatched confirmations when the job seeker opted in.
    const settings = await externalSettings(dataDir);
    const backfill = backfillDue(settings, sync);
    let offers = [...(fields.external_offers ?? [])];
    if (backfill) {
      // Mail read before the opt-in is part of the one backfill.
      counter.backfill = true;
      unmatched = unmatched.filter((u) => {
        const added =
          u.candidates.length === 0 ? addToOffers(offers, u.message, counter) : undefined;
        if (added !== undefined) offers = added;
        return added === undefined;
      });
    }
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
        const added =
          settings.enabled && match.kind === "unmatched"
            ? addToOffers(offers, message, counter)
            : undefined;
        if (added !== undefined) {
          offers = added;
          continue;
        }
        result.unmatched++;
        const ranked = match.kind === "ambiguous" ? match.candidates : [];
        unmatched.push({
          message,
          candidates: ranked.map((c) => c.app.id),
          ranking: ranked.map((c) => ({ application_id: c.app.id, reason: c.reason })),
          at,
        });
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
        n: counter.n,
        application_id: match.app.id,
        from: current,
        to: rule.to,
        reason: `${REASON_LEAD[message.classification]} from ${message.from}: "${message.subject}".`,
        confidence: match.confidence,
        ...(match.note ? { note: match.note } : {}),
        message: messageRef(message, `${match.step.name} (step ${match.step.step})`),
        state: "pending",
        proposed_at: at,
        decided_at: null,
      });
      result.proposed.push(counter.n++);
    }
    await w.put("sync", CONNECTOR, {
      ...fields,
      last_synced_at: at,
      processed_ids: processed,
      proposals,
      unmatched,
      next_n: counter.n,
      external_offers: offers,
      ...(backfill
        ? {
            external_backfill: {
              ran_at: at,
              months: settings.backfill_months,
              after: gmailDate(backfillFrom(settings.backfill_months)),
            },
          }
        : {}),
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
    // An External application offer is dismissed the same way: its mail is never raised again.
    const offers = (fields.external_offers ?? []).map((o) => {
      if (!wanted.includes(o.n) || o.state !== "pending") return o;
      dismissed.push(...o.messages.map((m) => m.message_id));
      return { ...o, state: "dismissed" as const, decided_at: at };
    });
    for (const n of wanted) {
      if (![...proposals, ...offers].some((p) => p.n === n && p.state === "dismissed")) {
        throw new CoreError("NOT_FOUND", `There's no pending proposal ${n} to dismiss.`, { n });
      }
    }
    await w.put("sync", CONNECTOR, {
      ...fields,
      proposals,
      dismissed_ids: dismissed,
      external_offers: offers,
    });
    return { dismissed: wanted, ...(await trackDigest(dataDir)) };
  });
}

const notUnmatched = (id: string) =>
  new CoreError("NOT_UNMATCHED", `Message "${id}" isn't waiting in the unmatched list.`, {
    message_id: id,
  });

/** Add what an approved or assigned message teaches: its thread and its sender's and Reply-To domains. */
export async function learnFrom(
  w: StoreWriter,
  dataDir: string,
  app: StoredRecord,
  ref: Pick<MessageRef, "thread_id" | "from" | "reply_to" | "source">,
): Promise<StoredRecord> {
  const key = ref.source === "calendar" ? "calendar_events" : "gmail_threads";
  const ids = (app[key] as string[] | undefined) ?? [];
  const learned = learnableDomains(ref);
  const domains = (app.mail_domains as string[] | undefined) ?? [];
  const added = learned.filter((d) => !domains.includes(d));
  const next = {
    ...app,
    [key]: ids.includes(ref.thread_id) ? ids : [...ids, ref.thread_id],
    ...(added.length > 0 ? { mail_domains: [...domains, ...added] } : {}),
  };
  if (learned.length > 0 && typeof app.listing === "string") {
    const listing = await getRecord(dataDir, "listing", app.listing);
    const employerId = listing?.employer ?? app.employer;
    const employer =
      typeof employerId === "string" ? await getRecord(dataDir, "employer", employerId) : undefined;
    if (employer !== undefined) {
      const known = (employer.mail_domains as string[] | undefined) ?? [];
      const fresh = learned.filter((d) => !known.includes(d));
      if (fresh.length > 0) {
        await w.put("employer", employer.id, { ...employer, mail_domains: [...known, ...fresh] });
      }
    }
  }
  return w.put("application", app.id, next);
}

/**
 * `track assign <message-id> <application-id>`: the job seeker places unmatched mail on one
 * Application (the pick when several fit). It proposes the Status change like a match would;
 * with nothing to change it only teaches Track the thread and domain.
 */
export async function trackAssign(dataDir: string, args: string[]) {
  const [messageId, appId] = args;
  if (messageId === undefined || appId === undefined) {
    throw usageError("track assign: <message-id> and <application-id> are required");
  }
  return withWriter(dataDir, "track assign", async (w) => {
    const fields = syncFields(await readSync(dataDir));
    const item = fields.unmatched.find((u) => u.message.message_id === messageId);
    if (item === undefined) throw notUnmatched(messageId);
    const app = await getRecord(dataDir, "application", appId);
    if (app === undefined) {
      throw new CoreError("NOT_FOUND", `There's no Application "${appId}".`, {
        application_id: appId,
      });
    }
    const message = item.message;
    const at = timestamp();
    const rule = PROPOSES[message.classification];
    const current = app.status as Status;
    const proposals = [...fields.proposals];
    let next = fields.next_n;
    const proposed: number[] = [];
    if (rule?.from.includes(current)) {
      proposals.push({
        n: next,
        application_id: appId,
        from: current,
        to: rule.to,
        reason: `${REASON_LEAD[message.classification]} from ${message.from}: "${message.subject}".`,
        confidence: "sure",
        message: messageRef(message, "assigned by you"),
        state: "pending",
        proposed_at: at,
        decided_at: null,
      });
      proposed.push(next++);
    } else {
      await learnFrom(w, dataDir, app, {
        thread_id: message.thread_id,
        from: message.from,
        ...(message.reply_to ? { reply_to: message.reply_to } : {}),
        source: message.source,
      });
    }
    await w.put("sync", CONNECTOR, {
      ...fields,
      proposals,
      next_n: next,
      unmatched: fields.unmatched.filter((u) => u.message.message_id !== messageId),
    });
    return { assigned: messageId, proposed, ...(await trackDigest(dataDir)) };
  });
}

/** `track dismiss-mail <message-id>...`: drop unmatched mail; it is never raised again. */
export async function trackDismissMail(dataDir: string, args: string[]) {
  if (args.length === 0) throw usageError("track dismiss-mail: give message IDs");
  return withWriter(dataDir, "track dismiss-mail", async (w) => {
    const fields = syncFields(await readSync(dataDir));
    for (const id of args) {
      if (!fields.unmatched.some((u) => u.message.message_id === id)) throw notUnmatched(id);
    }
    await w.put("sync", CONNECTOR, {
      ...fields,
      dismissed_ids: [...new Set([...fields.dismissed_ids, ...args])],
      unmatched: fields.unmatched.filter((u) => !args.includes(u.message.message_id)),
    });
    return { dismissed_mail: args, ...(await trackDigest(dataDir)) };
  });
}

export const REPLIES = [
  {
    reply: "approve <n>[, <n>]",
    does: "approve those Status changes, or track an offered External application (asks for your Approval)",
  },
  { reply: "dismiss <n>", does: "drop a proposal and don't raise that message again" },
  {
    reply: "assign <message-id> <application-id>",
    does: "place unmatched mail on one Application",
  },
  { reply: "dismiss-mail <message-id>", does: "drop unmatched mail and never raise it again" },
  {
    reply: "link <listing-id> <application-id>",
    does: "mark a Listing as already applied to through an External application",
  },
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
    const preselected = p.confidence === "sure";
    lines.push(
      `  ${p.n}) ${name}: ${statusLabel(p.from)} → ${statusLabel(p.to)}  [${p.confidence}]${
        preselected ? " pre-selected" : ""
      }`,
    );
    const calendar = p.message?.source === "calendar" ? " (Calendar event)" : "";
    lines.push(
      `       ${p.reason}${p.message ? ` Matched by ${p.message.matched_by}${calendar}.` : ""}`,
    );
    if (p.confidence === "probable" && p.note) lines.push(`       Why probable: ${p.note}.`);
    return { ...p, application: name, preselected };
  });
  const unmatched = sync?.unmatched ?? [];
  const unmatchedItems = unmatched.map((u) => {
    const ranking = u.ranking ?? u.candidates.map((id) => ({ application_id: id, reason: "" }));
    return {
      message_id: u.message.message_id,
      source: u.message.source ?? "email",
      from: u.message.from,
      subject: u.message.subject,
      received_at: u.message.received_at,
      classification: u.message.classification,
      ats_mail: isVendorSender(u.message.from),
      candidates: ranking.map((c) => {
        const app = apps.get(c.application_id);
        return {
          application_id: c.application_id,
          application: app ? `${app.company} · ${app.title}` : c.application_id,
          reason: c.reason,
        };
      }),
    };
  });
  if (unmatched.length > 0) {
    lines.push(`UNMATCHED (${unmatched.length})  job mail no Application claims yet`);
    for (const u of unmatchedItems) {
      const kind = u.source === "calendar" ? "Calendar event" : "mail";
      lines.push(
        `  - ${u.message_id}: ${kind} from ${u.from}: "${u.subject}"${u.ats_mail ? " (ATS mail)" : ""}`,
      );
      u.candidates.forEach((c, i) => {
        lines.push(`       ${i + 1}. ${c.application}${c.reason ? `: ${c.reason}` : ""}`);
      });
      lines.push(
        u.candidates.length > 1
          ? `       Several fit, pick one: track assign ${u.message_id} <application-id>, or track dismiss-mail ${u.message_id}`
          : `       track assign ${u.message_id} <application-id>, or track dismiss-mail ${u.message_id}`,
      );
    }
  }
  const offers = (sync?.external_offers ?? []).filter((o) => o.state === "pending");
  const offerItems = offers.map((o) => ({
    n: o.n,
    company: o.company,
    title: o.title,
    applied_at: o.applied_at,
    backfill: o.backfill,
    messages: o.messages,
    reply: `approve ${o.n}`,
  }));
  const offerLine = (o: ExternalOffer) => {
    lines.push(
      `  ${o.n}) ${o.company} · ${o.title}: applied ${o.applied_at.slice(0, 10)}, ` +
        `${o.messages.length} message${o.messages.length === 1 ? "" : "s"}`,
    );
    const first = [...o.messages].sort((a, b) => a.received_at.localeCompare(b.received_at))[0];
    if (first) lines.push(`       Earliest: "${first.subject}" from ${first.from}.`);
  };
  const fresh = offers.filter((o) => !o.backfill);
  const back = offers.filter((o) => o.backfill);
  if (fresh.length > 0) {
    lines.push(
      `EXTERNAL APPLICATIONS (${fresh.length})  applied outside Job Butler; approve <n> to track as External application`,
    );
    for (const o of fresh) offerLine(o);
  }
  if (back.length > 0) {
    lines.push(
      `EXTERNAL APPLICATIONS FROM YOUR BACKFILL (${back.length})  one look back over your mail; approve <n> to track as External application`,
    );
    for (const o of back) offerLine(o);
  }
  const bulk = back.length > 0 ? `approve ${back.map((o) => o.n).join(", ")}` : null;
  if (bulk) lines.push(`Bulk approve the backfill: ${bulk}`);
  const sure = pending.filter((p) => p.confidence === "sure").map((p) => p.n);
  const suggested = sure.length > 0 ? `approve ${sure.join(", ")}` : null;
  if (suggested) lines.push(`Pre-selected: ${suggested}`);
  lines.push(`Reply: ${REPLIES.map((r) => r.reply).join(" · ")}`);
  return {
    proposals: items,
    unmatched: unmatched.length,
    unmatched_items: unmatchedItems,
    suggested_reply: suggested,
    external_offers: offerItems,
    external_bulk_reply: bulk,
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
  const approval = await citeSpentApproval(
    dataDir,
    action,
    `There's no digest-status Approval for "${action}", so no Status changed. Show the digest, ` +
      "record the job seeker's yes with `approval record digest-status`, then run it.",
  );
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
    const moved = await moveStatus(dataDir, w, app, {
      stage: "track",
      to,
      reason: proposal.reason,
      approval,
      ...(proposal.message ? { message: proposal.message } : {}),
      at,
    });
    const updated = proposal.message ? await learnFrom(w, dataDir, moved, proposal.message) : moved;
    await w.put("sync", CONNECTOR, {
      ...fields,
      proposals: fields.proposals.map((p) =>
        p.n === n ? { ...p, state: "approved" as const, decided_at: at } : p,
      ),
    });
    return { application: updated, event: (updated.event_log as EventLogEntry[]).at(-1) };
  });
}
