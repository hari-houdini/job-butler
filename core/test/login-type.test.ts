import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { detectLoginType } from "../src/login-type.ts";
import { runCli, tempDir, withProcessEnv } from "./harness.ts";

// Seam: the `status` command's `login` field. Advisory only: status always succeeds.
// CLAUDE_CONFIG_DIR is pinned to a directory per test so the host's own login never leaks in,
// and the macOS keychain probe is skipped whenever CLAUDE_CONFIG_DIR is set.
const FIXTURES = join(import.meta.dirname, "fixtures", "login");

// Every login-related variable is removed unless a test sets it.
const CLEAN = {
  ANTHROPIC_API_KEY: undefined,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
  CLAUDE_CODE_USE_BEDROCK: undefined,
  CLAUDE_CODE_USE_VERTEX: undefined,
  CLAUDE_CONFIG_DIR: undefined,
};

async function login(t: TestContext, env: Record<string, string | undefined>) {
  const dataDir = join(tempDir(t), "data");
  const r = await runCli(["status"], { dataDir, env: { ...CLEAN, ...env } });
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  return r.json.login as { type: string; method: string };
}

test("an API key in the environment reports api-key", async (t) => {
  const got = await login(t, { ANTHROPIC_API_KEY: "test-key-not-real" });
  assert.equal(got.type, "api-key");
});

test("Bedrock in the environment reports bedrock", async (t) => {
  const got = await login(t, { CLAUDE_CODE_USE_BEDROCK: "1" });
  assert.equal(got.type, "bedrock");
});

test("Vertex in the environment reports vertex", async (t) => {
  const got = await login(t, { CLAUDE_CODE_USE_VERTEX: "1" });
  assert.equal(got.type, "vertex");
});

test("a setup token in the environment reports setup-token", async (t) => {
  const got = await login(t, { CLAUDE_CODE_OAUTH_TOKEN: "test-token-not-real" });
  assert.equal(got.type, "setup-token");
});

test("a claude.ai credentials file in the config directory reports claude.ai", async (t) => {
  const got = await login(t, { CLAUDE_CONFIG_DIR: join(FIXTURES, "claude-ai") });
  assert.equal(got.type, "claude.ai");
});

test("no login signal reports unknown and still succeeds", async (t) => {
  const configDir = tempDir(t, "jb-claude-config-");
  const got = await login(t, { CLAUDE_CONFIG_DIR: configDir });
  assert.equal(got.type, "unknown");
});

test("a credentials path that cannot be read reports unknown, never an error", async (t) => {
  const configDir = tempDir(t, "jb-claude-config-");
  // A directory where the credentials file should be: reading it fails.
  mkdirSync(join(configDir, ".credentials.json"));
  const got = await login(t, { CLAUDE_CONFIG_DIR: configDir });
  assert.equal(got.type, "unknown");
});

test("an API key outranks a claude.ai credentials file", async (t) => {
  const got = await login(t, {
    ANTHROPIC_API_KEY: "test-key-not-real",
    CLAUDE_CONFIG_DIR: join(FIXTURES, "claude-ai"),
  });
  assert.equal(got.type, "api-key");
});

// --- the macOS keychain branch -------------------------------------------------------------
// Called in-process with the probe stubbed, so the real keychain is never touched. HOME is a
// fresh directory so a host's ~/.claude credentials file cannot answer first.

// Every login variable is cleared, HOME is a fresh directory, then the test's own values apply.
async function withLoginEnv(
  t: TestContext,
  env: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const cleared = Object.fromEntries(
    [...Object.keys(CLEAN), "HOME"].map((k) => [k, undefined] as const),
  );
  await withProcessEnv({ ...cleared, HOME: tempDir(t, "jb-home-"), ...env }, fn);
}

test("a macOS keychain item reports claude.ai, and no item reports unknown", async (t) => {
  await withLoginEnv(t, {}, async () => {
    let probed = 0;
    const found = await detectLoginType({
      platform: "darwin",
      keychain: async () => {
        probed++;
        return true;
      },
    });
    assert.equal(found.type, "claude.ai");
    assert.match(found.method, /keychain/);
    assert.equal(probed, 1);

    const missing = await detectLoginType({ platform: "darwin", keychain: async () => false });
    assert.equal(missing.type, "unknown");
    assert.equal(missing.method, "no login signal found");
  });
});

test("the keychain is not probed off macOS, or when CLAUDE_CONFIG_DIR is set", async (t) => {
  await withLoginEnv(t, {}, async () => {
    let probed = 0;
    const probe = async () => {
      probed++;
      return true;
    };
    const linux = await detectLoginType({ platform: "linux", keychain: probe });
    assert.equal(linux.type, "unknown");
    assert.equal(probed, 0);
  });
  await withLoginEnv(t, { CLAUDE_CONFIG_DIR: tempDir(t, "jb-claude-config-") }, async () => {
    let probed = 0;
    const pinned = await detectLoginType({
      platform: "darwin",
      keychain: async () => {
        probed++;
        return true;
      },
    });
    assert.equal(pinned.type, "unknown");
    assert.equal(probed, 0);
  });
});
