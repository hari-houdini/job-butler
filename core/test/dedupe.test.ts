// Dedupe, reposts, similar roles and splitting (ticket #37). Every scenario drives
// `discover boards` against recorded Greenhouse responses. The scenario boards under
// fixtures/network/dedupe-* are the recorded `greenhouse` board with jobs copied under new
// IDs (and, for `greenhouse-uk`, a second board of the same company), so their fields are
// the real API's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, NETWORK_FIXTURES, runCli, tempDir } from "./harness.ts";

const BOARD = { ats: "greenhouse", token: "greenhouse" };
const UK_BOARD = { ats: "greenhouse", token: "greenhouse-uk" };
const company = (name: string, board: unknown) => ({
  name,
  board,
  confirmed_at: "2026-01-15T08:58:00.000Z",
});

/** The main board plus a second board of the same company: one job links back, one is a copy. */
const TWO_BOARDS = join(NETWORK_FIXTURES, "dedupe-two-boards");
/** The main board with a second live "Strategic Consultant I" in London (8300001). */
const SIMILAR_ROLE = join(NETWORK_FIXTURES, "dedupe-similar-role");
/** 8279752 taken down and reposted as 8300002 with a near-identical advert. */
const REPOST = join(NETWORK_FIXTURES, "dedupe-repost");
/** 8279752 taken down; 8300003 has its title and location but a different advert. */
const REWRITTEN = join(NETWORK_FIXTURES, "dedupe-repost-rewritten");
/** The main board with 8279752 taken down. */
const TAKEN_DOWN = join(NETWORK_FIXTURES, "discover-later");

const EAE = "greenhouse:greenhouse:8279752"; // Enterprise Account Executive, London
const SWE = "greenhouse:greenhouse:8204473"; // Senior Software Engineer, Ontario
const SC = "greenhouse:greenhouse:8227655"; // Strategic Consultant I, London
const UK_LINK = "greenhouse:greenhouse-uk:9100001"; // links to SWE's posting
const UK_EAE = "greenhouse:greenhouse-uk:9100002"; // a copy of EAE

async function setUp(dataDir: string, targetCompanies: unknown[]): Promise<void> {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  profile.filters.target_companies = targetCompanies;
  const p = await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  assert.equal(p.code, 0, p.stdout);
  const prefs = await runCli(["preferences", "init"], { dataDir });
  assert.equal(prefs.code, 0, prefs.stdout);
}

interface Alias {
  id: string;
  url: string;
}
interface Sighting {
  discover_run: string;
  alias: string;
  seen_at: string;
  repost?: boolean;
}
interface Listing {
  id: string;
  aliases: Alias[];
  sightings: Sighting[];
  similar_roles?: string[];
  repost_count?: number;
  overrides?: Record<string, unknown>[];
  [field: string]: unknown;
}
interface Candidate {
  listing: { id: string; title: string; description: string };
  other: { id: string; title: string; description: string };
}
interface DiscoverResult {
  discover_run: Record<string, unknown> & { id: string; merges: unknown[]; reposts: unknown[] };
  new: { id: string }[];
  same_job: Candidate[];
}

async function discover(
  dataDir: string,
  now: string,
  fixtures = NETWORK_FIXTURES,
): Promise<DiscoverResult> {
  const r = await runCli(["discover", "boards"], {
    dataDir,
    env: { JOB_BUTLER_NOW: now, JOB_BUTLER_NETWORK_FIXTURES: fixtures },
  });
  assert.equal(r.code, 0, r.stdout);
  return r.json as unknown as DiscoverResult;
}

async function listings(dataDir: string): Promise<Map<string, Listing>> {
  const r = await runCli(["record", "list", "listing"], { dataDir });
  return new Map((r.json.records as Listing[]).map((l) => [l.id, l]));
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("a posting whose link points at a known ATS posting merges into that Listing", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Greenhouse", UK_BOARD)]);

  const run = await discover(dataDir, "2026-11-13T07:00:00.000Z", TWO_BOARDS);

  const all = await listings(dataDir);
  assert.equal(all.has(UK_LINK), false);
  const swe = all.get(SWE);
  assert.deepEqual(ids(swe?.aliases ?? []), [SWE, UK_LINK]);
  assert.deepEqual(
    swe?.sightings.map((s) => s.alias),
    [SWE, UK_LINK],
  );
  assert.equal(swe?.title, "Senior Software Engineer");
  assert.equal(ids(run.new).includes(UK_LINK), false);
  assert.deepEqual(run.discover_run.merges, [
    { listing: SWE, alias: UK_LINK, step: "shared-ats-link", reason: null },
  ]);
});

