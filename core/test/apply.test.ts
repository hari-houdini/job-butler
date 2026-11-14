import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURES, hostVar, judgment, runCli, tempDir } from "./harness.ts";

// biome-ignore lint/suspicious/noExplicitAny: parsed test JSON
type Any = any;

export const APP = "app-1";
export const LISTING = "greenhouse:acme:101";

/** A Profile, a Tailored Application for Acme's job 101 (or `jobId`) and its Tailor files. */
export async function setUp(
  dataDir: string,
  opts: { jobId?: string; url?: string; aliases?: Any[]; source?: string; tailored?: boolean } = {},
) {
  const jobId = opts.jobId ?? "101";
  const listingId = `greenhouse:acme:${jobId}`;
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  assert.equal(
    (await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile })).code,
    0,
  );
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
  const url = opts.url ?? `https://job-boards.greenhouse.io/acme/jobs/${jobId}`;
  const listing = {
    source: opts.source ?? "greenhouse",
    board: "greenhouse:acme",
    company: "Acme",
    source_job_id: jobId,
    title: "Senior Backend Engineer",
    location: "London",
    url,
    description: "Design and build Application Programming Interfaces. Kafka is a plus.",
    aliases: opts.aliases ?? [{ id: listingId, url, source: "greenhouse" }],
    sightings: [],
    gone: false,
    application_id: APP,
    screen: { outcome: "shortlist", checks: [] },
  };
  const put = (type: string, id: string, input: unknown) =>
    runCli(["record", "put", type, id, "--input", "-"], { dataDir, input });
  assert.equal((await put("listing", listingId, listing)).code, 0);
  assert.equal(
    (
      await put("application", APP, {
        origin: "picked",
        listing: listingId,
        company: "Acme",
        title: "Senior Backend Engineer",
        status: "picked",
        event_log: [
          {
            at: "2026-01-14T10:00:00.000Z",
            stage: "screen",
            from: null,
            to: "picked",
            reason: "Picked from the Shortlist.",
            approval: null,
          },
        ],
        gmail_threads: [],
        answers: [],
        fill_plan: null,
        tailor: null,
        decision_tree: null,
      })
    ).code,
    0,
  );
  if (opts.tailored !== false) {
    const t = await runCli(["tailor", "record", APP, "--input", judgment("tailor-judgment")], {
      dataDir,
    });
    assert.equal(t.code, 0, t.stdout);
  }
}

export const prepare = (dataDir: string, ...ids: string[]) =>
  runCli(["apply", "prepare", ...ids], { dataDir });
export const plan = (dataDir: string, name = "apply-plan") =>
  runCli(["apply", "plan", APP, "--input", judgment(name)], { dataDir });
export const app = async (dataDir: string): Promise<Any> =>
  JSON.parse(
    readFileSync(
      join(dataDir, "pipeline", "application", `${encodeURIComponent(APP)}.json`),
      "utf8",
    ),
  );

test("apply prepare gives the worker the form schema, identity, Answer bank and Tailor files", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await prepare(dataDir);
  assert.equal(r.code, 0, r.stdout);
  const apps = r.json.applications as Any[];
  assert.equal(apps.length, 1);
  const a = apps[0];
  assert.equal(a.application_id, APP);
  const names = a.form.fields.map((f: Any) => f.name);
  assert.deepEqual(names, [
    "first_name",
    "last_name",
    "email",
    "phone",
    "resume",
    "resume_text",
    "question_1001",
    "question_1002",
    "question_1003",
  ]);
  const gender = a.form.fields.find((f: Any) => f.name === "question_1002");
  assert.equal(gender.type, "select");
  assert.deepEqual(
    gender.options.map((o: Any) => o.label),
    ["Yes", "No"],
  );
  assert.equal(a.form.fields.find((f: Any) => f.name === "resume").required, true);
  assert.equal(a.form.fields.find((f: Any) => f.name === "resume_text").required, false);
  assert.equal(a.identity.first_name, "Ada");
  assert.equal(a.identity.last_name, "Example");
  assert.equal(a.answer_bank[0].question, "Are you legally authorised to work in the UK?");
  assert.deepEqual(
    a.tailor_files.map((f: Any) => f.name),
    ["Ada-Example-Resume.docx"],
  );
  assert.deepEqual(r.json.by_hand, []);
  // Nothing is written by preparing a form that exists.
  assert.equal((await app(dataDir)).status, "tailored");
});

