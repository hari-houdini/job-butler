import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES, judgment, runCli, tempDir } from "./harness.ts";

const REGISTER = { JOB_BUTLER_NETWORK_FIXTURES: join(FIXTURES, "sponsor-network") };
const TABLES = { JOB_BUTLER_NETWORK_FIXTURES: join(FIXTURES, "sponsorship-network") };
const TABLES_DOWN = {
  JOB_BUTLER_NETWORK_FIXTURES: join(FIXTURES, "sponsorship-network-down"),
  JOB_BUTLER_NOW: "2026-01-30T09:00:00.000Z",
};

interface Spec {
  n: number;
  company: string;
  title: string;
  location?: string;
  salary?: string | null;
  description?: string;
  /** Skills match for the worker's rating: sets the Fit score. */
  match?: "strong" | "partial";
}

function listing(s: Spec) {
  const id = `greenhouse:acme:${s.n}`;
  return {
    id,
    record: {
      source: "greenhouse",
      board: "greenhouse:acme",
      company: s.company,
      source_job_id: String(s.n),
      title: s.title,
      location: s.location ?? "London",
      url: `https://job-boards.greenhouse.io/acme/jobs/${s.n}`,
      description: s.description ?? `${s.title} at ${s.company}. You will build things.`,
      departments: ["Engineering"],
      employment_type: null,
      salary: s.salary ?? null,
      posted_at: "2026-01-10T00:00:00.000Z",
      deadline: null,
      source_fields: { internal_job_id: s.n },
      aliases: [{ id, url: `https://job-boards.greenhouse.io/acme/jobs/${s.n}` }],
      sightings: [{ discover_run: "run-1", alias: id, seen_at: "2026-01-14T07:00:00.000Z" }],
      first_seen_at: "2026-01-14T07:00:00.000Z",
      last_seen_at: "2026-01-14T07:00:00.000Z",
      gone: false,
      gone_at: null,
    },
    rating: {
      listing_id: id,
      skills_rating: {
        summary: "Rated for the Sponsorship tests.",
        criteria: [
          {
            criterion: "Backend",
            importance: "core",
            match: s.match ?? "strong",
            listing_quote: "You will build things",
            resume_evidence: "Senior Software Engineer, Northwind Payments",
          },
        ],
      },
    },
  };
}

type Sponsorship = Record<string, unknown>;

/** Setup's Profile with the given Sponsorship section; every Listing screened in one go. */
async function run(
  t: import("node:test").TestContext,
  specs: Spec[],
  sponsorship: Sponsorship | null,
  opts: {
    employers?: { company: string; town: string }[];
    env?: Record<string, string>;
    /** The job seeker's own Companies House key, set before the employers are matched. */
    key?: string;
  } = {},
) {
  const dataDir = tempDir(t);
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  if (sponsorship !== null) profile.sponsorship = sponsorship;
  const p = await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  assert.equal(p.code, 0, p.stdout);
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
  if (opts.key !== undefined) {
    const k = await runCli(["profile", "put", "--section", "companies_house_key", "--input", "-"], {
      dataDir,
      input: JSON.stringify(opts.key),
    });
    assert.equal(k.code, 0, k.stdout);
  }
  for (const e of opts.employers ?? []) {
    const m = await runCli(["employer", "match", "--input", "-"], {
      dataDir,
      input: e,
      env: REGISTER,
    });
    assert.equal(m.code, 0, m.stdout);
  }
  const items = specs.map(listing);
  for (const l of items) {
    const r = await runCli(["record", "put", "listing", l.id, "--input", "-"], {
      dataDir,
      input: l.record,
    });
    assert.equal(r.code, 0, r.stdout);
  }
  const r = await runCli(["screen", "record", "--input", "-"], {
    dataDir,
    input: { judgments: items.map((l) => l.rating) },
    env: opts.env ?? TABLES,
  });
  assert.equal(r.code, 0, r.stdout);
  return { dataDir, digest: r.json, ids: items.map((l) => l.id) };
}

