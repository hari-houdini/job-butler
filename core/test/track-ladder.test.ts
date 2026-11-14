import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runCli, tempDir } from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CORE = "node /plugins/job-butler/core/src/cli.ts";
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON records read back from the CLI
type Rec = Record<string, any>;
const SESSION = "session-1";

async function put(dataDir: string, type: string, id: string, data: unknown) {
  const r = await runCli(["record", "put", type, id, "--input", "-"], { dataDir, input: data });
  assert.equal(r.code, 0, r.stdout);
}

function listing(id: string, company: string, title: string, employer?: string) {
  const [ats, slug, jobId] = id.split(":") as [string, string, string];
  const url = `https://jobs.lever.co/${slug}/${jobId}`;
  return {
    source: ats,
    board: `${ats}:${slug}`,
    company,
    source_job_id: jobId,
    title,
    location: "London",
    url,
    aliases: [{ id, url, board: `${ats}:${slug}`, source_job_id: jobId }],
    sightings: [],
    gone: false,
    ...(employer ? { employer } : {}),
  };
}

interface Seed {
  id: string;
  company: string;
  title: string;
  status?: string;
  employer?: string;
  mail_domains?: string[];
}

async function seed(dataDir: string, apps: Seed[]) {
  for (const a of apps) {
    const lid = `lever:${a.company.toLowerCase().replaceAll(" ", "")}:${a.id}`;
    await put(dataDir, "listing", lid, listing(lid, a.company, a.title, a.employer));
    await put(dataDir, "application", a.id, {
      origin: "picked",
      listing: lid,
      company: a.company,
      title: a.title,
      status: a.status ?? "submitted",
      event_log: [],
      gmail_threads: [],
      ...(a.mail_domains ? { mail_domains: a.mail_domains } : {}),
    });
  }
}

function msg(over: Record<string, unknown>) {
  return {
    message_id: "m-x",
    thread_id: "t-x",
    from: "hr@somewhere.example",
    subject: "Hello",
    received_at: "2026-01-14T10:00:00.000Z",
    classification: "rejection",
    ...over,
  };
}

async function record(dataDir: string, messages: unknown[]) {
  const r = await runCli(["track", "record", "--input", "-"], { dataDir, input: { messages } });
  assert.equal(r.code, 0, r.stdout);
  return r.json as Rec;
}

async function getRec(dataDir: string, type: string, id: string) {
  const r = await runCli(["record", "get", type, id], { dataDir });
  return (r.json.record ?? r.json) as Rec;
}

async function approveAndRun(dataDir: string, action: string) {
  const recorded = await runCli(
    ["approval", "record", "digest-status", "--session", SESSION, "--input", "-"],
    { dataDir, input: { actions: [action] } },
  );
  assert.equal(recorded.code, 0, recorded.stdout);
  const hook = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: SESSION, tool_name: "Bash", tool_input: { command: `${CORE} ${action}` } },
  });
  assert.equal(JSON.stringify(hook.json), "{}");
  return runCli(action.split(" "), { dataDir });
}

const ACME = { id: "a1", company: "Acme", title: "Backend Engineer" };
const BETA1 = { id: "b1", company: "Beta Labs", title: "Platform Engineer" };
const BETA2 = { id: "b2", company: "Beta Labs", title: "Data Engineer" };

// ---------------------------------------------------------------------------------------
// Step 3: learned mail domain

test("step 3: a learned Application mail domain matches; with one open Application it is sure", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [{ ...ACME, mail_domains: ["acme.example"] }, BETA1]);
  const r = await record(dataDir, [msg({ from: "Jo <jo@mail.acme.example>" })]);
  const [p] = r.proposals as Rec[];
  assert.equal(p?.application_id, "a1");
  assert.equal(p?.confidence, "sure");
  assert.equal(p?.preselected, true);
  assert.match(p?.message.matched_by, /mail domain \(step 3\)/);
});

test("step 3: an Employer's learned domain matches; several open Applications make it several candidates", async (t) => {
  const dataDir = tempDir(t);
  await put(dataDir, "employer", "emp-beta", { name: "Beta Labs", mail_domains: ["beta.example"] });
  await seed(dataDir, [
    { ...BETA1, employer: "emp-beta" },
    { ...BETA2, employer: "emp-beta" },
  ]);
  const r = await record(dataDir, [msg({ from: "hr@beta.example" })]);
  assert.deepEqual(r.proposed, []);
  assert.equal(r.unmatched, 1);
  const sync = await getRec(dataDir, "sync", "gmail");
  assert.deepEqual([...sync.unmatched[0].candidates].sort(), ["b1", "b2"]);
});

