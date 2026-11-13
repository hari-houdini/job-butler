// Screen exclusions and the ghost score (#39), driven through the core CLI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

const NOW = "2026-01-15T09:00:00.000Z";
const ENV = { JOB_BUTLER_NOW: NOW };

type Fields = Record<string, unknown>;

/** A Listing as Discover writes it, fresh (seen today), with overrides for the case at hand. */
function listing(jobId: string, fields: Fields = {}) {
  const id = `greenhouse:acme:${jobId}`;
  return {
    id,
    source: "greenhouse",
    board: "greenhouse:acme",
    company: "Acme",
    source_job_id: jobId,
    title: "Backend Engineer",
    location: "London",
    url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}`,
    description: "Backend Engineer at Acme. You have shipped Go services to production.",
    departments: [],
    employment_type: null,
    salary: "£90,000",
    posted_at: NOW,
    deadline: null,
    source_fields: { internal_job_id: 1 },
    aliases: [{ id, url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}` }],
    sightings: [{ discover_run: "run-1", alias: id, seen_at: NOW }],
    first_seen_at: NOW,
    last_seen_at: NOW,
    gone: false,
    gone_at: null,
    repost_count: 0,
    ...fields,
  };
}

async function setUp(dataDir: string, listings: ReturnType<typeof listing>[]): Promise<void> {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  assert.equal(
    (await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile })).code,
    0,
  );
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
  for (const l of listings) {
    const r = await runCli(["record", "put", "listing", l.id, "--input", "-"], {
      dataDir,
      input: l,
    });
    assert.equal(r.code, 0, r.stdout);
  }
}

/** One strong skills rating per Listing: the exclusions don't depend on it. */
function ratings(listings: { id: string }[]) {
  return {
    judgments: listings.map((l) => ({
      listing_id: l.id,
      skills_rating: {
        summary: "Go evidenced.",
        criteria: [
          {
            criterion: "Go",
            importance: "core",
            match: "strong",
            listing_quote: "shipped Go services",
            resume_evidence: "Senior Software Engineer: Go services",
          },
        ],
      },
    })),
  };
}

interface Check {
  check: string;
  status: string;
  effect: string | null;
  result: string;
  evidence: string[];
}
interface Screened {
  id: string;
  screen: {
    outcome: string;
    excluded_by: string | null;
    checks: Check[];
    flags: { check: string; label: string }[];
    badges: { check: string; label: string }[];
    fit?: { score: number; band: string };
    ghost?: { score: number; band: string; reasons: { signal: string; points: number }[] };
  };
  overrides?: { kind: string; at: string; check?: string }[];
  decision_tree: string;
}

async function screenAll(dataDir: string, listings: { id: string }[]) {
  const r = await runCli(["screen", "record", "--input", "-"], {
    dataDir,
    input: ratings(listings),
    env: ENV,
  });
  assert.equal(r.code, 0, r.stdout);
  return r.json;
}

