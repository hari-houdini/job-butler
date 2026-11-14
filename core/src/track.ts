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
import {
  addToOffers,
  type ExternalBackfill,
  type ExternalOffer,
  type ExternalSettings,
  externalSettings,
} from "./external.ts";
import {
  getRecord,
  listRecords,
  type StoredRecord,
  type StoreWriter,
  withWriter,
} from "./store.ts";
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

/** Personal mail providers (and Google's calendar-group address): never an Employer's domain. */
export const FREE_MAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "calendar.google.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
];

/** The sender's domain, lower case: the text after the last "@" of the address. */
export function senderDomain(from: string): string | undefined {
  const m = from.toLowerCase().match(/@([a-z0-9.-]+)[^@]*$/);
  return m?.[1]?.replace(/\.+$/, "");
}

const underDomain = (domain: string, list: string[]) =>
  list.some((d) => domain === d || domain.endsWith(`.${d}`));

/** True when the sender's domain is a vendor domain or a subdomain of one. */
export function isVendorSender(from: string): boolean {
  const domain = senderDomain(from);
  return domain !== undefined && underDomain(domain, VENDOR_DOMAINS);
}

/** The domain a sender can teach Track: never a vendor, free-mail or missing domain. */
export function learnableDomain(from: string): string | undefined {
  const domain = senderDomain(from);
  if (domain === undefined || !domain.includes(".")) return undefined;
  if (underDomain(domain, VENDOR_DOMAINS) || underDomain(domain, FREE_MAIL_DOMAINS)) {
    return undefined;
  }
  return domain;
}

/** The domains a message can teach, in the order step 3 tries them: the sender's, then Reply-To's. */
export function learnableDomains(m: { from: string; reply_to?: string }): string[] {
  const domains = [learnableDomain(m.from), learnableDomain(m.reply_to ?? "")];
  return [...new Set(domains.filter((d): d is string => d !== undefined))];
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

// ---------------------------------------------------------------------------------------
// The matching ladder (spec, "Track"). The first step to leave exactly one candidate wins.
// #49 adds steps 3 to 5 (learned domain, named sender, body) to LADDER; nothing else changes.

export interface LadderContext {
  /** Every Application, the aliases of its Listing, and its Employer record when it has one. */
  apps: {
    app: StoredRecord;
    aliases: AliasInfo[];
    employer?: StoredRecord;
    employerId?: string;
  }[];
}

interface AliasInfo {
  id: string;
  url: string | null;
  board: string | null;
  source_job_id: string | null;
}

/** What a step found: the Applications (empty when it has no signal) and, for step 3, the domain. */
export interface LadderHit {
  apps: StoredRecord[];
  domain?: string;
}

export interface LadderStep {
  step: number;
  name: string;
  find(message: ClassifiedMessage, ctx: LadderContext): LadderHit;
}

const lower = (s: string | undefined | null): string => (s ?? "").trim().toLowerCase();

/** Closed Applications can't take new mail: steps 3 to 5 leave them out. */
const CLOSED: string[] = ["rejected", "withdrawn"];
const isOpen = (app: StoredRecord) => !CLOSED.includes(String(app.status));

const byThread: LadderStep = {
  step: 1,
  name: "thread",
  find: (m, ctx) => {
    const key = m.source === "calendar" ? "calendar_events" : "gmail_threads";
    return {
      apps: ctx.apps
        .filter(
          ({ app }) => Array.isArray(app[key]) && (app[key] as string[]).includes(m.thread_id),
        )
        .map((x) => x.app),
    };
  },
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
    if (ats === undefined) return { apps: [] };
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
    if (exact.length > 0) return { apps: exact.map((x) => x.app) };
    const board = (pick: (a: AliasInfo) => string, want: string) =>
      want === ""
        ? []
        : ctx.apps.filter(({ aliases }) => aliases.some((a) => pick(a) === want)).map((x) => x.app);
    const bySlug = board(slugOf, slug);
    return { apps: bySlug.length > 0 ? bySlug : board(tenantOf, lower(ats.workday_tenant)) };
  },
};

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(lower) : [];

/** The domains Track has learned for an Application: its own and its Employer's. */
function mailDomains(entry: LadderContext["apps"][number]): string[] {
  return [...stringList(entry.app.mail_domains), ...stringList(entry.employer?.mail_domains)];
}

/** Applications that share an Employer: the Employer record, else the normalised company. */
function sameEmployer(a: LadderContext["apps"][number], b: LadderContext["apps"][number]) {
  const ea = a.employerId;
  const eb = b.employerId;
  if (ea !== undefined && eb !== undefined) return ea === eb;
  return (
    nameTokens(String(a.app.company)).join(" ") === nameTokens(String(b.app.company)).join(" ")
  );
}

/**
 * Step 3's match: the first of the message's domains (sender, then Reply-To) that an open
 * Application or its Employer has learned, with those Applications. Undefined when none.
 */
function learnedMailMatch(
  m: ClassifiedMessage,
  ctx: LadderContext,
): { domain: string; apps: StoredRecord[] } | undefined {
  for (const domain of learnableDomains(m)) {
    const apps = ctx.apps
      .filter((e) => isOpen(e.app) && mailDomains(e).some((d) => underDomain(domain, [d])))
      .map((e) => e.app);
    if (apps.length > 0) return { domain, apps };
  }
  return undefined;
}

/** Step 3: the sender's domain, else the Reply-To domain, is one Track learned for an open Application or its Employer. */
const byMailDomain: LadderStep = {
  step: 3,
  name: "mail domain",
  find(m, ctx) {
    const hit = learnedMailMatch(m, ctx);
    return hit === undefined ? { apps: [] } : { apps: hit.apps, domain: hit.domain };
  },
};