interface Check {
  check: string;
  result: string;
  status: string;
  effect: string | null;
  citation: string;
  rule: string;
  evidence: string[];
  label: string | null;
}

async function checksOf(dataDir: string, id: string) {
  const r = await runCli(["record", "get", "listing", id], { dataDir });
  const screen = (
    r.json.record as {
      screen: { checks: Check[]; flags: unknown[]; badges: unknown[]; sponsorship?: Sponsorship };
    }
  ).screen;
  const by = (name: string) => screen.checks.find((c) => c.check === `sponsorship.${name}`);
  return { screen, by, verdict: by("verdict") as Check };
}

const ACME = { company: "Acme Widgets", town: "London" };
const NO_FLAGS = { needed: true, regime: "uk-skilled-worker", flags: {}, flags_skipped: true };
const NEW_ENTRANT = {
  needed: true,
  regime: "uk-skilled-worker",
  flags: { new_entrant: { value: true, reason: "graduate_route" } },
  flags_skipped: false,
};

test("likely only when the register, the SOC code and the pay all pass", async (t) => {
  const { dataDir, ids } = await run(
    t,
    [
      {
        n: 1,
        company: "Acme Widgets",
        title: "Senior Backend Engineer",
        salary: "£70,000 - £85,000 per year",
      },
    ],
    NO_FLAGS,
    { employers: [ACME] },
  );
  const { by, verdict, screen } = await checksOf(dataDir, ids[0] as string);

  assert.equal(by("employer")?.status, "pass");
  assert.match(by("employer")?.result ?? "", /A-rated Skilled Worker/);
  assert.equal(by("role")?.status, "pass");
  assert.match(by("role")?.result ?? "", /2134 Higher Skilled/);
  assert.equal(by("pay")?.status, "pass");
  assert.match(by("pay")?.rule ?? "", /£54,700/);
  assert.equal(by("wording")?.status, "pass");
  assert.equal(verdict.result, "likely");
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.effect, null);
  assert.deepEqual(screen.flags, []);
  assert.deepEqual(screen.badges, []);
});

test("a fuzzy employer match is unknown without a Companies House key, likely once verified", async (t) => {
  const ORBITAL = { company: "Orbital Dynamic Ltd", town: "Cambridge" };
  const job = {
    n: 1,
    company: "Orbital Dynamic Ltd",
    title: "Senior Backend Engineer",
    location: "Cambridge",
    salary: "£70,000 - £85,000 per year",
  };
  // No key: the near match doesn't count, though the role and pay both pass.
  const plain = await run(t, [job], NO_FLAGS, { employers: [ORBITAL] });
  const a = await checksOf(plain.dataDir, plain.ids[0] as string);
  assert.equal(a.by("role")?.status, "pass");
  assert.equal(a.by("pay")?.status, "pass");
  assert.equal(a.by("employer")?.status, "warn");
  assert.equal(a.verdict.result, "unknown");

  // With the key, Companies House verifies the same match and the verdict is likely.
  const keyed = await run(t, [job], NO_FLAGS, { employers: [ORBITAL], key: "test-key-not-real" });
  const b = await checksOf(keyed.dataDir, keyed.ids[0] as string);
  assert.equal(b.by("employer")?.status, "pass");
  assert.equal(b.verdict.result, "likely");

  // A near match whose town doesn't agree is unknown even with the key.
  const wrong = await run(t, [job], NO_FLAGS, {
    employers: [{ company: "Orbital Dynamic Ltd", town: "Leeds" }],
    key: "test-key-not-real",
  });
  const c = await checksOf(wrong.dataDir, wrong.ids[0] as string);
  assert.equal(c.verdict.result, "unknown");
});

