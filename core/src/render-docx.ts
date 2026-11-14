// DOCX writer, no dependencies: a DOCX is a zip of a few XML parts. The package holds only
// document, styles and numbering parts: no header, footer, media, table or section columns.
import { crc32, deflateRawSync } from "node:zlib";
import type { Block, DocumentModel } from "./document.ts";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function stripControlChars(text: string): string {
  return [...text]
    .filter((c) => {
      const n = c.charCodeAt(0);
      return n >= 32 || n === 9 || n === 10 || n === 13;
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraph(style: string, text: string, numbered = false): string {
  const num = numbered ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "";
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${num}</w:pPr><w:r><w:t xml:space="preserve">${stripControlChars(text)}</w:t></w:r></w:p>`;
}

function blockXml(b: Block): string {
  switch (b.kind) {
    case "title":
      return paragraph("Title", b.text);
    case "heading":
      return paragraph("Heading1", b.text);
    case "entry":
      return paragraph("Heading2", b.text) + (b.meta ? paragraph("Normal", b.meta) : "");
    case "bullet":
      return paragraph("ListParagraph", b.text, true);
    default:
      return paragraph("Normal", b.text);
  }
}

const style = (
  id: string,
  name: string,
  size: number,
  bold: boolean,
  before: number,
  after: number,
) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>` +
  `<w:pPr><w:spacing w:before="${before}" w:after="${after}"/></w:pPr>` +
  `<w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/></w:rPr></w:style>`;

const STYLES =
  `${XML}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr>` +
  '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="21"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  style("Title", "Title", 36, true, 0, 60) +
  style("Heading1", "heading 1", 24, true, 200, 80) +
  style("Heading2", "heading 2", 21, true, 100, 20) +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:ind w:left="360"/><w:spacing w:after="40"/></w:pPr></w:style></w:styles>';

const NUMBERING =
  `${XML}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>` +
  '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>' +
  '<w:pPr><w:ind w:left="360" w:hanging="260"/></w:pPr></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

const CONTENT_TYPES =
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>';

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS =
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOC_RELS =
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/></Relationships>`;

/** A zip archive of deflated entries with a fixed timestamp, so output is reproducible. */
function zip(entries: [string, string][]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

export function render(doc: DocumentModel): Buffer {
  const body = doc.blocks.map(blockXml).join("");
  // A section with a page size and margins only: no columns, header or footer references.
  const section =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
  const document = `${XML}<w:document ${W}><w:body>${body}${section}</w:body></w:document>`;
  return zip([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", RELS],
    ["word/document.xml", document],
    ["word/_rels/document.xml.rels", DOC_RELS],
    ["word/styles.xml", STYLES],
    ["word/numbering.xml", NUMBERING],
  ]);
}
