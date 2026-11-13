import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

/** Listings in the shape Discover writes them (core-conventions.md, "Listing record"). */
function listing(id: string, title: string, location: string | null) {
  const jobId = id.split(":").at(-1);
  return {
    source: "greenhouse",
    board: "greenhouse:acme",
    company: "Acme",
    source_job_id: jobId,
    title,
    location,
    url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}`,
    description: `${title} at Acme. You have shipped Go services to production.`,
    departments: ["Engineering"],
    employment_type: null,
    salary: null,
    posted_at: "2026-01-10T00:00:00.000Z",
    deadline: null,
    source_fields: { internal_job_id: 1 },
    aliases: [{ id, url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}` }],
    sightings: [{ discover_run: "run-1", alias: id, seen_at: "2026-01-14T07:00:00.000Z" }],
    first_seen_at: "2026-01-14T07:00:00.000Z",
    last_seen_at: "2026-01-14T07:00:00.000Z",
    gone: false,
    gone_at: null as string | null,
  };
}

const LISTINGS = [
  listing("greenhouse:acme:101", "Senior Backend Engineer", "London"),
  listing("greenhouse:acme:102", "Platform Engineer", "Remote (UK)"),
  listing("greenhouse:acme:103", "Senior Backend Engineer", "Berlin"),
  listing("greenhouse:acme:104", "Junior Data Analyst", "London"),
];

/** Setup's complete Profile (targets: Backend/Platform Engineer, senior/staff, London, remote). */
async function setUp(dataDir: string, listings = LISTINGS): Promise<void> {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  const p = await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  assert.equal(p.code, 0, p.stdout);
  const prefs = await runCli(["preferences", "init"], { dataDir });
  assert.equal(prefs.code, 0, prefs.stdout);
  for (const l of listings) {
    const id = l.aliases[0]?.id as string;
    const r = await runCli(["record", "put", "listing", id, "--input", "-"], { dataDir, input: l });
    assert.equal(r.code, 0, r.stdout);
  }
}

/** The worker's skills rating, cut down to the given Listings. */
function rating(...ids: string[]) {
  const all = JSON.parse(readFileSync(judgment("screen-skills-rating"), "utf8"));
  return {
    judgments: all.judgments.filter((j: { listing_id: string }) => ids.includes(j.listing_id)),
  };
}

const ALL_IDS = LISTINGS.map((l) => l.aliases[0]?.id as string);

async function screen(dataDir: string, input: unknown = rating(...ALL_IDS)) {
  const r = await runCli(["screen", "record", "--input", "-"], { dataDir, input });
  assert.equal(r.code, 0, r.stdout);
  return r.json;
}

interface Check {
  check: string;
  name: string;
  rule: string;
  result: string;
  status: string;
  citation: string;
  evidence: string[];
}

interface ScreenedListing {
  id: string;
  screen: {
    outcome: string;
    fit: {
      score: number;
      band: string;
      skills_score: number;
      rules_score: number;
      capped: boolean;
      criteria: Record<string, unknown>[];
      rules: { rule: string; result: string; evidence: string }[];
    };
    checks: Check[];
  };
  decision_tree: string;
  application_id?: string;
  [field: string]: unknown;
}

async function getListing(dataDir: string, id: string): Promise<ScreenedListing> {
  const r = await runCli(["record", "get", "listing", id], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  return r.json.record as ScreenedListing;
}

// ---------------------------------------------------------------------------------------
// Pending: what Screen hands the worker

test("screen pending hands the worker each unscreened Listing plus the Profile it rates against", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);

  const r = await runCli(["screen", "pending"], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  const listings = r.json.listings as Record<string, unknown>[];
  assert.deepEqual(
    listings.map((l) => l.id),
    ALL_IDS,
  );
  assert.deepEqual(Object.keys(listings[0] ?? {}).sort(), [
    "company",
    "description",
    "id",
    "location",
    "title",
  ]);
  const profile = r.json.profile as Record<string, unknown>;
  assert.deepEqual(Object.keys(profile).sort(), ["base_resume", "targets"]);
  assert.equal(r.json.judgments_file, join(dataDir, "inbox", "screen-judgments.json"));
});

// ---------------------------------------------------------------------------------------
// Fit score: rules, the LLM skills rating, bands and capping

