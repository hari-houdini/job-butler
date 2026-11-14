import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES, runCli, tempDir } from "./harness.ts";

const DAY1 = { JOB_BUTLER_NETWORK_FIXTURES: join(FIXTURES, "sponsor-network") };
const DAY2 = {
  JOB_BUTLER_NETWORK_FIXTURES: join(FIXTURES, "sponsor-network-day2"),
  JOB_BUTLER_NOW: "2026-01-16T09:00:00.000Z",
};
const DAY2_DOWN = {
  JOB_BUTLER_NETWORK_FIXTURES: join(FIXTURES, "sponsor-network-down"),
  JOB_BUTLER_NOW: "2026-01-16T09:00:00.000Z",
};

test("sponsor refresh scrapes the CSV link from the GOV.UK page and downloads it", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["sponsor", "refresh"], { dataDir, env: DAY1 });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.refreshed, true);
  assert.equal(
    r.json.csv_url,
    "https://assets.publishing.service.gov.uk/media/6a0f1c2d3e4b5a6c7d8e9f01/2026-01-14_-_Worker_and_Temporary_Worker.csv",
  );
  assert.equal(r.json.stale, false);
  assert.equal(r.json.organisations, 11);
  assert.ok(existsSync(join(dataDir, "cache", "sponsor-register.csv")));
});

test("sponsor refresh downloads at most once a day", async (t) => {
  const dataDir = tempDir(t);
  await runCli(["sponsor", "refresh"], { dataDir, env: DAY1 });
  // Same day, and the network is down: no attempt is made, so nothing is stale.
  const again = await runCli(["sponsor", "refresh"], {
    dataDir,
    env: { ...DAY1, JOB_BUTLER_NETWORK_FIXTURES: join(FIXTURES, "sponsor-network-down") },
  });
  assert.equal(again.json.refreshed, false);
  assert.equal(again.json.stale, false);
  // The next day it downloads again.
  const next = await runCli(["sponsor", "refresh"], { dataDir, env: DAY2 });
  assert.equal(next.json.refreshed, true);
  assert.equal(next.json.as_of, "2026-01-16");
});

test("a failed download keeps the last good copy and marks results stale", async (t) => {
  const dataDir = tempDir(t);
  await runCli(["sponsor", "refresh"], { dataDir, env: DAY1 });
  const r = await runCli(["sponsor", "refresh"], { dataDir, env: DAY2_DOWN });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.refreshed, false);
  assert.equal(r.json.stale, true);
  assert.equal(r.json.as_of, "2026-01-15");
  assert.equal(r.json.stale_note, "data may be stale (as of 2026-01-15)");
  const status = await runCli(["sponsor", "status"], { dataDir, env: DAY2_DOWN });
  assert.equal(status.json.stale_note, "data may be stale (as of 2026-01-15)");
});

test("with no copy at all, a failed download refuses", async (t) => {
  const dataDir = tempDir(t);
  const r = await runCli(["sponsor", "refresh"], { dataDir, env: DAY2_DOWN });
  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "REGISTER_UNAVAILABLE");
});

// --- the Employer matcher ---------------------------------------------------------------

interface Match {
  employer: {
    id: string;
    status: string;
    match_tier: string | null;
    confidence: string | null;
    matched_at: string;
    register_entry: { organisation_name: string; town: string; entries: unknown[] } | null;
    company_number: string | null;
    [k: string]: unknown;
  };
  cached: boolean;
  stale: boolean;
  stale_note: string | null;
  judgment_needed: {
    candidates: { key: string; organisation_name: string; town: string }[];
  } | null;
  [k: string]: unknown;
}

async function match(dataDir: string, input: object, env: Record<string, string> = DAY1) {
  const r = await runCli(["employer", "match", "--input", "-"], { dataDir, input, env });
  assert.equal(r.code, 0, r.stdout);
  return r.json as unknown as Match & { ok: boolean };
}

test("matching normalises case, punctuation, Ltd and Limited, and caches an Employer", async (t) => {
  const dataDir = tempDir(t);
  const m = await match(dataDir, { company: "ACME  WIDGETS, Ltd.", town: "London" });
  assert.equal(m.employer.status, "matched");
  assert.equal(m.employer.match_tier, "exact");
  assert.equal(m.employer.confidence, "high");
  assert.equal(m.employer.register_entry?.organisation_name, "Acme Widgets Limited");
  assert.equal(m.employer.register_entry?.entries.length, 2);
  assert.equal(m.employer.matched_at, "2026-01-15T09:00:00.000Z");
  // The register downloaded on demand; the match is now an Employer record.
  const list = await runCli(["record", "list", "employer"], { dataDir });
  assert.equal((list.json.records as unknown[]).length, 1);
  // A second call reuses it.
  const again = await match(dataDir, { company: "Acme Widgets Limited", town: "London" });
  assert.equal(again.cached, true);
  assert.equal(again.employer.id, m.employer.id);
});

