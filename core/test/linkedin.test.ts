// Pasted LinkedIn Listings matched to the employer's ATS posting (ticket #38). LinkedIn is never
// fetched: the network fixtures refuse any URL they don't list, and no linkedin.com URL is
// listed, so a fetch would fail the command. The Target company's board is the recorded
// `greenhouse` board (Enterprise Account Executive and Strategic Consultant I in London,
// Senior Software Engineer in Ontario).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, NETWORK_FIXTURES, runCli, tempDir } from "./harness.ts";

const BOARD = { ats: "greenhouse", token: "greenhouse" };
const GREENHOUSE = { name: "Greenhouse", board: BOARD, confirmed_at: "2026-01-15T08:58:00.000Z" };
const EAE = "greenhouse:greenhouse:8279752"; // Enterprise Account Executive, London
const NOW = "2026-11-13T07:00:00.000Z";

/** A LinkedIn copy of the board's Enterprise Account Executive advert. */
const EAE_ON_LINKEDIN = {
  company: "Greenhouse Software, Inc.",
  title: "Enterprise Account Executive",
  location: "London, England, United Kingdom",
  url: "https://www.linkedin.com/jobs/view/4012345678/?trackingId=abc%3D%3D&refId=xyz",
  description:
    "About the job. Greenhouse is looking for an Enterprise Account Executive in London to " +
    "own new business with large companies across the UK and Ireland.",
};
const EAE_LINKEDIN_ID = "linkedin:4012345678";

async function setUp(dataDir: string, targetCompanies: unknown[]): Promise<void> {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  profile.filters.target_companies = targetCompanies;
  const p = await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  assert.equal(p.code, 0, p.stdout);
  const prefs = await runCli(["preferences", "init"], { dataDir });
  assert.equal(prefs.code, 0, prefs.stdout);
}

interface Side {
  id: string;
  title: string;
  location: string | null;
}
interface Intake {
  listing: string;
  status: "matched" | "unmatched" | "to_confirm";
  target_company: string | null;
  new_company: boolean;
}
interface AddResult {
  discover_run: Record<string, unknown> & { id: string };
  listings: Intake[];
  linkedin_match: { linkedin: Side & { url: string | null }; candidates: Side[] }[];
  new_companies: string[];
}

async function add(
  dataDir: string,
  jobs: unknown[],
  opts: { now?: string; fixtures?: string } = {},
): Promise<AddResult> {
  const r = await runCli(["linkedin", "add", "--input", "-"], {
    dataDir,
    input: { jobs },
    env: {
      JOB_BUTLER_NOW: opts.now ?? NOW,
      JOB_BUTLER_NETWORK_FIXTURES: opts.fixtures ?? NETWORK_FIXTURES,
    },
  });
  assert.equal(r.code, 0, r.stdout);
  return r.json as unknown as AddResult;
}

async function listings(dataDir: string): Promise<Map<string, Record<string, unknown>>> {
  const r = await runCli(["record", "list", "listing"], { dataDir });
  const records = r.json.records as (Record<string, unknown> & { id: string })[];
  return new Map(records.map((l) => [l.id, l]));
}

const aliasIds = (l: Record<string, unknown> | undefined) =>
  ((l?.aliases as { id: string }[] | undefined) ?? []).map((a) => a.id);

