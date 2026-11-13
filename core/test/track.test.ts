import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CORE = "node /plugins/job-butler/core/src/cli.ts";
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON records read back from the CLI
type Rec = Record<string, any>;
const SESSION = "session-1";

function listing(id: string, board: string, company: string, title: string) {
  const [ats, slug, jobId] = id.split(":") as [string, string, string];
  const url =
    ats === "greenhouse"
      ? `https://job-boards.greenhouse.io/${slug}/jobs/${jobId}`
      : `https://jobs.lever.co/${slug}/${jobId}`;
  return {
    source: ats,
    board,
    company,
    source_job_id: jobId,
    title,
    location: "London",
    url,
    aliases: [{ id, url, board, source_job_id: jobId }],
    sightings: [],
    gone: false,
    screen: { outcome: "shortlist", excluded_by: null, checks: [], flags: [], badges: [] },
  };
}

const LISTINGS = [
  listing("greenhouse:acme:101", "greenhouse:acme", "Acme", "Senior Backend Engineer"),
  listing("lever:beta:202", "lever:beta", "Beta", "Platform Engineer"),
  listing("lever:beta:203", "lever:beta", "Beta", "Data Engineer"),
];

async function put(dataDir: string, type: string, id: string, data: unknown) {
  const r = await runCli(["record", "put", type, id, "--input", "-"], { dataDir, input: data });
  assert.equal(r.code, 0, r.stdout);
}

/** One Application per Listing, each Submitted (Acme's already knows its Gmail thread). */
async function setUp(dataDir: string, status = "submitted") {
  for (const l of LISTINGS) await put(dataDir, "listing", l.aliases[0]?.id as string, l);
  for (const [i, l] of LISTINGS.entries()) {
    await put(dataDir, "application", `app-${i + 1}`, {
      origin: "picked",
      listing: l.aliases[0]?.id,
      company: l.company,
      title: l.title,
      status,
      event_log: [],
      gmail_threads: i === 0 ? ["t-acme-1"] : [],
      answers: [],
      fill_plan: null,
      tailor: null,
    });
  }
}

const classified = () => JSON.parse(readFileSync(judgment("track-classification"), "utf8"));

async function trackRecord(dataDir: string, input: unknown = classified()) {
  const r = await runCli(["track", "record", "--input", "-"], { dataDir, input });
  assert.equal(r.code, 0, r.stdout);
  return r.json as Rec;
}

async function getApp(dataDir: string, id: string) {
  const r = await runCli(["record", "get", "application", id], { dataDir });
  return (r.json.record ?? r.json) as Rec;
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

// ---------------------------------------------------------------------------------------
// Sync record: window and dedupe

test("the first window reaches back 30 days; later windows start a day before the last sync", async (t) => {
  const dataDir = tempDir(t);
  const first = await runCli(["track", "window"], { dataDir });
  assert.equal(first.json.after, "2025/12/16");
  assert.equal(first.json.query, "after:2025/12/16");

  await setUp(dataDir);
  await trackRecord(dataDir);
  const later = await runCli(["track", "window"], { dataDir });
  assert.equal(later.json.last_synced_at, "2026-01-15T09:00:00.000Z");
  assert.equal(later.json.after, "2026/01/14");
});

test("a message already processed is not proposed again", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const one = await trackRecord(dataDir);
  assert.equal(one.new, 3);
  assert.deepEqual(one.proposed, [1, 2]);

  const two = await trackRecord(dataDir);
  assert.equal(two.new, 0);
  assert.equal(two.skipped_seen, 3);
  assert.deepEqual(two.proposed, []);
  assert.equal((two.proposals as unknown[]).length, 2);

  const sync = await runCli(["record", "get", "sync", "gmail"], { dataDir });
  const rec = (sync.json.record ?? sync.json) as Rec;
  assert.deepEqual(rec.processed_ids, ["m-reject-1", "m-invite-2", "m-other-3"]);
});

test("a dismissed proposal's message is remembered and never raised again", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await trackRecord(dataDir);
  const d = await runCli(["track", "dismiss", "1"], { dataDir });
  assert.equal(d.code, 0, d.stdout);
  assert.equal((d.json.proposals as unknown[]).length, 1);

  const again = await trackRecord(dataDir);
  assert.deepEqual(again.proposed, []);
  assert.equal((again.proposals as unknown[]).length, 1);
});

test("unusable classifications refuse and record nothing", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await runCli(["track", "record", "--input", "-"], {
    dataDir,
    input: { messages: [msg({ classification: "spam" })] },
  });
  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "CLASSIFICATION_INVALID");
  const w = await runCli(["track", "window"], { dataDir });
  assert.equal(w.json.last_synced_at, null);
});

// ---------------------------------------------------------------------------------------
// The ladder: step 1 thread, step 2 ATS ID

