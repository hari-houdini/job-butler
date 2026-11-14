// The command registry. Each later ticket adds its commands here, implemented in its own module.

import { alertsWindow, recordAlerts } from "./alerts.ts";
import { pickListings } from "./application.ts";
import { applicationSubmitted, applyAnswer, applyPlan, applyPrepare } from "./apply.ts";
import { applyClose, applyFill, applyHandover } from "./apply-fill.ts";
import {
  addGrant,
  approvalState,
  grantState,
  readApprovals,
  readGrants,
  recordApproval,
  revokeGrant,
} from "./approval.ts";
import { detectBoard } from "./boards/detect.ts";
import type { Command } from "./cli.ts";
import { coverLetterPending, coverLetterRecord } from "./cover-letter.ts";
import { ensureSafeDataDir } from "./data-dir.ts";
import { confirmSameJob, discoverBoards, splitMerged } from "./discover.ts";
import {
  confirmEmployer,
  correctEmployer,
  matchEmployer,
  nameEndClient,
  sponsorRefresh,
  sponsorStatus,
} from "./employer.ts";
import { sessionId } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { createExternal, linkExternal } from "./external-create.ts";
import { preToolUse, sessionStart } from "./hook.ts";
import { addLinkedInJobs, confirmLinkedInMatch, matchLinkedIn } from "./linkedin.ts";
import { endRun, readRunLock, startRun } from "./lock.ts";
import { httpGet } from "./net.ts";
import { notifyVerdict, pipelineDigest, routeReply, scheduleTick } from "./orchestrate.ts";
import { initPreferences, loadPreferences, setPreference, settingPaths } from "./preferences.ts";
import { assertProfileComplete, checkProfile, putProfile, readProfile } from "./profile.ts";
import { restoreListing, showExcluded } from "./restore.ts";
import { importResume } from "./resume.ts";
import { deleteRecords, previewPrune, prune } from "./retention.ts";
import { digest, screenPending, screenRecord, screenRescore, why } from "./screen.ts";
import { sponsorshipRefresh } from "./sponsorship.ts";
import { assertRecordType, getRecord, listRecords, notFound, withWriter } from "./store.ts";
import { tailorPending, tailorRecord } from "./tailor.ts";
import {
  approveStatus,
  trackAssign,
  trackDigest,
  trackDismiss,
  trackDismissMail,
  trackPropose,
  trackRecord,
  trackWindow,
} from "./track.ts";
import { openView, regenerateView } from "./view.ts";

function needId(args: string[]): string {
  const [id] = args;
  if (id === undefined) throw usageError("<id> is required");
  return id;
}