test("every check is a Decision tree node with its threshold, result and citation", async (t) => {
  const { dataDir, ids } = await run(
    t,
    [{ n: 1, company: "Acme Widgets", title: "Backend Engineer", salary: "£70,000 a year" }],
    NO_FLAGS,
    { employers: [ACME] },
  );
  const tree = readFileSync(
    join(dataDir, "decision-trees", `${encodeURIComponent(ids[0] as string)}.mmd`),
    "utf8",
  );
  for (const name of ["employer", "role", "pay", "wording", "verdict"]) {
    assert.ok(tree.includes(`c_sponsorship_${name}`), `tree has the ${name} node`);
  }
  const { by } = await checksOf(dataDir, ids[0] as string);
  assert.match(by("employer")?.citation ?? "", /Home Office register as of 2026-01-15/);
  assert.match(by("role")?.citation ?? "", /GOV\.UK eligible occupations/);
  assert.match(by("pay")?.citation ?? "", /GOV\.UK going rates/);
  const why = await runCli(["screen", "why", ids[0] as string], { dataDir });
  assert.match(String(why.json.text), /Sponsorship pay/);
});

test("failed pay is flagged and sorts below the fit order, Fit unchanged", async (t) => {
  const { dataDir, digest, ids } = await run(
    t,
    [
      // Higher Fit, but £50,000 is under the 2134 going rate of £54,700.
      {
        n: 1,
        company: "Acme Widgets",
        title: "Senior Backend Engineer",
        salary: "£50,000 per year",
        match: "strong",
      },
      {
        n: 2,
        company: "Acme Widgets",
        title: "Senior Backend Engineer",
        salary: "£80,000 per year",
        match: "partial",
      },
    ],
    NO_FLAGS,
    { employers: [ACME] },
  );
  const failed = await checksOf(dataDir, ids[0] as string);
  assert.equal(failed.by("pay")?.status, "fail");
  assert.match(failed.by("pay")?.result ?? "", /£50,000 is under £54,700/);
  assert.equal(failed.verdict.result, "failed");
  assert.equal(failed.verdict.effect, "flag");
  const shortlist = digest.shortlist as { id: string; fit: number; flags: string[] }[];
  assert.deepEqual(
    shortlist.map((s) => s.id),
    [ids[1], ids[0]],
  );
  assert.deepEqual(shortlist[1]?.flags, ["Sponsorship: failed"]);
  const fits = shortlist.map((s) => s.fit);
  assert.ok((fits[1] ?? 0) > (fits[0] ?? 0), "the flagged Listing keeps the higher Fit score");
});

test("pay must also clear £41,700 when the going rate is lower", async (t) => {
  const { dataDir, ids } = await run(
    t,
    [
      { n: 1, company: "Acme Widgets", title: "Business Analyst", salary: "£40,000 per year" },
      { n: 2, company: "Acme Widgets", title: "Business Analyst", salary: "£42,000 per year" },
    ],
    NO_FLAGS,
    { employers: [ACME] },
  );
  const low = await checksOf(dataDir, ids[0] as string);
  assert.equal(low.by("pay")?.status, "fail");
  assert.match(low.by("pay")?.result ?? "", /under £41,700/);
  const ok = await checksOf(dataDir, ids[1] as string);
  assert.equal(ok.verdict.result, "likely");
});

