# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Visual surfaces are web-rendered: claude.ai artifacts and generated documents (HTML, PDF, DOCX). Most interaction happens in conversation, in Claude Code or Claude chat. The terminal is the main surface for now.

## Stack

A multi-agent Claude skills repo: skills and subagents that run inside Claude, not a standalone app. There is no separate web app or server. Visual output is published as artifacts or written out as document files.

## Users

Individual job seekers running their own search. They want the repetitive work of job hunting taken off their hands (finding roles, tailoring materials, tracking where every application stands) while keeping control over anything that goes out under their name.

## Product Purpose

Job Butler is a personal job-search assistant built from cooperating Claude agents. It does the busywork of a job search so the seeker can spend their time on decisions, conversations and interviews. Success means less manual tracking and copy-pasting, a pipeline that stays accurate without upkeep, and better-targeted applications.

## Positioning

Spreadsheets and trackers such as Huntr or Teal make the user do the work. Job Butler's agents do it:
- **AI does the busywork:** finds relevant roles, tailors resumes and cover letters, and drafts outreach.
- **Auto-tracks from the inbox:** reads email and calendar to update application status and interviews without manual entry.
- **Aggregates job sources:** pulls listings from several boards into one feed.
- **A clean, ranked feed:** ghost and fake listings are filtered out, sponsorship is flagged, and roles are scored for fit, so the user only sees jobs worth applying to.

## Operating Context

- Runs inside Claude (Claude Code or chat) as skills and subagents, using connected tools such as email, calendar and job-board connectors.
- The user directs the work in conversation and reviews drafts before acting on them.
- Outputs are tailored resumes and cover letters, pipeline and tracker views (artifacts), and job feeds.

## Capabilities and Constraints

Confirmed capabilities:
- Job discovery and aggregation across sources
- Resume and cover-letter tailoring
- Outreach drafting
- Inbox and calendar-driven application tracking
- Interview prep
- Salary and offer help
- Fit scoring and prioritization: ranks roles against the user's profile and preferences so effort goes to the best matches
- Sponsorship filtering: identifies which roles offer (visa) sponsorship and filters by it
- Ghost-job filtering: detects and removes fake, stale or never-to-be-filled ("ghost") listings before they reach the user

Constraints:
- **Human approves each send by default.** Agents draft and prepare. Nothing outward-facing (applications, emails, messages) goes out without explicit approval. Users can choose to grant more autonomy, but the safe default must hold.
- The product reads private data (email, calendar, resume). Only the minimum needed is used, and personal details are never sent to services beyond what a task requires.

First job sources:
- LinkedIn
- Company ATS pages (e.g. Greenhouse, Lever, Ashby, Workday)
- Official company career pages

Inbox auto-tracking source: Gmail + Google Calendar.

Opt-in autonomous mode always keeps these limits, which the user configures:
- **Daily/weekly caps** on applications and messages sent
- **Fit-score threshold:** acts only on roles scoring above the user's chosen level
- **Allow/deny lists** for companies, titles and locations

Open decisions:
- Aggregated boards (e.g. Indeed, ZipRecruiter): not in the first set

## Evidence on Hand

None yet: the repo is empty. Do not fabricate users, testimonials, success metrics or placement statistics.

## Product Principles

1. **The user stays in control.** Drafting is free; sending needs approval unless the user explicitly chose more autonomy.
2. **Zero manual upkeep.** The pipeline updates itself from the inbox and calendar. If the user has to type a status, that's a gap to close.
3. **Tailored, not templated.** Every application artifact is specific to the role and the person.
4. **Private by default.** Personal data is handled carefully and shared only when a task requires it.
5. **Show the state at a glance.** Where a visual surface exists, it answers "where does my search stand and what needs me?" before anything else.