test("apply plan stores the Fill plan and moves the Application to Ready to apply", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await plan(dataDir);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.outcome, "planned");
  const a = await app(dataDir);
  assert.equal(a.status, "ready_to_apply");
  assert.equal(a.fill_plan.state, "planned");
  const first = a.fill_plan.fields.find((f: Any) => f.name === "first_name");
  assert.equal(first.value, "Ada");
  assert.equal(first.readback, null);
  const resume = a.fill_plan.fields.find((f: Any) => f.name === "resume");
  assert.equal(resume.value, "Ada-Example-Resume.docx");
  assert.match(resume.path, /tailor\/app-1\/Ada-Example-Resume\.docx$/);
  const last = a.event_log.at(-1);
  assert.equal(last.stage, "apply");
  assert.equal(last.from, "tailored");
  assert.equal(last.to, "ready_to_apply");
});

test("apply plan refuses values the sources can't back, writing nothing", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const good = JSON.parse(readFileSync(judgment("apply-plan"), "utf8"));
  const bad = async (mutate: (p: Any) => void) => {
    const p = structuredClone(good);
    mutate(p);
    const r = await runCli(["apply", "plan", APP, "--input", "-"], { dataDir, input: p });
    assert.equal(r.json.error?.code, "JUDGMENT_INVALID", r.stdout);
    assert.equal((await app(dataDir)).fill_plan, null);
    return r.json.error?.message ?? "";
  };
  assert.match(await bad((p) => (p.fields[0].value = "Grace")), /first_name/);
  assert.match(
    await bad((p) =>
      p.fields.push({ name: "nope", value: "x", source: { kind: "written", basis: "b" } }),
    ),
    /nope/,
  );
  assert.match(
    await bad((p) => (p.fields = p.fields.filter((f: Any) => f.name !== "email"))),
    /email/,
  );
  assert.match(await bad((p) => (p.fields[5].value = "Maybe")), /question_1002/);
  assert.match(await bad((p) => (p.fields[4].value = "Other.docx")), /resume/);
});

test("an unmappable field pauses the Application and keeps the partial plan", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, { jobId: "102" });
  const r = await plan(dataDir, "apply-plan-102");
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.outcome, "paused");
  assert.equal((r.json.unmappable as Any[])[0].name, "question_1004");
  const a = await app(dataDir);
  assert.equal(a.status, "paused");
  assert.equal(a.fill_plan.state, "paused");
  assert.equal(a.fill_plan.fields.length, 7);
  assert.equal(a.fill_plan.unmappable[0].label, "What is your expected salary in GBP?");
  assert.equal(a.event_log.at(-1).to, "paused");
});

test("an answer given during Apply is kept on the Application, never in the Answer bank", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, { jobId: "102" });
  await plan(dataDir, "apply-plan-102");
  const bankBefore = (await runCli(["profile", "get", "--section", "answer_bank"], { dataDir }))
    .stdout;
  const r = await runCli(["apply", "answer", APP, "question_1004", "--input", "-"], {
    dataDir,
    input: { answer: "65000" },
  });
  assert.equal(r.code, 0, r.stdout);
  const a = await app(dataDir);
  assert.equal(a.answers[0].field, "question_1004");
  assert.equal(a.answers[0].answer, "65000");
  assert.equal(a.fill_plan.unmappable.length, 0);
  const field = a.fill_plan.fields.find((f: Any) => f.name === "question_1004");
  assert.equal(field.value, "65000");
  assert.equal(field.source.kind, "application_answer");
  assert.equal(a.status, "ready_to_apply");
  assert.equal(a.fill_plan.state, "planned");
  const bankAfter = (await runCli(["profile", "get", "--section", "answer_bank"], { dataDir }))
    .stdout;
  assert.equal(bankAfter, bankBefore);
});

