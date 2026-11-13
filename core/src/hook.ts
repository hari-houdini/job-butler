// The Approval hook: Claude Code runs `hook pre-tool-use` before every tool call that
// hooks/hooks.json matches. It is the second layer behind the Stage skills' instructions:
//
//  - Checkpoint commands (core CLI calls registered in CHECKPOINT_COMMANDS) run only when an
//    unspent Approval in this session lists the exact action; the hook spends it.
//  - Gated core commands (GATED_COMMANDS) run only under an active grant.
//  - Gmail and Calendar connector tools are default-deny in a Job Butler session: the
//    read-only allowlist runs, anything else needs an active grant.
//  - Write, Edit and NotebookEdit may never touch pipeline state, grants or session marks.
//
// Output is Claude Code's hook JSON. The hook only ever denies; when it doesn't block, it
// prints {} (or a systemMessage reporting a reused grant) so Claude Code's own permission
// rules still apply. Any failure to decide denies (fails closed) and says why.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  CHECKPOINT_COMMANDS,
  CHECKPOINTS,
  commandOf,
  GATED_COMMANDS,
  type Grant,
  grantsPath,
  isGovernedTool,
  READ_ONLY_TOOLS,
  spendApproval,
  useGrant,
} from "./approval.ts";
import { resolveDataDir, timestamp } from "./env.ts";
import { CoreError } from "./errors.ts";
import { lockPath } from "./lock.ts";

export type HookOutput = Record<string, unknown>;

interface ToolCall {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

const NO_OPINION: HookOutput = {};

function deny(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Job Butler blocked this: ${reason}`,
    },
  };
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Decide one PreToolUse call. Never throws: anything unexpected denies. */
export async function preToolUse(rawInput: string, dataDirFlag: string | undefined) {
  try {
    let call: ToolCall;
    try {
      call = JSON.parse(rawInput) as ToolCall;
    } catch {
      return deny("the tool call it was given couldn't be read, so it can't check it.");
    }
    const tool = typeof call.tool_name === "string" ? call.tool_name : "";
    const input = (call.tool_input ?? {}) as Record<string, unknown>;
    const session = typeof call.session_id === "string" ? call.session_id : "";
    const cwd = typeof call.cwd === "string" ? call.cwd : process.cwd();
    const dataDir = resolveDataDir(dataDirFlag);

    if (FILE_TOOLS.has(tool)) return fileTool(dataDir, cwd, input);
    if (tool === "Bash") return await bashTool(dataDir, session, String(input.command ?? ""));
    if (tool === "Skill" && /job-butler/.test(String(input.skill ?? ""))) {
      if (session !== "") await markSession(dataDir, session);
      return NO_OPINION;
    }
    if (isGovernedTool(tool)) return await connectorTool(dataDir, session, tool);
    return NO_OPINION;
  } catch (e) {
    const why = e instanceof CoreError ? e.message : `the check failed (${(e as Error).message}).`;
    return deny(`${why} Nothing was run. Fix the problem above, then try again.`);
  }
}

// ---------------------------------------------------------------------------------------

function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fileTool(dataDir: string, cwd: string, input: Record<string, unknown>): HookOutput {
  const target = input.file_path ?? input.notebook_path;
  if (typeof target !== "string") return NO_OPINION;
  const file = resolve(cwd, target);
  const protectedPaths = [
    join(dataDir, "pipeline"),
    join(dataDir, "sessions"),
    grantsPath(dataDir),
    lockPath(dataDir),
  ];
  if (protectedPaths.some((p) => inside(p, file))) {
    return deny(
      `${file} is Job Butler's pipeline state, grants or session record, which only the core ` +
        "may change. Use the Job Butler command for the change instead.",
    );
  }
  return NO_OPINION;
}

// ---------------------------------------------------------------------------------------
// Bash: find each core CLI invocation and check the ones that need an Approval or a grant.

const OPERATORS = new Set([";", "&", "&&", "|", "||", "\n", "(", ")"]);