test("missing evidence gives unknown with a badge that sorts by fit", async (t) => {
  const { dataDir, digest, ids } = await run(
    t,
    [
      // No salary advertised: pay is unknown, not a pass. Higher Fit than the next.
      {
        n: 1,
        company: "Acme Widgets",
        title: "Senior Backend Engineer",
        salary: null,
        match: "strong",
      },
      {
        n: 2,
        company: "Acme Widgets",
        title: "Software Developer",
        salary: "£80,000 per year",
        match: "partial",
      },
      // An employer that was never matched: unknown too.
      {
        n: 3,
        company: "Zorb Corp",
        title: "Software Engineer",
        salary: "£80,000 per year",
        match: "partial",
      },
      // A title with no SOC code in the table: unknown.
      {
        n: 4,
        company: "Acme Widgets",
        title: "Growth Hacker",
        salary: "£80,000 per year",
        match: "partial",
      },
    ],
    NO_FLAGS,
    { employers: [ACME] },
  );
  const noPay = await checksOf(dataDir, ids[0] as string);
  assert.equal(noPay.by("pay")?.status, "warn");
  assert.match(noPay.by("pay")?.result ?? "", /unknown/);
  assert.equal(noPay.verdict.result, "unknown");
  assert.equal(noPay.verdict.effect, "badge");
  const noEmployer = await checksOf(dataDir, ids[2] as string);
  assert.equal(noEmployer.by("employer")?.status, "warn");
  assert.equal(noEmployer.verdict.result, "unknown");
  const noSoc = await checksOf(dataDir, ids[3] as string);
  assert.equal(noSoc.by("role")?.status, "warn");
  assert.equal(noSoc.verdict.result, "unknown");

  const shortlist = digest.shortlist as { id: string; badges: string[]; flags: string[] }[];
  // Unknown is a badge only: the strong-fit unknown Listing stays first.
  assert.equal(shortlist[0]?.id, ids[0]);
  assert.deepEqual(shortlist[0]?.badges, ["Sponsorship: unknown"]);
  assert.deepEqual(shortlist[0]?.flags, []);
});

test("an unmatched or agency Employer is unknown, never yes", async (t) => {
  const { dataDir, ids } = await run(
    t,
    [
      {
        n: 1,
        company: "Zephyr Staffing Ltd",
        title: "Software Engineer",
        salary: "£80,000 a year",
      },
    ],
    NO_FLAGS,
    { employers: [{ company: "Zephyr Staffing Ltd", town: "London" }] },
  );
  const r = await checksOf(dataDir, ids[0] as string);
  assert.equal(r.by("employer")?.status, "warn");
  assert.equal(r.verdict.result, "unknown");
  assert.equal(r.verdict.label, "Sponsorship: unknown · agency, end client not named");
});

test("a B-rated register entry fails the Employer check", async (t) => {
  const { dataDir, ids } = await run(
    t,
    [
      {
        n: 1,
        company: "Northwind Traders",
        title: "Software Engineer",
        location: "Bristol",
        salary: "£80,000 a year",
      },
    ],
    NO_FLAGS,
    { employers: [{ company: "Northwind Traders", town: "Bristol" }] },
  );
  const r = await checksOf(dataDir, ids[0] as string);
  assert.equal(r.by("employer")?.status, "fail");
  assert.match(r.by("employer")?.result ?? "", /B rating/);
  assert.equal(r.verdict.result, "failed");
});

test("a Medium Skilled or ineligible SOC code fails the role check", async (t) => {
  const { dataDir, ids } = await run(
    t,
    [
      { n: 1, company: "Acme Widgets", title: "IT Support Technician", salary: "£50,000 a year" },
      { n: 2, company: "Acme Widgets", title: "Retail Assistant", salary: "£50,000 a year" },
    ],
    NO_FLAGS,
    { employers: [ACME] },
  );
  const medium = await checksOf(dataDir, ids[0] as string);
  assert.equal(medium.by("role")?.status, "fail");
  assert.match(medium.by("role")?.result ?? "", /3132 Medium Skilled/);
  assert.equal(medium.verdict.result, "failed");
  const inel = await checksOf(dataDir, ids[1] as string);
  assert.match(inel.by("role")?.result ?? "", /7111 Ineligible/);
});

test('"no sponsorship" wording overrides every passing check', async (t) => {
  const { dataDir, digest, ids } = await run(
    t,
    [
      {
        n: 1,
        company: "Acme Widgets",
        title: "Senior Backend Engineer",
        salary: "£90,000 per year",
        description: "Build things. Unfortunately we are unable to sponsor visas for this role.",
      },
      {
        n: 2,
        company: "Zorb Corp",
        title: "Growth Hacker",
        description: "Candidates must already have the right to work in the UK.",
      },
    ],
    NO_FLAGS,
    { employers: [ACME] },
  );
  const r = await checksOf(dataDir, ids[0] as string);
  assert.equal(r.by("employer")?.status, "pass");
  assert.equal(r.by("role")?.status, "pass");
  assert.equal(r.by("pay")?.status, "pass");
  assert.equal(r.by("wording")?.status, "fail");
  assert.match(r.by("wording")?.evidence.join(" ") ?? "", /unable to sponsor/);
  assert.equal(r.verdict.result, "failed");
  assert.equal(r.verdict.effect, "flag");
  // The override holds even when the other checks have no evidence at all.
  const bare = await checksOf(dataDir, ids[1] as string);
  assert.equal(bare.by("wording")?.status, "fail");
  assert.equal(bare.verdict.result, "failed");
  const shortlist = digest.shortlist as { id: string; flags: string[] }[];
  assert.ok(shortlist.every((s) => s.flags.includes("Sponsorship: failed")));
});

