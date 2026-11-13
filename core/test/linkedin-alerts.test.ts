// LinkedIn job-alert emails become Listings (ticket #51). The alert worker reads the mail
// through the read-only Gmail tools and returns JSON (fixtures/judgments/linkedin-alerts.json,
// recorded from two alert emails); the core turns each job into a LinkedIn Listing with intake
// "alert", matches it like a pasted one, and records the message in the Sync record.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { judgment, NETWORK_FIXTURES, runCli, tempDir } from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const NOW = "2026-11-13T07:00:00.000Z";
const BOARD = { ats: "greenhouse", token: "greenhouse" };
const GREENHOUSE = { name: "Greenhouse", board: BOARD, confirmed_at: "2026-01-15T08:58:00.000Z" };
const EAE = "greenhouse:greenhouse:8279752";
const EAE_LINKEDIN = "linkedin:4012345678";
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON records read back from the CLI
type Rec = Record<string, any>;

const alerts = () => JSON.parse(readFileSync(judgment("linkedin-alerts"), "utf8"));

async function setUp(dataDir: string): Promise<void> {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  profile.filters.target_companies = [GREENHOUSE];
  assert.equal(
    (await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile })).code,
    0,
  );
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
}

async function record(dataDir: string, input: unknown = alerts(), now = NOW) {
  return runCli(["linkedin", "alerts", "record", "--input", "-"], {
    dataDir,
    input,
    env: { JOB_BUTLER_NOW: now, JOB_BUTLER_NETWORK_FIXTURES: NETWORK_FIXTURES },
  });
}

async function listings(dataDir: string): Promise<Map<string, Rec>> {
  const r = await runCli(["record", "list", "listing"], { dataDir });
  return new Map((r.json.records as Rec[]).map((l) => [l.id, l]));
}

async function sync(dataDir: string): Promise<Rec> {
  const r = await runCli(["record", "get", "sync", "gmail"], { dataDir });
  return (r.json.record ?? r.json) as Rec;
}

test("each job in an alert email becomes a LinkedIn Listing with intake alert, matched like a pasted one", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);

  const r = await record(dataDir);

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.alerts_new, 2);
  assert.equal(r.json.alerts_skipped, 0);
  const results = (r.json.listings as Rec[]).map((l) => [l.listing, l.status, l.new_company]);
  assert.deepEqual(results, [
    [EAE_LINKEDIN, "to_confirm", false],
    ["linkedin:4023456789", "unmatched", true],
    ["linkedin:4034567890", "to_confirm", false],
    // The second alert repeats the first job: still one Listing and one question.
    ["linkedin:4045678901", "unmatched", true],
  ]);
  assert.deepEqual(r.json.new_companies, ["Northwind Traders", "Contoso Ltd"]);
  assert.deepEqual(
    (r.json.linkedin_match as Rec[]).map((q) => [
      q.linkedin.id,
      q.candidates.map((c: Rec) => c.id),
    ]),
    [
      [EAE_LINKEDIN, [EAE]],
      ["linkedin:4034567890", ["greenhouse:greenhouse:8227655"]],
    ],
  );

  const all = await listings(dataDir);
  const eae = all.get(EAE_LINKEDIN);
  assert.equal(eae?.source, "linkedin");
  assert.equal(eae?.existence_unverified, true);
  assert.deepEqual(eae?.source_fields, { intake: "alert" });
  assert.equal(eae?.url, "https://www.linkedin.com/jobs/view/4012345678/");
  assert.equal(eae?.description, "");
  assert.equal(eae?.sightings.length, 1);
  assert.equal(all.get("linkedin:4045678901")?.location, null);
  assert.equal(all.get("linkedin:4023456789")?.company, "Northwind Traders");
});

test("the worker's match answers pair an alert Listing with the ATS posting", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const r = await record(dataDir);

  const confirmed = await runCli(
    [
      "linkedin",
      "confirm",
      (r.json.discover_run as Rec).id,
      "--input",
      judgment("linkedin-match-confirmed"),
    ],
    { dataDir, env: { JOB_BUTLER_NOW: NOW } },
  );

  assert.equal(confirmed.code, 0, confirmed.stdout);
  assert.equal((confirmed.json.pairings as Rec[])[0]?.ats.id, EAE);
  const all = await listings(dataDir);
  assert.equal(all.has(EAE_LINKEDIN), false);
  assert.equal(all.get(EAE)?.existence_unverified, false);
});

