import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

/** What setup does at the end: write the Profile, then create Preferences. */
async function setUp(dataDir: string): Promise<void> {
  const p = await runCli(["profile", "put", "--input", judgment("setup-profile")], { dataDir });
  assert.equal(p.code, 0, p.stdout);
  const prefs = await runCli(["preferences", "init"], { dataDir });
  assert.equal(prefs.code, 0, prefs.stdout);
}

function profileFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
}

test("a Stage refuses to start without a Profile and sends the job seeker to setup", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["run", "start", "discover"], { dataDir });

  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "PROFILE_INCOMPLETE");
  assert.match(r.json.error?.message ?? "", /\/job-butler:setup/);
});

test("after setup writes a complete Profile and Preferences, a Stage starts", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);

  const r = await runCli(["run", "start", "discover"], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(typeof r.json.run_id, "string");
  assert.equal(r.json.joined, false);
  const status = await runCli(["status"], { dataDir });
  assert.equal(status.json.profile, "complete");
  assert.equal(status.json.next, null);
});

test("a Profile missing sections refuses every Stage and names what's missing", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const { identity } = profileFixture();
  await runCli(["profile", "put", "--section", "identity", "--input", "-"], {
    dataDir,
    input: identity,
  });
  await runCli(["preferences", "init"], { dataDir });

  for (const stage of ["discover", "screen", "tailor", "apply", "track", "pipeline"]) {
    const r = await runCli(["run", "start", stage], { dataDir });
    assert.equal(r.json.error?.code, "PROFILE_INCOMPLETE", stage);
    assert.match(r.json.error?.message ?? "", /base_resume.*targets.*\/job-butler:setup/);
  }
  const status = await runCli(["status"], { dataDir });
  assert.equal(status.json.profile, "incomplete");
  assert.equal(status.json.next, "setup");
});

test("an unreviewed Base resume keeps the Profile incomplete", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const profile = profileFixture();
  (profile.base_resume as Record<string, unknown>).reviewed_at = null;
  await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  await runCli(["preferences", "init"], { dataDir });

  const r = await runCli(["run", "start", "screen"], { dataDir });

  assert.equal(r.json.error?.code, "PROFILE_INCOMPLETE");
  assert.match(r.json.error?.message ?? "", /base_resume\.reviewed_at/);
});

test("setup can re-run one section and leaves the others as they were", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const targets = { ...(profileFixture().targets as object), roles: ["Staff Engineer"] };

  const r = await runCli(["profile", "put", "--section", "targets", "--input", "-"], {
    dataDir,
    input: targets,
  });

  assert.equal(r.code, 0, r.stdout);
  const after = await runCli(["profile", "get"], { dataDir });
  const profile = after.json.profile as Record<string, Record<string, unknown>>;
  assert.deepEqual(profile.targets?.roles, ["Staff Engineer"]);
  assert.deepEqual(profile.identity, profileFixture().identity);
  assert.deepEqual(profile.base_resume, profileFixture().base_resume);
});

test("the Profile is YAML the job seeker can edit by hand", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const file = join(dataDir, "profile.yaml");
  const yaml = readFileSync(file, "utf8");
  assert.match(yaml, /^identity:\n {2}name: Ada Example\n/m);
  assert.match(yaml, /^ {2}country: United Kingdom$/m);

  writeFileSync(
    file,
    yaml.replace(
      /^ {2}roles:\n(?: {4}- .*\n)+/m,
      "  roles: [Backend Engineer, 'Site Reliability Engineer']  # edited\n",
    ),
  );
  const r = await runCli(["profile", "get", "--section", "targets"], { dataDir });

  assert.deepEqual((r.json.section as Record<string, unknown>).roles, [
    "Backend Engineer",
    "Site Reliability Engineer",
  ]);
  assert.equal((await runCli(["run", "start", "discover"], { dataDir })).code, 0);
});

test("a broken hand edit stops every Stage with the setting to fix", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const file = join(dataDir, "profile.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("  remote: true", "  remote: maybe"));

  const r = await runCli(["run", "start", "discover"], { dataDir });

  assert.equal(r.json.error?.code, "PROFILE_INVALID");
  assert.match(r.json.error?.message ?? "", /targets\.remote must be true or false/);
});

test("the Profile refuses sensitive Sponsorship facts: only derived flags are kept", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const sponsorship = {
    needed: true,
    regime: "uk-skilled-worker",
    flags: { date_of_birth: "1999-02-03", new_entrant: { value: true, reason: "under_26" } },
    flags_skipped: false,
  };

  const r = await runCli(["profile", "put", "--section", "sponsorship", "--input", "-"], {
    dataDir,
    input: sponsorship,
  });

  assert.equal(r.json.error?.code, "PROFILE_INVALID");
  assert.match(r.json.error?.message ?? "", /date_of_birth can't be stored/);
  assert.equal(existsSync(join(dataDir, "profile.yaml")), false);
});

test("every Base resume fact must name its source", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const base = profileFixture().base_resume as { skills: Record<string, unknown>[] };
  base.skills.push({ name: "Kubernetes" });

  const r = await runCli(["profile", "put", "--section", "base_resume", "--input", "-"], {
    dataDir,
    input: base,
  });

  assert.equal(r.json.error?.code, "PROFILE_INVALID");
  assert.match(r.json.error?.message ?? "", /base_resume\.skills\[2\]\.source must name where/);
});

test("autonomy can only be stored as off", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["profile", "put", "--section", "autonomy", "--input", "-"], {
    dataDir,
    input: { enabled: true, caps: {}, fit_threshold: 80, lists: {} },
  });

  assert.equal(r.json.error?.code, "PROFILE_INVALID");
  assert.match(r.json.error?.message ?? "", /autonomy\.enabled must be false/);
});

test("hand-written block text, quotes and comments in the Profile read as the job seeker meant", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await setUp(dataDir);
  const file = join(dataDir, "profile.yaml");
  const yaml = readFileSync(file, "utf8").replace(
    /^ {2}summary:\n(?: {4}.*\n)+/m,
    [
      "  summary:",
      "    # rewritten by hand",
      "    text: >-",
      "      Backend engineer: six years",
      "      building payment APIs.",
      "",
      "      Mentor # not a comment",
      '    source: "job_seeker: told setup"',
      "",
    ].join("\n"),
  );
  writeFileSync(file, yaml);

  const r = await runCli(["profile", "get", "--section", "base_resume"], { dataDir });

  assert.deepEqual((r.json.section as Record<string, unknown>).summary, {
    text: "Backend engineer: six years building payment APIs.\nMentor # not a comment",
    source: "job_seeker: told setup",
  });
});
