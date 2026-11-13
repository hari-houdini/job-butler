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

/** The names in a DOCX (zip) and a reader for one of them. */
function unzip(file: string): Map<string, Buffer> {
  const zip = readFileSync(file);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
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
    out.set(name, method === 8 ? inflateRawSync(data) : data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function setUp(dataDir: string, name = "Ada Example", extraApp: object = {}) {
  const profile = JSON.parse(readFileSync(judgment("setup-profile"), "utf8"));
  profile.identity.name = name;
  const p = await runCli(["profile", "put", "--input", "-"], { dataDir, input: profile });
  assert.equal(p.code, 0, p.stdout);
  assert.equal((await runCli(["preferences", "init"], { dataDir })).code, 0);
  const listing = {
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
  };
  const l = await runCli(["record", "put", "listing", LISTING, "--input", "-"], {
    dataDir,
    input: listing,
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
      fill_plan: null,
      tailor: null,
      decision_tree: null,
      ...extraApp,
    },
  });
  assert.equal(a.code, 0, a.stdout);
}

function worker(): Any {
  return JSON.parse(readFileSync(judgment("tailor-judgment"), "utf8"));
}

async function record(dataDir: string, input: unknown = worker()) {
  return runCli(["tailor", "record", APP, "--input", "-"], { dataDir, input });
}

test("tailor pending hands the worker the advert and numbered Base resume facts, never identity", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await runCli(["tailor", "pending"], { dataDir });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.batch_size, 3);
  const apps = r.json.applications as Any[];
  assert.equal(apps.length, 1);
  assert.equal(apps[0]?.application_id, APP);
  assert.equal(apps[0]?.company, "Acme");
  assert.match(apps[0]?.description, /Kafka is a plus/);
  const refs = ((apps[0]?.facts ?? []) as { ref: string }[]).map((f) => f.ref);
  for (const ref of [
    "summary",
    "experience.0",
    "experience.0.bullets.0",
    "experience.0.bullets.1",
    "education.0",
    "skills.1",
  ]) {
    assert.ok(refs.includes(ref), `missing fact ${ref}`);
  }
  assert.doesNotMatch(r.stdout, /ada@example\.com|\+44 7700/);
});

test("tailor record renders md, docx and pdf with neutral names in one folder per Application", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await record(dataDir);
  assert.equal(r.code, 0, r.stdout);
  const folder = join(dataDir, "tailor", APP);
  assert.deepEqual(readdirSync(folder).sort(), [
    "Ada-Example-Resume.docx",
    "Ada-Example-Resume.md",
    "Ada-Example-Resume.pdf",
    "notes.json",
    "notes.md",
  ]);
  const paths = r.json.paths as Record<string, string>;
  assert.equal(paths.docx, join(folder, "Ada-Example-Resume.docx"));
  assert.equal(paths.pdf, join(folder, "Ada-Example-Resume.pdf"));
  for (const f of ["docx", "pdf"]) {
    assert.ok(statSync(paths[f] as string).size < 2.5 * 1024 * 1024);
  }
  const md = readFileSync(paths.md as string, "utf8");
  const lines = md.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines[0], "# Ada Example");
  assert.match(lines[1] ?? "", /ada@example\.com/);
  // The Listing-specific summary sits right under the contact line, before any role.
  assert.ok(md.indexOf("a fit for Acme's payments") < md.indexOf("Northwind Payments"));
  assert.match(md, /^- Cut card authorisation latency by 40%.*\(API\)/m);
  assert.doesNotMatch(md, /\|---|<table/);
});

test("the DOCX is single-column text: no tables, columns, text boxes, images, headers or footers", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await record(dataDir);
  const parts = unzip((r.json.paths as Record<string, string>).docx as string);
  const names = [...parts.keys()];
  assert.ok(names.includes("word/document.xml"));
  assert.ok(names.includes("[Content_Types].xml"));
  assert.deepEqual(
    names.filter((n) => /header|footer|media|embeddings|drawings/i.test(n)),
    [],
  );
  const xml = (parts.get("word/document.xml") as Buffer).toString("utf8");
  for (const banned of [
    "<w:tbl",
    "<w:cols",
    "<w:drawing",
    "<w:pict",
    "<w:txbxContent",
    "<mc:Alt",
  ]) {
    assert.ok(!xml.includes(banned), `document.xml has ${banned}`);
  }
  assert.ok(!/headerReference|footerReference/.test(xml));
  assert.match(xml, /Ada Example/);
  assert.match(xml, /ada@example\.com/);
  assert.match(xml, /Mentored four engineers\./);
});