test("a processed alert is recorded in the Sync record and never read twice", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  await record(dataDir);
  assert.deepEqual((await sync(dataDir)).processed_ids, ["m-alert-1", "m-alert-2"]);
  const before = await listings(dataDir);

  const again = await record(dataDir, alerts(), "2026-11-14T07:00:00.000Z");

  assert.equal(again.code, 0, again.stdout);
  assert.equal(again.json.alerts_new, 0);
  assert.equal(again.json.alerts_skipped, 2);
  assert.deepEqual(again.json.listings, []);
  assert.deepEqual(await listings(dataDir), before);
  assert.deepEqual((await sync(dataDir)).processed_ids, ["m-alert-1", "m-alert-2"]);
});

test("alerts share Track's processed IDs: Track skips them, and alerts skip what Track handled", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  await record(dataDir);
  const msg = (id: string) => ({
    message_id: id,
    thread_id: "t-x",
    from: "hr@somewhere.example",
    subject: "Hello",
    received_at: "2026-11-13T10:00:00.000Z",
    classification: "other_job_mail",
  });

  const tracked = await runCli(["track", "record", "--input", "-"], {
    dataDir,
    input: { messages: [msg("m-alert-1"), msg("m-other")] },
    env: { JOB_BUTLER_NOW: NOW },
  });
  assert.equal(tracked.json.skipped_seen, 1);
  assert.equal(tracked.json.new, 1);

  const input = alerts();
  input.alerts.push({ ...input.alerts[0], message_id: "m-other", jobs: [] });
  const r = await record(dataDir, input);
  assert.equal(r.json.alerts_new, 0);
  assert.equal(r.json.alerts_skipped, 3);
  assert.deepEqual((await sync(dataDir)).processed_ids, ["m-alert-1", "m-alert-2", "m-other"]);
});

test("the alert window starts 30 days back, then a day before the last alert read", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const env = { JOB_BUTLER_NOW: NOW };

  const first = await runCli(["linkedin", "alerts", "window"], { dataDir, env });
  assert.equal(first.code, 0, first.stdout);
  assert.equal(first.json.after, "2026/10/14");
  assert.match(
    first.json.query as string,
    /^after:2026\/10\/14 from:jobalerts-noreply@linkedin\.com$/,
  );
  assert.deepEqual(first.json.processed_ids, []);

  await record(dataDir);
  const later = await runCli(["linkedin", "alerts", "window"], { dataDir, env });
  assert.equal(later.json.after, "2026/11/12");
  assert.deepEqual(later.json.processed_ids, ["m-alert-1", "m-alert-2"]);
  // Reading alerts must not move Track's own window.
  assert.equal((await sync(dataDir)).last_synced_at, null);
});

test("an alert with no jobs is still recorded as processed", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const input = { alerts: [{ ...alerts().alerts[0], jobs: [] }] };

  const r = await record(dataDir, input);

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.alerts_new, 1);
  assert.deepEqual(r.json.listings, []);
  assert.deepEqual((await sync(dataDir)).processed_ids, ["m-alert-1"]);
});

test("a malformed worker reply or a non-LinkedIn link refuses and records nothing", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);

  const noJobs = await record(dataDir, { alerts: [{ message_id: "m-1" }] });
  assert.equal((noJobs.json.error as Rec).code, "ALERT_INVALID");

  const bad = alerts();
  bad.alerts[1].jobs[0].url = "https://example.com/jobs/view/1";
  const notLinkedIn = await record(dataDir, bad);
  assert.equal((notLinkedIn.json.error as Rec).code, "NOT_A_LINKEDIN_URL");

  assert.equal((await listings(dataDir)).size, 0);
  assert.deepEqual((await runCli(["record", "list", "sync"], { dataDir })).json.records, []);
});

test("the alert worker's tools are the read-only Gmail reads the hook allows", async (t) => {
  const text = readFileSync(join(ROOT, "agents/alert-worker.md"), "utf8");
  const tools = (text.match(/^tools:\s*(.+)$/m)?.[1] ?? "").split(",").map((s) => s.trim());
  assert.deepEqual(tools.sort(), [
    "mcp__claude_ai_Gmail__get_message",
    "mcp__claude_ai_Gmail__get_thread",
    "mcp__claude_ai_Gmail__search_threads",
  ]);
  const dataDir = tempDir(t);
  await runCli(["status"], { dataDir });
  for (const tool of tools) {
    const r = await runCli(["hook", "pre-tool-use"], {
      dataDir,
      input: { session_id: "s", tool_name: tool, tool_input: {} },
    });
    assert.equal(JSON.stringify(r.json), "{}", tool);
  }
});
