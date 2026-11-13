// The document model every rendered document (Tailor's resume, #44; the cover letter, #47)
// is written in. One model, three renderers: Markdown here, DOCX in render-docx.ts and PDF in
// render-pdf.ts. The model has no way to express a table, column, text box, image, header or
// footer, so a document built from it can't contain one.
import { render as renderDocx } from "./render-docx.ts";
import { render as renderPdf } from "./render-pdf.ts";

export type Block =
  /** The document's first line (the job seeker's name, or a letter's sender). */
  | { kind: "title"; text: string }
  /** A plain line under the title: contact details sit in the body, never a header. */
  | { kind: "line"; text: string }
  | { kind: "heading"; text: string }
  /** A role, school or project: a bold line, then an optional plain line (place, dates). */
  | { kind: "entry"; text: string; meta?: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string };

export interface DocumentModel {
  blocks: Block[];
}

export function toMarkdown(doc: DocumentModel): string {
  const out: string[] = [];
  let previous: Block["kind"] | undefined;
  for (const b of doc.blocks) {
    // Blank line between blocks, except inside a bullet list and under a title or entry.
    const tight =
      (previous === "bullet" && b.kind === "bullet") ||
      (previous === "title" && b.kind === "line") ||
      (previous === "line" && b.kind === "line");
    if (previous !== undefined && !tight) out.push("");
    switch (b.kind) {
      case "title":
        out.push(`# ${b.text}`);
        break;
      case "heading":
        out.push(`## ${b.text}`);
        break;
      case "entry":
        out.push(`### ${b.text}`);
        if (b.meta) out.push("", b.meta);
        break;
      case "bullet":
        out.push(`- ${b.text}`);
        break;
      default:
        out.push(b.text);
    }
    previous = b.kind;
  }
  return `${out.join("\n")}\n`;
}

export interface RenderedDocument {
  markdown: string;
  docx: Buffer;
  pdf: Buffer;
}

export function renderDocument(doc: DocumentModel): RenderedDocument {
  return { markdown: toMarkdown(doc), docx: renderDocx(doc), pdf: renderPdf(doc) };
}