const LEGAL = new Set(["inc", "ltd", "limited", "llc", "plc", "corp", "corporation", "gmbh", "co"]);

/** Lower-case words of a name, without punctuation or a legal suffix. */
function nameTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w !== "");
  const trimmed = words.filter((w) => !LEGAL.has(w));
  return trimmed.length > 0 ? trimmed : words;
}

/** True when `needle`'s words appear in `haystack` as a run of whole words. */
function containsName(haystack: string, needle: string): boolean {
  const h = haystack
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const n = nameTokens(needle).join(" ");
  return n !== "" && ` ${h} `.includes(` ${n} `);
}

/** The display name of the sender: "Acme Talent <jobs@acme.example>" gives "Acme Talent". */
const displayName = (from: string): string =>
  from
    .replace(/<[^>]*>/g, "")
    .replace(/\S+@\S+/g, "")
    .replace(/"/g, "");

/** Step 4: the sender's display name or signature names an open Application's company. */
const bySenderName: LadderStep = {
  step: 4,
  name: "named sender",
  find(m, ctx) {
    const text = `${displayName(m.from)}\n${m.signature ?? ""}`;
    return {
      apps: ctx.apps
        .filter((e) => isOpen(e.app) && containsName(text, String(e.app.company)))
        .map((e) => e.app),
    };
  },
};

const roleMatches = (title: string, role: string): boolean => {
  const a = nameTokens(title).join(" ");
  const b = nameTokens(role).join(" ");
  return (
    a !== "" && b !== "" && (a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `))
  );
};

/** Step 5: the body names the company, and the role when it says one. */
const byBody: LadderStep = {
  step: 5,
  name: "body",
  find(m, ctx) {
    if (m.company === undefined || m.company.trim() === "") return { apps: [] };
    const company = ctx.apps.filter(
      (e) => isOpen(e.app) && containsName(m.company as string, String(e.app.company)),
    );
    const role = m.role?.trim();
    if (role) {
      const narrowed = company.filter((e) => roleMatches(String(e.app.title), role));
      if (narrowed.length > 0) return { apps: narrowed.map((x) => x.app) };
    }
    return { apps: company.map((x) => x.app) };
  },
};

export const LADDER: LadderStep[] = [byThread, byAtsId, byMailDomain, bySenderName, byBody];

export interface Candidate {
  app: StoredRecord;
  reason: string;
}

export type Match =
  | {
      kind: "matched";
      app: StoredRecord;
      step: LadderStep;
      /** Step 3 only: the learned domain the message matched by. */
      domain?: string;
      confidence: "sure" | "probable";
      /** Why a probable match is only probable; absent for a sure one. */
      note?: string;
    }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "unmatched" };

/** One line on how a step found the Application, for the digest. */
function stepReason(
  step: LadderStep,
  m: ClassifiedMessage,
  app: StoredRecord,
  domain: string | undefined,
): string {
  const company = String(app.company);
  switch (step.step) {
    case 3:
      return `mail from ${domain ?? senderDomain(m.from)}, a mail domain learned for ${company}`;
    case 4:
      return `the sender or signature names ${company}`;
    case 5:
      return m.role
        ? `the message names ${company} and "${m.role}"`
        : `the message names ${company}`;
    default:
      return `${step.name} matches`;
  }
}

function openAtEmployer(app: StoredRecord, ctx: LadderContext): number {
  const me = ctx.apps.find((e) => e.app.id === app.id);
  if (me === undefined) return 1;
  return ctx.apps.filter((e) => isOpen(e.app) && sameEmployer(e, me)).length;
}

export function matchMessage(message: ClassifiedMessage, ctx: LadderContext): Match {
  const tally = new Map<
    string,
    { app: StoredRecord; hits: { step: LadderStep; domain?: string }[] }
  >();
  for (const step of LADDER) {
    const hit = step.find(message, ctx);
    const found = [...new Map(hit.apps.map((a) => [a.id, a])).values()];
    if (found.length === 1) {
      const app = found[0] as StoredRecord;
      const sure = step.step <= 2 || (step.step === 3 && openAtEmployer(app, ctx) === 1);
      return {
        kind: "matched",
        app,
        step,
        ...(hit.domain !== undefined ? { domain: hit.domain } : {}),
        confidence: sure ? "sure" : "probable",
        ...(sure
          ? {}
          : {
              note:
                step.step === 3
                  ? `${stepReason(step, message, app, hit.domain)}, but ${String(app.company)} has other open Applications`
                  : stepReason(step, message, app, hit.domain),
            }),
      };
    }
    for (const app of found) {
      const entry = tally.get(app.id) ?? { app, hits: [] };
      entry.hits.push({ step, domain: hit.domain });
      tally.set(app.id, entry);
    }
  }
  if (tally.size === 0) return { kind: "unmatched" };
  const role = message.role?.trim();
  const score = (x: { app: StoredRecord; hits: unknown[] }) =>
    x.hits.length +
    (role && roleMatches(String(x.app.title), role) ? 0.5 : 0) +
    (isOpen(x.app) ? 0.1 : 0);
  const candidates = [...tally.values()]
    .sort((a, b) => score(b) - score(a) || String(a.app.id).localeCompare(String(b.app.id)))
    .map((x) => ({
      app: x.app,
      reason: x.hits.map((h) => stepReason(h.step, message, x.app, h.domain)).join("; "),
    }));
  return { kind: "ambiguous", candidates };
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
    const moved = await w.put("application", appId, {
      ...app,
      status: to,
      event_log: [...((app.event_log as EventLogEntry[]) ?? []), entry],
    });
    const updated = proposal.message ? await learnFrom(w, dataDir, moved, proposal.message) : moved;
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
