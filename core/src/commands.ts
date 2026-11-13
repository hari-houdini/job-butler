// The command registry. Each later ticket adds its commands here, implemented in its own module.
import type { Command } from "./cli.ts";
import { ensureSafeDataDir } from "./data-dir.ts";
import { usageError } from "./errors.ts";
import { httpGet } from "./net.ts";
import { profileState } from "./profile.ts";
import { assertRecordType, getRecord, listRecords, notFound, withWriter } from "./store.ts";

export const commands: Record<string, Command> = {
  help: {
    usage: "help",
    summary: "List every command.",
    run: async () => ({}),
  },

  status: {
    usage: "status",
    summary: "Report whether a Profile exists and what the job seeker should do next.",
    async run({ dataDir }) {
      const profile = await profileState(dataDir);
      if (profile === "missing") {
        return {
          profile,
          next: "setup",
          message: "No Profile found. Run /job-butler setup to build one from your resume.",
          data_dir: dataDir,
        };
      }
      return { profile, next: null, data_dir: dataDir };
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
};