test("the PDF is text-based: standard font, readable text, no images or annotations", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await record(dataDir);
  const pdf = readFileSync((r.json.paths as Record<string, string>).pdf as string, "latin1");
  assert.ok(pdf.startsWith("%PDF-1."));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  assert.match(pdf, /\/BaseFont \/Helvetica/);
  assert.doesNotMatch(pdf, /\/Subtype \/Image|\/XObject|\/Annots|\/Columns/);
  assert.match(pdf, /\(Ada Example\) Tj/);
  assert.match(pdf, /\(Mentored four engineers\.\) Tj/);
});

test("text with XML and PDF special characters survives both renderers", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const j = worker();
  j.experience[0].bullets[1].text = "Led R&D <fast> teams (four) \\ at scale: 'ok' – “done”.";
  j.keywords = j.keywords.filter((k: { keyword: string }) => k.keyword !== "Mentored");
  const r = await record(dataDir, j);
  assert.equal(r.code, 0, r.stdout);
  const paths = r.json.paths as Record<string, string>;
  const xml = (unzip(paths.docx as string).get("word/document.xml") as Buffer).toString("utf8");
  assert.match(xml, /Led R&amp;D &lt;fast&gt; teams/);
  const pdf = readFileSync(paths.pdf as string, "latin1");
  assert.ok(pdf.includes("Led R&D <fast> teams \\(four\\) \\\\ at scale"));
});

test("a long resume wraps onto more pages and stays under the size limit", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const j = worker();
  const bullets = Array.from({ length: 80 }, () => ({
    text: "Mentored four engineers across the payments platform and its on-call rota for a full year.",
    source: "experience.0.bullets.1",
  }));
  j.experience[0].bullets = [j.experience[0].bullets[0], ...bullets];
  const r = await record(dataDir, j);
  assert.equal(r.code, 0, r.stdout);
  const pdf = readFileSync((r.json.paths as Record<string, string>).pdf as string, "latin1");
  assert.ok((pdf.match(/\/Type \/Page\b/g) ?? []).length >= 3);
  assert.ok(
    statSync((r.json.paths as Record<string, string>).pdf as string).size < 2.5 * 1024 * 1024,
  );
});

test("neutral upload names come from the identity name, ASCII only", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir, "Zoë O'Brien");
  const r = await record(dataDir);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(readdirSync(join(dataDir, "tailor", APP)).sort(), [
    "Zoe-O-Brien-Resume.docx",
    "Zoe-O-Brien-Resume.md",
    "Zoe-O-Brien-Resume.pdf",
    "notes.json",
    "notes.md",
  ]);
});

test("the keyword table shows where each keyword is used, and the gaps list holds the unbacked ones", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const r = await record(dataDir);
  assert.equal(r.code, 0, r.stdout);
  const table = r.json.keywords as Any[];
  const api = table.find((k) => k.keyword === "Application Programming Interface");
  assert.equal(api?.status, "used");
  assert.deepEqual(
    api?.used_in.map((u: { source: string }) => u.source),
    ["experience.0.bullets.0"],
  );
  assert.deepEqual(r.json.gaps, ["Kafka"]);
  assert.match(r.json.fit_summary as string, /no Kafka/);
  assert.ok((r.json.changes as string[]).length > 0);
  assert.match(r.json.text as string, /Kafka\s+gap/);

  const notes = JSON.parse(readFileSync(join(dataDir, "tailor", APP, "notes.json"), "utf8"));
  assert.deepEqual(notes.gaps, ["Kafka"]);
  // Every bullet traces to the Base resume fact it came from.
  const sources = notes.sources as { text: string; source: string; source_text: string }[];
  const first = sources.find((s) => s.source === "experience.0.bullets.1");
  assert.equal(first?.source_text, "Mentored four engineers.");
  const md = readFileSync(join(dataDir, "tailor", APP, "notes.md"), "utf8");
  assert.match(md, /\| Kafka \| gap \|/);
});

