// Tailor (#44): a tailored resume for each Picked Application. The tailor worker selects,
// reorders and rephrases Base resume facts in the advert's words and returns a JSON
// judgment; this module checks it against the Base resume, renders Markdown, DOCX and PDF
// (document.ts), writes one folder per Application and moves the Application to Tailored.
// Rules and shapes: docs/agents/core-conventions.md, "Tailor".
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Block, type DocumentModel, renderDocument } from "./document.ts";
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
import { isObject, type Problems } from "./validate.ts";

/** How many Applications the skill tailors in parallel, one worker each. */
export const BATCH_SIZE = 3;
export const MAX_SUMMARY_WORDS = 60;
export const MAX_FILE_BYTES = 2.5 * 1024 * 1024;

// ---------------------------------------------------------------------------------------
// Base resume facts

export interface Fact {
  ref: string;
  kind: string;
  text: string;
}

export type Item = Record<string, unknown>;
export const items = (v: unknown): Item[] => (Array.isArray(v) ? v.filter(isObject) : []);
export const textOrEmpty = (v: unknown): string => (typeof v === "string" ? v : "");

const roleText = (e: Item) => `${textOrEmpty(e.title)}, ${textOrEmpty(e.employer)}`;
const schoolText = (e: Item) => `${textOrEmpty(e.qualification)}, ${textOrEmpty(e.institution)}`;
const certText = (c: Item) =>
  [textOrEmpty(c.name), textOrEmpty(c.issuer)].filter(Boolean).join(", ");

/** Every Base resume fact with a stable reference ("experience.0.bullets.1"). */
export function baseFacts(baseResume: unknown): Fact[] {
  const br = isObject(baseResume) ? baseResume : {};
  const facts: Fact[] = [];
  if (isObject(br.summary))
    facts.push({ ref: "summary", kind: "summary", text: textOrEmpty(br.summary.text) });
  for (const [i, e] of items(br.experience).entries()) {
    facts.push({ ref: `experience.${i}`, kind: "role", text: roleText(e) });
    for (const [j, b] of items(e.bullets).entries()) {
      facts.push({
        ref: `experience.${i}.bullets.${j}`,
        kind: "bullet",
        text: textOrEmpty(b.text),
      });
    }
  }
  for (const [i, e] of items(br.education).entries()) {
    facts.push({ ref: `education.${i}`, kind: "education", text: schoolText(e) });
  }
  for (const [i, s] of items(br.skills).entries()) {
    facts.push({ ref: `skills.${i}`, kind: "skill", text: textOrEmpty(s.name) });
  }
  for (const [i, p] of items(br.projects).entries()) {
    facts.push({
      ref: `projects.${i}`,
      kind: "project",
      text: [textOrEmpty(p.name), textOrEmpty(p.description)].filter(Boolean).join(": "),
    });
  }
  for (const [i, c] of items(br.certifications).entries()) {
    facts.push({ ref: `certifications.${i}`, kind: "certification", text: certText(c) });
  }
  return facts;
}

// ---------------------------------------------------------------------------------------
// The judgment

interface Bullet {
  text: string;
  source: string;
}
export interface Keyword {
  keyword: string;
  abbreviation: string | null;
  advert_quote: string;
  status: "used" | "gap";
}
export interface Judgment {
  fit_summary: string;
  summary: { text: string; sources: string[] };
  experience: { fact: string; bullets: Bullet[] }[];
  education: { fact: string }[];
  skills: { fact: string }[];
  projects: { fact: string }[];
  certifications: { fact: string }[];
  keywords: Keyword[];
  changes: string[];
}

const SECTIONS = ["education", "skills", "projects", "certifications"] as const;

function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
}

export function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** One piece of resume text in reading order, for the keyword rules. */
export interface Run {
  where: "summary" | "bullet" | "other";
  text: string;
  source?: string;
}

