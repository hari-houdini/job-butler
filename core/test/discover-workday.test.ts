import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, NETWORK_FIXTURES, runCli, tempDir } from "./harness.ts";

/** Workday's own career site (recorded): tenant "workday", instance wd5, site "Workday". */
const WORKDAY = {
  name: "Workday",
  careers_url: "https://workday.wd5.myworkdayjobs.com/Workday",
  board: { ats: "workday", tenant: "workday", instance: "wd5", site: "Workday" },
  confirmed_at: "2026-01-15T08:58:00.000Z",
};
/**
 * The recorded searches: "Senior Backend Engineer" matches 26 jobs (two cxs pages of 20),
 * "Staff Backend Engineer" matches 2 of those same jobs.
 */
const ROLES = ["Senior Backend Engineer", "Staff Backend Engineer"];

/** cxs answering the jobs search with JSON of another shape (its job-detail response). */
const CXS_CHANGED = join(NETWORK_FIXTURES, "discover-workday-changed");
/** cxs lists a job whose page has no JSON-LD JobPosting. */
const NO_JSON_LD = join(NETWORK_FIXTURES, "discover-workday-no-jsonld");

const BASE = "workday:workday:Workday";

async function setUp(dataDir: string, roles: string[]): Promise<void> {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  profile.filters.target_companies = [WORKDAY];
  profile.targets.roles = roles;
  const p = await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  assert.equal(p.code, 0, p.stdout);
  const prefs = await runCli(["preferences", "init"], { dataDir });
  assert.equal(prefs.code, 0, prefs.stdout);
}

interface Source {
  id: string;
  status: string;
  jobs: number | null;
  error: { code: string; message: string } | null;
}

async function discover(
  dataDir: string,
  env: Record<string, string> = {},
): Promise<{ sources: Source[]; gone_listings: string[] }> {
  const r = await runCli(["discover", "boards"], { dataDir, env });
  assert.equal(r.code, 0, r.stdout);
  return r.json.discover_run as { sources: Source[]; gone_listings: string[] };
}

async function listings(dataDir: string): Promise<Record<string, unknown>[]> {
  const r = await runCli(["record", "list", "listing"], { dataDir });
  return r.json.records as Record<string, unknown>[];
}

test("Workday boards are searched through cxs with each target role, every page read", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, ROLES);

  const run = await discover(dataDir);

  assert.deepEqual(run.sources[0], {
    id: BASE,
    ats: "workday",
    company: "Workday",
    status: "ok",
    jobs: 26,
    error: null,
  });
  const ids = (await listings(dataDir)).map((l) => l.id);
  assert.equal(ids.length, 26);
  assert.equal(new Set(ids).size, 26);
  // On the second cxs page of "Senior Backend Engineer".
  assert.ok(ids.includes(`${BASE}:JR-0111129`), "a job from the second page");
  // Found by both searches, kept once.
  assert.ok(ids.includes(`${BASE}:JR-0110344`));
});

test("a Workday Listing's details come from the job page's JSON-LD JobPosting", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, ["Staff Backend Engineer"]);

  await discover(dataDir);

  const all = await listings(dataDir);
  assert.deepEqual(
    all.map((l) => l.id),
    [`${BASE}:JR-0110317`, `${BASE}:JR-0110344`],
  );
  const vndly = all[0] ?? {};
  assert.equal(vndly.source, "workday");
  assert.equal(vndly.board, BASE);
  assert.equal(vndly.company, "Workday");
  assert.equal(vndly.source_job_id, "JR-0110317");
  assert.equal(vndly.title, "Sr Software Development Engineer VNDLY");
  assert.equal(vndly.location, "USA, OH, Mason");
  assert.equal(
    vndly.url,
    "https://workday.wd5.myworkdayjobs.com/Workday/job/USA-OH-Mason/Sr-Software-Development-Engineer-VNDLY_JR-0110317",
  );
  assert.equal(vndly.employment_type, "OTHER");
  assert.equal(vndly.posted_at, "2026-09-29T00:00:00.000Z");
  assert.equal(vndly.deadline, "2027-01-20T00:00:00.000Z");
  assert.equal(vndly.salary, null);
  assert.deepEqual(vndly.departments, []);
  assert.deepEqual(vndly.source_fields, {
    hiring_organization: "Canada Workday ULC",
    external_path: "/job/USA-OH-Mason/Sr-Software-Development-Engineer-VNDLY_JR-0110317",
    locations_text: "2 Locations",
    posted_on: "Posted 30+ Days Ago",
    remote_type: "Flex",
    job_location_type: "TELECOMMUTE",
  });
  const description = String(vndly.description);
  assert.match(description, /^Your work days are brighter here\. /);
  assert.doesNotMatch(description, /<\/?[a-z][^>]*>/i);

  const pune = all[1] ?? {};
  assert.equal(pune.location, "IND.Pune");
  assert.equal(pune.deadline, null);
});

test("cxs answering in a changed shape fails the Workday source loudly", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, ["Staff Backend Engineer"]);
  await discover(dataDir, { JOB_BUTLER_NOW: "2026-11-13T07:00:00.000Z" });

  const run = await discover(dataDir, {
    JOB_BUTLER_NOW: "2026-11-14T07:00:00.000Z",
    JOB_BUTLER_NETWORK_FIXTURES: CXS_CHANGED,
  });

  const [source] = run.sources;
  assert.equal(source?.status, "failed");
  assert.equal(source?.jobs, null);
  assert.equal(source?.error?.code, "BOARD_CHANGED_SHAPE");
  assert.match(source?.error?.message ?? "", /Workday board "workday\/Workday"/);
  assert.match(source?.error?.message ?? "", /no jobPostings/);
  // A failed board marks nothing gone.
  assert.deepEqual(run.gone_listings, []);
  for (const l of await listings(dataDir)) assert.equal(l.gone, false, String(l.id));
});

test("a Workday job page with no JSON-LD JobPosting fails the source", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, ["Staff Backend Engineer"]);

  const run = await discover(dataDir, { JOB_BUTLER_NETWORK_FIXTURES: NO_JSON_LD });

  const [source] = run.sources;
  assert.equal(source?.status, "failed");
  assert.equal(source?.error?.code, "BOARD_CHANGED_SHAPE");
  assert.match(source?.error?.message ?? "", /JSON-LD JobPosting/);
  assert.match(source?.error?.message ?? "", /JR-0110344/);
  assert.deepEqual(await listings(dataDir), []);
});