test("an exact name needs no town, and handles quoted commas and t/a names", async (t) => {
  const dataDir = tempDir(t);
  const a = await match(dataDir, { company: "Smith, Jones & Co" });
  assert.equal(a.employer.register_entry?.organisation_name, "Smith, Jones & Co Ltd");
  const b = await match(dataDir, { company: "The Amazon", town: "Slough" });
  assert.equal(b.employer.register_entry?.organisation_name, "Maxico Uk limited t/a The Amazon");
});

test("the town only tells apart entries with the same name", async (t) => {
  const dataDir = tempDir(t);
  const leeds = await match(dataDir, { company: "Northwind Traders", town: "Leeds" });
  assert.equal(leeds.employer.register_entry?.town, "Leeds");
  const bristol = await match(dataDir, { company: "Northwind Traders", town: "Bristol" });
  assert.equal(bristol.employer.register_entry?.town, "Bristol");
  const unknown = await match(dataDir, { company: "Northwind Traders" });
  assert.equal(unknown.employer.status, "unmatched");
  assert.equal(unknown.employer.register_entry, null);
});

test("a near name needs the town and a Companies House key to match", async (t) => {
  // No key: a near match can't be verified, so it doesn't count (decision #24).
  const plain = await match(tempDir(t), { company: "Orbital Dynamic Ltd", town: "Cambridge" });
  assert.equal(plain.employer.status, "unmatched");
  assert.equal(plain.employer.register_entry, null);
  assert.match(String(plain.employer.unmatched_reason), /Companies House key/);

  const keyed = tempDir(t);
  await setKey(keyed);
  const hit = await match(keyed, { company: "Orbital Dynamic Ltd", town: "Cambridge" });
  assert.equal(hit.employer.status, "matched");
  assert.equal(hit.employer.match_tier, "fuzzy");
  assert.equal(hit.employer.register_entry?.organisation_name, "Orbital Dynamics Limited");
  assert.equal(hit.employer.company_number, "02345678");
  const noTown = await match(keyed, { company: "Orbital Dynamic Ltd" });
  assert.equal(noTown.employer.status, "unmatched");
  const wrongTown = await match(keyed, { company: "Orbital Dynamic Ltd", town: "Leeds" });
  assert.equal(wrongTown.employer.status, "unmatched");
  const nothing = await match(keyed, { company: "Completely Different Name", town: "Cambridge" });
  assert.equal(nothing.employer.status, "unmatched");
});

test("without a key, several near candidates are unmatched and the model is not asked", async (t) => {
  const plain = await match(tempDir(t), { company: "Greenfield Analytix", town: "Bristol" });
  assert.equal(plain.employer.status, "unmatched");
  assert.equal(plain.judgment_needed, null);
});

test("several fuzzy candidates go to the model as JSON, and only one of them can be chosen", async (t) => {
  const dataDir = tempDir(t);
  await setKey(dataDir);
  const ask = await match(dataDir, { company: "Greenfield Analytix", town: "Bristol" });
  assert.equal(ask.employer.status, "needs_judgment");
  const candidates = ask.judgment_needed?.candidates ?? [];
  assert.ok(candidates.length >= 2 && candidates.length <= 3);
  const pick = candidates.find((c) => c.organisation_name === "Greenfield Analytics Limited");
  assert.ok(pick);
  const done = await match(dataDir, {
    company: "Greenfield Analytix",
    town: "Bristol",
    judgment: { choice: pick.key },
  });
  assert.equal(done.employer.status, "matched");
  assert.equal(done.employer.register_entry?.organisation_name, "Greenfield Analytics Limited");
  assert.equal(done.employer.company_number, "08123456");
  assert.equal(done.judgment_needed, null);

  const outside = await runCli(["employer", "match", "--input", "-"], {
    dataDir,
    env: DAY1,
    input: {
      company: "Greenfield Analytix",
      town: "Bristol",
      judgment: { choice: "northwind traders|leeds" },
    },
  });
  assert.equal(outside.json.error?.code, "JUDGMENT_NOT_A_CANDIDATE");

  const none = await match(dataDir, {
    company: "Greenfield Analytix",
    town: "Bristol",
    judgment: { choice: null },
  });
  assert.equal(none.employer.status, "unmatched");
});