export const commands: Record<string, Command> = {
  help: {
    usage: "help",
    summary: "List every command.",
    run: async () => ({}),
  },

  status: {
    usage: "status",
    summary: "Report whether the Profile is complete and what the job seeker should do next.",
    async run({ dataDir }) {
      const check = await checkProfile(dataDir);
      const run = await readRunLock(dataDir);
      const base = { profile: check.state, run: run ?? null, data_dir: dataDir };
      if (check.state === "missing") {
        return {
          ...base,
          next: "setup",
          message: "No Profile found. Run /job-butler:setup to build one from your resume.",
        };
      }
      if (check.state === "incomplete") {
        return {
          ...base,
          next: "setup",
          missing: check.missing,
          problems: check.problems,
          message: "Your Profile isn't complete. Run /job-butler:setup to finish it.",
        };
      }
      return { ...base, next: null };
    },
  },

  init: {
    usage: "init",
    summary:
      "Create the private data directory, git-ignoring it inside a git project; refuse if it is unsafe.",
    run: async ({ dataDir }) => ({ data_dir: dataDir, ...(await ensureSafeDataDir(dataDir)) }),
  },

  fetch: {
    usage: "fetch <url>",
    summary: "Fetch a public URL (e.g. a portfolio page) and print its status and body.",
    async run({ args }) {
      const [url] = args;
      if (url === undefined) throw usageError("fetch: <url> is required");
      return { ...(await httpGet(url)) };
    },
  },

  // Low-level pipeline-state access. Stage tickets add domain commands (e.g. "listing
  // upsert") that validate their input and call the store module directly.
  "record put": {
    usage: "record put <type> <id> --input <file>|-",
    summary: "Create or replace one pipeline record from a JSON object.",
    async run(ctx) {
      const [typeArg, id] = ctx.args;
      const type = assertRecordType(typeArg);
      if (id === undefined) throw usageError("record put: <id> is required");
      const data = await ctx.readInput();
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw usageError("record put: --input must be a JSON object");
      }
      const record = await withWriter(ctx.dataDir, "record put", (w) =>
        w.put(type, id, data as Record<string, unknown>),
      );
      return { record };
    },
  },

  "record get": {
    usage: "record get <type> <id>",
    summary: "Print one pipeline record.",
    async run(ctx) {
      const [typeArg, id] = ctx.args;
      const type = assertRecordType(typeArg);
      if (id === undefined) throw usageError("record get: <id> is required");
      const record = await getRecord(ctx.dataDir, type, id);
      if (record === undefined) throw notFound(type, id);
      return { record };
    },
  },

  "record list": {
    usage: "record list <type>",
    summary: "Print every pipeline record of one type, sorted by id.",
    async run(ctx) {
      const type = assertRecordType(ctx.args[0]);
      return { records: await listRecords(ctx.dataDir, type) };
    },
  },

  "record delete": {
    usage: "record delete <type> <id>...",
    summary:
      "Destructive, needs a grant: delete records on the job seeker's request, with their " +
      "files (a Listing's Decision tree, an Application's Tailor folder). All or nothing.",
    run: async ({ dataDir, args }) => ({
      ...(await deleteRecords(dataDir, args[0], args.slice(1))),
    }),
  },

  "run start": {
    usage: "run start <stage>",
    summary:
      "Stage entry gate: check the Profile is complete, validate Preferences, and take the run " +
      "lock for this session (joining the run if this session already holds it).",
    async run({ args, dataDir }) {
      const stage = args[0];
      if (stage === undefined || !STAGES.includes(stage)) {
        throw usageError(`run start: <stage> must be one of: ${STAGES.join(", ")}`);
      }
      await assertProfileComplete(dataDir);
      const preferences = await loadPreferences(dataDir);
      await ensureSafeDataDir(dataDir);
      const { run, joined } = await startRun(dataDir, stage);
      return { run_id: run.run_id, joined, run, preferences };
    },
  },

  "run end": {
    usage: "run end --run <run_id>",
    summary: "Release the run lock taken by `run start` (only when run_id matches).",
    async run({ dataDir, flags }) {
      const id = flags.run;
      if (id === undefined) throw usageError("run end: --run <run_id> is required");
      return { released: await endRun(dataDir, id) };
    },
  },

  "run digest": {
    usage: "run digest",
    summary:
      'The orchestrator\'s "what needs you" digest: Track changes awaiting Approval, the Shortlist, ' +
      "Applications ready to apply, paused forms and failed sources, with every reply it takes.",
    run: async ({ dataDir }) => ({ ...(await pipelineDigest(dataDir)) }),
  },

  "run reply": {
    usage: "run reply <the job seeker's reply>",
    summary:
      "Route one reply to the digest (why, pick, approve, show excluded, restore, help, link, ...) " +
      "to the core commands it means, and the Checkpoint to approve first. Writes nothing.",
    run: async ({ dataDir, args }) => ({ ...(await routeReply(dataDir, args.join(" "))) }),
  },

  "run notify": {
    usage: "run notify",
    summary:
      "Verdict for a desktop notification: notify is true only when something needs the job " +
      "seeker and Preferences allow it. The skill sends it.",
    run: async ({ dataDir }) => ({ ...(await notifyVerdict(dataDir)) }),
  },

  "schedule tick": {
    usage: "schedule tick",
    summary:
      "One turn of the opt-in schedule: which tasks are due, taking the run lock. A held lock " +
      'skips the turn and logs "skipped: another session was writing".',
    run: async ({ dataDir }) => ({ ...(await scheduleTick(dataDir)) }),
  },

  "run status": {
    usage: "run status",
    summary: "Show the run in progress, if any (a stale run lock is reported as none).",
    run: async ({ dataDir }) => ({ run: (await readRunLock(dataDir)) ?? null }),
  },

  "profile check": {
    usage: "profile check",
    summary: "Report whether the Profile is missing, incomplete or complete, and what's missing.",
    run: async ({ dataDir }) => ({ ...(await checkProfile(dataDir)) }),
  },

  "profile get": {
    usage: "profile get [--section <name>]",
    summary: "Print the Profile, or one section of it, as JSON.",
    async run({ dataDir, flags }) {
      const profile = await readProfile(dataDir);
      if (profile === undefined) {
        throw new CoreError("NOT_FOUND", "There's no Profile yet. Run /job-butler:setup.");
      }
      if (flags.section !== undefined) return { section: profile[flags.section as never] ?? null };
      return { profile };
    },
  },

  "profile put": {
    usage: "profile put [--section <name>] --input <file>|-",
    summary:
      "Setup only: write the whole Profile, or replace one section. Refuses invalid values " +
      "and refuses while a run is in progress.",
    async run(ctx) {
      const input = await ctx.readInput();
      return { ...(await putProfile(ctx.dataDir, input, ctx.flags.section)) };
    },
  },

  "resume import": {
    usage: "resume import <file>",
    summary:
      "Setup: keep a copy of the resume (PDF, DOCX or text) in the data directory and print " +
      "its text (null for a PDF: read that with the Read tool).",
    async run({ args, dataDir }) {
      const [file] = args;
      if (file === undefined) throw usageError("resume import: <file> is required");
      return { ...(await importResume(dataDir, file)) };
    },
  },

  "preferences init": {
    usage: "preferences init",
    summary: "Create Preferences with every default written out (no change if they exist).",
    run: async ({ dataDir }) => ({ ...(await initPreferences(dataDir)) }),
  },

  "preferences get": {
    usage: "preferences get",
    summary: "Validate and print Preferences, with the names of the settings that can change.",
    run: async ({ dataDir }) => ({
      preferences: await loadPreferences(dataDir),
      settings: settingPaths(),
    }),
  },

  "preferences set": {
    usage: "preferences set <setting> <value>",
    summary:
      "Change one setting (e.g. schedule.enabled true). Refuses while a run is in progress " +
      "and refuses a value that would make Preferences invalid.",
    async run({ args, dataDir }) {
      const [key, value] = args;
      if (key === undefined || value === undefined) {
        throw usageError("preferences set: <setting> and <value> are required");
      }
      return { preferences: await setPreference(dataDir, key, value) };
    },
  },

  // Discover (docs/agents/core-conventions.md, "Discover").
  "discover boards": {
    usage: "discover boards",
    summary:
      "Read every Target company's board, write the Discover run, add a Sighting to each " +
      "Listing seen (creating new ones) and mark gone the Listings missing from a board read.",
    run: async ({ dataDir }) => ({ ...(await discoverBoards(dataDir)) }),
  },
  "board detect": {
    usage: "board detect <careers-or-board-url>",
    summary:
      "Find the ATS board (Greenhouse, Lever, Ashby, Workday) a career page links to, in the " +
      "Profile's board shape, for setup to confirm with the job seeker. Writes nothing.",
    async run({ args }) {
      const [url] = args;
      if (url === undefined) throw usageError("board detect: <url> is required");
      return { ...(await detectBoard(url)) };
    },
  },

  // Screen (docs/agents/core-conventions.md, "Screen").
  "sponsor refresh": {
    usage: "sponsor refresh",
    summary: "Download the UK sponsor register (at most once a day) and re-check cached Employers.",
    run: async ({ dataDir }) => ({ ...(await sponsorRefresh(dataDir)) }),
  },

  "sponsor status": {
    usage: "sponsor status",
    summary: "Say how fresh the local sponsor register copy is.",
    run: async ({ dataDir }) => ({ ...(await sponsorStatus(dataDir)) }),
  },

  "sponsorship refresh": {
    usage: "sponsorship refresh",
    summary:
      "Download the GOV.UK occupation and going-rate tables (at most weekly) and say how fresh they are.",
    run: async ({ dataDir }) => ({ ...(await sponsorshipRefresh(dataDir)) }),
  },

  "employer match": {
    usage:
      'employer match --input <file>|- ({"company", "town"?, "description"?, "end_client"?, "judgment"?: {"choice"}})',
    summary:
      "Match a Listing's employer to the sponsor register and cache it as an Employer record.",
    run: async (ctx) => ({ ...(await matchEmployer(ctx.dataDir, await ctx.readInput())) }),
  },

  "employer confirm": {
    usage: "employer confirm <id>",
    summary: "Confirm an Employer's match and pin it.",
    run: async ({ dataDir, args }) => ({ ...(await confirmEmployer(dataDir, needId(args))) }),
  },

  "employer correct": {
    usage:
      'employer correct <id> --input <file>|- ({"organisation_name", "town"?} or {"none": true})',
    summary: "Correct an Employer's match to a register entry, or to none, and pin it.",
    run: async (ctx) => ({
      ...(await correctEmployer(ctx.dataDir, needId(ctx.args), await ctx.readInput())),
    }),
  },

  "employer end-client": {
    usage: 'employer end-client <id> --input <file>|- ({"end_client"})',
    summary: "Name an agency Listing's end client and match it again.",
    run: async (ctx) => ({
      ...(await nameEndClient(ctx.dataDir, needId(ctx.args), await ctx.readInput())),
    }),
  },

  "screen pending": {
    usage: "screen pending",
    summary:
      "The Listings Screen still has to judge (new, or marked for rescore), with the Profile " +
      "parts the screen worker rates against and the file to write its judgments to.",
    run: async ({ dataDir }) => ({ ...(await screenPending(dataDir)) }),
  },

  "screen record": {
    usage: 'screen record --input <file>|- ({"judgments": [{"listing_id", "skills_rating"}]})',
    summary:
      "Validate the screen worker's judgments, run every Screen check, store the results on " +
      "each Listing, regenerate the Decision trees, and print the digest.",
    run: async (ctx) => ({ ...(await screenRecord(ctx.dataDir, await ctx.readInput())) }),
  },

  "screen rescore": {
    usage: "screen rescore <listing-id>...|all",
    summary:
      "Only when the job seeker asks: mark screened Listings to be scored again; they show " +
      "up in `screen pending` until `screen record` scores them.",
    run: async ({ dataDir, args }) => ({ ...(await screenRescore(dataDir, args)) }),
  },

  "screen digest": {
    usage: "screen digest",
    summary: "The ranked Shortlist (lettered a, b, ...) with its terminal text and the replies.",
    run: async ({ dataDir }) => ({ ...(await digest(dataDir)) }),
  },

  "tailor pending": {
    usage: "tailor pending [<application-id>...]",
    summary:
      "The Applications to tailor (Picked, or the ones named, for an edit) with the advert and " +
      "numbered Base resume facts for the tailor worker, never identity details.",
    run: async ({ dataDir, args }) => ({ ...(await tailorPending(dataDir, args)) }),
  },

  "tailor record": {
    usage: "tailor record <application-id> --input <file>|- (the tailor worker's JSON)",
    summary:
      "Check the tailor worker's resume against the Base resume, render Markdown, DOCX and PDF " +
      "into the Application's folder, and mark it Tailored. Run again with an edit to re-render.",
    run: async (ctx) => ({
      ...(await tailorRecord(ctx.dataDir, ctx.args[0], await ctx.readInput())),
    }),
  },

  "tailor cover-letter pending": {
    usage: "tailor cover-letter pending [<application-id>...] [--requested yes]",
    summary:
      "The Tailored Applications whose Fill plan has a cover-letter field and no letter yet (or the " +
      "ones named; --requested yes when the job seeker asked) with the advert and Base resume facts.",
    run: async ({ dataDir, args, flags }) => ({
      ...(await coverLetterPending(dataDir, args, flags.requested === "yes")),
    }),
  },

  "tailor cover-letter record": {
    usage: "tailor cover-letter record <application-id> --input <file>|- [--requested yes]",
    summary:
      "Check the worker's cover letter against the Base resume, render Markdown, DOCX and PDF " +
      "beside the resume files. Refused unless the form has a cover-letter field or --requested yes.",
    run: async (ctx) => ({
      ...(await coverLetterRecord(
        ctx.dataDir,
        ctx.args[0],
        await ctx.readInput(),
        ctx.flags.requested === "yes",
      )),
    }),
  },

  "screen why": {
    usage: "screen why <letter|listing-id|application-id>",
    summary: "One Listing's Screen checks with rule, result and evidence, and its tree's path.",
    run: async ({ dataDir, args }) => ({ ...(await why(dataDir, args[0])) }),
  },

  "show excluded": {
    usage: "show excluded",
    summary: "The excluded Listings, each with the check that excluded it and the reasons.",
    run: async ({ dataDir }) => ({ ...(await showExcluded(dataDir)) }),
  },

  restore: {
    usage: "restore <name>",
    summary:
      "The job seeker's override of an exclusion: record it and put the Listing back at its " +
      "fit position, flagged. A deny-listed Listing can't be restored.",
    run: async ({ dataDir, args }) => ({
      ...(await restoreListing(dataDir, args)),
      ...(await digest(dataDir)),
    }),
  },

  "application pick": {
    usage: "application pick <listing-id>... [--override-limit <listing-id>,...]",
    summary:
      "Shortlist-pick Checkpoint: create one Picked Application per Listing. Runs only under " +
      "an Approval recorded with `approval record shortlist-pick` for this exact command. A " +
      "Listing over its Application limit is refused unless named in --override-limit.",
    run: async ({ dataDir, args, flags }) => ({
      ...(await pickListings(dataDir, args, {
        overrideLimit: (flags["override-limit"] ?? "").split(",").filter((x) => x !== ""),
      })),
    }),
  },

  "application status": {
    usage: "application status <application-id> <status> <n>",
    summary:
      "Digest-status Checkpoint: apply Track's proposal <n>. Runs only under an Approval " +
      "recorded with `approval record digest-status` for this exact command.",
    run: async ({ dataDir, args }) => ({ ...(await approveStatus(dataDir, args)) }),
  },

  "application external": {
    usage: "application external <n>",
    summary:
      "Digest-status Checkpoint: create the External application Track offered as <n> (applied " +
      "outside Job Butler). Runs only under an Approval recorded with `approval record " +
      "digest-status` for this exact command.",
    run: async ({ dataDir, args }) => ({ ...(await createExternal(dataDir, args)) }),
  },

  "application link-external": {
    usage: "application link-external <listing-id> <application-id>",
    summary:
      "The job seeker's reply: this Listing is a job they already applied to as an External " +
      "application. Screen marks it 'already applied (external)' and keeps it off the Shortlist.",
    run: async ({ dataDir, args }) => ({ ...(await linkExternal(dataDir, args)) }),
  },

  "apply prepare": {
    usage: "apply prepare [<application-id>...]",
    summary:
      "Read each Tailored, Ready to apply or Paused Application's Greenhouse form and give the " +
      "apply worker its material. A missing posting pauses the Application; a LinkedIn-only " +
      "Listing comes back in by_hand with the link.",
    run: async ({ dataDir, args }) => ({ ...(await applyPrepare(dataDir, args)) }),
  },

  "apply plan": {
    usage: "apply plan <application-id> --input <file>|- (the apply worker's JSON)",
    summary:
      "Check the worker's Fill plan against the form, Profile, Answer bank and Tailor files and " +
      "store it on the Application. An unmappable field pauses it with the partial plan kept.",
    async run(ctx) {
      return { ...(await applyPlan(ctx.dataDir, ctx.args[0], await ctx.readInput())) };
    },
  },

  "apply answer": {
    usage: 'apply answer <application-id> <field-name> --input {"answer": "..."}',
    summary:
      "Store the job seeker's answer to an unmappable field on this Application only (never in " +
      "the Answer bank) and add it to the Fill plan.",
    async run(ctx) {
      return { ...(await applyAnswer(ctx.dataDir, ctx.args, await ctx.readInput())) };
    },
  },

  "apply fill": {
    usage: "apply fill <application-id>",
    summary:
      "Fill the Application's form in a visible browser from its Fill plan, read every field back " +
      "and compare. Never clicks Submit: a control that would submit pauses the Application. " +
      "Outcome filled, blocked (mismatch, empty required field, voice rule) or paused.",
    run: async ({ dataDir, args }) => ({ ...(await applyFill(dataDir, args[0])) }),
  },

  "apply handover": {
    usage: "apply handover <application-id>",
    summary:
      "Show every field and attached file for review and move a clean, read-back Application to " +
      "Handover. Blocked while any mismatch, empty required field or voice-rule violation stands.",
    run: async ({ dataDir, args }) => ({ ...(await applyHandover(dataDir, args[0])) }),
  },

  "apply close": {
    usage: "apply close <application-id>",
    summary: "Close the browser Apply left open and delete its ephemeral profile.",
    run: async ({ dataDir, args }) => ({ ...(await applyClose(dataDir, args[0])) }),
  },

  "application submitted": {
    usage: "application submitted <application-id>",
    summary:
      "Handover Checkpoint: record Submitted after the job seeker confirms they clicked Submit. " +
      "Runs only under an Approval recorded with `approval record handover` for this exact command.",
    run: async ({ dataDir, args }) => ({ ...(await applicationSubmitted(dataDir, args)) }),
  },

  "track window": {
    usage: "track window",
    summary: "The Gmail date window the track worker reads, from the Sync record.",
    run: async ({ dataDir }) => ({ ...(await trackWindow(dataDir)) }),
  },

  "track record": {
    usage: 'track record --input {"messages": [...]}',
    summary:
      "Record the track worker's classifications: dedupe against the Sync record, match each " +
      "message to an Application, and propose Status changes (nothing changes until approved).",
    async run(ctx) {
      return { ...(await trackRecord(ctx.dataDir, await ctx.readInput())) };
    },
  },

  "track propose": {
    usage: 'track propose <application-id> <withdrawn|no_response> --input {"reason": "..."}',
    summary: "Propose a Status change that doesn't come from mail (Withdrawn, No response).",
    async run(ctx) {
      return { ...(await trackPropose(ctx.dataDir, ctx.args, await ctx.readInput())) };
    },
  },

  "track digest": {
    usage: "track digest",
    summary: "The numbered Status-change proposals waiting for the job seeker's approval.",
    run: async ({ dataDir }) => ({ ...(await trackDigest(dataDir)) }),
  },

  "track assign": {
    usage: "track assign <message-id> <application-id>",
    summary:
      "Place unmatched mail (or the pick among several candidates) on one Application: " +
      "proposes its Status change, or just teaches Track the thread and domain.",
    run: async ({ dataDir, args }) => ({ ...(await trackAssign(dataDir, args)) }),
  },

  "track dismiss-mail": {
    usage: "track dismiss-mail <message-id>...",
    summary: "Drop unmatched mail; it is remembered and never raised again.",
    run: async ({ dataDir, args }) => ({ ...(await trackDismissMail(dataDir, args)) }),
  },

  "track dismiss": {
    usage: "track dismiss <n>...",
    summary: "Drop proposals; their messages are remembered and not raised again.",
    run: async ({ dataDir, args }) => ({ ...(await trackDismiss(dataDir, args)) }),
  },

  "discover confirm": {
    usage: 'discover confirm <discover_run_id> --input {"judgments": [...]}',
    summary:
      'Apply the discover-worker\'s "same job?" verdicts from `discover boards`: merge the ' +
      "confirmed pairs (reported in the digest) and mark the rest as similar roles.",
    async run(ctx) {
      const [runId] = ctx.args;
      if (runId === undefined) throw usageError("discover confirm: <discover_run_id> is required");
      return { ...(await confirmSameJob(ctx.dataDir, runId, await ctx.readInput())) };
    },
  },

  // LinkedIn (docs/agents/core-conventions.md, "LinkedIn"). LinkedIn is never fetched.
  "linkedin add": {
    usage: 'linkedin add --input {"jobs": [{company, title, location, url, description, intake}]}',
    summary:
      "Take pasted (or alert) LinkedIn jobs in as Listings, read their Target company's board " +
      'for the same title, and return the "LinkedIn match" questions for the discover-worker.',
    run: async (ctx) => ({ ...(await addLinkedInJobs(ctx.dataDir, await ctx.readInput())) }),
  },

  "linkedin alerts window": {
    usage: "linkedin alerts window",
    summary:
      "The Gmail query the alert worker reads for LinkedIn job-alert emails, and the IDs already processed.",
    run: async ({ dataDir }) => ({ ...(await alertsWindow(dataDir)) }),
  },

  "linkedin alerts record": {
    usage:
      'linkedin alerts record --input {"alerts": [{message_id, thread_id, received_at, jobs}]}',
    summary:
      "Take the alert worker's jobs in as LinkedIn Listings (intake alert) and record the " +
      "alert messages in the Sync record so they are never read twice. Returns what `linkedin add` does.",
    run: async (ctx) => ({ ...(await recordAlerts(ctx.dataDir, await ctx.readInput())) }),
  },

  "linkedin match": {
    usage: "linkedin match [<listing_id>...]",
    summary:
      'The "LinkedIn match" questions for stored LinkedIn-only Listings (all, or those named) ' +
      "against the Listings on hand. Run after `discover boards`. Writes nothing.",
    run: async ({ args, dataDir }) => ({ ...(await matchLinkedIn(dataDir, args)) }),
  },

  "linkedin confirm": {
    usage: 'linkedin confirm <discover_run_id> --input {"matches": [...]}',
    summary:
      'Apply the discover-worker\'s "LinkedIn match" answers: pair each matched LinkedIn ' +
      "Listing with its ATS posting as aliases; keep the rest LinkedIn-only.",
    async run(ctx) {
      const [runId] = ctx.args;
      if (runId === undefined) throw usageError("linkedin confirm: <discover_run_id> is required");
      return { ...(await confirmLinkedInMatch(ctx.dataDir, runId, await ctx.readInput())) };
    },
  },

  "listing split": {
    usage: "listing split <listing_id> <alias_id>",
    summary:
      "The job seeker's override of a wrong merge: move one alias and its Sightings to their " +
      "own Listing. The two are never merged again.",
    async run({ args, dataDir }) {
      const [listing, alias] = args;
      if (listing === undefined || alias === undefined) {
        throw usageError("listing split: <listing_id> and <alias_id> are required");
      }
      return { ...(await splitMerged(dataDir, listing, alias)) };
    },
  },

  // Retention (docs/agents/core-conventions.md, "Retention and deletion").
  prune: {
    usage: "prune",
    summary:
      "Destructive, needs a grant: remove Listings that never became Applications 90 days " +
      "after their latest Sighting, with their Decision trees.",
    run: async ({ dataDir }) => ({ ...(await prune(dataDir)) }),
  },

  "view build": {
    usage: "view build",
    summary: "Regenerate the local pipeline page (<data>/view/index.html) without opening it.",
    run: async ({ dataDir }) => {
      await ensureSafeDataDir(dataDir);
      return { path: await regenerateView(dataDir) };
    },
  },

  view: {
    usage: "view",
    summary: "Regenerate the local pipeline page and open it in the browser. Changes no state.",
    run: async ({ dataDir }) => {
      await ensureSafeDataDir(dataDir);
      const path = await regenerateView(dataDir);
      return { path, opened: await openView(path) };
    },
  },

  "retention preview": {
    usage: "retention preview",
    summary:
      "What `prune` would remove now (Listings, orphan Decision trees, temp files), so the " +
      "job seeker can see it before agreeing. Changes nothing.",
    run: async ({ dataDir }) => ({ ...(await previewPrune(dataDir)) }),
  },

  // Approval (docs/agents/core-conventions.md, "Approval").
  "approval record": {
    usage: 'approval record <checkpoint> --session <id> --input {"actions": [...]}',
    summary:
      "Record the job seeker's yes at a Checkpoint (shortlist-pick, digest-status, handover), " +
      "listing the exact core commands it covers. Only after their yes in the session.",
    async run(ctx) {
      const input = await ctx.readInput();
      const session = sessionId(ctx.flags.session);
      return { approval: await recordApproval(ctx.dataDir, ctx.args[0], input, session) };
    },
  },

  "approval list": {
    usage: "approval list [--session <id>]",
    summary: "Print every Approval with its state in this session: active, spent or expired.",
    async run(ctx) {
      const session = sessionId(ctx.flags.session);
      const approvals = await readApprovals(ctx.dataDir);
      return { approvals: approvals.map((a) => ({ ...a, state: approvalState(a, session) })) };
    },
  },

  "grant add": {
    usage: "grant add <scope> --session <id>",
    summary:
      "Record a standing grant for one gated tool or command, after the job seeker asks for " +
      "it. Sensitive and destructive grants expire with the session.",
    async run(ctx) {
      return { grant: await addGrant(ctx.dataDir, ctx.args[0], sessionId(ctx.flags.session)) };
    },
  },

  "grant list": {
    usage: "grant list [--session <id>]",
    summary: "Print every standing grant with its state: active, revoked or expired.",
    async run(ctx) {
      const session = sessionId(ctx.flags.session);
      const grants = await readGrants(ctx.dataDir);
      return { grants: grants.map((g) => ({ ...g, state: grantState(g, session) })) };
    },
  },

  "grant revoke": {
    usage: "grant revoke <id>",
    summary: "Revoke a standing grant.",
    run: async (ctx) => ({ grant: await revokeGrant(ctx.dataDir, ctx.args[0]) }),
  },

  // Claude Code hooks (hooks/hooks.json). They print Claude Code's hook JSON, not {"ok"}.
  "hook pre-tool-use": {
    usage: "hook pre-tool-use < <PreToolUse JSON>",
    summary: "The Approval hook: deny a tool call that no Approval or grant covers.",
    raw: true,
    run: async (ctx) => preToolUse(await ctx.readStdin(), ctx.flags["data-dir"]),
  },

  "hook session-start": {
    usage: "hook session-start < <SessionStart JSON>",
    summary: "Export the session id to later Bash calls as JOB_BUTLER_SESSION_ID.",
    raw: true,
    run: async (ctx) => sessionStart(await ctx.readStdin()),
  },
};

/** What `run start` accepts: the orchestrator ("pipeline") or one Stage. */
const STAGES = ["pipeline", "discover", "screen", "tailor", "apply", "track"];