test("a Listing seen again through any of its aliases gets a Sighting, not a new Listing", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Greenhouse", UK_BOARD)]);
  await discover(dataDir, "2026-11-13T07:00:00.000Z", TWO_BOARDS);

  const second = await discover(dataDir, "2026-11-14T07:00:00.000Z", TWO_BOARDS);

  const swe = (await listings(dataDir)).get(SWE);
  assert.equal(swe?.id, SWE);
  assert.equal(swe?.first_seen_at, "2026-11-13T07:00:00.000Z");
  assert.deepEqual(
    swe?.sightings.map((s) => [s.alias, s.seen_at]),
    [
      [SWE, "2026-11-13T07:00:00.000Z"],
      [UK_LINK, "2026-11-13T07:00:00.000Z"],
      [SWE, "2026-11-14T07:00:00.000Z"],
      [UK_LINK, "2026-11-14T07:00:00.000Z"],
    ],
  );
  assert.deepEqual(ids(swe?.aliases ?? []), [SWE, UK_LINK]);
  assert.deepEqual(second.new, []);
  assert.deepEqual(second.discover_run.merges, []);
});

async function confirm(dataDir: string, runId: string, name: string) {
  const r = await runCli(["discover", "confirm", runId, "--input", judgment(name)], {
    dataDir,
    env: { JOB_BUTLER_NOW: "2026-11-13T07:05:00.000Z" },
  });
  assert.equal(r.code, 0, r.stdout);
  return r.json;
}

async function discoverRun(dataDir: string, id: string) {
  const r = await runCli(["record", "get", "discover-run", id], { dataDir });
  return r.json.record as Record<string, unknown>;
}

test("the same title and location on another board is put to the LLM, not merged", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Greenhouse", UK_BOARD)]);

  const run = await discover(dataDir, "2026-11-13T07:00:00.000Z", TWO_BOARDS);

  assert.deepEqual(
    run.same_job.map((c) => [c.listing.id, c.other.id]),
    [[UK_EAE, EAE]],
  );
  assert.equal(run.same_job[0]?.listing.title, "Enterprise Account Executive");
  assert.match(run.same_job[0]?.other.description ?? "", /^Greenhouse is/);
  const all = await listings(dataDir);
  assert.equal(all.has(UK_EAE), true);
  assert.equal(all.has(EAE), true);
});

test("a confirmed same job merges into the first-seen Listing and shows in the digest", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Greenhouse", UK_BOARD)]);
  const run = await discover(dataDir, "2026-11-13T07:00:00.000Z", TWO_BOARDS);

  const out = await confirm(dataDir, run.discover_run.id, "same-job-confirmed");

  const all = await listings(dataDir);
  assert.equal(all.has(UK_EAE), false);
  const eae = all.get(EAE);
  assert.deepEqual(ids(eae?.aliases ?? []), [EAE, UK_EAE]);
  assert.deepEqual(
    eae?.sightings.map((s) => s.alias),
    [EAE, UK_EAE],
  );
  const merge = {
    listing: EAE,
    alias: UK_EAE,
    step: "same-job",
    reason:
      "Same Enterprise Account Executive role in London; the two adverts are word for word the same.",
  };
  assert.deepEqual(out.merged, [merge]);
  const recorded = await discoverRun(dataDir, run.discover_run.id);
  assert.deepEqual((recorded.merges as unknown[]).at(-1), merge);

  // Next run: the copy is seen through its alias and nothing is asked again.
  const next = await discover(dataDir, "2026-11-14T07:00:00.000Z", TWO_BOARDS);
  assert.deepEqual(next.same_job, []);
  assert.deepEqual(next.new, []);
  assert.equal((await listings(dataDir)).get(EAE)?.sightings.length, 4);
});

