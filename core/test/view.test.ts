import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempDir } from "./harness.ts";
import { check, FIT, listing, put, screen, seed, seedHostile } from "./view-fixture.ts";

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

test("hostile text in every field that reaches the decision tree stays text in the page", async (t) => {
  const dataDir = tempDir(t);
  await seedHostile(dataDir);

  const html = await page(dataDir);

  // No markup from the hostile text survives unescaped, in the page or in the tree source.
  assert.doesNotMatch(html, /<img\b/i);
  // Shown as text: HTML-escaped where the page prints it, entity-coded inside the Mermaid source.
  assert.match(html, /&lt;img src=x onerror=&quot;window\.jbPwned=1&quot;&gt;/);
  // The check's evidence is listed as text in the Listing's checks list.
  assert.match(html, /<li>&lt;img src=x onerror=&quot;window\.jbPwned=1&quot;&gt;<\/li>/);
  // Each field that reaches the diagram carries the payload: company, title, location, the
  // check's name, rule, result and citation, and the event's reason.
  const sources = [...html.matchAll(/<script type="text\/x-mermaid">([\s\S]*?)<\/script>/g)].map(
    (m) => m[1] as string,
  );
  const tree = sources.find((s) => s.includes("#lt;img")) as string;
  assert.ok(tree, "the hostile Listing has a decision tree");
  assert.equal(tree.split("#lt;img src=x onerror=#quot;window.jbPwned=1#quot;#gt;").length - 1, 8);
});

test("the vendored Mermaid is the 12.x browser build, with its license beside it", async () => {
  const vendor = join(import.meta.dirname, "..", "vendor", "mermaid");
  const bundle = readFileSync(join(vendor, "mermaid.min.js"), "utf8");

  assert.match(bundle, /\{version:"12\.\d+\.\d+"\}/);
  assert.match(readFileSync(join(vendor, "LICENSE"), "utf8"), /MIT License/);
});
