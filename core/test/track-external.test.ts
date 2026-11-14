import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

// External applications (#50). The clock is 2026-01-15 (harness).
const CORE = "node /plugins/job-butler/core/src/cli.ts";
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON records read back from the CLI
type Rec = Record<string, any>;
const SESSION = "session-1";

async function put(dataDir: string, type: string, id: string, data: unknown) {
  const r = await runCli(["record", "put", type, id, "--input", "-"], { dataDir, input: data });
  assert.equal(r.code, 0, r.stdout);
}

async function getRec(dataDir: string, type: string, id: string): Promise<Rec> {
  const r = await runCli(["record", "get", type, id], { dataDir });
  return (r.json.record ?? r.json) as Rec;
}

async function applications(dataDir: string): Promise<Rec[]> {
  const r = await runCli(["record", "list", "application"], { dataDir });
  return (r.json.records ?? []) as Rec[];
}

async function prefs(dataDir: string, ...pairs: [string, string][]) {
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
  for (const [k, v] of pairs) {
    const r = await runCli(["preferences", "set", k, v], { dataDir });
    assert.equal(r.code, 0, r.stdout);
  }
}

const optIn = (dataDir: string, ...more: [string, string][]) =>
  prefs(dataDir, ["external_applications.enabled", "true"], ...more);

function msg(over: Record<string, unknown>) {
  return {
    message_id: "m-x",
    thread_id: "t-x",
    from: "Recruiting <jobs@gamma.example>",
    subject: "We received your application",
    received_at: "2026-01-10T10:00:00.000Z",
    classification: "acknowledgement",
    company: "Gamma Ltd",
    role: "Data Scientist",
    ...over,
  };
}

async function record(dataDir: string, messages: unknown[]) {
  const r = await runCli(["track", "record", "--input", "-"], { dataDir, input: { messages } });
  assert.equal(r.code, 0, r.stdout);
  return r.json as Rec;
}

async function approveAndRun(dataDir: string, actions: string[]) {
  const recorded = await runCli(
    ["approval", "record", "digest-status", "--session", SESSION, "--input", "-"],
    { dataDir, input: { actions } },
  );
  assert.equal(recorded.code, 0, recorded.stdout);
  const results = [];
  for (const action of actions) {
    const hook = await runCli(["hook", "pre-tool-use"], {
      dataDir,
      input: {
        session_id: SESSION,
        tool_name: "Bash",
        tool_input: { command: `${CORE} ${action}` },
      },
    });
    assert.equal(JSON.stringify(hook.json), "{}");
    results.push(await runCli(action.split(" "), { dataDir }));
  }
  return results;
}

// ---------------------------------------------------------------------------------------
// Offering

test("with the opt-in off, or no Preferences yet, unmatched confirmations are not offered", async (t) => {
  const dataDir = tempDir(t);
  const none = await record(dataDir, [msg({ message_id: "m-1" })]);
  assert.deepEqual(none.external_offers, []);
  await prefs(dataDir);
  const off = await record(dataDir, [msg({ message_id: "m-2", thread_id: "t-2" })]);
  assert.deepEqual(off.external_offers, []);
  assert.equal(off.unmatched, 1);
});

test("with the opt-in on, a confirmation or later step is offered and nothing is created", async (t) => {
  const dataDir = tempDir(t);
  await optIn(dataDir);
  await record(dataDir, []); // the one-off backfill, so these two are ordinary offers
  const r = await record(dataDir, [
    msg({ message_id: "m-1" }),
    msg({
      message_id: "m-2",
      thread_id: "t-2",
      from: "hr@delta.example",
      classification: "interview_invite",
      company: "Delta",
      role: "Analyst",
    }),
    msg({ message_id: "m-3", thread_id: "t-3", classification: "other_job_mail" }),
  ]);
  const offers = r.external_offers as Rec[];
  assert.deepEqual(
    offers.map((o) => `${o.company} · ${o.title}`),
    ["Gamma Ltd · Data Scientist", "Delta · Analyst"],
  );
  assert.match(r.text, /EXTERNAL APPLICATIONS \(2\)/);
  assert.match(r.text, /track as External application/);
  assert.equal(r.suggested_reply, null, "an External application is never pre-selected");
  assert.deepEqual(await applications(dataDir), []);
});

