import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempDir } from "./harness.ts";

// The harness clock is 2026-01-15T09:00:00.000Z; 90 days earlier is 2025-10-17T09:00:00.000Z.
const NINETY_DAYS_AGO = "2025-10-17T09:00:00.000Z";
const JUST_UNDER_NINETY = "2025-10-17T09:00:00.001Z";

async function putRecord(dataDir: string, type: string, id: string, data: object) {
  const r = await runCli(["record", "put", type, id, "--input", "-"], { dataDir, input: data });
  assert.equal(r.code, 0, r.stdout);
}

/** A screened Listing whose Sightings end at `lastSeen`, with its Decision tree on disk. */
async function putListing(dataDir: string, id: string, lastSeen: string, extra: object = {}) {
  await putRecord(dataDir, "listing", id, {
    company: "Acme",
    title: `Engineer ${id}`,
    first_seen_at: "2025-06-01T09:00:00.000Z",
    last_seen_at: lastSeen,
    sightings: [
      { discover_run: "run-1", alias: id, seen_at: "2025-06-01T09:00:00.000Z" },
      { discover_run: "run-2", alias: id, seen_at: lastSeen },
    ],
    decision_tree: `decision-trees/${encodeURIComponent(id)}.mmd`,
    ...extra,
  });
  writeTree(dataDir, id);
}

function writeTree(dataDir: string, id: string) {
  mkdirSync(join(dataDir, "decision-trees"), { recursive: true });
  writeFileSync(treeFile(dataDir, id), "flowchart TD\n");
}

const treeFile = (dataDir: string, id: string) =>
  join(dataDir, "decision-trees", `${encodeURIComponent(id)}.mmd`);

const listingIds = async (dataDir: string) =>
  ((await runCli(["record", "list", "listing"], { dataDir })).json.records as { id: string }[]).map(
    (r) => r.id,
  );

