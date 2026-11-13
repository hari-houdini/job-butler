// Data-directory safety. Nothing in the private data directory may reach git:
//  - inside a git project: the directory is added to the project's .gitignore, and every
//    write is refused while any file in it is tracked;
//  - backed by its own git repo (the directory is the repo root): every write is refused
//    unless `gh` reports the repo private.
// Every command that writes calls ensureSafeDataDir first (withWriter does it for you).
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { ghCommand } from "./env.ts";
import { CoreError } from "./errors.ts";

export interface DataDirReport {
  /** none: not in git; ignored-in-project: inside a project and git-ignored; private-repo: its own private repo */
  git: "none" | "ignored-in-project" | "private-repo";
  gitignore_updated: boolean;
}

function run(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8" });
}

/** The real (symlink-free) path of `dir`, even if it doesn't exist yet. */
async function realPathOf(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    const parent = dirname(dir);
    if (parent === dir) return dir;
    return join(await realPathOf(parent), basename(dir));
  }
}

async function nearestExisting(dir: string): Promise<string> {
  try {
    await realpath(dir);
    return dir;
  } catch {
    const parent = dirname(dir);
    return parent === dir ? dir : nearestExisting(parent);
  }
}

async function gitToplevel(dir: string): Promise<string | undefined> {
  const r = run("git", ["rev-parse", "--show-toplevel"], await nearestExisting(dir));
  if (r.error) {
    throw new CoreError(
      "GIT_UNAVAILABLE",
      "Job Butler needs git installed to check that your data directory can't leak through git.",
    );
  }
  return r.status === 0 ? await realpath(r.stdout.trim()) : undefined;
}

export async function ensureSafeDataDir(dataDir: string): Promise<DataDirReport> {
  const real = await realPathOf(dataDir);
  const top = await gitToplevel(real);

  if (top === undefined) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    return { git: "none", gitignore_updated: false };
  }

  if (top === real) {
    assertRepoPrivate(real);
    return { git: "private-repo", gitignore_updated: false };
  }

  const rel = relative(top, real).split(sep).join("/");
  const tracked = run("git", ["ls-files", "--", rel], top).stdout.trim();
  if (tracked !== "") {
    const files = tracked.split("\n");
    throw new CoreError(
      "DATA_DIR_TRACKED",
      `Your Job Butler data directory ${dataDir} has files tracked by git, so your data could ` +
        `be committed: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}. ` +
        `Untrack them (git rm -r --cached ${rel}) or choose another data directory.`,
      { tracked: files },
    );
  }

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let gitignoreUpdated = false;
  if (!isIgnored(top, rel)) {
    const gitignore = join(top, ".gitignore");
    const current = await readFile(gitignore, "utf8").catch(() => "");
    const lead = current === "" || current.endsWith("\n") ? "" : "\n";
    await appendFile(gitignore, `${lead}/${rel}/\n`);
    gitignoreUpdated = true;
    if (!isIgnored(top, rel)) {
      throw new CoreError(
        "DATA_DIR_NOT_IGNORED",
        `Added /${rel}/ to ${gitignore}, but git still doesn't ignore ${dataDir} ` +
          "(another .gitignore rule re-includes it). Fix the rule or choose another data directory.",
      );
    }
  }
  return { git: "ignored-in-project", gitignore_updated: gitignoreUpdated };
}

function isIgnored(top: string, rel: string): boolean {
  return run("git", ["check-ignore", "-q", `${rel}/`], top).status === 0;
}

function assertRepoPrivate(repoDir: string): void {
  const r = run(ghCommand(), ["repo", "view", "--json", "isPrivate"], repoDir);
  let isPrivate: unknown;
  try {
    isPrivate = JSON.parse(r.stdout).isPrivate;
  } catch {
    isPrivate = undefined;
  }
  if (r.status === 0 && isPrivate === true) return;
  const why =
    isPrivate === false
      ? "GitHub reports the repo is public"
      : `gh could not confirm the repo is private (${(r.stderr || String(r.error ?? "")).trim() || "no answer"})`;
  throw new CoreError(
    "DATA_DIR_REPO_NOT_PRIVATE",
    `Your Job Butler data directory ${repoDir} is a git repo, and ${why}. ` +
      "Job Butler only writes there when gh reports the repo private. Make it private, " +
      "check `gh auth status`, or choose a data directory outside git.",
  );
}
