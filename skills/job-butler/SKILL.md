---
name: job-butler
description: Run the job search pipeline, or one Stage of it.
disable-model-invocation: true
argument-hint: "[setup | discover | screen | tailor | apply | track | preferences | view]"
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
- **`discover`**: read `${CLAUDE_SKILL_DIR}/../discover/SKILL.md` and follow it.
- **`preferences`**: see Preferences below.
- **anything else** (no argument, or a Stage name): run the pipeline.

### Pipeline

1. Run `run start <stage>`, with `<stage>` being `pipeline` for no argument or the Stage name given. It is the entry gate: it refuses when the Profile is incomplete (relay the message; it sends the job seeker to `/job-butler:setup`), when Preferences are invalid, or when another session's run is in progress. On success keep `run_id`.
2. Tell the job seeker the pipeline Stages aren't built yet.
3. Run `run end --run <run_id>`, unless `joined` was true. Run it whenever the run stops after step 1, including on an error.

### Preferences

1. Run `preferences get` and show the job seeker their settings in plain words.
2. Ask what to change. For each change run `preferences set <setting> <value>`, using a name from `settings`. A `LOCKED` refusal means a run is in progress: relay it and stop.
3. Show the changed settings.