test("Fit score weighs the skills rating most, with rules for location, seniority and roles", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  const strong = await getListing(dataDir, "greenhouse:acme:101");
  assert.equal(strong.screen.fit.score, 87);
  assert.equal(strong.screen.fit.band, "strong");
  assert.deepEqual(
    strong.screen.fit.rules.map((r) => [r.rule, r.result]),
    [
      ["location", "pass"],
      ["seniority", "pass"],
      ["target_roles", "pass"],
    ],
  );

  // No seniority word in "Platform Engineer": the seniority rule is unknown, not failed.
  const partial = await getListing(dataDir, "greenhouse:acme:102");
  assert.equal(partial.screen.fit.score, 65);
  assert.equal(partial.screen.fit.band, "partial");
  assert.equal(partial.screen.fit.rules[1]?.result, "unknown");
  assert.equal(partial.screen.fit.capped, false);
});

test("a failed rule caps the Fit score in the weak band", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  // Same rating as the 87 above, but in Berlin: uncapped it would be 80.
  const berlin = await getListing(dataDir, "greenhouse:acme:103");
  assert.equal(berlin.screen.fit.rules[0]?.result, "fail");
  assert.match(berlin.screen.fit.rules[0]?.evidence ?? "", /Berlin/);
  assert.equal(berlin.screen.fit.score, 49);
  assert.equal(berlin.screen.fit.band, "weak");
  assert.equal(berlin.screen.fit.capped, true);

  // Already below the cap: the score stands.
  const analyst = await getListing(dataDir, "greenhouse:acme:104");
  assert.deepEqual(
    analyst.screen.fit.rules.map((r) => r.result),
    ["pass", "fail", "fail"],
  );
  assert.equal(analyst.screen.fit.score, 27);
  assert.equal(analyst.screen.fit.band, "weak");
});

test("the per-criterion breakdown is stored on the Listing with its evidence", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  const strong = await getListing(dataDir, "greenhouse:acme:101");
  assert.equal(strong.screen.fit.criteria.length, 4);
  assert.deepEqual(strong.screen.fit.criteria[3], {
    criterion: "Mentoring",
    importance: "nice",
    match: "strong",
    listing_quote: "mentor other engineers",
    resume_evidence: "Mentored four engineers.",
  });
  assert.equal(Math.round(strong.screen.fit.skills_score), 83);
  assert.equal(strong.screen.fit.rules_score, 100);
});

test("a rating without evidence for a matched criterion is refused, and nothing is written", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const bad = rating("greenhouse:acme:101");
  bad.judgments[0].skills_rating.criteria[0].resume_evidence = null;

  const r = await runCli(["screen", "record", "--input", "-"], { dataDir, input: bad });

  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "JUDGMENT_INVALID");
  assert.match(r.json.error?.message ?? "", /resume_evidence/);
  assert.equal((await getListing(dataDir, "greenhouse:acme:101")).screen, undefined);
});

test("a rescore happens only when asked", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  const pending = await runCli(["screen", "pending"], { dataDir });
  assert.deepEqual(pending.json.listings, []);
  const again = await runCli(["screen", "record", "--input", "-"], {
    dataDir,
    input: rating("greenhouse:acme:102"),
  });
  assert.equal(again.json.error?.code, "ALREADY_SCREENED");

  const asked = await runCli(["screen", "rescore", "greenhouse:acme:102"], { dataDir });
  assert.equal(asked.code, 0, asked.stdout);
  const pendingAgain = await runCli(["screen", "pending"], { dataDir });
  assert.deepEqual(
    (pendingAgain.json.listings as { id: string }[]).map((l) => l.id),
    ["greenhouse:acme:102"],
  );
  const rescored = await runCli(["screen", "record", "--input", "-"], {
    dataDir,
    input: rating("greenhouse:acme:102"),
    env: { JOB_BUTLER_NOW: "2026-01-16T09:00:00.000Z" },
  });
  assert.equal(rescored.code, 0, rescored.stdout);
  const after = await getListing(dataDir, "greenhouse:acme:102");
  assert.equal(
    (after.screen as unknown as { screened_at: string }).screened_at,
    "2026-01-16T09:00:00.000Z",
  );
});

// ---------------------------------------------------------------------------------------
// Shortlist: ranking, the digest, why and help

