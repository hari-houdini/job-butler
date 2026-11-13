# Core conventions

How the plugin and the deterministic core are laid out, set by ticket #30. Follow these when adding a Stage, a command or a test; change them here when you change them in code.

## Layout

```
.claude-plugin/   plugin.json + marketplace.json (repo root is the plugin root)
skills/<name>/    SKILL.md per skill; skills/job-butler is the /job-butler entry point
agents/           worker subagents, one per Stage (add when the first one lands)
hooks/hooks.json  the Approval PreToolUse hook and a SessionStart hook; both call the core
core/src/         the TypeScript core: cli.ts (entry), commands.ts (registry), one module per concern
core/test/        *.test.ts, harness.ts, fixtures/
```

## Runtime: Node type stripping, no build, no runtime dependencies

- The core is plain `.ts` run directly by Node (>= 22.18) through built-in type stripping. There is no build step and no `dist/`.
- Write erasable TypeScript only (no `enum`, `namespace` or constructor parameter properties) and import local files with their `.ts` extension. `tsc --noEmit` (`erasableSyntaxOnly`) enforces both.
- A plugin install copies the repo without running `npm install`, so the core has **no runtime dependencies**. Dev dependencies (TypeScript, Biome, `@types/node`) are fine. A ticket that truly needs a runtime package (Playwright for Apply, DOCX/PDF rendering for Tailor) must decide how it gets installed and record that here.
- Skills call the core as `node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]`.

## CLI

