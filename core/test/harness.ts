// Test harness: every test drives the core CLI as a Stage skill would, against a
// temporary data directory, with the three outside dependencies replaced by fixtures:
//   1. network      -> core/test/fixtures/network (manifest.json maps URL -> recorded response)
//   2. LLM judgments -> JSON files in core/test/fixtures/judgments, passed with --input
//   3. browser      -> local pages in core/test/fixtures/browser, served on 127.0.0.1
// See docs/agents/core-conventions.md.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import type { TestContext } from "node:test";

const here = import.meta.dirname;
export const CLI = resolve(here, "../src/cli.ts");
export const FIXTURES = join(here, "fixtures");
export const NETWORK_FIXTURES = join(FIXTURES, "network");
export const GH_FIXTURES = join(FIXTURES, "gh");

/** Path to an LLM judgment fixture, e.g. judgment("skills-rating") */
export function judgment(name: string): string {
  return join(FIXTURES, "judgments", `${name}.json`);
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
