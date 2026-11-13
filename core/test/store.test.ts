import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgment, runCli, tempDir } from "./harness.ts";

function readRecord(dataDir: string, type: string, file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataDir, "pipeline", type, file), "utf8"));
}

test("record put writes one JSON file per record with schema_version 1 and UTC timestamps", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["record", "put", "listing", "greenhouse:acme:123", "--input", "-"], {
    dataDir,
    input: { title: "Backend Engineer", company: "Acme" },
    env: { JOB_BUTLER_NOW: "2026-02-01T10:30:00.000Z" },
  });

  assert.equal(r.code, 0, r.stdout);
  const record = readRecord(dataDir, "listing", "greenhouse%3Aacme%3A123.json");
  assert.deepEqual(record, {
    schema_version: 1,
    id: "greenhouse:acme:123",
    created_at: "2026-02-01T10:30:00.000Z",
    updated_at: "2026-02-01T10:30:00.000Z",
    title: "Backend Engineer",
    company: "Acme",
  });
});

test("record put replaces a record and keeps created_at", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const put = (now: string, title: string) =>
    runCli(["record", "put", "listing", "lever:acme:9", "--input", "-"], {
      dataDir,
      input: { title },
      env: { JOB_BUTLER_NOW: now },
    });

  await put("2026-02-01T00:00:00.000Z", "First");
  await put("2026-02-03T00:00:00.000Z", "Second");

  const got = await runCli(["record", "get", "listing", "lever:acme:9"], { dataDir });
  assert.deepEqual(got.json.record, {
    schema_version: 1,
    id: "lever:acme:9",
    created_at: "2026-02-01T00:00:00.000Z",
    updated_at: "2026-02-03T00:00:00.000Z",
    title: "Second",
  });
});

test("record put takes an LLM judgment fixture file as --input", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(
    ["record", "put", "employer", "acme-london", "--input", judgment("example-employer-match")],
    { dataDir },
  );

  assert.equal(r.code, 0, r.stdout);
  assert.equal(readRecord(dataDir, "employer", "acme-london.json").register_name, "ACME LTD");
});

test("record get of an unknown record is a NOT_FOUND refusal", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["record", "get", "listing", "nope"], { dataDir });

  assert.equal(r.code, 1);
  assert.equal(r.json.error?.code, "NOT_FOUND");
});

test("record list returns every record of a type", async (t) => {
  const dataDir = join(tempDir(t), "data");
  for (const id of ["b", "a"]) {
    await runCli(["record", "put", "application", id, "--input", "-"], { dataDir, input: {} });
  }

  const r = await runCli(["record", "list", "application"], { dataDir });

  assert.deepEqual(
    (r.json.records as { id: string }[]).map((x) => x.id),
    ["a", "b"],
  );
});

test("record put refuses an unknown record type", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["record", "put", "banana", "x", "--input", "-"], { dataDir, input: {} });

  assert.equal(r.code, 2);
  assert.equal(r.json.error?.code, "USAGE");
  assert.equal(existsSync(join(dataDir, "pipeline")), false);
});

test("record put refuses input that is not a JSON object", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["record", "put", "listing", "x", "--input", "-"], {
    dataDir,
    input: [1, 2],
  });

  assert.equal(r.code, 2);
  assert.equal(r.json.error?.code, "USAGE");
});
