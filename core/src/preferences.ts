// Preferences: <data dir>/preferences.yaml, how Job Butler runs. Created at setup with every
// default written out. Not pipeline state, so no Checkpoint; but it never changes while a
// run holds the run lock, and every run validates it at start and stops on any bad value
// (a missing or unknown key is a bad value too: nothing silently falls back to a default).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CoreError, usageError } from "./errors.ts";
import { withEditLock, writeThenReplace } from "./store.ts";
import { boolean, integer, isObject, object, oneOf, type Problems } from "./validate.ts";
import { parseYaml, stringifyYaml, YamlError } from "./yaml.ts";

export const PREFERENCES_DEFAULTS = {
  schema_version: 1,
  schedule: {
    enabled: false,
    track: { every_hours: 2, from: "08:00", until: "20:00" },
    discover_screen: { at: "08:00" },
  },
  notifications: { desktop: true },
  external_applications: { enabled: false, backfill_months: 6 },
  application_limits: {
    default_reapply_cooldown: { count: 1, window_months: 6, scope: "same_role" },
  },
};

const COMMENTS: Record<string, string> = {
  schema_version: "Format version of this file. Leave it at 1.",
  schedule:
    "Runs inside an open Claude Code session only. A scheduled run never crosses a Checkpoint\n" +
    "and skips its turn when another session is running.",
  "schedule.enabled": "true to run on a schedule; false runs only when you start it.",
  "schedule.track": "Track (mail and calendar) every few hours during the day, local time.",
  "schedule.discover_screen": "Discover + Screen once each morning at this local time.",
  "notifications.desktop":
    "Desktop notification after a scheduled run, only when something needs you.",
  external_applications:
    "Track applications you made outside Job Butler. Turning it on reads back over the\n" +
    "backfill window once.",
  "application_limits.default_reapply_cooldown":
    "Used when neither your note nor the advert states a limit: at most `count`\n" +
    "Applications in `window_months` for the same role (or the whole company).",
};

export function preferencesPath(dataDir: string): string {
  return join(dataDir, "preferences.yaml");
}

function serialise(prefs: unknown): string {
  return (
    "# Job Butler Preferences: how Job Butler runs. Every setting is written out.\n" +
    "# Change them with /job-butler preferences (refused while a run is in progress) or by\n" +
    "# hand; every run checks this file and stops on a bad value.\n" +
    stringifyYaml(prefs, COMMENTS)
  );
}

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function time(v: unknown, path: string, p: Problems): boolean {
  if (typeof v !== "string" || !TIME_RE.test(v)) {
    p.push(`${path} must be a 24-hour time like "08:00" (got ${JSON.stringify(v)})`);
    return false;
  }
  return true;
}

/** Every problem with the file's values, including missing and unknown keys. */
export function preferencesProblems(v: unknown): Problems {
  const p: Problems = [];
  const root = object(v, "preferences", Object.keys(PREFERENCES_DEFAULTS), p);
  if (!root) return p;
  if (root.schema_version !== 1)
    p.push(`schema_version must be 1 (got ${JSON.stringify(root.schema_version)})`);

  const s = object(root.schedule, "schedule", ["enabled", "track", "discover_screen"], p);
  if (s) {
    boolean(s.enabled, "schedule.enabled", p);
    const t = object(s.track, "schedule.track", ["every_hours", "from", "until"], p);
    if (t) {
      integer(t.every_hours, "schedule.track.every_hours", p, 1, 24);
      const ok = time(t.from, "schedule.track.from", p) && time(t.until, "schedule.track.until", p);
      if (ok && (t.from as string) >= (t.until as string)) {
        p.push(
          `schedule.track.from (${t.from}) must be earlier than schedule.track.until (${t.until})`,
        );
      }
    }
    const d = object(s.discover_screen, "schedule.discover_screen", ["at"], p);
    if (d) time(d.at, "schedule.discover_screen.at", p);
  }

  const n = object(root.notifications, "notifications", ["desktop"], p);
  if (n) boolean(n.desktop, "notifications.desktop", p);

  const e = object(
    root.external_applications,
    "external_applications",
    ["enabled", "backfill_months"],
    p,
  );
  if (e) {
    boolean(e.enabled, "external_applications.enabled", p);
    integer(e.backfill_months, "external_applications.backfill_months", p, 1, 24);
  }

  const l = object(root.application_limits, "application_limits", ["default_reapply_cooldown"], p);
  if (l) {
    const at = "application_limits.default_reapply_cooldown";
    const c = object(l.default_reapply_cooldown, at, ["count", "window_months", "scope"], p);
    if (c) {
      integer(c.count, `${at}.count`, p, 1, 100);
      integer(c.window_months, `${at}.window_months`, p, 1, 60);
      oneOf(c.scope, `${at}.scope`, ["same_role", "company"], p);
    }
  }
  // Report missing keys too: `object` only flags unknown ones.
  addMissing(PREFERENCES_DEFAULTS, root, "", p);
  return p;
}

