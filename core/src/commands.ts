// The command registry. Each later ticket adds its commands here, implemented in its own module.
import {
  addGrant,
  approvalState,
  grantState,
  readApprovals,
  readGrants,
  recordApproval,
  revokeGrant,
} from "./approval.ts";
import type { Command } from "./cli.ts";
import { ensureSafeDataDir } from "./data-dir.ts";
import { sessionId } from "./env.ts";
import { usageError } from "./errors.ts";
import { preToolUse, sessionStart } from "./hook.ts";
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

  // Approval (docs/agents/core-conventions.md, "Approval").
  "approval record": {
    usage: 'approval record <checkpoint> --session <id> --input {"actions": [...]}',
    summary:
      "Record the job seeker's yes at a Checkpoint (shortlist-pick, digest-status, handover), " +
      "listing the exact core commands it covers. Only after their yes in the session.",
    async run(ctx) {
      const input = await ctx.readInput();
      const session = sessionId(ctx.flags.session);
      return { approval: await recordApproval(ctx.dataDir, ctx.args[0], input, session) };
    },
  },

  "approval list": {
    usage: "approval list [--session <id>]",
    summary: "Print every Approval with its state in this session: active, spent or expired.",
    async run(ctx) {
      const session = sessionId(ctx.flags.session);
      const approvals = await readApprovals(ctx.dataDir);
      return { approvals: approvals.map((a) => ({ ...a, state: approvalState(a, session) })) };
    },
  },

  "grant add": {
    usage: "grant add <scope> --session <id>",
    summary:
      "Record a standing grant for one gated tool or command, after the job seeker asks for " +
      "it. Sensitive and destructive grants expire with the session.",
    async run(ctx) {
      return { grant: await addGrant(ctx.dataDir, ctx.args[0], sessionId(ctx.flags.session)) };
    },
  },

  "grant list": {
    usage: "grant list [--session <id>]",
    summary: "Print every standing grant with its state: active, revoked or expired.",
    async run(ctx) {
      const session = sessionId(ctx.flags.session);
      const grants = await readGrants(ctx.dataDir);
      return { grants: grants.map((g) => ({ ...g, state: grantState(g, session) })) };
    },
  },

  "grant revoke": {
    usage: "grant revoke <id>",
    summary: "Revoke a standing grant.",
    run: async (ctx) => ({ grant: await revokeGrant(ctx.dataDir, ctx.args[0]) }),
  },

  // Claude Code hooks (hooks/hooks.json). They print Claude Code's hook JSON, not {"ok"}.
  "hook pre-tool-use": {
    usage: "hook pre-tool-use < <PreToolUse JSON>",
    summary: "The Approval hook: deny a tool call that no Approval or grant covers.",
    raw: true,
    run: async (ctx) => preToolUse(await ctx.readStdin(), ctx.flags["data-dir"]),
  },

  "hook session-start": {
    usage: "hook session-start < <SessionStart JSON>",
    summary: "Export the session id to later Bash calls as JOB_BUTLER_SESSION_ID.",
    raw: true,
    run: async (ctx) => sessionStart(await ctx.readStdin()),
  },
};