test("two jobs the LLM says differ stay two Listings marked similar role", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Greenhouse", UK_BOARD)]);
  const run = await discover(dataDir, "2026-11-13T07:00:00.000Z", TWO_BOARDS);

  await confirm(dataDir, run.discover_run.id, "same-job-different");

  const all = await listings(dataDir);
  assert.deepEqual(all.get(EAE)?.similar_roles, [UK_EAE]);
  assert.deepEqual(all.get(UK_EAE)?.similar_roles, [EAE]);
  const next = await discover(dataDir, "2026-11-14T07:00:00.000Z", TWO_BOARDS);
  assert.deepEqual(next.same_job, []);
});

test("two live postings for the same role on one board stay two Listings marked similar role", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD)]);
  await discover(dataDir, "2026-11-13T07:00:00.000Z");

  const run = await discover(dataDir, "2026-11-14T07:00:00.000Z", SIMILAR_ROLE);

  const second = "greenhouse:greenhouse:8300001";
  const all = await listings(dataDir);
  assert.deepEqual(all.get(SC)?.similar_roles, [second]);
  assert.deepEqual(all.get(second)?.similar_roles, [SC]);
  assert.deepEqual(ids(run.new), [second]);
  assert.deepEqual(run.same_job, []);
  assert.deepEqual(run.discover_run.similar_roles, [[SC, second]]);
});

test("a posting reappearing within 60 days with a near-identical advert is a repost", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD)]);
  await discover(dataDir, "2026-11-13T07:00:00.000Z");
  await discover(dataDir, "2026-11-14T07:00:00.000Z", TAKEN_DOWN);

  const run = await discover(dataDir, "2027-01-13T07:00:00.000Z", REPOST);

  const repost = "greenhouse:greenhouse:8300002";
  const all = await listings(dataDir);
  assert.equal(all.has(repost), false);
  const eae = all.get(EAE);
  assert.equal(eae?.repost_count, 1);
  assert.equal(eae?.gone, false);
  assert.equal(eae?.first_seen_at, "2026-11-13T07:00:00.000Z");
  assert.deepEqual(ids(eae?.aliases ?? []), [EAE, repost]);
  assert.deepEqual(eae?.sightings.at(-1), {
    discover_run: run.discover_run.id,
    alias: repost,
    seen_at: "2027-01-13T07:00:00.000Z",
    repost: true,
  });
  assert.equal(eae?.url, "https://job-boards.greenhouse.io/greenhouse/jobs/8300002?gh_jid=8300002");
  assert.deepEqual(run.new, []);
  assert.deepEqual(run.discover_run.reposts, [{ listing: EAE, alias: repost }]);
});

test("a posting reappearing more than 60 days after it went is a new Listing", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD)]);
  await discover(dataDir, "2026-11-13T07:00:00.000Z");
  await discover(dataDir, "2026-11-14T07:00:00.000Z", TAKEN_DOWN);

  const run = await discover(dataDir, "2027-01-14T07:00:00.000Z", REPOST);

  assert.deepEqual(ids(run.new), ["greenhouse:greenhouse:8300002"]);
  assert.equal((await listings(dataDir)).get(EAE)?.repost_count, 0);
});

test("a reappearing title and location with a rewritten advert isn't a repost", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD)]);
  await discover(dataDir, "2026-11-13T07:00:00.000Z");
  await discover(dataDir, "2026-11-14T07:00:00.000Z", TAKEN_DOWN);

  const run = await discover(dataDir, "2026-11-20T07:00:00.000Z", REWRITTEN);

  assert.deepEqual(ids(run.new), ["greenhouse:greenhouse:8300003"]);
  assert.equal((await listings(dataDir)).get(EAE)?.repost_count, 0);
});

test("a late copy of a Listing with an Application merges as a Sighting only", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD)]);
  await discover(dataDir, "2026-11-13T07:00:00.000Z");
  const app = { listing: EAE, origin: "picked", status: "Picked" };
  await runCli(["record", "put", "application", "app-1", "--input", "-"], { dataDir, input: app });
  const picked = { ...(await listings(dataDir)).get(EAE), shortlist: { picked: true } };
  await runCli(["record", "put", "listing", EAE, "--input", "-"], { dataDir, input: picked });
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Greenhouse", UK_BOARD)]);

  const run = await discover(dataDir, "2026-11-14T07:00:00.000Z", TWO_BOARDS);
  await confirm(dataDir, run.discover_run.id, "same-job-confirmed");

  const all = await listings(dataDir);
  assert.equal(all.has(UK_EAE), false);
  const eae = all.get(EAE);
  assert.deepEqual(ids(eae?.aliases ?? []), [EAE, UK_EAE]);
  assert.deepEqual(eae?.shortlist, { picked: true });
  const apps = await runCli(["record", "list", "application"], { dataDir });
  assert.deepEqual(
    (apps.json.records as { listing: string }[]).map((a) => a.listing),
    [EAE],
  );
});