test("step 3: an Employer's only open Application is sure even when another one is closed", async (t) => {
  const dataDir = tempDir(t);
  await put(dataDir, "employer", "emp-beta", { name: "Beta Labs", mail_domains: ["beta.example"] });
  await seed(dataDir, [
    { ...BETA1, employer: "emp-beta" },
    { ...BETA2, employer: "emp-beta", status: "rejected" },
  ]);
  const r = await record(dataDir, [msg({ from: "hr@beta.example" })]);
  const [p] = r.proposals as Rec[];
  assert.equal(p?.application_id, "b1");
  assert.equal(p?.confidence, "sure");
});

test("step 3: vendor and free-mail domains are never a match, even if listed as learned", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [
    { ...ACME, mail_domains: ["greenhouse.io", "gmail.com", "myworkday.com", "calendly.com"] },
  ]);
  for (const from of [
    "no-reply@greenhouse.io",
    "no-reply@us.greenhouse-mail.io",
    "someone@gmail.com",
    "acme@myworkday.com",
    "n@calendly.com",
  ]) {
    const r = await record(dataDir, [
      msg({ message_id: `m-${from}`, thread_id: `t-${from}`, from }),
    ]);
    assert.deepEqual(r.proposed, [], from);
    assert.equal(r.unmatched, 1, from);
  }
});

// ---------------------------------------------------------------------------------------
// Step 4 and 5

test("step 4: a sender name or signature naming the company is probable, with a reason", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [ACME, BETA1]);
  const r = await record(dataDir, [
    msg({ message_id: "m1", thread_id: "t1", from: "Acme Talent Team <noreply@bamboo.example>" }),
    msg({
      message_id: "m2",
      thread_id: "t2",
      from: "no-reply@greenhouse.io",
      signature: "Sam Lee, Recruiter, Beta Labs",
    }),
  ]);
  const ps = r.proposals as Rec[];
  assert.deepEqual(
    ps.map((p) => [p.application_id, p.confidence, p.preselected]),
    [
      ["a1", "probable", false],
      ["b1", "probable", false],
    ],
  );
  assert.match(ps[0]?.message.matched_by, /named sender \(step 4\)/);
  assert.match(ps[0]?.note, /Acme/);
  assert.match(String(r.text), /\[probable\]/);
  assert.match(String(r.text), /Why probable: /);
});

test("step 5: company and role in the body pick one of two Applications at a company", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [BETA1, BETA2]);
  const r = await record(dataDir, [
    msg({ from: "x@unknown.example", company: "Beta Labs", role: "Data Engineer" }),
  ]);
  const [p] = r.proposals as Rec[];
  assert.equal(p?.application_id, "b2");
  assert.equal(p?.confidence, "probable");
  assert.match(p?.message.matched_by, /body \(step 5\)/);
});

test("the first step to leave exactly one candidate wins over later steps", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [{ ...ACME, mail_domains: ["acme.example"] }, BETA1]);
  const r = await record(dataDir, [
    msg({ from: "Beta Labs <hr@acme.example>", company: "Beta Labs", role: "Platform Engineer" }),
  ]);
  assert.equal((r.proposals as Rec[])[0]?.application_id, "a1");
});

// ---------------------------------------------------------------------------------------
// Several candidates, none, assign, dismiss

test("several candidates are listed ranked and the job seeker picks one; one message updates one Application", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [BETA1, BETA2, ACME]);
  const r = await record(dataDir, [
    msg({
      message_id: "m-sev",
      thread_id: "t-sev",
      from: "Beta Labs Recruiting <r@bl.example>",
      company: "Beta Labs",
      role: "Platform Engineer",
    }),
  ]);
  // Step 4 finds both Beta Applications; step 5 narrows to one, so this one is matched.
  assert.equal((r.proposals as Rec[])[0]?.application_id, "b1");

  const dir2 = tempDir(t);
  await seed(dir2, [BETA1, BETA2]);
  const two = await record(dir2, [
    msg({ message_id: "m-sev", thread_id: "t-sev", from: "Beta Labs Recruiting <r@bl.example>" }),
  ]);
  assert.deepEqual(two.proposed, []);
  const [u] = two.unmatched_items as Rec[];
  assert.equal(u?.candidates.length, 2);
  assert.ok(u?.candidates.every((c: Rec) => typeof c.reason === "string" && c.reason !== ""));
  assert.match(String(two.text), /pick one: track assign m-sev <application-id>/);

  const pick = await runCli(["track", "assign", "m-sev", "b2"], { dataDir: dir2 });
  assert.equal(pick.code, 0, pick.stdout);
  assert.deepEqual(
    (pick.json.proposals as Rec[]).map((p) => p.application_id),
    ["b2"],
  );
  assert.equal(pick.json.unmatched, 0);
  const again = await runCli(["track", "assign", "m-sev", "b1"], { dataDir: dir2 });
  assert.equal(again.json.error?.code, "NOT_UNMATCHED");
});

