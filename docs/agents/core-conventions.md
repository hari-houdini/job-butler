# Core conventions

How the plugin and the deterministic core are laid out, set by ticket #30. Follow these when adding a Stage, a command or a test; change them here when you change them in code.

## Layout

```
.claude-plugin/   plugin.json + marketplace.json (repo root is the plugin root)
skills/<name>/    SKILL.md per skill; skills/job-butler is the /job-butler entry point
agents/           worker subagents, <stage>-worker.md (see "Stage skills and worker subagents")
hooks/hooks.json  the Approval PreToolUse hook and a SessionStart hook; both call the core
core/src/         the TypeScript core: cli.ts (entry), commands.ts (registry), one module per concern;
                  boards/ holds one reader per ATS
core/test/        *.test.ts, harness.ts, fixtures/
```

## Runtime: Node type stripping, no build, no runtime dependencies

- The core is plain `.ts` run directly by Node (>= 22.18) through built-in type stripping. There is no build step and no `dist/`.
- Write erasable TypeScript only (no `enum`, `namespace` or constructor parameter properties) and import local files with their `.ts` extension. `tsc --noEmit` (`erasableSyntaxOnly`) enforces both.
- A plugin install copies the repo without running `npm install`, so the core has **no runtime dependencies**. Dev dependencies (TypeScript, Biome, `@types/node`) are fine. A ticket that truly needs a runtime package (Playwright for Apply, DOCX/PDF rendering for Tailor) must decide how it gets installed and record that here.
- Skills call the core as `node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]`.

## CLI

- Commands are words, longest match wins (`help` lists them all): e.g. `status`, `record put|get|list`, `run start|end|status`, `profile put|get|check`, `preferences init|get|set`. Add a command by adding an entry to `core/src/commands.ts` that calls a module in `core/src/`. Name multi-word commands `<noun> <verb>` (e.g. `listing upsert`, `lock status`).
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
  - `JOB_BUTLER_SESSION_PID`: overrides the session process that owns a run (tests stand in another session with a live or dead pid).
  - `JOB_BUTLER_SESSION_ID`: the Claude Code session (or `--session`). The SessionStart hook exports it to Bash through `CLAUDE_ENV_FILE`; read it with `sessionId()`.

## Data directory and pipeline store (ADR 0001)