test("mail for one company and role is one offer, dated by its earliest confirmation", async (t) => {
  const dataDir = tempDir(t);
  await optIn(dataDir);
  const r = await record(dataDir, [
    msg({
      message_id: "m-late",
      thread_id: "t-2",
      classification: "interview_invite",
      received_at: "2026-01-12T09:00:00.000Z",
      company: "Gamma",
    }),
    msg({ message_id: "m-ack2", thread_id: "t-3", received_at: "2026-01-09T09:00:00.000Z" }),
    msg({ message_id: "m-ack1", received_at: "2026-01-05T09:00:00.000Z" }),
  ]);
  const offers = r.external_offers as Rec[];
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.applied_at, "2026-01-05T09:00:00.000Z");
  assert.equal(offers[0]?.messages.length, 3);
});

test("a message with no company or role can't be offered", async (t) => {
  const dataDir = tempDir(t);
  await optIn(dataDir);
  const r = await record(dataDir, [msg({ message_id: "m-1", company: undefined })]);
  assert.deepEqual(r.external_offers, []);
  assert.equal(r.unmatched, 1);
});

// ---------------------------------------------------------------------------------------
// Creation (Checkpoint)

test("approving an offer creates an External application at Submitted, with no Listing", async (t) => {
  const dataDir = tempDir(t);
  await optIn(dataDir);
  await record(dataDir, [
    msg({ message_id: "m-1", received_at: "2026-01-08T10:00:00.000Z" }),
    msg({
      message_id: "m-2",
      thread_id: "t-2",
      classification: "interview_invite",
      from: "Sam <sam@mail.gamma.example>",
      received_at: "2026-01-12T10:00:00.000Z",
    }),
  ]);
  const [res] = await approveAndRun(dataDir, ["application external 1"]);
  assert.equal(res?.code, 0, res?.stdout);
  const apps = await applications(dataDir);
  assert.equal(apps.length, 1);
  const app = apps[0] as Rec;
  assert.equal(app.origin, "external");
  assert.equal(app.listing, null);
  assert.equal(app.company, "Gamma Ltd");
  assert.equal(app.title, "Data Scientist");
  assert.equal(app.status, "submitted");
  assert.equal(app.applied_at, "2026-01-08T10:00:00.000Z");
  assert.deepEqual([...app.gmail_threads].sort(), ["t-2", "t-x"]);
  assert.deepEqual([...app.mail_domains].sort(), ["gamma.example", "mail.gamma.example"]);
  assert.deepEqual(app.evidence_messages.map((m: Rec) => m.id).sort(), ["m-1", "m-2"]);
  assert.equal(app.event_log.length, 1);
  assert.equal(app.event_log[0].to, "submitted");
  assert.equal(app.event_log[0].stage, "track");
  assert.equal(app.event_log[0].approval.checkpoint, "digest-status");
  assert.equal(app.event_log[0].approval.action, "application external 1");
  for (const absent of ["tailor", "fill_plan", "answers", "decision_tree"]) {
    assert.equal(absent in app, false, `${absent} is for picked Applications`);
  }
  // The offer is settled; the digest no longer lists it.
  const digest = await runCli(["track", "digest"], { dataDir });
  assert.deepEqual(digest.json.external_offers, []);
  // Later mail on a learned thread now matches the External application.
  const next = await record(dataDir, [
    msg({ message_id: "m-3", thread_id: "t-2", classification: "offer" }),
  ]);
  assert.equal((next.proposals as Rec[])[0]?.application_id, app.id);
});

test("creating one needs the job seeker's Approval, and the hook gates it", async (t) => {
  const dataDir = tempDir(t);
  await optIn(dataDir);
  await record(dataDir, [msg({ message_id: "m-1" })]);
  const hook = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: {
      session_id: SESSION,
      tool_name: "Bash",
      tool_input: { command: `${CORE} application external 1` },
    },
  });
  assert.equal(
    (hook.json.hookSpecificOutput as Rec | undefined)?.permissionDecision,
    "deny",
    hook.stdout,
  );
  const direct = await runCli(["application", "external", "1"], { dataDir });
  assert.equal(direct.json.error?.code, "APPROVAL_MISSING");
  assert.deepEqual(await applications(dataDir), []);
});

