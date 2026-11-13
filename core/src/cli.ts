#!/usr/bin/env node
// Job Butler core CLI. The single seam between Stage skills and the deterministic core.
//
//   node core/src/cli.ts <command> [args] [--data-dir <dir>] [--input <file>|-]
//
// Output: exactly one JSON object on stdout.
//   success: {"ok": true, ...}                                   exit 0
//   refusal: {"ok": false, "error": {"code", "message", ...}}    exit 1
//   usage:   {"ok": false, "error": {"code": "USAGE", ...}}      exit 2
// Input (LLM judgments, records): JSON from --input <file>, or --input - for stdin.
// See docs/agents/core-conventions.md.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { commands } from "./commands.ts";
import { resolveDataDir } from "./env.ts";
import { CoreError, usageError } from "./errors.ts";

export interface CommandContext {
  /** Positional arguments after the command name. */
  args: string[];
  /** Absolute path of the private data directory. */
  dataDir: string;
  /** String flags given on the command line (see `flagOptions`). */
  flags: Record<string, string | undefined>;
  /** Parse the JSON given with --input. Throws USAGE if absent or invalid. */
  readInput(): Promise<unknown>;
  /** Read stdin as text (hook commands, which Claude Code feeds on stdin). */
  readStdin(): Promise<string>;
}

export interface Command {
  /** One line shown by `help`, e.g. "record put <type> <id> --input <file>". */
  usage: string;
  summary: string;
  /** Print the result as is, without {"ok": true}: Claude Code hook commands only. */
  raw?: boolean;
  run(ctx: CommandContext): Promise<Record<string, unknown>>;
}

/** Every flag any command accepts. Add new ones here; all take a string value. */
const flagOptions = {
  "data-dir": { type: "string" },
  input: { type: "string" },
  "override-limit": { type: "string" },
  run: { type: "string" },
  section: { type: "string" },
  session: { type: "string" },
} as const;

async function main(argv: string[]): Promise<{ result: Record<string, unknown>; raw: boolean }> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof flagOptions; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: flagOptions, allowPositionals: true });
  } catch (e) {
    throw usageError((e as Error).message);
  }
  const { values, positionals } = parsed;

  // Longest matching command name wins, so "record put" beats "record".
  let name: string | undefined;
  for (let n = positionals.length; n > 0; n--) {
    const candidate = positionals.slice(0, n).join(" ");
    if (candidate in commands) {
      name = candidate;
      break;
    }
  }
  if (name === undefined || name === "help") {
    const list = Object.entries(commands).map(([n, c]) => ({
      name: n,
      usage: c.usage,
      summary: c.summary,
    }));
    return { result: { commands: list }, raw: false };
  }
  const command = commands[name] as Command;

  const ctx: CommandContext = {
    args: positionals.slice(name.split(" ").length),
    dataDir: resolveDataDir(values["data-dir"]),
    flags: values,
    async readInput() {
      const source = values.input;
      if (source === undefined)
        throw usageError(`${command.usage}: --input <file> or --input - is required`);
      const text = source === "-" ? await readStdin() : await readFile(source, "utf8");
      try {
        return JSON.parse(text);
      } catch (e) {
        throw usageError(`--input is not valid JSON: ${(e as Error).message}`);
      }
    },
    readStdin,
  };
  return { result: await command.run(ctx), raw: command.raw === true };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function print(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  const { result, raw } = await main(process.argv.slice(2));
  print(raw ? result : { ok: true, ...result });
} catch (e) {
  if (e instanceof CoreError) {
    print({ ok: false, error: { code: e.code, message: e.message, ...e.details } });
    process.exitCode = e.exitCode;
  } else {
    print({ ok: false, error: { code: "INTERNAL", message: String((e as Error)?.stack ?? e) } });
    process.exitCode = 70;
  }
}
