// Generates a command's usage line from its declaration (commands.ts), so the positionals and
// the input kind are written once. Summary text stays hand-written in the registry.

/** A positional argument. `name` may hold text such as "withdrawn|no_response". */
export interface Positional {
  name: string;
  /** Printed in square brackets: zero or more allowed. */
  optional?: true;
  /** Printed with "...": one or more (or zero, with `optional`). */
  variadic?: true;
  /** Printed after the variadic marker, e.g. "all" in "<listing-id>...|all". */
  alternative?: string;
}

/** A flag that takes a value. Optional flags print in square brackets. */
export interface Flag {
  name: string;
  value: string;
  optional?: true;
}

export type InputDeclaration =
  /** --input <file>|- (stdin or a file), with an optional hint in parentheses. */
  | { kind: "file"; hint?: string }
  /** --input followed by a literal example of the JSON shape. */
  | { kind: "inline"; example: string }
  /** Hook JSON on stdin, printed as "< example". */
  | { kind: "stdin"; example: string };

export interface Declaration {
  positionals?: Positional[];
  flags?: Flag[];
  input?: InputDeclaration;
  /** Flags printed after the input, when the usage line puts them there. */
  trailingFlags?: Flag[];
}

function renderPositional(p: Positional): string {
  const token = `<${p.name}>${p.variadic ? "..." : ""}${p.alternative ? `|${p.alternative}` : ""}`;
  return p.optional ? `[${token}]` : token;
}

function renderFlag(f: Flag): string {
  const token = `--${f.name} ${f.value}`;
  return f.optional ? `[${token}]` : token;
}

function renderInput(input: InputDeclaration): string {
  switch (input.kind) {
    case "file":
      return input.hint === undefined ? "--input <file>|-" : `--input <file>|- (${input.hint})`;
    case "inline":
      return `--input ${input.example}`;
    case "stdin":
      return `< ${input.example}`;
  }
}

/** The one-line usage shown by `help` and in the "--input is required" refusal. */
export function renderUsage(name: string, declaration: Declaration = {}): string {
  const parts = [
    name,
    ...(declaration.positionals ?? []).map(renderPositional),
    ...(declaration.flags ?? []).map(renderFlag),
    ...(declaration.input === undefined ? [] : [renderInput(declaration.input)]),
    ...(declaration.trailingFlags ?? []).map(renderFlag),
  ];
  return parts.join(" ");
}
