// HTML to plain text for Listing descriptions: Listings store text, never raw HTML.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
};

/** Decode HTML character references once. Unknown named entities are left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

const BLOCK =
  "p|div|section|article|header|footer|h[1-6]|ul|ol|table|tr|blockquote|pre|hr|dl|dt|dd";

/** Turn an HTML fragment into readable text: paragraphs as blank lines, list items as "- ". */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(text)
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/^-\n+/gm, "- ") // a list item whose text sits in its own paragraph
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(- [^\n]*)\n\n(?=- )/gm, "$1\n") // keep a list's items together
    .trim();
}
