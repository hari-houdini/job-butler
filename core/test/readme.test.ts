import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Seam: the README at the repo root, read as the job seeker reads it. The login wording must
// match the login-type check (core-conventions.md, "Login type check").
const README = join(resolve(import.meta.dirname, "../.."), "README.md");

test("the README states the claude.ai subscription requirement and what v1 does not support", () => {
  const doc = readFileSync(README, "utf8");
  assert.match(doc, /claude\.ai subscription login/i);
  for (const unsupported of [/API[- ]key/i, /Bedrock/, /Vertex/]) {
    assert.match(doc, unsupported);
  }
  assert.match(doc, /not supported/i);
});

test("the README gives the macOS-only notice for desktop notifications", () => {
  const doc = readFileSync(README, "utf8");
  assert.match(doc, /desktop notifications are macOS-only/i);
});

test("the README names the first run and a line for each Stage", () => {
  const doc = readFileSync(README, "utf8");
  assert.match(doc, /\/job-butler:setup/);
  assert.match(doc, /\/job-butler\b/);
  for (const stage of ["Discover", "Screen", "Tailor", "Apply", "Track"]) {
    assert.match(doc, new RegExp(`\\*\\*${stage}\\*\\*`));
  }
  assert.match(doc, /\*\*Setup\*\*/);
});
