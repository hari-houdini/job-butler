// Apply over Lever and Ashby forms (#46). Lever's questions are read from the hosted apply
// page (recorded network fixture); Ashby's are mapped by label from a page snapshot (the fake
// page driver's controls). The fill, read-back, pause and Handover rules are Greenhouse's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES, judgment, runCli, tempDir } from "./harness.ts";

// biome-ignore lint/suspicious/noExplicitAny: parsed test JSON
type Any = any;

const APP = "app-1";
const SESSION = "session-1";
const CORE = "node /plugins/job-butler/core/src/cli.ts";
const CARD = "cards[11111111-2222-4333-8444-555555555555]";

interface Board {
  ats: "lever" | "ashby";
  jobId: string;
  gone: string;
  url: (id: string) => string;
  plan: string;
  clean: string;
  salary: string;
  email: string;
  phone: string;
  why: string;
  resume: string;
  scenario: (name: string) => string;
}
const BOARDS: Board[] = [
  {
    ats: "lever",
    jobId: "5f0a1c2e-aaaa-4bbb-8ccc-000000000001",
    gone: "00000000-aaaa-4bbb-8ccc-000000000404",
    url: (id) => `https://jobs.lever.co/acme/${id}`,
    plan: "apply-plan-lever",
    clean: "lever-clean",
    salary: `${CARD}[field2]`,
    email: "email",
    phone: "phone",
    why: `${CARD}[field1]`,
    resume: "resume",
    scenario: (n) => `lever-${n}`,
  },
  {
    ats: "ashby",
    jobId: "7d1b2c3e-aaaa-4bbb-8ccc-000000000002",
    gone: "ashby-gone",
    url: (id) => `https://jobs.ashbyhq.com/acme/${id}`,
    plan: "apply-plan-ashby",
    clean: "ashby-clean",
    salary: "a1b2c3d4-0004-4000-8000-000000000004",
    email: "_systemfield_email",
    phone: "a1b2c3d4-0001-4000-8000-000000000001",
    why: "a1b2c3d4-0003-4000-8000-000000000003",
    resume: "_systemfield_resume",
    scenario: (n) => `ashby-${n}`,
  },
];

const fake = (scenario: string) => ({
  JOB_BUTLER_BROWSER: "fake",
  JOB_BUTLER_FAKE_PAGE: join(FIXTURES, "browser", "fake", `${scenario}.json`),
});

async function setUp(dataDir: string, b: Board, jobId = b.jobId) {
  const put = (type: string, id: string, input: unknown) =>
    runCli(["record", "put", type, id, "--input", "-"], { dataDir, input });
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  assert.equal(
    (await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile })).code,
    0,
  );
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
  const url = b.url(jobId);
  const listingId = `${b.ats}:acme:${jobId}`;
  assert.equal(
    (
      await put("listing", listingId, {
        source: b.ats,
        board: `${b.ats}:acme`,
        company: "Acme",
        source_job_id: jobId,
        title: "Senior Backend Engineer",
        location: "London",
        url,
        description: "Design and build Application Programming Interfaces.",
        aliases: [{ id: listingId, url, source: b.ats }],
        sightings: [],
        gone: false,
        application_id: APP,
        screen: { outcome: "shortlist", checks: [] },
      })
    ).code,
    0,
  );
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
  const t = await runCli(["tailor", "record", APP, "--input", judgment("tailor-judgment")], {
    dataDir,
  });
  assert.equal(t.code, 0, t.stdout);
}

const prepare = (dataDir: string, b: Board) =>
  runCli(["apply", "prepare"], { dataDir, env: fake(b.clean) });
const plan = (dataDir: string, b: Board, input?: Any) =>
  runCli(["apply", "plan", APP, "--input", input === undefined ? judgment(b.plan) : "-"], {
    dataDir,
    env: fake(b.clean),
    ...(input === undefined ? {} : { input }),
  });
const app = async (dataDir: string): Promise<Any> =>
  JSON.parse(
    readFileSync(
      join(dataDir, "pipeline", "application", `${encodeURIComponent(APP)}.json`),
      "utf8",
    ),
  );
const fill = (dataDir: string, scenario: string) =>
  runCli(["apply", "fill", APP], { dataDir, env: fake(scenario) });

/** Set up, store the plan, answer the one unmappable field: Ready to apply. */
async function ready(dataDir: string, b: Board, mutate?: (p: Any) => void) {
  await setUp(dataDir, b);
  const input = JSON.parse(readFileSync(judgment(b.plan), "utf8"));
  mutate?.(input);
  const r = await plan(dataDir, b, input);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.outcome, "paused");
  const a = await runCli(["apply", "answer", APP, b.salary, "--input", "-"], {
    dataDir,
    input: { answer: "65000" },
  });
  assert.equal(a.code, 0, a.stdout);
  assert.equal((await app(dataDir)).status, "ready_to_apply");
}

// ---------------------------------------------------------------------------------------
// Reading the form

