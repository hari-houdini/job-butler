---
name: screen
description: Score new Listings for fit, show the ranked Shortlist, and pick Listings to pursue.
disable-model-invocation: true
---

# Job Butler Screen

You run Screen: the screen worker rates each new Listing against the Base resume, the core scores and ranks them, and you show the job seeker the Shortlist and take their replies. Picking is a Checkpoint: nothing becomes an Application without the job seeker's yes.

## Calling the core

```sh
node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]
```

It prints one JSON object. On `"ok": false`, tell the job seeker `error.message` as written and go to step 6.

## Steps

1. Run `run start screen`. On a refusal, relay it and stop: there is no run to end. Keep `run_id` and `joined`.
2. Run `screen pending`. With `listings` empty, go to step 4.
3. Rate them with one batch dispatch:
   - When the Profile's Sponsorship is a criterion, first run `employer match --input -` with `{"company", "town"?, "description"}` for each Listing's company, so Screen can check the register (an unmatched Employer gives an unknown verdict).
   - Dispatch the `screen-worker` subagent once, with the whole `screen pending` JSON (`listings` and `profile`) in its prompt.
   - Write its reply, exactly as returned, to the `judgments_file` path with the Write tool.
   - Run `screen record --input <judgments_file>`. On `JUDGMENT_INVALID`, dispatch the worker once more with the same JSON plus the error message, write and record again; after a second refusal, relay it and go to step 4.
4. Run `screen digest` and show its `text` as is, in a code block. A row with a `LinkedIn:` line has a LinkedIn copy: paired with the employer's posting, or LinkedIn-only and unverified.
5. Take replies until the job seeker is done:
   - **`why <letter>`**: run `screen why <letter>` and show its `text` in a code block.
   - **`pick a, b`**: see Picking below.
   - **`help`**: list the digest's `replies`, each with what it does.
   - **`rescore <letter>`** or "rescore all", only when the job seeker asks: run `screen rescore <listing-id>...` (or `all`), then go back to step 2.
   - Anything else: say which replies work, from `replies`.
6. Run `run end --run <run_id>`, unless `joined` was true. Run it whenever the run stops after step 1, including on an error.

## Picking (the Shortlist-pick Checkpoint)

1. Map each letter to its Listing ID using the `shortlist` from the latest `screen digest` you showed. An unknown letter: say so and ask again.
2. Show what will happen: "Pick these as Applications?" with each Listing's letter, Fit score, company and title. Wait for the job seeker's yes. Without it, nothing is recorded.
3. After their yes, record the Approval, with every picked ID in one action:
   ```sh
   node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" approval record shortlist-pick \
     --session "${CLAUDE_SESSION_ID}" --input - <<< '{"actions": ["application pick <id-1> <id-2>"]}'
   ```
4. Run exactly that action, with the IDs written out in the same order:
   ```sh
   node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" application pick <id-1> <id-2>
   ```
5. Report each new Application (company and title) and that Tailor comes next, then run `screen digest` and show the Shortlist again.