test("splitting a merged Listing gives the alias its own Listing, never merged again", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Greenhouse", UK_BOARD)]);
  await discover(dataDir, "2026-11-13T07:00:00.000Z", TWO_BOARDS);

  const r = await runCli(["listing", "split", SWE, UK_LINK], {
    dataDir,
    env: { JOB_BUTLER_NOW: "2026-11-13T08:00:00.000Z" },
  });

  assert.equal(r.code, 0, r.stdout);
  const all = await listings(dataDir);
  const swe = all.get(SWE);
  const split = all.get(UK_LINK);
  assert.deepEqual(ids(swe?.aliases ?? []), [SWE]);
  assert.deepEqual(
    swe?.sightings.map((s) => s.alias),
    [SWE],
  );
  assert.deepEqual(ids(split?.aliases ?? []), [UK_LINK]);
  assert.deepEqual(
    split?.sightings.map((s) => s.alias),
    [UK_LINK],
  );
  assert.equal(split?.title, "Senior Software Engineer (Ecosystem)");
  assert.equal(split?.board, "greenhouse:greenhouse-uk");
  assert.equal(split?.first_seen_at, "2026-11-13T07:00:00.000Z");
  assert.deepEqual(swe?.overrides, [
    { kind: "split", into: UK_LINK, alias: UK_LINK, at: "2026-11-13T08:00:00.000Z" },
  ]);
  assert.deepEqual(split?.overrides, [
    { kind: "split", from: SWE, alias: UK_LINK, at: "2026-11-13T08:00:00.000Z" },
  ]);

  const next = await discover(dataDir, "2026-11-14T07:00:00.000Z", TWO_BOARDS);
  const after = await listings(dataDir);
  assert.deepEqual(ids(after.get(SWE)?.aliases ?? []), [SWE]);
  assert.deepEqual(
    after.get(UK_LINK)?.sightings.map((s) => s.seen_at),
    ["2026-11-13T07:00:00.000Z", "2026-11-14T07:00:00.000Z"],
  );
  assert.deepEqual(next.discover_run.merges, []);
});

test("a Listing's own posting can't be split off, and an unknown alias is refused", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Greenhouse", UK_BOARD)]);
  await discover(dataDir, "2026-11-13T07:00:00.000Z", TWO_BOARDS);

  const own = await runCli(["listing", "split", SWE, SWE], { dataDir });
  const unknown = await runCli(["listing", "split", SWE, "lever:acme:x"], { dataDir });

  assert.equal(own.json.error?.code, "SPLIT_OWN_ALIAS");
  assert.equal(unknown.json.error?.code, "ALIAS_NOT_FOUND");
});

test("a judgment in the wrong shape changes nothing", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Greenhouse", UK_BOARD)]);
  const run = await discover(dataDir, "2026-11-13T07:00:00.000Z", TWO_BOARDS);

  const r = await runCli(["discover", "confirm", run.discover_run.id, "--input", "-"], {
    dataDir,
    input: { judgments: [{ listing: UK_EAE, other: EAE, same_job: "yes" }] },
  });

  assert.equal(r.json.error?.code, "JUDGMENT_INVALID");
  assert.equal((await listings(dataDir)).has(UK_EAE), true);
});

test("dedupe stays within a company: the same role at another company is left alone", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [company("Greenhouse", BOARD), company("Other Co", UK_BOARD)]);

  const run = await discover(dataDir, "2026-11-13T07:00:00.000Z", TWO_BOARDS);

  assert.deepEqual(run.same_job, []);
  assert.deepEqual(run.discover_run.merges, []);
  assert.equal((await listings(dataDir)).has(UK_LINK), true);
});