test("the Shortlist ranks by Fit score, lettered a, b, c, and drops gone Listings", async (t) => {
  const dataDir = tempDir(t);
  const gone = { ...listing("greenhouse:acme:105", "Staff Backend Engineer", "London") };
  gone.gone = true;
  gone.gone_at = "2026-01-15T07:00:00.000Z";
  await setUp(dataDir, [
    LISTINGS[3],
    LISTINGS[2],
    LISTINGS[0],
    LISTINGS[1],
    gone,
  ] as typeof LISTINGS);
  await screen(dataDir);

  const r = await runCli(["screen", "digest"], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  const shortlist = r.json.shortlist as Record<string, unknown>[];
  assert.deepEqual(
    shortlist.map((s) => [s.letter, s.id, s.fit, s.band]),
    [
      ["a", "greenhouse:acme:101", 87, "strong"],
      ["b", "greenhouse:acme:102", 65, "partial"],
      ["c", "greenhouse:acme:103", 49, "weak"],
      ["d", "greenhouse:acme:104", 27, "weak"],
    ],
  );
  const text = String(r.json.text);
  assert.match(text, /SHORTLIST \(4\)/);
  assert.match(text, /a\) 87 strong +Acme +Senior Backend Engineer +London/);
  assert.match(text, /why <letter> · pick a, b · show excluded · restore <name> · help/);
});

test("why <letter> prints each check with its result and evidence", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  const r = await runCli(["screen", "why", "c"], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.listing_id, "greenhouse:acme:103");
  const text = String(r.json.text);
  assert.match(text, /^Acme · Senior Backend Engineer · Berlin · Fit 49 weak/);
  assert.match(text, /✗ Location +fail/);
  assert.match(text, /✓ Seniority +pass/);
  assert.match(text, /✓ Skills rating +83\/100/);
  assert.match(text, /"deep PostgreSQL experience"/);
  assert.match(text, /Full diagram: .*decision-trees\/greenhouse%3Aacme%3A103\.mmd/);
  const checks = r.json.checks as Check[];
  assert.deepEqual(
    checks.map((c) => c.check),
    [
      "scam.signs",
      "scam.no_vacancy",
      "deny.list",
      "ghost.score",
      "sponsorship.employer",
      "sponsorship.role",
      "sponsorship.pay",
      "sponsorship.wording",
      "sponsorship.verdict",
      "fit.location",
      "fit.seniority",
      "fit.target_roles",
      "fit.skills",
      "fit.score",
      "application_limit.limit",
    ],
  );
});

test("why also takes a Listing ID, and an unknown letter is refused", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  const byId = await runCli(["screen", "why", "greenhouse:acme:101"], { dataDir });
  assert.equal(byId.json.listing_id, "greenhouse:acme:101");
  const unknown = await runCli(["screen", "why", "z"], { dataDir });
  assert.equal(unknown.json.error?.code, "NOT_FOUND");
});

test("help lists the replies the digest takes", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  const r = await runCli(["screen", "digest"], { dataDir });

  const replies = (r.json.replies as { reply: string }[]).map((x) => x.reply);
  assert.deepEqual(replies, [
    "why <letter>",
    "pick a, b",
    "show excluded",
    "restore <name>",
    "help",
  ]);
});

// ---------------------------------------------------------------------------------------
// Pick: the Shortlist-pick Checkpoint creates Picked Applications

const CORE = "node /plugins/job-butler/core/src/cli.ts";
const SESSION = "session-1";

/** The job seeker said yes: record the Approval, then the hook spends it as Bash runs. */
async function approveAndRun(dataDir: string, action: string) {
  const recorded = await runCli(
    ["approval", "record", "shortlist-pick", "--session", SESSION, "--input", "-"],
    { dataDir, input: { actions: [action] } },
  );
  assert.equal(recorded.code, 0, recorded.stdout);
  const hook = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: SESSION, tool_name: "Bash", tool_input: { command: `${CORE} ${action}` } },
  });
  assert.equal(JSON.stringify(hook.json), "{}", "the hook lets the approved pick through");
  return {
    approval: recorded.json.approval as { id: string; approved_at: string },
    result: await runCli(action.split(" "), { dataDir }),
  };
}

interface Application {
  id: string;
  origin: string;
  listing: string;
  status: string;
  event_log: Record<string, unknown>[];
  decision_tree: string;
}