// --- Companies House ---------------------------------------------------------------------

async function setKey(dataDir: string) {
  const r = await runCli(["profile", "put", "--section", "companies_house_key", "--input", "-"], {
    dataDir,
    input: JSON.stringify("test-key-not-real"),
  });
  assert.equal(r.code, 0, r.stdout);
}

test("setup stores the job seeker's own Companies House key in the Profile, not in the code", async (t) => {
  const dataDir = tempDir(t);
  await setKey(dataDir);
  const got = await runCli(["profile", "get"], { dataDir });
  assert.equal(JSON.stringify(got.json).includes("test-key-not-real"), true);
});

test("without a key the exact tier gives no company number; with one it verifies", async (t) => {
  const dataDir = tempDir(t);
  const plain = await match(dataDir, { company: "Acme Widgets Limited", town: "London" });
  assert.equal(plain.employer.company_number, null);
  assert.equal(plain.companies_house, "not_set");

  const keyed = tempDir(t);
  await setKey(keyed);
  const m = await match(keyed, { company: "Acme Widgets Limited", town: "London" });
  assert.equal(m.employer.company_number, "00112233");
  assert.equal(m.companies_house, "used");
});

test("with a key, a fuzzy match counts only when Companies House verifies it", async (t) => {
  const dataDir = tempDir(t);
  await setKey(dataDir);
  const ok = await match(dataDir, { company: "Orbital Dynamic Ltd", town: "Cambridge" });
  assert.equal(ok.employer.status, "matched");
  assert.equal(ok.employer.match_tier, "fuzzy");
  assert.equal(ok.employer.company_number, "02345678");
  // Zephyr Labs is dissolved at Companies House: not high confidence.
  const dissolved = await match(dataDir, { company: "Zephyr Lab Ltd", town: "Oxford" });
  assert.equal(dissolved.employer.status, "unmatched");
});

test("with a key, a brand name is looked up for its legal name and matched to the register", async (t) => {
  const keyed = tempDir(t);
  await setKey(keyed);
  const m = await match(keyed, { company: "Kestrel", town: "Edinburgh" });
  assert.equal(m.employer.status, "matched");
  assert.equal(m.employer.match_tier, "companies_house");
  assert.equal(m.employer.register_entry?.organisation_name, "Kestrel Robotics Limited");
  assert.equal(m.employer.company_number, "09876543");
  // Without a key the brand stays unmatched.
  const plain = await match(tempDir(t), { company: "Kestrel", town: "Edinburgh" });
  assert.equal(plain.employer.status, "unmatched");
});

test("a cached fuzzy Employer is re-checked after a Companies House key is added, without a register download", async (t) => {
  const dataDir = tempDir(t);
  const before = await match(dataDir, { company: "Orbital Dynamic Ltd", town: "Cambridge" });
  assert.equal(before.employer.status, "unmatched");
  await setKey(dataDir);
  // Same register copy, same day: no download happens, but the key changes the answer.
  const after = await match(dataDir, { company: "Orbital Dynamic Ltd", town: "Cambridge" });
  assert.equal(after.refreshed, false);
  assert.equal(after.cached, false);
  assert.equal(after.employer.status, "matched");
  assert.equal(after.employer.match_tier, "fuzzy");
  assert.equal(after.employer.company_number, "02345678");
  assert.equal(after.employer.verified_by_companies_house, true);
});

// --- agencies ----------------------------------------------------------------------------

test("agencies are detected by name, 'our client' wording and SIC 78xxx and get a badge", async (t) => {
  const dataDir = tempDir(t);
  const byName = await match(dataDir, { company: "Pinnacle Recruitment Ltd", town: "London" });
  assert.equal(byName.employer.status, "agency");
  assert.deepEqual((byName.employer.agency as { signals: string[] }).signals, ["name pattern"]);
  assert.equal((byName.employer.agency as { badge: string }).badge, "agency, end client not named");
  assert.equal(byName.employer.register_entry, null);

  const byWording = await match(dataDir, {
    company: "Hartley Associates",
    town: "Leeds",
    description: "Our client, a fast-growing fintech, is hiring a developer.",
  });
  assert.equal(byWording.employer.status, "agency");
  assert.deepEqual((byWording.employer.agency as { signals: string[] }).signals, [
    "our client wording",
  ]);

  const keyed = tempDir(t);
  await setKey(keyed);
  const bySic = await match(keyed, { company: "Meridian People Limited", town: "London" });
  assert.equal(bySic.employer.status, "agency");
  assert.deepEqual((bySic.employer.agency as { signals: string[] }).signals, ["SIC 78xxx"]);
});