test("a missing posting pauses the Application with the reason", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, { jobId: "404" });
  const r = await prepare(dataDir);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.applications, []);
  const paused = r.json.paused as Any[];
  assert.equal(paused[0].application_id, APP);
  assert.match(paused[0].reason, /no longer on Greenhouse/);
  const a = await app(dataDir);
  assert.equal(a.status, "paused");
  assert.match(a.event_log.at(-1).reason, /no longer on Greenhouse/);
});

test("a LinkedIn-only Listing gets the link to apply by hand and no form is read", async (t) => {
  const dataDir = tempDir(t);
  const url = "https://www.linkedin.com/jobs/view/3999/";
  await setUp(dataDir, {
    source: "linkedin",
    url,
    aliases: [{ id: "linkedin:3999", url, source: "linkedin" }],
  });
  const r = await prepare(dataDir);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.applications, []);
  const hand = r.json.by_hand as Any[];
  assert.equal(hand[0].application_id, APP);
  assert.equal(hand[0].link, url);
  assert.equal((await app(dataDir)).status, "tailored");
});

// ---------------------------------------------------------------------------------------
// Fill, read-back and Handover, against the fake page driver (scenarios in fixtures/browser/fake)

const CORE = "node /plugins/job-butler/core/src/cli.ts";
const SESSION = "session-1";
const fake = (scenario: string) => ({
  JOB_BUTLER_BROWSER: "fake",
  JOB_BUTLER_FAKE_PAGE: join(FIXTURES, "browser", "fake", `${scenario}.json`),
});
const fill = (dataDir: string, scenario: string) =>
  runCli(["apply", "fill", APP], { dataDir, env: fake(scenario) });

async function ready(dataDir: string, planInput?: Any) {
  await setUp(dataDir);
  const r = planInput
    ? await runCli(["apply", "plan", APP, "--input", "-"], { dataDir, input: planInput })
    : await plan(dataDir);
  assert.equal(r.code, 0, r.stdout);
}

test("a clean fill reads every field back against the plan and leaves the Application ready", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  const r = await fill(dataDir, "clean");
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.outcome, "filled");
  assert.deepEqual(r.json.blockers, []);
  const a = await app(dataDir);
  assert.equal(a.fill_plan.state, "filled");
  assert.equal(a.status, "ready_to_apply");
  for (const f of a.fill_plan.fields) {
    assert.equal(f.readback.match, true, f.name);
    assert.equal(f.readback.value, f.name === "resume" ? "Ada-Example-Resume.docx" : f.value);
  }
});

test("a read-back mismatch blocks the Handover", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  const r = await fill(dataDir, "mismatch");
  assert.equal(r.json.outcome, "blocked");
  const blockers = r.json.blockers as Any[];
  assert.equal(blockers[0].kind, "mismatch");
  assert.equal(blockers[0].field, "phone");
  assert.match(blockers[0].detail, /\+447700900123/);
  const a = await app(dataDir);
  assert.equal(a.fill_plan.state, "blocked");
  assert.equal(a.fill_plan.fields.find((f: Any) => f.name === "phone").readback.match, false);
  const h = await runCli(["apply", "handover", APP], { dataDir });
  assert.equal(h.json.error?.code, "HANDOVER_BLOCKED");
  assert.equal((await app(dataDir)).status, "ready_to_apply");
});

test("an empty required field the plan left out blocks the Handover", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  const r = await fill(dataDir, "empty-required");
  assert.equal(r.json.outcome, "blocked");
  const blockers = r.json.blockers as Any[];
  assert.deepEqual(
    blockers.map((b) => [b.kind, b.field]),
    [["empty_required", "question_9999"]],
  );
});

test("a free-text answer that breaks the voice rules blocks the Handover", async (t) => {
  const dataDir = tempDir(t);
  const bad = JSON.parse(readFileSync(judgment("apply-plan"), "utf8"));
  bad.fields[6].value = "I am passionate about Acme \u2014 I would love to delve into its mission.";
  await ready(dataDir, bad);
  const r = await fill(dataDir, "clean");
  assert.equal(r.json.outcome, "blocked");
  const blockers = r.json.blockers as Any[];
  assert.ok(blockers.every((b) => b.kind === "voice" && b.field === "question_1003"));
  assert.ok(blockers.length >= 3, "passionate, delve and the em dash are each named");
  assert.equal(
    (await runCli(["apply", "handover", APP], { dataDir })).json.error?.code,
    "HANDOVER_BLOCKED",
  );
});