test("a pasted LinkedIn job is paired with its ATS posting once the worker confirms", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);

  const added = await add(dataDir, [EAE_ON_LINKEDIN]);

  assert.deepEqual(added.listings, [
    {
      listing: EAE_LINKEDIN_ID,
      company: "Greenhouse",
      title: "Enterprise Account Executive",
      location: "London, England, United Kingdom",
      status: "to_confirm",
      target_company: "Greenhouse",
      new_company: false,
      pairing: null,
    },
  ]);
  assert.equal(added.linkedin_match.length, 1);
  const match = added.linkedin_match[0];
  assert.equal(match?.linkedin.id, EAE_LINKEDIN_ID);
  assert.equal(match?.linkedin.url, "https://www.linkedin.com/jobs/view/4012345678/");
  assert.deepEqual(
    match?.candidates.map((c) => c.id),
    [EAE],
  );
  // Until confirmed, the LinkedIn Listing is LinkedIn-only.
  const before = await listings(dataDir);
  assert.equal(before.get(EAE_LINKEDIN_ID)?.existence_unverified, true);
  assert.equal(before.get(EAE_LINKEDIN_ID)?.source, "linkedin");

  const confirmed = await runCli(
    ["linkedin", "confirm", added.discover_run.id, "--input", judgment("linkedin-match-confirmed")],
    { dataDir, env: { JOB_BUTLER_NOW: NOW } },
  );
  assert.equal(confirmed.code, 0, confirmed.stdout);
  const reason =
    "Same Enterprise Account Executive role in London; the LinkedIn text is the opening of the board's advert.";
  assert.deepEqual(confirmed.json.matched, [
    { listing: EAE, alias: EAE_LINKEDIN_ID, step: "linkedin-match", reason },
  ]);
  assert.deepEqual(confirmed.json.pairings, [
    {
      listing: EAE,
      linkedin: [{ id: EAE_LINKEDIN_ID, url: "https://www.linkedin.com/jobs/view/4012345678/" }],
      ats: {
        id: EAE,
        source: "greenhouse",
        url: "https://job-boards.greenhouse.io/greenhouse/jobs/8279752?gh_jid=8279752",
      },
      reason,
      existence_unverified: false,
    },
  ]);

  const after = await listings(dataDir);
  assert.equal(after.has(EAE_LINKEDIN_ID), false);
  const eae = after.get(EAE);
  assert.deepEqual(aliasIds(eae), [EAE, EAE_LINKEDIN_ID]);
  assert.equal(eae?.existence_unverified, false);
  assert.equal(eae?.source, "greenhouse");
  const run = (await runCli(["record", "get", "discover-run", added.discover_run.id], { dataDir }))
    .json.record as Record<string, unknown>;
  assert.deepEqual(run.merges, confirmed.json.matched);
  assert.equal(run.intake, "linkedin");

  // Pasting it again is a Sighting on the paired Listing, nothing new to confirm (the board,
  // read again, adds its own).
  const again = await add(dataDir, [EAE_ON_LINKEDIN], { now: "2026-11-14T07:00:00.000Z" });
  assert.equal(again.listings[0]?.status, "matched");
  assert.equal(again.listings[0]?.listing, EAE);
  assert.deepEqual(again.linkedin_match, []);
  const sightings = (await listings(dataDir)).get(EAE)?.sightings as { alias: string }[];
  assert.deepEqual(
    sightings.map((s) => s.alias),
    [EAE, EAE_LINKEDIN_ID, EAE, EAE_LINKEDIN_ID],
  );
});

test("a LinkedIn job with no same-title posting on the board stays LinkedIn-only, existence unverified", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);

  const added = await add(dataDir, [
    {
      company: "Greenhouse",
      title: "Staff Platform Engineer",
      location: "London",
      url: "https://uk.linkedin.com/jobs/view/staff-platform-engineer-at-greenhouse-4099999999",
      description: "Lead our platform team.",
    },
  ]);

  assert.equal(added.listings[0]?.status, "unmatched");
  assert.equal(added.listings[0]?.listing, "linkedin:4099999999");
  assert.equal(added.listings[0]?.new_company, false);
  assert.deepEqual(added.linkedin_match, []);
  const l = (await listings(dataDir)).get("linkedin:4099999999");
  assert.equal(l?.existence_unverified, true);
  assert.equal(l?.url, "https://www.linkedin.com/jobs/view/4099999999/");
  // The board was read (the posting it searched for wasn't on it).
  const sources = added.discover_run.sources as { id: string; status: string }[];
  assert.deepEqual(
    sources.map((s) => [s.id, s.status]),
    [["greenhouse:greenhouse", "ok"]],
  );
});

test("when the worker says none of the candidates is the job, it stays LinkedIn-only and isn't asked again", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);
  const added = await add(dataDir, [EAE_ON_LINKEDIN]);

  const confirmed = await runCli(
    ["linkedin", "confirm", added.discover_run.id, "--input", judgment("linkedin-match-none")],
    { dataDir, env: { JOB_BUTLER_NOW: NOW } },
  );

  assert.equal(confirmed.code, 0, confirmed.stdout);
  assert.deepEqual(confirmed.json.matched, []);
  assert.deepEqual(confirmed.json.unmatched, [EAE_LINKEDIN_ID]);
  const all = await listings(dataDir);
  assert.equal(all.get(EAE_LINKEDIN_ID)?.existence_unverified, true);
  assert.deepEqual(aliasIds(all.get(EAE)), [EAE]);
  const again = await runCli(["linkedin", "match"], { dataDir });
  assert.deepEqual(again.json.linkedin_match, []);
  assert.equal((again.json.listings as Intake[])[0]?.status, "unmatched");
});