- Commands are words, longest match wins: `status`, `init`, `fetch <url>`, `record put|get|list`. Add a command by adding an entry to `core/src/commands.ts` that calls a module in `core/src/`. Name multi-word commands `<noun> <verb>` (e.g. `listing upsert`, `lock status`).
- **Output:** exactly one JSON object on stdout, nothing else. Use snake_case keys. (Exception: `hook ...` commands set `raw: true` and print Claude Code's hook JSON instead.)
  - success: `{"ok": true, ...}`, exit 0
  - refusal: `{"ok": false, "error": {"code": "LOCKED", "message": "..."}}`, exit 1. Throw `CoreError(code, message, details?)`; codes are SCREAMING_SNAKE. `message` is for the job seeker: what happened and what to do. Skills relay it as written.
  - usage: `usageError(...)`, code `USAGE`, exit 2. Unexpected crash: code `INTERNAL`, exit 70.
- **Input:** structured input, including every LLM judgment, is JSON passed with `--input <file>` or `--input -` (stdin). Flags take string values; add new ones to `flagOptions` in `cli.ts`.
- **Environment** (all read in `core/src/env.ts`):
  - `JOB_BUTLER_DATA_DIR`: the data directory (or `--data-dir`; default `~/.job-butler`).
  - `JOB_BUTLER_NOW`: fixes the clock (ISO 8601). Always read time through `now()` / `timestamp()`.
  - `JOB_BUTLER_NETWORK_FIXTURES`: serve fetches from recorded responses.
  - `JOB_BUTLER_GH`: the `gh` executable.
  - `JOB_BUTLER_FAULT`: fault injection for tests (`crash-before-replace`).
  - `JOB_BUTLER_SESSION_ID`: the Claude Code session (or `--session`). The SessionStart hook exports it to Bash through `CLAUDE_ENV_FILE`; read it with `sessionId()`.

## Data directory and pipeline store (ADR 0001)

- Profile at `<data>/profile.yaml`. Pipeline records at `<data>/pipeline/<type>/<encodeURIComponent(id)>.json`. Types: `listing`, `application`, `employer`, `discover-run`, `sync`, `approval` (add new ones to `RECORD_TYPES` in `store.ts`). Standing grants live in `<data>/grants.json`; session marks in `<data>/sessions/`.
- The store sets `schema_version` (1), `id`, `created_at` and `updated_at` (ISO 8601 UTC) on every record; callers pass only the record's own fields. Every other timestamp you store is ISO 8601 UTC from `timestamp()` too.
- Write only through `withWriter(dataDir, command, fn)`: it runs the data-directory safety checks, takes the lock, clears temp files left by an interrupted write, and releases the lock. Put all of one command's writes in one `withWriter` call, and prefer one CLI call per batch over one call per record (each call re-runs the git and `gh` checks).
- Any other file you write into the data directory (Preferences, grants, rendered pages) goes through `writeThenReplace` and, if it is pipeline state, inside `withWriter`.
- **Lock file contract:** `<data>/pipeline.lock` holds `{"pid", "hostname", "acquired_at", "command"}`. A lock whose `hostname` is this machine and whose `pid` is gone is stale and gets cleared; any other lock refuses with `LOCKED`. The lock is held for one CLI call. A run-level lock (Preferences refusing mid-run, scheduled runs skipping a turn) is not built yet: that ticket decides which process owns it and records it here.
- **Safety** (`data-dir.ts`, run by `init` and every write): inside a git project the directory is appended to the project's `.gitignore` and any tracked file in it refuses with `DATA_DIR_TRACKED`; if the directory is itself a repo root, writes refuse with `DATA_DIR_REPO_NOT_PRIVATE` unless `gh repo view --json isPrivate` says private.

## Approval (ticket #32)

Two layers: the Stage skill asks at the Checkpoint, and the PreToolUse hook (`hook pre-tool-use`, code in `core/src/hook.ts`, rules in `core/src/approval.ts`) blocks what no Approval or grant covers. The hook only ever denies; when it doesn't block it prints `{}`, so Claude Code's own permission rules still apply. Anything it can't decide (unreadable tool call, Approval record, grants file or session mark) denies, with a reason Claude relays. If the core can't run at all, the `hooks.json` command exits 2, which also blocks.

### What the hook gates

- **Checkpoint commands:** core CLI calls listed in `CHECKPOINT_COMMANDS` (`approval.ts`). Today: `application pick` → `shortlist-pick`, `application status` → `digest-status`, `application submitted` → `handover`. The hook finds each `core/src/cli.ts` invocation in a Bash command, takes its positional arguments (flags dropped) as the **action**, e.g. `application status app-1 interview`, and needs an unspent Approval in this session that lists that exact action. It spends the action as it lets the call through. Shell substitution (`$(…)`, backticks, `eval`, `xargs`) or `$VAR` in the command words is denied.
- **Gated commands:** `GATED_COMMANDS` maps a core command to its grant kind (`standing`, `sensitive`, `destructive`). These run only under an active grant. Empty today; #53 registers `prune` and delete commands as `destructive`.
- **Connector tools** (`mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`): default-deny with the `READ_ONLY_TOOLS` allowlist, but only in sessions where Job Butler has run (a core call or a `job-butler` Skill call marks the session in `<data>/sessions/`). Other sessions are left alone so the plugin doesn't take over the job seeker's mailbox everywhere. Anything not on the allowlist needs an active grant.
- **Write, Edit, MultiEdit, NotebookEdit** into `<data>/pipeline/`, `<data>/sessions/`, `grants.json` or `pipeline.lock`: always denied. Only the core changes those.

### How a Stage skill requests and records an Approval (#34, #45, #48)

1. Build the Checkpoint command so its targets are **positional arguments**, not inside `--input` (the hook can't see file contents). One action is the command plus all its positionals: `application pick greenhouse:acme:123`. Register the command in `CHECKPOINT_COMMANDS` with its Checkpoint.
2. At the Checkpoint, show the job seeker exactly what will happen and ask. No yes, no record.
3. After their yes, record it, listing every action you will run:
   ```sh
   node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" approval record shortlist-pick \
     --session "${CLAUDE_SESSION_ID}" --input - <<< '{"actions": ["application pick greenhouse:acme:123", "application pick lever:beta:9"]}'
   ```
   `--session` may be left out when `JOB_BUTLER_SESSION_ID` is set. Actions from another Checkpoint refuse with `ACTION_NOT_AT_CHECKPOINT`; no session refuses with `NO_SESSION`.
4. Run each action as its own written-out core command. Each is allowed once; a second run, or a run in a later session, is denied (`already used` / `has expired`), and you must ask again.
5. In the command's Event log entry, cite the Approval: `approvalUsedFor(dataDir, action)` returns the record whose action the hook just spent (its `id`, `checkpoint`, `approved_at`).

Approval record (`pipeline/approval/<uuid>.json`): `checkpoint`, `session_id`, `approved_at`, `actions: [{action, spent_at}]`. `approval list [--session]` shows each as `active`, `spent` or `expired`.

### Standing grants

- `grant add <scope> --session <id>` after the job seeker asks for one; `grant list [--session]`; `grant revoke <id>`. A scope is one gated tool name or one `GATED_COMMANDS` entry, exactly. Checkpoint commands refuse (`CHECKPOINT_NEEDS_APPROVAL`): autonomy is off in v1. Read-only or ungated scopes refuse (`GRANT_SCOPE_UNKNOWN`).
- The core sets `kind` from the scope: words like delete, trash, prune, overwrite, remove → `destructive`; send, reply, forward, draft, respond, share, `create_event`, `update_event` → `sensitive`; else `standing`. Sensitive and destructive grants work only in the session that recorded them. Revoked grants stay in the file with `revoked_at`.
- On each reuse the hook counts it (`uses`, `last_used_at`) and tells the job seeker through `systemMessage`, naming the grant and how to revoke it.
- File: `<data>/grants.json` = `{"schema_version": 1, "grants": [{id, scope, kind, granted_at, session_id, revoked_at, uses, last_used_at}]}`, written under the lock.

### Testing it

Drive `hook pre-tool-use` with the PreToolUse JSON on stdin (`session_id`, `tool_name`, `tool_input`) and read `hookSpecificOutput.permissionDecision` (`"deny"`, else not blocked). See `core/test/approval.test.ts`.

## Network

Every fetch goes through `httpGet` in `core/src/net.ts`. With `JOB_BUTLER_NETWORK_FIXTURES` set, it answers from `<dir>/manifest.json` (`{"<url>": {"status", "content_type", "file"}}`) and refuses unknown URLs with `NETWORK_FIXTURE_MISSING`. Loopback URLs are always live.

## Tests

- Runner: `node:test` with `node:assert/strict`. Scripts: `npm test`, `npm run typecheck`, `npm run lint` (Biome), `npm run check` (all three; must pass before you commit). `npm run format` fixes formatting.
- Tests drive the CLI through `runCli(args, { dataDir, input, env })` from `core/test/harness.ts` and assert on the JSON result, exit code and files in the data directory. Never import `core/src` from a test.
- Use `tempDir(t)` for a data directory and `git(cwd, ...)` for git repos (both isolated from your own config). `runCli` defaults: network from `core/test/fixtures/network`, `gh` from `core/test/fixtures/gh/unavailable`, clock at `2026-01-15T09:00:00.000Z`.
- Fixture boundaries:
  - **Network:** add the recorded file to `core/test/fixtures/network/` and its URL to `manifest.json`. Record real responses; trim them, don't invent fields.
  - **LLM judgments:** JSON files in `core/test/fixtures/judgments/`, passed with `--input judgment("<name>")`.
  - **Browser:** pages in `core/test/fixtures/browser/`, served by `serveBrowserFixtures(t)` on 127.0.0.1.
  - **gh:** executable scripts in `core/test/fixtures/gh/`, selected with `env: { JOB_BUTLER_GH }`.
- Fault injection: check `fault("<name>")` from `env.ts` at the point to interrupt; tests set `JOB_BUTLER_FAULT`.
