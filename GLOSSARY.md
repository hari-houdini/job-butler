# Job Butler

A personal job-search assistant made of cooperating agents that do the busywork of a job search while the job seeker keeps control of anything sent under their name.

## Language

### The process

**Stage**:
One step of the job process: Discover, Screen, Tailor, Apply or Track.
_Avoid_: Step, phase

**Agent**:
The owner of exactly one Stage: a Stage skill that deals with the job seeker, plus the worker subagent it sends unattended work to.
_Avoid_: Bot, worker

**Skill**:
One capability an Agent uses within its Stage, such as the ghost-job check inside Screen.
_Avoid_: Subskill, tool

### Jobs and pursuit

**Listing**:
A job posting as found on a source.
_Avoid_: Job, posting, role, opening

**Shortlist**:
The ranked Listings Screen puts in front of the job seeker; picking one from it creates an Application.
_Avoid_: Recommendations, picks

**Application**:
The job seeker's pursuit of one Listing, from shortlist through outcome; the unit the pipeline tracks.
_Avoid_: Job, lead, opportunity

**Ghost job**:
A Listing that is fake, stale, or never intended to be filled.
_Avoid_: Faux job, fake job

**Sponsorship**:
Whether the employer behind a Listing will sponsor the job seeker's work visa.
_Avoid_: Visa support

### The job seeker

**Profile**:
The job seeker's standing record: base resume, target roles, preferences, Sponsorship needs, and allow/deny lists. It must exist before any Stage runs.
_Avoid_: Settings, preferences, user config

**Base resume**:
The job seeker's complete, reviewed record of experience from which every tailored resume is drawn.
_Avoid_: Master resume, CV, source resume

**Answer bank**:
The job seeker's stored answers to recurring application-form questions.
_Avoid_: Canned answers, form defaults

### Control

**Approval**:
The job seeker's explicit yes on one outward-facing action, such as submitting an Application or sending a message.
_Avoid_: Confirmation, sign-off

### Pipeline records

**Pipeline state**:
Everything the Stages read and write to pass work along: Listings with their Sightings, Applications with their Status and Event log, and Sync records.
_Avoid_: Database, store, cache

**Sighting**:
One observation of a Listing on a source, with the date it was seen. Repeated Sightings reveal reposts and let Screen judge how long a Listing has been open.
_Avoid_: Hit, appearance

**Status**:
Where an Application stands right now, from picked through to a Track outcome.
_Avoid_: State, stage

**Event log**:
The append-only record of every Status change on an Application, with the Stage that made it and when.
_Avoid_: History, audit trail

**Sync record**:
Track's record of how far it has read from one connector (Gmail, Google Calendar), so the next run only looks at new mail and events.
_Avoid_: Cursor, checkpoint

**Discover run**:
One pass of Discover across its sources, recording when it ran, which sources it searched, and any source that failed.
_Avoid_: Scan, crawl, search
