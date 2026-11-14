// External applications (#50): applications made outside Job Butler that Track finds in Gmail.
// This leaf module holds the pure parts: the opt-in and backfill state, grouping unmatched
// mail into offers, and the "already applied (external)" match. Creating one (a Checkpoint
// write) and linking are in external-create.ts. See docs/agents/core-conventions.md,
// "External applications".
import { CoreError } from "./errors.ts";
import { loadPreferences } from "./preferences.ts";
import { normaliseCompanyName, normaliseTitle, sameRole } from "./same-role.ts";
import type { StoredRecord } from "./store.ts";
import type { ClassifiedMessage } from "./track.ts";

/** What marks a Listing the job seeker already applied to elsewhere. */
export const ALREADY_APPLIED_LABEL = "already applied (external)";

/** One thing Track offers to track: every unmatched message about one company and role. */
export interface ExternalOffer {
  /** Numbered from the Sync record's counter, shared with Status-change proposals. */
  n: number;
  company: string;
  title: string;
  messages: ClassifiedMessage[];
  /** The earliest confirmation mail (an acknowledgement), else the earliest message. */
  applied_at: string;
  /** Found by the one-off backfill, so grouped for bulk approval. */
  backfill: boolean;
  state: "pending" | "approved" | "dismissed";
  offered_at: string;
  decided_at: string | null;
  application_id?: string;
}

/** The one-off backfill, recorded on the Sync record once it has run. */
export interface ExternalBackfill {
  ran_at: string;
  months: number;
  after: string;
}

export interface ExternalSettings {
  enabled: boolean;
  backfill_months: number;
}

/** The opt-in and window from Preferences; off when there are no Preferences yet. */
export async function externalSettings(dataDir: string): Promise<ExternalSettings> {
  try {
    return (await loadPreferences(dataDir)).external_applications;
  } catch (e) {
    if (e instanceof CoreError && e.code === "PREFERENCES_MISSING") {
      return { enabled: false, backfill_months: 6 };
    }
    throw e;
  }
}

/** Mail that confirms an application or reports a later step can start an External application. */
export function offerable(m: ClassifiedMessage): boolean {
  return (
    m.classification !== "other_job_mail" &&
    (m.company ?? "").trim() !== "" &&
    (m.role ?? "").trim() !== ""
  );
}

export const offerKey = (company: string, title: string): string =>
  `${normaliseCompanyName(company)}|${normaliseTitle(title)}`;

/** The earliest acknowledgement, else the earliest message of any kind. */
export function earliestConfirmation(messages: ClassifiedMessage[]): string {
  const at = (ms: ClassifiedMessage[]) => ms.map((m) => m.received_at).sort()[0] as string;
  const acks = messages.filter((m) => m.classification === "acknowledgement");
  return at(acks.length > 0 ? acks : messages);
}

/**
 * Fold one unmatched message into the offers: onto the pending offer for the same company and
 * role, else a new one numbered `n`. Returns undefined (and changes nothing) when the message
 * can't be offered or its company and role already became an External application.
 */
export function addToOffers(
  offers: ExternalOffer[],
  message: ClassifiedMessage,
  next: { n: number; at: string; backfill: boolean },
): ExternalOffer[] | undefined {
  if (!offerable(message)) return undefined;
  const key = offerKey(message.company as string, message.role as string);
  const same = offers.filter((o) => offerKey(o.company, o.title) === key);
  if (same.some((o) => o.state === "approved")) return undefined;
  const pending = same.find((o) => o.state === "pending");
  if (pending !== undefined) {
    const messages = [...pending.messages, message];
    return offers.map((o) =>
      o === pending ? { ...o, messages, applied_at: earliestConfirmation(messages) } : o,
    );
  }
  const n = next.n++;
  return [
    ...offers,
    {
      n,
      company: (message.company as string).trim(),
      title: (message.role as string).trim(),
      messages: [message],
      applied_at: earliestConfirmation([message]),
      backfill: next.backfill,
      state: "pending",
      offered_at: next.at,
      decided_at: null,
    },
  ];
}

// ---------------------------------------------------------------------------------------
// Already applied (external)

/** An External application still alive: a rejected or withdrawn one no longer blocks a Listing. */
const isLive = (app: StoredRecord) => !["rejected", "withdrawn"].includes(String(app.status));

export interface AppliedMark {
  label: typeof ALREADY_APPLIED_LABEL;
  application_id: string;
  /** True when the job seeker linked it; false when Screen matched company and role. */
  linked: boolean;
}

/**
 * Whether a Listing is already applied to as an External application: one the job seeker
 * linked, else a live External application for the same role at the same company (Employer
 * when both have one, else the normalised name; location ignored, as for the reapply cooldown).
 */
export function externalMark(
  listing: StoredRecord,
  externals: StoredRecord[],
): AppliedMark | undefined {
  const link = listing.already_applied as { application_id?: string } | undefined;
  if (typeof link?.application_id === "string") {
    return { label: ALREADY_APPLIED_LABEL, application_id: link.application_id, linked: true };
  }
  const role = {
    company: String(listing.company),
    employer: (listing.employer as string | null | undefined) ?? null,
    title: String(listing.title),
  };
  const hit = externals.find(
    (a) =>
      a.origin === "external" &&
      isLive(a) &&
      sameRole(
        {
          company: String(a.company),
          employer: (a.employer as string | null) ?? null,
          title: String(a.title),
        },
        role,
        { location: false },
      ),
  );
  return hit === undefined
    ? undefined
    : { label: ALREADY_APPLIED_LABEL, application_id: hit.id, linked: false };
}
