// Approval records and standing grants: what the Approval hook (hook.ts) checks before an
// outward tool or a Checkpoint write runs. See docs/agents/core-conventions.md, "Approval".
//
//  - An Approval is the job seeker's yes at one Checkpoint. The Stage skill records it
//    (`approval record`) only after that yes. It lists the exact actions it covers; each
//    action is spent the first time the hook lets it through, and the whole Approval
//    expires with the Claude Code session that recorded it.
//  - A standing grant (`<data>/grants.json`) covers one gated tool or command across
//    sessions until revoked. Sensitive and destructive grants expire with their session.
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { listRecords, type StoredRecord, withWriter, writeThenReplace } from "./store.ts";

/** The three Checkpoints, with the name the job seeker sees. */
export const CHECKPOINTS = {
  "shortlist-pick": "Shortlist pick",
  "digest-status": "digest Status changes",
  handover: "Handover",
} as const;
export type Checkpoint = keyof typeof CHECKPOINTS;

/**
 * Core commands that change pipeline state at a Checkpoint. The hook lets one through only
 * when an unspent Approval in this session lists the exact action (the command and its
 * positional arguments). The Stage ticket that builds a command registers it here.
 */
export const CHECKPOINT_COMMANDS: Record<string, Checkpoint> = {
  "application pick": "shortlist-pick",
  "application status": "digest-status",
  "application submitted": "handover",
};

export type GrantKind = "standing" | "sensitive" | "destructive";

/**
 * Core commands that are gated outside the Checkpoints: they run only under a grant.
 * Register destructive commands (delete, prune, overwrite) and anything that shares
 * personal data off the machine here, with their kind.
 */
export const GATED_COMMANDS: Record<string, GrantKind> = {
  prune: "destructive",
  "record delete": "destructive",
};

/** Outward connector tools the hook governs: default-deny within these namespaces. */
export const GOVERNED_TOOL_PREFIXES = [
  "mcp__claude_ai_Gmail__",
  "mcp__claude_ai_Google_Calendar__",
];

/**
 * Playwright tools that act on a page (click, type, press a key, run code). While Apply runs
 * the core fills the form and the job seeker clicks Submit, so the hook blocks these (#45).
 * Reading tools (snapshot, screenshot, tabs) are left alone.
 */
export const BROWSER_PREFIXES = ["mcp__plugin_playwright_playwright__", "mcp__playwright__"];
export const BROWSER_ACTING_TOOLS = new Set([
  "browser_click",
  "browser_drag",
  "browser_drop",
  "browser_evaluate",
  "browser_file_upload",
  "browser_fill_form",
  "browser_handle_dialog",
  "browser_press_key",
  "browser_run_code_unsafe",
  "browser_select_option",
  "browser_type",
]);

export function isActingBrowserTool(tool: string): boolean {
  const prefix = BROWSER_PREFIXES.find((p) => tool.startsWith(p));
  return prefix !== undefined && BROWSER_ACTING_TOOLS.has(tool.slice(prefix.length));
}

/** The read-only allowlist: the only governed tools that run without a grant. */
export const READ_ONLY_TOOLS = new Set([
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__get_message",
  "mcp__claude_ai_Gmail__list_labels",
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__search_events",
  "mcp__claude_ai_Google_Calendar__get_event",
  "mcp__claude_ai_Google_Calendar__list_calendars",
]);

export function isGovernedTool(tool: string): boolean {
  return GOVERNED_TOOL_PREFIXES.some((p) => tool.startsWith(p));
}

const DESTRUCTIVE_WORDS = new Set(["delete", "trash", "prune", "overwrite", "remove"]);
const SENSITIVE_WORDS = new Set(["send", "reply", "forward", "draft", "respond", "share"]);
// Calendar writes with attendees send invitations: they share data off the machine.
const SENSITIVE_TOOLS = new Set(["create_event", "update_event"]);

/** A grant's kind follows from its scope; the caller never chooses it. */
export function grantKind(scope: string): GrantKind {
  const fromCommand = GATED_COMMANDS[scope];
  if (fromCommand !== undefined) return fromCommand;
  const name = scope.slice(scope.lastIndexOf("__") + 2);
  const words = name.split("_");
  if (words.some((w) => DESTRUCTIVE_WORDS.has(w))) return "destructive";
  if (words.some((w) => SENSITIVE_WORDS.has(w)) || SENSITIVE_TOOLS.has(name)) return "sensitive";
  return "standing";
}

/** "application  pick a" -> "application pick a" */
export function normaliseAction(action: string): string {
  return action.trim().split(/\s+/).join(" ");
}

/** The registered command an action starts with (longest match), if any. */
export function commandOf(action: string, registry: Record<string, unknown>): string | undefined {
  const words = normaliseAction(action).split(" ");
  for (let n = words.length; n > 0; n--) {
    const candidate = words.slice(0, n).join(" ");
    if (candidate in registry) return candidate;
  }
  return undefined;
}