test("pick a, b records the Approval and creates one Picked Application per Listing", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  const action = "application pick greenhouse:acme:101 greenhouse:acme:102";
  const { approval, result } = await approveAndRun(dataDir, action);

  assert.equal(result.code, 0, result.stdout);
  const apps = (await runCli(["record", "list", "application"], { dataDir })).json
    .records as Application[];
  assert.equal(apps.length, 2);
  const first = apps.find((a) => a.listing === "greenhouse:acme:101");
  assert.match(
    first?.id ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(first?.origin, "picked");
  assert.equal(first?.status, "picked");
  assert.equal(first?.decision_tree, "decision-trees/greenhouse%3Aacme%3A101.mmd");
  assert.deepEqual(first?.event_log, [
    {
      at: "2026-01-15T09:00:00.000Z",
      stage: "screen",
      from: null,
      to: "picked",
      reason: "Picked from the Shortlist (Fit 87 strong).",
      approval: {
        id: approval.id,
        checkpoint: "shortlist-pick",
        approved_at: approval.approved_at,
        action,
      },
    },
  ]);
  assert.equal((await getListing(dataDir, "greenhouse:acme:101")).application_id, first?.id);

  // Picked Listings leave the Shortlist; the rest are lettered again.
  const after = await runCli(["screen", "digest"], { dataDir });
  assert.deepEqual(
    (after.json.shortlist as { letter: string; id: string }[]).map((s) => [s.letter, s.id]),
    [
      // 103 is the same role as the picked 101, so the default cooldown sorts it below 104.
      ["a", "greenhouse:acme:104"],
      ["b", "greenhouse:acme:103"],
    ],
  );
});

test("a pick with no Approval behind it is refused and creates nothing", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  const r = await runCli(["application", "pick", "greenhouse:acme:101"], { dataDir });

  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "APPROVAL_MISSING");
  const apps = await runCli(["record", "list", "application"], { dataDir });
  assert.deepEqual(apps.json.records, []);
});

test("only Listings on the Shortlist can be picked, and only once", async (t) => {
  const dataDir = tempDir(t);
  const gone = { ...listing("greenhouse:acme:105", "Staff Backend Engineer", "London") };
  gone.gone = true;
  await setUp(dataDir, [...LISTINGS, gone]);
  await screen(dataDir, {
    judgments: [
      ...rating(...ALL_IDS).judgments,
      { ...rating("greenhouse:acme:101").judgments[0], listing_id: "greenhouse:acme:105" },
    ],
  });

  const withGone = await approveAndRun(
    dataDir,
    "application pick greenhouse:acme:101 greenhouse:acme:105",
  );
  assert.equal(withGone.result.json.error?.code, "NOT_ON_SHORTLIST");
  assert.match(withGone.result.json.error?.message ?? "", /gone from its board/);
  const none = await runCli(["record", "list", "application"], { dataDir });
  assert.deepEqual(none.json.records, [], "all or nothing");

  await approveAndRun(dataDir, "application pick greenhouse:acme:101");
  const twice = await approveAndRun(dataDir, "application pick greenhouse:acme:101");
  assert.equal(twice.result.json.error?.code, "ALREADY_PICKED");
});

// ---------------------------------------------------------------------------------------
// Decision tree

function tree(dataDir: string, listingId: string): string {
  const file = join(dataDir, "decision-trees", `${encodeURIComponent(listingId)}.mmd`);
  return readFileSync(file, "utf8");
}

