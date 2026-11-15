// Test harness: every test drives the core CLI as a Stage skill would, against a
// temporary data directory, with the three outside dependencies replaced by fixtures:
//   1. network      -> core/test/fixtures/network (manifest.json maps URL -> recorded response)
//   2. LLM judgments -> JSON files in core/test/fixtures/judgments, passed with --input
//   3. browser      -> local pages in core/test/fixtures/browser, served on 127.0.0.1
// See docs/agents/core-conventions.md.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserType } from "playwright-core";

const here = import.meta.dirname;
export const CLI = resolve(here, "../src/cli.ts");
export const FIXTURES = join(here, "fixtures");
export const NETWORK_FIXTURES = join(FIXTURES, "network");
export const GH_FIXTURES = join(FIXTURES, "gh");

/** Path to an LLM judgment fixture, e.g. judgment("skills-rating") */
export function judgment(name: string): string {
  return join(FIXTURES, "judgments", `${name}.json`);
}

/** The host environment, to pass on to a child process. Tests read the host environment only here. */
export function hostEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/** One host environment variable, or undefined when it isn't set. */
export function hostVar(name: string): string | undefined {
  return process.env[name];
}

/** Whether CI is set. CI runs must never pass a real-browser test by skipping it. */
function inCi(): boolean {
  const ci = hostVar("CI");
  return ci !== undefined && ci !== "";
}

export type RealBrowser =
  | { available: true; playwright: string; chromium: BrowserType }
  | { available: false; reason: string };

/**
 * Whether a real-browser test may run: playwright-core (JOB_BUTLER_PLAYWRIGHT, else the
 * installed package) must load, and the Chromium it launches must exist on disk. Resolves the
 * package once: `chromium` is the loaded module's launcher, for in-process tests, and
 * `playwright` is the entry file, for a CLI child process that loads it itself.
 */
export async function realBrowser(): Promise<RealBrowser> {
  const override = hostVar("JOB_BUTLER_PLAYWRIGHT") || undefined;
  let mod: { chromium?: BrowserType; default?: { chromium?: BrowserType } };
  try {
    mod = await import(override ? pathToFileURL(override).href : "playwright-core");
  } catch {
    return {
      available: false,
      reason: override
        ? `JOB_BUTLER_PLAYWRIGHT=${override} doesn't load`
        : "playwright-core isn't installed",
    };
  }
  const chromium = mod.chromium ?? mod.default?.chromium;
  const exe = chromium?.executablePath();
  if (chromium === undefined || exe === undefined || !existsSync(exe)) {
    return {
      available: false,
      reason: `Chromium isn't installed (expected at ${exe ?? "unknown"}); run npx playwright-core install chromium`,
    };
  }
  const playwright = override ?? fileURLToPath(import.meta.resolve("playwright-core"));
  return { available: true, playwright, chromium };
}

/**
 * Declares real-browser tests. When the browser is available, they run. When it isn't, they
 * skip locally and FAIL when CI is set, so a browser CI never installed cannot pass silently.
 */
export function realBrowserTest(
  browser: RealBrowser,
): (name: string, fn: (t: TestContext) => Promise<void>) => void {
  return (name, fn) => {
    if (browser.available) {
      test(name, fn);
    } else if (inCi()) {
      test(name, async () => {
        throw new Error(`real-browser test can't run in CI: ${browser.reason}`);
      });
    } else {
      test(name, { skip: browser.reason }, fn);
    }
  };
}

/** A fresh temporary directory, removed when the test ends. */
export function tempDir(t: TestContext, prefix = "jb-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Isolate git from the developer's global and system config.
const emptyGitConfig = join(mkdtempSync(join(tmpdir(), "jb-gitconfig-")), "config");
writeFileSync(emptyGitConfig, "");
const gitEnv = {
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Run git synchronously in `cwd` with the isolated config; throws on failure. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as the CLI's single JSON result */
  json: Record<string, unknown> & { ok: boolean; error?: { code: string; message: string } };
}

export interface RunOptions {
  /** Sets JOB_BUTLER_DATA_DIR. */
  dataDir?: string;
  /** Written to stdin; objects are JSON-encoded (pair with `--input -`). */
  input?: unknown;
  /** Extra environment; undefined values remove a variable. */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/**
 * Run the core CLI. By default the network goes to the recorded fixtures (only
 * 127.0.0.1 is reachable live) and `gh` is a fixture that reports it is unavailable.
 */
export function runCli(args: string[], opts: RunOptions = {}): Promise<CliResult> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...gitEnv,
    JOB_BUTLER_NETWORK_FIXTURES: NETWORK_FIXTURES,
    JOB_BUTLER_GH: join(GH_FIXTURES, "unavailable"),
    JOB_BUTLER_NOW: "2026-01-15T09:00:00.000Z",
    ...(opts.dataDir ? { JOB_BUTLER_DATA_DIR: opts.dataDir } : {}),
    ...opts.env,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: env as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let json: CliResult["json"];
      try {
        json = JSON.parse(stdout);
      } catch {
        reject(new Error(`CLI stdout was not JSON (exit ${code}):\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolvePromise({ code, stdout, stderr, json });
    });
    if (opts.input !== undefined) {
      child.stdin.end(typeof opts.input === "string" ? opts.input : JSON.stringify(opts.input));
    } else {
      child.stdin.end();
    }
  });
}

/** PID of a process that has already exited (for stale-lock tests). */
export function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(r.stdout);
}

/** Serve a directory of browser fixture pages on 127.0.0.1; returns the base URL. */
export async function serveBrowserFixtures(
  t: TestContext,
  dir = join(FIXTURES, "browser"),
): Promise<string> {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
  };
  const server = createServer(async (req, res) => {
    const path = normalize(new URL(req.url ?? "/", "http://x").pathname).replace(
      /^(\.\.[/\\])+/,
      "",
    );
    const file = join(dir, path.endsWith("/") ? `${path}index.html` : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  return `http://127.0.0.1:${addr.port}`;
}

/** Run `fn` with process.env set to `vars` (undefined removes a name), then restore it. In-process tests only. */
export async function withProcessEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  try {
    for (const [k, v] of Object.entries(vars)) set(k, v);
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) set(k, v);
  }
}
