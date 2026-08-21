import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RELEASE_TRACKED_FILES,
  buildReleaseCommitMessage,
  commitReleaseArtifacts,
  parsePorcelainForAllowlist,
} from "./commit-release-artifacts.mjs";

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function writeTrackedReleaseFiles(repoRoot, version) {
  const files = {
    "package.json": `${JSON.stringify({ name: "dbscout-workbench", version }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify({ name: "dbscout-workbench", version }, null, 2)}\n`,
    "src-tauri/tauri.conf.json": `${JSON.stringify({ version }, null, 2)}\n`,
    "src-tauri/Cargo.toml": `[package]\nname = "dbscout-workbench"\nversion = "${version}"\n`,
    "Cargo.lock": `# cargo lock ${version}\n`,
    "src/workbench/appVersion.js": `export const APP_VERSION = "${version}";\n`,
    "latest.json": `${JSON.stringify({
      version,
      notes: "1. 测试更新",
      platforms: { "windows-x86_64": { path: `blackcat_${version}_x64-setup.exe` } },
    })}\n`,
  };
  for (const [relative, content] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relative);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content);
  }
}

async function createRepo() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "blackcat-release-git-"));
  const repoRoot = path.join(root, "repo");
  const remoteRoot = path.join(root, "remote.git");
  await fs.promises.mkdir(repoRoot, { recursive: true });
  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "release-test@example.com"]);
  git(repoRoot, ["config", "user.name", "Release Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await writeTrackedReleaseFiles(repoRoot, "0.1.42");
  git(repoRoot, ["add", "--", ...RELEASE_TRACKED_FILES]);
  git(repoRoot, ["commit", "-m", "chore(release): bump version to 0.1.42"]);
  execFileSync("git", ["init", "--bare", "-b", "main", remoteRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  git(repoRoot, ["remote", "add", "origin", remoteRoot]);
  git(repoRoot, ["push", "-u", "origin", "main"]);
  return { root, repoRoot, remoteRoot };
}

test("commit message uses bump version so the next release can find it", () => {
  assert.equal(
    buildReleaseCommitMessage({ appVersion: "0.1.43" }),
    "chore(release): bump version to 0.1.43",
  );
  assert.equal(
    buildReleaseCommitMessage({ agentRuntimeVersion: 2 }),
    "chore(release): bump agent runtime to 2",
  );
});

test("porcelain parser keeps only allowlisted files and rejects conflicts", () => {
  const output = [
    " M Cargo.lock",
    " M package.json",
    " M src/workbench/MySqlWorkbench.vue",
    "?? tmp/release-notes-0.1.43.md",
    "?? target/release/bundle/nsis/blackcat_0.1.43_x64-setup.exe",
    " M latest.json",
  ].join("\n");
  assert.deepEqual(parsePorcelainForAllowlist(output), ["Cargo.lock", "package.json", "latest.json"]);
  assert.throws(
    () => parsePorcelainForAllowlist("UU latest.json"),
    /merge conflict/,
  );
});

test("commits only release files, leaves unrelated dirty files, and pushes main", async (t) => {
  const current = await createRepo();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));

  await writeTrackedReleaseFiles(current.repoRoot, "0.1.43");
  await fs.promises.writeFile(path.join(current.repoRoot, "scratch-notes.txt"), "do not commit\n");
  await fs.promises.mkdir(path.join(current.repoRoot, "tmp"), { recursive: true });
  await fs.promises.writeFile(
    path.join(current.repoRoot, "tmp", "release-notes-0.1.43.md"),
    "1. 测试\n",
  );
  await fs.promises.mkdir(
    path.join(current.repoRoot, "target", "release", "bundle", "nsis"),
    { recursive: true },
  );
  await fs.promises.writeFile(
    path.join(current.repoRoot, "target", "release", "bundle", "nsis", "blackcat_0.1.43_x64-setup.exe"),
    "installer",
  );

  const result = commitReleaseArtifacts({
    repoRoot: current.repoRoot,
    appVersion: "0.1.43",
  });

  assert.equal(result.action, "committed-and-pushed");
  assert.equal(result.pushed, true);
  assert.equal(result.message, "chore(release): bump version to 0.1.43");
  assert.ok(result.files.includes("package.json"));
  assert.ok(result.files.includes("latest.json"));
  assert.ok(result.files.every((file) => RELEASE_TRACKED_FILES.includes(file)));
  assert.equal(git(current.repoRoot, ["log", "-1", "--pretty=%s"]), result.message);
  assert.equal(git(current.remoteRoot, ["log", "-1", "--pretty=%s"]), result.message);
  assert.match(git(current.repoRoot, ["status", "--porcelain"]), /scratch-notes\.txt/);
  const committedFiles = git(current.repoRoot, ["show", "--name-only", "--pretty="]);
  assert.match(committedFiles, /package\.json/);
  assert.match(committedFiles, /latest\.json/);
  assert.doesNotMatch(committedFiles, /scratch-notes|tmp\/|setup\.exe/);
});

test("commits a worktree-only Cargo.lock change that leads git status output", async (t) => {
  const current = await createRepo();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(current.repoRoot, "Cargo.lock"), "# cargo lock 0.1.43\n");

  const result = commitReleaseArtifacts({
    repoRoot: current.repoRoot,
    appVersion: "0.1.43",
  });

  assert.equal(result.action, "committed-and-pushed");
  assert.deepEqual(result.files, ["Cargo.lock"]);
  assert.match(git(current.repoRoot, ["show", "--name-only", "--pretty="]), /Cargo\.lock/);
  assert.equal(git(current.remoteRoot, ["log", "-1", "--pretty=%s"]), result.message);
});

