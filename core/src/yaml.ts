// A small YAML subset for the human-edited files (Profile, Preferences). The core has no
// runtime dependencies, so this reads and writes only what those files need:
//   block mappings and sequences, comments, plain / "double" / 'single' quoted scalars,
//   null, booleans, numbers, `[]`, `{}`, flow sequences of scalars `[a, b]`, and the
//   block scalars `|`, `|-`, `>`, `>-`.
// Anything else (anchors, tags, flow mappings, several documents) is refused with the line
// number, so a hand edit never silently turns into something else.

export class YamlError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

interface Line {
  no: number;
  indent: number;
  text: string; // content after the indentation, comment not yet stripped
}

const KEY_RE =
  /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#[\]{}&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+|$)/;

export function parseYaml(source: string): unknown {
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  const lines: Line[] = [];
  raw.forEach((l, i) => {
    if (/^\s*(#.*)?$/.test(l)) return;
    if (/^\t/.test(l)) throw new YamlError(i + 1, "use spaces, not tabs, for indentation");
    const indent = l.length - l.trimStart().length;
    const text = l.slice(indent);
    if (indent === 0 && (text === "---" || text === "...")) {
      if (text === "---" && lines.length === 0) return;
      throw new YamlError(i + 1, "only one YAML document is supported");
    }
    lines.push({ no: i + 1, indent, text });
  });
  if (lines.length === 0) return null;
  const p = new Parser(lines, raw);
  const first = lines[0] as Line;
  const value = p.block(first.indent);
  const rest = p.peek();
  if (rest) throw new YamlError(rest.no, "unexpected indentation");
  return value;
}

class Parser {
  private i = 0;
  private readonly lines: Line[];
  private readonly raw: string[];

  constructor(lines: Line[], raw: string[]) {
    this.lines = lines;
    this.raw = raw;
  }

  peek(): Line | undefined {
    return this.lines[this.i];
  }

  block(indent: number): unknown {
    const line = this.peek() as Line;
    return isSeqItem(line.text) ? this.sequence(indent) : this.mapping(indent);
  }

  mapping(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let line = this.peek(); line && line.indent === indent; line = this.peek()) {
      if (isSeqItem(line.text)) throw new YamlError(line.no, "expected a `key: value` line here");
      const m = KEY_RE.exec(line.text);
      if (!m) throw new YamlError(line.no, "expected a `key: value` line");
      const key = unquoteKey(m[1] as string, line.no);
      if (Object.hasOwn(out, key)) throw new YamlError(line.no, `duplicate key "${key}"`);
      const rest = stripComment(line.text.slice(m[0].length), line.no);
      this.i++;
      out[key] = this.valueAfter(rest, indent, line, true);
    }
    const next = this.peek();
    if (next && next.indent > indent) throw new YamlError(next.no, "unexpected indentation");
    return out;
  }

  sequence(indent: number): unknown[] {
    const out: unknown[] = [];
    for (let line = this.peek(); line && line.indent === indent; line = this.peek()) {
      if (!isSeqItem(line.text)) break;
      const content = line.text.slice(1).trimStart();
      const offset = line.text.length - content.length;
      if (content === "" || content.startsWith("#")) {
        this.i++;
        out.push(this.valueAfter("", indent, line, false));
      } else if (KEY_RE.test(content) || isSeqItem(content)) {
        // "- key: value": the item is a mapping (or nested sequence) starting on this line.
        line.indent = indent + offset;
        line.text = content;
        out.push(this.block(line.indent));
      } else {
        this.i++;
        out.push(this.valueAfter(stripComment(content, line.no), indent, line, false));
      }
    }
    const next = this.peek();
    if (next && next.indent > indent) throw new YamlError(next.no, "unexpected indentation");
    return out;
  }

  /** The value following `key:` or `-`, either inline (`rest`) or as a nested block. */
  private valueAfter(rest: string, indent: number, line: Line, inMapping: boolean): unknown {
    if (/^[|>][-+]?$/.test(rest)) return this.blockScalar(rest, indent, line);
    if (rest !== "") return scalar(rest, line.no);
    const next = this.peek();
    if (next && next.indent > indent) return this.block(next.indent);
    // YAML lets a mapping's sequence value sit at the key's own indentation.
    if (inMapping && next && next.indent === indent && isSeqItem(next.text)) {
      return this.sequence(indent);
    }
    return null;
  }

  private blockScalar(header: string, indent: number, line: Line): string {
    const folded = header.startsWith(">");
    const chomp = header.endsWith("-") ? "strip" : header.endsWith("+") ? "keep" : "clip";
    const body: string[] = [];
    let blockIndent: number | undefined;
    let r = line.no; // raw index of the next line (line numbers are 1-based)
    while (r < this.raw.length) {
      const l = this.raw[r] as string;
      const ind = l.length - l.trimStart().length;
      if (l.trim() === "") {
        body.push("");
        r++;
        continue;
      }
      if (ind <= indent) break;
      blockIndent ??= ind;
      if (ind < blockIndent)
        throw new YamlError(r + 1, "block text is less indented than its first line");
      body.push(l.slice(blockIndent));
      r++;
    }
    // Skip the structural lines that belonged to the block.
    while (this.peek() && (this.peek() as Line).no <= r) this.i++;
    while (body.length > 0 && body[body.length - 1] === "" && chomp !== "keep") body.pop();
    let text = folded
      ? // Folded: a single line break becomes a space; each blank line becomes one "\n".
        body.reduce((acc, l, k) => {
          if (k === 0) return l;
          if (l === "") return `${acc}\n`;
          return body[k - 1] === "" ? `${acc}${l}` : `${acc} ${l}`;
        }, "")
      : body.join("\n");
    if (chomp !== "strip" && body.length > 0) text += "\n";
    return text;
  }
}

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ") || text.startsWith("-\t");
}

