// Tailor's cover letter (#47). A letter is made only when the Application's Fill plan has a
// cover-letter field or the job seeker asks. The tailor worker (agents/tailor-worker.md, "Cover
// letter") returns a JSON judgment; this module checks every claim against the Base resume,
// renders the letter with the resume's renderer and constraints (document.ts) and stores it in
// the Application's Tailor folder. Rules and shapes: docs/agents/core-conventions.md,
// "Cover letter".
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Block, renderDocument } from "./document.ts";
import { timestamp } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";
import { assertProfileComplete, readProfile } from "./profile.ts";
import {
  getRecord,
  listRecords,
  notFound,
  type StoredRecord,
  withWriter,
  writeThenReplace,
} from "./store.ts";
import {
  baseFacts,
  contactLines,
  type Item,
  judgmentsFile,
  type Keyword,
  keywordProblems,
  MAX_FILE_BYTES,
  neutralName,
  type Run,
  str,
  words,
} from "./tailor.ts";
import { isObject, type Problems } from "./validate.ts";

export const MAX_OPENING_WORDS = 70;
export const MAX_LETTER_WORDS = 350;
const COVER_FIELD = /cover[\s_-]*letter/i;

type Trigger = "fill_plan" | "requested";
interface Paragraph {
  text: string;
  sources: string[];
}
export interface CoverLetterJudgment {
  opening: Paragraph;
  body: Paragraph[];
  closing: string;
  keywords: Keyword[];
}

interface Field {
  name?: unknown;
  label?: unknown;
}

/** Whether the stored Fill plan has a cover-letter field, filled or unmapped. */
function planHasCoverField(app: StoredRecord): boolean {
  const plan = app.fill_plan;
  if (!isObject(plan)) return false;
  const all = [
    ...(Array.isArray(plan.fields) ? plan.fields : []),
    ...(Array.isArray(plan.unmappable) ? plan.unmappable : []),
  ];
  return all.some((f: Field) => COVER_FIELD.test(`${str(f?.name)} ${str(f?.label)}`));
}

function triggerOf(app: StoredRecord, requested: boolean): Trigger | null {
  if (planHasCoverField(app)) return "fill_plan";
  return requested ? "requested" : null;
}

function assertWanted(app: StoredRecord | undefined, id: string, requested: boolean): Trigger {
  if (app === undefined) throw notFound("application", id);
  if (!isObject(app.tailor)) {
    throw new CoreError(
      "NOT_TAILORED",
      `${app.company} · ${app.title} has no tailored resume yet; run Tailor first.`,
      { application_id: id },
    );
  }
  const trigger = triggerOf(app, requested);
  if (trigger === null) {
    throw new CoreError(
      "COVER_LETTER_NOT_NEEDED",
      `${app.company} · ${app.title}: the form has no cover-letter field and no cover letter was requested, so none is written.`,
      { application_id: id },
    );
  }
  return trigger;
}

const coverJudgmentsFile = (dataDir: string, id: string) =>
  judgmentsFile(dataDir, id).replace(/tailor-([^/]*)$/, "cover-$1");

async function readNotes(dataDir: string, app: StoredRecord): Promise<Item> {
  const folder = (app.tailor as { folder?: unknown } | null)?.folder;
  if (typeof folder !== "string") return {};
  try {
    return JSON.parse(await readFile(join(dataDir, folder, "cover-letter.json"), "utf8"));
  } catch {
    return {};
  }
}

/** `tailor cover-letter pending [<application-id>...] [--requested yes]` */
export async function coverLetterPending(dataDir: string, ids: string[], requested: boolean) {
  await assertProfileComplete(dataDir);
  const profile = (await readProfile(dataDir)) as Item;
  const base = profile.base_resume;
  const facts = baseFacts(base);
  const wanted: { app: StoredRecord; trigger: Trigger }[] = [];
  if (ids.length > 0) {
    for (const id of ids) {
      const app = await getRecord(dataDir, "application", id);
      wanted.push({ app: app as StoredRecord, trigger: assertWanted(app, id, requested) });
    }
  } else {
    for (const app of await listRecords(dataDir, "application")) {
      const t = app.tailor as { cover_letter?: unknown } | null;
      if (isObject(t) && !t.cover_letter && planHasCoverField(app)) {
        wanted.push({ app, trigger: "fill_plan" });
      }
    }
  }
  const applications = [];
  for (const { app, trigger } of wanted) {
    const listing = await getRecord(dataDir, "listing", String(app.listing));
    const tailor = app.tailor as { fit_summary?: string; gaps?: string[] };
    applications.push({
      application_id: app.id,
      listing_id: app.listing,
      company: app.company,
      title: app.title,
      location: listing?.location ?? null,
      description: listing?.description ?? "",
      trigger,
      // Never identity or contact details.
      base_resume: base,
      facts,
      fit_summary: tailor.fit_summary ?? "",
      gaps: tailor.gaps ?? [],
      previous: (await readNotes(dataDir, app)).judgment ?? null,
      judgments_file: coverJudgmentsFile(dataDir, app.id),
    });
  }
  return { applications };
}