- Profile at `<data>/profile.yaml`, Preferences at `<data>/preferences.yaml`, resume copies in `<data>/sources/`. Pipeline records at `<data>/pipeline/<type>/<encodeURIComponent(id)>.json`. Types: `listing`, `application`, `employer`, `discover-run`, `sync`, `approval` (add new ones to `RECORD_TYPES` in `store.ts`). Standing grants live in `<data>/grants.json`; session marks in `<data>/sessions/`. Decision trees in `<data>/decision-trees/<encodeURIComponent(listing id)>.mmd` (see "Decision tree"). `<data>/inbox/` holds files a skill writes with the Write tool to pass a worker's JSON to the core (`--input <file>`); the hook allows Write there, unlike `pipeline/`.
- The store sets `schema_version` (1), `id`, `created_at` and `updated_at` (ISO 8601 UTC) on every record; callers pass only the record's own fields. Every other timestamp you store is ISO 8601 UTC from `timestamp()` too.
- Write only through `withWriter(dataDir, command, fn)`: it runs the data-directory safety checks, takes the lock, clears temp files left by an interrupted write, and releases the lock. Put all of one command's writes in one `withWriter` call, and prefer one CLI call per batch over one call per record (each call re-runs the git and `gh` checks).
- Any other file you write into the data directory (Preferences, grants, rendered pages) goes through `writeThenReplace` and, if it is pipeline state, inside `withWriter`; a file that must not change mid-run (Profile, Preferences) goes inside `withEditLock`.
- **Lock file contract:** two files with the same JSON shape `{"pid", "hostname", "acquired_at", "command"}` and the same stale rule: a lock whose `hostname` is this machine and whose `pid` is gone is stale and gets cleared; any other lock refuses with `LOCKED`.
  - `<data>/pipeline.lock` is held for one CLI call that writes (`withWriter`, `withEditLock`); its `pid` is the CLI process.
  - `<data>/run.lock` adds `run_id` and is held for a whole run, from `run start <stage>` to `run end --run <run_id>`. Its `pid` is the **Claude Code session**: the nearest ancestor of the CLI process that isn't a shell or wrapper (`sessionPid()` in `lock.ts`), so it survives between CLI calls and goes stale when the session exits.
  - While a run is held: pipeline writes from **another** session refuse (`withWriter`); the running session writes normally. Profile and Preferences writes refuse from **every** session, the running one included (`withEditLock`).
  - `run start` in a session that already holds the run returns `joined: true` and the same `run_id`; only the caller that got `joined: false` calls `run end`. A scheduled run (#52) calls `run start` and treats `LOCKED` as "skip this turn".
- **Safety** (`data-dir.ts`, run by `init` and every write): inside a git project the directory is appended to the project's `.gitignore` and any tracked file in it refuses with `DATA_DIR_TRACKED`; if the directory is itself a repo root, writes refuse with `DATA_DIR_REPO_NOT_PRIVATE` unless `gh repo view --json isPrivate` says private.

## Stage entry gate, Profile and Preferences

- Every Stage entry point (the `/job-butler` orchestrator and each Stage skill) starts with `run start <stage>` (`pipeline`, `discover`, `screen`, `tailor`, `apply`, `track`) and ends with `run end`. `run start` refuses `PROFILE_INCOMPLETE` / `PROFILE_INVALID` (send the job seeker to `/job-butler:setup`), `PREFERENCES_MISSING` / `PREFERENCES_INVALID`, or `LOCKED`, in that order. On success it returns the validated `preferences`, so a Stage reads them from there and never applies defaults of its own.
- Profile (`profile.ts`): human-editable YAML, written only through `profile put [--section <name>]` (setup). Sections: `identity`, `base_resume`, `targets`, `sponsorship`, `filters` (with `target_companies`), `autonomy`, `answer_bank`, plus `companies_house_key`. Validation refuses unknown keys, so a new field means adding it to the section's check. Completeness rules live in `missingFields`. Read it with `profile get [--section]`.
- Preferences (`preferences.ts`): every setting written out by `preferences init`; changed by `preferences set <dotted.setting> <value>`. A missing, unknown or out-of-range setting is `PREFERENCES_INVALID`, never a default. Add a setting by adding it to `PREFERENCES_DEFAULTS`, `preferencesProblems` and (optionally) `COMMENTS`. Rewriting the file regenerates its comments; hand-written comments are not kept.
- YAML (`yaml.ts`) is a small dependency-free subset: block mappings and sequences, comments, quoted and plain scalars, `[a, b]`, and `|` / `>` block text. Anything else refuses with its line number.

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

## Stage skills and worker subagents (set by #33)

- A Stage skill lives at `skills/<stage>/SKILL.md`, user-invoked (`disable-model-invocation: true`), and the `/job-butler` skill routes its Stage name to it by reading that file. Its shape: `run start <stage>` → the Stage's core commands → report → `run end --run <run_id>` unless `joined` was true. Run `run end` on every exit after a successful `run start`. Relay `error.message` as written.
- The skill owns all conversation and every pipeline write; each write is one core command per batch (`discover boards` writes a whole run in one `withWriter`).
- A **worker subagent** (`agents/<stage>-worker.md`) does only the Stage's LLM judgments. It has no outward tools and no Bash, so it can neither write pipeline state nor fetch: give it `tools: Read` at most, and the cheapest `model` that fits (haiku for extraction and classification, sonnet for rating and tailoring). The round trip: a core command returns the material to judge as JSON → the skill dispatches the worker with that JSON in the prompt (the worker reads nothing else, so Profile data reaches it only when the judgment needs it) → the worker returns one JSON object → the skill passes it to the core with `--input -`, which validates it and writes. Store each judgment's fixture in `core/test/fixtures/judgments/`.
- When the judgment JSON can carry free text (quotes from adverts, resume facts), the skill writes the worker's reply with the Write tool to a file under `<data>/inbox/` and passes `--input <file>`, rather than a heredoc: a backtick or `$(` in the text would make the Approval hook deny the Bash call.
- One worker per Stage, shared by every judgment of that Stage: a later check that needs an LLM judgment adds its own section to the worker's per-Listing object and its instructions to the worker file (see "Screen check pipeline").
- `agents/screen-worker.md` (#34) is the first worker: sonnet, `tools: Read`, one batch dispatch per Screen run.
- Discover has no worker yet: reading boards needs no judgment. The first Discover judgment (#37's "same job?" confirmation or #38's LinkedIn matching) adds `agents/discover-worker.md` in this shape.

## Discover (set by #33)

`discover boards` reads every Target company's board, then in one write: creates the Discover run, adds a Sighting to every Listing seen (creating new Listings), and marks gone every Listing missing from a board that was read **successfully** (a failed board marks nothing gone). It returns `discover_run` and `new` (`[{id, company, title, location}]`). Discover's writes need no Approval: none of its commands are in `CHECKPOINT_COMMANDS` or `GATED_COMMANDS`.

### Board readers (`core/src/boards/`)

- `reader.ts` defines the seam: `BoardReader.read(board, {company, target_roles}) → JobPosting[]`. A reader fetches through `httpGet`, normalises, and never writes. It throws `BoardFailure` (a `CoreError`) with `BOARD_NOT_FOUND` (404), `BOARD_UNAVAILABLE` (other non-2xx) or `BOARD_CHANGED_SHAPE` (non-JSON or missing fields); helpers `fetchBoardJson`, `changedShape` and `utc` cover these. Any `CoreError` from a reader, `NETWORK_ERROR` included, fails that source only.
- `index.ts` registers readers in `BOARD_READERS` by ATS and defines `boardId(board)`: `greenhouse:<token>`, `lever:<token>`, `ashby:<token>`, `workday:<tenant>:<site>`. An ATS with no reader is recorded as a `skipped` source with `BOARD_NOT_SUPPORTED`. Add an ATS (#35, #36) by writing `boards/<ats>.ts` and adding it to `BOARD_READERS`; `discover.ts` needs no change.
- `fetchBoardJson(url, what, postBody?)` POSTs `postBody` as JSON when given; `fetchBoard(url, what, postBody?)` returns the body as text (HTML pages) with the same status rules.
- `JobPosting` fields, all present (null or `[]` when the board has none): `source_job_id`, `title` (trimmed), `location`, `url` (the public posting page), `description` (plain text via `htmlToText` in `core/src/html-text.ts`: never HTML), `departments`, `employment_type`, `salary` (as stated, or null), `posted_at` and `deadline` (ISO UTC), and `source_fields` (source-specific scalars):
  - Greenhouse: `internal_job_id`, `requisition_id`, `updated_at`, `offices`.
  - Lever (#35): `team`, `country`, `workplace_type`, `all_locations` (`; `-joined), `apply_url`, and the numeric pay range `salary_min`, `salary_max`, `salary_currency`, `salary_interval` (e.g. `per-year-salary`). `posted_at` is the undocumented `createdAt`. `description` joins the opening, each `lists` entry under its heading, and the closing `additional`.
  - Ashby (#35): `team`, `is_listed`, `is_remote`, `workplace_type`, `secondary_locations` (`; `-joined), `compensation_summary` (equity, bonus too), `apply_url`. `salary` is the salary-only summary, null when the board hides pay. Read with `includeCompensation=true`; board names are case-sensitive.
  - Workday (#36): `hiring_organization`, `external_path`, `locations_text`, `posted_on` (cxs relative text), `remote_type`, `job_location_type`. `salary` is always null; `deadline` is `validThrough` when present.

### Workday (`core/src/boards/workday.ts`, #36)

One cxs search per target role (`POST /wday/cxs/{tenant}/{site}/jobs`, 20 per page, `total` read from the first page only since later pages answer 0; the whole board when there are no roles), deduped by `externalPath`. Each job page is then fetched (4 at a time) and read from its JSON-LD `JobPosting`. `source_job_id` is the JSON-LD `identifier.value` (the requisition ID, e.g. `JR-0110317`); two postings of one requisition keep the first. A cxs page without `jobPostings`/`total`, or a job page with no JSON-LD `JobPosting` (Workday answers a missing job with a 200 page that has none), fails the source with `BOARD_CHANGED_SHAPE`; more than 2,000 matches for one role fails with `BOARD_SEARCH_TOO_BROAD`. Because a Workday board is read through searches, a job that stops matching the target roles (including after the job seeker changes them) is marked gone.

### Board detection (`core/src/boards/detect.ts`, #35)

`board detect <url>` returns `{url, page_url, fetched, boards: [{ats, board, board_id, links, evidence}]}`, most-linked first, with `board` in the Profile's shape. A URL that is itself a board link is recognised without a fetch; otherwise the page is fetched once and every ATS URL in it is collected (hrefs, script and preload links, URLs inside inline JSON, `\/` escapes undone). The URL patterns live in `boardFromUrl`. Empty `boards` means enter the board by hand; an unreadable page refuses `CAREERS_PAGE_UNAVAILABLE`. It writes nothing: setup stores the confirmed board on the Target company with `confirmed_at`.

### Listing record (`pipeline/listing/<id>.json`)

- ID: `<board id>:<source_job_id>`, e.g. `greenhouse:acme:4012345`, kept for life.
- `source` (the ATS), `board` (board ID), `company` (the Target company's name), every `JobPosting` field, plus:
  - `aliases: [{id, url}]`: starts as the Listing's own ID and URL. #37 and #38 add others.
  - `sightings: [{discover_run, alias, seen_at}]`: one per Discover run that saw it, `alias` naming the copy seen.
  - `first_seen_at` (Job Butler's own first Sighting, never changed) and `last_seen_at`. Screen's age is the earlier of `first_seen_at` and `posted_at`, since `posted_at` resets on republish.
  - `gone: boolean`, `gone_at`: set when its board was read and it was missing; cleared when it is seen again.
- A later Sighting refreshes the posting fields and keeps every other field, so Screen results and marks added by later Stages survive Discover.

### Discover run record (`pipeline/discover-run/<uuid>.json`)

`started_at`, `finished_at`, `run_id` (the run lock's, or null), `sources: [{id, ats, company, status: "ok"|"failed"|"skipped", jobs, error: {code, message}|null}]`, `new_listings` and `gone_listings` (Listing IDs), `listings_seen`. The digest (#52) reports every source whose status isn't `ok`.

## Screen (set by #34)

The Screen skill's loop: `screen pending` → one `screen-worker` dispatch → Write the reply to `judgments_file` → `screen record --input <file>` → `screen digest` → replies (`screen why <letter>`, `pick`, `help`). None of these commands needs an Approval except `application pick`.

- `screen pending`: Listings not gone, not picked, and either never screened or marked for rescore; each as `{id, company, title, location, description}`. Plus `profile` (`base_resume`, `targets` only: never identity), `judgment_keys` and `judgments_file`.
- `screen record --input`: `{"judgments": [{"listing_id", "<judgment key>": ...}]}`. Validates every judgment first (`JUDGMENT_INVALID` lists the problems; nothing is written), refuses a Listing already screened (`ALREADY_SCREENED`) or picked (`ALREADY_PICKED`), then in one `withWriter`: runs the pipeline, stores `screen` and `decision_tree` on each Listing, and regenerates **every** screened Listing's tree (so a Listing Discover marked gone shows it). Returns `recorded` plus the digest.
- `screen rescore <id>...|all`: only when the job seeker asks. Sets `screen.rescore_requested_at`, which puts the Listing back in `screen pending`; scores never change otherwise, Profile edits included.
- `screen digest`: `shortlist: [{letter, id, company, title, location, fit, band, flags, badges}]`, `excluded`, `pending`, `text` (the terminal block) and `replies` (`[{reply, does}]`; later tickets add `approve <n>`, `show excluded`, `restore <name>`).
- `screen why <letter|listing id|application id>`: `checks`, `decision_tree` (absolute path) and `text`: one line per Check `<mark> <name padded 22> <result>`, then its rule and evidence lines. Marks: ✓ pass, ! warn, ✗ fail, · not reached.

### Screen check pipeline (`core/src/screen-check.ts`, `SCREEN_STEPS` in `screen.ts`)

- `SCREEN_STEPS` runs in the spec's order on each Listing: scam gate, deny list (#39), ghost score (#39), Sponsorship (#41), **fit** (#34), Application limit (#42). Add a check by writing a `ScreenStep` in its own module and inserting it at its place in `SCREEN_STEPS`; `screen.ts`, the digest and the Decision tree need no change.
- A `ScreenStep` has `id`, `checks` (a `CheckSpec` `{check: "<step>.<name>", name, rule}` per node, in order, used for "not reached"), an optional `judgment: {key, check}` (its section of each Listing's worker judgment and the validator, which pushes plain-words problems), and `run(ctx) → {checks, stored?}`. `ctx` has `listing`, `profile`, `judgment` (its section only) and `now`. `stored` is merged into `listing.screen` (fit stores `fit`; ghost should store `ghost`, and so on). A step that needs more inputs (Employers, Applications, the register) loads them into `StepContext` in `screenRecord`, once per batch.
- A `Check` is `{check, name, rule, result, status, effect, citation, evidence[], label}`:
  - `status`: `pass` | `warn` | `fail` | `not_reached`.
  - `effect`: `exclude` (off the Shortlist; stops the pipeline, later checks become `not_reached`), `flag` (sorts below the fit order, Fit unchanged), `badge` (shown only), or `null` (recorded only, e.g. a failed Fit rule, which already caps the score).
  - `label`: the Shortlist text for a flag or badge (e.g. `ghost: high`); defaults to `<name>: <result>`.
- `listing.screen`: `{screened_at, run_id, outcome: "shortlist"|"excluded", excluded_by, checks, flags: [{check, label}], badges: [{check, label}], rescore_requested_at, fit, ...}`. Flags and badges are collected from Checks with that effect and status `warn` or `fail`.
- **Shortlist** (derived when read, never stored separately): `outcome` is `shortlist`, not `gone`, no Application. **Ranking:** unflagged before flagged, then Fit score descending, then company, title, ID. Letters a…z, then aa, ab…. Overrides (#39 restore, #42 limit override) should record their own Check or Event so the tree shows an override node.

### Fit score (`core/src/fit.ts`)

- Rules from the Profile: **location** (contains one of `targets.locations` or `filters.allow.locations`, or remote/anywhere when `targets.remote`; on `filters.deny.locations` fails; none stated is unknown), **seniority** (title words mapped to the Profile's levels, e.g. senior/sr → senior, graduate/junior → junior; no word is unknown), **target roles** (every non-seniority word of one target role appears in the title; back-end/front-end/full-stack normalised).
- Skills rating (judgment key `skills_rating`): `{summary, criteria: [{criterion, importance: core|nice, match: strong|partial|none, listing_quote, resume_evidence}]}`; `strong`/`partial` need `resume_evidence`.
- Weights, fixed in v1: skills = Σ(importance × match) / Σ importance × 100 with core 2, nice 1, strong 1, partial ½, none 0. Rules = mean of pass 1, unknown ½, fail 0, × 100. Fit = round(0.8 × skills + 0.2 × rules); any failed rule caps it at 49. Bands: 80+ strong, 50–79 partial, <50 weak.
- `screen.fit`: `{score, band, skills_score, rules_score (1 dp), capped, weights, rules: [{rule, result, evidence}], summary, criteria}`. Checks: `fit.location`, `fit.seniority`, `fit.target_roles`, `fit.skills`, `fit.score`; none excludes or flags.

## Application record and Event log (set by #34)

`pipeline/application/<uuid>.json`, written by `core/src/application.ts`:

- `origin` (`picked`; `external` from #50), `listing_id` (null for External), `company`, `title`, `status`, `event_log`, `gmail_threads: []`, `answers: []`, `fill_plan: null`, `tailor: null`, `decision_tree` (the Listing's tree path). The Listing gets `application_id`.
- Status values (`STATUSES`, snake_case keys with display names): `picked`, `tailored`, `ready_to_apply`, `paused`, `handover`, `submitted`, `interview`, `rejected`, `offer`, `withdrawn`, `no_response`.
- Event log entry (append only): `{at, stage, from, to, reason, approval}`; `approval` is `{id, checkpoint, approved_at, action}` for a Checkpoint change, else null.
- `application pick <listing-id>...`: one action covers all the IDs (`application pick <id-1> <id-2>`), one `withWriter`. It refuses `APPROVAL_MISSING` unless `approvalUsedFor` finds the spent Approval for that exact action (so it never runs outside the hook), and all-or-nothing `NOT_FOUND`, `NOT_ON_SHORTLIST` (unscreened, excluded or gone) or `ALREADY_PICKED`. Each new entry cites the Approval. Later Checkpoint commands (`application status`, `application submitted`) follow the same shape: check `approvalUsedFor`, append an entry, rewrite the tree in the same `withWriter`.

## Decision tree (set by #34, `core/src/decision-tree.ts`)

- One `.mmd` per screened Listing at `decision-trees/<encodeURIComponent(id)>.mmd`, path stored as `decision_tree` on the Listing and Application. Generated only from the stored Listing and Application; `writeTrees(dataDir, listings, applications)` rewrites each file in full. Call it inside the same `withWriter` as any change to a Listing's `screen`, `gone` or Application (Discover doesn't call it yet; `screen record` regenerates all trees, so gone shows at the next Screen). #53 deletes the file with the Listing.
- `flowchart TD`: root `L` (company, title, location; class `src`) → one node per Check in order, id `c_<check with dots as _>`, label `<b>name</b><br/><small>rule</small><br/>→ result<br/><i>citation</i>`. Classes: pass `ok`; not reached `nr` (dashed edges after the cut-off); fail with effect `exclude` `bad`, other fail and warn `warn`. An excluding Check links `-->|excluded| X(["Excluded · restorable"]):::outbad`. End node: `SL(["On the Shortlist · Fit n band"]):::out`, or `GONE([...])` when gone.
- After the pick: `SL(["Shortlisted · Fit …"]):::ok` → one node `e<n>` per Event log entry (`<from> → <to>`, stage and time, reason, Approval citation; class `human` with an Approval, else `ok`) → `ST(["Status: <label>"]):::out`.
- Text is escaped with Mermaid entity codes (`#quot;`, `#lt;`, `#gt;`) and cut to 140 characters. The `classDef` lines are the colour key shared with the terminal and the pipeline view (#43).

## Network

Every fetch goes through `httpGet` in `core/src/net.ts`. A JSON POST goes through `httpPostJson(url, body)`. With `JOB_BUTLER_NETWORK_FIXTURES` set, both answer from `<dir>/manifest.json` (`{"<url>": {"status", "content_type", "file"}}`; a POST's key is `"POST <url> <body>"`, the JSON body exactly as sent) and refuse unknown requests with `NETWORK_FIXTURE_MISSING`. Loopback URLs are always live.

## Tests

- Runner: `node:test` with `node:assert/strict`. Scripts: `npm test`, `npm run typecheck`, `npm run lint` (Biome), `npm run check` (all three; must pass before you commit). `npm run format` fixes formatting.
- Tests drive the CLI through `runCli(args, { dataDir, input, env })` from `core/test/harness.ts` and assert on the JSON result, exit code and files in the data directory. Never import `core/src` from a test.
- Use `tempDir(t)` for a data directory and `git(cwd, ...)` for git repos (both isolated from your own config). `runCli` defaults: network from `core/test/fixtures/network`, `gh` from `core/test/fixtures/gh/unavailable`, clock at `2026-01-15T09:00:00.000Z`.
- Fixture boundaries:
  - **Network:** add the recorded file to `core/test/fixtures/network/` and its URL to `manifest.json`. Record real responses; trim them, don't invent fields. When the same URL must answer differently in a later run (a job taken down, a board failing), add a scenario folder with its own `manifest.json` (its `file` may point to `../<file>`) and pass it as `env: { JOB_BUTLER_NETWORK_FIXTURES }` for that call, as `discover.test.ts` does.
  - **LLM judgments:** JSON files in `core/test/fixtures/judgments/`, passed with `--input judgment("<name>")`. `setup-profile.json` is a complete Profile as setup would write it; tests that need a passing Stage gate write it with `profile put` and run `preferences init`.
  - **Browser:** pages in `core/test/fixtures/browser/`, served by `serveBrowserFixtures(t)` on 127.0.0.1.
  - **gh:** executable scripts in `core/test/fixtures/gh/`, selected with `env: { JOB_BUTLER_GH }`.
- Fault injection: check `fault("<name>")` from `env.ts` at the point to interrupt; tests set `JOB_BUTLER_FAULT`.