test("a page error mid-fill pauses the Application and keeps the partial plan", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  const r = await fill(dataDir, "error-mid-fill");
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.outcome, "paused");
  assert.equal(r.json.code, "PAGE_ERROR");
  const a = await app(dataDir);
  assert.equal(a.status, "paused");
  assert.equal(a.fill_plan.state, "paused");
  assert.equal(a.fill_plan.fields.length, 7, "the plan is kept whole");
  assert.match(a.event_log.at(-1).reason, /ERR_CONNECTION_RESET/);
});

test("a page that can't be opened pauses the Application", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  const r = await fill(dataDir, "page-down");
  assert.equal(r.json.outcome, "paused");
  assert.equal(r.json.code, "PAGE_ERROR");
  assert.equal((await app(dataDir)).status, "paused");
});

test("a form that no longer has a planned field pauses as a page change", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  const r = await fill(dataDir, "changed");
  assert.equal(r.json.outcome, "paused");
  assert.equal(r.json.code, "PAGE_CHANGED");
  assert.match(String(r.json.reason), /phone/);
  assert.equal((await app(dataDir)).status, "paused");
});

test("the fill refuses a control that would submit the form", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  const r = await fill(dataDir, "submit-control");
  assert.equal(r.json.outcome, "paused");
  assert.equal(r.json.code, "SUBMIT_REFUSED");
  assert.match(String(r.json.reason), /phone/);
  const a = await app(dataDir);
  assert.equal(a.status, "paused");
  assert.equal(a.fill_plan.fields.find((f: Any) => f.name === "phone").readback, null);
  assert.equal(
    a.event_log.every((e: Any) => e.to !== "submitted"),
    true,
  );
});

test("a paused Application resumes with another fill once the page is fine", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  assert.equal((await fill(dataDir, "error-mid-fill")).json.outcome, "paused");
  const r = await fill(dataDir, "clean");
  assert.equal(r.json.outcome, "filled");
  assert.equal((await app(dataDir)).status, "ready_to_apply");
});

test("the Handover shows every field and file, and Submitted needs the job seeker's Approval", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  assert.equal((await fill(dataDir, "clean")).json.outcome, "filled");
  const h = await runCli(["apply", "handover", APP], { dataDir });
  assert.equal(h.code, 0, h.stdout);
  assert.equal(h.json.status, "handover");
  const shown = h.json.fields as Any[];
  assert.equal(shown.length, 7);
  assert.deepEqual(
    shown.find((f) => f.name === "phone"),
    {
      name: "phone",
      label: "Phone",
      value: "+44 7700 900123",
      readback: "+44 7700 900123",
      match: true,
    },
  );
  const files = h.json.files as Any[];
  assert.equal(files[0].name, "Ada-Example-Resume.docx");
  assert.ok(files[0].bytes > 1000);
  assert.match(String(h.json.text), /Ada-Example-Resume\.docx/);
  assert.equal((await app(dataDir)).status, "handover");

  // Apply never records Submitted by itself.
  const denied = await runCli(["application", "submitted", APP], { dataDir });
  assert.equal(denied.json.error?.code, "APPROVAL_MISSING");
  assert.equal((await app(dataDir)).status, "handover");

  const action = `application submitted ${APP}`;
  const rec = await runCli(
    ["approval", "record", "handover", "--session", SESSION, "--input", "-"],
    {
      dataDir,
      input: { actions: [action] },
    },
  );
  assert.equal(rec.code, 0, rec.stdout);
  const hook = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: SESSION, tool_name: "Bash", tool_input: { command: `${CORE} ${action}` } },
  });
  assert.equal(JSON.stringify(hook.json), "{}");
  const done = await runCli(action.split(" "), { dataDir });
  assert.equal(done.code, 0, done.stdout);
  const a = await app(dataDir);
  assert.equal(a.status, "submitted");
  const last = a.event_log.at(-1);
  assert.equal(last.from, "handover");
  assert.equal(last.to, "submitted");
  assert.equal(last.approval.checkpoint, "handover");
  assert.equal(last.approval.action, action);
});