test("skips an empty commit when no tracked release files changed", async (t) => {
  const current = await createRepo();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(current.repoRoot, "unrelated.txt"), "still dirty\n");

  const result = commitReleaseArtifacts({
    repoRoot: current.repoRoot,
    appVersion: "0.1.43",
  });

  assert.equal(result.action, "skipped");
  assert.equal(result.pushed, false);
  assert.equal(git(current.repoRoot, ["rev-list", "--count", "HEAD"]), "1");
});

test("refuses to commit when the current branch is not main", async (t) => {
  const current = await createRepo();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));
  git(current.repoRoot, ["checkout", "-b", "feature/release"]);
  await writeTrackedReleaseFiles(current.repoRoot, "0.1.43");

  assert.throws(
    () => commitReleaseArtifacts({
      repoRoot: current.repoRoot,
      appVersion: "0.1.43",
      push: false,
    }),
    /must be made on main/,
  );
});

test("fast-forwards main before committing when origin is ahead", async (t) => {
  const current = await createRepo();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));

  const otherRoot = path.join(current.root, "other");
  execFileSync("git", ["clone", current.remoteRoot, otherRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  git(otherRoot, ["config", "user.email", "release-test@example.com"]);
  git(otherRoot, ["config", "user.name", "Release Test"]);
  git(otherRoot, ["config", "commit.gpgsign", "false"]);
  await fs.promises.writeFile(path.join(otherRoot, "README.md"), "upstream\n");
  git(otherRoot, ["add", "--", "README.md"]);
  git(otherRoot, ["commit", "-m", "docs: upstream change"]);
  git(otherRoot, ["push", "origin", "main"]);

  await writeTrackedReleaseFiles(current.repoRoot, "0.1.43");
  const result = commitReleaseArtifacts({
    repoRoot: current.repoRoot,
    appVersion: "0.1.43",
  });

  assert.equal(result.action, "committed-and-pushed");
  const subjects = git(current.repoRoot, ["log", "--pretty=%s"]).split(/\r?\n/);
  assert.deepEqual(subjects.slice(0, 3), [
    "chore(release): bump version to 0.1.43",
    "docs: upstream change",
    "chore(release): bump version to 0.1.42",
  ]);
  assert.equal(git(current.remoteRoot, ["log", "-1", "--pretty=%s"]), result.message);
});
