---
name: track
description: Read new Gmail for replies to the job seeker's applications and propose Status changes for approval.
disable-model-invocation: true
---

# Job Butler Track

You run Track: the track worker reads new mail through read-only Gmail tools, the core matches each message to an Application and proposes Status changes, and you take the job seeker's replies. Approving a Status change is a Checkpoint: no Status changes without the job seeker's yes. You own every write; the worker returns JSON only.

## Calling the core

```sh
node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]
```

It prints one JSON object. On `"ok": false`, tell the job seeker `error.message` as written and go to step 6.

## Steps

1. Run `run start track`. On a refusal, relay it and stop: there is no run to end. Keep `run_id` and `joined`.
2. Run `track window`. Keep `query`, `processed_ids` and `inbox_file`.
3. Read the mail with one dispatch:
   - Dispatch the `track-worker` subagent once, with `query` and `processed_ids` in its prompt. If the Gmail tools are missing, tell the job seeker to connect Gmail in claude.ai and go to step 6.
   - Write its reply, exactly as returned, to `inbox_file` with the Write tool.
   - Run `track record --input <inbox_file>`. On `CLASSIFICATION_INVALID`, dispatch the worker once more with the same query plus the error message, write and record again; after a second refusal, relay it and go to step 6.
4. Show the result's `text` as is, in a code block.
5. Take replies until the job seeker is done:
   - **`approve 1, 3`**: see Approving below.
   - **`dismiss 2`**: run `track dismiss 2`, then show the new `text`.
   - **`help`**: list `replies`, each with what it does.
   - A job seeker's own word that they withdrew an application, or that a Submitted one has gone quiet: run `track propose <application-id> withdrawn|no_response --input -` with `{"reason": "<their words>"}`, then show `text`.
   - Anything else: say which replies work.
6. Run `run end --run <run_id>`, unless `joined` was true. Run it whenever the run stops after step 1, including on an error.

## Approving (the digest Checkpoint)

1. Take each number from the latest `proposals`, which gives `application_id`, `to` (the Status key) and `n`. An unknown number: say so and ask again.
2. Show what will happen: each Application's company and title, its Status change, the reason and the matched message. Ask "Apply these Status changes?" and wait for the yes. Without it, nothing is recorded.
3. After their yes, record the Approval, one action per proposal:
   ```sh
   node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" approval record digest-status \
     --session "${CLAUDE_SESSION_ID}" --input - <<< '{"actions": ["application status <application-id> <to> <n>"]}'
   ```
4. Run each action exactly as written, as its own command:
   ```sh
   node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" application status <application-id> <to> <n>
   ```
5. Report each change (company, title, old and new Status), then run `track digest` and show its `text`.
