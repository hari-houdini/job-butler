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
- A plugin install copies the repo without running `npm install`, so the core has **no runtime dependencies**. Dev dependencies (TypeScript, Biome, `@types/node`) are fine. A ticket that truly needs a runtime package (Playwright for Apply, DOCX/PDF rendering for Tailor) must decide how it gets installed and record that here. (Tailor decided: hand-written writers, see "Tailor".)
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
  - `JOB_BUTLER_OPENER`: the program `view` opens the page with (tests).
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
- **Gated commands:** `GATED_COMMANDS` maps a core command to its grant kind (`standing`, `sensitive`, `destructive`). These run only under an active grant. Today: `prune` and `record delete`, both `destructive` (#53), so their grants work only in the session that recorded them.
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
- `agents/screen-worker.md` (#34, `model: sonnet`, `tools: Read`) rates skills against the Base resume, one batch dispatch per Screen run: input the `screen pending` JSON, output `{"judgments": [{listing_id, skills_rating}]}` for `screen record`.
- `agents/discover-worker.md` (added by #37, `model: haiku`, `tools: Read`) has one section per judgment; the skill names the judgment in the prompt. "Same job?": input the `same_job` array from `discover boards`, output `{"judgments": [{listing, other, same_job, reason}]}` for `discover confirm`. "LinkedIn match" (#38): input the `linkedin_match` array from `linkedin add` / `linkedin match`, output `{"matches": [{linkedin, match: <candidate id>|null, reason}]}` for `linkedin confirm`. A later Discover judgment adds its own section and core command the same way.

## Discover (set by #33)

`discover boards` reads every Target company's board, then in one write: creates the Discover run, adds a Sighting to every Listing seen (creating new Listings), and marks gone every Listing missing from a board that was read **successfully** (a failed board marks nothing gone). It returns `discover_run`, `new` (`[{id, company, title, location}]`) and `same_job` (pairs for the worker; see "Dedupe"). Discover's writes need no Approval: none of its commands are in `CHECKPOINT_COMMANDS` or `GATED_COMMANDS`.

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
  - `aliases: [{id, url, board, source, source_job_id, title, location, via, added_at}]`: every copy of the job. The first is the Listing's own posting (`via: "own"`); others joined by `shared-ats-link`, `same-job`, `repost` or `linkedin-match`. `url` is null for a LinkedIn job pasted without its link. Track matches on every alias; Apply prefers an employer-ATS alias. (Listings written before #37 have `{id, url}` only.)
  - `sightings: [{discover_run, alias, seen_at, repost?}]`: one per alias seen per Discover run; `repost: true` on the Sighting that recorded a repost.
  - `first_seen_at` (Job Butler's own first Sighting, never changed) and `last_seen_at`. Screen's age is the earlier of `first_seen_at` and `posted_at`, since `posted_at` resets on republish.
  - `gone: boolean`, `gone_at`: set when it wasn't seen and every board it is on that the run covered was read successfully; cleared when it is seen again.
  - `repost_count` (the ghost score's repost signal, #39), `similar_roles` (IDs of live Listings for the same role kept apart; once set, kept), `distinct_from` (IDs the LLM or a split ruled a different job: never merged), `merges: [{listing, alias, step, reason, merged_at}]` (LLM merges), `overrides: [{kind: "split", from|into, alias, at}]` (on both Listings of a split; the Decision tree (#34) draws an override node from it in both trees).
- A Sighting through a copy on the Listing's own `board` refreshes the posting fields (so a repost's URL becomes the live one); a Sighting through another source's alias only adds the Sighting. Every other field is kept, so Screen results and marks added by later Stages survive Discover.

### Discover run record (`pipeline/discover-run/<uuid>.json`)

`started_at`, `finished_at`, `run_id` (the run lock's, or null), `sources: [{id, ats, company, status: "ok"|"failed"|"skipped", jobs, error: {code, message}|null}]`, `new_listings` and `gone_listings` (Listing IDs), `listings_seen`, `merges: [{listing, alias, step: "shared-ats-link"|"same-job", reason}]` (`discover confirm` appends its merges), `reposts: [{listing, alias}]`, `similar_roles: [[id, id]]` (newly marked pairs). The digest (#52) reports every source whose status isn't `ok` and every `same-job` merge.

### Dedupe (set by #37, code in `core/src/dedupe.ts`)

Every posting `discover boards` reads is matched within its company scope (see "Same role"), in order:

1. **Same alias:** its `<board id>:<job id>` is an alias of a Listing → a Sighting there.
2. **Shared ATS link:** its ID or the ATS posting its `url` points to (`atsPostingId(url)`: Greenhouse, Lever, Ashby URL patterns → `<ats>:<token>:<job id>`) equals an alias's ID or link → a new alias and Sighting, recorded as a merge. Readers must keep `source_job_id` equal to the ID in the posting URL so this holds; #36 adds Workday to `atsPostingId`.
3. **Repost:** a Listing gone at most 60 days (`gone_at` ≥ now − 60 d), same title and location, description word-trigram Jaccard ≥ 0.8 → alias, Sighting with `repost: true`, `repost_count` + 1.
4. Otherwise a new Listing.

Then, over all live Listings: pairs with the same role and location on the **same board**, or ruled distinct, are marked `similar_roles`; pairs on **different boards** not yet judged come back as `same_job` (`[{listing, other}]`, `listing` the later-seen, each side `{id, company, title, location, source, url, description}`). The skill sends them to the worker and `discover confirm <discover_run_id> --input -` merges confirmed pairs and keeps the rest apart (`distinct_from` + `similar_roles`). A pair no longer open is reported in `skipped`. Unconfirmed pairs come back on the next run.

- **Survivor of a merge:** the Listing with an Application, else one on an ATS board over a LinkedIn-only one (#38: its posting fields are the employer's), else the first seen (ties: the board read first). The other Listing's aliases and Sightings move over and its record is deleted, so a late copy of a Listing with an Application never makes a second Application or a Shortlist entry. A pair where both have an Application is never offered.
- **Applications** are found by their `listing` field (the Listing ID). Screen (#34) must use that field name.
- **Split** (`listing split <listing_id> <alias_id>`, the job seeker's override, no Approval): the alias and its Sightings become a Listing whose ID is the alias; posting fields come from the alias (title, location, URL, board) and the rest from the old Listing until the next Sighting refreshes them; Screen results (`screen`, `shortlist`, `decision_tree`) are not copied. Both get a split override and each other in `distinct_from`. The Listing's own ID can't be split off (`SPLIT_OWN_ALIAS`).

### LinkedIn (set by #38, code in `core/src/linkedin.ts`)

LinkedIn is never fetched; nothing in the core opens a LinkedIn URL. A LinkedIn job comes in as `{company, title, location, url, description, intake: "pasted"|"alert"}`: the skill reads it from pasted text, and #51's alert reader fills the same shape from an alert email (empty `description` is fine; the worker then matches only a lone exact candidate).

- `linkedin add --input {"jobs": [...]}` refuses a URL that isn't a LinkedIn job link (`NOT_A_LINKEDIN_URL`) or a malformed job (`LINKEDIN_JOB_INVALID`), writing nothing. It matches each company to a Target company (same `normaliseCompanyName`, else one name the other's leading words: "Greenhouse Software, Inc." → "Greenhouse"), reads each matched board once (Workday searched for the jobs' titles), observes only the same-title postings (normal dedupe Sightings), and writes a Discover run with `intake: "linkedin"` and `linkedin: [{listing, status}]` (same fields as a board run otherwise; `gone_listings` is always empty).
- **Listing:** ID `linkedin:<job id>` from `/jobs/view/[<slug>-]<id>`, `/comm/jobs/view/<id>` or `?currentJobId=<id>`, with `url` stored as `https://www.linkedin.com/jobs/view/<id>/` (tracking dropped); without a link, `linkedin:p-<sha256 of normalised company|title|location, 12 hex>`, so a re-paste finds it. `source` and `board` are `linkedin`; `company` is the Target company's name when one matched; `source_fields: {intake}`; `existence_unverified: true` while every alias is LinkedIn (the ghost signal for #39; merges and splits keep it current). A LinkedIn Listing is never marked gone (no board covers it). Seen again, it gets a Sighting; a LinkedIn-only one takes the latest text.
- **Candidates** for a LinkedIn-only Listing: live non-LinkedIn Listings in its company scope, same `normaliseTitle`, overlapping location (`locationsOverlap`: either missing, both remote, or one's city part appears in the other), not in `distinct_from`, not both with an Application. Returned as `linkedin_match: [{linkedin: side, candidates: [side]}]` (sides as in "same job?").
- Each entry of `listings` is `{listing, company, title, location, status: "matched"|"to_confirm"|"unmatched", target_company, new_company, pairing}`; `new_companies` lists the names with no Target company, for the skill's "add this company?". Adding one is a Profile change, so it happens in setup after the run; the next run's `linkedin match` then pairs it.
- `linkedin match [<listing_id>...]` asks the same for stored LinkedIn-only Listings (all live ones by default) against the Listings on hand, without fetching or writing. The Discover skill runs it after `discover boards`.
- `linkedin confirm <discover_run_id> --input {"matches": [...]}`: a match merges the LinkedIn Listing into the candidate (`mergeListings` with step `linkedin-match`, appended to the run's `merges`); `null` puts every current candidate in `distinct_from`, so it isn't asked again and stays LinkedIn-only. Answers no longer open are returned in `skipped`.
- **Pairing** (`linkedInPairing(listing)`): `{listing, linkedin: [{id, url}], ats: {id, source, url}|null, reason, existence_unverified}`, null for a Listing with no LinkedIn alias. `linkedin confirm` returns it as `pairings`. **Screen (#34) shows it at the Shortlist pick** for every Listing with a LinkedIn alias (both links and the reason, or "LinkedIn only, existence unverified"); Apply (#45) hands over the LinkedIn link when `ats` is null.

### Same role (set by #37 for #42, code in `core/src/same-role.ts`)

`sameRole(a, b, {location})` is the deterministic half of "same role at the same company": same scope (`sameCompany`: the same `employer` when both Listings have one (#40 sets `listing.employer` to the Employer ID), else the same `normaliseCompanyName`), same `normaliseTitle`, and with `location: true` the same `normaliseLocation`. Dedupe uses `location: true`; the reapply cooldown (#42) uses `location: false`. A match is only a candidate: the LLM confirms it (for #42, add a "same role?" section to the worker that judges limits, in the shape above). `normaliseCompanyName` lowercases, maps `&` to "and", drops punctuation and trailing legal suffixes (ltd, limited, plc, llp, uk, group, inc, llc, co, company, corp, gmbh); #40's register matcher can reuse it.

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

## Screen exclusions and ghost score (set by #39)

Steps in their own modules, in `SCREEN_STEPS` order: `scamStep`, `denyStep` (`core/src/scam-gate.ts`), `ghostStep` (`core/src/ghost.ts`), then fit. Restore lives in `core/src/restore.ts`.

- **Scam gate** (`scam.signs`, `scam.no_vacancy`; effect `exclude`): deterministic text rules over the title and description, no model. Signs: `payment` (fees, buy your own kit, gift cards), `crypto` (paid in or asked to send crypto, "optimisation tasks"), `reshipping`, `text_only_interview`. Evidence is `<sign>: "<quote>"`. `no_vacancy` is the employer's own statement ("no current vacancy", "collecting resumes"). Patterns are in `SCAM_SIGNS`/`NO_VACANCY`; keep them specific, because a fintech advert may say "payment" or "crypto" honestly.
- **Deny list** (`deny.list`; `exclude`): the Profile's `filters.deny` companies (normalised name equal), titles and locations (case-insensitive substring). It changes only by editing the Profile, so `restore` refuses it (`DENY_LISTED`).
- **Ghost score** (`ghost.score`): additive. Signals (`screen.ghost.reasons: [{signal, points, detail}]`): `age` (earlier of `first_seen_at` and `posted_at`), `repost`, `prospect_post` (Greenhouse `internal_job_id` null), `expired` (`deadline`/`validThrough` before now), `existence_unverified` (LinkedIn only), `missing_salary` (weak). `screen.ghost = {score, band, reasons}`. **All weights and band cut-offs are the named constants `GHOST_WEIGHTS` and `GHOST_BANDS` at the top of `ghost.ts`: the one place to change them. They are first estimates ranked from `docs/research/ghost-job-signals.md` and are calibrated in a later pass.** Bands: Low, Medium (badge `Ghost risk: medium`), High (flag `Ghost risk: high`: sorts below the fit order, Fit unchanged).
- **Not reached, but kept:** `runSteps` still runs the steps after an exclusion and stores their real Checks in `screen.after_exclusion` (and their `stored` fields, so the Fit score exists) while recording "not reached" in `checks`. Nothing else reads `after_exclusion` except restore.
- **`show excluded`**: `{excluded: [{id, company, title, location, excluded_by, check, reasons, restorable}], text}`. The digest shows `EXCLUDED (n)` collapsed.
- **`restore <name>`** (no Approval): `<name>` is a Listing ID, or words found in `<company> <title>` among excluded Listings (`NOT_FOUND`, `AMBIGUOUS_NAME` with IDs). It appends `{kind: "restore", check, at}` to `listing.overrides`, swaps `after_exclusion` into `checks`, sets `outcome: "shortlist"`, `excluded_by: null`, and adds the badge `Restored: <check name>` (a badge, not a flag, so the Listing sits at its fit position; ghost High still flags). The excluding Check stays failed in the tree, plus an `Override: restore` node. Returns `restored`, `override` and the digest. A later `screen rescore` keeps the restore (`reapplyRestore`).

## Application record and Event log (set by #34)

`pipeline/application/<uuid>.json`, written by `core/src/application.ts`:

- `origin` (`picked`; `external` from #50), `listing` (the Listing ID, the field Dedupe finds Applications by; null for External), `company`, `title`, `status`, `event_log`, `gmail_threads: []`, `answers: []`, `fill_plan: null`, `tailor: null`, `decision_tree` (the Listing's tree path). The Listing gets `application_id`.
- Status values (`STATUSES`, snake_case keys with display names): `picked`, `tailored`, `ready_to_apply`, `paused`, `handover`, `submitted`, `interview`, `rejected`, `offer`, `withdrawn`, `no_response`.
- Event log entry (append only): `{at, stage, from, to, reason, approval}`; `approval` is `{id, checkpoint, approved_at, action}` for a Checkpoint change, else null.
- `application pick <listing-id>...`: one action covers all the IDs (`application pick <id-1> <id-2>`), one `withWriter`. It refuses `APPROVAL_MISSING` unless `approvalUsedFor` finds the spent Approval for that exact action (so it never runs outside the hook), and all-or-nothing `NOT_FOUND`, `NOT_ON_SHORTLIST` (unscreened, excluded or gone) or `ALREADY_PICKED`. Each new entry cites the Approval. Later Checkpoint commands (`application status`, `application submitted`) follow the same shape: check `approvalUsedFor`, append an entry, rewrite the tree in the same `withWriter`.

## Decision tree (set by #34, `core/src/decision-tree.ts`)

- One `.mmd` per screened Listing at `decision-trees/<encodeURIComponent(id)>.mmd`, path stored as `decision_tree` on the Listing and Application. Generated only from the stored Listing and Application; `writeTrees(dataDir, listings, applications)` rewrites each file in full. Call it inside the same `withWriter` as any change to a Listing's `screen`, `gone` or Application (Discover doesn't call it yet; `screen record` regenerates all trees, so gone shows at the next Screen). `prune` and `record delete` (#53) delete the file with the Listing.
- `flowchart TD`: root `L` (company, title, location; class `src`) → one node per Check in order, id `c_<check with dots as _>`, label `<b>name</b><br/><small>rule</small><br/>→ result<br/><i>citation</i>`. Classes: pass `ok`; not reached `nr` (dashed edges after the cut-off); fail with effect `exclude` `bad`, other fail and warn `warn`. An excluding Check links `-->|excluded| X(["Excluded · restorable"]):::outbad`. End node: `SL(["On the Shortlist · Fit n band"]):::out`, or `GONE([...])` when gone.
- **Overrides:** each entry of `listing.overrides` gets a node `o<n>` (class `human`, linked `L -.- o<n>`) naming its kind, what it did and when. `overrideNodes` in `decision-tree.ts` words `split` (#37: `into` on the Listing split from, `from` on the one split off); #39 (restore) and #42 (limit override) add their kinds there.
- Dedupe (#37) merges delete a Listing record and splits change `overrides` without touching trees: the survivor's tree catches up at the next `screen record`, and the deleted Listing's `.mmd` stays until the next `prune` removes orphans.
- After the pick: `SL(["Shortlisted · Fit …"]):::ok` → one node `e<n>` per Event log entry (`<from> → <to>`, stage and time, reason, Approval citation; class `human` with an Approval, else `ok`) → `ST(["Status: <label>"]):::out`.
- Text is escaped with Mermaid entity codes (`#quot;`, `#lt;`, `#gt;`) and cut to 140 characters. The `classDef` lines are the colour key shared with the terminal and the pipeline view (#43).

## Retention and deletion (set by #53, `core/src/retention.ts`)

Both commands are destructive: they're in `GATED_COMMANDS`, so the hook runs them only under a `destructive` grant (`grant add prune` / `grant add "record delete"`), which expires with its session. Ask the job seeker, record the grant after their yes, then run the command.

- `retention preview` (ungated, writes nothing) and `prune` return the same shape: `cutoff` (now − 90 days), `pruned: [{id, company, title, latest_sighting_at}]`, `orphan_trees` and `temp_files` (paths relative to the data directory).
- **Prune rule:** a Listing is pruned when no Application names it (`application.listing`) and it has no `application_id`, and its latest Sighting is at or before the cutoff (exactly 90 days old is pruned). Latest Sighting = the newest of `sightings[].seen_at`, `last_seen_at` and `first_seen_at` (else `created_at`). Gone or not doesn't matter. `prune` also removes `.mmd` files in `decision-trees/` that no Listing owns (left by dedupe merges) and temp files (`.tmp-`) there; other files are left alone. Other Listings' `similar_roles` and `distinct_from` keep the pruned IDs, so a job that comes back under the same ID stays apart from what it was ruled distinct from.
- `record delete <type> <id>...`: all or nothing (`NOT_FOUND` deletes nothing), one `withWriter`. A Listing takes its Decision tree; one that an Application names refuses `LISTING_HAS_APPLICATION` (delete the Application first). An Application takes its Tailor folder, read from `tailor.folder` (a path relative to the data directory; anything outside it is never removed), and its Listing loses `application_id` and has its tree redrawn, so it is back on the Shortlist if Screen put it there. Other types are just the record. Returns `deleted: [{type, id}]` and `files_removed`.
- A Stage that stores more files per record (#44 Tailor) must record them where `record delete` finds them (`tailor.folder`), or extend `deleteRecords`.

## Pipeline view (set by #43)

- **Code:** `core/src/view.ts`. The page is `<data>/view/index.html`, with the bundled Mermaid copied beside it as `view/mermaid.min.js` (the only `<script src>`, a relative path). The page has no external URL, `fetch` or font load, and never writes state: its only actions are tab switching, showing a Decision tree node's evidence and copying a reply (`data-copy`) to the clipboard.
- **Regeneration happens in one place:** `withWriter` in `store.ts` calls `refreshView` after the pipeline lock is released. It only reads records and replaces files outside `pipeline/` (never calls `withWriter`), so it can't recurse or hold the lock; a failure goes to stderr and never fails the write. `withEditLock` (Profile, Preferences) doesn't regenerate. A new write path must go through `withWriter`.
- **Commands:** `view build` regenerates; `view` regenerates and opens (`opened: false` if the opener failed). The opener is `JOB_BUTLER_OPENER` (tests), else `open` / `xdg-open` / `explorer`. Tests use `view build` and a fixture opener.
- **Tabs:** Needs you (default): Shortlist pick (from `rankShortlist`), paused Apply (`status: paused`, field from `application.pause.field`), Handover, Digest change (an Application with `pending_change: {to, reason}`, which Track #48 should write; numbered so the button copies `approve <n>`), failed Discover sources (last Discover run, status not `ok`), then the other Applications, then Excluded in a closed `<details>`. Board: one column per Status in `STATUSES`, External badge for `origin: "external"`. Listings: list plus detail; the tree source is `renderTree`, so the page and the `.mmd` can't drift; a `click <node> call jbNode("<node>")` line is appended per check and Event log node (loose Mermaid security, needed for clicks) and the node's evidence comes from the same Check.
- **Replies the buttons copy:** `pick <letter>`, `pick a, b`, `why <letter|application id>`, `approve <n>`, `restore <company> <title>`. A new reply must also be in the terminal digest.
- **Colour key:** the `classDef` list in `decision-tree.ts`; the legend and the checks list use the same colours and the terminal marks (✓ pass, ! warn, ✗ fail, · not reached).
- **Vendored Mermaid:** `core/vendor/mermaid/mermaid.min.js`, Mermaid **10.9.1** (jsDelivr `npm/mermaid@10.9.1/dist/mermaid.min.js`), MIT licence in `core/vendor/mermaid/LICENSE`. Excluded from Biome in `biome.json` (`!core/vendor`). To upgrade, replace both files, update this version, and re-run the tests. Never load it from a CDN.

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

## Sponsor register and Employer matching (set by #40)

Code: `core/src/sponsor.ts` (the register copy, CSV parsing, name normalising) and `core/src/employer.ts` (the matcher and Employer records). Tests: `core/test/sponsor-register.test.ts` with its own recorded network fixtures in `core/test/fixtures/sponsor-network*/` (point `JOB_BUTLER_NETWORK_FIXTURES` at one of them; the shared `network/manifest.json` is untouched).

### Commands

- `sponsor refresh`: downloads the register unless a copy was already downloaded today (UTC), then re-checks every cached Employer. Returns `refreshed`, `csv_url`, `organisations`, `as_of`, `stale`, `stale_note` and `rechecked: {checked, changed: [{id, before, after}]}` (null when nothing was downloaded). `sponsor status` reports freshness only.
- `employer match --input` `{"company", "town"?, "description"?, "end_client"?, "judgment"?: {"choice": "<candidate key>" | null}}`: refreshes the register when due, matches, caches. Returns `employer` (the record), `cached`, `as_of`, `stale`, `stale_note`, `companies_house` (`not_set`, `used` or `unavailable`) and `judgment_needed` (null, or `{question, employer, town, candidates}`).
- `employer confirm <id>`, `employer correct <id> --input {"organisation_name", "town"?} | {"none": true}`, `employer end-client <id> --input {"end_client"}`.
- Setup stores the job seeker's own key with `profile put --section companies_house_key`. It is read from the Profile at match time and never bundled or logged. Without it, only tiers 1 and 2 run.

### The register copy

- Files: `<data>/cache/sponsor-register.csv` and `sponsor-register.json` (`downloaded_at`, `csv_url`, `last_error`). The CSV link is scraped from the GOV.UK publication page (`href` ending `.csv`) on each download, never hard-coded.
- A failed download (page or CSV unreachable, no link, columns changed, empty file) keeps the last good copy, records `last_error`, and every result then carries `stale: true` and `stale_note: "data may be stale (as of <YYYY-MM-DD>)"`. The next successful download clears it. With no copy at all the command refuses `REGISTER_UNAVAILABLE`. Only successful downloads count toward "once a day", so a failure is retried on the next call.
- Rows are grouped by licence holder (name and town): `organisation_name`, `town`, `county`, `entries: [{type_rating, route}]`. "X t/a Y" answers to both X and Y.

### Matcher

Name normalising (`normaliseName`): lower case, `&` to `and`, punctuation dropped, the words ltd, limited, plc and llp removed. Town agreement (`townsAgree`): one town's words are all in the other's.

1. **exact:** normalised names equal. One register holder gives the match, whatever the town. Several holders with that name need the town to pick exactly one, else unmatched.
2. **fuzzy:** the town is required and must agree. Candidates are holders in that town whose trigram Dice similarity is at least `FUZZY_THRESHOLD`; the top `MAX_FUZZY_CANDIDATES` (3) are kept. One candidate is accepted. Two or three come back as `status: "needs_judgment"` with `judgment_needed.candidates` (`{key, organisation_name, town, score}`); the skill passes that JSON to the worker, and the worker returns `{"choice": "<key>"}` or `{"choice": null}`, which the skill passes back in `judgment`. A key that isn't a candidate refuses `JUDGMENT_NOT_A_CANDIDATE`; the model never names an entry of its own.
3. **Companies House (key set only):** a fuzzy match counts only if an active company with that name exists in that town (otherwise unmatched); an exact match gets its `company_number` when verified but stands without it. When tiers 1 and 2 found nothing, the brand is searched at Companies House and its active, same-town legal name is matched exactly against the register (`match_tier: "companies_house"`).
4. Anything else is `unmatched` with `unmatched_reason`. The matcher never answers "not sponsored": that is Sponsorship's job (#41), and unmatched means unknown.

Companies House requests use Basic auth with the key as the username (`httpGet(url, headers)` in `net.ts`). A refused key (401/403) stops further requests in that call; any other failure makes `companies_house` read `unavailable` and unverifiable fuzzy matches stay unmatched.

### Employer record (`pipeline/employer/<id>.json`)

`id` = normalised brand name with spaces as `-`, plus `:<normalised town>` when the town is known (`employerId`). Fields beyond the store's four:

| field | meaning |
| --- | --- |
| `brand_name`, `town` | as seen on the Listing (`town` null when unknown) |
| `status` | `matched`, `unmatched`, `needs_judgment` or `agency` |
| `register_entry` | `{organisation_name, town, county, entries: [{type_rating, route}]}` for `matched`, else null. **Ticket #41 reads this**: the A rating and Skilled Worker route live in `entries` (one row per route) |
| `company_number` | Companies House number when verified, else null; `verified_by_companies_house` |
| `match_tier` | `exact`, `fuzzy`, `companies_house` or `corrected`; `confidence` is `"high"` for every match |
| `matched_at` | the match date: when this Employer was last evaluated (ISO UTC); `register_as_of` is the date of the register copy used |
| `unmatched_reason`, `candidates` | why unmatched; the 1 to 3 candidates while `needs_judgment` |
| `pinned` | null, or `{at, action: "confirmed" \| "corrected"}`; a pinned Employer is never re-matched |
| `agency` | `{detected, signals, end_client, badge}` |
| `mail_domains`, `application_limit_notes` | kept across re-matches; written by Track and Application limits |

Results are cached: a second `employer match` for the same brand and town returns the record unchanged unless the register was downloaded since, an `end_client` or `judgment` is given, or the record is `needs_judgment`. `sponsor refresh` (and any `employer match` that triggers a download) re-matches every unpinned Employer against the new copy; a `needs_judgment` result keeps the earlier match while it is still a candidate. Confirm pins the current match; correct pins a named register entry (found by normalised name, plus town when ambiguous; `NOT_ON_REGISTER` otherwise) or "none".

### Agencies

Detected by: a name pattern (recruitment, recruiter, resourcing, staffing, talent, headhunter, search and selection, executive search, employment agency or business, manpower, personnel), "our client" wording in the description (our client, my client, on behalf of a client, confidential client), or, with a key, Companies House SIC codes starting `78`. An agency without a named end client gets `status: "agency"`, no `register_entry`, and `agency.badge: "agency, end client not named"` (Sponsorship shows unknown plus that badge). `employer end-client` (or `employer match` with `end_client`) matches the end client instead, stores it in `agency.end_client`, and clears the badge; the Employer stays keyed by the agency brand and town.

### Open calibration items

- **`FUZZY_THRESHOLD` (0.85) is a hand-picked placeholder.** There is no hand-labelled sample of real Listings here, so precision and recall per tier are unmeasured. Calibrate it on such a sample before trusting fuzzy matches; the fixtures only prove the tiers behave as designed.
- **Companies House behaviour is unverified against the live API.** The fixtures were written from the published API reference, not recorded with a key. Still to check live: whether `search/companies` finds previous names and how it ranks near-matches, the exact `address.locality` values returned, and whether the SIC check needs the company profile (`/company/<number>`) as assumed.
- The agency name patterns and the `78` SIC prefix come from the research, not from measured Listings.

## Track tracer (set by #48)

`core/src/track.ts`; skill `skills/track/SKILL.md`; worker `agents/track-worker.md` (`model: haiku`, tools exactly `search_threads`, `get_thread`, `get_message` of the Gmail connector: read-only, no Bash, no Read, no writes).

- **Round trip:** `track window` (the `after:` query and `processed_ids`) → the skill dispatches the worker → the skill writes its reply to `<data>/inbox/track-messages.json` → `track record --input <file>` → digest `text` → the job seeker replies `approve <n>`. Other commands: `track propose <application-id> withdrawn|no_response --input {"reason"}` (proposals that don't come from mail), `track dismiss <n>...`, `track digest`.
- **Worker JSON:** `{"messages": [{message_id, thread_id, from, subject, received_at, classification, ats?: {job_url, job_id, board_slug, workday_tenant}}]}`; `classification` is `acknowledgement`, `rejection`, `interview_invite`, `offer` or `other_job_mail`. Refused as `CLASSIFICATION_INVALID`. Fixture: `fixtures/judgments/track-classification.json`.
- **Sync record** (`pipeline/sync/gmail.json`, one per connector): `last_synced_at`, `processed_ids`, `dismissed_ids`, `proposals`, `next_n`, `unmatched`. The window starts one day before `last_synced_at` (`after:` is a midnight date); the first window reaches back 30 days (`FIRST_SYNC_DAYS`, a design choice: the spec's 6-month backfill belongs to External applications, #49/#50). Dedupe is local: a message ID in `processed_ids` or `dismissed_ids` is skipped. Messages the ladder can't place go to `unmatched` (with `candidates` when it found several) for #49.
- **Ladder** (`LADDER` in `track.ts`, one `LadderStep {step, name, find}` per rung): the first step that leaves exactly one Application wins; several candidates fall through to the next step, and the first multi-candidate set is kept as `candidates`. Step 1 `thread`: `application.gmail_threads`. Step 2 `ATS ID`: a job URL (via `atsPostingId`) or job ID (with the board slug when given) against the Application's Listing aliases; else the board slug; else the Workday tenant. **#49 adds steps 3 to 5 by appending to `LADDER`; nothing else changes.** `VENDOR_DOMAINS` / `isVendorSender` are a hint only and no step reads them as a match.
- **Proposals** (`Proposal` on the Sync record, numbered by `next_n`, never reused): acknowledgement → Submitted (from Picked through Handover), rejection → Rejected, interview invite → Interview, offer → Offer; `other_job_mail` and a change the Status already shows propose nothing. Withdrawn and No response come only from `track propose`. All are "sure" in #48 (steps 1 and 2); #49 adds Probable and several-candidate ranking.
- **Approval:** `application status <application-id> <status> <n>` is the `digest-status` Checkpoint command (registered in `approval.ts` by #32). The action carries proposal `n`, so an Approval covers exactly that change: `NO_PROPOSAL` otherwise, `STALE_PROPOSAL` if the Status moved since, `APPROVAL_MISSING` outside the hook. It appends the Event log entry (`stage: "track"`, the proposal's reason, the Approval, and `message`), adds the thread to `gmail_threads` (so the next message on it matches at step 1), marks the proposal approved, and rewrites the Listing's Decision tree, all in one `withWriter`. The skill records one Approval listing every approved action, then runs each.
- **Event log `message`:** `{id, thread_id, from, subject, received_at, classification, matched_by}`, only on entries from Track.
- **Decision tree:** each Event log entry with a `message` gets an outcome node `e<n>m` (class `out`, linked `e<n> -.- e<n>m`) citing the classification, subject, sender, time, message ID and the ladder step that matched.

## Tailor (set by #44)

`/job-butler:tailor` (`skills/tailor/SKILL.md`) runs one `tailor-worker` (`agents/tailor-worker.md`, `model: sonnet`, `tools: Read`) per Picked Application, `batch_size` (3) in parallel. Commands (`core/src/tailor.ts`), none needs an Approval; editing is not a Checkpoint:

- `tailor pending [<application-id>...]`: Applications with status `picked` and no `tailor` (or the ones named, for an edit). Each: `application_id`, `listing_id`, `company`, `title`, `location`, `description`, `base_resume`, `facts` (`[{ref, kind, text}]`, refs like `summary`, `experience.0`, `experience.0.bullets.1`, `education.0`, `skills.2`), `previous` (the last worker JSON, or null) and `judgments_file` (`<data>/inbox/tailor-<id>.json`). Never identity or contact details.
- `tailor record <application-id> --input <file>`: the worker JSON `{fit_summary, summary: {text, sources}, experience: [{fact, bullets: [{text, source}]}], education|skills|projects|certifications: [{fact}], keywords: [{keyword, abbreviation, advert_quote, status: used|gap}], changes}`. The core fills employer, title, dates, schools and skill names from the Base resume by `fact`. It refuses `JUDGMENT_INVALID`, writing nothing, when: a ref isn't a Base resume fact; a bullet's `source` isn't a fact of its own role; the summary is over 60 words or cites nothing; a `gap` keyword (or its abbreviation) appears anywhere in the resume; a `used` keyword appears in no bullet, first appears outside a bullet (the summary), or is not written as "Full Name (ABBR)" at first use. Matching is whole-word and case-insensitive.
- Output: `folder`, `paths` (`md`, `docx`, `pdf`, `notes`), `revision`, `fit_summary`, `keywords` (table with `used_in: [{source, text}]`), `gaps`, `changes`, `text` (terminal keyword table).

**Folder** `<data>/tailor/<application id>/`, recorded as `tailor.folder` (relative; `record delete` removes it): `<Name>-Resume.md|docx|pdf` (neutral names from `identity.name`, ASCII, e.g. `Ada-Example-Resume.docx`; these are the upload names), `notes.md` (fit summary, keyword table, gaps, changes, sources) and `notes.json` (the same plus the worker's `judgment`, which `tailor pending` returns as `previous`). Recording again replaces every file and bumps `tailor.revision`. The Application moves `picked` to `tailored` once, with a `tailor` Event log entry and no Approval; any other status is kept. `tailor` on the Application: `{folder, files, revision, tailored_at, fit_summary, gaps}`.

**Rendering** (`document.ts`, `render-docx.ts`, `render-pdf.ts`): a document is a `DocumentModel` of blocks (`title`, `line`, `heading`, `entry`, `paragraph`, `bullet`), rendered to Markdown, DOCX and PDF by `renderDocument`. The model cannot express a table, column, text box, image, header or footer, so none can appear; contact details sit in body lines under the title. Files over 2.5 MB refuse `RENDER_TOO_LARGE`. The cover letter (#47) builds its own `DocumentModel` and calls `renderDocument`; it needs no new writer.

**Decision: no runtime dependencies for rendering.** A plugin install runs no `npm install`, and the ATS-safe subset is small, so both writers are hand-written. DOCX is a zip (`node:zlib` `deflateRawSync` and `crc32`, fixed timestamps) of `document`, `styles` and `numbering` parts: no header, footer or media parts. PDF is plain objects with the built-in Helvetica and Helvetica-Bold (WinAnsi, no embedded fonts), one text column, A4, uncompressed content streams, with Helvetica widths built in for wrapping. Characters outside WinAnsi print as `?` in the PDF; the DOCX keeps them. A library (`docx`, `pdf-lib`) would add a bundled `node_modules` for no output the subset needs.


## UK Sponsorship verdict (set by #41)

Code: `core/src/sponsorship.ts` (the regime-neutral interface, the verdict combiner and `sponsorshipStep`) and `core/src/sponsorship-uk.ts` (the UK rules and the GOV.UK tables). Tests: `core/test/sponsorship.test.ts`, with recorded pages in `core/test/fixtures/sponsorship-network*/` (point `JOB_BUTLER_NETWORK_FIXTURES` at one; the register for `employer match` stays in `sponsor-network/`).

- **Setup** already asks (`sponsorship.needed`, regime `uk-skilled-worker` by default) and stores only the derived flags `new_entrant` (reason category) and `relevant_phd` (`stem`); the job seeker can skip (`flags_skipped`). The Profile refuses anything else, so no date of birth or visa expiry is kept.
- **Interface:** `SponsorshipRegime<Data>` has `employerEvidence(listing, employer)`, `roleEvidence(listing, sponsorshipSection, data)` (role and pay evidence) and `wordingLexicon` (`negative`, `weak`, `positive` patterns), plus `dataStatus`. Each evidence is `{status: ok|fail|unknown, result, rule, citation, evidence[]}`. Register a regime in `REGIMES`; the step and combiner stay as they are. Only `uk-skilled-worker` ships.
- **The step** (after ghost, before fit in `SCREEN_STEPS`) records five Checks, each a Decision tree node: `sponsorship.employer`, `.role`, `.pay`, `.wording`, `.verdict`. Only the verdict has an effect: `failed` flags (`Sponsorship: failed`, sorts below the fit order, Fit unchanged), `unknown` is a badge (`Sponsorship: unknown`, plus the agency badge from the Employer) that sorts by fit, `likely` and a Sponsorship that isn't a criterion (result `not a criterion`) have none. The existing flag and badge ranking in `screen.ts` is unchanged. `screen.sponsorship` stores `{regime, verdict, confidence, employer_id, wording, tables_as_of, tables_stale, soc, salary, required, discount}`.
- **Verdict:** negative wording, or any failed check, gives `failed`; all of employer, role and pay `ok` gives `likely` (confidence `high` with positive wording, else `medium`); anything else is `unknown`. Missing evidence is never `ok`.
- **Employer** reads #40's Employer record for the Listing's company (same normalised brand; the town breaks ties). `matched` with a Skilled Worker row rated `Worker (A ...)` (or legacy `A (Premium)`/`A (SME+)`) is `ok`; on the register but not Skilled Worker, or B-rated or Provisional, is `fail`; no record, `unmatched`, `needs_judgment` and `agency` are `unknown`. The skill runs `employer match` before `screen record`; Screen never matches.
- **Role:** the Listing's title (level words such as senior, lead, graduate dropped) must equal or contain a "related job title" of an occupation row. All matching codes Higher Skilled is `ok`; none Higher Skilled is `fail` (Medium Skilled and Ineligible; the Immigration Salary List and Temporary Shortage List are not read, so Medium Skilled always fails); a mix, no match, or no table is `unknown`. There is no model step.
- **Pay:** the bottom of the advert's pay range, annualised at 37.5 hours (hour x 37.5 x 52, day x 5 x 52), base only. No salary, OTE, a non-GBP currency or no pay period is `unknown`. Required pay is the higher of `GENERAL_THRESHOLD` (£41,700) and the highest standard going rate of the matched codes, or the lowest of the discounts the flags unlock (`DISCOUNTS`: new entrant 70% floor £33,400, STEM PhD 80% floor £33,400, other PhD 90% floor £37,500). With no going rate known, only the floor is checked, so pay is `fail` below it and `unknown` above it. Part-time pro-rating is not applied.
- **Wording:** `NEGATIVE` in `sponsorship-uk.ts` (unable to sponsor, no sponsorship, "already have the right to work", UK/Irish citizens only, SC/DV clearance) overrides all checks. Plain "must have the right to work in the UK" is `weak`: noted in evidence, never a refusal. `positive` only raises confidence. The patterns are observed conventions from the research, not measured on real Listings.
- **Tables:** `sponsorship refresh` (and `screen record`, when Sponsorship is needed) downloads the two GOV.UK HTML pages (`OCCUPATIONS_URL`, `GOING_RATES_URL`) when the copy is a week old (`REFRESH_DAYS`), to `<data>/cache/uk-sponsorship-tables.json`: `downloaded_at`, the pages' own "Updated" dates, `last_error`, `occupations` and `going_rates`. Both pages must parse or neither is kept; a failure keeps the last good copy and marks it stale (`stale_note: "data may be stale (as of <date>)"`). With no copy at all the command refuses `TABLES_UNAVAILABLE` and Screen records role and pay as unknown. The parser finds columns by header text (code, job type, related, eligib, standard/going rate).
- **Fixtures** are hand-trimmed pages in the GOV.UK table shape (four occupations, three going rates), not live recordings; the going rates other than 2134 are illustrative. Record real pages before relying on the parser's column matching against GOV.UK.
