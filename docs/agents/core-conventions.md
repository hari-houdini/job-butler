# Core conventions

How the plugin and the deterministic core are laid out, set by ticket #30. Follow these when adding a Stage, a command or a test; change them here when you change them in code.

## Layout

```
.claude-plugin/   plugin.json + marketplace.json (repo root is the plugin root)
skills/<name>/    SKILL.md per skill; skills/job-butler is the /job-butler entry point
agents/           worker subagents, one per Stage (add when the first one lands)
hooks/hooks.json  the Approval PreToolUse hook (add with the Approval ticket; it calls the core)
core/src/         the TypeScript core: cli.ts (entry), commands.ts (registry), one module per concern
core/test/        *.test.ts, harness.ts, fixtures/
```

## Runtime: Node type stripping, no build, no runtime dependencies

- The core is plain `.ts` run directly by Node (>= 22.18) through built-in type stripping. There is no build step and no `dist/`.
- Write erasable TypeScript only (no `enum`, `namespace` or constructor parameter properties) and import local files with their `.ts` extension. `tsc --noEmit` (`erasableSyntaxOnly`) enforces both.
- A plugin install copies the repo without running `npm install`, so the core has **no runtime dependencies**. Dev dependencies (TypeScript, Biome, `@types/node`) are fine. A ticket that truly needs a runtime package (Playwright for Apply, DOCX/PDF rendering for Tailor) must decide how it gets installed and record that here.
- Skills call the core as `node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]`.

## CLI

- Commands are words, longest match wins (`help` lists them all): e.g. `status`, `record put|get|list`, `run start|end|status`, `profile put|get|check`, `preferences init|get|set`. Add a command by adding an entry to `core/src/commands.ts` that calls a module in `core/src/`. Name multi-word commands `<noun> <verb>` (e.g. `listing upsert`, `lock status`).
- **Output:** exactly one JSON object on stdout, nothing else. Use snake_case keys.
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

## Data directory and pipeline store (ADR 0001)

- Profile at `<data>/profile.yaml`, Preferences at `<data>/preferences.yaml`, resume copies in `<data>/sources/`. Pipeline records at `<data>/pipeline/<type>/<encodeURIComponent(id)>.json`. Types: `listing`, `application`, `employer`, `discover-run`, `sync` (add new ones to `RECORD_TYPES` in `store.ts`).
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

## Network

Every fetch goes through `httpGet` in `core/src/net.ts`. With `JOB_BUTLER_NETWORK_FIXTURES` set, it answers from `<dir>/manifest.json` (`{"<url>": {"status", "content_type", "file"}}`) and refuses unknown URLs with `NETWORK_FIXTURE_MISSING`. Loopback URLs are always live.

## Tests

- Runner: `node:test` with `node:assert/strict`. Scripts: `npm test`, `npm run typecheck`, `npm run lint` (Biome), `npm run check` (all three; must pass before you commit). `npm run format` fixes formatting.
- Tests drive the CLI through `runCli(args, { dataDir, input, env })` from `core/test/harness.ts` and assert on the JSON result, exit code and files in the data directory. Never import `core/src` from a test.
- Use `tempDir(t)` for a data directory and `git(cwd, ...)` for git repos (both isolated from your own config). `runCli` defaults: network from `core/test/fixtures/network`, `gh` from `core/test/fixtures/gh/unavailable`, clock at `2026-01-15T09:00:00.000Z`.
- Fixture boundaries:
  - **Network:** add the recorded file to `core/test/fixtures/network/` and its URL to `manifest.json`. Record real responses; trim them, don't invent fields.
  - **LLM judgments:** JSON files in `core/test/fixtures/judgments/`, passed with `--input judgment("<name>")`. `setup-profile.json` is a complete Profile as setup would write it; tests that need a passing Stage gate write it with `profile put` and run `preferences init`.
  - **Browser:** pages in `core/test/fixtures/browser/`, served by `serveBrowserFixtures(t)` on 127.0.0.1.
  - **gh:** executable scripts in `core/test/fixtures/gh/`, selected with `env: { JOB_BUTLER_GH }`.
- Fault injection: check `fault("<name>")` from `env.ts` at the point to interrupt; tests set `JOB_BUTLER_FAULT`.
