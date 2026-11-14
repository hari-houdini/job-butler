import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runCli, tempDir } from "./harness.ts";

const DOC = join(resolve(import.meta.dirname, "../.."), "docs", "agents", "core-conventions.md");

/**
 * A command is named in the conventions doc when its full name appears, or when the doc
 * writes it in the pipe shorthand, e.g. `record put|get|list` names "record get".
 */
function isNamed(doc: string, name: string): boolean {
  if (doc.includes(name)) return true;
  const [noun, verb] = name.split(" ");
  if (verb === undefined) return false;
  return new RegExp(`${noun} [a-z|-]*\\b${verb}\\b`).test(doc);
}

test("every registered command is named in the conventions doc", async (t) => {
  const dataDir = tempDir(t);
  const help = await runCli(["help"], { dataDir });
  assert.equal(help.code, 0, help.stdout);
  const names = (help.json.commands as { name: string }[]).map((c) => c.name);
  assert.ok(names.length > 50, "the help listing is the command registry");

  const doc = readFileSync(DOC, "utf8");
  const missing = names.filter((name) => !isNamed(doc, name));
  assert.deepEqual(
    missing,
    [],
    `docs/agents/core-conventions.md doesn't name these commands: ${missing.join(", ")}`,
  );
});
