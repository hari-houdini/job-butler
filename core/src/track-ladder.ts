// The Track match ladder (spec, "Track"): the pure matching of one classified message to the
// Applications it may belong to. The first step to leave exactly one candidate wins. No I/O:
// track.ts builds the LadderContext from the data directory and calls matchMessage.
// #49 added steps 3 to 5 (learned domain, named sender, body) to LADDER.

import { atsPostingId } from "./dedupe.ts";
import type { StoredRecord } from "./store.ts";

/** The fields of a classified message the ladder reads. Track's ClassifiedMessage has them all. */
export interface LadderMessage {
  thread_id: string;
  from: string;
  reply_to?: string;
  source?: "email" | "calendar";
  ats?: { job_url?: string; job_id?: string; board_slug?: string; workday_tenant?: string };
  company?: string;
  role?: string;
  signature?: string;
}

// ---------------------------------------------------------------------------------------
// Mail domains: which sender domains Track may learn (step 3)

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

// ---------------------------------------------------------------------------------------
// The matching steps

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
  find(message: LadderMessage, ctx: LadderContext): LadderHit;
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
  m: LadderMessage,
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
  m: LadderMessage,
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

export function matchMessage(message: LadderMessage, ctx: LadderContext): Match {
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
