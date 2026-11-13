---
name: discover
description: Read the job seeker's Target companies' job boards into Listings.
disable-model-invocation: true
---

# Job Butler Discover

You run Discover: the core reads every Target company's board and writes the Listings, their Sightings and the Discover run. You start and end the run and tell the job seeker what changed. Discover's writes need no Approval, so nothing here asks for one.

## Calling the core

```sh
node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]
```

It prints one JSON object. On `"ok": false`, tell the job seeker `error.message` as written and go to step 5 (except where a step says otherwise).

## Steps

1. Run `run start discover`. On a refusal, relay it and stop: there is no run to end. Keep `run_id` and `joined`.
2. Run `discover boards`. It returns `discover_run`, `new` and `same_job`. The core has already merged copies it can prove (same alias, shared ATS link) and recorded reposts.
3. If `same_job` is non-empty, get the "same job?" verdicts:
   1. Dispatch the `discover-worker` subagent with the `same_job` array as JSON in its prompt, and nothing else.
   2. Pass its reply to `discover confirm <discover_run.id> --input -`. It returns `merged`, `kept_apart` and `skipped`. On `JUDGMENT_INVALID`, dispatch the worker once more; if it fails again, relay the message and carry on: the pairs come back next run.
4. Report, in this order:
   - **New:** the count of `new` minus the Listings named as `alias` in `merged`, then each remaining one's title, company and location. Up to 10; past that, the count only.
   - **Merged:** each entry of `merged` as `<title> at <company>: found again on another source (<reason>)`. The job seeker can undo one with a split (below).
   - **Reposts:** the count of `discover_run.reposts`, if any.
   - **Gone:** the count of `discover_run.gone_listings`. These have left their boards and drop off the Shortlist.
   - **Failed and skipped boards:** every entry in `discover_run.sources` whose `status` isn't `ok`, as `<company>: <error.message>`. Say each one, so a failed board is never silent.
   - With `sources` empty, tell the job seeker there are no Target companies yet and that `/job-butler:setup filters` adds them.
5. Run `run end --run <run_id>`, unless `joined` was true (the caller that started the run ends it). Run it whenever the run stops after step 1, including on an error.

## Splitting a wrong merge

When the job seeker says two merged postings are different jobs, run `listing split <listing_id> <alias_id>`, inside a run (steps 1 and 5 around it). The alias is the copy to move out: one of the Listing's `aliases[].id` other than its own ID. It needs no Approval; the split is recorded as an override on both Listings and the pair is never merged again. Tell the job seeker the two Listings' IDs.
