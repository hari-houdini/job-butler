import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { judgment, runCli, tempDir } from "./harness.ts";

// biome-ignore lint/suspicious/noExplicitAny: parsed test JSON
type Any = any;
const LISTING = "greenhouse:acme:101";
const APP = "app-1";

const COVER_FIELD = {
  name: "cover_letter",
  label: "Cover Letter",
  type: "file",
  required: false,
  value: "",
  source: { kind: "tailor", ref: "cover_letter" },
  readback: null,
};
const PLAN_WITH_COVER = {
  state: "planned",
  built_at: "2026-01-15T08:00:00.000Z",
  form: { url: "u", board_token: "acme", job_id: "101", fetched_at: "2026-01-15T08:00:00.000Z" },
  fields: [COVER_FIELD],
  unmappable: [],
  blockers: [],
  readback_at: null,
  browser: null,
};
const PLAN_WITHOUT_COVER = { ...PLAN_WITH_COVER, fields: [] };

function docxXml(file: string): string {
  const zip = readFileSync(file);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  let xml = "";
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    names.push(name);
    if (name === "word/document.xml") xml = (method === 8 ? inflateRawSync(data) : data).toString();
    at += 46 + nameLen + extraLen + commentLen;
  }
  assert.deepEqual(
    names.filter((n) => /header|footer|media|embeddings|drawings/i.test(n)),
    [],
  );
  return xml;
}

async function setUp(dataDir: string, fillPlan: object | null = PLAN_WITH_COVER) {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  assert.equal(
    (await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile })).code,
    0,
  );
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
  const l = await runCli(["record", "put", "listing", LISTING, "--input", "-"], {
    dataDir,
    input: {
      source: "greenhouse",
      board: "greenhouse:acme",
      company: "Acme",
      source_job_id: "101",
      title: "Senior Backend Engineer",
      location: "London",
      url: "https://job-boards.greenhouse.io/acme/jobs/101",
      description: "Design and build Application Programming Interfaces. Kafka is a plus.",
      aliases: [{ id: LISTING, url: "https://job-boards.greenhouse.io/acme/jobs/101" }],
      sightings: [],
      gone: false,
      application_id: APP,
      screen: { outcome: "shortlist" },
    },
  });
  assert.equal(l.code, 0, l.stdout);
  const a = await runCli(["record", "put", "application", APP, "--input", "-"], {
    dataDir,
    input: {
      origin: "picked",
      listing: LISTING,
      company: "Acme",
      title: "Senior Backend Engineer",
      status: "picked",
      event_log: [
        {
          at: "2026-01-14T10:00:00.000Z",
          stage: "screen",
          from: null,
          to: "picked",
          reason: "Picked from the Shortlist.",
          approval: null,
        },
      ],
      gmail_threads: [],
      answers: [],
      fill_plan: fillPlan,
      tailor: null,
      decision_tree: null,
    },
  });
  assert.equal(a.code, 0, a.stdout);
  const t = await runCli(["tailor", "record", APP, "--input", judgment("tailor-judgment")], {
    dataDir,
  });
  assert.equal(t.code, 0, t.stdout);
}

const letter = (): Any => JSON.parse(readFileSync(judgment("cover-letter-judgment"), "utf8"));
const record = (dataDir: string, input: unknown = letter(), args: string[] = []) =>
  runCli(["tailor", "cover-letter", "record", APP, ...args, "--input", "-"], { dataDir, input });
const folder = (dataDir: string) => join(dataDir, "tailor", APP);
const application = async (dataDir: string): Promise<Any> =>
  (await runCli(["record", "get", "application", APP], { dataDir })).json.record;

test("no cover letter when the Fill plan has no cover-letter field and the job seeker didn't ask", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, PLAN_WITHOUT_COVER);
  const before = readdirSync(folder(dataDir)).sort();
  const pending = await runCli(["tailor", "cover-letter", "pending", APP], { dataDir });
  assert.equal(pending.code, 1);
  assert.equal((pending.json as Any).error.code, "COVER_LETTER_NOT_NEEDED");
  const listed = await runCli(["tailor", "cover-letter", "pending"], { dataDir });
  assert.deepEqual(listed.json.applications, []);
  const r = await record(dataDir);
  assert.equal(r.code, 1);
  assert.equal((r.json as Any).error.code, "COVER_LETTER_NOT_NEEDED");
  assert.deepEqual(readdirSync(folder(dataDir)).sort(), before);
  assert.equal((await application(dataDir)).tailor.cover_letter, undefined);
});

test("a cover-letter field in the Fill plan triggers it, and the worker gets facts but no identity", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await runCli(["tailor", "cover-letter", "pending"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  const apps = r.json.applications as Any[];
  assert.equal(apps.length, 1);
  assert.equal(apps[0].application_id, APP);
  assert.equal(apps[0].trigger, "fill_plan");
  assert.match(apps[0].description, /Kafka is a plus/);
  assert.ok(apps[0].facts.some((f: Any) => f.ref === "experience.0.bullets.0"));
  assert.doesNotMatch(r.stdout, /ada@example\.com|\+44 7700/);
});

test("an unmapped cover-letter field in the Fill plan triggers it too", async (t) => {
  const dataDir = tempDir(t);
  const plan = {
    ...PLAN_WITH_COVER,
    state: "paused",
    fields: [],
    unmappable: [{ ...COVER_FIELD, name: "question_9", label: "Cover letter", reason: "none yet" }],
  };
  await setUp(dataDir, plan);
  const r = await runCli(["tailor", "cover-letter", "pending", APP], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  assert.equal((r.json.applications as Any[])[0].trigger, "fill_plan");
});

test("the job seeker's request triggers it when the Fill plan has no such field", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, PLAN_WITHOUT_COVER);
  const pending = await runCli(["tailor", "cover-letter", "pending", APP, "--requested", "yes"], {
    dataDir,
  });
  assert.equal(pending.code, 0, pending.stdout);
  assert.equal((pending.json.applications as Any[])[0].trigger, "requested");
  const r = await record(dataDir, letter(), ["--requested", "yes"]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal((await application(dataDir)).tailor.cover_letter.trigger, "requested");
});

test("a Tailored Application with no Fill plan yet can still get one on request", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, null);
  assert.equal((await record(dataDir)).code, 1);
  assert.equal((await record(dataDir, letter(), ["--requested", "yes"])).code, 0);
});

