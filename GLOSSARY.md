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

**Target company**:
A company whose job board Discover searches, kept on a list in the Profile. Unlike the company allow list, it decides where Discover looks, not which Listings Screen keeps.
_Avoid_: Watchlist, allow list, tracked company

**Fit score**:
A 0–100 score, with written bands, of how well a Listing matches the Profile, with reasons cited per criterion. It ranks the Shortlist and never removes a Listing.
_Avoid_: Match score, relevance, rating

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
The job seeker's explicit yes at a Checkpoint, covering only the actions that Checkpoint lists.
_Avoid_: Confirmation, sign-off

**Checkpoint**:
One of the three points where Apply or Track stops for the job seeker's Approval: picking Listings from the Shortlist, the digest's status changes, and the handover before Submit.
_Avoid_: Gate, stop

**Standing grant**:
A permission the job seeker has given once, which lasts across sessions until revoked. Sensitive or destructive grants expire with their session instead.
_Avoid_: Blanket approval, always-allow

### Applying

**Fill plan**:
The per-field list of values Apply intends to enter in one Application's form. It is built before any browser action and checked against the form on read-back.
_Avoid_: Form data, answers

**Handover**:
The point where Apply stops and the job seeker reviews every filled field in the visible browser before clicking Submit themselves.
_Avoid_: Hand-off, review step

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

**Decision tree**:
A diagram of every check a Listing went through and the branch each one took, from Screen onwards and on into its Application. It is a view of what the pipeline already recorded, never a separate account of it.
_Avoid_: Audit trail, explanation, reasoning trace

**Sync record**:
Track's record of how far it has read from one connector (Gmail, Google Calendar), so the next run only looks at new mail and events.
_Avoid_: Cursor, checkpoint

**Discover run**:
One pass of Discover across its sources, recording when it ran, which sources it searched, and any source that failed.
_Avoid_: Scan, crawl, search