test("an offer that doesn't exist, or one already approved, creates nothing", async (t) => {
  const dataDir = tempDir(t);
  await optIn(dataDir);
  await record(dataDir, [msg({ message_id: "m-1" })]);
  const [missing] = await approveAndRun(dataDir, ["application external 9"]);
  assert.equal(missing?.json.error?.code, "NO_OFFER");
  const [first] = await approveAndRun(dataDir, ["application external 1"]);
  assert.equal(first?.code, 0);
  const [again] = await approveAndRun(dataDir, ["application external 1"]);
  assert.equal(again?.json.error?.code, "NO_OFFER");
  assert.equal((await applications(dataDir)).length, 1);
});

test("dismissing an offer remembers its mail and never raises it again", async (t) => {
  const dataDir = tempDir(t);
  await optIn(dataDir);
  await record(dataDir, [msg({ message_id: "m-1" })]);
  const d = await runCli(["track", "dismiss", "1"], { dataDir });
  assert.equal(d.code, 0, d.stdout);
  assert.deepEqual(d.json.external_offers, []);
  const again = await record(dataDir, [msg({ message_id: "m-1" })]);
  assert.deepEqual(again.external_offers, []);
  assert.equal(again.skipped_seen, 1);
});

// ---------------------------------------------------------------------------------------
// Backfill

test("turning the opt-in on runs one backfill over the window, grouped for bulk approval", async (t) => {
  const dataDir = tempDir(t);
  await prefs(dataDir);
  // Mail read before the opt-in sits unmatched.
  await record(dataDir, [msg({ message_id: "m-old", company: "Old Co", role: "Tester" })]);
  assert.equal(
    ((await runCli(["track", "window"], { dataDir })).json.backfill as Rec).pending,
    false,
  );

  await runCli(["preferences", "set", "external_applications.enabled", "true"], { dataDir });
  const w = await runCli(["track", "window"], { dataDir });
  assert.equal((w.json.backfill as Rec).pending, true);
  assert.equal((w.json.backfill as Rec).months, 6);
  assert.equal(w.json.after, "2025/07/15");
  assert.equal(w.json.query, "after:2025/07/15");

  const r = await record(dataDir, [
    msg({ message_id: "m-1", thread_id: "t-1", received_at: "2025-08-02T10:00:00.000Z" }),
    msg({
      message_id: "m-2",
      thread_id: "t-2",
      company: "Delta",
      role: "Analyst",
      received_at: "2025-10-02T10:00:00.000Z",
    }),
  ]);
  const offers = r.external_offers as Rec[];
  assert.equal(offers.length, 3, "the earlier unmatched mail joins the backfill");
  assert.ok(offers.every((o) => o.backfill === true));
  assert.equal(r.external_bulk_reply, "approve 1, 2, 3");
  assert.match(r.text, /FROM YOUR BACKFILL/);
  const sync = await getRec(dataDir, "sync", "gmail");
  assert.equal(sync.external_backfill.months, 6);
  assert.equal(typeof sync.external_backfill.ran_at, "string");

  // Bulk approval: every action, one Approval.
  const results = await approveAndRun(dataDir, [
    "application external 1",
    "application external 2",
    "application external 3",
  ]);
  assert.ok(results.every((x) => x.code === 0));
  assert.equal((await applications(dataDir)).length, 3);
});

test("widening the window later doesn't re-run the backfill", async (t) => {
  const dataDir = tempDir(t);
  await optIn(dataDir);
  await record(dataDir, []);
  await runCli(["preferences", "set", "external_applications.backfill_months", "12"], { dataDir });
  const w = await runCli(["track", "window"], { dataDir });
  assert.equal((w.json.backfill as Rec).pending, false);
  assert.equal(w.json.after, "2026/01/14", "the normal window, a day before the last sync");
  const r = await record(dataDir, [
    msg({ message_id: "m-1", received_at: "2026-01-14T10:00:00.000Z" }),
  ]);
  assert.equal((r.external_offers as Rec[])[0]?.backfill, false);
  // Switching it off and on again doesn't re-run it either.
  await runCli(["preferences", "set", "external_applications.enabled", "false"], { dataDir });
  await runCli(["preferences", "set", "external_applications.enabled", "true"], { dataDir });
  const again = await runCli(["track", "window"], { dataDir });
  assert.equal((again.json.backfill as Rec).pending, false);
});

