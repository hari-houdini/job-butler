import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES, runCli, tempDir } from "./harness.ts";

const resume = (name: string) => join(FIXTURES, "resumes", name);

test("resume import keeps a copy of a DOCX resume and returns its text", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["resume", "import", resume("ada-example.docx")], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.format, "docx");
  assert.equal(
    r.json.text,
    "Ada Example\nSenior Software Engineer, Northwind Payments & Co\nCut card authorisation latency by 40%\t2022",
  );
  assert.equal(r.json.source, "resume: ada-example.docx");
  const copy = join(dataDir, "sources", "ada-example.docx");
  assert.deepEqual(readFileSync(copy), readFileSync(resume("ada-example.docx")));
});

test("resume import reads a text resume as it is", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["resume", "import", resume("ada-example.txt")], { dataDir });

  assert.equal(r.json.format, "text");
  assert.equal(r.json.text, "Ada Example\nSenior Software Engineer\n");
});

test("resume import keeps a PDF and leaves reading it to the setup skill", async (t) => {
  const dir = tempDir(t);
  const pdf = join(dir, "cv.pdf");
  writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");

  const r = await runCli(["resume", "import", pdf], { dataDir: join(dir, "data") });

  assert.equal(r.json.format, "pdf");
  assert.equal(r.json.text, null);
  assert.equal(r.json.path, join(dir, "data", "sources", "cv.pdf"));
  assert.equal(existsSync(join(dir, "data", "sources", "cv.pdf")), true);
});

test("resume import refuses other formats", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "cv.pages");
  writeFileSync(file, "x");

  const r = await runCli(["resume", "import", file], { dataDir: join(dir, "data") });

  assert.equal(r.json.error?.code, "RESUME_FORMAT");
  assert.match(r.json.error?.message ?? "", /PDF, DOCX or text/);
});