function addMissing(
  defaults: object,
  actual: Record<string, unknown>,
  path: string,
  p: Problems,
): void {
  for (const [k, d] of Object.entries(defaults)) {
    const at = path ? `${path}.${k}` : k;
    if (!(k in actual)) {
      if (!p.some((x) => x.startsWith(`${at} `))) p.push(`${at} is missing`);
    } else if (isObject(d) && isObject(actual[k])) {
      addMissing(d, actual[k] as Record<string, unknown>, at, p);
    }
  }
}

async function readRaw(dataDir: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(preferencesPath(dataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return parseYaml(text);
  } catch (e) {
    if (!(e instanceof YamlError)) throw e;
    throw invalid(dataDir, [e.message]);
  }
}

function invalid(dataDir: string, problems: Problems): CoreError {
  return new CoreError(
    "PREFERENCES_INVALID",
    `Your Preferences (${preferencesPath(dataDir)}) have invalid values, so nothing ran: ` +
      `${problems.join("; ")}. Fix them with /job-butler preferences or by hand.`,
    { path: preferencesPath(dataDir), problems },
  );
}

/** Read and validate Preferences; every run calls this at start. Never fills in defaults. */
export async function loadPreferences(dataDir: string): Promise<typeof PREFERENCES_DEFAULTS> {
  const raw = await readRaw(dataDir);
  if (raw === undefined) {
    throw new CoreError(
      "PREFERENCES_MISSING",
      `There's no Preferences file (${preferencesPath(dataDir)}). Run /job-butler:setup to create it.`,
      { path: preferencesPath(dataDir) },
    );
  }
  const problems = preferencesProblems(raw);
  if (problems.length > 0) throw invalid(dataDir, problems);
  return raw as typeof PREFERENCES_DEFAULTS;
}

/** Create the file with every default written out, unless it already exists. */
export async function initPreferences(dataDir: string): Promise<{ created: boolean }> {
  return withEditLock(dataDir, "preferences init", "your Preferences", async () => {
    if ((await readRaw(dataDir)) !== undefined) return { created: false };
    await writeThenReplace(preferencesPath(dataDir), serialise(PREFERENCES_DEFAULTS));
    return { created: true };
  });
}

/** The leaf settings a job seeker can change, as dotted paths. */
export function settingPaths(v: object = PREFERENCES_DEFAULTS, path = ""): string[] {
  return Object.entries(v).flatMap(([k, d]) => {
    const at = path ? `${path}.${k}` : k;
    if (at === "schema_version") return [];
    return isObject(d) ? settingPaths(d, at) : [at];
  });
}

/** Change one setting. The whole file must be valid afterwards or nothing is written. */
export async function setPreference(
  dataDir: string,
  key: string,
  valueText: string,
): Promise<typeof PREFERENCES_DEFAULTS> {
  if (!settingPaths().includes(key)) {
    throw usageError(`Unknown setting "${key}". Settings: ${settingPaths().join(", ")}`);
  }
  let value: unknown;
  try {
    value = parseYaml(`v: ${valueText}`);
    value = (value as { v: unknown }).v;
  } catch {
    value = valueText;
  }
  return withEditLock(dataDir, "preferences set", "your Preferences", async () => {
    const raw = await readRaw(dataDir);
    if (raw === undefined) {
      throw new CoreError(
        "PREFERENCES_MISSING",
        `There's no Preferences file (${preferencesPath(dataDir)}). Run /job-butler:setup to create it.`,
      );
    }
    const next = structuredClone(raw) as Record<string, unknown>;
    const parts = key.split(".");
    let cur: Record<string, unknown> = next;
    for (const part of parts.slice(0, -1)) {
      if (!isObject(cur[part])) cur[part] = {};
      cur = cur[part] as Record<string, unknown>;
    }
    cur[parts.at(-1) as string] = value;
    const problems = preferencesProblems(next);
    if (problems.length > 0) {
      throw new CoreError(
        "PREFERENCES_INVALID",
        `Preferences weren't changed: ${problems.join("; ")}.`,
        { problems },
      );
    }
    await writeThenReplace(preferencesPath(dataDir), serialise(next));
    return next as typeof PREFERENCES_DEFAULTS;
  });
}
