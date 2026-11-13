import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

// The clock is 2026-01-15 (harness). Windows roll back from there.

function listing(id: string, title: string, extra: Record<string, unknown> = {}) {
  const jobId = id.split(":").at(-1);
  return {
    source: "greenhouse",
    board: "greenhouse:acme",
    company: "Acme",
    source_job_id: jobId,
    title,
    location: "London",
    url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}`,
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

const BACKEND = "greenhouse:acme:101";
const PLATFORM = "greenhouse:acme:102";
const BACKEND_BERLIN = "greenhouse:acme:103";

const LISTINGS = (extra: Record<string, unknown> = {}) => [
  listing(BACKEND, "Senior Backend Engineer", extra),
  listing(PLATFORM, "Platform Engineer", extra),
  listing(BACKEND_BERLIN, "Senior Backend Engineer", { ...extra, location: "Berlin" }),
];

async function put(dataDir: string, type: string, id: string, record: unknown) {
  const r = await runCli(["record", "put", type, id, "--input", "-"], { dataDir, input: record });
  assert.equal(r.code, 0, r.stdout);
}

async function setUp(dataDir: string, listings = LISTINGS(), prefs?: [string, string][]) {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  profile.sponsorship = { needed: false }; // these tests are about limits, not Sponsorship
  assert.equal(
    (await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile })).code,
    0,
  );
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
  for (const [k, v] of prefs ?? []) {
    const r = await runCli(["preferences", "set", k, v], { dataDir });
    assert.equal(r.code, 0, r.stdout);
  }
  for (const l of listings) await put(dataDir, "listing", l.aliases[0]?.id as string, l);
}

/** The skills ratings for the listings, each with an optional advert limit judgment. */
function judgments(advert: Record<string, unknown> = {}) {
  const all = JSON.parse(readFileSync(judgment("screen-skills-rating"), "utf8"));
  return {
    judgments: all.judgments
      .filter((j: { listing_id: string }) =>
        [BACKEND, PLATFORM, BACKEND_BERLIN].includes(j.listing_id),
      )
      .map((j: { listing_id: string }) =>
        advert[j.listing_id] !== undefined ? { ...j, application_limit: advert[j.listing_id] } : j,
      ),
  };
}

async function screen(dataDir: string, input: unknown = judgments()) {
  const r = await runCli(["screen", "record", "--input", "-"], { dataDir, input });
  assert.equal(r.code, 0, r.stdout);
  return r.json;
}

interface Item {
  id: string;
  fit: number;
  flags: string[];
  badges: string[];
  suggested?: boolean;
  group?: { company: string; slots: number; members: number } | null;
}
async function shortlist(dataDir: string): Promise<Item[]> {
  const r = await runCli(["screen", "digest"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  return r.json.shortlist as Item[];
}

async function getListing(dataDir: string, id: string) {
  const r = await runCli(["record", "get", "listing", id], { dataDir });
  return r.json.record as Record<string, any>;
}

function entry(to: string, at: string, from: string | null = null) {
  return { at, stage: "screen", from, to, reason: "test", approval: null };
}

let n = 0;
async function application(
  dataDir: string,
  a: Record<string, unknown>,
  log: ReturnType<typeof entry>[],
) {
  n += 1;
  await put(dataDir, "application", `app-${n}`, {
    origin: "picked",
    listing: null,
    company: "Acme",
    title: "Senior Backend Engineer",
    event_log: log,
    gmail_threads: [],
    answers: [],
    fill_plan: null,
    tailor: null,
    ...a,
  });
}

const noteOn = (
  dataDir: string,
  note: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  put(dataDir, "employer", "emp-acme", {
    name: "Acme Ltd",
    application_limit_note: note,
    ...extra,
  });

// ---------------------------------------------------------------------------------------
// Sources

test("the default cooldown applies when there is no note and no advert limit", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await application(dataDir, { status: "submitted" }, [
    entry("picked", "2025-11-01T10:00:00.000Z"),
    entry("submitted", "2025-11-03T10:00:00.000Z", "picked"),
  ]);
  await screen(dataDir);

  const items = await shortlist(dataDir);
  const backend = items.find((i) => i.id === BACKEND);
  assert.match(backend?.flags[0] ?? "", /would be your 2nd of 1 at Acme/);
  assert.match(backend?.flags[0] ?? "", /6 months/);
  assert.match(backend?.flags[0] ?? "", /default/);
  // A different role at Acme is not the same role: nothing to flag.
  const platform = items.find((i) => i.id === PLATFORM);
  assert.deepEqual(platform?.flags, []);
  assert.deepEqual(platform?.badges, []);
});

test("a Listing that would use the last slot of a multi-slot limit gets a badge only", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, LISTINGS({ employer: "emp-acme" }));
  await noteOn(dataDir, { count: 2, window_days: 30, scope: "company" });
  await application(dataDir, { status: "submitted", employer: "emp-acme", title: "Other" }, [
    entry("picked", "2026-01-05T09:00:00.000Z"),
  ]);
  await screen(dataDir);
  const items = await shortlist(dataDir);
  for (const i of items) {
    assert.deepEqual(i.flags, []);
    assert.match(i.badges[0] ?? "", /uses your last slot at Acme in 30 days \(your note\)/);
  }
});

test("the advert's limit, with its quote, beats the default", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await application(dataDir, { status: "submitted" }, [
    entry("picked", "2026-01-01T10:00:00.000Z"),
    entry("submitted", "2026-01-02T10:00:00.000Z", "picked"),
  ]);
  const advert = {
    count: 1,
    window_days: 30,
    scope: "company",
    quote: "Please apply to one role at a time",
  };
  await screen(dataDir, judgments({ [PLATFORM]: advert }));

  const items = await shortlist(dataDir);
  const platform = items.find((i) => i.id === PLATFORM);
  assert.match(platform?.flags[0] ?? "", /would be your 2nd of 1 at Acme in 30 days/);
  assert.match(platform?.flags[0] ?? "", /advert/);
  const stored = await getListing(dataDir, PLATFORM);
  const check = stored.screen.checks.find((c: any) => c.check === "application_limit.limit");
  assert.ok(check.evidence.some((e: string) => e.includes("Please apply to one role at a time")));
  // The other two Listings have no advert limit and fall back to the same-role default.
  const backend = items.find((i) => i.id === BACKEND);
  assert.match(backend?.flags[0] ?? "", /default/);
});

test("an advert limit without a quote is refused", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await runCli(["screen", "record", "--input", "-"], {
    dataDir,
    input: judgments({ [BACKEND]: { count: 1, window_days: 30, scope: "company" } }),
  });
  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "JUDGMENT_INVALID");
});

test("the job seeker's note on the company wins over the advert and the default", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, LISTINGS({ employer: "emp-acme" }));
  await noteOn(dataDir, { count: 3, window_days: 30, scope: "company" });
  for (const [i, day] of ["2026-01-02", "2026-01-05", "2026-01-08"].entries()) {
    await application(dataDir, { status: "submitted", title: `Role ${i}`, employer: "emp-acme" }, [
      entry("picked", `${day}T09:00:00.000Z`),
      entry("submitted", `${day}T10:00:00.000Z`, "picked"),
    ]);
  }
  const advert = {
    count: 10,
    window_days: 30,
    scope: "company",
    quote: "Apply to as many as you like",
  };
  await screen(dataDir, judgments({ [BACKEND]: advert }));

  const backend = (await shortlist(dataDir)).find((i) => i.id === BACKEND);
  assert.match(backend?.flags[0] ?? "", /would be your 4th of 3 at Acme in 30 days/);
  assert.match(backend?.flags[0] ?? "", /your note/);
});

// ---------------------------------------------------------------------------------------
// Counting

test("Submitted, Picked and External applications count; withdrawn picks and old ones do not", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, LISTINGS({ employer: "emp-acme" }));
  await noteOn(dataDir, { count: 5, window_days: 30, scope: "company" });
  const emp = { employer: "emp-acme" };
  // counted: submitted, picked (not submitted), external (dated by earliest confirmation)
  await application(dataDir, { status: "submitted", ...emp }, [
    entry("picked", "2026-01-03T10:00:00.000Z"),
    entry("submitted", "2026-01-04T10:00:00.000Z", "picked"),
  ]);
  await application(dataDir, { status: "tailored", ...emp }, [
    entry("picked", "2026-01-05T10:00:00.000Z"),
  ]);
  await application(
    dataDir,
    { origin: "external", status: "submitted", applied_at: "2026-01-06T10:00:00.000Z", ...emp },
    [],
  );
  // not counted: a pick withdrawn before Submit, and an application older than the window
  await application(dataDir, { status: "withdrawn", ...emp }, [
    entry("picked", "2026-01-07T10:00:00.000Z"),
    entry("withdrawn", "2026-01-08T10:00:00.000Z", "picked"),
  ]);
  await application(dataDir, { status: "submitted", ...emp }, [
    entry("picked", "2025-11-01T10:00:00.000Z"),
    entry("submitted", "2025-11-02T10:00:00.000Z", "picked"),
  ]);
  await screen(dataDir);

  const backend = (await shortlist(dataDir)).find((i) => i.id === BACKEND);
  // 3 counted, so the next would be the 4th of 5: under the limit, not the last slot.
  assert.deepEqual(backend?.flags, []);
  assert.deepEqual(backend?.badges, []);
  const stored = await getListing(dataDir, BACKEND);
  const check = stored.screen.checks.find((c: any) => c.check === "application_limit.limit");
  assert.equal(check.status, "pass");
  assert.match(check.result, /3 of 5/);
});

test("a withdrawn Application that was submitted still counts, dated by its submit date", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, LISTINGS({ employer: "emp-acme" }));
  await noteOn(dataDir, { count: 1, window_days: 30, scope: "company" });
  // Picked 100 days ago but submitted 10 days ago: the submit date puts it in the window.
  await application(dataDir, { status: "withdrawn", employer: "emp-acme" }, [
    entry("picked", "2025-10-07T10:00:00.000Z"),
    entry("submitted", "2026-01-05T10:00:00.000Z", "picked"),
    entry("withdrawn", "2026-01-06T10:00:00.000Z", "submitted"),
  ]);
  await screen(dataDir);

  const backend = (await shortlist(dataDir)).find((i) => i.id === BACKEND);
  assert.match(backend?.flags[0] ?? "", /2nd of 1/);
});

test("the window rolls from today: 30 days is in, 31 days is out", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, LISTINGS({ employer: "emp-acme" }));
  await noteOn(dataDir, { count: 1, window_days: 30, scope: "company" });
  await application(dataDir, { status: "submitted", employer: "emp-acme" }, [
    entry("picked", "2025-12-16T09:00:00.000Z"),
  ]);
  await screen(dataDir);
  assert.match((await shortlist(dataDir))[0]?.flags[0] ?? "", /2nd of 1/);

  const other = tempDir(t);
  await setUp(other, LISTINGS({ employer: "emp-acme" }));
  await noteOn(other, { count: 1, window_days: 30, scope: "company" });
  await application(other, { status: "submitted", employer: "emp-acme" }, [
    entry("picked", "2025-12-15T08:00:00.000Z"),
  ]);
  await screen(other);
  assert.deepEqual(
    (await shortlist(other)).flatMap((i) => i.flags),
    [],
  );
});

test("a same_role limit counts the same normalised title only; a company limit counts every role", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, LISTINGS({ employer: "emp-acme" }));
  await noteOn(dataDir, { count: 1, window_months: 3, scope: "same_role" });
  await application(
    dataDir,
    { status: "submitted", employer: "emp-acme", title: "senior backend  engineer" },
    [entry("picked", "2026-01-05T09:00:00.000Z")],
  );
  await screen(dataDir);
  const items = await shortlist(dataDir);
  assert.match(items.find((i) => i.id === BACKEND)?.flags[0] ?? "", /same role/);
  assert.match(items.find((i) => i.id === BACKEND_BERLIN)?.flags[0] ?? "", /same role/);
  assert.deepEqual(items.find((i) => i.id === PLATFORM)?.flags, []);

  await noteOn(dataDir, { count: 1, window_months: 3, scope: "company" });
  await runCli(["screen", "rescore", "all"], { dataDir });
  await screen(dataDir);
  assert.match(
    (await shortlist(dataDir)).find((i) => i.id === PLATFORM)?.flags[0] ?? "",
    /2nd of 1/,
  );
});

test("counts are against the Employer, or the normalised company name when there is none", async (t) => {
  const dataDir = tempDir(t);
  // Listings with an Employer: an application at the same-named company but another Employer doesn't count.
  await setUp(dataDir, LISTINGS({ employer: "emp-acme" }));
  await noteOn(dataDir, { count: 1, window_days: 30, scope: "company" });
  await application(dataDir, { status: "submitted", employer: "emp-other", company: "Acme" }, [
    entry("picked", "2026-01-05T09:00:00.000Z"),
  ]);
  await screen(dataDir);
  assert.deepEqual(
    (await shortlist(dataDir)).flatMap((i) => i.flags),
    [],
  );

  // No Employer: "Acme Ltd." counts against "Acme".
  const bare = tempDir(t);
  await setUp(bare);
  await put(bare, "employer", "emp-x", {
    name: "ACME",
    application_limit_note: { count: 1, window_days: 30, scope: "company" },
  });
  await application(bare, { status: "submitted", company: "Acme Ltd." }, [
    entry("picked", "2026-01-05T09:00:00.000Z"),
  ]);
  await screen(bare);
  const flags = (await shortlist(bare)).flatMap((i) => i.flags);
  assert.equal(flags.length, 3);
  assert.match(flags[0] ?? "", /your note/);
});

// ---------------------------------------------------------------------------------------
// Ranking, badges, suggestions

test("an over-limit Listing sorts below the fit order with its Fit score unchanged", async (t) => {
  const baseline = tempDir(t);
  await setUp(baseline, LISTINGS({ employer: "emp-acme" }));
  await noteOn(baseline, { count: 1, window_days: 30, scope: "same_role" });
  await screen(baseline);
  const base = await shortlist(baseline);
  const topId = base[0]?.id as string;

  const dataDir = tempDir(t);
  await setUp(dataDir, LISTINGS({ employer: "emp-acme" }));
  await noteOn(dataDir, { count: 1, window_days: 30, scope: "same_role" });
  const title = topId === PLATFORM ? "Platform Engineer" : "Senior Backend Engineer";
  await application(dataDir, { status: "submitted", employer: "emp-acme", title }, [
    entry("picked", "2026-01-05T09:00:00.000Z"),
  ]);
  await screen(dataDir);
  const items = await shortlist(dataDir);
  const flaggedIds = items.filter((i) => i.flags.length > 0).map((i) => i.id);
  assert.ok(flaggedIds.includes(topId));
  const firstFlagged = items.findIndex((i) => i.flags.length > 0);
  assert.ok(
    items.slice(firstFlagged).every((i) => i.flags.length > 0),
    "flagged Listings sit below",
  );
  for (const i of items) {
    assert.equal(i.fit, base.find((b) => b.id === i.id)?.fit, "Fit score unchanged");
  }
});

test("when a company has more Shortlisted Listings than slots, the top-fit ones are suggested", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, LISTINGS({ employer: "emp-acme" }));
  await noteOn(dataDir, { count: 2, window_days: 30, scope: "company" });
  await application(dataDir, { status: "submitted", employer: "emp-acme", title: "Other role" }, [
    entry("picked", "2026-01-05T09:00:00.000Z"),
  ]);
  await screen(dataDir);

  const items = await shortlist(dataDir);
  assert.equal(items.length, 3);
  const suggested = items.filter((i) => i.suggested === true);
  assert.equal(suggested.length, 1, "one slot left for three Listings");
  const best = [...items].sort((a, b) => b.fit - a.fit)[0];
  assert.equal(suggested[0]?.id, best?.id);
  assert.deepEqual(items[0]?.group, { company: "Acme", slots: 1, members: 3 });
  const text = (await runCli(["screen", "digest"], { dataDir })).json.text as string;
  assert.match(text, /suggested/);
});

// ---------------------------------------------------------------------------------------
// Decision tree and overrides

test("every Listing's Decision tree has an Application-limit node", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);
  for (const id of [BACKEND, PLATFORM, BACKEND_BERLIN]) {
    const l = await getListing(dataDir, id);
    assert.ok(l.screen.checks.some((c: any) => c.check === "application_limit.limit"));
    const tree = readFileSync(join(dataDir, l.decision_tree), "utf8");
    assert.match(tree, /Application limit/);
  }
});

const CORE = "node /plugins/job-butler/core/src/cli.ts";
async function approvedPick(dataDir: string, ids: string[], flags: string[] = []) {
  const action = `application pick ${ids.join(" ")}`;
  const rec = await runCli(
    ["approval", "record", "shortlist-pick", "--session", "s1", "--input", "-"],
    {
      dataDir,
      input: { actions: [action] },
    },
  );
  assert.equal(rec.code, 0, rec.stdout);
  const hook = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: "s1", tool_name: "Bash", tool_input: { command: `${CORE} ${action}` } },
  });
  assert.equal(JSON.stringify(hook.json), "{}");
  return runCli([...action.split(" "), ...flags], { dataDir });
}

test("picking an over-limit Listing needs an explicit override, which the Event log records", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await application(dataDir, { status: "submitted" }, [
    entry("picked", "2025-12-20T10:00:00.000Z"),
    entry("submitted", "2025-12-21T10:00:00.000Z", "picked"),
  ]);
  await screen(dataDir);

  const refused = await approvedPick(dataDir, [BACKEND]);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.error?.code, "OVER_APPLICATION_LIMIT");
  assert.match(refused.json.error?.message ?? "", /2nd of 1/);
  assert.equal((await getListing(dataDir, BACKEND)).application_id, undefined);

  const ok = await approvedPick(dataDir, [BACKEND], ["--override-limit", BACKEND]);
  assert.equal(ok.code, 0, ok.stdout);
  const apps = ok.json.applications as { event_log: { reason: string }[]; id: string }[];
  assert.match(apps[0]?.event_log[0]?.reason ?? "", /override/i);
  assert.match(apps[0]?.event_log[0]?.reason ?? "", /2nd of 1/);
  const l = await getListing(dataDir, BACKEND);
  assert.equal(l.overrides[0].kind, "application_limit");
  const tree = readFileSync(join(dataDir, l.decision_tree), "utf8");
  assert.match(tree, /Override: application_limit/);
});

test("an under-limit pick needs no override", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);
  const ok = await approvedPick(dataDir, [PLATFORM]);
  assert.equal(ok.code, 0, ok.stdout);
});

test("picks in one command are counted in turn, so a second pick for the same role needs an override", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);
  // Default is 1 per same role: picking Backend uses the last slot; the Berlin twin is then over.
  const ok = await approvedPick(dataDir, [BACKEND, BACKEND_BERLIN]);
  assert.equal(ok.code, 1);
  assert.equal(ok.json.error?.code, "OVER_APPLICATION_LIMIT");
});