test("no candidate: the message is unmatched, listed with its ATS-mail hint", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [ACME]);
  const r = await record(dataDir, [msg({ from: "no-reply@ashbyhq.com" })]);
  assert.equal(r.unmatched, 1);
  const [u] = r.unmatched_items as Rec[];
  assert.deepEqual(u?.candidates, []);
  assert.equal(u?.ats_mail, true);
});

test("unmatched mail can be dismissed and is never raised again", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [ACME]);
  await record(dataDir, [msg({ message_id: "m-d", thread_id: "t-d" })]);
  const d = await runCli(["track", "dismiss-mail", "m-d"], { dataDir });
  assert.equal(d.code, 0, d.stdout);
  assert.equal(d.json.unmatched, 0);
  const again = await record(dataDir, [msg({ message_id: "m-d", thread_id: "t-d" })]);
  assert.equal(again.unmatched, 0);
  assert.equal(again.skipped_seen, 1);
  const bad = await runCli(["track", "dismiss-mail", "m-none"], { dataDir });
  assert.equal(bad.json.error?.code, "NOT_UNMATCHED");
});

// ---------------------------------------------------------------------------------------
// Learning

test("an approved match records the thread and the sender's domain, and the next mail matches by domain", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [ACME, BETA1]);
  await record(dataDir, [
    msg({
      message_id: "m1",
      thread_id: "t-acme",
      from: "Acme Talent <hr@acme.example>",
      company: "Acme",
      classification: "interview_invite",
    }),
  ]);
  const ok = await approveAndRun(dataDir, "application status a1 interview 1");
  assert.equal(ok.code, 0, ok.stdout);
  const app = await getRec(dataDir, "application", "a1");
  assert.deepEqual(app.gmail_threads, ["t-acme"]);
  assert.deepEqual(app.mail_domains, ["acme.example"]);

  const next = await record(dataDir, [
    msg({
      message_id: "m2",
      thread_id: "t-other",
      from: "bob@acme.example",
      classification: "offer",
    }),
  ]);
  const p = (next.proposals as Rec[]).find((x) => x.message?.id === "m2");
  assert.equal(p?.application_id, "a1");
  assert.match(p?.message.matched_by, /mail domain \(step 3\)/);
});

test("learning also records the domain on the Employer, and skips vendor and free-mail senders", async (t) => {
  const dataDir = tempDir(t);
  await put(dataDir, "employer", "emp-beta", { name: "Beta Labs" });
  await seed(dataDir, [
    { ...BETA1, employer: "emp-beta" },
    { ...ACME, id: "a9" },
  ]);
  await record(dataDir, [
    msg({
      message_id: "m1",
      thread_id: "t1",
      from: "Beta Labs <hr@beta.example>",
      company: "Beta Labs",
    }),
    msg({
      message_id: "m2",
      thread_id: "t2",
      from: "Acme <no-reply@greenhouse.io>",
      company: "Acme",
    }),
  ]);
  await approveAndRun(dataDir, "application status b1 rejected 1");
  await approveAndRun(dataDir, "application status a9 rejected 2");
  assert.deepEqual((await getRec(dataDir, "employer", "emp-beta")).mail_domains, ["beta.example"]);
  assert.deepEqual((await getRec(dataDir, "application", "a9")).mail_domains ?? [], []);
  assert.deepEqual((await getRec(dataDir, "application", "a9")).gmail_threads, ["t2"]);
});

// ---------------------------------------------------------------------------------------
// Reply-To: step 3 tries the sender's domain, then the Reply-To domain (decision #27)

test("step 3: a Reply-To domain learned for an Application matches when the sender's domain does not", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [{ ...ACME, mail_domains: ["acme.example"] }, BETA1]);
  const r = await record(dataDir, [
    msg({
      from: "Talent Team <no-reply@bamboo.example>",
      reply_to: "Acme Talent <talent@acme.example>",
    }),
  ]);
  const [p] = r.proposals as Rec[];
  assert.equal(p?.application_id, "a1");
  assert.equal(p?.confidence, "sure");
  assert.match(p?.message.matched_by, /mail domain \(step 3\)/);
});

