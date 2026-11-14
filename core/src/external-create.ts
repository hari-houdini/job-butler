// External applications (#50): the two writes. `application external <n>` is the digest-status
// Checkpoint command that turns an offer into an External application; `application
// link-external` is the job seeker's own reply that ties a Listing to one. Pure helpers and the
// state shapes are in external.ts. See docs/agents/core-conventions.md, "External applications".
import { randomUUID } from "node:crypto";
import type { EventLogEntry } from "./application.ts";
import { approvalUsedFor, normaliseAction } from "./approval.ts";
import { timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { externalSettings } from "./external.ts";
import { getRecord, withWriter } from "./store.ts";
import {
  type ClassifiedMessage,
  CONNECTOR,
  learnableDomain,
  type MessageRef,
  readSync,
  syncFields,
} from "./track.ts";

const refOf = (m: ClassifiedMessage): MessageRef => ({
  id: m.message_id,
  thread_id: m.thread_id,
  from: m.from,
  subject: m.subject,
  received_at: m.received_at,
  classification: m.classification,
  matched_by: "your approval of the External application offer",
  ...(m.source === "calendar" ? { source: "calendar" as const } : {}),
});

/**
 * `application external <n>`: create the External application for offer `n`. Runs only under
 * an Approval for this exact action (the hook spends it first). The record has no Listing: a
 * company, role title, the evidence messages, learned threads and domains, a Status
 * (Submitted) and an Event log, dated by its earliest confirmation mail (`applied_at`).
 */
export async function createExternal(dataDir: string, args: string[]) {
  const [nArg, ...extra] = args;
  const n = Number(nArg);
  if (nArg === undefined || extra.length > 0 || !Number.isInteger(n)) {
    throw usageError("application external: give one offer number, e.g. application external 4");
  }
  const action = normaliseAction(`application external ${n}`);
  const approval = await approvalUsedFor(dataDir, action);
  if (approval === undefined) {
    throw new CoreError(
      "APPROVAL_MISSING",
      `There's no digest-status Approval for "${action}", so no External application was created. ` +
        "Show the digest, record the job seeker's yes with `approval record digest-status`, then run it.",
      { action },
    );
  }
  return withWriter(dataDir, "application external", async (w) => {
    if (!(await externalSettings(dataDir)).enabled) {
      throw new CoreError(
        "EXTERNAL_OFF",
        "Tracking External applications is off in Preferences, so nothing was created.",
      );
    }
    const fields = syncFields(await readSync(dataDir));
    const offers = fields.external_offers ?? [];
    const offer = offers.find((o) => o.n === n && o.state === "pending");
    if (offer === undefined) {
      throw new CoreError(
        "NO_OFFER",
        `Track has no pending External application offer ${n}, so nothing was created.`,
        { action },
      );
    }
    const at = timestamp();
    const messages = [...offer.messages].sort((a, b) => a.received_at.localeCompare(b.received_at));
    const earliest = messages.find((m) => m.received_at === offer.applied_at) ?? messages[0];
    const unique = (xs: (string | undefined)[]) => [...new Set(xs.filter((x) => x !== undefined))];
    const entry: EventLogEntry = {
      at,
      stage: "track",
      from: null,
      to: "submitted",
      reason:
        `Applied outside Job Butler; earliest confirmation ${offer.applied_at.slice(0, 10)} ` +
        `(${messages.length} message${messages.length === 1 ? "" : "s"} found in your mail).`,
      approval: {
        id: approval.id,
        checkpoint: approval.checkpoint,
        approved_at: approval.approved_at,
        action,
      },
      ...(earliest ? { message: refOf(earliest) } : {}),
    };
    const calendar = messages.filter((m) => m.source === "calendar");
    const mail = messages.filter((m) => m.source !== "calendar");
    const app = await w.put("application", randomUUID(), {
      origin: "external",
      listing: null,
      employer: null,
      company: offer.company,
      title: offer.title,
      status: "submitted",
      applied_at: offer.applied_at,
      event_log: [entry],
      evidence_messages: messages.map(refOf),
      gmail_threads: unique(mail.map((m) => m.thread_id)),
      ...(calendar.length > 0 ? { calendar_events: unique(calendar.map((m) => m.thread_id)) } : {}),
      mail_domains: unique(messages.map((m) => learnableDomain(m.from))),
    });
    await w.put("sync", CONNECTOR, {
      ...fields,
      external_offers: offers.map((o) =>
        o.n === n
          ? { ...o, state: "approved" as const, decided_at: at, application_id: app.id }
          : o,
      ),
    });
    return { application: app, event: entry };
  });
}

/**
 * `application link-external <listing-id> <application-id>`: the job seeker says this Listing
 * is the job they already applied to as an External application. Screen then marks it "already
 * applied (external)" and keeps it off the Shortlist. Nothing links them but this reply.
 */
export async function linkExternal(dataDir: string, args: string[]) {
  const [listingId, appId] = args;
  if (listingId === undefined || appId === undefined || args.length !== 2) {
    throw usageError("application link-external: <listing-id> and <application-id> are required");
  }
  return withWriter(dataDir, "application link-external", async (w) => {
    const listing = await getRecord(dataDir, "listing", listingId);
    if (listing === undefined) {
      throw new CoreError("NOT_FOUND", `There's no Listing "${listingId}".`, {
        listing_id: listingId,
      });
    }
    const app = await getRecord(dataDir, "application", appId);
    if (app === undefined || app.origin !== "external") {
      throw new CoreError("NOT_FOUND", `There's no External application "${appId}".`, {
        application_id: appId,
      });
    }
    if (typeof listing.application_id === "string") {
      throw new CoreError(
        "ALREADY_PICKED",
        `${listing.company} · ${listing.title} is already an Application, so it can't be linked.`,
        { listing_id: listingId },
      );
    }
    const at = timestamp();
    const linked = Array.isArray(app.linked_listings) ? (app.linked_listings as string[]) : [];
    await w.put("listing", listingId, {
      ...listing,
      already_applied: { kind: "external", application_id: appId, linked_at: at },
    });
    const updated = await w.put("application", appId, {
      ...app,
      linked_listings: linked.includes(listingId) ? linked : [...linked, listingId],
    });
    return { listing_id: listingId, application: updated, label: "already applied (external)" };
  });
}