// ---------------------------------------------------------------------------------------
// The Board and Needs you

test("the Board shows External applications with a badge and a pending offer counts in Needs you", async (t) => {
  const dataDir = tempDir(t);
  await optIn(dataDir);
  await record(dataDir, [msg({ message_id: "m-1" })]);
  const page = async () => {
    const built = await runCli(["view", "build"], { dataDir });
    assert.equal(built.code, 0, built.stdout);
    return readFileSync(built.json.path as string, "utf8");
  };
  let html = await page();
  assert.match(html, /Needs you <span class="chip">1<\/span>/);
  assert.match(html, /External application/);
  assert.match(html, /Gamma Ltd/);
  assert.match(html, /approve 1/);

  await approveAndRun(dataDir, ["application external 1"]);
  html = await page();
  assert.match(html, /Needs you <span class="chip">0<\/span>/);
  const board = html.slice(html.indexOf('id="tab-board"'));
  assert.match(board, /Gamma Ltd[\s\S]*?<span class="chip">External<\/span>/);
});

// ---------------------------------------------------------------------------------------
// Already applied (external) and Application limits

const BACKEND = "greenhouse:acme:101";
const PLATFORM = "greenhouse:acme:102";
const BERLIN = "greenhouse:acme:103";

function listing(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    source: "greenhouse",
    board: "greenhouse:acme",
    company: "Acme",
    source_job_id: id.split(":").at(-1),
    title,
    location: "London",
    url: `https://job-boards.greenhouse.io/acme/jobs/${id.split(":").at(-1)}`,
    description: `${title} at Acme. You have shipped Go services to production.`,
    departments: ["Engineering"],
    employment_type: null,
    salary: null,
    posted_at: "2026-01-10T00:00:00.000Z",
    deadline: null,
    source_fields: {},
    aliases: [{ id, url: null }],
    sightings: [],
    first_seen_at: "2026-01-14T07:00:00.000Z",
    last_seen_at: "2026-01-14T07:00:00.000Z",
    gone: false,
    gone_at: null,
    ...extra,
  };
}

async function screenAcme(dataDir: string, extra: Record<string, unknown> = {}) {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  assert.equal(
    (await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile })).code,
    0,
  );
  await optIn(dataDir);
  await put(dataDir, "listing", BACKEND, listing(BACKEND, "Senior Backend Engineer", extra));
  await put(dataDir, "listing", PLATFORM, listing(PLATFORM, "Platform Engineer", extra));
  await put(
    dataDir,
    "listing",
    BERLIN,
    listing(BERLIN, "Senior Backend Engineer", { ...extra, location: "Berlin" }),
  );
  const all = JSON.parse(readFileSync(judgment("screen-skills-rating"), "utf8"));
  const judgments = all.judgments.filter((j: { listing_id: string }) =>
    [BACKEND, PLATFORM, BERLIN].includes(j.listing_id),
  );
  const r = await runCli(["screen", "record", "--input", "-"], { dataDir, input: { judgments } });
  assert.equal(r.code, 0, r.stdout);
}