test("step 3: when the sender's and Reply-To domains learned for different Applications disagree, the sender's wins", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [
    { ...ACME, mail_domains: ["acme.example"] },
    { ...BETA1, mail_domains: ["beta.example"] },
  ]);
  const r = await record(dataDir, [msg({ from: "hr@acme.example", reply_to: "hr@beta.example" })]);
  const [p] = r.proposals as Rec[];
  assert.equal(p?.application_id, "a1");
});

test("an approved match learns the Reply-To domain as well as the sender's, on the Application and its Employer", async (t) => {
  const dataDir = tempDir(t);
  await put(dataDir, "employer", "emp-beta", { name: "Beta Labs" });
  await seed(dataDir, [{ ...BETA1, employer: "emp-beta" }]);
  await record(dataDir, [
    msg({
      message_id: "m1",
      thread_id: "t1",
      from: "Beta Hiring <no-reply@bamboo.example>",
      reply_to: "Beta Labs <jobs@beta.example>",
      company: "Beta Labs",
      classification: "rejection",
    }),
  ]);
  const ok = await approveAndRun(dataDir, "application status b1 rejected 1");
  assert.equal(ok.code, 0, ok.stdout);
  assert.deepEqual((await getRec(dataDir, "application", "b1")).mail_domains, [
    "bamboo.example",
    "beta.example",
  ]);
  assert.deepEqual((await getRec(dataDir, "employer", "emp-beta")).mail_domains, [
    "bamboo.example",
    "beta.example",
  ]);
});

test("a Reply-To that is not text refuses the whole record", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [ACME]);
  const r = await runCli(["track", "record", "--input", "-"], {
    dataDir,
    input: { messages: [msg({ reply_to: 5 })] },
  });
  assert.notEqual(r.code, 0);
  assert.equal(r.json.error?.code, "CLASSIFICATION_INVALID");
});

// ---------------------------------------------------------------------------------------
// Calendar events

test("a Calendar event uses the same ladder with the organizer as sender and counts as an interview invite", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [{ ...ACME, mail_domains: ["acme.example"] }, BETA1]);
  const r = await record(dataDir, [
    {
      message_id: "cal:ev1",
      thread_id: "ev1",
      source: "calendar",
      from: "Pat <pat@acme.example>",
      subject: "Interview: Backend Engineer",
      received_at: "2026-01-14T10:00:00.000Z",
    },
  ]);
  const [p] = r.proposals as Rec[];
  assert.equal(p?.application_id, "a1");
  assert.equal(p?.to, "interview");
  assert.equal(p?.message.source, "calendar");
  assert.match(String(r.text), /Calendar event/);

  await approveAndRun(dataDir, "application status a1 interview 1");
  const app = await getRec(dataDir, "application", "a1");
  assert.deepEqual(app.calendar_events, ["ev1"]);
  assert.deepEqual(app.gmail_threads, []);

  const second = await record(dataDir, [
    {
      message_id: "cal:ev1b",
      thread_id: "ev1",
      source: "calendar",
      from: "x@y.example",
      subject: "Moved",
      received_at: "2026-01-15T10:00:00.000Z",
    },
  ]);
  assert.equal(second.new, 1);
  assert.equal(second.no_change, 1);
});

test("a Calendar event from a scheduling vendor with the company named is matched at step 5", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir, [BETA1, BETA2]);
  const r = await record(dataDir, [
    {
      message_id: "cal:ev2",
      thread_id: "ev2",
      source: "calendar",
      from: "invites@calendly.com",
      subject: "Chat with Beta Labs",
      received_at: "2026-01-14T10:00:00.000Z",
      company: "Beta Labs",
      role: "Platform Engineer",
    },
  ]);
  assert.equal((r.proposals as Rec[])[0]?.application_id, "b1");
});

// ---------------------------------------------------------------------------------------
// The worker stays read-only

test("the track worker may also read Calendar (search_events, get_event, list_events) and nothing that writes", async () => {
  const text = readFileSync(join(ROOT, "agents/track-worker.md"), "utf8");
  const tools = (text.match(/^tools:\s*(.+)$/m)?.[1] ?? "").split(",").map((s) => s.trim());
  const calendar = tools.filter((x) => x.startsWith("mcp__claude_ai_Google_Calendar__")).sort();
  assert.deepEqual(calendar, [
    "mcp__claude_ai_Google_Calendar__get_event",
    "mcp__claude_ai_Google_Calendar__list_events",
    "mcp__claude_ai_Google_Calendar__search_events",
  ]);
  for (const tool of tools)
    assert.doesNotMatch(tool, /send|label|trash|draft|delete|update|create|respond|forward/);
});
