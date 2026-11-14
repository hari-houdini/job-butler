import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commands } from "../src/commands.ts";
import { renderUsage } from "../src/usage.ts";
import { FIXTURES, runCli, tempDir } from "./harness.ts";

// The usage lines as they were printed before commands declared them (D3 of #67). Every
// command's usage line must still match these, byte for byte.
const oldUsage: Record<string, string> = JSON.parse(
  readFileSync(join(FIXTURES, "command-usage.json"), "utf8"),
);

test("renderUsage prints the command name alone when nothing is declared", () => {
  assert.equal(renderUsage("help"), "help");
});

test("renderUsage prints required, optional and variadic positionals", () => {
  assert.equal(renderUsage("fetch", { positionals: [{ name: "url" }] }), "fetch <url>");
  assert.equal(
    renderUsage("tailor pending", {
      positionals: [{ name: "application-id", optional: true, variadic: true }],
    }),
    "tailor pending [<application-id>...]",
  );
  assert.equal(
    renderUsage("track dismiss", { positionals: [{ name: "n", variadic: true }] }),
    "track dismiss <n>...",
  );
});

test("renderUsage prints an alternative after a variadic positional, and keeps a name with a pipe", () => {
  assert.equal(
    renderUsage("screen rescore", {
      positionals: [{ name: "listing-id", variadic: true, alternative: "all" }],
    }),
    "screen rescore <listing-id>...|all",
  );
  assert.equal(
    renderUsage("track propose", {
      positionals: [{ name: "application-id" }, { name: "withdrawn|no_response" }],
      input: { kind: "inline", example: '{"reason": "..."}' },
    }),
    'track propose <application-id> <withdrawn|no_response> --input {"reason": "..."}',
  );
});

test("renderUsage prints flags in brackets when optional, bare when required", () => {
  assert.equal(
    renderUsage("profile get", { flags: [{ name: "section", value: "<name>", optional: true }] }),
    "profile get [--section <name>]",
  );
  assert.equal(
    renderUsage("run end", { flags: [{ name: "run", value: "<run_id>" }] }),
    "run end --run <run_id>",
  );
});

test("renderUsage prints a file input with its hint in parentheses", () => {
  assert.equal(
    renderUsage("apply plan", {
      positionals: [{ name: "application-id" }],
      input: { kind: "file", hint: "the apply worker's JSON" },
    }),
    "apply plan <application-id> --input <file>|- (the apply worker's JSON)",
  );
  assert.equal(
    renderUsage("record put", {
      positionals: [{ name: "type" }, { name: "id" }],
      input: { kind: "file" },
    }),
    "record put <type> <id> --input <file>|-",
  );
});

test("renderUsage prints an inline input and a stdin input as given", () => {
  assert.equal(
    renderUsage("apply answer", {
      positionals: [{ name: "application-id" }, { name: "field-name" }],
      input: { kind: "inline", example: '{"answer": "..."}' },
    }),
    'apply answer <application-id> <field-name> --input {"answer": "..."}',
  );
  assert.equal(
    renderUsage("hook pre-tool-use", { input: { kind: "stdin", example: "<PreToolUse JSON>" } }),
    "hook pre-tool-use < <PreToolUse JSON>",
  );
});

test("renderUsage puts flags before the input unless they are declared as trailing", () => {
  assert.equal(
    renderUsage("profile put", {
      flags: [{ name: "section", value: "<name>", optional: true }],
      input: { kind: "file" },
    }),
    "profile put [--section <name>] --input <file>|-",
  );
  assert.equal(
    renderUsage("tailor cover-letter record", {
      positionals: [{ name: "application-id" }],
      input: { kind: "file" },
      trailingFlags: [{ name: "requested", value: "yes", optional: true }],
    }),
    "tailor cover-letter record <application-id> --input <file>|- [--requested yes]",
  );
});

test("every command's generated usage line matches the usage line it had before D3", () => {
  assert.deepEqual(
    Object.keys(commands).sort(),
    Object.keys(oldUsage).sort(),
    "the set of commands changed",
  );
  for (const [name, usage] of Object.entries(oldUsage)) {
    assert.equal(commands[name]?.usage, usage, `usage of "${name}"`);
  }
});

test("help prints the same usage line for every command the registry declares", async (t) => {
  const r = await runCli(["help"], { dataDir: tempDir(t) });
  assert.equal(r.code, 0, r.stdout);
  const listed = Object.fromEntries(
    (r.json.commands as { name: string; usage: string }[]).map((c) => [c.name, c.usage]),
  );
  assert.deepEqual(listed, oldUsage);
});