test("step 1: a message on a known Gmail thread matches that Application", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await trackRecord(dataDir, {
    messages: [msg({ thread_id: "t-acme-1", from: "someone@unknown.example" })],
  });
  const [p] = r.proposals as Rec[];
  assert.equal(p?.application_id, "app-1");
  assert.match(p?.message.matched_by, /thread \(step 1\)/);
});

test("step 2: a job URL matches the Application whose Listing alias it is", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await trackRecord(dataDir, {
    messages: [
      msg({
        thread_id: "t-new",
        ats: { job_url: "https://boards.greenhouse.io/acme/jobs/101?gh_src=abc" },
      }),
    ],
  });
  const [p] = r.proposals as Rec[];
  assert.equal(p?.application_id, "app-1");
  assert.match(p?.message.matched_by, /ATS ID \(step 2\)/);
});

test("step 2: a job ID with its board slug picks one posting; a slug alone with two is not a match", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await trackRecord(dataDir, {
    messages: [
      msg({ message_id: "m-a", thread_id: "t-a", ats: { board_slug: "beta", job_id: "203" } }),
      msg({ message_id: "m-b", thread_id: "t-b", ats: { board_slug: "beta" } }),
    ],
  });
  assert.deepEqual(
    (r.proposals as Rec[]).map((p) => p.application_id),
    ["app-3"],
  );
  assert.equal(r.unmatched, 1);
});

test("step 2: a Workday tenant matches the Application on that tenant's board", async (t) => {
  const dataDir = tempDir(t);
  const wd = {
    ...listing("lever:gamma:1", "workday:gamma:wd5:External", "Gamma", "Analyst"),
    aliases: [
      {
        id: "workday:gamma:wd5:External:JR-1",
        url: "https://gamma.wd5.myworkdayjobs.com/External/job/London/Analyst_JR-1",
        board: "workday:gamma:wd5:External",
      },
    ],
  };
  await put(dataDir, "listing", "workday:gamma:wd5:External:JR-1", wd);
  await put(dataDir, "application", "app-w", {
    origin: "picked",
    listing: "workday:gamma:wd5:External:JR-1",
    company: "Gamma",
    title: "Analyst",
    status: "submitted",
    event_log: [],
    gmail_threads: [],
  });
  const r = await trackRecord(dataDir, {
    messages: [msg({ ats: { workday_tenant: "Gamma" }, from: "gamma@myworkday.com" })],
  });
  assert.equal((r.proposals as Rec[])[0]?.application_id, "app-w");
});

test("a vendor sender is only a hint: with no thread or ATS ID the message is unmatched", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  for (const from of [
    "no-reply@greenhouse.io",
    "no-reply@us.greenhouse-mail.io",
    "no-reply@ashbyhq.com",
    "gamma@myworkday.com",
    "invites@calendly.com",
    "scheduling@goodtime.io",
  ]) {
    const r = await trackRecord(dataDir, {
      messages: [msg({ message_id: `m-${from}`, thread_id: `t-${from}`, from })],
    });
    assert.deepEqual(r.proposed, [], from);
    assert.equal(r.unmatched, 1, from);
  }
});

// ---------------------------------------------------------------------------------------
// Proposals

test("each classification proposes the Status the spec lists, only where it makes sense", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, "handover");
  const r = await trackRecord(dataDir, {
    messages: [
      msg({ message_id: "m1", thread_id: "t-acme-1", classification: "acknowledgement" }),
      msg({
        message_id: "m2",
        thread_id: "t2",
        classification: "offer",
        ats: { job_url: "https://jobs.lever.co/beta/202" },
      }),
      msg({
        message_id: "m3",
        thread_id: "t3",
        classification: "other_job_mail",
        ats: { job_url: "https://jobs.lever.co/beta/203" },
      }),
    ],
  });
  assert.deepEqual(
    (r.proposals as Rec[]).map((p) => `${p.application_id}:${p.from}>${p.to}`),
    ["app-1:handover>submitted", "app-2:handover>offer"],
  );
  assert.equal(r.no_change, 1);
  assert.match(String(r.text), /Handover → Submitted/);
});

test("Withdrawn and No response are proposed with track propose", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await runCli(["track", "propose", "app-2", "no_response", "--input", "-"], {
    dataDir,
    input: { reason: "No reply in 30 days." },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.proposed, [1]);
  const bad = await runCli(["track", "propose", "app-2", "offer", "--input", "-"], {
    dataDir,
    input: { reason: "x" },
  });
  assert.equal(bad.code, 2);
});

// ---------------------------------------------------------------------------------------
// Approval: `approve <n>` at the digest Checkpoint

async function approveAndRun(dataDir: string, action: string, session = SESSION) {
  const recorded = await runCli(
    ["approval", "record", "digest-status", "--session", session, "--input", "-"],
    { dataDir, input: { actions: [action] } },
  );
  assert.equal(recorded.code, 0, recorded.stdout);
  const hook = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: session, tool_name: "Bash", tool_input: { command: `${CORE} ${action}` } },
  });
  assert.equal(JSON.stringify(hook.json), "{}", "the hook lets the approved change through");
  return {
    approval: recorded.json.approval as { id: string; checkpoint: string; approved_at: string },
    result: await runCli(action.split(" "), { dataDir }),
  };
}