/** An Application the job seeker made elsewhere, dated inside the default cooldown window. */
async function appliedElsewhere(dataDir: string) {
  const r = await runCli(["record", "put", "application", "app-elsewhere", "--input", "-"], {
    dataDir,
    input: {
      origin: "external",
      listing: "greenhouse:acme:999",
      company: "Acme",
      title: "Senior Backend Engineer",
      status: "submitted",
      applied_at: "2026-01-10T09:00:00.000Z",
      event_log: [],
    },
  });
  assert.equal(r.code, 0, r.stdout);
}

test("the Handover re-checks the Application limit and shows no warning while counts are unchanged", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  assert.equal((await fill(dataDir, "clean")).json.outcome, "filled");
  const h = await runCli(["apply", "handover", APP], { dataDir });
  assert.equal(h.code, 0, h.stdout);
  assert.equal(h.json.limit_warning, null);
  assert.doesNotMatch(String(h.json.text), /Application limit/);
});

test("the Handover warns, without blocking, when counts changed so the Listing is now over its limit", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  assert.equal((await fill(dataDir, "clean")).json.outcome, "filled");
  await appliedElsewhere(dataDir);
  const h = await runCli(["apply", "handover", APP], { dataDir });
  assert.equal(h.code, 0, h.stdout);
  assert.equal(h.json.status, "handover");
  const w = h.json.limit_warning as Any;
  assert.equal(w.limit, 1);
  assert.equal(w.source, "default cooldown");
  assert.equal(w.existing, 1);
  assert.match(String(h.json.text), /Application limit: would be your 2nd of 1 at Acme/);
});

test("Submitted can't be recorded before the Handover", async (t) => {
  const dataDir = tempDir(t);
  await ready(dataDir);
  const action = `application submitted ${APP}`;
  await runCli(["approval", "record", "handover", "--session", SESSION, "--input", "-"], {
    dataDir,
    input: { actions: [action] },
  });
  await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: SESSION, tool_name: "Bash", tool_input: { command: `${CORE} ${action}` } },
  });
  const r = await runCli(action.split(" "), { dataDir });
  assert.equal(r.json.error?.code, "NOT_AT_HANDOVER");
  assert.equal((await app(dataDir)).status, "ready_to_apply");
});

test("Apply refuses to fill a plan that still has an unmappable field", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, { jobId: "102" });
  await plan(dataDir, "apply-plan-102");
  const r = await fill(dataDir, "clean");
  assert.equal(r.json.error?.code, "PLAN_INCOMPLETE");
});

// ---------------------------------------------------------------------------------------
// The hook gates the browser while Apply runs

const PW = "mcp__plugin_playwright_playwright__";
async function toolDecision(dataDir: string, tool: string) {
  const r = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: SESSION, tool_name: tool, tool_input: {} },
  });
  const out = r.json.hookSpecificOutput as Any;
  return {
    deny: out?.permissionDecision === "deny",
    reason: String(out?.permissionDecisionReason ?? ""),
  };
}

test("while Apply runs, the hook blocks Playwright tools that could click Submit", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  assert.equal(
    (await toolDecision(dataDir, `${PW}browser_click`)).deny,
    false,
    "no run, no opinion",
  );
  assert.equal((await runCli(["run", "start", "apply"], { dataDir })).code, 0);
  for (const tool of [
    "browser_click",
    "browser_press_key",
    "browser_run_code_unsafe",
    "browser_fill_form",
  ]) {
    const d = await toolDecision(dataDir, `${PW}${tool}`);
    assert.equal(d.deny, true, tool);
    assert.match(d.reason, /apply fill/);
  }
  assert.equal((await toolDecision(dataDir, `${PW}browser_snapshot`)).deny, false);
  assert.equal((await toolDecision(dataDir, `${PW}browser_take_screenshot`)).deny, false);
});

// ---------------------------------------------------------------------------------------
// A real browser, when playwright-core and its Chromium are installed

function playwrightPath(): string | undefined {
  const override = hostVar("JOB_BUTLER_PLAYWRIGHT");
  if (override) return override;
  try {
    return fileURLToPath(import.meta.resolve("playwright-core"));
  } catch {
    return undefined;
  }
}
const REAL = playwrightPath();
const real = { skip: REAL === undefined ? "playwright-core isn't installed" : false };

