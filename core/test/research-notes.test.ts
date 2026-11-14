import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const SELF = relative(ROOT, import.meta.filename);

// Code, prompts and skills that may cite a research note. Vendored minified code is skipped.
const CITING_DIRS = ["core/src", "core/test", "hooks", "skills", "agents"];
const CITING_EXT = /\.(ts|js|mjs|md|json)$/;

// A note cited by its repo path, e.g. docs/research/ghost-job-signals.md.
const CITED_PATH = /docs\/research\/[A-Za-z0-9._-]+\.md/g;
// A note cited by the branch it lived on, e.g. research/ghost-job-signals or "branch research/x".
// Branch names are not paths on the integration branch, so code must not cite them.
const BRANCH_CITE = /(?<!docs\/)\bresearch\/[a-z0-9]+(?:-[a-z0-9]+)+/g;

function filesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => CITING_EXT.test(f))
    .map((f) => join(dir, f))
    .filter((f) => relative(ROOT, join(ROOT, f)) !== SELF);
}

function citations(pattern: RegExp): { file: string; match: string }[] {
  const out: { file: string; match: string }[] = [];
  for (const dir of CITING_DIRS) {
    if (!existsSync(join(ROOT, dir))) continue;
    for (const file of filesUnder(dir)) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(pattern)) out.push({ file, match: m[0] });
    }
  }
  return out;
}

test("every research note cited from code exists in the tree", () => {
  const cited = citations(CITED_PATH);
  assert.ok(cited.length > 0, "expected code to cite at least one research note");

  const missing = cited.filter((c) => !existsSync(join(ROOT, c.match)));
  assert.deepEqual(
    missing,
    [],
    `cited research notes missing from the tree: ${missing.map((c) => `${c.file} -> ${c.match}`).join(", ")}`,
  );
});

test("code cites research notes by repo path, never by the branch they lived on", () => {
  const branchCites = citations(BRANCH_CITE);
  assert.deepEqual(
    branchCites,
    [],
    `code cites a research branch instead of its merged path: ${branchCites.map((c) => `${c.file} -> ${c.match}`).join(", ")}`,
  );
});