function noSession(what: string): CoreError {
  return new CoreError(
    "NO_SESSION",
    `Can't ${what} without the Claude Code session it belongs to. ` +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the skill substitution, verbatim
      'Pass --session "${CLAUDE_SESSION_ID}" (or set JOB_BUTLER_SESSION_ID).',
  );
}

// ---------------------------------------------------------------------------------------
// Approvals: pipeline records of type "approval".

export interface ApprovalAction {
  action: string;
  spent_at: string | null;
}

export interface ApprovalRecord extends StoredRecord {
  checkpoint: Checkpoint;
  session_id: string;
  approved_at: string;
  actions: ApprovalAction[];
}

export async function recordApproval(
  dataDir: string,
  checkpointArg: string | undefined,
  input: unknown,
  session: string | undefined,
): Promise<ApprovalRecord> {
  if (!(checkpointArg !== undefined && checkpointArg in CHECKPOINTS)) {
    throw usageError(
      `Unknown Checkpoint "${checkpointArg}". Expected one of: ${Object.keys(CHECKPOINTS).join(", ")}`,
    );
  }
  const checkpoint = checkpointArg as Checkpoint;
  if (session === undefined) throw noSession("record an Approval");
  const actions = (input as { actions?: unknown } | null)?.actions;
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    !actions.every((a) => typeof a === "string" && a.trim() !== "")
  ) {
    throw usageError('approval record: --input must be {"actions": ["<command> <args>", ...]}');
  }
  const normalised = [...new Set((actions as string[]).map(normaliseAction))];
  for (const action of normalised) {
    const command = commandOf(action, CHECKPOINT_COMMANDS);
    if (command === undefined || CHECKPOINT_COMMANDS[command] !== checkpoint) {
      throw new CoreError(
        "ACTION_NOT_AT_CHECKPOINT",
        `"${action}" isn't an action the ${CHECKPOINTS[checkpoint]} Checkpoint covers, so the ` +
          "Approval wasn't recorded. Ask again for the actions this Checkpoint lists.",
        { action, checkpoint },
      );
    }
  }
  const id = randomUUID();
  const approvedAt = timestamp();
  return (await withWriter(dataDir, "approval record", (w) =>
    w.put("approval", id, {
      checkpoint,
      session_id: session,
      approved_at: approvedAt,
      actions: normalised.map((action) => ({ action, spent_at: null })),
    }),
  )) as ApprovalRecord;
}

/** Every Approval record. Throws APPROVAL_UNREADABLE when one can't be read. */
export async function readApprovals(dataDir: string): Promise<ApprovalRecord[]> {
  try {
    return (await listRecords(dataDir, "approval")) as ApprovalRecord[];
  } catch (e) {
    throw new CoreError(
      "APPROVAL_UNREADABLE",
      `Couldn't read the Approval records in ${join(dataDir, "pipeline", "approval")} ` +
        `(${(e as Error).message}).`,
    );
  }
}

export type ApprovalState = "active" | "spent" | "expired";

export function approvalState(a: ApprovalRecord, session: string | undefined): ApprovalState {
  if (a.actions.every((x) => x.spent_at !== null)) return "spent";
  return a.session_id === session ? "active" : "expired";
}

export type SpendResult =
  | { ok: true; approval: ApprovalRecord }
  | { ok: false; why: "none" | "spent" | "expired" };

/**
 * Spend `action` from the earliest unspent Approval for its Checkpoint in this session.
 * Runs under the pipeline lock so two tool calls can't spend the same action.
 */
export async function spendApproval(
  dataDir: string,
  session: string,
  checkpoint: Checkpoint,
  action: string,
): Promise<SpendResult> {
  return withWriter(dataDir, "approval spend", async (w) => {
    const matching = (await readApprovals(dataDir))
      .filter((a) => a.checkpoint === checkpoint && a.actions.some((x) => x.action === action))
      .sort((a, b) => (a.approved_at < b.approved_at ? -1 : 1));
    const usable = matching.find(
      (a) => a.session_id === session && a.actions.some((x) => x.action === action && !x.spent_at),
    );
    if (usable === undefined) {
      if (matching.some((a) => a.session_id === session)) return { ok: false, why: "spent" };
      return { ok: false, why: matching.length > 0 ? "expired" : "none" };
    }
    const spentAt = timestamp();
    const { schema_version: _v, id, created_at: _c, updated_at: _u, ...fields } = usable;
    const updated = (await w.put("approval", id, {
      ...fields,
      actions: usable.actions.map((x) =>
        x.action === action && !x.spent_at ? { ...x, spent_at: spentAt } : x,
      ),
    })) as ApprovalRecord;
    return { ok: true, approval: updated };
  });
}

/**
 * The Approval that covered `action` most recently, for a Checkpoint command's Event log
 * entry. The hook spends the action just before the command runs.
 */