test("an approved proposal becomes an Event log entry with the reason, Approval and message", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await trackRecord(dataDir);

  const { approval, result } = await approveAndRun(dataDir, "application status app-1 rejected 1");
  assert.equal(result.code, 0, result.stdout);

  const app = await getApp(dataDir, "app-1");
  assert.equal(app.status, "rejected");
  assert.deepEqual(app.gmail_threads, ["t-acme-1"]);
  const [entry] = app.event_log;
  assert.equal(entry.stage, "track");
  assert.equal(entry.from, "submitted");
  assert.equal(entry.to, "rejected");
  assert.match(entry.reason, /Rejection email from Acme Recruiting/);
  assert.equal(entry.approval.id, approval.id);
  assert.equal(entry.approval.checkpoint, "digest-status");
  assert.equal(entry.message.id, "m-reject-1");

  const digest = await runCli(["track", "digest"], { dataDir });
  assert.deepEqual(
    (digest.json.proposals as { n: number }[]).map((p) => p.n),
    [2],
  );
});

test("approval teaches Track the thread, so the next message on it matches by thread", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await trackRecord(dataDir);
  await approveAndRun(dataDir, "application status app-2 interview 2");
  assert.deepEqual((await getApp(dataDir, "app-2")).gmail_threads, ["t-beta-2"]);

  const r = await trackRecord(dataDir, {
    messages: [msg({ message_id: "m-next", thread_id: "t-beta-2", classification: "offer" })],
  });
  const p = (r.proposals as Rec[]).find((x) => x.message?.id === "m-next");
  assert.equal(p?.application_id, "app-2");
  assert.equal(p?.from, "interview");
  assert.match(p?.message.matched_by, /thread/);
});

test("without an Approval the hook denies the Status change and the command refuses", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await trackRecord(dataDir);
  const hook = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: {
      session_id: SESSION,
      tool_name: "Bash",
      tool_input: { command: `${CORE} application status app-1 rejected 1` },
    },
  });
  assert.equal((hook.json.hookSpecificOutput as Record<string, string>).permissionDecision, "deny");
  const direct = await runCli(["application", "status", "app-1", "rejected", "1"], { dataDir });
  assert.equal(direct.code, 1);
  assert.equal(direct.json.error?.code, "APPROVAL_MISSING");
  assert.equal((await getApp(dataDir, "app-1")).status, "submitted");
});

test("an Approval covers only the proposal it names", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await trackRecord(dataDir);
  const { result } = await approveAndRun(dataDir, "application status app-1 offer 1");
  assert.equal(result.code, 1);
  assert.equal(result.json.error?.code, "NO_PROPOSAL");
  assert.equal((await getApp(dataDir, "app-1")).status, "submitted");
});

test("a proposal goes stale when the Status moved since", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await trackRecord(dataDir);
  const app = await getApp(dataDir, "app-1");
  await put(dataDir, "application", "app-1", { ...app, status: "withdrawn" });
  const { result } = await approveAndRun(dataDir, "application status app-1 rejected 1");
  assert.equal(result.json.error?.code, "STALE_PROPOSAL");
});

// ---------------------------------------------------------------------------------------
// Decision tree outcome node

test("the Decision tree gains an outcome node citing the matched message", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await trackRecord(dataDir);
  await approveAndRun(dataDir, "application status app-1 rejected 1");
  const tree = readFileSync(
    join(dataDir, "decision-trees", `${encodeURIComponent("greenhouse:acme:101")}.mmd`),
    "utf8",
  );
  assert.match(tree, /Outcome: rejection/);
  assert.match(tree, /Message m-reject-1/);
  assert.match(tree, /Your application to Senior Backend Engineer/);
  assert.match(tree, /Status: Rejected/);
});

// ---------------------------------------------------------------------------------------
// The worker is read-only

test("the track worker's tools are Gmail reads that the hook allows, and nothing that writes", async (t) => {
  const text = readFileSync(join(ROOT, "agents/track-worker.md"), "utf8");
  const tools = (text.match(/^tools:\s*(.+)$/m)?.[1] ?? "").split(",").map((s) => s.trim());
  assert.ok(tools.length >= 3);
  const dataDir = tempDir(t);
  await runCli(["status"], { dataDir });
  const marked = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: SESSION, tool_name: "Bash", tool_input: { command: `${CORE} status` } },
  });
  assert.equal(marked.code, 0);
  for (const tool of tools) {
    assert.match(
      tool,
      /^mcp__claude_ai_(Gmail__(search_threads|get_thread|get_message)|Google_Calendar__(search_events|get_event|list_events))$/,
    );
    const r = await runCli(["hook", "pre-tool-use"], {
      dataDir,
      input: { session_id: SESSION, tool_name: tool, tool_input: {} },
    });
    assert.equal(JSON.stringify(r.json), "{}", tool);
  }
});