test("Lever: the questions come from the hosted apply page, stable names and cards fields alike", async (t) => {
  const dataDir = tempDir(t);
  const b = BOARDS[0] as Board;
  await setUp(dataDir, b);
  const r = await prepare(dataDir, b);
  assert.equal(r.code, 0, r.stdout);
  const form = (r.json.applications as Any[])[0].form;
  assert.equal(form.ats, "lever");
  assert.equal(form.url, `${b.url(b.jobId)}/apply`);
  const by = (n: string) => form.fields.find((f: Any) => f.name === n);
  assert.deepEqual(
    form.fields.map((f: Any) => f.name),
    [
      "resume",
      "name",
      "email",
      "phone",
      "org",
      "urls[LinkedIn]",
      `${CARD}[field0]`,
      `${CARD}[field1]`,
      `${CARD}[field2]`,
      `${CARD}[field3]`,
    ],
    "hidden inputs, the captcha and the submit button are not fields",
  );
  assert.equal(by("resume").type, "file");
  assert.equal(by("resume").required, true);
  assert.equal(by("name").label, "Full name");
  assert.equal(by("phone").required, false);
  assert.equal(by(`${CARD}[field0]`).type, "select");
  assert.deepEqual(
    by(`${CARD}[field0]`).options.map((o: Any) => o.label),
    ["Yes", "No"],
  );
  assert.equal(by(`${CARD}[field0]`).required, true);
  assert.equal(by(`${CARD}[field1]`).type, "textarea");
  assert.equal(by(`${CARD}[field1]`).label, "Why Acme?");
  assert.deepEqual(
    by(`${CARD}[field3]`).options.map((o: Any) => o.label),
    ["Immediately", "1 month", "3 months"],
    "the Select... placeholder is not a choice",
  );
  assert.equal((await app(dataDir)).status, "tailored");
});

test("Ashby: the fields are mapped by label from a page snapshot", async (t) => {
  const dataDir = tempDir(t);
  const b = BOARDS[1] as Board;
  await setUp(dataDir, b);
  const r = await prepare(dataDir, b);
  assert.equal(r.code, 0, r.stdout);
  const form = (r.json.applications as Any[])[0].form;
  assert.equal(form.ats, "ashby");
  assert.equal(form.url, `${b.url(b.jobId)}/application`);
  assert.deepEqual(
    form.fields.map((f: Any) => [f.label, f.type, f.required]),
    [
      ["Name", "text", true],
      ["Email", "text", true],
      ["Resume", "file", true],
      ["Phone number", "text", false],
      ["Are you legally authorised to work in the UK?", "select", true],
      ["Why do you want to work at Acme?", "textarea", true],
      ["What is your expected salary in GBP?", "text", true],
    ],
    "required markers leave the labels; the submit button is not a field",
  );
  assert.equal(form.fields[4].options.map((o: Any) => o.label).join("/"), "Yes/No");
  assert.equal((await app(dataDir)).status, "tailored");
});

