import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runCli, tempDir } from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const DOC = join(ROOT, "docs", "agents", "core-conventions.md");

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

test("the required Node version is the same everywhere it is written down", () => {
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
  const engines = (JSON.parse(read("package.json")) as { engines: { node: string } }).engines.node;
  // Each place names the major version as its own text reads: the engines range, the version
  // file, the README requirement line, the conventions doc runtime line, the hook error text.
  const written: Record<string, string | undefined> = {
    "package.json engines.node": engines.match(/\d+/)?.[0],
    ".nvmrc": read(".nvmrc").trim(),
    "README.md (Requirements)": read("README.md").match(/Node\.js (\d+)/)?.[1],
    "docs/agents/core-conventions.md (runtime)": read("docs/agents/core-conventions.md").match(
      /Node \(>= (\d+)/,
    )?.[1],
    "hooks/hooks.json (Approval hook error)":
      read("hooks/hooks.json").match(/Check that Node (\d+)/)?.[1],
    // No single source can feed these: a workflow file can't import TypeScript, and the guard
    // must run on Node 22 with no imports beyond node:fs, so each names the major in its text.
    "core/src/node-guard.ts (REQUIRED_MAJOR)": read("core/src/node-guard.ts").match(
      /const REQUIRED_MAJOR = (\d+);/,
    )?.[1],
    ".github/workflows/check.yml (setup-node)": read(".github/workflows/check.yml").match(
      /node-version: "(\d+)"/,
    )?.[1],
  };
  for (const [place, major] of Object.entries(written)) {
    assert.equal(major, "26", `${place} names Node ${major}, not Node 26`);
  }
});
