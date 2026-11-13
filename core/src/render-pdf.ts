// PDF writer, no dependencies: plain objects, the built-in Helvetica fonts (no embedded
// fonts, so no images or font files), one column of text-showing operators per page.
import type { Block, DocumentModel } from "./document.ts";

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 54;

/** Helvetica advance widths for ASCII 32..126, in 1/1000 em (Adobe core font metrics). */
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Characters outside Latin-1 that WinAnsi (the PDF font encoding used) has at 0x80-0x9F. */
const WIN_ANSI: Record<string, number> = {
  "€": 0x80,
  "…": 0x85,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "™": 0x99,
};

/** One character as a WinAnsi byte; anything the font can't show becomes "?". */
function encode(ch: string): number {
  const code = ch.codePointAt(0) as number;
  if (code >= 32 && code <= 126) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return WIN_ANSI[ch] ?? 63;
}

function widthOf(byte: number, bold: boolean): number {
  const w = byte >= 32 && byte <= 126 ? (WIDTHS[byte - 32] as number) : 556;
  return bold ? w * 1.08 : w; // Bold runs a little wider; measure on the safe side.
}

function measure(text: string, size: number, bold: boolean): number {
  let total = 0;
  for (const ch of text) total += widthOf(encode(ch), bold);
  return (total * size) / 1000;
}

function wrap(text: string, size: number, bold: boolean, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && measure(next, size, bold) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function literal(text: string): string {
  let out = "";
  for (const ch of text) {
    const byte = encode(ch);
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else out += String.fromCharCode(byte);
  }
  return out;
}

interface Placed {
  x: number;
  y: number;
  size: number;
  bold: boolean;
  text: string;
}

const STYLE: Record<Block["kind"], { size: number; bold: boolean; before: number; after: number }> =
  {
    title: { size: 18, bold: true, before: 0, after: 4 },
    line: { size: 10, bold: false, before: 0, after: 2 },
    heading: { size: 12, bold: true, before: 12, after: 4 },
    entry: { size: 10.5, bold: true, before: 6, after: 1 },
    paragraph: { size: 10.5, bold: false, before: 0, after: 4 },
    bullet: { size: 10.5, bold: false, before: 0, after: 2 },
  };

function layout(doc: DocumentModel): Placed[][] {
  const pages: Placed[][] = [[]];
  let y = PAGE_H - MARGIN;
  const place = (kind: Block["kind"], text: string, x: number, indent: number, bold: boolean) => {
    const s = STYLE[kind];
    const lead = s.size * 1.35;
    const lines = wrap(text, s.size, bold, PAGE_W - MARGIN - x - indent);
    for (const [i, line] of lines.entries()) {
      if (y - lead < MARGIN) {
        pages.push([]);
        y = PAGE_H - MARGIN;
      }
      y -= lead;
      (pages.at(-1) as Placed[]).push({
        x: x + (i === 0 ? 0 : indent),
        y,
        size: s.size,
        bold,
        text: line,
      });
    }
  };
  for (const b of doc.blocks) {
    const s = STYLE[b.kind];
    y -= s.before;
    if (b.kind === "bullet") {
      // Bullet glyph at the margin, text hanging at 14pt.
      const lines = wrap(b.text, s.size, false, PAGE_W - 2 * MARGIN - 14);
      for (const [i, line] of lines.entries()) {
        if (y - s.size * 1.35 < MARGIN) {
          pages.push([]);
          y = PAGE_H - MARGIN;
        }
        y -= s.size * 1.35;
        const page = pages.at(-1) as Placed[];
        if (i === 0) page.push({ x: MARGIN, y, size: s.size, bold: false, text: "•" });
        page.push({ x: MARGIN + 14, y, size: s.size, bold: false, text: line });
      }
    } else {
      place(b.kind, b.text, MARGIN, 0, s.bold);
      if (b.kind === "entry" && b.meta) place("line", b.meta, MARGIN, 0, false);
    }
    y -= s.after;
  }
  return pages;
}

export function render(doc: DocumentModel): Buffer {
  const pages = layout(doc);
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("");
  const pagesObj = add("");
  const regular = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const bold = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  const kids: number[] = [];
  for (const page of pages) {
    const ops = page
      .map(
        (p) =>
          `BT /${p.bold ? "F2" : "F1"} ${p.size} Tf ${p.x.toFixed(2)} ${p.y.toFixed(2)} Td (${literal(p.text)}) Tj ET`,
      )
      .join("\n");
    const content = add(
      `<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