test('plain "right to work" wording is not a refusal', async (t) => {
  const { dataDir, ids } = await run(
    t,
    [
      {
        n: 1,
        company: "Acme Widgets",
        title: "Backend Engineer",
        salary: "£90,000 per year",
        description: "You must have the right to work in the UK. Visa sponsorship available.",
      },
    ],
    NO_FLAGS,
    { employers: [ACME] },
  );
  const r = await checksOf(dataDir, ids[0] as string);
  assert.equal(r.by("wording")?.status, "pass");
  assert.equal(r.verdict.result, "likely");
});

test("a new entrant's pay threshold is discounted from the flag", async (t) => {
  const spec: Spec = {
    n: 1,
    company: "Acme Widgets",
    title: "Software Engineer",
    salary: "£40,000 per year",
  };
  const without = await run(t, [spec], NO_FLAGS, { employers: [ACME] });
  const w = await checksOf(without.dataDir, without.ids[0] as string);
  assert.equal(w.by("pay")?.status, "fail");

  const withFlag = await run(t, [spec], NEW_ENTRANT, { employers: [ACME] });
  const f = await checksOf(withFlag.dataDir, withFlag.ids[0] as string);
  // 70% of £54,700 is £38,290, above the £33,400 new-entrant floor.
  assert.equal(f.by("pay")?.status, "pass");
  assert.match(f.by("pay")?.rule ?? "", /£38,290/);
  assert.match(f.by("pay")?.rule ?? "", /new entrant/);
  assert.equal(f.verdict.result, "likely");
});

test("PhD discounts: STEM 80% with a £33,400 floor, non-STEM 90% with £37,500", async (t) => {
  const spec: Spec = {
    n: 1,
    company: "Acme Widgets",
    title: "Software Engineer",
    salary: "£44,000 per year",
  };
  const stem = await run(
    t,
    [spec],
    { ...NO_FLAGS, flags: { relevant_phd: { value: true, stem: true } } },
    { employers: [ACME] },
  );
  const s = await checksOf(stem.dataDir, stem.ids[0] as string);
  assert.equal(s.by("pay")?.status, "pass"); // 80% of £54,700 = £43,760
  assert.match(s.by("pay")?.rule ?? "", /£43,760/);

  const nonStem = await run(
    t,
    [spec],
    { ...NO_FLAGS, flags: { relevant_phd: { value: true, stem: false } } },
    { employers: [ACME] },
  );
  const n = await checksOf(nonStem.dataDir, nonStem.ids[0] as string);
  assert.equal(n.by("pay")?.status, "fail"); // 90% of £54,700 = £49,230
  assert.match(n.by("pay")?.rule ?? "", /£49,230/);
});

test("a discount never lowers the floor below the flag's own minimum", async (t) => {
  const { dataDir, ids } = await run(
    t,
    [{ n: 1, company: "Acme Widgets", title: "Business Analyst", salary: "£33,000 per year" }],
    NEW_ENTRANT,
    { employers: [ACME] },
  );
  // 70% of £38,200 is £26,740, but the new-entrant floor is £33,400.
  const r = await checksOf(dataDir, ids[0] as string);
  assert.equal(r.by("pay")?.status, "fail");
  assert.match(r.by("pay")?.result ?? "", /£33,000 is under £33,400/);
});

