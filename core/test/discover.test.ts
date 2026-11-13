import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, NETWORK_FIXTURES, runCli, tempDir } from "./harness.ts";

const GREENHOUSE = {
  name: "Greenhouse",
  careers_url: "https://www.greenhouse.com/careers",
  board: { ats: "greenhouse", token: "greenhouse" },
  confirmed_at: "2026-01-15T08:58:00.000Z",
};
/** A board token the Job Board API answers with 404 (recorded). */
const MISSING_BOARD = {
  name: "Gone Ltd",
  board: { ats: "greenhouse", token: "jb-no-such-board" },
  confirmed_at: "2026-01-15T08:58:00.000Z",
};
/** A Workday site cxs answers with 404 (recorded). */
const MISSING_WORKDAY_SITE = {
  name: "Workday",
  board: { ats: "workday", tenant: "workday", instance: "wd5", site: "NoSuchSite" },
  confirmed_at: "2026-01-15T08:59:00.000Z",
};

/** A later Discover run's view of the boards: one Greenhouse job has been taken down. */
const LATER_BOARDS = join(NETWORK_FIXTURES, "discover-later");
/** The Greenhouse board answering with an error (the recorded 404) for one run. */
const BOARD_DOWN = join(NETWORK_FIXTURES, "discover-board-down");

/** Setup's complete Profile with the given Target companies, plus Preferences. */
async function setUp(dataDir: string, targetCompanies: unknown[]): Promise<void> {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  profile.filters.target_companies = targetCompanies;
  const p = await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  assert.equal(p.code, 0, p.stdout);
  const prefs = await runCli(["preferences", "init"], { dataDir });
  assert.equal(prefs.code, 0, prefs.stdout);
}

/** The fields these tests read; the CLI prints the whole record. */
interface Listing {
  id: string;
  sightings: unknown[];
  source_fields: Record<string, unknown>;
  [field: string]: unknown;
}

interface DiscoverRun {
  id: string;
  sources: {
    id: string;
    company: string;
    status: string;
    jobs: number | null;
    error: { code: string; message: string } | null;
  }[];
  [field: string]: unknown;
}

/** Run `discover boards` as the Discover Stage skill does; returns the Discover run. */
async function discover(dataDir: string, env: Record<string, string> = {}): Promise<DiscoverRun> {
  const r = await runCli(["discover", "boards"], { dataDir, env });
  assert.equal(r.code, 0, r.stdout);
  return r.json.discover_run as DiscoverRun;
}

async function listings(dataDir: string): Promise<Listing[]> {
  const r = await runCli(["record", "list", "listing"], { dataDir });
  return r.json.records as Listing[];
}

async function discoverRuns(dataDir: string): Promise<DiscoverRun[]> {
  const r = await runCli(["record", "list", "discover-run"], { dataDir });
  return r.json.records as DiscoverRun[];
}

test("Discover writes one Listing per Greenhouse job, keyed by source and job ID", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);

  await discover(dataDir);

  const all = await listings(dataDir);
  assert.deepEqual(
    all.map((l) => l.id),
    [
      "greenhouse:greenhouse:8204473",
      "greenhouse:greenhouse:8227655",
      "greenhouse:greenhouse:8279752",
    ],
  );
  const swe = all.find((l) => l.id === "greenhouse:greenhouse:8204473");
  assert.equal(swe?.source, "greenhouse");
  assert.equal(swe?.source_job_id, "8204473");
  assert.equal(swe?.company, "Greenhouse");
  assert.equal(swe?.title, "Senior Software Engineer");
  assert.equal(swe?.location, "Ontario");
  assert.equal(swe?.url, "https://job-boards.greenhouse.io/greenhouse/jobs/8204473?gh_jid=8204473");
  assert.deepEqual(swe?.departments, ["Ecosystem"]);
  assert.equal(swe?.posted_at, "2026-09-15T20:45:18.000Z");
  assert.equal(swe?.source_fields.internal_job_id, 3547866);
});

test("Discover names its new Listings so the skill can report them in one call", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);

  const first = await runCli(["discover", "boards"], { dataDir });
  const second = await runCli(["discover", "boards"], { dataDir });

  assert.deepEqual((first.json.new as unknown[])[1], {
    id: "greenhouse:greenhouse:8204473",
    company: "Greenhouse",
    title: "Senior Software Engineer",
    location: "Ontario",
  });
  assert.equal((first.json.new as unknown[]).length, 3);
  assert.deepEqual(second.json.new, []);
});

test("a Listing's description is plain text, never HTML", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);

  await discover(dataDir);

  const swe = (await listings(dataDir)).find((l) => l.id === "greenhouse:greenhouse:8204473");
  const description = String(swe?.description);
  assert.doesNotMatch(description, /<\/?[a-z][^>]*>/i);
  assert.doesNotMatch(description, /&(lt|gt|amp|quot|nbsp|#\d+);/);
  assert.match(description, /^Greenhouse is the first Orchestrated Hiring Ecosystem: /);
  assert.match(description, /\n\nWho will love this job\n\n- A mentor – you’re passionate/);
  assert.match(description, /team’s collective success\n- A doer/);
});

