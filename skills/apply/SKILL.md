---
name: apply
description: Fill the form for each Tailored Application in a visible browser from a Fill plan, read every field back, and hand over to you to click Submit yourself.
argument-hint: "[application id ...]"
disable-model-invocation: true
---

# Job Butler Apply

You run Apply. A worker plans every field first, the core fills the form in a visible browser and reads each field back against the plan, and the job seeker reviews it and clicks Submit themselves. Apply never clicks Submit and never guesses: it pauses and asks.

## Calling the core

```sh
node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]
```

It prints one JSON object. On `"ok": false`, tell the job seeker `error.message` as written and go to step 8. Fill the form only through `apply fill`: the hook blocks Playwright tools that click or type while Apply runs.

## Steps

1. Run `run start apply`. On a refusal, relay it and stop: there is no run to end. Keep `run_id` and `joined`.
2. Run `apply prepare`, adding the Application IDs the job seeker named.
   - Each `by_hand` entry: give the `link` and say the job is on LinkedIn only, so they apply by hand.
   - Each `paused` entry: relay its `reason` (the posting is gone, on Greenhouse, Lever or Ashby).
   - Empty `applications`: say nothing is waiting to be filled and go to step 8.
3. Plan in waves of `batch_size` Applications, at most three `apply-worker`s in flight at once (`batch_size` is 3). Start the next wave only once every reply in the current one is planned or relayed. For each wave:
   1. Dispatch one `apply-worker` per Application in the wave, all in one message, each with that Application's object from `applications` as JSON in its prompt and nothing else.
   2. Write each reply, exactly as returned, with the Write tool to that object's `judgments_file`, then run `apply plan <application_id> --input <judgments_file>`. On `JUDGMENT_INVALID`, dispatch that worker once more with the same JSON plus the error message; after a second refusal, relay the message and move on.
4. When `apply plan` returns `outcome: "paused"`, ask the job seeker each `unmappable` question in turn, with its `label` and `options`. Run `apply answer <application_id> <name> --input -` with `{"answer": "<their words>"}` for each. Tell them an answer stays on this Application only; to keep it for every form, they promote it to the Answer bank through `/job-butler:setup answer_bank`. When no field remains unmapped the Application is Ready to apply. If they decline to answer, leave it Paused and move on.
5. For each Ready to apply Application, run `apply fill <application_id>`. A visible browser opens.
   - `outcome: "paused"`: relay `reason` (page error, page change, or a control that would submit). The partial plan is kept. Resume with `apply fill` again once the job seeker says the page is fine.
   - `outcome: "blocked"`: list each blocker (`detail`). Fix the cause (an `apply answer`, or a re-dispatched worker for the plan), then run `apply fill` again. A blocker stands until a fill passes.
   - `outcome: "filled"`: continue.
6. Run `apply handover <application_id>` and show its `text` in a code block: every field and each attached file. If `limit_warning` is not null, say it first: the Application limit was re-checked and the Listing is now over it (`label` gives limit, source and count). The Handover still goes ahead; the job seeker decides. Tell the job seeker the form is open in the browser, to review it there and click Submit themselves.
7. Ask whether they clicked Submit. Only on their yes:
   1. Record the Approval: `approval record handover --session "${CLAUDE_SESSION_ID}" --input -` with `{"actions": ["application submitted <application_id>"]}`.
   2. Run `application submitted <application_id>`. Write the command out in full.
   Answering "not yet" leaves the Application at Handover; close the browser with `apply close <application_id>` if they abandon it.
8. Run `apply close <application_id>` for every Application whose browser is still open, then `run end --run <run_id>`, unless `joined` was true. Run `run end` whenever the run stops after step 1, including on an error.
