import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "../..");
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON read back from the CLI
type Rec = Record<string, any>;
const TZ = { TZ: "UTC" };

const BOARDS = [
  {
    name: "Greenhouse",
    careers_url: "https://www.greenhouse.com/careers",
    board: { ats: "greenhouse", token: "greenhouse" },
    confirmed_at: "2026-01-15T08:58:00.000Z",
  },
  {
    name: "Gone Ltd",
    board: { ats: "greenhouse", token: "jb-no-such-board" },
    confirmed_at: "2026-01-15T08:59:00.000Z",
  },
];

async function setUp(dataDir: string, targets: unknown[] = BOARDS): Promise<void> {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  profile.filters.target_companies = targets;
  assert.equal(
    (await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile })).code,
    0,
  );
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
}

async function put(dataDir: string, type: string, id: string, data: unknown) {
  const r = await runCli(["record", "put", type, id, "--input", "-"], { dataDir, input: data });
  assert.equal(r.code, 0, r.stdout);
}

/** The application records Track and Apply leave behind, in the shape the core writes. */
const application = (id: string, status: string, extra: Rec = {}) => ({
  origin: "picked",
  listing: `greenhouse:acme:${id}`,
  company: "Acme",
  title: `Role ${id}`,
  status,
  event_log: [],
  gmail_threads: [],
  answers: [],
  fill_plan: null,
  tailor: null,
  ...extra,
});

/** Listings from the recorded Greenhouse board, screened with the worker's judgments built here. */
async function discoverAndScreen(dataDir: string): Promise<Rec> {
  const found = await runCli(["discover", "boards"], { dataDir });
  assert.equal(found.code, 0, found.stdout);
  const pending = await runCli(["screen", "pending"], { dataDir });
  const base = JSON.parse(readFileSync(judgment("screen-skills-rating"), "utf8")).judgments[0];
  const judgments = (pending.json.listings as Rec[]).map((l) => ({ ...base, listing_id: l.id }));
  const rec = await runCli(["screen", "record", "--input", "-"], { dataDir, input: { judgments } });
  assert.equal(rec.code, 0, rec.stdout);
  return rec.json;
}

const REPLY_SAMPLES: Record<string, string> = {
  why: "why a",
  pick: "pick a",
  approve: "approve 1",
  "show excluded": "show excluded",
  restore: "restore Acme Senior Backend Engineer",
  help: "help",
  link: "link greenhouse:acme:1 app-1",
  dismiss: "dismiss 1",
  assign: "assign m-1 app-1",
  "dismiss-mail": "dismiss-mail m-1",
  alerts: "alerts",
};

test("the digest lists every section the job seeker has to act on", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await discoverAndScreen(dataDir);
  await put(dataDir, "application", "r1", application("1", "ready_to_apply"));
  await put(dataDir, "application", "p1", {
    ...application("2", "paused"),
    pause: { code: "UNMAPPABLE_FIELD", reason: 'Apply can\'t map "Visa".', at: "x" },
  });

  const r = await runCli(["run", "digest"], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  const text = r.json.text as string;
  assert.match(text, /STATUS CHANGES/);
  assert.match(text, /SHORTLIST/);
  assert.match(text, /READY TO APPLY \(1\)[\s\S]*r1: Acme · Role 1/);
  assert.match(text, /PAUSED FORMS \(1\)[\s\S]*Apply can't map "Visa"/);
  assert.match(text, /FAILED SOURCES \(1\)[\s\S]*Gone Ltd/);
  assert.match(text, /Reply: .*why <letter>.*approve <n>/);
  assert.equal((r.json.counts as Rec).failed_sources, 1);
});

test("a quiet digest has no paused forms or failed sources section", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const text = (await runCli(["run", "digest"], { dataDir })).json.text as string;
  assert.doesNotMatch(text, /PAUSED FORMS|FAILED SOURCES/);
  assert.match(text, /READY TO APPLY \(0\)/);
});