test("salary text is read as the base: ranges use the bottom, k, hours and OTE", async (t) => {
  const { dataDir, ids } = await run(
    t,
    [
      { n: 1, company: "Acme Widgets", title: "Software Engineer", salary: "£60k - £90k" },
      { n: 2, company: "Acme Widgets", title: "Software Engineer", salary: "£30 per hour" },
      { n: 3, company: "Acme Widgets", title: "Software Engineer", salary: "£90,000 OTE" },
      { n: 4, company: "Acme Widgets", title: "Software Engineer", salary: "USD 120,000 per year" },
    ],
    NO_FLAGS,
    { employers: [ACME] },
  );
  const pay = async (i: number) => (await checksOf(dataDir, ids[i] as string)).by("pay");
  assert.equal((await pay(0))?.status, "pass");
  // £30 x 37.5 x 52 = £58,500
  assert.equal((await pay(1))?.status, "pass");
  assert.match((await pay(1))?.evidence.join(" ") ?? "", /£58,500/);
  assert.equal((await pay(2))?.status, "warn");
  assert.equal((await pay(3))?.status, "warn");
});

test("when Sponsorship is not a criterion every check passes as not a criterion", async (t) => {
  const { dataDir, digest, ids } = await run(
    t,
    [{ n: 1, company: "Zorb Corp", title: "Growth Hacker" }],
    { needed: false },
  );
  const r = await checksOf(dataDir, ids[0] as string);
  assert.equal(r.verdict.result, "not a criterion");
  assert.equal(r.verdict.status, "pass");
  assert.deepEqual((digest.shortlist as { badges: string[] }[])[0]?.badges, []);
});

test("the going-rate and occupation tables are stored with their date and staleness", async (t) => {
  const dataDir = tempDir(t);
  const first = await runCli(["sponsorship", "refresh"], { dataDir, env: TABLES });
  assert.equal(first.code, 0, first.stdout);
  assert.equal(first.json.refreshed, true);
  assert.equal(first.json.as_of, "2026-01-15");
  assert.equal(first.json.stale, false);
  assert.equal(first.json.occupations, 4);
  assert.equal(first.json.going_rates, 3);
  assert.ok(existsSync(join(dataDir, "cache", "uk-sponsorship-tables.json")));

  // Within a week nothing is downloaded, even with the network down.
  const same = await runCli(["sponsorship", "refresh"], {
    dataDir,
    env: { ...TABLES_DOWN, JOB_BUTLER_NOW: "2026-01-20T09:00:00.000Z" },
  });
  assert.equal(same.json.refreshed, false);
  assert.equal(same.json.stale, false);

  // After a week a failed download keeps the last good copy and marks it stale.
  const down = await runCli(["sponsorship", "refresh"], { dataDir, env: TABLES_DOWN });
  assert.equal(down.code, 0, down.stdout);
  assert.equal(down.json.refreshed, false);
  assert.equal(down.json.stale, true);
  assert.equal(down.json.as_of, "2026-01-15");
  assert.equal(down.json.stale_note, "data may be stale (as of 2026-01-15)");
  assert.equal(down.json.occupations, 4);
});

test("with no tables at all, the role and pay checks are unknown, not a pass", async (t) => {
  const { dataDir, ids } = await run(
    t,
    [{ n: 1, company: "Acme Widgets", title: "Software Engineer", salary: "£90,000 a year" }],
    NO_FLAGS,
    { employers: [ACME], env: TABLES_DOWN },
  );
  const r = await checksOf(dataDir, ids[0] as string);
  assert.equal(r.by("role")?.status, "warn");
  assert.equal(r.verdict.result, "unknown");
});

test("the Profile never stores a date of birth or visa expiry for Sponsorship", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["profile", "put", "--section", "sponsorship", "--input", "-"], {
    dataDir,
    input: { needed: true, regime: "uk-skilled-worker", flags: { date_of_birth: "1999-01-01" } },
  });
  assert.notEqual(r.code, 0);
});
