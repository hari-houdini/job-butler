---
name: discover
description: Read the job seeker's Target companies' job boards into Listings, or take in a LinkedIn job they paste.
argument-hint: "[pasted LinkedIn job text and link]"
disable-model-invocation: true
---

# Job Butler Discover

You run Discover: the core reads every Target company's board, or takes in a LinkedIn job the job seeker pasted, and writes the Listings, their Sightings and the Discover run. You start and end the run and tell the job seeker what changed. Discover's writes need no Approval, so nothing here asks for one.

## Calling the core

```sh
node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]
```

It prints one JSON object. On `"ok": false`, tell the job seeker `error.message` as written and go to step 6 (except where a step says otherwise).

Input that carries advert text (pasted jobs, worker replies) goes through a file: write the JSON with the Write tool to `<data_dir>/inbox/<name>.json` (`data_dir` from `status`) and pass `--input <file>`. A backtick or `$(` in a heredoc would make the Approval hook deny the call.

## Steps

1. Run `run start discover`. On a refusal, relay it and stop: there is no run to end. Keep `run_id` and `joined`.
2. When the job seeker gave a LinkedIn job (pasted text, a link or both), do "Taking in a LinkedIn job" below, then go to step 6. Otherwise carry on.
3. Run `discover boards`. It returns `discover_run`, `new` and `same_job`. The core has already merged copies it can prove (same alias, shared ATS link) and recorded reposts.
4. If `same_job` is non-empty, get the "same job?" verdicts:
   1. Dispatch the `discover-worker` subagent with `"same job?"` and the `same_job` array as JSON in its prompt, and nothing else.
   2. Write its reply to `same-job.json` in the inbox and run `discover confirm <discover_run.id> --input <file>`. It returns `merged`, `kept_apart` and `skipped`. On `JUDGMENT_INVALID`, dispatch the worker once more; if it fails again, relay the message and carry on: the pairs come back next run.
5. Run `linkedin match`, so LinkedIn-only Listings get a chance to pair with postings the boards just showed. If its `linkedin_match` is non-empty, do "Getting the LinkedIn match" below with `discover_run.id` from step 3. Then report, in this order:
   - **New:** the count of `new` minus the Listings named as `alias` in `merged`, then each remaining one's title, company and location. Up to 10; past that, the count only.
   - **Merged:** each entry of `merged` as `<title> at <company>: found again on another source (<reason>)`. The job seeker can undo one with a split (below).
   - **Paired with LinkedIn:** each entry of `pairings` from `linkedin confirm`, as in "Taking in a LinkedIn job".
   - **Reposts:** the count of `discover_run.reposts`, if any.
   - **Gone:** the count of `discover_run.gone_listings`. These have left their boards and drop off the Shortlist.
   - **Failed and skipped boards:** every entry in `discover_run.sources` whose `status` isn't `ok`, as `<company>: <error.message>`. Say each one, so a failed board is never silent.
   - With `sources` empty, tell the job seeker there are no Target companies yet and that `/job-butler:setup filters` adds them.
6. Run `run end --run <run_id>`, unless `joined` was true (the caller that started the run ends it). Run it whenever the run stops after step 1, including on an error.

## Taking in a LinkedIn job

LinkedIn is never fetched: read the job only from what the job seeker pasted, and pass the link to the core as an identifier. If they gave only a link, ask them to paste the job's text too (its title, company, location and description), since nothing here may open it.

1. Read the pasted text into `company`, `title`, `location` (null when it names none) and `description` (the advert text, as pasted). Show the job seeker the company, title and location you read and apply their corrections.
2. Write `{"jobs": [{"company", "title", "location", "url", "description", "intake": "pasted"}]}` (`url` null without a link; one entry per job pasted) to `linkedin-jobs.json` in the inbox and run `linkedin add --input <file>`. It reads each Target company's board for the same title and returns `discover_run`, `listings`, `linkedin_match` and `new_companies`.
3. If `linkedin_match` is non-empty, do "Getting the LinkedIn match" with `discover_run.id`.
4. Report each entry of `listings` by its final state (a `linkedin confirm` pairing wins over `status`):
   - **Paired:** `<title> at <company>` is on the employer's board too: show the LinkedIn link, the board posting's `url` and the `reason`. Apply will use the employer's form. The pairing is shown again at the Shortlist pick; a wrong one is undone with a split (below).
   - **LinkedIn-only:** no posting on the employer's board matched, so the Listing is marked "existence unverified" (Screen counts it as a ghost signal) and Apply hands over the LinkedIn link to apply by hand. Name every failed board from `discover_run.sources` as in step 5.
5. For each name in `new_companies`, ask the job seeker: "<company> isn't one of your Target companies. Add this company?" On yes, tell them to run `/job-butler:setup filters` after this run ends to add it with its board; the next Discover run then pairs the Listing (step 5 above). Profile changes can't happen during a run, so leave the adding to setup.

## Getting the LinkedIn match

1. Dispatch the `discover-worker` subagent with `"LinkedIn match"` and the `linkedin_match` array as JSON in its prompt, and nothing else.
2. Write its reply to `linkedin-match.json` in the inbox and run `linkedin confirm <discover_run_id> --input <file>`. It returns `matched`, `pairings`, `unmatched` and `skipped`. On `JUDGMENT_INVALID`, dispatch the worker once more; if it fails again, relay the message and carry on: the questions come back next run.

## Splitting a wrong merge

When the job seeker says two merged postings are different jobs (including a wrong LinkedIn pairing), run `listing split <listing_id> <alias_id>`, inside a run (steps 1 and 6 around it). The alias is the copy to move out: one of the Listing's `aliases[].id` other than its own ID. It needs no Approval; the split is recorded as an override on both Listings and the pair is never merged again. Tell the job seeker the two Listings' IDs.