test("a LinkedIn job from a company that isn't a Target company asks to add it, and pairs once it is", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, []);

  const added = await add(dataDir, [{ ...EAE_ON_LINKEDIN, company: "Greenhouse" }]);

  assert.equal(added.listings[0]?.status, "unmatched");
  assert.equal(added.listings[0]?.target_company, null);
  assert.equal(added.listings[0]?.new_company, true);
  assert.deepEqual(added.new_companies, ["Greenhouse"]);
  assert.deepEqual(added.discover_run.sources, []);

  // The job seeker adds the company (setup), and the next Discover run reads its board.
  await setUp(dataDir, [GREENHOUSE]);
  const run = await runCli(["discover", "boards"], {
    dataDir,
    env: { JOB_BUTLER_NOW: "2026-11-14T07:00:00.000Z" },
  });
  assert.equal(run.code, 0, run.stdout);
  const match = await runCli(["linkedin", "match"], { dataDir });
  assert.equal(match.code, 0, match.stdout);
  const questions = match.json.linkedin_match as AddResult["linkedin_match"];
  assert.deepEqual(
    questions.map((q) => [q.linkedin.id, q.candidates.map((c) => c.id)]),
    [[EAE_LINKEDIN_ID, [EAE]]],
  );
  assert.equal((match.json.listings as Intake[])[0]?.new_company, false);
});

test("a LinkedIn-only Listing merged by a 'same job?' verdict gives way to the ATS posting", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, []);
  // Seen on LinkedIn first, with the board's exact location, before the company was added.
  await add(dataDir, [
    { ...EAE_ON_LINKEDIN, company: "Greenhouse", location: "London, United Kingdom" },
  ]);
  await setUp(dataDir, [GREENHOUSE]);
  const run = await runCli(["discover", "boards"], {
    dataDir,
    env: { JOB_BUTLER_NOW: "2026-11-14T07:00:00.000Z" },
  });
  const pairs = run.json.same_job as { listing: { id: string }; other: { id: string } }[];
  assert.deepEqual(
    pairs.map((p) => [p.listing.id, p.other.id]),
    [[EAE, EAE_LINKEDIN_ID]],
  );

  const confirmed = await runCli(
    ["discover", "confirm", (run.json.discover_run as { id: string }).id, "--input", "-"],
    {
      dataDir,
      input: {
        judgments: [
          { listing: EAE, other: EAE_LINKEDIN_ID, same_job: true, reason: "Same advert." },
        ],
      },
    },
  );

  assert.equal(confirmed.code, 0, confirmed.stdout);
  const all = await listings(dataDir);
  assert.equal(all.has(EAE_LINKEDIN_ID), false);
  assert.deepEqual(aliasIds(all.get(EAE)), [EAE, EAE_LINKEDIN_ID]);
  assert.equal(all.get(EAE)?.existence_unverified, false);
  assert.equal(all.get(EAE)?.first_seen_at, NOW);
});

test("a LinkedIn job pasted without its link gets a stable ID, so pasting it again finds it", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, []);
  const job = { company: "Northwind Traders Ltd", title: "Data Engineer", location: "Leeds" };

  const first = await add(dataDir, [job]);
  const second = await add(dataDir, [{ ...job, company: "Northwind Traders" }], {
    now: "2026-11-14T07:00:00.000Z",
  });

  const id = first.listings[0]?.listing ?? "";
  assert.match(id, /^linkedin:p-[0-9a-f]{12}$/);
  assert.equal(second.listings[0]?.listing, id);
  const l = (await listings(dataDir)).get(id);
  assert.equal(l?.url, null);
  assert.equal((l?.sightings as unknown[] | undefined)?.length, 2);
});

test("a link that isn't a LinkedIn job is refused and nothing is written", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);

  for (const url of [
    "https://job-boards.greenhouse.io/greenhouse/jobs/8279752",
    "https://www.linkedin.com/jobs/search/?keywords=engineer",
  ]) {
    const r = await runCli(["linkedin", "add", "--input", "-"], {
      dataDir,
      input: { jobs: [{ ...EAE_ON_LINKEDIN, url }] },
    });
    assert.equal(r.code, 1, r.stdout);
    assert.equal(r.json.error?.code, "NOT_A_LINKEDIN_URL");
  }
  assert.equal((await listings(dataDir)).size, 0);
});

test("a Target company board that can't be read leaves the LinkedIn job unmatched and says so", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);

  const added = await add(dataDir, [EAE_ON_LINKEDIN], {
    fixtures: join(NETWORK_FIXTURES, "discover-board-down"),
  });

  assert.equal(added.listings[0]?.status, "unmatched");
  const sources = added.discover_run.sources as { status: string; error: { code: string } }[];
  assert.equal(sources[0]?.status, "failed");
  assert.equal(sources[0]?.error.code, "BOARD_NOT_FOUND");
});
