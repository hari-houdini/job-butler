import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempDir } from "./harness.ts";

/** A screened Listing in the shape Discover and Screen write (core-conventions.md). */
function listing(jobId: string, title: string, extra: Record<string, unknown> = {}) {
  const id = `greenhouse:acme:${jobId}`;
  return {
    id,
    body: {
      source: "greenhouse",
      board: "greenhouse:acme",
      company: "Acme",
      source_job_id: jobId,
      title,
      location: "London",
      url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}`,
      description: `${title} at Acme.`,
      aliases: [{ id, url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}` }],
      sightings: [],
      first_seen_at: "2026-01-14T07:00:00.000Z",
      last_seen_at: "2026-01-14T07:00:00.000Z",
      gone: false,
      gone_at: null,
      decision_tree: `decision-trees/${encodeURIComponent(id)}.mmd`,
      ...extra,
    },
  };
}

function check(
  name: string,
  status: "pass" | "warn" | "fail" | "not_reached",
  extra: Record<string, unknown> = {},
) {
  return {
    check: `step.${name.toLowerCase().replace(/\W+/g, "_")}`,
    name,
    rule: `${name} rule`,
    result: status === "not_reached" ? "not reached" : status,
    status,
    effect: null,
    citation: `${name} citation`,
    evidence: [`${name} evidence line`],
    label: null,
    ...extra,
  };
}

function screen(outcome: "shortlist" | "excluded", checks: unknown[], extra = {}) {
  return {
    screened_at: "2026-01-14T08:00:00.000Z",
    run_id: null,
    outcome,
    excluded_by: null,
    checks,
    flags: [],
    badges: [],
    rescore_requested_at: null,
    ...extra,
  };
}

const FIT = (score: number, band: string) => ({ score, band });

const SHORT_A = listing("101", "Senior Backend Engineer", {
  screen: screen("shortlist", [check("Scam gate", "pass"), check("Fit score", "pass")], {
    fit: FIT(86, "strong"),
  }),
});
const SHORT_B = listing("102", "Platform Engineer", {
  screen: screen("shortlist", [check("Scam gate", "pass"), check("Ghost score", "warn")], {
    fit: FIT(61, "partial"),
    flags: [{ check: "step.ghost_score", label: "ghost: high" }],
  }),
});
const EXCLUDED = listing("103", "Crypto Wizard", {
  screen: screen(
    "excluded",
    [
      check("Scam gate", "fail", { effect: "exclude", evidence: ["asks for a fee upfront"] }),
      check("Fit score", "not_reached"),
    ],
    { excluded_by: "step.scam_gate" },
  ),
});
const PAUSED = listing("104", "Backend Engineer II", {
  application_id: "app-paused",
  screen: screen("shortlist", [check("Scam gate", "pass")], { fit: FIT(77, "partial") }),
});
const HANDOVER = listing("105", "Staff Engineer", {
  application_id: "app-handover",
  screen: screen("shortlist", [check("Scam gate", "pass")], { fit: FIT(81, "strong") }),
});

function application(
  id: string,
  listingId: string | null,
  title: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    body: {
      origin: listingId === null ? "external" : "picked",
      listing: listingId,
      company: "Acme",
      title,
      status,
      event_log: [
        {
          at: "2026-01-14T09:00:00.000Z",
          stage: "screen",
          from: null,
          to: "picked",
          reason: "Picked from the Shortlist (Fit 80 strong).",
          approval: {
            id: "ap-1",
            checkpoint: "shortlist-pick",
            approved_at: "2026-01-14T08:59:00.000Z",
            action: `application pick ${listingId}`,
          },
        },
      ],
      gmail_threads: [],
      answers: [],
      ...extra,
    },
  };
}

const APPS = [
  application("app-paused", PAUSED.id, "Backend Engineer II", "paused", {
    pause: { field: "Right to work: visa expiry date" },
  }),
  application("app-handover", HANDOVER.id, "Staff Engineer", "handover"),
  application("app-ext", null, "Data Engineer", "submitted"),
  application("app-change", null, "Analyst", "submitted", {
    pending_change: { to: "interview", reason: "Invite matched by thread" },
  }),
];

