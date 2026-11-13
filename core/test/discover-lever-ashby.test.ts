import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

const LEVER = {
  name: "Lever Demo",
  careers_url: "https://jobs.lever.co/leverdemo",
  board: { ats: "lever", token: "leverdemo" },
  confirmed_at: "2026-01-15T08:58:00.000Z",
};
const ASHBY = {
  name: "Ashby",
  careers_url: "https://jobs.ashbyhq.com/Ashby",
  board: { ats: "ashby", token: "Ashby" },
  confirmed_at: "2026-01-15T08:58:00.000Z",
};

/** Setup's complete Profile with the given Target companies, plus Preferences. */
async function setUp(dataDir: string, targetCompanies: unknown[]): Promise<void> {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  profile.filters.target_companies = targetCompanies;
  const p = await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  assert.equal(p.code, 0, p.stdout);
  const prefs = await runCli(["preferences", "init"], { dataDir });
  assert.equal(prefs.code, 0, prefs.stdout);
}

interface Listing {
  id: string;
  source_fields: Record<string, unknown>;
  [field: string]: unknown;
}

interface Source {
  id: string;
  status: string;
  jobs: number | null;
  error: { code: string; message: string } | null;
}

async function discover(dataDir: string): Promise<Source[]> {
  const r = await runCli(["discover", "boards"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  return (r.json.discover_run as { sources: Source[] }).sources;
}

async function listings(dataDir: string): Promise<Listing[]> {
  const r = await runCli(["record", "list", "listing"], { dataDir });
  return r.json.records as Listing[];
}

test("Discover writes one Listing per Lever posting, keyed by board and posting ID", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [LEVER]);

  const sources = await discover(dataDir);

  assert.deepEqual(
    sources.map((s) => [s.id, s.status, s.jobs]),
    [["lever:leverdemo", "ok", 4]],
  );
  const all = await listings(dataDir);
  assert.deepEqual(
    all.map((l) => l.id),
    [
      "lever:leverdemo:1dbf02a6-d434-4e47-8d66-3aba2c17bed1",
      "lever:leverdemo:58db3f8e-b108-47d1-9e6e-87a1712497cd",
      "lever:leverdemo:93db84be-2f79-4264-b521-510409fd0225",
      "lever:leverdemo:ad208490-4052-4f91-a57e-433f2d1e484b",
    ],
  );
  const se = all.find((l) => l.id === "lever:leverdemo:58db3f8e-b108-47d1-9e6e-87a1712497cd");
  assert.equal(se?.source, "lever");
  assert.equal(se?.board, "lever:leverdemo");
  assert.equal(se?.company, "Lever Demo");
  assert.equal(se?.title, "Sales Engineer AH");
  assert.equal(se?.location, "Atlanta, Georgia");
  assert.equal(se?.url, "https://jobs.lever.co/leverdemo/58db3f8e-b108-47d1-9e6e-87a1712497cd");
  assert.deepEqual(se?.departments, ["Business Development"]);
  assert.equal(se?.employment_type, "Regular Full Time (Salary)");
  assert.equal(se?.salary, null);
  assert.equal(se?.posted_at, "2026-09-01T18:45:08.535Z");
  assert.equal(se?.deadline, null);
  assert.equal(se?.source_fields.team, "Special Sales Development");
  assert.equal(se?.source_fields.workplace_type, "remote");
  assert.equal(se?.source_fields.country, "US");
  assert.equal(se?.source_fields.all_locations, "Atlanta, Georgia; Arlington, TX; Boston, MA");
});

test("a Lever Listing's description joins the opening, lists and closing as plain text", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [LEVER]);

  await discover(dataDir);

  const se = (await listings(dataDir)).find(
    (l) => l.id === "lever:leverdemo:58db3f8e-b108-47d1-9e6e-87a1712497cd",
  );
  const description = String(se?.description);
  assert.doesNotMatch(description, /<\/?[a-z][^>]*>/i);
  assert.match(description, /^Welcome to the Demo Job Listing for Lever! /);
  assert.match(
    description,
    /\n\nWhat You'll Do\n\n- Partner with Account Executives to understand customer business objectives, technical requirements, and buying criteria.\n- Lead technical discovery/,
  );
  assert.match(description, /\n\nLever builds modern recruiting software/);
});