async function shortlistIds(dataDir: string) {
  const r = await runCli(["screen", "digest"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  return r;
}

async function externalAcme(dataDir: string, title = "Senior Backend Engineer") {
  await record(dataDir, [
    msg({
      message_id: "m-acme",
      thread_id: "t-acme",
      from: "jobs@acme-careers.example",
      company: "Acme",
      role: title,
      received_at: "2026-01-05T09:00:00.000Z",
    }),
  ]);
  const [res] = await approveAndRun(dataDir, ["application external 1"]);
  assert.equal(res?.code, 0, res?.stdout);
  return (await applications(dataDir))[0] as Rec;
}

test("Screen marks a later matching Listing 'already applied (external)' and keeps it off the Shortlist", async (t) => {
  const dataDir = tempDir(t);
  await screenAcme(dataDir);
  const before = await shortlistIds(dataDir);
  assert.deepEqual(
    (before.json.shortlist as Rec[]).map((s) => s.id).sort(),
    [BACKEND, BERLIN, PLATFORM].sort(),
  );
  const app = await externalAcme(dataDir);
  const after = await shortlistIds(dataDir);
  assert.deepEqual(
    (after.json.shortlist as Rec[]).map((s) => s.id),
    [PLATFORM],
  );
  const marked = (after.json.already_applied as Rec[]).map((m) => m.id).sort();
  assert.deepEqual(marked, [BACKEND, BERLIN].sort());
  assert.equal((after.json.already_applied as Rec[])[0]?.label, "already applied (external)");
  assert.equal((after.json.already_applied as Rec[])[0]?.application_id, app.id);
  assert.match(String(after.json.text), /already applied \(external\)/);
});

test("only the job seeker links a different Listing to an External application", async (t) => {
  const dataDir = tempDir(t);
  await screenAcme(dataDir);
  const app = await externalAcme(dataDir);
  assert.ok(((await shortlistIds(dataDir)).json.shortlist as Rec[]).some((s) => s.id === PLATFORM));

  const linked = await runCli(["application", "link-external", PLATFORM, app.id], { dataDir });
  assert.equal(linked.code, 0, linked.stdout);
  const l = await getRec(dataDir, "listing", PLATFORM);
  assert.equal(l.already_applied.application_id, app.id);
  assert.equal(l.already_applied.kind, "external");
  assert.deepEqual(
    ((await shortlistIds(dataDir)).json.shortlist as Rec[]).map((s) => s.id),
    [],
  );
  assert.ok((await getRec(dataDir, "application", app.id)).linked_listings.includes(PLATFORM));

  const notExternal = await runCli(["application", "link-external", PLATFORM, "nope"], { dataDir });
  assert.equal(notExternal.json.error?.code, "NOT_FOUND");
});

test("a closed External application doesn't mark a later Listing", async (t) => {
  const dataDir = tempDir(t);
  await screenAcme(dataDir);
  const app = await externalAcme(dataDir);
  await put(dataDir, "application", app.id, { ...app, status: "rejected" });
  const ids = ((await shortlistIds(dataDir)).json.shortlist as Rec[]).map((s) => s.id).sort();
  assert.deepEqual(ids, [BACKEND, BERLIN, PLATFORM].sort());
});

test("External applications count toward Application limits, dated by the earliest confirmation mail", async (t) => {
  const dataDir = tempDir(t);
  await screenAcme(dataDir);
  await put(dataDir, "employer", "emp-acme", {
    name: "Acme Ltd",
    application_limit_note: { count: 1, window_days: 30, scope: "company" },
  });
  for (const id of [BACKEND, PLATFORM, BERLIN]) {
    const l = await getRec(dataDir, "listing", id);
    await put(dataDir, "listing", id, { ...l, employer: "emp-acme" });
  }
  const rescore = await runCli(["screen", "rescore", "all"], { dataDir });
  assert.equal(rescore.code, 0, rescore.stdout);
  const all = JSON.parse(readFileSync(judgment("screen-skills-rating"), "utf8"));
  const judgments = all.judgments.filter((j: { listing_id: string }) =>
    [BACKEND, PLATFORM, BERLIN].includes(j.listing_id),
  );
  await runCli(["screen", "record", "--input", "-"], { dataDir, input: { judgments } });
  const clear = ((await shortlistIds(dataDir)).json.shortlist as Rec[]).find(
    (s) => s.id === PLATFORM,
  );
  assert.deepEqual(clear?.flags, []);

  // A confirmation 10 days ago is in the 30-day window; one found later but dated 60 days
  // ago would not be. The earliest confirmation dates it.
  await record(dataDir, [
    msg({
      message_id: "m-b",
      thread_id: "t-b",
      company: "Acme",
      role: "Staff Engineer",
      received_at: "2026-01-09T09:00:00.000Z",
    }),
    msg({
      message_id: "m-a",
      thread_id: "t-a",
      company: "Acme",
      role: "Staff Engineer",
      received_at: "2026-01-05T09:00:00.000Z",
    }),
  ]);
  await approveAndRun(dataDir, ["application external 1"]);
  const app = (await applications(dataDir))[0] as Rec;
  assert.equal(app.applied_at, "2026-01-05T09:00:00.000Z");
  const flagged = ((await shortlistIds(dataDir)).json.shortlist as Rec[]).find(
    (s) => s.id === PLATFORM,
  );
  assert.match(flagged?.flags[0] ?? "", /would be your 2nd of 1 at Acme in 30 days/);
});