test("the cover letter is stored beside the resume files under a neutral name", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await record(dataDir);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(readdirSync(folder(dataDir)).sort(), [
    "Ada-Example-Cover-Letter.docx",
    "Ada-Example-Cover-Letter.md",
    "Ada-Example-Cover-Letter.pdf",
    "Ada-Example-Resume.docx",
    "Ada-Example-Resume.md",
    "Ada-Example-Resume.pdf",
    "cover-letter.json",
    "notes.json",
    "notes.md",
  ]);
  const paths = r.json.paths as Record<string, string>;
  assert.equal(paths.docx, join(folder(dataDir), "Ada-Example-Cover-Letter.docx"));
  for (const f of ["docx", "pdf"]) {
    assert.ok(statSync(paths[f] as string).size < 2.5 * 1024 * 1024);
  }
  const md = readFileSync(paths.md as string, "utf8");
  const lines = md.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines[0], "# Ada Example");
  assert.match(lines[1] ?? "", /ada@example\.com/);
  assert.match(md, /Dear Acme hiring team,/);
  assert.ok(md.indexOf("needs a backend engineer") < md.indexOf("helping colleagues grow"));
  assert.doesNotMatch(md, /\|---|<table/);
  const app = await application(dataDir);
  assert.equal(app.tailor.cover_letter.files.docx, "Ada-Example-Cover-Letter.docx");
  assert.equal(app.tailor.cover_letter.trigger, "fill_plan");
  assert.equal(app.status, "tailored");
});

test("the DOCX is single-column text and the PDF is text-based, with the sender in the body", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await record(dataDir);
  const paths = r.json.paths as Record<string, string>;
  const xml = docxXml(paths.docx as string);
  for (const banned of ["<w:tbl", "<w:cols", "<w:drawing", "<w:pict", "<w:txbxContent"]) {
    assert.ok(!xml.includes(banned), `document.xml has ${banned}`);
  }
  assert.ok(!/headerReference|footerReference/.test(xml));
  assert.match(xml, /ada@example\.com/);
  assert.match(xml, /needs a backend engineer/);
  const pdf = readFileSync(paths.pdf as string, "latin1");
  assert.ok(pdf.startsWith("%PDF-1."));
  assert.match(pdf, /\/BaseFont \/Helvetica/);
  assert.doesNotMatch(pdf, /\/Subtype \/Image|\/XObject|\/Annots|\/Columns/);
  assert.match(pdf, /\(Ada Example\) Tj/);
});

test("an unbacked keyword is refused like Tailor refuses one, and nothing is written", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const j = letter();
  j.body[0].text += " I have also run Kafka clusters.";
  const r = await record(dataDir, j);
  assert.equal(r.code, 1);
  assert.equal((r.json as Any).error.code, "JUDGMENT_INVALID");
  assert.match((r.json as Any).error.message, /Kafka/);
  assert.equal(existsSync(join(folder(dataDir), "Ada-Example-Cover-Letter.docx")), false);
});

test("a claim with no real Base resume fact behind it is refused", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const noSource = letter();
  noSource.opening.sources = [];
  const fake = letter();
  fake.body[0].sources = ["experience.9.bullets.0"];
  const number = letter();
  number.body[0].text += " I grew revenue by 300% in a year.";
  for (const [bad, pattern] of [
    [noSource, /opening/],
    [fake, /experience\.9/],
    [number, /300/],
  ] as const) {
    const r = await record(dataDir, bad);
    assert.equal(r.code, 1);
    assert.equal((r.json as Any).error.code, "JUDGMENT_INVALID");
    assert.match((r.json as Any).error.message, pattern);
  }
  assert.equal(existsSync(join(folder(dataDir), "Ada-Example-Cover-Letter.docx")), false);
});

test("a paragraph that restates a resume bullet is refused", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const j = letter();
  j.body[0].text =
    "Cut card authorisation latency by 40% by moving fraud checks off the hot path. That is my best story.";
  j.body[0].sources = ["experience.0.bullets.0"];
  const r = await record(dataDir, j);
  assert.equal(r.code, 1);
  assert.equal((r.json as Any).error.code, "JUDGMENT_INVALID");
  assert.match((r.json as Any).error.message, /restates/);
});

test("tailoring the resume again keeps the cover letter, and recording it again replaces it", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  assert.equal((await record(dataDir)).code, 0);
  const again = await runCli(["tailor", "record", APP, "--input", judgment("tailor-judgment")], {
    dataDir,
  });
  assert.equal(again.code, 0, again.stdout);
  assert.ok(existsSync(join(folder(dataDir), "Ada-Example-Cover-Letter.pdf")));
  assert.equal((await application(dataDir)).tailor.cover_letter.revision, 1);
  const second = await record(dataDir);
  assert.equal(second.code, 0, second.stdout);
  assert.equal((await application(dataDir)).tailor.cover_letter.revision, 2);
  const pending = await runCli(["tailor", "cover-letter", "pending", APP], { dataDir });
  assert.ok((pending.json.applications as Any[])[0].previous);
});
