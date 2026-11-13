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

1. Run `status`. When `profile` is `"missing"`, tell the job seeker the `message` (no Profile yet, run `/job-butler setup`) and stop. That ends this run.
2. Otherwise tell the job seeker the pipeline Stages aren't built yet and stop.
