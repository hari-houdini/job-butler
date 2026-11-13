// Resume intake for setup: keep a copy of the job seeker's resume in <data dir>/sources/ and
// return its text so the setup skill can build the Base resume. DOCX and plain text are read
// here; a PDF is kept and the skill reads it with its own Read tool (no PDF parser in a
// dependency-free core).
import { mkdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ensureSafeDataDir } from "./data-dir.ts";
import { CoreError } from "./errors.ts";
import { writeThenReplace } from "./store.ts";

const FORMATS: Record<string, "pdf" | "docx" | "text"> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".txt": "text",
  ".md": "text",
  ".text": "text",
};

export interface ImportedResume {
  format: "pdf" | "docx" | "text";
  /** The copy in the data directory. */
  path: string;
  /** The `source` value Base resume facts from this file should carry. */
  source: string;
  /** Extracted text; null for a PDF. */
  text: string | null;
}

export async function importResume(dataDir: string, file: string): Promise<ImportedResume> {
  const format = FORMATS[extname(file).toLowerCase()];
  if (format === undefined) {
    throw new CoreError(
      "RESUME_FORMAT",
      `Job Butler reads resumes as PDF, DOCX or text (.txt, .md), not ${extname(file) || "this file"}. ` +
        "Export your resume to one of those and try again.",
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (e) {
    throw new CoreError("NOT_FOUND", `Can't read ${file}: ${(e as Error).message}`);
  }
  const text =
    format === "text" ? bytes.toString("utf8") : format === "docx" ? docxText(bytes, file) : null;

  await ensureSafeDataDir(dataDir);
  const dir = join(dataDir, "sources");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, basename(file));
  await writeThenReplace(path, bytes);
  return { format, path, source: `resume: ${basename(file)}`, text };
}

// ---- DOCX: a zip holding word/document.xml ----

function badDocx(file: string): CoreError {
  return new CoreError(
    "RESUME_FORMAT",
    `${file} isn't a readable DOCX file. Save it again from your editor, or export it as PDF.`,
  );
}

/** Read one entry from a zip archive (stored or deflated). */
function zipEntry(zip: Buffer, name: string, file: string): Buffer | undefined {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw badDocx(file);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw badDocx(file);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entryName = zip.toString("utf8", at + 46, at + 46 + nameLen);
    if (entryName === name) {
      const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(dataAt, dataAt + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw badDocx(file);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function docxText(bytes: Buffer, file: string): string {
  let xml: string;
  try {
    const entry = zipEntry(bytes, "word/document.xml", file);
    if (entry === undefined) throw badDocx(file);
    xml = entry.toString("utf8");
  } catch (e) {
    if (e instanceof CoreError) throw e;
    throw badDocx(file);
  }
  const paragraphs = xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs
    .map((p) =>
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
        .map((m) => (m[0] === "<w:tab/>" ? "\t" : m[0] === "<w:br/>" ? "\n" : (m[1] ?? "")))
        .join(""),
    )
    .join("\n")
    .replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-fA-F]+);/g, (_, n, d, h) =>
      n ? (ENTITIES[n] as string) : String.fromCodePoint(d ? Number(d) : Number.parseInt(h, 16)),
    );
}