function unquoteKey(key: string, no: number): string {
  if (key.startsWith('"') || key.startsWith("'")) return scalar(key, no) as string;
  return key.trimEnd();
}

/** Remove a trailing ` # comment` outside quotes. */
function stripComment(text: string, no: number): string {
  let quote: string | undefined;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) {
      if (c === "\\" && quote === '"') k++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      if (k === 0 || /[\s[,]/.test(text[k - 1] as string)) quote = c;
    } else if (c === "#" && (k === 0 || /\s/.test(text[k - 1] as string))) {
      return text.slice(0, k).trimEnd();
    }
  }
  if (quote) throw new YamlError(no, "unterminated quoted text");
  return text.trimEnd();
}

function scalar(text: string, no: number): unknown {
  if (text.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) throw new YamlError(no, `bad quoted text: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new YamlError(no, `bad escape in quoted text: ${text}`);
    }
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw new YamlError(no, `bad quoted text: ${text}`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new YamlError(no, `unterminated list: ${text}`);
    return splitFlow(text.slice(1, -1), no).map((item) => {
      if (/^[[{]/.test(item))
        throw new YamlError(no, "nested lists or mappings inside [ ] aren't supported");
      return scalar(item, no);
    });
  }
  if (/^[{&*!%@`]/.test(text) || text.startsWith("? ")) {
    throw new YamlError(no, `unsupported YAML syntax: ${text}`);
  }
  if (/^(null|Null|NULL|~)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  if (/:\s/.test(text)) throw new YamlError(no, `quote text that contains ": ": ${text}`);
  return text;
}

function splitFlow(inner: string, no: number): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k] as string;
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') cur += inner[++k] ?? "";
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ",") {
      items.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (quote) throw new YamlError(no, "unterminated quoted text");
  if (cur.trim() !== "") items.push(cur.trim());
  if (items.some((x) => x === "")) throw new YamlError(no, "empty item in [ ]");
  return items;
}

// ---- writing ----

const PLAIN_RE = /^[A-Za-z][A-Za-z0-9 _.,'()/&+@-]*$/;
const RESERVED =
  /^(null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|y|Y|n|N)$/;

function str(s: string): string {
  return PLAIN_RE.test(s) && !RESERVED.test(s) && !s.endsWith(" ") ? s : JSON.stringify(s);
}

function key(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k);
}

function inline(v: unknown): string | undefined {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("YAML can't hold a non-finite number");
    return String(v);
  }
  if (typeof v === "string") return str(v);
  if (Array.isArray(v) && v.length === 0) return "[]";
  if (typeof v === "object" && Object.keys(v as object).length === 0) return "{}";
  return undefined;
}

/**
 * Serialise plain JSON data. `comments` maps a dotted key path (e.g. "schedule.enabled")
 * to a comment line written above that key.
 */
export function stringifyYaml(value: unknown, comments: Record<string, string> = {}): string {
  const out: string[] = [];
  write(value, 0, "", out, comments);
  return `${out.join("\n")}\n`;
}

function write(
  v: unknown,
  indent: number,
  path: string,
  out: string[],
  comments: Record<string, string>,
): void {
  const pad = " ".repeat(indent);
  const simple = inline(v);
  if (simple !== undefined) {
    out.push(pad + simple);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = inline(item);
      if (s !== undefined) {
        out.push(`${pad}- ${s}`);
        continue;
      }
      const start = out.length;
      write(item, indent + 2, path, out, {});
      // Turn the item's first line into "- first".
      out[start] = `${pad}- ${(out[start] as string).slice(indent + 2)}`;
    }
    return;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    const comment = comments[p];
    if (comment !== undefined) for (const c of comment.split("\n")) out.push(`${pad}# ${c}`);
    const s = inline(val);
    if (s !== undefined) {
      out.push(`${pad}${key(k)}: ${s}`);
    } else {
      out.push(`${pad}${key(k)}:`);
      write(val, Array.isArray(val) ? indent + 2 : indent + 2, p, out, comments);
    }
  }
}
