# Job Butler

Job Butler is a personal job-search assistant for Claude Code. It finds jobs at the companies you choose, ranks them against your resume, writes a tailored resume for each one you pick, fills in application forms for you to review, and tracks the replies in your Gmail. You approve anything that is sent in your name.

## Requirements

- **A claude.ai subscription login.** v1 needs a claude.ai subscription login. Sign in to Claude Code with your claude.ai account. API-key, Bedrock and Vertex logins are not supported in v1, and neither is a setup token (`CLAUDE_CODE_OAUTH_TOKEN`). The Gmail and Google Calendar connectors only load under a claude.ai subscription login.
- **Node.js 22.18 or later.**
- **Desktop notifications are macOS-only in v1.**

## Install

1. In Claude Code, add the marketplace:

   ```
   /plugin marketplace add hari-houdini/job-butler
   ```

2. Install the plugin:

   ```
   /plugin install job-butler@job-butler
   ```

3. Only if you want Apply to fill forms, install its browser support once. In the plugin folder, run:

   ```sh
   npm install
   npx playwright-core install chromium
   ```

   The Chromium download is about 150 MB.

## First run

1. Run `/job-butler:setup`. Give it your resume and answer its questions. It builds your Profile (your details, target companies, and sponsorship needs) and creates your Preferences.
2. Run `/job-butler`. This runs the whole pipeline and ends with a digest of what needs you.

## The Stages

- **Setup** (`/job-butler:setup`): builds your Profile from your resume and creates your Preferences.
- **Discover**: reads the job boards of your target companies into Listings. You can also paste a LinkedIn job or pass it LinkedIn job-alert emails.
- **Screen**: scores new Listings for fit against your base resume, shows you the ranked Shortlist, and takes your picks.
- **Tailor**: writes an ATS-safe tailored resume (Markdown, DOCX and PDF) for each Listing you picked, and shows it to you for review.
- **Apply**: fills in the form for each tailored application in a visible browser, reads every field back, and hands over to you. You click Submit yourself.
- **Track**: reads new Gmail for replies to your applications and proposes Status changes. Nothing changes until you approve it.
- **Orchestrator** (`/job-butler`): runs the Stages in order (Track, Discover, Screen, then Tailor and Apply for your picks) and ends with a digest. It also covers `view`, `preferences`, `scheduled` and `prune`.

## Approvals

Job Butler asks before anything is sent in your name or changes your records. A Checkpoint (picking Listings, approving a Status change, or confirming an application is submitted) needs your yes. A hook blocks those calls unless you have approved them.

## Notifications

Desktop notifications are on by default and only appear when a scheduled run has something for you. To turn them off, run `/job-butler preferences` and ask for `notifications.desktop` to be set to false.
