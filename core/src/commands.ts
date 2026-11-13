// The command registry. Each later ticket adds its commands here, implemented in its own module.
import type { Command } from "./cli.ts";
import { ensureSafeDataDir } from "./data-dir.ts";
import { CoreError, usageError } from "./errors.ts";
import { endRun, readRunLock, startRun } from "./lock.ts";
import { httpGet } from "./net.ts";
import { initPreferences, loadPreferences, setPreference, settingPaths } from "./preferences.ts";
import { assertProfileComplete, checkProfile, putProfile, readProfile } from "./profile.ts";
import { importResume } from "./resume.ts";
import { assertRecordType, getRecord, listRecords, notFound, withWriter } from "./store.ts";

export const commands: Record<string, Command> = {
  help: {
    usage: "help",
    summary: "List every command.",
    run: async () => ({}),
  },

  status: {
    usage: "status",
    summary: "Report whether the Profile is complete and what the job seeker should do next.",
    async run({ dataDir }) {
      const check = await checkProfile(dataDir);
      const run = await readRunLock(dataDir);
      const base = { profile: check.state, run: run ?? null, data_dir: dataDir };
      if (check.state === "missing") {
        return {
          ...base,
          next: "setup",
          message: "No Profile found. Run /job-butler:setup to build one from your resume.",
        };
      }
      if (check.state === "incomplete") {
        return {
          ...base,
          next: "setup",
          missing: check.missing,
          problems: check.problems,
          message: "Your Profile isn't complete. Run /job-butler:setup to finish it.",
        };
      }
      return { ...base, next: null };
    },
  },

  init: {
    usage: "init",
    summary:
      "Create the private data directory, git-ignoring it inside a git project; refuse if it is unsafe.",
    run: async ({ dataDir }) => ({ data_dir: dataDir, ...(await ensureSafeDataDir(dataDir)) }),
  },

  fetch: {
    usage: "fetch <url>",
    summary: "Fetch a public URL (e.g. a portfolio page) and print its status and body.",
    async run({ args }) {
      const [url] = args;
      if (url === undefined) throw usageError("fetch: <url> is required");
      return { ...(await httpGet(url)) };
    },
  },

  // Low-level pipeline-state access. Stage tickets add domain commands (e.g. "listing
  // upsert") that validate their input and call the store module directly.
  "record put": {
    usage: "record put <type> <id> --input <file>|-",
    summary: "Create or replace one pipeline record from a JSON object.",
    async run(ctx) {
      const [typeArg, id] = ctx.args;
      const type = assertRecordType(typeArg);
      if (id === undefined) throw usageError("record put: <id> is required");
      const data = await ctx.readInput();
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw usageError("record put: --input must be a JSON object");
      }
      const record = await withWriter(ctx.dataDir, "record put", (w) =>
        w.put(type, id, data as Record<string, unknown>),
      );
      return { record };
    },
  },

  "record get": {
    usage: "record get <type> <id>",
    summary: "Print one pipeline record.",
    async run(ctx) {
      const [typeArg, id] = ctx.args;
      const type = assertRecordType(typeArg);
      if (id === undefined) throw usageError("record get: <id> is required");
      const record = await getRecord(ctx.dataDir, type, id);
      if (record === undefined) throw notFound(type, id);
      return { record };
    },
  },

  "record list": {
    usage: "record list <type>",
    summary: "Print every pipeline record of one type, sorted by id.",
    async run(ctx) {
      const type = assertRecordType(ctx.args[0]);
      return { records: await listRecords(ctx.dataDir, type) };
    },
  },

  "run start": {
    usage: "run start <stage>",
    summary:
      "Stage entry gate: check the Profile is complete, validate Preferences, and take the run " +
      "lock for this session (joining the run if this session already holds it).",
    async run({ args, dataDir }) {
      const stage = args[0];
      if (stage === undefined || !STAGES.includes(stage)) {
        throw usageError(`run start: <stage> must be one of: ${STAGES.join(", ")}`);
      }
      await assertProfileComplete(dataDir);
      const preferences = await loadPreferences(dataDir);
      await ensureSafeDataDir(dataDir);
      const { run, joined } = await startRun(dataDir, stage);
      return { run_id: run.run_id, joined, run, preferences };
    },
  },

  "run end": {
    usage: "run end --run <run_id>",
    summary: "Release the run lock taken by `run start` (only when run_id matches).",
    async run({ dataDir, flags }) {
      const id = flags.run;
      if (id === undefined) throw usageError("run end: --run <run_id> is required");
      return { released: await endRun(dataDir, id) };
    },
  },

  "run status": {
    usage: "run status",
    summary: "Show the run in progress, if any (a stale run lock is reported as none).",
    run: async ({ dataDir }) => ({ run: (await readRunLock(dataDir)) ?? null }),
  },

  "profile check": {
    usage: "profile check",
    summary: "Report whether the Profile is missing, incomplete or complete, and what's missing.",
    run: async ({ dataDir }) => ({ ...(await checkProfile(dataDir)) }),
  },

  "profile get": {
    usage: "profile get [--section <name>]",
    summary: "Print the Profile, or one section of it, as JSON.",
    async run({ dataDir, flags }) {
      const profile = await readProfile(dataDir);
      if (profile === undefined) {
        throw new CoreError("NOT_FOUND", "There's no Profile yet. Run /job-butler:setup.");
      }
      if (flags.section !== undefined) return { section: profile[flags.section as never] ?? null };
      return { profile };
    },
  },

  "profile put": {
    usage: "profile put [--section <name>] --input <file>|-",
    summary:
      "Setup only: write the whole Profile, or replace one section. Refuses invalid values " +
      "and refuses while a run is in progress.",
    async run(ctx) {
      const input = await ctx.readInput();
      return { ...(await putProfile(ctx.dataDir, input, ctx.flags.section)) };
    },
  },

  "resume import": {
    usage: "resume import <file>",
    summary:
      "Setup: keep a copy of the resume (PDF, DOCX or text) in the data directory and print " +
      "its text (null for a PDF: read that with the Read tool).",
    async run({ args, dataDir }) {
      const [file] = args;
      if (file === undefined) throw usageError("resume import: <file> is required");
      return { ...(await importResume(dataDir, file)) };
    },
  },

  "preferences init": {
    usage: "preferences init",
    summary: "Create Preferences with every default written out (no change if they exist).",
    run: async ({ dataDir }) => ({ ...(await initPreferences(dataDir)) }),
  },

  "preferences get": {
    usage: "preferences get",
    summary: "Validate and print Preferences, with the names of the settings that can change.",
    run: async ({ dataDir }) => ({
      preferences: await loadPreferences(dataDir),
      settings: settingPaths(),
    }),
  },

  "preferences set": {
    usage: "preferences set <setting> <value>",
    summary:
      "Change one setting (e.g. schedule.enabled true). Refuses while a run is in progress " +
      "and refuses a value that would make Preferences invalid.",
    async run({ args, dataDir }) {
      const [key, value] = args;
      if (key === undefined || value === undefined) {
        throw usageError("preferences set: <setting> and <value> are required");
      }
      return { preferences: await setPreference(dataDir, key, value) };
    },
  },
};

/** What `run start` accepts: the orchestrator ("pipeline") or one Stage. */
const STAGES = ["pipeline", "discover", "screen", "tailor", "apply", "track"];
