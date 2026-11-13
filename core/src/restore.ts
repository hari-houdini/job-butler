// Restoring an excluded Listing (#39): `show excluded` and `restore <name>`.
//
// Screen cuts the Checks after an exclusion off ("not reached") but still runs them and keeps
// the real results in `screen.after_exclusion`, with the Fit score. Restoring records an
// override on the Listing (`overrides: [{kind: "restore", check, at}]`), swaps those results
// in for the "not reached" ones and puts the Listing back on the Shortlist at its fit position
// with a "Restored" badge, so it stays visibly flagged. A deny-listed Listing can't be
// restored: only editing the Profile changes the deny list. See core-conventions.md.
import { treePath, writeTrees } from "./decision-tree.ts";
import { timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { type Check, marksFor } from "./screen-check.ts";
import { getRecord, listRecords, type StoredRecord, withWriter } from "./store.ts";
import { isObject } from "./validate.ts";

interface ScreenData {
  outcome: "shortlist" | "excluded";
  excluded_by: string | null;
  checks: Check[];
  after_exclusion?: Check[];
  [field: string]: unknown;
}

interface Override {
  kind: string;
  check?: string;
  at?: string;
}

/** The check that decides a deny-listed Listing; never restorable. */
const DENY_CHECK = "deny.list";

function screenOf(listing: StoredRecord): ScreenData | undefined {
  return isObject(listing.screen) ? (listing.screen as ScreenData) : undefined;
}

function overridesOf(listing: StoredRecord): Override[] {
  return Array.isArray(listing.overrides) ? (listing.overrides as Override[]) : [];
}

/** The screen of an excluded Listing after a restore: on the Shortlist, flagged with a badge. */
export function applyRestore(screen: ScreenData): ScreenData {
  const excluding = screen.checks.find((c) => c.check === screen.excluded_by);
  const after = screen.after_exclusion ?? [];
  const checks = screen.checks.map((c) =>
    c.status === "not_reached" ? (after.find((a) => a.check === c.check) ?? c) : c,
  );
  const { after_exclusion: _dropped, ...rest } = screen;
  return {
    ...rest,
    outcome: "shortlist",
    excluded_by: null,
    checks,
    flags: marksFor(checks, "flag"),
    badges: [
      ...marksFor(checks, "badge"),
      ...(excluding ? [{ check: excluding.check, label: `Restored: ${excluding.name}` }] : []),
    ],
  };
}

/** After a rescore: an exclusion the job seeker already overruled stays overruled. */
export function reapplyRestore(listing: StoredRecord, screen: ScreenData): ScreenData {
  if (screen.outcome !== "excluded") return screen;
  const restored = overridesOf(listing).some(
    (o) => o.kind === "restore" && o.check === screen.excluded_by,
  );
  return restored ? applyRestore(screen) : screen;
}

function isExcluded(l: StoredRecord): boolean {
  return screenOf(l)?.outcome === "excluded" && l.gone !== true && !l.application_id;
}

export async function showExcluded(dataDir: string) {
  const excluded = (await listRecords(dataDir, "listing")).filter(isExcluded).map((l) => {
    const screen = screenOf(l) as ScreenData;
    const by = screen.checks.find((c) => c.check === screen.excluded_by);
    return {
      id: l.id,
      company: String(l.company),
      title: String(l.title),
      location: (l.location as string | null) ?? null,
      excluded_by: screen.excluded_by,
      check: by?.name ?? screen.excluded_by,
      reasons: by?.evidence ?? [],
      restorable: screen.excluded_by !== DENY_CHECK,
    };
  });
  const lines = [`EXCLUDED (${excluded.length})`];
  for (const e of excluded) {
    lines.push(`  ${e.company} · ${e.title}${e.location ? ` · ${e.location}` : ""}`);
    lines.push(`    ${e.check}${e.restorable ? "" : " (change your deny list to restore)"}`);
    for (const r of e.reasons) lines.push(`    ${r}`);
    if (e.restorable) lines.push(`    reply: restore ${e.company} ${e.title}`);
  }
  return { excluded, text: lines.join("\n") };
}

function resolve(listings: StoredRecord[], words: string[]): StoredRecord {
  const name = words.join(" ").trim().toLowerCase();
  if (name === "") throw usageError("restore: give the Listing's name (company and title) or ID");
  const excluded = listings.filter(isExcluded);
  const exact = excluded.filter((l) => l.id.toLowerCase() === name);
  const found =
    exact.length > 0
      ? exact
      : excluded.filter((l) => `${l.company} ${l.title}`.toLowerCase().includes(name));
  if (found.length === 0) {
    throw new CoreError("NOT_FOUND", `No excluded Listing matches "${words.join(" ")}".`);
  }
  if (found.length > 1) {
    throw new CoreError(
      "AMBIGUOUS_NAME",
      `"${words.join(" ")}" matches ${found.length} excluded Listings; use the Listing ID: ` +
        found.map((l) => `${l.company} · ${l.title} (${l.id})`).join("; "),
      { listing_ids: found.map((l) => l.id) },
    );
  }
  return found[0] as StoredRecord;
}

export async function restoreListing(dataDir: string, words: string[]) {
  return withWriter(dataDir, "restore", async (w) => {
    const listings = await listRecords(dataDir, "listing");
    const listing = resolve(listings, words);
    const screen = screenOf(listing) as ScreenData;
    if (screen.excluded_by === DENY_CHECK) {
      throw new CoreError(
        "DENY_LISTED",
        `${listing.company} · ${listing.title} is on your deny list. Deny-listed Listings stay ` +
          "excluded; edit your deny list in your Profile to change that.",
        { listing_id: listing.id },
      );
    }
    const override: Override = {
      kind: "restore",
      check: screen.excluded_by as string,
      at: timestamp(),
    };
    const restored: StoredRecord = {
      ...listing,
      screen: applyRestore(screen),
      overrides: [...overridesOf(listing), override],
      decision_tree: treePath(listing.id),
    };
    await w.put("listing", listing.id, restored);
    await writeTrees(
      dataDir,
      [(await getRecord(dataDir, "listing", listing.id)) as StoredRecord],
      await listRecords(dataDir, "application"),
    );
    return { restored: listing.id, override };
  });
}
