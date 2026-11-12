# Job Butler

A personal job-search assistant made of cooperating agents that do the busywork of a job search while the job seeker keeps control of anything sent under their name.

## Language

### The process

**Stage**:
One step of the job process: Discover, Screen, Tailor, Apply or Track.
_Avoid_: Step, phase

**Agent**:
The worker that owns exactly one Stage.
_Avoid_: Bot, worker

**Skill**:
One capability an Agent uses within its Stage, such as the ghost-job check inside Screen.
_Avoid_: Subskill, tool

### Jobs and pursuit

**Listing**:
A job posting as found on a source.
_Avoid_: Job, posting, role, opening

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

### Control

**Approval**:
The job seeker's explicit yes on one outward-facing action, such as submitting an Application or sending a message.
_Avoid_: Confirmation, sign-off