/** A small shell tokenizer: quotes removed, operators as their own tokens. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  const push = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const stop = end === -1 ? command.length : end;
      current += command.slice(i + 1, stop);
      started = true;
      i = stop;
    } else if (c === "\\" && i + 1 < command.length) {
      current += command[++i];
      started = true;
    } else if (c === " " || c === "\t") {
      push();
    } else if (";&|\n()".includes(c)) {
      push();
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        tokens.push(two);
        i++;
      } else tokens.push(c);
    } else {
      current += c;
      started = true;
    }
  }
  push();
  return tokens;
}

interface Invocation {
  positionals: string[];
  dataDir: string | undefined;
}

function coreInvocations(command: string): Invocation[] {
  const tokens = tokenize(command);
  const found: Invocation[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!/(^|[/\\])core[/\\]src[/\\]cli\.ts$/.test(tokens[i] as string)) continue;
    const inv: Invocation = { positionals: [], dataDir: undefined };
    // A JOB_BUTLER_DATA_DIR=... assignment earlier in the same simple command.
    for (let j = i - 1; j >= 0 && !OPERATORS.has(tokens[j] as string); j--) {
      const m = /^JOB_BUTLER_DATA_DIR=(.*)$/.exec(tokens[j] as string);
      if (m) inv.dataDir = m[1];
    }
    for (let j = i + 1; j < tokens.length && !OPERATORS.has(tokens[j] as string); j++) {
      const t = tokens[j] as string;
      if (t.startsWith("--")) {
        const [flag, value] = t.includes("=") ? t.split(/=(.*)/s) : [t, tokens[++j]];
        if (flag === "--data-dir") inv.dataDir = value;
      } else inv.positionals.push(t);
    }
    found.push(inv);
  }
  return found;
}

async function bashTool(dataDir: string, session: string, command: string): Promise<HookOutput> {
  if (!/cli\.ts/.test(command)) return NO_OPINION;
  const invocations = coreInvocations(command);
  if (invocations.length === 0) return NO_OPINION;
  if (/\$\(|`|\beval\b|\bxargs\b/.test(command)) {
    return deny(
      "it runs the Job Butler core through shell substitution, so the Approval hook can't " +
        "read which command it is. Run the core command on its own, with its arguments written out.",
    );
  }
  const reports: string[] = [];
  for (const inv of invocations) {
    const dir = inv.dataDir === undefined ? dataDir : resolve(inv.dataDir);
    if (session !== "") await markSession(dir, session);
    if (inv.positionals.slice(0, 3).some((p) => p.includes("$"))) {
      return deny(
        "the core command is built from shell variables, so the Approval hook can't read it. " +
          "Write the command and its arguments out in full.",
      );
    }
    const action = inv.positionals.join(" ");
    const checkpointCommand = commandOf(action, CHECKPOINT_COMMANDS);
    if (checkpointCommand !== undefined) {
      const checkpoint = CHECKPOINT_COMMANDS[checkpointCommand] as keyof typeof CHECKPOINTS;
      const name = CHECKPOINTS[checkpoint];
      if (session === "") return deny(noSessionReason(`"${action}"`));
      const spent = await spendApproval(dir, session, checkpoint, action);
      if (!spent.ok) {
        const why = {
          none: `there's no Approval for "${action}" at the ${name} Checkpoint.`,
          spent: `your Approval for "${action}" at the ${name} Checkpoint was already used.`,
          expired: `your Approval for "${action}" at the ${name} Checkpoint was given in an earlier session and has expired.`,
        }[spent.why];
        return deny(
          `${why} Ask the job seeker at the ${name} Checkpoint, and record their yes with ` +
            `\`approval record ${checkpoint}\` before running it.`,
        );
      }
      continue;
    }
    const gated = commandOf(action, GATED_COMMANDS);
    if (gated !== undefined) {
      if (session === "") return deny(noSessionReason(`"${action}"`));
      const grant = await useGrant(dir, gated, session);
      if (grant === undefined) return deny(noGrantReason(gated));
      reports.push(grantReport(grant));
    }
  }
  return reports.length > 0 ? { systemMessage: reports.join("\n") } : NO_OPINION;
}

// ---------------------------------------------------------------------------------------
// Connector tools: default-deny with the read-only allowlist, in Job Butler sessions.

async function connectorTool(dataDir: string, session: string, tool: string): Promise<HookOutput> {
  if (session === "" || !(await isMarked(dataDir, session))) return NO_OPINION;
  if (READ_ONLY_TOOLS.has(tool)) return NO_OPINION;
  const grant = await useGrant(dataDir, tool, session);
  if (grant === undefined) return deny(noGrantReason(tool));
  return { systemMessage: grantReport(grant) };
}

function noGrantReason(scope: string): string {
  return (
    `${scope} acts outside the machine or can't be undone, and no Approval or standing grant ` +
    `covers it. Ask the job seeker; if they agree, record it with \`grant add ${scope}\`.`
  );
}

function noSessionReason(what: string): string {
  return `${what} needs an Approval, and Claude Code didn't say which session this is.`;
}

function grantReport(g: Grant): string {
  const lasts =
    g.kind === "standing" ? "it lasts until you revoke it" : "it expires when this session ends";
  return (
    `Job Butler used your standing grant for ${g.scope} (given ${g.granted_at.slice(0, 10)}, ` +
    `${g.kind}; ${lasts}). Revoke it with \`grant revoke ${g.id}\`.`
  );
}

// ---------------------------------------------------------------------------------------
// Session marks: <data>/sessions/<session id>.json records that Job Butler ran in a
// session, which puts the connector tools under the hook for the rest of it.

function sessionFile(dataDir: string, session: string): string {
  return join(dataDir, "sessions", `${encodeURIComponent(session)}.json`);
}

async function isMarked(dataDir: string, session: string): Promise<boolean> {
  try {
    await readFile(sessionFile(dataDir, session), "utf8");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CoreError(
      "SESSION_UNREADABLE",
      `couldn't tell whether Job Butler is running in this session (${(e as Error).message}).`,
    );
  }
}

async function markSession(dataDir: string, session: string): Promise<void> {
  if (await isMarked(dataDir, session)) return;
  await mkdir(join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
  await writeFile(
    sessionFile(dataDir, session),
    `${JSON.stringify({ schema_version: 1, session_id: session, started_at: timestamp() })}\n`,
  );
}

// ---------------------------------------------------------------------------------------

/**
 * SessionStart: export the session id to later Bash calls through CLAUDE_ENV_FILE, so core
 * commands that record Approvals and grants know their session without a --session flag.
 */
export async function sessionStart(rawInput: string): Promise<HookOutput> {
  const envFile = process.env.CLAUDE_ENV_FILE;
  let session: unknown;
  try {
    session = (JSON.parse(rawInput) as ToolCall).session_id;
  } catch {
    return NO_OPINION;
  }
  if (envFile && typeof session === "string" && /^[\w.-]+$/.test(session)) {
    const existing = await readFile(envFile, "utf8").catch(() => "");
    const lead = existing === "" || existing.endsWith("\n") ? "" : "\n";
    await writeFile(envFile, `${existing}${lead}export JOB_BUTLER_SESSION_ID=${session}\n`);
  }
  return NO_OPINION;
}