async function get(dataDir: string, id: string): Promise<Screened> {
  const r = await runCli(["record", "get", "listing", id], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  return r.json.record as Screened;
}

function check(l: Screened, id: string): Check {
  const c = l.screen.checks.find((x) => x.check === id);
  assert.ok(c, `no check ${id}`);
  return c;
}

// ---------------------------------------------------------------------------------------
// Scam gate

const SCAMS: [string, string][] = [
  ["payment", "A one-off $49 training fee is due before your first day."],
  ["payment", "You must purchase your own starter kit to begin."],
  ["crypto", "Your salary is paid in Bitcoin and you will deposit USDT to activate your account."],
  [
    "reshipping",
    "Receive packages at home and forward them to our warehouse (package forwarding).",
  ],
  ["text_only_interview", "The interview is conducted via Telegram chat only, no video."],
];

for (const [sign, text] of SCAMS) {
  test(`the scam gate excludes on ${sign}: "${text.slice(0, 30)}…" and cuts the later checks off`, async (t) => {
    const dataDir = tempDir(t);
    const scam = listing("201", { description: `Remote assistant. ${text}` });
    await setUp(dataDir, [scam]);

    await screenAll(dataDir, [scam]);

    const l = await get(dataDir, scam.id);
    assert.equal(l.screen.outcome, "excluded");
    assert.equal(l.screen.excluded_by, "scam.signs");
    const c = check(l, "scam.signs");
    assert.equal(c.status, "fail");
    assert.equal(c.effect, "exclude");
    assert.ok(
      c.evidence.some((e) => e.includes(sign)),
      c.evidence.join("|"),
    );
    assert.equal(check(l, "deny.list").status, "not_reached");
    assert.equal(check(l, "ghost.score").status, "not_reached");
    assert.equal(check(l, "fit.score").status, "not_reached");
  });
}

test("the scam gate excludes on the employer's own no-current-vacancy statement", async (t) => {
  const dataDir = tempDir(t);
  const l0 = listing("202", {
    description: "Join our talent pool. THERE IS NO CURRENT VACANCY: we are collecting resumes.",
  });
  await setUp(dataDir, [l0]);

  await screenAll(dataDir, [l0]);

  const l = await get(dataDir, l0.id);
  assert.equal(l.screen.excluded_by, "scam.no_vacancy");
  assert.equal(check(l, "scam.no_vacancy").effect, "exclude");
  assert.equal(check(l, "scam.signs").status, "pass");
});

test("a clean advert passes the scam gate and stays on the Shortlist", async (t) => {
  const dataDir = tempDir(t);
  const clean = listing("203");
  await setUp(dataDir, [clean]);

  const out = await screenAll(dataDir, [clean]);

  const l = await get(dataDir, clean.id);
  assert.equal(l.screen.outcome, "shortlist");
  assert.equal(check(l, "scam.signs").status, "pass");
  assert.equal(check(l, "scam.no_vacancy").status, "pass");
  assert.equal((out.shortlist as unknown[]).length, 1);
});

// ---------------------------------------------------------------------------------------
// Deny list

test("a Listing from a deny-listed company or with a deny-listed title word is excluded", async (t) => {
  const dataDir = tempDir(t);
  const byCompany = listing("301", { company: "Contoso Ltd" });
  const byTitle = listing("302", { title: "Sales Backend Engineer" });
  await setUp(dataDir, [byCompany, byTitle]);

  await screenAll(dataDir, [byCompany, byTitle]);

  for (const l0 of [byCompany, byTitle]) {
    const l = await get(dataDir, l0.id);
    assert.equal(l.screen.outcome, "excluded");
    assert.equal(l.screen.excluded_by, "deny.list");
    assert.match(check(l, "deny.list").evidence.join("|"), /deny/);
    assert.equal(check(l, "scam.signs").status, "pass");
    assert.equal(check(l, "ghost.score").status, "not_reached");
  }
});

test("restoring a deny-listed Listing is refused: only editing the Profile changes it", async (t) => {
  const dataDir = tempDir(t);
  const denied = listing("303", { company: "Contoso" });
  await setUp(dataDir, [denied]);
  await screenAll(dataDir, [denied]);

  const r = await runCli(["restore", "Contoso"], { dataDir, env: ENV });

  assert.notEqual(r.code, 0);
  assert.equal(r.json.error?.code, "DENY_LISTED");
  assert.equal((await get(dataDir, denied.id)).screen.outcome, "excluded");
});

// ---------------------------------------------------------------------------------------
// Ghost score

const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

async function ghostOf(t: Parameters<typeof tempDir>[0], fields: Fields) {
  const dataDir = tempDir(t);
  const l0 = listing("401", fields);
  await setUp(dataDir, [l0]);
  await screenAll(dataDir, [l0]);
  return get(dataDir, l0.id);
}

function signals(l: Screened): Record<string, number> {
  return Object.fromEntries((l.screen.ghost?.reasons ?? []).map((r) => [r.signal, r.points]));
}

test("a fresh Listing with a salary has a Low ghost score and no reasons", async (t) => {
  const l = await ghostOf(t, {});
  assert.equal(l.screen.ghost?.score, 0);
  assert.equal(l.screen.ghost?.band, "low");
  assert.deepEqual(signals(l), {});
  assert.equal(check(l, "ghost.score").status, "pass");
  assert.equal(l.screen.flags.length, 0);
});

test("age counts from the earlier of first seen and posted, in steps", async (t) => {
  assert.deepEqual(signals(await ghostOf(t, { first_seen_at: daysAgo(10) })), {});
  assert.deepEqual(signals(await ghostOf(t, { first_seen_at: daysAgo(45) })), { age: 2 });
  assert.deepEqual(signals(await ghostOf(t, { first_seen_at: daysAgo(75) })), { age: 3 });
  assert.deepEqual(signals(await ghostOf(t, { first_seen_at: daysAgo(120) })), { age: 4 });
  // posted_at resets on republish, so the earlier date wins either way
  assert.deepEqual(signals(await ghostOf(t, { posted_at: daysAgo(75) })), { age: 3 });
});

test("each repost adds a point, up to a cap", async (t) => {
  assert.deepEqual(signals(await ghostOf(t, { repost_count: 2 })), { repost: 2 });
  assert.deepEqual(signals(await ghostOf(t, { repost_count: 9 })), { repost: 3 });
});

test("a Greenhouse prospect post (no internal job id) is a strong ghost signal", async (t) => {
  const l = await ghostOf(t, { source_fields: { internal_job_id: null } });
  assert.deepEqual(signals(l), { prospect_post: 4 });
  assert.match(check(l, "ghost.score").evidence.join("|"), /prospect/i);
});

test("an expired deadline or validThrough is a strong ghost signal", async (t) => {
  assert.deepEqual(signals(await ghostOf(t, { deadline: daysAgo(3) })), { expired: 4 });
  assert.deepEqual(signals(await ghostOf(t, { deadline: daysAgo(-3) })), {});
});

test("a LinkedIn-only Listing is existence unverified", async (t) => {
  const l = await ghostOf(t, { existence_unverified: true });
  assert.deepEqual(signals(l), { existence_unverified: 2 });
});

test("a missing salary is a weak signal", async (t) => {
  assert.deepEqual(signals(await ghostOf(t, { salary: null })), { missing_salary: 1 });
});

test("the score is the sum of its signals, banded Low, Medium or High", async (t) => {
  const medium = await ghostOf(t, { first_seen_at: daysAgo(45), salary: null });
  assert.equal(medium.screen.ghost?.score, 3);
  assert.equal(medium.screen.ghost?.band, "medium");
  const low = await ghostOf(t, { first_seen_at: daysAgo(45) });
  assert.equal(low.screen.ghost?.score, 2);
  assert.equal(low.screen.ghost?.band, "low");
  const high = await ghostOf(t, { source_fields: { internal_job_id: null }, deadline: daysAgo(1) });
  assert.equal(high.screen.ghost?.score, 8);
  assert.equal(high.screen.ghost?.band, "high");
});

test("High ghost risk flags the Listing and sorts it below the fit order, Fit unchanged", async (t) => {
  const dataDir = tempDir(t);
  const ghosty = listing("501", {
    title: "A Backend Engineer",
    source_fields: { internal_job_id: null },
    deadline: daysAgo(1),
  });
  const clean = listing("502", { title: "Z Backend Engineer" });
  await setUp(dataDir, [ghosty, clean]);

  const out = await screenAll(dataDir, [ghosty, clean]);

  const order = (out.shortlist as { id: string; flags: string[] }[]).map((s) => s.id);
  assert.deepEqual(order, [clean.id, ghosty.id]);
  const g = await get(dataDir, ghosty.id);
  const c = await get(dataDir, clean.id);
  assert.equal(g.screen.outcome, "shortlist");
  assert.equal(g.screen.fit?.score, c.screen.fit?.score);
  assert.deepEqual(
    g.screen.flags.map((f) => f.label),
    ["Ghost risk: high"],
  );
  assert.equal(check(g, "ghost.score").effect, "flag");
});

test("Medium ghost risk shows a badge but keeps its place in the fit order", async (t) => {
  const l = await ghostOf(t, { first_seen_at: daysAgo(75) });
  assert.equal(l.screen.ghost?.band, "medium");
  assert.equal(l.screen.flags.length, 0);
  assert.deepEqual(
    l.screen.badges.map((b) => b.label),
    ["Ghost risk: medium"],
  );
});

test("the reasons are in the why output", async (t) => {
  const dataDir = tempDir(t);
  const l0 = listing("601", { first_seen_at: daysAgo(75), repost_count: 1 });
  await setUp(dataDir, [l0]);
  await screenAll(dataDir, [l0]);

  const r = await runCli(["screen", "why", l0.id], { dataDir });

  assert.match(String(r.json.text), /Ghost score\s+medium \(4\)/);
  assert.match(String(r.json.text), /age: 75 days/);
  assert.match(String(r.json.text), /repost/);
});

// ---------------------------------------------------------------------------------------
// The Excluded section, show excluded and restore

const SCAMMY = "Receive packages at home and forward them to our warehouse (package forwarding).";

async function withExcluded(t: Parameters<typeof tempDir>[0]) {
  const dataDir = tempDir(t);
  const top = listing("701", { title: "Backend Engineer" });
  const scam = listing("702", { title: "Backend Engineer", description: SCAMMY });
  const weak = listing("703", { title: "Junior Data Analyst" });
  await setUp(dataDir, [top, scam, weak]);
  const out = await screenAll(dataDir, [top, scam, weak]);
  return { dataDir, top, scam, weak, out };
}

test("the digest keeps excluded Listings out of the Shortlist and collapsed to a count", async (t) => {
  const { out } = await withExcluded(t);
  assert.equal((out.shortlist as unknown[]).length, 2);
  assert.equal(out.excluded, 1);
  assert.match(String(out.text), /EXCLUDED \(1\).*show excluded/);
  assert.match(JSON.stringify(out.replies), /restore <name>/);
});

test("show excluded lists each excluded Listing with the check that excluded it and why", async (t) => {
  const { dataDir, scam } = await withExcluded(t);

  const r = await runCli(["show", "excluded"], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  const rows = r.json.excluded as { id: string; excluded_by: string; reasons: string[] }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, scam.id);
  assert.equal(rows[0]?.excluded_by, "scam.signs");
  assert.match(String(rows[0]?.reasons.join("|")), /reshipping/);
  assert.match(String(r.json.text), /Acme/);
  assert.match(String(r.json.text), /restore/);
});

test("restore <name> records an override and returns the Listing to its fit position, still flagged", async (t) => {
  const { dataDir, top, scam, weak } = await withExcluded(t);

  const byId = await runCli(["restore", scam.id], { dataDir, env: ENV });
  assert.equal(byId.code, 0, byId.stdout);

  const order = (byId.json.shortlist as { id: string }[]).map((s) => s.id);
  assert.deepEqual(order, [top.id, scam.id, weak.id]);
  const l = await get(dataDir, scam.id);
  assert.equal(l.screen.outcome, "shortlist");
  assert.deepEqual(
    l.overrides?.map((o) => [o.kind, o.check]),
    [["restore", "scam.signs"]],
  );
  assert.equal(check(l, "scam.signs").status, "fail");
  assert.deepEqual(
    l.screen.badges.map((b) => b.label),
    ["Restored: Scam signs"],
  );
  assert.ok((l.screen.fit?.score ?? 0) > 0);
  assert.equal(check(l, "ghost.score").status, "pass");
});

test("restore takes the company and title as the name, and refuses an unknown or ambiguous one", async (t) => {
  const { dataDir } = await withExcluded(t);
  const none = await runCli(["restore", "Initech"], { dataDir, env: ENV });
  assert.equal(none.json.error?.code, "NOT_FOUND");

  const ok = await runCli(["restore", "Acme", "Backend"], { dataDir, env: ENV });
  assert.equal(ok.code, 0, ok.stdout);
  const again = await runCli(["restore", "Acme", "Backend"], { dataDir, env: ENV });
  assert.equal(again.json.error?.code, "NOT_FOUND");
});

test("a name that matches two excluded Listings is refused as ambiguous", async (t) => {
  const dataDir = tempDir(t);
  const a = listing("801", { description: SCAMMY });
  const b = listing("802", { description: SCAMMY });
  await setUp(dataDir, [a, b]);
  await screenAll(dataDir, [a, b]);

  const r = await runCli(["restore", "Acme"], { dataDir, env: ENV });

  assert.equal(r.json.error?.code, "AMBIGUOUS_NAME");
  assert.equal((await get(dataDir, a.id)).screen.outcome, "excluded");
});

test("the Decision tree shows not reached after an exclusion, then an override node after restore", async (t) => {
  const { dataDir, scam } = await withExcluded(t);
  const treeOf = async () =>
    readFileSync(`${dataDir}/${(await get(dataDir, scam.id)).decision_tree}`, "utf8");

  const before = await treeOf();
  assert.match(before, /Excluded · restorable/);
  assert.match(before, /Ghost score[\s\S]*→ not reached/);
  assert.doesNotMatch(before, /Override: restore/);

  await runCli(["restore", scam.id], { dataDir, env: ENV });

  const after = await treeOf();
  assert.match(after, /Override: restore/);
  assert.doesNotMatch(after, /Ghost score[^\n]*→ not reached/);
  assert.doesNotMatch(after, /Excluded · restorable/);
});

test("a rescore keeps a restored Listing restored", async (t) => {
  const { dataDir, scam } = await withExcluded(t);
  await runCli(["restore", scam.id], { dataDir, env: ENV });
  await runCli(["screen", "rescore", scam.id], { dataDir });

  await screenAll(dataDir, [scam]);

  assert.equal((await get(dataDir, scam.id)).screen.outcome, "shortlist");
});
