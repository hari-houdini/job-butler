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

It prints one JSON object. On `"ok": false`, tell the job seeker `error.message` as written and go to step 4.

## Steps

1. Run `run start discover`. On a refusal, relay it and stop: there is no run to end. Keep `run_id` and `joined`.
2. Run `discover boards`. It returns `discover_run` and `new`.
3. Report, in this order:
   - **New:** the count of `new`, then each one's title, company and location. Up to 10; past that, the count only.
   - **Gone:** the count of `discover_run.gone_listings`. These have left their boards and drop off the Shortlist.
   - **Failed and skipped boards:** every entry in `discover_run.sources` whose `status` isn't `ok`, as `<company>: <error.message>`. Say each one, so a failed board is never silent.
   - With `sources` empty, tell the job seeker there are no Target companies yet and that `/job-butler:setup filters` adds them.
4. Run `run end --run <run_id>`, unless `joined` was true (the caller that started the run ends it). Run it whenever the run stops after step 1, including on an error.
