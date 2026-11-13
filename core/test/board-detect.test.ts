import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

interface Detected {
  ats: string;
  board: Record<string, string>;
  board_id: string;
  links: number;
  evidence: string[];
}

async function detect(url: string): Promise<{ boards: Detected[]; fetched: boolean }> {
  const r = await runCli(["board", "detect", url]);
  assert.equal(r.code, 0, r.stdout);
  return r.json as unknown as { boards: Detected[]; fetched: boolean };
}

test("a career page linking to Lever postings names the Lever board", async () => {
  const r = await detect("https://www.palantir.com/careers/");

  assert.equal(r.fetched, true);
  assert.deepEqual(
    r.boards.map((b) => [b.board_id, b.board]),
    [["lever:palantir", { ats: "lever", token: "palantir" }]],
  );
  assert.deepEqual(r.boards[0]?.evidence, [
    "https://jobs.lever.co/palantir/61eaa54c-e1b7-4064-afad-f7df3d48d652",
  ]);
});

test("a career page listing Ashby jobs names the Ashby board once, counting its links", async () => {
  const r = await detect("https://www.notion.com/careers");

  assert.deepEqual(
    r.boards.map((b) => [b.board_id, b.board, b.links]),
    [["ashby:notion", { ats: "ashby", token: "notion" }, 2]],
  );
});

test("a career page that loads the Greenhouse Job Board API names the Greenhouse board", async () => {
  const r = await detect("https://careers.duolingo.com/");

  assert.deepEqual(
    r.boards.map((b) => [b.board_id, b.board]),
    [["greenhouse:duolingo", { ats: "greenhouse", token: "duolingo" }]],
  );
});

test("a Greenhouse job link on a career page names its board", async () => {
  const r = await detect("https://example.com/careers");

  assert.deepEqual(
    r.boards.map((b) => b.board),
    [{ ats: "greenhouse", token: "exampleco" }],
  );
});

test("Workday links name the tenant, instance and site, with or without a locale", async () => {
  const r = await detect("https://www.workday.com/en-us/company/careers/overview.html");

  assert.deepEqual(
    r.boards.map((b) => [b.board_id, b.board, b.links]),
    [
      [
        "workday:workday:Workday",
        { ats: "workday", tenant: "workday", instance: "wd5", site: "Workday" },
        2,
      ],
    ],
  );
});

test("a board URL entered directly is recognised without fetching anything", async () => {
  // None of these URLs has a recorded response, so a fetch would refuse.
  const cases: [string, Record<string, string>][] = [
    ["https://job-boards.greenhouse.io/acme/jobs/4012345", { ats: "greenhouse", token: "acme" }],
    ["https://boards.greenhouse.io/acme", { ats: "greenhouse", token: "acme" }],
    ["https://jobs.lever.co/acme/1234/apply", { ats: "lever", token: "acme" }],
    ["https://jobs.eu.lever.co/acme", { ats: "lever", token: "acme", region: "eu" }],
    ["https://jobs.ashbyhq.com/Acme/9f1e/application", { ats: "ashby", token: "Acme" }],
    [
      "https://fabrikam.wd3.myworkdayjobs.com/en-US/External/job/London/Engineer_R-1",
      { ats: "workday", tenant: "fabrikam", instance: "wd3", site: "External" },
    ],
  ];
  for (const [url, board] of cases) {
    const r = await detect(url);
    assert.equal(r.fetched, false, url);
    assert.deepEqual(
      r.boards.map((b) => b.board),
      [board],
      url,
    );
  }
});

test("a career page with no job board link finds nothing, so the board is entered by hand", async () => {
  // Greenhouse's own careers page links to greenhouse.io sign-in and support pages only.
  const r = await detect("https://www.greenhouse.com/careers");

  assert.equal(r.fetched, true);
  assert.deepEqual(r.boards, []);
});

test("a career page that can't be read refuses with a way forward", async () => {
  const r = await runCli(["board", "detect", "https://www.lever.co/careers/"]);

  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.error?.code, "CAREERS_PAGE_UNAVAILABLE");
  assert.match(r.json.error?.message ?? "", /HTTP 403/);
  assert.match(r.json.error?.message ?? "", /board URL/);
});

test("a detected board, once confirmed, is stored on the Target company and read by Discover", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  await runCli(["preferences", "init"], { dataDir });
  const [found] = (await detect("https://jobs.lever.co/leverdemo")).boards;

  const filters = {
    ...profile.filters,
    target_companies: [
      {
        name: "Lever Demo",
        careers_url: "https://jobs.lever.co/leverdemo",
        board: found?.board,
        confirmed_at: "2026-01-15T08:58:00.000Z",
      },
    ],
  };
  const put = await runCli(["profile", "put", "--section", "filters", "--input", "-"], {
    dataDir,
    input: filters,
  });
  assert.equal(put.code, 0, put.stdout);

  const run = await runCli(["discover", "boards"], { dataDir });
  const sources = (run.json.discover_run as { sources: { id: string; status: string }[] }).sources;
  assert.deepEqual(sources, [{ ...sources[0], id: "lever:leverdemo", status: "ok" }]);
});