test("every documented reply is recognised", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await discoverAndScreen(dataDir);
  const digest = (await runCli(["run", "digest"], { dataDir })).json as Rec;
  const documented = (digest.replies as { reply: string }[]).map((r) => r.reply.split(" ")[0]);
  const skipSecond = new Set(["show"]);
  for (const word of documented) {
    const key = skipSecond.has(word as string) ? "show excluded" : (word as string);
    assert.ok(key in REPLY_SAMPLES, `no sample for documented reply "${word}"`);
  }
  for (const [name, sample] of Object.entries(REPLY_SAMPLES)) {
    const r = await runCli(["run", "reply", "--", sample], { dataDir });
    assert.equal(r.code, 0, `${name}: ${r.stdout}`);
    assert.equal(r.json.recognised, true, `${name} was not recognised: ${r.stdout}`);
  }
});

test("an unknown reply is not recognised and says so", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await runCli(["run", "reply", "--", "frobnicate"], { dataDir });
  assert.equal(r.json.recognised, false);
  assert.match(String(r.json.message), /isn't one of the replies/);
});

test("pick routes letters to the Shortlist-pick Checkpoint with Listing IDs", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await discoverAndScreen(dataDir);
  const shortlist = (await runCli(["screen", "digest"], { dataDir })).json.shortlist as Rec[];
  assert.ok(shortlist.length > 0, "the fixture should shortlist something");

  const r = await runCli(["run", "reply", "--", "pick a"], { dataDir });

  assert.equal(r.json.checkpoint, "shortlist-pick");
  assert.deepEqual(r.json.commands, [["application", "pick", shortlist[0]?.id]]);
  const bad = await runCli(["run", "reply", "--", "pick z"], { dataDir });
  assert.deepEqual(bad.json.commands, []);
});

test("approve routes proposal numbers to the digest-status Checkpoint", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  for (const [i, id] of ["acme-1", "beta-2"].entries()) {
    await put(dataDir, "application", `app-${i + 1}`, {
      ...application(String(i + 1), "submitted"),
      gmail_threads: [i === 0 ? "t-acme-1" : "t-beta-2"],
      listing: id,
    });
  }
  const classification = JSON.parse(readFileSync(judgment("track-classification"), "utf8"));
  assert.equal(
    (await runCli(["track", "record", "--input", "-"], { dataDir, input: classification })).code,
    0,
  );
  const proposals = (await runCli(["track", "digest"], { dataDir })).json.proposals as Rec[];
  assert.ok(proposals.length > 0);

  const r = await runCli(["run", "reply", "--", "approve 1"], { dataDir });

  assert.equal(r.json.checkpoint, "digest-status");
  const first = proposals.find((p) => p.n === 1) as Rec;
  assert.deepEqual(r.json.commands, [
    ["application", "status", first.application_id, first.to, "1"],
  ]);
  const none = await runCli(["run", "reply", "--", "approve 99"], { dataDir });
  assert.deepEqual(none.json.commands, []);
  assert.match(String(none.json.message), /no item 99/);
});

test("a quiet run sends no notification", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, []);
  const r = await runCli(["run", "notify"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.notify, false);
  assert.equal(r.json.message, null);
});

test("a run with something for the job seeker sends one notification saying what", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await put(dataDir, "application", "r1", application("1", "ready_to_apply"));
  const r = await runCli(["run", "notify"], { dataDir });
  assert.equal(r.json.notify, true);
  assert.match(String(r.json.message), /1 application ready to apply/);

  await runCli(["preferences", "set", "notifications.desktop", "false"], { dataDir });
  const off = await runCli(["run", "notify"], { dataDir });
  assert.equal(off.json.notify, false);
  assert.match(String(off.json.reason), /off in Preferences/);
});

test("the schedule does nothing while it is off", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, []);
  const r = await runCli(["schedule", "tick"], { dataDir, env: TZ });
  assert.equal(r.json.action, "off");
  assert.equal(existsSync(join(dataDir, "run.lock")), false);
});