const DISCOVER_RUN = {
  id: "run-1",
  body: {
    started_at: "2026-01-15T08:00:00.000Z",
    finished_at: "2026-01-15T08:02:00.000Z",
    run_id: null,
    sources: [
      {
        id: "greenhouse:acme",
        ats: "greenhouse",
        company: "Acme",
        status: "ok",
        jobs: 3,
        error: null,
      },
      {
        id: "workday:adatum:ext",
        ats: "workday",
        company: "Adatum",
        status: "failed",
        jobs: 0,
        error: {
          code: "BOARD_CHANGED_SHAPE",
          message: "Adatum's board answered with an unexpected shape.",
        },
      },
    ],
    new_listings: [],
    gone_listings: [],
    listings_seen: 3,
  },
};

async function put(dataDir: string, type: string, rec: { id: string; body: unknown }) {
  const r = await runCli(["record", "put", type, rec.id, "--input", "-"], {
    dataDir,
    input: rec.body,
  });
  assert.equal(r.code, 0, r.stdout);
}

async function seed(dataDir: string) {
  for (const l of [SHORT_A, SHORT_B, EXCLUDED, PAUSED, HANDOVER]) await put(dataDir, "listing", l);
  for (const a of APPS) await put(dataDir, "application", a);
  await put(dataDir, "discover-run", DISCOVER_RUN);
}

/** Run `view` (without opening a browser) and return the page text. */
async function page(dataDir: string): Promise<string> {
  const r = await runCli(["view", "build"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  return readFileSync(String(r.json.path), "utf8");
}

/** The HTML of one tab panel. */
function panel(html: string, tab: string): string {
  const m = html.match(new RegExp(`<section[^>]*id="tab-${tab}"[^>]*>([\\s\\S]*?)</section>`));
  assert.ok(m, `no ${tab} tab panel`);
  return m[1] as string;
}

test("view writes a page with Needs you, Board and Listings tabs, Needs you first", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir);

  const r = await runCli(["view", "build"], { dataDir });
  const html = readFileSync(String(r.json.path), "utf8");

  assert.equal(r.json.path, join(dataDir, "view", "index.html"));
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["Needs you", "Board", "Listings"]);
  assert.match(html, /<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>Needs you</);
});

test("Needs you lists the Shortlist pick, paused Apply, Handover, digest changes and failed sources", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir);

  const needs = panel(await page(dataDir), "needs");

  // Shortlist pick: ranked, lettered, each with its reply.
  assert.match(needs, /Shortlist pick/);
  assert.ok(needs.indexOf("Senior Backend Engineer") < needs.indexOf("Platform Engineer"));
  assert.match(needs, /data-copy="pick a"/);
  assert.match(needs, /data-copy="pick b"/);
  assert.match(needs, /ghost: high/);
  // Paused Apply names the field; Handover; digest change; failed source.
  assert.match(needs, /Apply paused[\s\S]*Right to work: visa expiry date/);
  assert.match(needs, /Handover[\s\S]*Staff Engineer/);
  assert.match(needs, /Invite matched by thread/);
  assert.match(needs, /data-copy="approve \d+"/);
  assert.match(needs, /Adatum[\s\S]*unexpected shape/);
  // Order: pick, paused, handover, digest changes, failed sources.
  const order = ["Shortlist pick", "Apply paused", "Handover", "Digest", "Source failed"].map((s) =>
    needs.indexOf(s),
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.ok(order.every((i) => i >= 0));
});

test("Excluded is collapsed and gives the reason and a restore reply", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir);

  const needs = panel(await page(dataDir), "needs");

  const m = needs.match(
    /<details(?![^>]*\bopen\b)[^>]*>\s*<summary>Excluded \(1\)<\/summary>([\s\S]*?)<\/details>/,
  );
  assert.ok(m, "Excluded is a closed details element");
  assert.match(m[1] as string, /Crypto Wizard/);
  assert.match(m[1] as string, /asks for a fee upfront/);
  assert.match(m[1] as string, /data-copy="restore Acme Crypto Wizard"/);
});