test("prune removes Listings with no Application 90 days after their latest Sighting, with their tree", async (t) => {
  const dataDir = tempDir(t);
  await putListing(dataDir, "greenhouse:acme:old", NINETY_DAYS_AGO);
  await putListing(dataDir, "greenhouse:acme:recent", JUST_UNDER_NINETY);

  const r = await runCli(["prune"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(
    (r.json.pruned as { id: string }[]).map((p) => p.id),
    ["greenhouse:acme:old"],
  );
  assert.deepEqual(await listingIds(dataDir), ["greenhouse:acme:recent"]);
  assert.equal(existsSync(treeFile(dataDir, "greenhouse:acme:old")), false);
  assert.equal(existsSync(treeFile(dataDir, "greenhouse:acme:recent")), true);
});

test("prune keeps a Listing that became an Application, however old its Sightings", async (t) => {
  const dataDir = tempDir(t);
  await putListing(dataDir, "greenhouse:acme:picked", "2025-01-01T09:00:00.000Z", {
    application_id: "app-1",
  });
  await putRecord(dataDir, "application", "app-1", {
    origin: "picked",
    listing: "greenhouse:acme:picked",
    status: "submitted",
  });
  // An Application that names the Listing counts even when the Listing lacks the back-link.
  await putListing(dataDir, "greenhouse:acme:linked", "2025-01-01T09:00:00.000Z");
  await putRecord(dataDir, "application", "app-2", {
    origin: "picked",
    listing: "greenhouse:acme:linked",
    status: "picked",
  });

  const r = await runCli(["prune"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.pruned, []);
  assert.deepEqual(await listingIds(dataDir), ["greenhouse:acme:linked", "greenhouse:acme:picked"]);
  assert.equal(existsSync(treeFile(dataDir, "greenhouse:acme:picked")), true);
});

test("prune removes orphan Decision trees and leftover temp files, and keeps the rest", async (t) => {
  const dataDir = tempDir(t);
  await putListing(dataDir, "greenhouse:acme:live", JUST_UNDER_NINETY);
  // A Listing deleted by a dedupe merge leaves its tree behind.
  writeTree(dataDir, "greenhouse:acme:merged-away");
  const trees = join(dataDir, "decision-trees");
  writeFileSync(join(trees, "greenhouse%3Aacme%3Alive.mmd.tmp-4242"), "half");
  writeFileSync(join(trees, "README.txt"), "not a tree");

  const r = await runCli(["prune"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.orphan_trees, ["decision-trees/greenhouse%3Aacme%3Amerged-away.mmd"]);
  assert.deepEqual(r.json.temp_files, ["decision-trees/greenhouse%3Aacme%3Alive.mmd.tmp-4242"]);
  assert.deepEqual(readdirSync(trees).sort(), ["README.txt", "greenhouse%3Aacme%3Alive.mmd"]);
});

// ---- the Approval hook ----

const CORE = "node /plugins/job-butler/core/src/cli.ts";

async function bashDecision(dataDir: string, command: string, session: string) {
  const r = await runCli(["hook", "pre-tool-use"], {
    dataDir,
    input: { session_id: session, tool_name: "Bash", tool_input: { command } },
  });
  assert.equal(r.code, 0, r.stdout);
  const out = r.json.hookSpecificOutput as Record<string, string> | undefined;
  return {
    decision: out?.permissionDecision === "deny" ? "deny" : "allow",
    reason: out?.permissionDecisionReason ?? "",
  };
}

for (const [scope, command] of [
  ["prune", "prune"],
  ["record delete", "record delete listing greenhouse:acme:1"],
] as const) {
  test(`${scope} needs a destructive grant that expires with its session`, async (t) => {
    const dataDir = tempDir(t);
    const denied = await bashDecision(dataDir, `${CORE} ${command}`, "first");
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, new RegExp(`grant add ${scope}`));

    const added = await runCli(["grant", "add", scope, "--session", "first"], { dataDir });
    assert.equal(added.code, 0, added.stdout);
    assert.equal((added.json.grant as Record<string, unknown>).kind, "destructive");

    assert.equal((await bashDecision(dataDir, `${CORE} ${command}`, "first")).decision, "allow");
    assert.equal((await bashDecision(dataDir, `${CORE} ${command}`, "second")).decision, "deny");
  });
}

test("retention preview and other record commands need no grant", async (t) => {
  const dataDir = tempDir(t);
  for (const command of ["retention preview", "record list listing", "record get listing x"]) {
    assert.equal((await bashDecision(dataDir, `${CORE} ${command}`, "s")).decision, "allow");
  }
});

// ---- record delete ----

const SCREENED = { screen: { outcome: "shortlist", excluded_by: null, checks: [] } };

test("record delete removes a Listing and its Decision tree", async (t) => {
  const dataDir = tempDir(t);
  await putListing(dataDir, "greenhouse:acme:1", JUST_UNDER_NINETY);
  await putListing(dataDir, "greenhouse:acme:2", JUST_UNDER_NINETY);

  const r = await runCli(["record", "delete", "listing", "greenhouse:acme:1"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.deleted, [{ type: "listing", id: "greenhouse:acme:1" }]);
  assert.deepEqual(r.json.files_removed, ["decision-trees/greenhouse%3Aacme%3A1.mmd"]);
  assert.deepEqual(await listingIds(dataDir), ["greenhouse:acme:2"]);
  assert.equal(existsSync(treeFile(dataDir, "greenhouse:acme:1")), false);
});

test("record delete refuses a Listing that has an Application until the Application goes", async (t) => {
  const dataDir = tempDir(t);
  await putListing(dataDir, "greenhouse:acme:1", JUST_UNDER_NINETY, {
    ...SCREENED,
    application_id: "app-1",
  });
  await putRecord(dataDir, "application", "app-1", {
    origin: "picked",
    listing: "greenhouse:acme:1",
    status: "picked",
    event_log: [],
    decision_tree: "decision-trees/greenhouse%3Aacme%3A1.mmd",
  });

  const refused = await runCli(["record", "delete", "listing", "greenhouse:acme:1"], { dataDir });
  assert.equal(refused.code, 1);
  assert.equal(refused.json.error?.code, "LISTING_HAS_APPLICATION");
  assert.match(refused.json.error?.message ?? "", /record delete application app-1/);
  assert.deepEqual(await listingIds(dataDir), ["greenhouse:acme:1"]);

  const app = await runCli(["record", "delete", "application", "app-1"], { dataDir });
  assert.equal(app.code, 0, app.stdout);
  const listing = (await runCli(["record", "get", "listing", "greenhouse:acme:1"], { dataDir }))
    .json.record as Record<string, unknown>;
  assert.equal(listing.application_id, undefined);
  // The tree is redrawn without the Application's chain.
  const tree = readFileSync(treeFile(dataDir, "greenhouse:acme:1"), "utf8");
  assert.match(tree, /On the Shortlist/);
  assert.doesNotMatch(tree, /Status:/);

  const listingGone = await runCli(["record", "delete", "listing", "greenhouse:acme:1"], {
    dataDir,
  });
  assert.equal(listingGone.code, 0, listingGone.stdout);
});

test("record delete removes an Application's Tailor folder inside the data directory", async (t) => {
  const dataDir = tempDir(t);
  const folder = join(dataDir, "tailor", "app-1");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "resume.md"), "# Resume");
  await putRecord(dataDir, "application", "app-1", {
    origin: "external",
    listing: null,
    status: "submitted",
    tailor: { folder: "tailor/app-1" },
  });

  const r = await runCli(["record", "delete", "application", "app-1"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.files_removed, ["tailor/app-1"]);
  assert.equal(existsSync(folder), false);
  assert.equal(existsSync(join(dataDir, "tailor")), true);
});

test("record delete is all or nothing: an unknown id deletes nothing", async (t) => {
  const dataDir = tempDir(t);
  await putRecord(dataDir, "employer", "emp-1", { name: "Acme" });
  const r = await runCli(["record", "delete", "employer", "emp-1", "emp-missing"], { dataDir });
  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "NOT_FOUND");
  const kept = await runCli(["record", "get", "employer", "emp-1"], { dataDir });
  assert.equal(kept.code, 0);

  const both = await runCli(["record", "delete", "employer", "emp-1"], { dataDir });
  assert.equal(both.code, 0, both.stdout);
  assert.equal((await runCli(["record", "get", "employer", "emp-1"], { dataDir })).code, 1);
});

test("retention preview lists what prune would remove and changes nothing", async (t) => {
  const dataDir = tempDir(t);
  await putListing(dataDir, "greenhouse:acme:old", NINETY_DAYS_AGO);
  writeTree(dataDir, "greenhouse:acme:merged-away");

  const r = await runCli(["retention", "preview"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.cutoff, NINETY_DAYS_AGO);
  assert.deepEqual(r.json.pruned, [
    {
      id: "greenhouse:acme:old",
      company: "Acme",
      title: "Engineer greenhouse:acme:old",
      latest_sighting_at: NINETY_DAYS_AGO,
    },
  ]);
  assert.deepEqual(r.json.orphan_trees, ["decision-trees/greenhouse%3Aacme%3Amerged-away.mmd"]);
  assert.deepEqual(await listingIds(dataDir), ["greenhouse:acme:old"]);
  assert.equal(existsSync(treeFile(dataDir, "greenhouse:acme:merged-away")), true);
});
