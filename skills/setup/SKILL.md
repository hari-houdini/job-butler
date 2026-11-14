---
name: setup
description: Build or update the job seeker's Profile from their resume, and create Preferences.
disable-model-invocation: true
argument-hint: "[identity | base_resume | targets | sponsorship | filters | answer_bank | companies_house_key]"
---

# Job Butler setup

You interview the job seeker and turn their answers into a Profile. The core validates and writes everything; you hold the conversation. Only this skill writes the Profile.

## Calling the core

```sh
node "${CLAUDE_SKILL_DIR}/../../core/src/cli.ts" <command> [args]
```

It prints one JSON object. On `"ok": false`, tell the job seeker `error.message` as written. On `PROFILE_INVALID`, fix the value with the job seeker and write again; on anything else, stop.

Write a section with `profile put --section <name> --input -`, passing the section's JSON on stdin through a quoted heredoc (`<<'JSON'`). Write each section as soon as the job seeker confirms it, so an interrupted setup keeps its progress. Timestamps are ISO 8601 UTC: `date -u +%Y-%m-%dT%H:%M:%SZ`.

## Steps

1. Run `init`. It makes the data directory private and git-ignored, or refuses when that's unsafe.
2. Run `profile check`.
   - With a section named in the arguments, do only that section's step below, then go to step 12.
   - With `state` `"missing"`, do every section in order.
   - Otherwise show the job seeker `missing` and `problems` and ask which sections to redo; do those.
3. **Mail connectors.** If no `mcp__claude_ai_Gmail__` tools are available to you, tell the job seeker that Track needs Gmail and Google Calendar connected at claude.ai/customize/connectors while logged in to Claude Code with a claude.ai account. Carry on with setup.
4. **base_resume.** Done when the job seeker has approved the whole Base resume and it is written with `reviewed_at`.
   1. Ask for the resume file (PDF, DOCX or text). Run `resume import <path>`. When `text` is null (a PDF), read the copy at `path` with the Read tool.
   2. Structure it into `summary`, `experience` (with `bullets`), `education`, `skills`, `projects` and `certifications`. Every fact and every bullet carries `source`: the `source` value `resume import` returned.
   3. Offer the optional sources: a LinkedIn PDF, data-export ZIP or pasted profile text that the job seeker gives you (`source: "linkedin: <what>"`); their GitHub (`fetch https://api.github.com/users/<name>/repos`, `source: "github: <repo>"`); their portfolio (`fetch <url>`, `source: "portfolio: <url>"`). LinkedIn reaches you only as material the job seeker hands over: linkedin.com is never fetched, because automated access risks their account.
   4. Propose each fact found only in an optional source as an addition, one at a time; add only the ones the job seeker accepts. Put every conflict between sources (dates, titles, employers) to the job seeker and record their answer, with `source: "job_seeker"` when they correct it.
   5. Show the full Base resume, grouped by section, each fact with its source. Apply their edits. On their approval set `reviewed_at` to now and write the section.
5. **identity.** Confirm `name`, `email`, `phone`, `location` and `links` from the resume, and ask their `country` (where they live and would work from).
6. **targets.** Ask for target `roles`, `seniority` (from `intern`, `junior`, `mid`, `senior`, `staff`, `principal`, `lead`, `manager`, `director`, `executive`), `locations`, whether `remote` suits them, `salary_floor` (`{amount, currency, period}`, or null for none) and `notice_period`.
7. **sponsorship.** Ask whether visa Sponsorship is a criterion (`needed`). When it is, `regime` is `uk-skilled-worker`. Then offer the two optional flags, which can lower the UK pay threshold:
   - `new_entrant`: `{value, reason}`, with `reason` one of `under_26`, `graduate_route`, `student_route`, `professional_registration`, `postdoctoral`.
   - `relevant_phd`: `{value, stem}`.

   Ask for the category, and store only the flag: the job seeker's date of birth or visa expiry stays out of the conversation and the file. When they'd rather skip, write `flags: {}` and `flags_skipped: true`; Screen then uses the standard threshold.
8. **filters.** Ask for `allow` and `deny` lists of `companies`, `titles` and `locations` (empty lists are fine). Then build `target_companies`, the companies whose boards Discover reads (separate from the allow list): for each, the `name`, the `careers_url`, and the `board`.
   1. Ask for the company's career page (or any job link of theirs) and run `board detect <url>`. Each entry in `boards` carries `board` in the Profile's shape, plus `links` and `evidence` showing where it was found. With several, the first is the most-linked.
   2. When `boards` is empty or the call refuses `CAREERS_PAGE_UNAVAILABLE`, the job seeker enters the board by hand:
      - Greenhouse, Lever or Ashby: `{ats, token}`, where the token is the first path segment of the board URL (`job-boards.greenhouse.io/<token>`, `jobs.lever.co/<token>`, `jobs.ashbyhq.com/<token>`). Lever's EU boards (`jobs.eu.lever.co`) add `region: "eu"`.
      - Workday: `{ats: "workday", tenant, instance, site}` from `<tenant>.<instance>.myworkdayjobs.com/<site>`.

      A board URL they paste can go through `board detect` too: it is recognised without a fetch.
   3. Read the board and its evidence back to the job seeker. Set `confirmed_at` once they confirm it; the board is then stored and never detected again.
9. **autonomy.** Write `{"enabled": false, "caps": {}, "fit_threshold": 80, "lists": {}}` and tell the job seeker nothing runs on its own in this version.
10. **answer_bank.** Collect answers to recurring form questions: right to work, notice, salary expectation, relocation, how they heard about the role. Add the diversity questions (gender, ethnicity, disability, veteran status, sexual orientation) with answer `Prefer not to say` and `kind: "diversity"`, and change one only when the job seeker asks. Answers given during Apply join the bank only here, when the job seeker asks to promote them.
11. **companies_house_key.** Offer the optional Companies House API key: it is their own free key from developer.company-information.service.gov.uk, and without it, a near-name employer match does not count toward a Sponsorship "likely". Write the key, or null.
12. **Preferences.** Run `preferences init` (it changes nothing when Preferences exist). On a first setup, ask once whether to track External applications, jobs they applied to outside Job Butler found in their mail; on a yes, run `preferences set external_applications.enabled true`. Mention that `/job-butler preferences` changes the schedule and the rest.
13. Run `profile check`. Setup is done when `state` is `"complete"`; otherwise return to the step for each entry in `missing` and `problems`. Finish by telling the job seeker where the Profile and Preferences files are (`data_dir` from `status`) and that both are editable by hand.