test("a scheduled turn runs Track and Discover + Screen when due, once each", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, []);
  await runCli(["preferences", "set", "schedule.enabled", "true"], { dataDir });
  const at = (iso: string) => ({ ...TZ, JOB_BUTLER_NOW: iso });

  const first = await runCli(["schedule", "tick"], {
    dataDir,
    env: at("2026-01-15T09:00:00.000Z"),
  });
  assert.equal(first.json.action, "run");
  assert.deepEqual(first.json.tasks, ["track", "discover-screen"]);
  await runCli(["run", "end", "--run", String(first.json.run_id)], { dataDir });

  const soon = await runCli(["schedule", "tick"], { dataDir, env: at("2026-01-15T10:00:00.000Z") });
  assert.equal(soon.json.action, "idle");

  const later = await runCli(["schedule", "tick"], {
    dataDir,
    env: at("2026-01-15T11:00:00.000Z"),
  });
  assert.deepEqual(later.json.tasks, ["track"]);
  await runCli(["run", "end", "--run", String(later.json.run_id)], { dataDir });

  const night = await runCli(["schedule", "tick"], {
    dataDir,
    env: at("2026-01-15T22:00:00.000Z"),
  });
  assert.equal(night.json.action, "idle");
  const nextDay = await runCli(["schedule", "tick"], {
    dataDir,
    env: at("2026-01-16T08:00:00.000Z"),
  });
  assert.deepEqual(nextDay.json.tasks, ["track", "discover-screen"]);
});

test("a scheduled turn skips when another session holds the lock, and logs it", async (t: TestContext) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, []);
  await runCli(["preferences", "set", "schedule.enabled", "true"], { dataDir });
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => other.kill());
  const started = await runCli(["run", "start", "discover"], {
    dataDir,
    env: { JOB_BUTLER_SESSION_PID: String(other.pid) },
  });
  assert.equal(started.code, 0, started.stdout);

  const r = await runCli(["schedule", "tick"], { dataDir, env: TZ });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.action, "skipped");
  assert.equal(r.json.log, "skipped: another session was writing");
  assert.match(
    readFileSync(join(dataDir, "schedule.log"), "utf8"),
    /skipped: another session was writing\n$/,
  );
  const held = (await runCli(["run", "status"], { dataDir })).json.run as Rec;
  assert.equal(held.command, "discover");
  // The skipped turn is retried: the same turn runs once the lock is free.
  other.kill();
});

test("every subagent names a model and an effort", () => {
  const files = readdirSync(join(ROOT, "agents")).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const head = readFileSync(join(ROOT, "agents", f), "utf8").split("---")[1] ?? "";
    assert.match(head, /^model: (haiku|sonnet|opus)$/m, `${f} has no model`);
    assert.match(head, /^effort: (low|medium|high)$/m, `${f} has no effort`);
  }
});

test("an end-to-end run over a fixture data directory reaches the digest", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  // Applications Track will match mail to.
  await put(dataDir, "application", "app-1", {
    ...application("101", "submitted"),
    gmail_threads: ["t-acme-1"],
  });
  const runId = (await runCli(["run", "start", "pipeline"], { dataDir })).json.run_id as string;
  assert.ok(runId);

  // Track: the window, then the worker's classified mail.
  const window = await runCli(["track", "window"], { dataDir });
  assert.equal(window.code, 0, window.stdout);
  const classified = JSON.parse(readFileSync(judgment("track-classification"), "utf8"));
  assert.equal(
    (await runCli(["track", "record", "--input", "-"], { dataDir, input: classified })).code,
    0,
  );
  // Discover and Screen: recorded board responses and the worker's ratings.
  await discoverAndScreen(dataDir);

  const digest = await runCli(["run", "digest"], { dataDir });
  const verdict = await runCli(["run", "notify"], { dataDir });
  const end = await runCli(["run", "end", "--run", runId], { dataDir });

  assert.equal(digest.code, 0, digest.stdout);
  const text = digest.json.text as string;
  assert.match(text, /^WHAT NEEDS YOU/);
  assert.match(text, /STATUS CHANGES \(1\)/);
  assert.match(text, /SHORTLIST \(\d+\)/);
  assert.match(text, /FAILED SOURCES \(1\)[\s\S]*Gone Ltd/);
  assert.match(text, /Reply: why <letter>/);
  assert.equal(verdict.json.notify, true);
  assert.equal(end.json.released, true);
});
