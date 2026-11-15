// Status moves (#67, D1): the one place an Application's Status changes. A Status move appends
// its Event log entry and redraws the Listing's Decision tree in the same write, so the tree
// never lags the Application. Creating an Application with its first Status is not a Status
// move (see pickListings and createExternal in application.ts and external-create.ts). This
// module makes no transition rules: each caller decides which moves are allowed.
import type { EventApproval, EventLogEntry, EventMessage, Status } from "./application.ts";
import { writeTrees } from "./decision-tree.ts";
import { timestamp } from "./env.ts";
import { getRecord, type StoredRecord, type StoreWriter } from "./store.ts";

export interface StatusMove {
  /** The Stage that made the change: track, apply, tailor, ... */
  stage: string;
  to: Status;
  reason: string;
  /** The Approval the change cites, for a Checkpoint command; null otherwise. */
  approval?: EventApproval | null;
  /** The mail that prompted the change (Track). */
  message?: EventMessage;
  /** When the change happened. Defaults to now. */
  at?: string;
  /** Other Application fields written in the same write as the Status. */
  changes?: Record<string, unknown>;
}

/**
 * Move an Application to `move.to`: append the Event log entry (from its current Status),
 * write the Application, and redraw its Listing's Decision tree. Call inside the same
 * `withWriter` as the rest of the command's writes. Returns the saved Application, whose last
 * Event log entry is the one this move wrote.
 */
export async function moveStatus(
  dataDir: string,
  w: StoreWriter,
  app: StoredRecord,
  move: StatusMove,
): Promise<StoredRecord> {
  const entry: EventLogEntry = {
    at: move.at ?? timestamp(),
    stage: move.stage,
    from: app.status as Status,
    to: move.to,
    reason: move.reason,
    approval: move.approval ?? null,
    ...(move.message ? { message: move.message } : {}),
  };
  const { id: _i, created_at: _c, updated_at: _u, schema_version: _s, ...fields } = app;
  const saved = await w.put("application", app.id, {
    ...fields,
    ...move.changes,
    status: move.to,
    event_log: [...((app.event_log as EventLogEntry[] | undefined) ?? []), entry],
  });
  await redrawTree(dataDir, saved);
  return saved;
}

/**
 * Redraw the Decision tree of the Application's Listing from the stored records. A Status move
 * calls it; so does any write that changes an Application without moving its Status, so the
 * tree stays as it was before.
 */
export async function redrawTree(dataDir: string, application: StoredRecord): Promise<void> {
  const listing =
    typeof application.listing === "string"
      ? await getRecord(dataDir, "listing", application.listing)
      : undefined;
  if (listing !== undefined) await writeTrees(dataDir, [listing], [application]);
}
