---
name: job-butler
description: Run the job search pipeline, or one Stage of it.
disable-model-invocation: true
argument-hint: "[setup | discover | screen | tailor | apply | track | preferences | view | prune | scheduled]"
---

# Job Butler

You are the orchestrator for the job seeker's search. The deterministic core owns every rule and every write of pipeline state; you call it and relay its results in plain words.

## Calling the core

Run the core CLI with Bash, from the job seeker's working directory:

```sh
node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]
```

It prints one JSON object. On `"ok": false`, tell the job seeker `error.message` as written and stop.

## Steps

Branch on the first argument:

- **`setup`**: read `${CLAUDE_SKILL_DIR}/../setup/SKILL.md` and follow it, passing on any further arguments.
- **`discover`**: read `${CLAUDE_SKILL_DIR}/../discover/SKILL.md` and follow it, passing on any further arguments (a pasted LinkedIn job).
- **`screen`**: read `${CLAUDE_SKILL_DIR}/../screen/SKILL.md` and follow it.
- **`view`**: run `view`. It regenerates the local pipeline page and opens it in the browser; tell the job seeker the `path`, and that the page is read-only (its buttons copy replies to paste here). If `opened` is false, give them the path to open themselves.
- **`preferences`**: see Preferences below.
- **`scheduled`**: see Scheduled runs below.
- **`prune`**, or the job seeker asks to delete a record: see Prune and delete below.
- **anything else** (no argument, or a Stage name): run the pipeline.

### Pipeline

1. Run `run start <stage>`, with `<stage>` being `pipeline` for no argument or the Stage name given. It is the entry gate: it refuses when the Profile is incomplete (relay the message; it sends the job seeker to `/job-butler:setup`), when Preferences are invalid, or when another session's run is in progress. On success keep `run_id`.
2. With no Stage name, run the Stages in order. Each Stage skill's own `run start` joins this run, so follow each skill's steps as written and skip its `run end`:
   1. Track: `${CLAUDE_SKILL_DIR}/../track/SKILL.md`.
   2. Discover: `${CLAUDE_SKILL_DIR}/../discover/SKILL.md`.
   3. Screen: `${CLAUDE_SKILL_DIR}/../screen/SKILL.md`. Stop at the Shortlist.
   4. Tailor then Apply: `${CLAUDE_SKILL_DIR}/../tailor/SKILL.md` and `${CLAUDE_SKILL_DIR}/../apply/SKILL.md`, for the Listings the job seeker picked (the shortlist-pick Checkpoint in the Screen skill). With no picks, skip both.
3. End with the digest (see Digest below).
4. Run `run end --run <run_id>`, unless `joined` was true. Run it whenever the run stops after step 1, including on an error.

### Digest

Run `run digest` and show its `text` in a code block. Take replies until the job seeker is done. For each reply run `run reply -- <their words>` and follow what it returns:

- `recognised: false`: relay `message` and list `replies`.
- `skill`: follow that Stage skill for the reply (`alerts`).
- `checkpoint`: show what the `commands` will do, ask for the yes, then record the Approval with `approval record <checkpoint> --session "${CLAUDE_SESSION_ID}"` listing every command as an action, as the Stage skill for that Checkpoint does.
- Run each of `commands` as its own call, then run `run digest` again and show the new `text`. `help` has no commands: list `replies`.

### Scheduled runs

`scheduled` is what the loop prompt below starts. Preferences opt in with `schedule.enabled` (`preferences set schedule.enabled true`); the job seeker then starts the schedule in an open session with:

```
/loop 30m /job-butler scheduled
```

Each turn:

1. Run `schedule tick`. `action: "off"` or `"idle"`: stop, say nothing. `"skipped"`: stop and relay `log`; the turn is retried on the next tick. `"run"`: keep `run_id` and `tasks`.
2. For `track` run the Track skill, and for `discover-screen` the Discover then Screen skills, each stopping at its Checkpoint: never record an Approval, pick, Tailor, Apply or change a Status. Leave the replies for the job seeker.
3. Run `run end --run <run_id>`, also on an error.
4. Run `run notify`. Only when `notify` is true, and only on macOS, send a desktop notification with its `title` and `message`: `osascript -e 'display notification "<message>" with title "<title>"'`. Elsewhere, or when false, stay silent.

### Preferences

1. Run `preferences get` and show the job seeker their settings in plain words.
2. Ask what to change. For each change run `preferences set <setting> <value>`, using a name from `settings`. A `LOCKED` refusal means a run is in progress: relay it and stop.
3. Show the changed settings.

### Prune and delete

Both are destructive: the hook runs them only under a grant the job seeker gives in this session, and that grant ends with the session.

1. Show exactly what will go:
   - **Prune:** run `retention preview` and list `pruned` (company, title, last seen), plus the counts of `orphan_trees` and `temp_files`. If all three are empty, say so and stop.
   - **Delete:** run `record get <type> <id>` for each record named and show what it is. A Listing with an Application can't be deleted on its own: offer to delete the Application first.
2. Ask the job seeker to confirm. Without a clear yes, stop.
3. After their yes, record the grant: `grant add prune --session "${CLAUDE_SESSION_ID}"`, or `grant add "record delete" --session "${CLAUDE_SESSION_ID}"`.
4. Run `prune`, or `record delete <type> <id>...` with every id written out.
5. Report what was removed (`pruned` or `deleted`, and the files), and that the grant expires when this session ends (`grant revoke <id>` ends it sooner).
