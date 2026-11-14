// The pipeline view in a real browser: the page is built by `view build` and opened from disk
// (file://), with no local server, as a job seeker would open it. See harness.ts for the gate.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import { realBrowser, realBrowserTest, runCli, tempDir } from "./harness.ts";
import { seed, seedHostile } from "./view-fixture.ts";

const BROWSER = await realBrowser();
const realTest = realBrowserTest(BROWSER);

/** A Listing with a flagged check: its tree has a node to click. */
const FLAGGED = "greenhouse:acme:102";
/** The Listing whose every field is hostile. */
const HOSTILE = "greenhouse:acme:301";

/** A headless Chromium, through the Playwright module the harness resolved. */
async function launch(t: TestContext): Promise<Browser> {
  if (!BROWSER.available) throw new Error(BROWSER.reason);
  const { chromium } = (await import(
    pathToFileURL(BROWSER.playwright).href
  )) as typeof import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  return browser;
}

/** Build the page from the seeded records, open it from disk, and go to the Listings tab. */
async function openListings(t: TestContext): Promise<{ page: Page; path: string }> {
  const dataDir = tempDir(t);
  await seed(dataDir);
  await seedHostile(dataDir);
  const r = await runCli(["view", "build"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  const path = String(r.json.path);

  const browser = await launch(t);
  const page = await browser.newPage();

  await page.goto(pathToFileURL(path).href);
  await page.click('[role="tab"][data-tab="listings"]');
  return { page, path };
}

/** Select a Listing in the Listings tab and wait until its tree is drawn. */
async function drawTree(page: Page, id: string) {
  await page.click(`[data-select="${id}"]`);
  await page.waitForSelector(`article[data-listing="${id}"] .tree svg`);
}

realTest("real browser: the pipeline view draws its decision tree from disk", async (t) => {
  const { page } = await openListings(t);
  await drawTree(page, FLAGGED);

  const nodes = await page.locator(`article[data-listing="${FLAGGED}"] .tree g.node`).count();
  assert.ok(nodes >= 3, `expected the tree's nodes, found ${nodes}`);
});

realTest("real browser: clicking a node shows its rule and evidence in the panel", async (t) => {
  const { page } = await openListings(t);
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
  const { page } = await openListings(t);
  await drawTree(page, HOSTILE);

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
  const shown = await page.locator(`article[data-listing="${HOSTILE}"] .tree`).textContent();
  assert.match(shown ?? "", /<img src=x onerror="window\.jbPwned=1">/);
});

realTest("real browser: the page's global mermaid exposes initialize and render", async (t) => {
  const { page } = await openListings(t);

  const lib = await page.evaluate(
    `({ initialize: typeof window.mermaid?.initialize, render: typeof window.mermaid?.render })`,
  );
  assert.deepEqual(lib, { initialize: "function", render: "function" });
});