/** Serve the browser fixtures and record every request, so a test can see nothing was posted. */
async function recordingServer(t: import("node:test").TestContext) {
  const requests: string[] = [];
  const dir = join(FIXTURES, "browser");
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    try {
      const body = readFileSync(join(dir, (req.url ?? "/").split("?")[0] as string));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, requests };
}

const browserEnv = () => ({
  JOB_BUTLER_BROWSER_HEADLESS: "1",
  ...(REAL === undefined ? {} : { JOB_BUTLER_PLAYWRIGHT: REAL }),
});

async function realRun(t: import("node:test").TestContext, page: string) {
  const dataDir = tempDir(t);
  const { base, requests } = await recordingServer(t);
  await setUp(dataDir, { url: `${base}/${page}` });
  assert.equal((await plan(dataDir)).code, 0);
  const r = await runCli(["apply", "fill", APP], { dataDir, env: browserEnv() });
  t.after(() => runCli(["apply", "close", APP], { dataDir, env: browserEnv() }));
  return { dataDir, r, requests };
}

test(
  "real browser: a clean fill reads back, leaves the browser open, and closing deletes its profile",
  real,
  async (t) => {
    const { dataDir, r, requests } = await realRun(t, "greenhouse-101.html");
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.outcome, "filled", r.stdout);
    assert.equal(r.json.browser_open, true);
    const a = await app(dataDir);
    const phone = a.fill_plan.fields.find((f: Any) => f.name === "phone");
    assert.equal(phone.readback.value, "+44 7700 900123");
    assert.equal(
      a.fill_plan.fields.find((f: Any) => f.name === "resume").readback.value,
      "Ada-Example-Resume.docx",
    );
    assert.ok(
      requests.every((q) => q.startsWith("GET ")),
      `Apply only reads: ${requests.join(", ")}`,
    );

    const { pid, profile_dir: profile } = a.fill_plan.browser;
    assert.doesNotThrow(() => process.kill(pid, 0), "the browser outlives the CLI call");
    assert.ok(existsSync(profile));
    assert.ok(
      !profile.startsWith(dataDir) && profile.includes("job-butler-browser-"),
      "the profile is ephemeral, outside the data dir",
    );
    assert.deepEqual(
      readdirSync(dataDir).filter((n) => /cookie|login|session-storage/i.test(n)),
      [],
    );

    const closed = await runCli(["apply", "close", APP], { dataDir, env: browserEnv() });
    assert.equal(closed.json.closed, true);
    assert.ok(!existsSync(profile), "the profile is deleted");
    assert.throws(() => process.kill(pid, 0), "the browser is gone");
    assert.equal((await app(dataDir)).fill_plan.browser, null);
  },
);

test("real browser: a page that rewrites a value is a read-back mismatch", real, async (t) => {
  const { r } = await realRun(t, "greenhouse-101-mangle.html");
  assert.equal(r.json.outcome, "blocked", r.stdout);
  assert.equal((r.json.blockers as Any[])[0].field, "phone");
});

test("real browser: a control that submits is refused and nothing is posted", real, async (t) => {
  const { r, requests } = await realRun(t, "greenhouse-101-submit.html");
  assert.equal(r.json.outcome, "paused", r.stdout);
  assert.equal(r.json.code, "SUBMIT_REFUSED");
  assert.ok(requests.every((q) => q.startsWith("GET ")));
});

test("real browser: a form missing a planned field pauses as a page change", real, async (t) => {
  const { r } = await realRun(t, "greenhouse-101-changed.html");
  assert.equal(r.json.outcome, "paused", r.stdout);
  assert.equal(r.json.code, "PAGE_CHANGED");
});

test("without Playwright the fill says how to install it and changes nothing", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await plan(dataDir);
  const r = await runCli(["apply", "fill", APP], {
    dataDir,
    env: { JOB_BUTLER_PLAYWRIGHT: "/nonexistent/playwright-core/index.js" },
  });
  assert.equal(r.json.error?.code, "BROWSER_UNAVAILABLE");
  assert.match(r.json.error?.message ?? "", /npm install/);
  assert.equal((await app(dataDir)).status, "ready_to_apply");
});