test("recording moves the Application to Tailored once, and re-recording an edit replaces the files", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const first = await record(dataDir);
  assert.equal(first.json.revision, 1);
  const app = (await runCli(["record", "get", "application", APP], { dataDir })).json.record as Any;
  assert.equal(app.status, "tailored");
  assert.equal(app.event_log.at(-1).stage, "tailor");
  assert.equal(app.event_log.at(-1).approval, null);
  assert.equal(app.tailor.folder, join("tailor", APP));

  const edit = worker();
  edit.experience[0].bullets[1].text = "Mentored four engineers through promotion.";
  const second = await record(dataDir, edit);
  assert.equal(second.code, 0, second.stdout);
  assert.equal(second.json.revision, 2);
  const md = readFileSync(join(dataDir, "tailor", APP, "Ada-Example-Resume.md"), "utf8");
  assert.match(md, /through promotion/);
  const after = (await runCli(["record", "get", "application", APP], { dataDir })).json
    .record as Any;
  assert.equal(after.event_log.length, app.event_log.length);
  assert.equal(after.status, "tailored");

  const pending = await runCli(["tailor", "pending"], { dataDir });
  assert.deepEqual(pending.json.applications, []);
  const again = await runCli(["tailor", "pending", APP], { dataDir });
  assert.equal((again.json.applications as Any[]).length, 1);
  assert.match(JSON.stringify((again.json.applications as Any[])[0].previous), /through promotion/);
});

async function refused(dataDir: string, mutate: (j: Any) => void, match: RegExp) {
  const j = worker();
  mutate(j);
  const r = await record(dataDir, j);
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.error?.code, "JUDGMENT_INVALID");
  assert.match(r.json.error?.message ?? "", match);
  assert.equal(existsSync(join(dataDir, "tailor")), false, "nothing is written on a refusal");
  const app = (await runCli(["record", "get", "application", APP], { dataDir })).json.record as Any;
  assert.equal(app.status, "picked");
}

test("a bullet whose source is not a Base resume fact is refused", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await refused(
    dataDir,
    (j) => {
      j.experience[0].bullets[1].source = "experience.0.bullets.9";
    },
    /experience\.0\.bullets\.9/,
  );
});

test("a bullet may only draw on facts of its own role", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await refused(
    dataDir,
    (j) => {
      j.experience[0].bullets[1].source = "skills.0";
    },
    /own role/,
  );
});

test("a gap keyword that appears in the resume is refused", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await refused(
    dataDir,
    (j) => {
      j.experience[0].bullets[1].text = "Mentored four engineers on Kafka.";
    },
    /Kafka/,
  );
});

test("a used keyword needs its full form and abbreviation at first use", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await refused(
    dataDir,
    (j) => {
      j.experience[0].bullets[0].text = "Cut card authorisation latency by 40% in the payment API.";
    },
    /Application Programming Interface/,
  );
});

test("a used keyword in the summary, outside a backed achievement, is refused", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await refused(
    dataDir,
    (j) => {
      j.summary.text = "Backend engineer who mentored engineers and builds payment APIs.";
    },
    /Mentored|bullet/,
  );
});

test("a used keyword that appears in no bullet is refused", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await refused(
    dataDir,
    (j) => {
      j.keywords.push({
        keyword: "Terraform",
        abbreviation: null,
        advert_quote: "Terraform",
        status: "used",
      });
    },
    /Terraform/,
  );
});

test("the summary must be short and cite Base resume facts", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  await refused(
    dataDir,
    (j) => {
      j.summary.text = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
    },
    /summary/,
  );
  await refused(
    dataDir,
    (j) => {
      j.summary.sources = ["experience.7"];
    },
    /experience\.7/,
  );
});

test("tailor record refuses an unknown Application", async (t) => {
  const dataDir = tempDir(t);
  await setUp(dataDir);
  const missing = await runCli(["tailor", "record", "nope", "--input", "-"], {
    dataDir,
    input: worker(),
  });
  assert.equal(missing.json.error?.code, "NOT_FOUND");
});
