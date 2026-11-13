// Applications: the job seeker's pursuit of one Listing (origin "picked") or of a job applied
// to outside Job Butler (origin "external", #50). Each has a Status and an append-only Event
// log. `application pick` is the Shortlist-pick Checkpoint command: the Approval hook lets it
// through only under an unspent Approval, and the entry it writes cites that Approval.
// Record shape: docs/agents/core-conventions.md, "Application record".
import { randomUUID } from "node:crypto";
import { liveEvaluation, loadLimitWorld } from "./application-limit.ts";
import { approvalUsedFor, normaliseAction } from "./approval.ts";
import { treePath, writeTrees } from "./decision-tree.ts";
import { timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { getRecord, listRecords, type StoredRecord, withWriter } from "./store.ts";

/** Every Status, in pipeline order, with the name the job seeker sees. */
export const STATUSES = {
  picked: "Picked",
  tailored: "Tailored",
  ready_to_apply: "Ready to apply",
  paused: "Paused",
  handover: "Handover",
  submitted: "Submitted",
  interview: "Interview",
  rejected: "Rejected",
  offer: "Offer",
  withdrawn: "Withdrawn",
  no_response: "No response",
} as const;
export type Status = keyof typeof STATUSES;

export function statusLabel(status: string): string {
  return STATUSES[status as Status] ?? status;
}

/** The Approval an Event log entry cites: the outward action it covered. */
export interface EventApproval {
  id: string;
  checkpoint: string;
  approved_at: string;
  action: string;
}

/** One Event log entry. Append only: never edit or remove one. */
export interface EventLogEntry {
  at: string;
  /** The Stage that made the change: discover, screen, tailor, apply or track. */
  stage: string;
  from: Status | null;
  to: Status;
  reason: string;
  approval: EventApproval | null;
}

/** The Listing must be on the Shortlist right now to be picked. */
function shortlistProblem(listing: StoredRecord | undefined, id: string): CoreError | undefined {
  if (listing === undefined) {
    return new CoreError("NOT_FOUND", `There's no Listing "${id}".`, { listing_id: id });
  }
  if (typeof listing.application_id === "string") {
    return new CoreError(
      "ALREADY_PICKED",
      `${listing.company} · ${listing.title} was already picked (Application ${listing.application_id}).`,
      { listing_id: id, application_id: listing.application_id },
    );
  }
  const screen = listing.screen as { outcome?: string } | undefined;
  if (screen?.outcome !== "shortlist" || listing.gone === true) {
    const why =
      screen === undefined
        ? "Screen hasn't scored it yet"
        : listing.gone === true
          ? "it has gone from its board"
          : "Screen excluded it";
    return new CoreError(
      "NOT_ON_SHORTLIST",
      `${listing.company} · ${listing.title} isn't on the Shortlist (${why}), so it can't be picked.`,
      { listing_id: id },
    );
  }
  return undefined;
}

/**
 * Create one Picked Application per Listing, citing the Shortlist-pick Approval that the
 * hook spent for this exact action. All or nothing: any Listing that can't be picked
 * refuses the whole pick.
 */
export async function pickListings(
  dataDir: string,
  listingIds: string[],
  opts: { overrideLimit?: string[] } = {},
): Promise<{ applications: StoredRecord[] }> {
  if (listingIds.length === 0) {
    throw usageError("application pick: give at least one <listing-id>");
  }
  const action = normaliseAction(`application pick ${listingIds.join(" ")}`);
  const approval = await approvalUsedFor(dataDir, action);
  if (approval === undefined) {
    throw new CoreError(
      "APPROVAL_MISSING",
      `There's no Shortlist-pick Approval for "${action}", so nothing was picked. Ask the job ` +
        "seeker at the Shortlist, record their yes with `approval record shortlist-pick`, then pick.",
      { action },
    );
  }
  return withWriter(dataDir, "application pick", async (w) => {
    const ids = [...new Set(listingIds)];
    const listings: StoredRecord[] = [];
    for (const id of ids) {
      const listing = await getRecord(dataDir, "listing", id);
      const problem = shortlistProblem(listing, id);
      if (problem) throw problem;
      listings.push(listing as StoredRecord);
    }
    const at = timestamp();
    // Application limits (#42): judge each pick against today's Applications plus the earlier
    // picks in this command. An over-limit pick needs an explicit override, which is recorded.
    const world = await loadLimitWorld(dataDir);
    const overridden = new Map<string, string>();
    for (const listing of listings) {
      const ev = liveEvaluation(listing, world, at);
      if (ev.status === "over") {
        if (!(opts.overrideLimit ?? []).includes(listing.id)) {
          throw new CoreError(
            "OVER_APPLICATION_LIMIT",
            `${listing.company} · ${listing.title} ${ev.label}. Nothing was picked. To pick it anyway, ` +
              `ask the job seeker, then repeat the pick with --override-limit ${listing.id}.`,
            { listing_id: listing.id, limit: ev.limit, counted: ev.existing },
          );
        }
        overridden.set(listing.id, ev.label);
      }
      world.applications.push({
        id: `pending-${listing.id}`,
        origin: "picked",
        listing: listing.id,
        company: listing.company,
        employer: listing.employer ?? null,
        title: listing.title,
        status: "picked",
        event_log: [{ at, to: "picked" }],
      } as unknown as StoredRecord);
    }
    const created: StoredRecord[] = [];
    const updated: StoredRecord[] = [];
    for (const listing of listings) {
      const fit = (listing.screen as { fit?: { score: number; band: string } }).fit;
      const entry: EventLogEntry = {
        at,
        stage: "screen",
        from: null,
        to: "picked",
        reason:
          `Picked from the Shortlist${fit ? ` (Fit ${fit.score} ${fit.band})` : ""}.` +
          (overridden.has(listing.id)
            ? ` Application-limit override: it ${overridden.get(listing.id)}.`
            : ""),
        approval: {
          id: approval.id,
          checkpoint: approval.checkpoint,
          approved_at: approval.approved_at,
          action,
        },
      };
      const app = await w.put("application", randomUUID(), {
        origin: "picked",
        listing: listing.id,
        company: listing.company,
        employer: listing.employer ?? null,
        title: listing.title,
        status: "picked",
        event_log: [entry],
        gmail_threads: [],
        answers: [],
        fill_plan: null,
        tailor: null,
        decision_tree: treePath(listing.id),
      });
      created.push(app);
      const overrides = overridden.has(listing.id)
        ? [
            ...(Array.isArray(listing.overrides) ? listing.overrides : []),
            { kind: "application_limit", at, label: overridden.get(listing.id) },
          ]
        : listing.overrides;
      updated.push(
        await w.put("listing", listing.id, { ...listing, application_id: app.id, overrides }),
      );
    }
    await writeTrees(dataDir, updated, created);
    return { applications: created };
  });
}

/** Every Application, keyed by the Listing it pursues (External applications have none). */
export async function applicationsByListing(dataDir: string): Promise<Map<string, StoredRecord>> {
  const apps = await listRecords(dataDir, "application");
  return new Map(
    apps.filter((a) => typeof a.listing === "string").map((a) => [a.listing as string, a]),
  );
}
