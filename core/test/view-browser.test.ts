// The pipeline view in a real browser: the page is built by `view build` and opened from disk
// (file://), with no local server, as a job seeker would open it. See harness.ts for the gate.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import { realBrowser, realBrowserTest, runCli, tempDir } from "./harness.ts";
import { HOSTILE, seed, seedHostile } from "./view-fixture.ts";

const BROWSER = await realBrowser();
const realTest = realBrowserTest(BROWSER);

/** A Listing with a flagged check: its tree has a node to click. */
const FLAGGED = "greenhouse:acme:102";
/** The Listing whose every field, and every check's evidence, is hostile. */
const HOSTILE_ID = "greenhouse:acme:301";
/** The Mermaid level the page is built with (view.ts). */
const LOOSE = 'securityLevel:"loose"';

/** A headless Chromium, from the playwright-core module the harness loaded. */
async function launch(t: TestContext): Promise<Browser> {
  if (!BROWSER.available) throw new Error(BROWSER.reason);
  const browser = await BROWSER.chromium.launch({ headless: true });
  t.after(() => browser.close());
  return browser;
}

/**
 * Build the page from the seeded records, open it from disk, and go to the Listings tab.
 * The page is built at "loose"; `level: "strict"` writes a copy with that Mermaid level beside
 * it (its relative mermaid.min.js still loads), so the test runs the other level.
 */
async function openListings(t: TestContext, level: "loose" | "strict" = "loose"): Promise<Page> {
  const dataDir = tempDir(t);
  await seed(dataDir);
  await seedHostile(dataDir);
  const r = await runCli(["view", "build"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  let path = String(r.json.path);
  if (level !== "loose") {
    const html = readFileSync(path, "utf8");
    assert.equal(html.split(LOOSE).length - 1, 1, "the page sets its Mermaid level once");
    path = join(dirname(path), `${level}.html`);
    writeFileSync(path, html.replace(LOOSE, `securityLevel:"${level}"`));
  }

  const browser = await launch(t);
  const page = await browser.newPage();

  await page.goto(pathToFileURL(path).href);
  await page.click('[role="tab"][data-tab="listings"]');
  return page;
}

/** Select a Listing in the Listings tab and wait until its tree is drawn. */
async function drawTree(page: Page, id: string) {
  await page.click(`[data-select="${id}"]`);
  await page.waitForSelector(`article[data-listing="${id}"] .tree svg`);
}

realTest("real browser: the pipeline view draws its decision tree from disk", async (t) => {
  const page = await openListings(t);
  await drawTree(page, FLAGGED);

  const nodes = await page.locator(`article[data-listing="${FLAGGED}"] .tree g.node`).count();
  assert.ok(nodes >= 3, `expected the tree's nodes, found ${nodes}`);
});

realTest("real browser: clicking a node shows its rule and evidence in the panel", async (t) => {
  const page = await openListings(t);
  await drawTree(page, FLAGGED);

  const article = `article[data-listing="${FLAGGED}"]`;
  const before = await page.locator(`${article} .nodeinfo`).textContent();
  assert.doesNotMatch(before ?? "", /Ghost score rule/);

  await page.locator(`${article} .tree g.node`).filter({ hasText: "Ghost score" }).first().click();

  const after = await page.locator(`${article} .nodeinfo`).textContent();
  assert.match(after ?? "", /Ghost score: warn/);
  assert.match(after ?? "", /Rule: Ghost score rule/);
  assert.match(after ?? "", /Ghost score evidence line/);
});

realTest("real browser: the hostile text is shown as text and injects no element", async (t) => {
  const page = await openListings(t);
  await drawTree(page, HOSTILE_ID);

  const injected = await page.evaluate(
    `({
      img: document.querySelectorAll("img").length,
      iframe: document.querySelectorAll("iframe").length,
      handlers: document.querySelectorAll("[onerror],[onload]").length,
      flag: window.jbPwned === undefined,
    })`,
  );
  assert.deepEqual(injected, { img: 0, iframe: 0, handlers: 0, flag: true });

  // The payload is on screen as text, in the tree.
  const shown = await page.locator(`article[data-listing="${HOSTILE_ID}"] .tree`).textContent();
  assert.ok((shown ?? "").includes(HOSTILE), "the payload is shown in the tree");
});

realTest("real browser: hostile evidence shows as text in the evidence panel", async (t) => {
  const page = await openListings(t);
  await drawTree(page, HOSTILE_ID);

  const article = `article[data-listing="${HOSTILE_ID}"]`;
  // The check's node carries "→ <result>"; the Listing's source node also holds the payload.
  await page
    .locator(`${article} .tree g.node`)
    .filter({ hasText: "→" })
    .filter({ hasText: HOSTILE })
    .first()
    .click();

  // The evidence line is the payload as text, and nothing was injected to show it.
  const evidence = await page.locator(`${article} .nodeinfo li`).allTextContents();
  assert.ok(evidence.includes(HOSTILE), `evidence shown as text: ${evidence.join(" | ")}`);
  const injected = await page.evaluate(
    `({ img: document.querySelectorAll("img").length, flag: window.jbPwned === undefined })`,
  );
  assert.deepEqual(injected, { img: 0, flag: true });
});

realTest("real browser: the page's global mermaid exposes initialize and render", async (t) => {
  const page = await openListings(t);

  const lib = await page.evaluate(
    `({ initialize: typeof window.mermaid?.initialize, render: typeof window.mermaid?.render })`,
  );
  assert.deepEqual(lib, { initialize: "function", render: "function" });
});

realTest("real browser: at Mermaid's strict level the evidence panel never updates", async (t) => {
  // The page's own level is "loose", where a node click updates the panel (the test above).
  // This runs the page at "strict" and checks the claim in view.ts: the panel stays unchanged.
  const page = await openListings(t, "strict");
  assert.equal(
    await page.evaluate("window.mermaid.mermaidAPI.getConfig().securityLevel"),
    "strict",
  );
  await drawTree(page, FLAGGED);

  const article = `article[data-listing="${FLAGGED}"]`;
  const before = await page.locator(`${article} .nodeinfo`).textContent();
  await page.locator(`${article} .tree g.node`).filter({ hasText: "Ghost score" }).first().click();

  const after = await page.locator(`${article} .nodeinfo`).textContent();
  assert.equal(after, before, "the evidence panel did not update at strict");
  assert.doesNotMatch(after ?? "", /Ghost score: warn/);
});
