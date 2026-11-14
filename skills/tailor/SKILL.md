---
name: tailor
description: Write an ATS-safe tailored resume (Markdown, DOCX, PDF) for each Picked Application, show it for review, and re-render on plain-language edits.
argument-hint: "[application id ...]"
disable-model-invocation: true
---

# Job Butler Tailor

You run Tailor: one `tailor-worker` per Picked Application selects, reorders and rephrases Base resume facts in the advert's words, and the core checks the result, renders it and writes the Application's folder. Tailoring and editing need no Approval and are not a Checkpoint: the job seeker's Checkpoint is the Handover, later.

## Calling the core

```sh
node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]
```

It prints one JSON object. On `"ok": false`, tell the job seeker `error.message` as written and go to step 6.

## Steps

1. Run `run start tailor`. On a refusal, relay it and stop: there is no run to end. Keep `run_id` and `joined`.
2. Run `tailor pending`, adding the Application IDs the job seeker named. Empty `applications`: say nothing is waiting to be tailored and go to step 6.
3. Tailor in waves of `batch_size` Applications, at most three `tailor-worker`s in flight at once (`batch_size` is 3). Start the next wave only once every reply in the current one is recorded. For each wave:
   1. Dispatch one `tailor-worker` per Application, all in one message, each with that Application's object from `applications` as JSON in its prompt and nothing else.
   2. Write each reply, exactly as returned, with the Write tool to that object's `judgments_file`.
   3. Run `tailor record <application_id> --input <judgments_file>`. On `JUDGMENT_INVALID`, dispatch that worker once more with the same JSON plus the error message, then write and record again; after a second refusal, relay the message and move on.
4. Show each recorded Application, then take edits (below) until the job seeker is done:
   - Company and title, then `fit_summary`.
   - `text` (the keyword table: used or gap) in a code block, then the `gaps`.
   - `changes`, one per line.
   - The `paths` for the DOCX (the upload), the PDF and the notes folder.
5. Cover letters, as below.
6. Run `run end --run <run_id>`, unless `joined` was true. Run it whenever the run stops after step 1, including on an error.

## Edits

The job seeker asks in plain words ("lead with the payments work", "shorten the summary", "drop the second bullet"). To apply one:

1. Run `tailor pending <application_id>`. Its `previous` is the worker's last JSON.
2. Dispatch `tailor-worker` with that object and the edit request in its prompt. The worker changes only what the request touches.
3. Write, record and show it as in steps 3 and 4. The core re-renders all three files and counts a new `revision`.

An edit that would need experience the Base resume doesn't hold is a Profile change: send the job seeker to `/job-butler:setup`, then tailor again.

## Cover letters

A cover letter is made only when an Application's Fill plan has a cover-letter field, or when the job seeker asks for one ("write a cover letter for Acme"). Otherwise make none.

1. Run `tailor cover-letter pending` (adding the Application IDs the job seeker named and `--requested yes` when they asked). `COVER_LETTER_NOT_NEEDED` means neither trigger holds: tell them so.
2. Dispatch one `tailor-worker` per Application with that object as JSON in its prompt, write the reply exactly as returned to its `judgments_file`, and run `tailor cover-letter record <application_id> --input <judgments_file>` (plus `--requested yes` if asked). Retry once on `JUDGMENT_INVALID` as in step 3.
3. Show `text` and the `paths`. A letter adds a form's cover-letter upload only through `apply plan` (the file is kind `cover_letter`); tell the job seeker to re-run Apply if a plan already exists.