test("naming the end client re-runs the match and drops the badge", async (t) => {
  const dataDir = tempDir(t);
  const first = await match(dataDir, { company: "Pinnacle Recruitment Ltd", town: "Manchester" });
  const named = await runCli(["employer", "end-client", first.employer.id, "--input", "-"], {
    dataDir,
    env: DAY1,
    input: { end_client: "Brightside Software" },
  });
  assert.equal(named.code, 0, named.stdout);
  const employer = named.json.employer as Match["employer"];
  assert.equal(employer.status, "matched");
  assert.equal(employer.register_entry?.organisation_name, "Brightside Software Ltd");
  assert.equal((employer.agency as { badge: string | null }).badge, null);
  assert.equal((employer.agency as { end_client: string }).end_client, "Brightside Software");
});

// --- confirming and correcting -------------------------------------------------------------

test("a confirmed or corrected match is pinned and survives a new register", async (t) => {
  const dataDir = tempDir(t);
  const a = await match(dataDir, { company: "Brightside Software", town: "Manchester" });
  assert.equal(a.employer.status, "matched");
  const pin = await runCli(["employer", "confirm", a.employer.id], { dataDir, env: DAY1 });
  assert.equal(pin.code, 0, pin.stdout);

  const b = await match(dataDir, { company: "Hartwell Foods", town: "Leeds" });
  assert.equal(b.employer.status, "unmatched");
  const fix = await runCli(["employer", "correct", b.employer.id, "--input", "-"], {
    dataDir,
    env: DAY1,
    input: { organisation_name: "Kestrel Robotics Limited" },
  });
  assert.equal(fix.code, 0, fix.stdout);

  // The next day's register has Hartwell Foods and no Brightside; pinned Employers don't move.
  const next = await runCli(["sponsor", "refresh"], { dataDir, env: DAY2 });
  assert.equal(next.json.refreshed, true);
  const list = await runCli(["record", "list", "employer"], { dataDir });
  const byId = new Map((list.json.records as Match["employer"][]).map((e) => [e.id, e]));
  assert.equal(
    byId.get(a.employer.id)?.register_entry?.organisation_name,
    "Brightside Software Ltd",
  );
  assert.equal(
    byId.get(b.employer.id)?.register_entry?.organisation_name,
    "Kestrel Robotics Limited",
  );
  assert.ok(byId.get(b.employer.id)?.pinned);

  const bad = await runCli(["employer", "correct", b.employer.id, "--input", "-"], {
    dataDir,
    env: DAY1,
    input: { organisation_name: "No Such Org" },
  });
  assert.equal(bad.json.error?.code, "NOT_ON_REGISTER");
});

test("each register download re-checks cached Employers", async (t) => {
  const dataDir = tempDir(t);
  const bright = await match(dataDir, { company: "Brightside Software", town: "Manchester" });
  const hartwell = await match(dataDir, { company: "Hartwell Foods", town: "Leeds" });
  assert.equal(bright.employer.status, "matched");
  assert.equal(hartwell.employer.status, "unmatched");

  const r = await runCli(["sponsor", "refresh"], { dataDir, env: DAY2 });
  const rechecked = r.json.rechecked as {
    checked: number;
    changed: { id: string; after: string }[];
  };
  assert.equal(rechecked.checked, 2);
  assert.deepEqual(
    rechecked.changed.map((c) => [c.id, c.after]).sort(),
    [
      [bright.employer.id, "unmatched"],
      [hartwell.employer.id, "Hartwell Foods Limited"],
    ].sort(),
  );
  const got = await runCli(["record", "get", "employer", hartwell.employer.id], { dataDir });
  const e = got.json.record as Match["employer"];
  assert.equal(e.status, "matched");
  assert.equal(e.matched_at, "2026-01-16T09:00:00.000Z");
});

test("results from a stale register say so", async (t) => {
  const dataDir = tempDir(t);
  await match(dataDir, { company: "Acme Widgets", town: "London" });
  const m = await match(dataDir, { company: "Acme Widgets", town: "London" }, DAY2_DOWN);
  assert.equal(m.stale, true);
  assert.equal(m.stale_note, "data may be stale (as of 2026-01-15)");
  assert.equal(m.employer.status, "matched");
});