test("a Lever salary range is kept as stated, with its parts for later Stages", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [LEVER]);

  await discover(dataDir);

  const all = await listings(dataDir);
  const csm = all.find((l) => l.id === "lever:leverdemo:ad208490-4052-4f91-a57e-433f2d1e484b");
  assert.equal(csm?.salary, "USD 85,000–175,000 per year");
  assert.equal(csm?.source_fields.salary_min, 85000);
  assert.equal(csm?.source_fields.salary_max, 175000);
  assert.equal(csm?.source_fields.salary_currency, "USD");
  assert.equal(csm?.source_fields.salary_interval, "per-year-salary");
  // A posting with no department, team or commitment keeps those empty.
  const bare = all.find((l) => l.id === "lever:leverdemo:93db84be-2f79-4264-b521-510409fd0225");
  assert.deepEqual(bare?.departments, []);
  assert.equal(bare?.employment_type, null);
  assert.equal(bare?.source_fields.team, null);
  assert.equal(bare?.source_fields.salary_min, null);
});

test("Discover writes one Listing per Ashby job, with its pay as the board states it", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [ASHBY]);

  const sources = await discover(dataDir);

  assert.deepEqual(
    sources.map((s) => [s.id, s.status, s.jobs]),
    [["ashby:Ashby", "ok", 3]],
  );
  const all = await listings(dataDir);
  assert.deepEqual(
    all.map((l) => l.id),
    [
      "ashby:Ashby:472eef28-6e52-43b4-9bff-9113522890f5",
      "ashby:Ashby:51061458-3a38-4bea-84f4-7ea0ac3e417f",
      "ashby:Ashby:d573471b-2005-482c-9fbf-d1df9550cb57",
    ],
  );
  const em = all.find((l) => l.id === "ashby:Ashby:d573471b-2005-482c-9fbf-d1df9550cb57");
  assert.equal(em?.source, "ashby");
  assert.equal(em?.company, "Ashby");
  assert.equal(em?.title, "Engineering Manager - UK");
  assert.equal(em?.location, "United Kingdom");
  assert.equal(em?.url, "https://jobs.ashbyhq.com/Ashby/d573471b-2005-482c-9fbf-d1df9550cb57");
  assert.deepEqual(em?.departments, ["Engineering"]);
  assert.equal(em?.employment_type, "FullTime");
  assert.equal(em?.salary, "£150K - £250K");
  assert.equal(em?.posted_at, "2025-04-01T14:39:51.428Z");
  assert.equal(em?.deadline, null);
  assert.equal(em?.source_fields.is_listed, true);
  assert.equal(em?.source_fields.workplace_type, "Remote");
  const description = String(em?.description);
  assert.doesNotMatch(description, /<\/?[a-z][^>]*>/i);
  assert.match(description, /^Hi 👋 I’m Colin, Director of Engineering, Europe\./);
});

test("a missing Lever or Ashby board fails only its own source", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [
    LEVER,
    { ...LEVER, name: "Gone Lever", board: { ats: "lever", token: "jb-no-such-board" } },
    { ...ASHBY, name: "Gone Ashby", board: { ats: "ashby", token: "jb-no-such-board" } },
  ]);

  const sources = await discover(dataDir);

  assert.deepEqual(
    sources.map((s) => [s.id, s.status, s.error?.code ?? null]),
    [
      ["lever:leverdemo", "ok", null],
      ["lever:jb-no-such-board", "failed", "BOARD_NOT_FOUND"],
      ["ashby:jb-no-such-board", "failed", "BOARD_NOT_FOUND"],
    ],
  );
  assert.equal((await listings(dataDir)).length, 4);
});