test("Board has one column per Status and badges External applications", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir);

  const board = panel(await page(dataDir), "board");

  const columns = [...board.matchAll(/<h3[^>]*>([^<]*)<span/g)].map((m) => (m[1] as string).trim());
  assert.deepEqual(columns, [
    "Picked",
    "Tailored",
    "Ready to apply",
    "Paused",
    "Handover",
    "Submitted",
    "Interview",
    "Rejected",
    "Offer",
    "Withdrawn",
    "No response",
  ]);
  const submitted = board.match(
    /data-status="submitted"[\s\S]*?<\/div>\s*<\/div>\s*(?=<div class="col"|$)/,
  );
  assert.ok(submitted);
  assert.match(submitted[0], /Data Engineer[\s\S]*External/);
  assert.doesNotMatch(
    board.match(/data-status="paused"[\s\S]*?(?=data-status="handover")/)?.[0] ?? "",
    /External/,
  );
});

test("Listings shows fit, flags, a clickable Decision tree with evidence, the Event log and the key", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir);

  const listings = panel(await page(dataDir), "listings");

  const detail = listings.match(
    /<article[^>]*data-listing="greenhouse:acme:102"[^>]*>([\s\S]*?)<\/article>/,
  );
  assert.ok(detail, "a detail for the flagged Listing");
  const d = detail[1] as string;
  assert.match(d, /Fit 61/);
  assert.match(d, /ghost: high/);
  assert.match(d, /Ghost score evidence line/);
  // Mermaid source with a click handler on a check node.
  assert.match(d, /flowchart TD/);
  assert.match(d, /click c_step_ghost_score call jbNode\(/);
  // The Event log on a picked Listing.
  const picked = listings.match(
    /<article[^>]*data-listing="greenhouse:acme:104"[^>]*>([\s\S]*?)<\/article>/,
  );
  assert.match(picked?.[1] ?? "", /Event log[\s\S]*Picked from the Shortlist[\s\S]*shortlist-pick/);
  // The same marks as the terminal, and the colour key.
  assert.match(d, /✓[\s\S]*Scam gate/);
  assert.match(listings, /✗/);
  assert.match(listings, /·<\/span> <b>Fit score/);
  for (const word of ["Passed", "Warning", "Failed", "Not reached", "Your Approval", "Outcome"]) {
    assert.match(listings, new RegExp(word));
  }
});

test("the page references no external URL and bundles Mermaid beside it", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir);

  const r = await runCli(["view", "build"], { dataDir });
  const html = readFileSync(String(r.json.path), "utf8");

  assert.doesNotMatch(html, /\b(?:src|href|action|poster|data)\s*=\s*["'](?:https?:)?\/\//i);
  assert.doesNotMatch(html, /url\(\s*["']?(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /@import|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|<iframe/);
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["mermaid.min.js"]);
  assert.ok(existsSync(join(dataDir, "view", "mermaid.min.js")));
  assert.match(
    readFileSync(join(dataDir, "view", "mermaid.min.js"), "utf8").slice(0, 2000),
    /mermaid/i,
  );
});

test("every pipeline write regenerates the page, and leaves the lock free", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir);
  await page(dataDir);

  await put(
    dataDir,
    "listing",
    listing("201", "Brand New Role", {
      screen: screen("shortlist", [check("Fit score", "pass")], { fit: FIT(90, "strong") }),
    }),
  );

  const html = readFileSync(join(dataDir, "view", "index.html"), "utf8");
  assert.match(html, /Brand New Role/);
  assert.ok(!existsSync(join(dataDir, "pipeline.lock")));
});

test("view opens the page with the platform opener", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir);
  const log = join(tempDir(t), "opened.txt");
  const opener = join(tempDir(t), "opener");
  writeFileSync(opener, `#!/bin/sh\necho "$1" > "${log}"\n`);
  chmodSync(opener, 0o755);

  const r = await runCli(["view"], { dataDir, env: { JOB_BUTLER_OPENER: opener } });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.opened, true);
  assert.equal(readFileSync(log, "utf8").trim(), join(dataDir, "view", "index.html"));
});

test("a view that cannot be written never fails the pipeline write", async (t) => {
  const dataDir = tempDir(t);
  await seed(dataDir);
  rmSync(join(dataDir, "view"), { recursive: true, force: true });
  writeFileSync(join(dataDir, "view"), "in the way");

  const r = await runCli(["record", "put", "listing", "x:y:1", "--input", "-"], {
    dataDir,
    input: { company: "Z", title: "Z" },
  });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.ok(!existsSync(join(dataDir, "pipeline.lock")));
});