function check(
  j: unknown,
  facts: Fact[],
  runs: Run[],
): { judgment?: Judgment; problems: Problems } {
  const problems: Problems = [];
  if (!isObject(j)) return { problems: ["the judgment must be a JSON object"] };
  const refs = new Map(facts.map((f) => [f.ref, f]));
  const text = (v: unknown, path: string): v is string => {
    if (typeof v === "string" && v.trim() !== "") return true;
    problems.push(`${path} must be a non-empty string`);
    return false;
  };
  const list = (v: unknown, path: string): unknown[] => {
    if (Array.isArray(v)) return v;
    problems.push(`${path} must be a list`);
    return [];
  };
  const fact = (ref: unknown, path: string, prefix: string): string | undefined => {
    if (typeof ref !== "string" || !refs.has(ref)) {
      problems.push(`${path} names "${String(ref)}", which isn't a Base resume fact`);
      return undefined;
    }
    if (!ref.startsWith(prefix)) {
      problems.push(`${path} ("${ref}") belongs in ${prefix.replace(/\.$/, "")}`);
      return undefined;
    }
    return ref;
  };

  text(j.fit_summary, "fit_summary");
  if (!isObject(j.summary)) {
    problems.push("summary must be {text, sources}");
  } else if (text(j.summary.text, "summary.text")) {
    if (words(j.summary.text) > MAX_SUMMARY_WORDS) {
      problems.push(
        `summary is ${words(j.summary.text)} words; keep it to ${MAX_SUMMARY_WORDS} or fewer`,
      );
    }
    const sources = list(j.summary.sources, "summary.sources");
    if (sources.length === 0)
      problems.push("summary.sources must name the Base resume facts it draws on");
    sources.forEach((s, i) => void fact(s, `summary.sources[${i}]`, ""));
    runs.push({ where: "summary", text: j.summary.text });
  }

  const roles = new Set<string>();
  list(j.experience, "experience").forEach((role, i) => {
    const at = `experience[${i}]`;
    if (!isObject(role)) {
      problems.push(`${at} must be {fact, bullets}`);
      return;
    }
    const ref = fact(role.fact, `${at}.fact`, "experience.");
    if (ref === undefined) return;
    if (ref.split(".").length !== 2) {
      problems.push(`${at}.fact must be a role such as "experience.0"`);
      return;
    }
    if (roles.has(ref)) problems.push(`${at}.fact repeats ${ref}`);
    roles.add(ref);
    runs.push({
      where: "other",
      text: roleText({
        title: refs.get(ref)?.text.split(", ")[0],
        employer: refs.get(ref)?.text.split(", ").slice(1).join(", "),
      }),
    });
    list(role.bullets, `${at}.bullets`).forEach((b, k) => {
      const bp = `${at}.bullets[${k}]`;
      if (!isObject(b)) {
        problems.push(`${bp} must be {text, source}`);
        return;
      }
      const ok = text(b.text, `${bp}.text`);
      const src = b.source;
      if (typeof src !== "string" || !refs.has(src)) {
        problems.push(`${bp}.source names "${String(src)}", which isn't a Base resume fact`);
      } else if (src !== ref && !src.startsWith(`${ref}.`)) {
        problems.push(`${bp}.source "${src}" isn't a fact of its own role ${ref}`);
      } else if (ok) {
        runs.push({ where: "bullet", text: b.text as string, source: src });
      }
    });
  });

  for (const section of SECTIONS) {
    const seen = new Set<string>();
    list(j[section], section).forEach((entry, i) => {
      const ref = isObject(entry)
        ? fact(entry.fact, `${section}[${i}].fact`, `${section}.`)
        : undefined;
      if (ref === undefined) {
        if (!isObject(entry)) problems.push(`${section}[${i}] must be {fact}`);
        return;
      }
      if (seen.has(ref)) problems.push(`${section}[${i}].fact repeats ${ref}`);
      seen.add(ref);
      runs.push({ where: "other", text: refs.get(ref)?.text ?? "" });
    });
  }

  list(j.keywords, "keywords").forEach((k, i) => {
    const at = `keywords[${i}]`;
    if (!isObject(k)) {
      problems.push(`${at} must be {keyword, abbreviation, advert_quote, status}`);
      return;
    }
    text(k.keyword, `${at}.keyword`);
    text(k.advert_quote, `${at}.advert_quote`);
    if (
      k.abbreviation !== null &&
      !(typeof k.abbreviation === "string" && k.abbreviation.trim() !== "")
    ) {
      problems.push(`${at}.abbreviation must be a string or null`);
    }
    if (k.status !== "used" && k.status !== "gap")
      problems.push(`${at}.status must be "used" or "gap"`);
  });
  list(j.changes, "changes").forEach((c, i) => void text(c, `changes[${i}]`));
  return problems.length > 0 ? { problems } : { judgment: j as unknown as Judgment, problems };
}