// ---------------------------------------------------------------------------------------
// The judgment

const numbers = (text: string): string[] => text.match(/\d+(?:[.,]\d+)*/g) ?? [];
const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

function check(
  j: unknown,
  facts: Map<string, string>,
  resumeText: string[],
  runs: Run[],
): { judgment?: CoverLetterJudgment; problems: Problems } {
  const problems: Problems = [];
  if (!isObject(j)) return { problems: ["the judgment must be a JSON object"] };

  const paragraph = (p: unknown, at: string): Paragraph | undefined => {
    if (!isObject(p) || typeof p.text !== "string" || p.text.trim() === "") {
      problems.push(`${at} must be {text, sources}`);
      return undefined;
    }
    const sources: unknown[] = Array.isArray(p.sources) ? p.sources : [];
    if (sources.length === 0) {
      problems.push(`${at} must name the Base resume facts it draws on (sources)`);
    }
    for (const s of sources) {
      if (typeof s !== "string" || !facts.has(s)) {
        problems.push(`${at} cites "${String(s)}", which isn't a Base resume fact`);
      }
    }
    const backing = sources.map((s) => facts.get(String(s)) ?? "").join(" ");
    for (const n of numbers(p.text)) {
      if (!numbers(backing).includes(n)) {
        problems.push(`${at} states "${n}", which none of its sources back`);
      }
    }
    const text = flat(p.text);
    const restated = resumeText.find((r) => words(r) >= 5 && text.includes(flat(r)));
    if (restated !== undefined) {
      problems.push(
        `${at} restates the resume ("${restated.slice(0, 50)}"); add context and motivation instead`,
      );
    }
    runs.push({ where: "bullet", text: p.text, source: String(sources[0] ?? "") });
    return { text: p.text, sources: sources.map(String) };
  };

  const opening = paragraph(j.opening, "opening");
  if (opening && words(opening.text) > MAX_OPENING_WORDS) {
    problems.push(
      `opening is ${words(opening.text)} words; keep it to ${MAX_OPENING_WORDS} or fewer`,
    );
  }
  const body: Paragraph[] = [];
  if (!Array.isArray(j.body) || j.body.length === 0)
    problems.push("body must list at least one paragraph");
  else
    j.body.forEach((p, i) => {
      const b = paragraph(p, `body[${i}]`);
      if (b) body.push(b);
    });
  if (typeof j.closing !== "string" || j.closing.trim() === "") {
    problems.push("closing must be a non-empty string");
  } else {
    // The closing carries no claims: no figures, and no gap keyword (checked below).
    if (numbers(j.closing).length > 0)
      problems.push("closing states a figure; the closing makes no claims");
    runs.push({ where: "other", text: j.closing });
  }
  const keywords = Array.isArray(j.keywords) ? j.keywords : [];
  keywords.forEach((k, i) => {
    if (
      !isObject(k) ||
      typeof k.keyword !== "string" ||
      (k.status !== "used" && k.status !== "gap") ||
      (k.abbreviation !== null && typeof k.abbreviation !== "string")
    ) {
      problems.push(`keywords[${i}] must be {keyword, abbreviation, advert_quote, status}`);
    }
  });
  if (opening?.text && body.length > 0) {
    const total = words([opening.text, ...body.map((b) => b.text), str(j.closing)].join(" "));
    if (total > MAX_LETTER_WORDS) {
      problems.push(`the letter is ${total} words; keep it to ${MAX_LETTER_WORDS} or fewer`);
    }
  }
  if (problems.length > 0 || !opening) return { problems };
  return {
    judgment: { opening, body, closing: str(j.closing), keywords: keywords as Keyword[] },
    problems,
  };
}

function buildDocument(identity: Item, company: string, j: CoverLetterJudgment) {
  const name = str(identity.name) || "Applicant";
  const blocks: Block[] = [{ kind: "title", text: name }];
  for (const line of contactLines(identity)) blocks.push({ kind: "line", text: line });
  blocks.push({ kind: "paragraph", text: `Dear ${company} hiring team,` });
  blocks.push({ kind: "paragraph", text: j.opening.text });
  for (const b of j.body) blocks.push({ kind: "paragraph", text: b.text });
  blocks.push({ kind: "paragraph", text: j.closing });
  blocks.push({ kind: "paragraph", text: "Sincerely," }, { kind: "paragraph", text: name });
  return { blocks };
}

