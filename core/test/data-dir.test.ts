import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GH_FIXTURES, git, runCli, tempDir } from "./harness.ts";

const gh = (name: string) => ({ JOB_BUTLER_GH: join(GH_FIXTURES, name) });

test("init creates a private data directory outside any git project", async (t) => {
  const dataDir = join(tempDir(t), "data");

  const r = await runCli(["init"], { dataDir });

  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.git, "none");
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
});

test("init inside a git project adds the data directory to .gitignore once", async (t) => {
  const project = realpathSync(tempDir(t));
  git(project, "init", "-q");
  writeFileSync(join(project, ".gitignore"), "node_modules/");
  const dataDir = join(project, "private", "job-butler");

  const first = await runCli(["init"], { dataDir });
  const second = await runCli(["init"], { dataDir });

  assert.equal(first.code, 0, first.stdout);
  assert.equal(first.json.git, "ignored-in-project");
  assert.equal(first.json.gitignore_updated, true);
  assert.equal(second.json.gitignore_updated, false);
  assert.equal(
    readFileSync(join(project, ".gitignore"), "utf8"),
    "node_modules/\n/private/job-butler/\n",
  );
  writeFileSync(join(dataDir, "profile.yaml"), "name: x\n");
  assert.equal(
    git(project, "status", "--porcelain", "--untracked-files=all").includes("profile"),
    false,
  );
});

test("init leaves .gitignore alone when the data directory is already ignored", async (t) => {
  const project = realpathSync(tempDir(t));
  git(project, "init", "-q");
  writeFileSync(join(project, ".gitignore"), ".job-butler/\n");

  const r = await runCli(["init"], { dataDir: join(project, ".job-butler") });

  assert.equal(r.json.gitignore_updated, false);
  assert.equal(readFileSync(join(project, ".gitignore"), "utf8"), ".job-butler/\n");
});

test("writes are refused when any file in the data directory is tracked by git", async (t) => {
  const project = realpathSync(tempDir(t));
  git(project, "init", "-q");
  const dataDir = join(project, "jb");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "notes.txt"), "oops");
  git(project, "add", ".");
  git(project, "commit", "-qm", "track it");

  const init = await runCli(["init"], { dataDir });
  const put = await runCli(["record", "put", "listing", "a", "--input", "-"], {
    dataDir,
    input: {},
  });

  assert.equal(init.code, 1);
  assert.equal(init.json.error?.code, "DATA_DIR_TRACKED");
  assert.match(init.json.error?.message ?? "", /jb\/notes\.txt/);
  assert.equal(put.json.error?.code, "DATA_DIR_TRACKED");
  assert.equal(existsSync(join(dataDir, "pipeline")), false);
  assert.equal(existsSync(join(project, ".gitignore")), false);
});

test("a data directory backed by a git repo is refused unless gh reports it private", async (t) => {
  const dataDir = realpathSync(tempDir(t));
  git(dataDir, "init", "-q");
  git(dataDir, "remote", "add", "origin", "https://github.com/someone/job-data.git");

  const pub = await runCli(["init"], { dataDir, env: gh("public") });
  const unavailable = await runCli(["init"], { dataDir, env: gh("unavailable") });
  const putPub = await runCli(["record", "put", "listing", "a", "--input", "-"], {
    dataDir,
    input: {},
    env: gh("public"),
  });
  const priv = await runCli(["init"], { dataDir, env: gh("private") });

  assert.equal(pub.code, 1);
  assert.equal(pub.json.error?.code, "DATA_DIR_REPO_NOT_PRIVATE");
  assert.equal(unavailable.json.error?.code, "DATA_DIR_REPO_NOT_PRIVATE");
  assert.match(unavailable.json.error?.message ?? "", /gh/);
  assert.equal(putPub.json.error?.code, "DATA_DIR_REPO_NOT_PRIVATE");
  assert.equal(existsSync(join(dataDir, "pipeline")), false);
  assert.equal(priv.code, 0, priv.stdout);
  assert.equal(priv.json.git, "private-repo");
});