const terms = (k: Keyword): string[] => [k.keyword, ...(k.abbreviation ? [k.abbreviation] : [])];
const mentions = (run: Run, k: Keyword) => terms(k).some((t) => termPattern(t).test(run.text));

export function keywordProblems(keywords: Keyword[], runs: Run[]): Problems {
  const problems: Problems = [];
  for (const k of keywords) {
    if (k.status === "gap") {
      const run = runs.find((r) => mentions(r, k));
      if (run) {
        problems.push(
          `"${k.keyword}" is on the gaps list but the resume mentions it ("${run.text.slice(0, 60)}"); no fact backs it, so take it out of the resume`,
        );
      }
      continue;
    }
    if (!runs.some((r) => r.where === "bullet" && mentions(r, k))) {
      problems.push(
        `"${k.keyword}" is marked used but appears in no bullet; put it in a backed achievement or move it to gaps`,
      );
      continue;
    }
    const first = runs.find((r) => mentions(r, k)) as Run;
    if (first.where !== "bullet") {
      problems.push(
        `"${k.keyword}" first appears outside a bullet (${first.where === "summary" ? "in the summary" : "in a heading"}); keywords belong inside a backed achievement`,
      );
      continue;
    }
    if (k.abbreviation) {
      const full = termPattern(`${k.keyword} (${k.abbreviation})`);
      const abbr = termPattern(k.abbreviation);
      const fullAt = first.text.search(termPattern(k.keyword));
      const abbrAt = first.text.search(abbr);
      const spelled = full.test(first.text) && (abbrAt < 0 || fullAt <= abbrAt);
      if (!spelled) {
        problems.push(
          `"${k.keyword}" must be written in full with its abbreviation at first use: "${k.keyword} (${k.abbreviation})"`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// Rendering

export function contactLines(identity: Item): string[] {
  const first = [
    textOrEmpty(identity.email),
    textOrEmpty(identity.phone),
    textOrEmpty(identity.location),
  ].filter(Boolean);
  const links = items(identity.links).map((l) => `${textOrEmpty(l.label)}: ${textOrEmpty(l.url)}`);
  return [first.join(" | "), links.join(" | ")].filter(Boolean);
}

const dates = (e: Item) =>
  e.start ? `${textOrEmpty(e.start)} - ${textOrEmpty(e.end) || "Present"}` : textOrEmpty(e.end);

/** The resume as a document model: the Base resume's own fields, the judgment's words. */
function buildDocument(identity: Item, br: Item, j: Judgment): DocumentModel {
  const blocks: Block[] = [{ kind: "title", text: textOrEmpty(identity.name) || "Resume" }];
  for (const line of contactLines(identity)) blocks.push({ kind: "line", text: line });
  blocks.push({ kind: "heading", text: "Summary" }, { kind: "paragraph", text: j.summary.text });
  const at = (section: string, ref: string): Item =>
    items(br[section])[Number(ref.split(".")[1])] as Item;
  if (j.experience.length > 0) blocks.push({ kind: "heading", text: "Experience" });
  for (const role of j.experience) {
    const e = at("experience", role.fact);
    const meta = [textOrEmpty(e.location), dates(e)].filter(Boolean).join(" | ");
    blocks.push({ kind: "entry", text: roleText(e), ...(meta ? { meta } : {}) });
    for (const b of role.bullets) blocks.push({ kind: "bullet", text: b.text });
  }
  if (j.projects.length > 0) blocks.push({ kind: "heading", text: "Projects" });
  for (const p of j.projects) {
    const e = at("projects", p.fact);
    blocks.push({
      kind: "entry",
      text: textOrEmpty(e.name),
      ...(e.url ? { meta: textOrEmpty(e.url) } : {}),
    });
    if (e.description) blocks.push({ kind: "paragraph", text: textOrEmpty(e.description) });
  }
  if (j.education.length > 0) blocks.push({ kind: "heading", text: "Education" });
  for (const s of j.education) {
    const e = at("education", s.fact);
    blocks.push({ kind: "entry", text: schoolText(e), ...(dates(e) ? { meta: dates(e) } : {}) });
  }
  if (j.skills.length > 0) {
    blocks.push(
      { kind: "heading", text: "Skills" },
      {
        kind: "paragraph",
        text: j.skills.map((s) => textOrEmpty(at("skills", s.fact).name)).join(", "),
      },
    );
  }
  if (j.certifications.length > 0) blocks.push({ kind: "heading", text: "Certifications" });
  for (const c of j.certifications) {
    const e = at("certifications", c.fact);
    blocks.push({
      kind: "bullet",
      text: `${certText(e)}${e.date ? ` (${textOrEmpty(e.date)})` : ""}`,
    });
  }
  return { blocks };
}

/** "Ada Example" -> "Ada-Example": ASCII letters and digits, hyphen-separated. */
export function neutralName(name: string, kind: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug === "" ? "Applicant" : slug}-${kind}`;
}

// ---------------------------------------------------------------------------------------
// Commands

const folderOf = (applicationId: string) => join("tailor", applicationId);
export const judgmentsFile = (dataDir: string, applicationId: string) =>
  join(dataDir, "inbox", `tailor-${encodeURIComponent(applicationId)}.json`);

async function readPrevious(dataDir: string, app: StoredRecord): Promise<unknown> {
  const folder = (app.tailor as { folder?: unknown } | null)?.folder;
  if (typeof folder !== "string") return null;
  try {
    const notes = JSON.parse(await readFile(join(dataDir, folder, "notes.json"), "utf8"));
    return notes.judgment ?? null;
  } catch {
    return null;
  }
}

function assertTailorable(app: StoredRecord | undefined, id: string): StoredRecord {
  if (app === undefined) throw notFound("application", id);
  if (app.origin !== "picked" || typeof app.listing !== "string") {
    throw new CoreError(
      "NOT_TAILORABLE",
      `${app.company} · ${app.title} wasn't picked from a Listing, so Tailor has no advert to work from.`,
      { application_id: id },
    );
  }
  return app;
}

/** `tailor pending [<application-id>...]`: the material for one worker per Application. */
export async function tailorPending(dataDir: string, ids: string[]) {
  await assertProfileComplete(dataDir);
  const profile = (await readProfile(dataDir)) as Item;
  const base = profile.base_resume;
  const facts = baseFacts(base);
  const apps =
    ids.length > 0
      ? await Promise.all(
          ids.map(async (id) => assertTailorable(await getRecord(dataDir, "application", id), id)),
        )
      : (await listRecords(dataDir, "application")).filter(
          (a) =>
            a.origin === "picked" &&
            a.status === "picked" &&
            !a.tailor &&
            typeof a.listing === "string",
        );
  const applications = [];
  for (const app of apps) {
    const listing = await getRecord(dataDir, "listing", app.listing as string);
    applications.push({
      application_id: app.id,
      listing_id: app.listing,
      company: app.company,
      title: app.title,
      location: listing?.location ?? null,
      description: listing?.description ?? "",
      // Only what the tailoring needs; never identity or contact details.
      base_resume: base,
      facts,
      previous: await readPrevious(dataDir, app),
      judgments_file: judgmentsFile(dataDir, app.id),
    });
  }
  return { batch_size: BATCH_SIZE, applications };
}

function keywordTable(keywords: Keyword[], runs: Run[]) {
  return keywords.map((k) => ({
    keyword: k.keyword,
    abbreviation: k.abbreviation,
    advert_quote: k.advert_quote,
    status: k.status,
    used_in: runs
      .filter((r) => r.where === "bullet" && mentions(r, k))
      .map((r) => ({ source: r.source, text: r.text })),
  }));
}

function tableText(table: ReturnType<typeof keywordTable>): string {
  const width = Math.max(7, ...table.map((k) => k.keyword.length));
  return table
    .map((k) => {
      const where =
        k.status === "gap"
          ? "no backing fact"
          : `${k.used_in.length} bullet${k.used_in.length === 1 ? "" : "s"}`;
      return `${k.keyword.padEnd(width)}  ${k.status.padEnd(4)}  ${where}`;
    })
    .join("\n");
}

function notesMarkdown(args: {
  company: string;
  title: string;
  j: Judgment;
  table: ReturnType<typeof keywordTable>;
  sources: { where: string; text: string; source: string; source_text: string }[];
}): string {
  const { j, table, sources } = args;
  const rows = table.map(
    (k) =>
      `| ${k.keyword} | ${k.status} | ${k.abbreviation ?? "-"} | ${k.status === "gap" ? "-" : k.used_in.map((u) => u.source).join(", ")} |`,
  );
  const gaps = table.filter((k) => k.status === "gap");
  return [
    `# Tailor notes: ${args.title}, ${args.company}`,
    "",
    "## Fit summary",
    "",
    j.fit_summary,
    "",
    "## Keywords",
    "",
    "| Keyword | Status | Abbreviation | Used in |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## Gaps",
    "",
    ...(gaps.length > 0 ? gaps.map((g) => `- ${g.keyword}: ${g.advert_quote}`) : ["None."]),
    "",
    "## Changes",
    "",
    ...j.changes.map((c) => `- ${c}`),
    "",
    "## Sources",
    "",
    ...sources.map((s) => `- ${s.where}: "${s.text}" <- ${s.source} ("${s.source_text}")`),
    "",
  ].join("\n");
}

/** The cover letter's files (#47), which a resume re-record leaves alone. */
function coverLetterFiles(app: StoredRecord): string[] {
  const c = (app.tailor as { cover_letter?: { files?: Record<string, string> } } | null)
    ?.cover_letter;
  return c?.files ? Object.values(c.files) : [];
}

/** `tailor record <application-id> --input <file>`: check, render, write, mark Tailored. */
export async function tailorRecord(dataDir: string, id: string | undefined, input: unknown) {
  if (id === undefined) throw usageError("tailor record: <application-id> is required");
  const app = assertTailorable(await getRecord(dataDir, "application", id), id);
  await assertProfileComplete(dataDir);
  const profile = (await readProfile(dataDir)) as Item;
  const identity = (isObject(profile.identity) ? profile.identity : {}) as Item;
  const br = (isObject(profile.base_resume) ? profile.base_resume : {}) as Item;
  const facts = baseFacts(br);

  const runs: Run[] = [];
  const checked = check(input, facts, runs);
  const j = checked.judgment;
  const problems = [...checked.problems];
  if (j) problems.push(...keywordProblems(j.keywords, runs));
  if (!j || problems.length > 0) {
    throw new CoreError(
      "JUDGMENT_INVALID",
      `The tailor worker's resume isn't usable, so nothing was written: ${problems.join("; ")}.`,
      { problems },
    );
  }

  const document = buildDocument(identity, br, j);
  const rendered = renderDocument(document);
  const base = neutralName(textOrEmpty(identity.name), "Resume");
  const names = { md: `${base}.md`, docx: `${base}.docx`, pdf: `${base}.pdf` };
  for (const [kind, size] of [
    ["DOCX", rendered.docx.length],
    ["PDF", rendered.pdf.length],
  ] as const) {
    if (size > MAX_FILE_BYTES) {
      throw new CoreError(
        "RENDER_TOO_LARGE",
        `The ${kind} came out at ${(size / 1048576).toFixed(1)} MB, over the 2.5 MB limit ATS parsers accept. Shorten the resume and try again.`,
      );
    }
  }

  const factText = new Map(facts.map((f) => [f.ref, f.text]));
  const sources = [
    ...j.summary.sources.map((s) => ({
      where: "summary",
      text: j.summary.text,
      source: s,
      source_text: factText.get(s) ?? "",
    })),
    ...j.experience.flatMap((r) =>
      r.bullets.map((b) => ({
        where: "bullet",
        text: b.text,
        source: b.source,
        source_text: factText.get(b.source) ?? "",
      })),
    ),
  ];
  const table = keywordTable(j.keywords, runs);
  const gaps = table.filter((k) => k.status === "gap").map((k) => k.keyword);
  const previous = app.tailor as { revision?: number; cover_letter?: unknown } | null;
  const revision = (previous?.revision ?? 0) + 1;
  const at = timestamp();
  const folder = folderOf(app.id);
  const dir = join(dataDir, folder);
  const notes = {
    application_id: app.id,
    listing_id: app.listing,
    company: app.company,
    title: app.title,
    revision,
    tailored_at: at,
    fit_summary: j.fit_summary,
    keywords: table,
    gaps,
    changes: j.changes,
    sources,
    judgment: j,
  };

  await withWriter(dataDir, "tailor record", async (w) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const files: [string, string | Buffer][] = [
      [names.md, rendered.markdown],
      [names.docx, rendered.docx],
      [names.pdf, rendered.pdf],
      ["notes.json", `${JSON.stringify(notes, null, 2)}\n`],
      [
        "notes.md",
        notesMarkdown({
          company: textOrEmpty(app.company),
          title: textOrEmpty(app.title),
          j,
          table,
          sources,
        }),
      ],
    ];
    for (const [name, content] of files) await writeThenReplace(join(dir, name), content);
    for (const stale of await readdir(dir)) {
      const kept = coverLetterFiles(app);
      if (!files.some(([name]) => name === stale) && !kept.includes(stale))
        await rm(join(dir, stale), { recursive: true, force: true });
    }
    const { schema_version: _v, id: _i, created_at: _c, updated_at: _u, ...fields } = app;
    const eventLog = [...(app.event_log as unknown[])];
    let status = app.status;
    if (app.status === "picked") {
      eventLog.push({
        at,
        stage: "tailor",
        from: "picked",
        to: "tailored",
        reason: `Tailored resume written (revision ${revision}).`,
        approval: null,
      });
      status = "tailored";
    }
    await w.put("application", app.id, {
      ...fields,
      status,
      event_log: eventLog,
      tailor: {
        ...(previous?.cover_letter ? { cover_letter: previous.cover_letter } : {}),
        folder,
        files: { ...names, notes: "notes.md", notes_json: "notes.json" },
        revision,
        tailored_at: at,
        fit_summary: j.fit_summary,
        gaps,
      },
    });
  });

  return {
    application_id: app.id,
    company: app.company,
    title: app.title,
    revision,
    fit_summary: j.fit_summary,
    keywords: table,
    gaps,
    changes: j.changes,
    folder: dir,
    paths: {
      md: join(dir, names.md),
      docx: join(dir, names.docx),
      pdf: join(dir, names.pdf),
      notes: join(dir, "notes.md"),
    },
    text: tableText(table),
  };
}
