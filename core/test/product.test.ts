import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Seam: PRODUCT.md at the repo root, read as the product owner reads it. The subscription
// requirement is a constraint, so it must sit under "Capabilities and Constraints" (spec #54).
const PRODUCT = join(resolve(import.meta.dirname, "../.."), "PRODUCT.md");

test("PRODUCT.md states the claude.ai subscription requirement under Capabilities and Constraints", () => {
  const doc = readFileSync(PRODUCT, "utf8");
  const section = doc.split(/^## /m).find((s) => s.startsWith("Capabilities and Constraints"));
  assert.ok(section, "PRODUCT.md has a Capabilities and Constraints section");
  assert.match(section, /v1 requires a claude\.ai subscription login/);
  assert.match(section, /API-key, Bedrock and Vertex setups are not supported/);
});