test("each screened Listing gets a Decision tree with check, rule, result and citation", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);

  const mmd = tree(dataDir, "greenhouse:acme:103");
  const lines = mmd.split("\n");
  assert.equal(
    lines.find((l) => !l.startsWith("%%")),
    "flowchart TD",
  );
  assert.ok(lines.includes('  L["<b>Acme</b><br/>Senior Backend Engineer<br/>Berlin"]:::src'));
  // A failed Fit rule caps rather than excludes: amber, not red.
  assert.ok(
    lines.includes(
      '  c_fit_location["<b>Location</b><br/><small>In your locations, or remote when you ' +
        "accept remote; not on your location deny list</small><br/>→ fail<br/><i>#quot;Berlin#quot; " +
        "isn't one of your locations (London) and isn't remote.</i>\"]:::warn",
    ),
    mmd,
  );
  assert.ok(lines.includes("  L --> c_scam_signs"));
  assert.ok(lines.includes("  c_ghost_score --> c_sponsorship_employer"));
  assert.ok(lines.includes("  c_sponsorship_verdict --> c_fit_location"));
  assert.ok(lines.includes("  c_fit_location --> c_fit_seniority"));
  assert.match(
    mmd,
    /c_fit_skills\["<b>Skills rating<\/b>.*→ 83\/100<br\/><i>3 of 4 criteria strongly evidenced\./,
  );
  assert.match(
    mmd,
    /c_fit_score\[.*→ 49 weak<br\/><i>.*capped at 49: location failed<\/i>"\]:::warn/,
  );
  assert.ok(
    lines.includes('  c_application_limit_limit --> SL(["On the Shortlist · Fit 49 weak"]):::out'),
  );
  assert.ok(
    lines.includes(
      "  classDef nr     fill:#f2f2f2,stroke:#b5b5b5,stroke-dasharray:4 3,color:#8a8a8a",
    ),
  );
  const stored = await getListing(dataDir, "greenhouse:acme:103");
  assert.equal(stored.decision_tree, "decision-trees/greenhouse%3Aacme%3A103.mmd");
});

test("after the pick the tree carries on through the Event log", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await screen(dataDir);
  const before = tree(dataDir, "greenhouse:acme:101");

  const { approval } = await approveAndRun(dataDir, "application pick greenhouse:acme:101");

  const mmd = tree(dataDir, "greenhouse:acme:101");
  const lines = mmd.split("\n");
  assert.ok(before.includes("On the Shortlist · Fit 87 strong"));
  assert.ok(!mmd.includes("On the Shortlist"), "regenerated in full, not appended to");
  assert.ok(
    lines.includes('  c_application_limit_limit --> SL(["Shortlisted · Fit 87 strong"]):::ok'),
  );
  assert.ok(
    lines.includes(
      '  e1["<b>Picked</b><br/><small>screen · 2026-01-15T09:00:00.000Z</small><br/>Picked from ' +
        `the Shortlist (Fit 87 strong).<br/><i>Your Approval (shortlist-pick, ${approval.approved_at}): ` +
        'application pick greenhouse:acme:101</i>"]:::human',
    ),
    mmd,
  );
  assert.ok(lines.includes("  SL --> e1"));
  assert.ok(lines.includes('  e1 --> ST(["Status: Picked"]):::out'));
});

test("a split override gets its own node in the tree", async (t) => {
  const dataDir = tempDir(t);
  const merged = listing("greenhouse:acme:101", "Senior Backend Engineer", "London");
  merged.aliases.push({
    id: "greenhouse:acme:999",
    url: "https://job-boards.greenhouse.io/acme/jobs/999",
  });
  await setUp(dataDir, [merged]);
  const split = await runCli(["listing", "split", "greenhouse:acme:101", "greenhouse:acme:999"], {
    dataDir,
  });
  assert.equal(split.code, 0, split.stdout);

  await screen(dataDir, rating("greenhouse:acme:101"));

  const lines = tree(dataDir, "greenhouse:acme:101").split("\n");
  assert.ok(
    lines.includes(
      '  o1["<b>Override: split</b><br/>Split off greenhouse:acme:999: a different job, never ' +
        'merged again<br/><i>Your decision · 2026-01-15T09:00:00.000Z</i>"]:::human',
    ),
    lines.join("\n"),
  );
  assert.ok(lines.includes("  L -.- o1"));
});

test("a Listing gone from its board shows so in its tree at the next Screen", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, LISTINGS.slice(0, 2));
  await screen(dataDir, rating("greenhouse:acme:101"));
  const l = await getListing(dataDir, "greenhouse:acme:101");
  await runCli(["record", "put", "listing", l.id, "--input", "-"], {
    dataDir,
    input: { ...l, gone: true, gone_at: "2026-01-15T08:00:00.000Z" },
  });

  await screen(dataDir, rating("greenhouse:acme:102"));

  assert.match(
    tree(dataDir, "greenhouse:acme:101"),
    /GONE\(\["Gone from its board · off the Shortlist · Fit 87 strong"\]\):::out/,
  );
});