test("each Listing records its first-seen date and one Sighting per Discover run", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);

  const first = await discover(dataDir, { JOB_BUTLER_NOW: "2026-11-13T07:00:00.000Z" });
  const second = await discover(dataDir, { JOB_BUTLER_NOW: "2026-11-14T07:00:00.000Z" });

  const firstRun = first.id;
  const secondRun = second.id;
  const swe = (await listings(dataDir)).find((l) => l.id === "greenhouse:greenhouse:8204473");
  assert.equal(swe?.first_seen_at, "2026-11-13T07:00:00.000Z");
  assert.equal(swe?.last_seen_at, "2026-11-14T07:00:00.000Z");
  assert.deepEqual(swe?.sightings, [
    {
      discover_run: firstRun,
      alias: "greenhouse:greenhouse:8204473",
      seen_at: "2026-11-13T07:00:00.000Z",
    },
    {
      discover_run: secondRun,
      alias: "greenhouse:greenhouse:8204473",
      seen_at: "2026-11-14T07:00:00.000Z",
    },
  ]);
  const runs = await discoverRuns(dataDir);
  assert.deepEqual(runs.map((r) => r.id).sort(), [firstRun, secondRun].sort());
});

test("a Discover run records when it ran, the sources searched and the ones that failed", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE, MISSING_BOARD, MISSING_WORKDAY_SITE]);
  const started = await runCli(["run", "start", "discover"], { dataDir });

  await discover(dataDir, { JOB_BUTLER_NOW: "2026-11-13T07:00:00.000Z" });

  const [run] = await discoverRuns(dataDir);
  assert.equal(run?.started_at, "2026-11-13T07:00:00.000Z");
  assert.equal(run?.finished_at, "2026-11-13T07:00:00.000Z");
  assert.equal(run?.run_id, started.json.run_id);
  const sources = run?.sources ?? [];
  assert.deepEqual(
    sources.map((s) => [s.id, s.company, s.status, s.jobs]),
    [
      ["greenhouse:greenhouse", "Greenhouse", "ok", 3],
      ["greenhouse:jb-no-such-board", "Gone Ltd", "failed", null],
      ["workday:workday:NoSuchSite", "Workday", "failed", null],
    ],
  );
  assert.equal(sources[0]?.error, null);
  assert.equal(sources[1]?.error?.code, "BOARD_NOT_FOUND");
  assert.match(sources[1]?.error?.message ?? "", /jb-no-such-board.*404/);
  assert.equal(sources[2]?.error?.code, "BOARD_NOT_FOUND");
  assert.match(sources[2]?.error?.message ?? "", /Workday board "workday\/NoSuchSite".*404/);
  assert.equal((await listings(dataDir)).length, 3);
});

test("a Listing missing from its board in the latest Discover run is marked gone", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);
  await discover(dataDir, { JOB_BUTLER_NOW: "2026-11-13T07:00:00.000Z" });

  const later = await discover(dataDir, {
    JOB_BUTLER_NOW: "2026-11-14T07:00:00.000Z",
    JOB_BUTLER_NETWORK_FIXTURES: LATER_BOARDS,
  });

  const byId = new Map((await listings(dataDir)).map((l) => [l.id, l]));
  const taken = byId.get("greenhouse:greenhouse:8279752");
  assert.equal(taken?.gone, true);
  assert.equal(taken?.gone_at, "2026-11-14T07:00:00.000Z");
  assert.equal(taken?.sightings.length, 1);
  assert.equal(byId.get("greenhouse:greenhouse:8204473")?.gone, false);
  assert.deepEqual(later.gone_listings, ["greenhouse:greenhouse:8279752"]);
  assert.deepEqual(later.new_listings, []);

  await discover(dataDir, { JOB_BUTLER_NOW: "2026-11-15T07:00:00.000Z" });
  const back = (await listings(dataDir)).find((l) => l.id === "greenhouse:greenhouse:8279752");
  assert.equal(back?.gone, false);
  assert.equal(back?.gone_at, null);
  assert.equal(back?.first_seen_at, "2026-11-13T07:00:00.000Z");
});

test("a board that fails to load doesn't mark its Listings gone", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);
  await discover(dataDir, { JOB_BUTLER_NOW: "2026-11-13T07:00:00.000Z" });

  const down = await discover(dataDir, {
    JOB_BUTLER_NOW: "2026-11-14T07:00:00.000Z",
    JOB_BUTLER_NETWORK_FIXTURES: BOARD_DOWN,
  });

  assert.equal(down.sources[0]?.status, "failed");
  assert.deepEqual(down.gone_listings, []);
  for (const l of await listings(dataDir)) assert.equal(l.gone, false, l.id);
});

test("Discover's writes need no Approval", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir, [GREENHOUSE]);
  const command = 'node "/plugins/job-butler/core/src/cli.ts" discover boards';
  const hook = () =>
    runCli(["hook", "pre-tool-use"], {
      dataDir,
      input: {
        session_id: "session-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      },
    });

  await hook(); // the first core call marks the session as a Job Butler one
  const r = await hook();

  const out = r.json.hookSpecificOutput as Record<string, string> | undefined;
  assert.notEqual(out?.permissionDecision, "deny", out?.permissionDecisionReason);
  await discover(dataDir);
  const approvals = await runCli(["approval", "list", "--session", "session-1"], { dataDir });
  assert.deepEqual(approvals.json.approvals, []);
});