for (const b of BOARDS) {
  test(`${b.ats}: a missing posting pauses the Application with the reason`, async (t) => {
    const dataDir = tempDir(t);
    await setUp(dataDir, b, b.gone === "ashby-gone" ? b.jobId : b.gone);
    const r = await runCli(["apply", "prepare"], {
      dataDir,
      env: fake(b.ats === "ashby" ? "ashby-gone" : b.clean),
    });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.json.applications, []);
    const paused = r.json.paused as Any[];
    assert.equal(paused[0].code, "POSTING_GONE");
    assert.match(paused[0].reason, b.ats === "lever" ? /no longer on Lever/ : /no longer on Ashby/);
    const a = await app(dataDir);
    assert.equal(a.status, "paused");
    assert.equal(a.event_log.at(-1).stage, "apply");
  });

  // -------------------------------------------------------------------------------------
  // The Fill plan, pause and read-back rules match Greenhouse

  test(`${b.ats}: an unmappable field pauses with the partial plan, and an answer resumes it`, async (t) => {
    const dataDir = tempDir(t);
    await setUp(dataDir, b);
    const r = await plan(dataDir, b);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.outcome, "paused");
    assert.equal((r.json.unmappable as Any[])[0].name, b.salary);
    let a = await app(dataDir);
    assert.equal(a.status, "paused");
    assert.equal(a.fill_plan.fields.length, 6, "the partial plan is kept");
    assert.equal(a.fill_plan.form.ats, b.ats);
    assert.equal(a.fill_plan.unmappable[0].label, "What is your expected salary in GBP?");
    const refused = await fill(dataDir, b.clean);
    assert.equal(refused.json.error?.code, "PLAN_INCOMPLETE");
    await runCli(["apply", "answer", APP, b.salary, "--input", "-"], {
      dataDir,
      input: { answer: "65000" },
    });
    a = await app(dataDir);
    assert.equal(a.status, "ready_to_apply");
    assert.equal(a.fill_plan.fields.find((f: Any) => f.name === b.salary).value, "65000");
  });

  test(`${b.ats}: a plan value its source can't back is refused and nothing is stored`, async (t) => {
    const dataDir = tempDir(t);
    await setUp(dataDir, b);
    const input = JSON.parse(readFileSync(judgment(b.plan), "utf8"));
    input.fields.find((f: Any) => f.name === b.email).value = "someone@else.example";
    const r = await plan(dataDir, b, input);
    assert.equal(r.json.error?.code, "JUDGMENT_INVALID");
    assert.equal((await app(dataDir)).fill_plan, null);
  });

  test(`${b.ats}: a clean fill reads back, hands over, and Submitted needs the Approval`, async (t) => {
    const dataDir = tempDir(t);
    await ready(dataDir, b);
    const r = await fill(dataDir, b.clean);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.outcome, "filled");
    const a = await app(dataDir);
    assert.equal(a.fill_plan.state, "filled");
    for (const f of a.fill_plan.fields) assert.equal(f.readback.match, true, f.name);
    const h = await runCli(["apply", "handover", APP], { dataDir });
    assert.equal(h.code, 0, h.stdout);
    assert.equal(h.json.status, "handover");
    assert.equal(
      h.json.form_url,
      `${b.url(b.jobId)}/${b.ats === "lever" ? "apply" : "application"}`,
    );
    assert.equal((h.json.files as Any[])[0].name, "Ada-Example-Resume.docx");
    assert.match(String(h.json.text), /65000/);

    const action = `application submitted ${APP}`;
    const denied = await runCli(action.split(" "), { dataDir });
    assert.equal(denied.json.error?.code, "APPROVAL_MISSING");
    assert.equal((await app(dataDir)).status, "handover");
    await runCli(["approval", "record", "handover", "--session", SESSION, "--input", "-"], {
      dataDir,
      input: { actions: [action] },
    });
    await runCli(["hook", "pre-tool-use"], {
      dataDir,
      input: {
        session_id: SESSION,
        tool_name: "Bash",
        tool_input: { command: `${CORE} ${action}` },
      },
    });
    const done = await runCli(action.split(" "), { dataDir });
    assert.equal(done.code, 0, done.stdout);
    const last = (await app(dataDir)).event_log.at(-1);
    assert.equal(last.to, "submitted");
    assert.equal(last.approval.checkpoint, "handover");
  });

  test(`${b.ats}: a read-back mismatch blocks the Handover`, async (t) => {
    const dataDir = tempDir(t);
    await ready(dataDir, b);
    const r = await fill(dataDir, b.scenario("mismatch"));
    assert.equal(r.json.outcome, "blocked");
    const blockers = r.json.blockers as Any[];
    assert.deepEqual(
      blockers.map((x) => [x.kind, x.field]),
      [["mismatch", b.email]],
    );
    assert.equal(
      (await runCli(["apply", "handover", APP], { dataDir })).json.error?.code,
      "HANDOVER_BLOCKED",
    );
    assert.equal((await app(dataDir)).status, "ready_to_apply");
  });

  test(`${b.ats}: an empty required field blocks the Handover`, async (t) => {
    const dataDir = tempDir(t);
    await ready(dataDir, b);
    const r = await fill(dataDir, b.scenario("empty-required"));
    assert.equal(r.json.outcome, "blocked");
    assert.equal((r.json.blockers as Any[])[0].kind, "empty_required");
    assert.equal(
      (await runCli(["apply", "handover", APP], { dataDir })).json.error?.code,
      "HANDOVER_BLOCKED",
    );
  });

  test(`${b.ats}: a written answer that breaks the voice rules blocks the Handover`, async (t) => {
    const dataDir = tempDir(t);
    await ready(dataDir, b, (p) => {
      p.fields.find((f: Any) => f.name === b.why).value =
        "I am passionate about Acme — I would love to delve into its mission.";
    });
    const r = await fill(dataDir, b.clean);
    assert.equal(r.json.outcome, "blocked");
    const blockers = r.json.blockers as Any[];
    assert.ok(
      blockers.length >= 3 && blockers.every((x) => x.kind === "voice" && x.field === b.why),
    );
  });

  test(`${b.ats}: a changed page pauses the Application and keeps the plan`, async (t) => {
    const dataDir = tempDir(t);
    await ready(dataDir, b);
    const r = await fill(dataDir, b.scenario("changed"));
    assert.equal(r.json.outcome, "paused");
    assert.equal(r.json.code, "PAGE_CHANGED");
    const a = await app(dataDir);
    assert.equal(a.status, "paused");
    assert.equal(a.fill_plan.fields.length, 7);
    assert.equal((await fill(dataDir, b.clean)).json.outcome, "filled", "a later fill resumes");
  });

  test(`${b.ats}: the fill refuses a control that submits the form`, async (t) => {
    const dataDir = tempDir(t);
    await ready(dataDir, b);
    const r = await fill(dataDir, b.scenario("submit"));
    assert.equal(r.json.outcome, "paused");
    assert.equal(r.json.code, "SUBMIT_REFUSED");
    const a = await app(dataDir);
    assert.equal(a.status, "paused");
    assert.ok(a.event_log.every((e: Any) => e.to !== "submitted"));
  });
}