export async function approvalUsedFor(
  dataDir: string,
  action: string,
): Promise<ApprovalRecord | undefined> {
  const wanted = normaliseAction(action);
  let best: { a: ApprovalRecord; at: string } | undefined;
  for (const a of await readApprovals(dataDir)) {
    for (const x of a.actions) {
      if (x.action === wanted && x.spent_at && (!best || x.spent_at > best.at)) {
        best = { a, at: x.spent_at };
      }
    }
  }
  return best?.a;
}

// ---------------------------------------------------------------------------------------
// Standing grants: <data>/grants.json

export interface Grant {
  id: string;
  scope: string;
  kind: GrantKind;
  granted_at: string;
  session_id: string;
  revoked_at: string | null;
  uses: number;
  last_used_at: string | null;
}

interface GrantsFile {
  schema_version: number;
  grants: Grant[];
}

export function grantsPath(dataDir: string): string {
  return join(dataDir, "grants.json");
}

/** Every grant, revoked ones included. Throws GRANTS_UNREADABLE when the file is damaged. */
export async function readGrants(dataDir: string): Promise<Grant[]> {
  let text: string;
  try {
    text = await readFile(grantsPath(dataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw grantsUnreadable(dataDir, (e as Error).message);
  }
  try {
    const parsed = JSON.parse(text) as GrantsFile;
    if (!Array.isArray(parsed.grants)) throw new Error("no grants list");
    return parsed.grants;
  } catch (e) {
    throw grantsUnreadable(dataDir, (e as Error).message);
  }
}

function grantsUnreadable(dataDir: string, why: string): CoreError {
  return new CoreError(
    "GRANTS_UNREADABLE",
    `Couldn't read your standing grants in ${grantsPath(dataDir)} (${why}).`,
  );
}

async function writeGrants(dataDir: string, grants: Grant[]): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file: GrantsFile = { schema_version: 1, grants };
  await writeThenReplace(grantsPath(dataDir), `${JSON.stringify(file, null, 2)}\n`);
}

export type GrantState = "active" | "revoked" | "expired";

export function grantState(g: Grant, session: string | undefined): GrantState {
  if (g.revoked_at !== null) return "revoked";
  if (g.kind !== "standing" && g.session_id !== session) return "expired";
  return "active";
}

export async function addGrant(
  dataDir: string,
  scopeArg: string | undefined,
  session: string | undefined,
): Promise<Grant> {
  if (scopeArg === undefined || scopeArg.trim() === "") {
    throw usageError("grant add: <scope> is required");
  }
  const scope = normaliseAction(scopeArg);
  if (commandOf(scope, CHECKPOINT_COMMANDS) !== undefined) {
    throw new CoreError(
      "CHECKPOINT_NEEDS_APPROVAL",
      `"${scope}" happens at a Checkpoint, so it needs your Approval each time and can't be a ` +
        "standing grant.",
    );
  }
  const gatedTool = isGovernedTool(scope) && !READ_ONLY_TOOLS.has(scope);
  if (!gatedTool && !(scope in GATED_COMMANDS)) {
    throw new CoreError(
      "GRANT_SCOPE_UNKNOWN",
      `"${scope}" isn't something Job Butler blocks, so there's nothing to grant. ` +
        "A grant names one outward tool or one gated command exactly.",
    );
  }
  if (session === undefined) throw noSession("record a grant");
  const grant: Grant = {
    id: randomUUID(),
    scope,
    kind: grantKind(scope),
    granted_at: timestamp(),
    session_id: session,
    revoked_at: null,
    uses: 0,
    last_used_at: null,
  };
  await withWriter(dataDir, "grant add", async () => {
    await writeGrants(dataDir, [...(await readGrants(dataDir)), grant]);
  });
  return grant;
}

export async function revokeGrant(dataDir: string, id: string | undefined): Promise<Grant> {
  if (id === undefined) throw usageError("grant revoke: <id> is required");
  return withWriter(dataDir, "grant revoke", async () => {
    const grants = await readGrants(dataDir);
    const grant = grants.find((g) => g.id === id);
    if (grant === undefined) {
      throw new CoreError("NOT_FOUND", `No standing grant with id "${id}".`, { id });
    }
    grant.revoked_at ??= timestamp();
    await writeGrants(dataDir, grants);
    return grant;
  });
}

/**
 * Use the active grant for `scope` in this session, counting the use. Returns undefined
 * when no active grant covers it.
 */
export async function useGrant(
  dataDir: string,
  scope: string,
  session: string,
): Promise<Grant | undefined> {
  const covering = (await readGrants(dataDir)).some(
    (g) => g.scope === scope && grantState(g, session) === "active",
  );
  if (!covering) return undefined;
  return withWriter(dataDir, "grant use", async () => {
    const grants = await readGrants(dataDir);
    const grant = grants.find((g) => g.scope === scope && grantState(g, session) === "active");
    if (grant === undefined) return undefined;
    grant.uses += 1;
    grant.last_used_at = timestamp();
    await writeGrants(dataDir, grants);
    return grant;
  });
}
