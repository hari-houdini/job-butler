import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, serveBrowserFixtures } from "./harness.ts";

test("fetch returns a recorded network response from the fixtures", async () => {
  const r = await runCli(["fetch", "https://example.com/careers"]);

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.status, 200);
  assert.equal(r.json.content_type, "text/html; charset=utf-8");
  assert.match(String(r.json.body), /Example Co careers/);
});

test("fetch refuses a URL with no recorded response instead of going online", async () => {
  const r = await runCli(["fetch", "https://example.com/not-recorded"]);

  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "NETWORK_FIXTURE_MISSING");
});

test("browser fixture pages are served locally and reachable from the core", async (t) => {
  const base = await serveBrowserFixtures(t);

  const r = await runCli(["fetch", `${base}/example-form.html`]);

  assert.equal(r.json.status, 200);
  assert.match(String(r.json.body), /<form/);
});