/** `tailor cover-letter record <application-id> --input <file> [--requested yes]` */
export async function coverLetterRecord(
  dataDir: string,
  id: string | undefined,
  input: unknown,
  requested: boolean,
) {
  if (id === undefined)
    throw usageError("tailor cover-letter record: <application-id> is required");
  const app = (await getRecord(dataDir, "application", id)) as StoredRecord | undefined;
  const trigger = assertWanted(app, id, requested);
  const found = app as StoredRecord;
  await assertProfileComplete(dataDir);
  const profile = (await readProfile(dataDir)) as Item;
  const identity = (isObject(profile.identity) ? profile.identity : {}) as Item;
  const factList = baseFacts(profile.base_resume);
  const facts = new Map(factList.map((f) => [f.ref, f.text]));

  // What the resume already says: the Base resume's text and the tailored bullets.
  const resumeText = factList
    .filter((f) => f.kind === "bullet" || f.kind === "summary")
    .map((f) => f.text);
  const folder = String((found.tailor as { folder?: unknown }).folder);
  try {
    const notes = JSON.parse(await readFile(join(dataDir, folder, "notes.json"), "utf8"));
    for (const role of notes.judgment?.experience ?? [])
      for (const b of role.bullets ?? []) resumeText.push(String(b.text));
    resumeText.push(String(notes.judgment?.summary?.text ?? ""));
  } catch {
    // No notes to compare against; the Base resume check still applies.
  }

  const runs: Run[] = [];
  const checked = check(input, facts, resumeText, runs);
  const j = checked.judgment;
  const problems = [...checked.problems];
  if (j) problems.push(...keywordProblems(j.keywords, runs));
  if (!j || problems.length > 0) {
    throw new CoreError(
      "JUDGMENT_INVALID",
      `The tailor worker's cover letter isn't usable, so nothing was written: ${problems.join("; ")}.`,
      { problems },
    );
  }

  const rendered = renderDocument(buildDocument(identity, str(found.company), j));
  const base = neutralName(str(identity.name), "Cover-Letter");
  const names = { md: `${base}.md`, docx: `${base}.docx`, pdf: `${base}.pdf` };
  for (const [kind, size] of [
    ["DOCX", rendered.docx.length],
    ["PDF", rendered.pdf.length],
  ] as const) {
    if (size > MAX_FILE_BYTES) {
      throw new CoreError(
        "RENDER_TOO_LARGE",
        `The cover letter ${kind} came out at ${(size / 1048576).toFixed(1)} MB, over the 2.5 MB limit ATS parsers accept. Shorten the letter and try again.`,
      );
    }
  }

  const sources = [
    { where: "opening", text: j.opening.text, sources: j.opening.sources },
    ...j.body.map((b) => ({ where: "body", text: b.text, sources: b.sources })),
  ].map((s) => ({ ...s, source_texts: s.sources.map((r) => facts.get(r) ?? "") }));
  const tailor = found.tailor as { revision?: number; cover_letter?: { revision?: number } };
  const revision = (tailor.cover_letter?.revision ?? 0) + 1;
  const at = timestamp();
  const dir = join(dataDir, folder);

  await withWriter(dataDir, "tailor cover-letter record", async (w) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const notes = {
      application_id: found.id,
      revision,
      trigger,
      written_at: at,
      sources,
      judgment: j,
    };
    const files: [string, string | Buffer][] = [
      [names.md, rendered.markdown],
      [names.docx, rendered.docx],
      [names.pdf, rendered.pdf],
      ["cover-letter.json", `${JSON.stringify(notes, null, 2)}\n`],
    ];
    for (const [name, content] of files) await writeThenReplace(join(dir, name), content);
    const { schema_version: _v, id: _i, created_at: _c, updated_at: _u, ...fields } = found;
    await w.put("application", found.id, {
      ...fields,
      tailor: {
        ...tailor,
        cover_letter: {
          files: { ...names, notes: "cover-letter.json" },
          revision,
          trigger,
          written_at: at,
        },
      },
    });
  });

  return {
    application_id: found.id,
    company: found.company,
    title: found.title,
    trigger,
    revision,
    folder: dir,
    paths: {
      md: join(dir, names.md),
      docx: join(dir, names.docx),
      pdf: join(dir, names.pdf),
      notes: join(dir, "cover-letter.json"),
    },
    text: [j.opening.text, ...j.body.map((b) => b.text), j.closing].join("\n\n"),
  };
}
