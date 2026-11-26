import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LOCAL_CONFIG_FILENAME,
  computeComparableHash,
  isExcludedRelativePath,
  parseArgs,
  saveLocalConfig,
  syncSourceToSvn,
  validateSvnDirectory,
} from "./sync-source-to-svn.mjs";

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout;
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-svn-sync-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repoDir = path.join(root, "repo");
  const svnParent = path.join(root, "svn-wc");
  const svnDir = path.join(svnParent, "blackcat");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(path.join(svnParent, ".svn"), { recursive: true });
  fs.mkdirSync(svnDir, { recursive: true });

  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);

  fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n.svn-sync.local.json\n");
  fs.writeFileSync(path.join(repoDir, "package.json"), '{\n  "name": "demo"\n}\n');
  fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "# Agent guide\n");
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "app.js"), 'export const v = 1;\n');
  fs.writeFileSync(path.join(repoDir, "src", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "docs", "note.md"), "doc\n");

  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "init"]);

  // Seed existing SVN mirror with CRLF text files + an extra obsolete file.
  fs.writeFileSync(path.join(svnDir, ".gitignore"), "node_modules/\r\n.svn-sync.local.json\r\n");
  fs.writeFileSync(path.join(svnDir, "package.json"), '{\r\n  "name": "demo"\r\n}\r\n');
  fs.mkdirSync(path.join(svnDir, "src", "old"), { recursive: true });
  fs.writeFileSync(path.join(svnDir, "src", "app.js"), 'export const v = 0;\r\n');
  fs.writeFileSync(path.join(svnDir, "src", "old", "legacy.js"), "old\r\n");

  const statePath = path.join(root, "sync-state.json");
  return { root, repoDir, svnDir, statePath };
}

test("isExcludedRelativePath filters build artifacts and AI/doc directories by default", () => {
  assert.equal(isExcludedRelativePath("AGENTS.md"), true);
  assert.equal(isExcludedRelativePath("CLAUDE.md"), true);
  assert.equal(isExcludedRelativePath(".agents/skills/foo.md"), true);
  assert.equal(isExcludedRelativePath("docs/guide.md"), true);
  assert.equal(isExcludedRelativePath("latest.json"), true);
  assert.equal(isExcludedRelativePath("node_modules/a/index.js"), true);
  assert.equal(isExcludedRelativePath("src-tauri/target/debug/app"), true);
  assert.equal(isExcludedRelativePath(".svn-sync.local.json"), true);
  assert.equal(isExcludedRelativePath("src/app.js"), false);
  assert.equal(isExcludedRelativePath("server/deploy/run-blackcat-server.sh"), false);
  assert.equal(isExcludedRelativePath("AGENTS.md", { includeAiDocs: true }), false);
});

test("validateSvnDirectory rejects non-SVN folders and folders inside Git repo", (t) => {
  const { root, repoDir, svnDir } = createFixture(t);
  const nonSvn = path.join(root, "plain");
  fs.mkdirSync(nonSvn);

  assert.throws(() => validateSvnDirectory("relative/path", repoDir), /绝对路径/);
  assert.throws(() => validateSvnDirectory(nonSvn, repoDir), /\.svn/);
  assert.throws(() => validateSvnDirectory(path.join(repoDir, "src"), repoDir), /Git 仓库内部/);

  const valid = validateSvnDirectory(svnDir, repoDir);
  assert.equal(valid.directory, fs.realpathSync(svnDir));
});

test("parseArgs reads local config and CLI overrides", (t) => {
  const { repoDir, svnDir } = createFixture(t);
  saveLocalConfig(repoDir, { svnDir });
  assert.equal(fs.existsSync(path.join(repoDir, LOCAL_CONFIG_FILENAME)), true);

  const fromConfig = parseArgs([], { env: {}, repoRoot: repoDir });
  assert.equal(fromConfig.svnDir, svnDir);

  const fromEnv = parseArgs([], {
    env: { DBSCOUT_SVN_SOURCE_DIR: "/env/path" },
    repoRoot: repoDir,
  });
  assert.equal(fromEnv.svnDir, "/env/path");

  const fromFlag = parseArgs(["--svn-dir", "/cli/path", "--dry-run", "--worktree", "--svn-update"], {
    env: { DBSCOUT_SVN_SOURCE_DIR: "/env/path" },
    repoRoot: repoDir,
  });
  assert.equal(fromFlag.svnDir, "/cli/path");
  assert.equal(fromFlag.dryRun, true);
  assert.equal(fromFlag.source, "worktree");
  assert.equal(fromFlag.svnUpdate, true);
});

test("syncSourceToSvn mirrors cleanly, preserves CRLF, skips unchanged, and removes obsolete files", (t) => {
  const { repoDir, svnDir, statePath } = createFixture(t);

  // Dry run touches nothing.
  const dry = syncSourceToSvn({
    repoRoot: repoDir,
    svnDir,
    statePath,
    dryRun: true,
    skipSvnCli: true,
  });
  assert.deepEqual(dry.added, ["src/icon.png"]);
  assert.deepEqual(dry.updated, ["src/app.js"]);
  assert.deepEqual(dry.deleted, ["src/old/legacy.js"]);
  assert.equal(dry.unchangedCount, 2); // .gitignore & package.json matched despite CRLF vs LF
  assert.equal(fs.existsSync(path.join(svnDir, "src", "old", "legacy.js")), true);

  // Real sync updates files and preserves CRLF on existing text files.
  const result = syncSourceToSvn({
    repoRoot: repoDir,
    svnDir,
    statePath,
    skipSvnCli: true,
  });
  assert.deepEqual(result.added, ["src/icon.png"]);
  assert.deepEqual(result.updated, ["src/app.js"]);
  assert.deepEqual(result.deleted, ["src/old/legacy.js"]);
  assert.deepEqual(result.removedDirs, ["src/old"]);
  assert.equal(fs.existsSync(path.join(svnDir, "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(svnDir, "docs")), false);
  assert.equal(fs.readFileSync(path.join(svnDir, "src", "app.js"), "utf8"), "export const v = 1;\r\n");
  assert.deepEqual(
    fs.readFileSync(path.join(svnDir, "src", "icon.png")),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  );

  // Re-running immediately should report zero changes.
  const second = syncSourceToSvn({
    repoRoot: repoDir,
    svnDir,
    statePath,
    skipSvnCli: true,
  });
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.updated, []);
  assert.deepEqual(second.deleted, []);
  assert.equal(second.unchangedCount, 4);
});

test("syncSourceToSvn blocks when Git worktree is dirty unless --head or --worktree is passed", (t) => {
  const { repoDir, svnDir, statePath } = createFixture(t);
  fs.writeFileSync(path.join(repoDir, "src", "app.js"), "export const v = 2;\n");

  assert.throws(
    () => syncSourceToSvn({ repoRoot: repoDir, svnDir, statePath, skipSvnCli: true }),
    /未提交的源码改动/,
  );

  // --head syncs committed v=1 only.
  const headSync = syncSourceToSvn({
    repoRoot: repoDir,
    svnDir,
    statePath,
    source: "head",
    skipSvnCli: true,
  });
  assert.equal(headSync.source, "head");
  assert.equal(fs.readFileSync(path.join(svnDir, "src", "app.js"), "utf8"), "export const v = 1;\r\n");

  // --worktree syncs uncommitted v=2.
  const wtSync = syncSourceToSvn({
    repoRoot: repoDir,
    svnDir,
    statePath,
    source: "worktree",
    skipSvnCli: true,
  });
  assert.deepEqual(wtSync.updated, ["src/app.js"]);
  assert.equal(fs.readFileSync(path.join(svnDir, "src", "app.js"), "utf8"), "export const v = 2;\r\n");
});

test("syncSourceToSvn detects unmerged SVN-side changes and blocks overwrite unless --force", (t) => {
  const { repoDir, svnDir, statePath } = createFixture(t);
  syncSourceToSvn({ repoRoot: repoDir, svnDir, statePath, skipSvnCli: true });

  // Simulate another developer committing to SVN and `svn update` landing in svnDir.
  fs.writeFileSync(path.join(svnDir, "src", "app.js"), "export const v = 99;\r\n");

  assert.throws(
    () => syncSourceToSvn({ repoRoot: repoDir, svnDir, statePath, skipSvnCli: true }),
    /未合并回 Git 的改动[\s\S]*src\/app\.js/,
  );

  // Once merged into Git, sync succeeds cleanly without --force.
  fs.writeFileSync(path.join(repoDir, "src", "app.js"), "export const v = 99;\n");
  git(repoDir, ["add", "src/app.js"]);
  git(repoDir, ["commit", "-m", "merge svn change"]);

  const afterMerge = syncSourceToSvn({ repoRoot: repoDir, svnDir, statePath, skipSvnCli: true });
  assert.deepEqual(afterMerge.updated, []);
  assert.equal(afterMerge.unchangedCount, 4);

  // Another unmerged SVN edit can be explicitly overridden with --force.
  fs.writeFileSync(path.join(svnDir, "src", "app.js"), "export const v = 123;\r\n");
  const forced = syncSourceToSvn({
    repoRoot: repoDir,
    svnDir,
    statePath,
    force: true,
    skipSvnCli: true,
  });
  assert.deepEqual(forced.updated, ["src/app.js"]);
  assert.equal(
    computeComparableHash(fs.readFileSync(path.join(svnDir, "src", "app.js")), "src/app.js"),
    computeComparableHash(Buffer.from("export const v = 99;\n"), "src/app.js"),
  );
});

function createFakeSvnBin(root, config) {
  const binPath = path.join(root, process.platform === "win32" ? "fake-svn.cmd" : "fake-svn");
  const scriptPath = path.join(root, "fake-svn.mjs");
  const logPath = path.join(root, "fake-svn.log.json");
  const statePath = path.join(root, "fake-svn-state.json");
  fs.writeFileSync(logPath, "[]\n", "utf8");
  fs.writeFileSync(statePath, JSON.stringify({ updated: false }), "utf8");

  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const cfg = ${JSON.stringify(config)};
const logPath = ${JSON.stringify(logPath)};
const statePath = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
const log = JSON.parse(fs.readFileSync(logPath, "utf8"));
log.push(args);
fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const sub = args[0];

if (sub === "info") {
  if (cfg.failInfo) {
    process.stderr.write("svn: E155007: not a working copy\\n");
    process.exit(1);
  }
  process.stdout.write([
    "URL: https://svn.example.local/repo/blackcat",
    "Revision: " + (state.updated ? "2600" : "2598"),
    "Last Changed Rev: " + (state.updated ? "2600" : "2593"),
    "Last Changed Author: tester",
    "Last Changed Date: 2026-11-26 14:00:00 +0800",
  ].join("\\n") + "\\n");
  process.exit(0);
}

if (sub === "status") {
  const lines = state.updated ? (cfg.postStatus || []) : (cfg.preStatus || []);
  process.stdout.write(lines.join("\\n") + (lines.length ? "\\n" : ""));
  process.exit(0);
}

if (sub === "cleanup") {
  if (cfg.failCleanup) {
    process.stderr.write("svn: E155004: cleanup failed\\n");
    process.exit(1);
  }
  process.exit(0);
}

if (sub === "update") {
  if (cfg.failUpdate) {
    process.stderr.write("svn: E170013: Unable to connect to a repository (No route to host)\\n");
    process.exit(1);
  }
  state.updated = true;
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (cfg.writeOnUpdate) {
    for (const [rel, content] of Object.entries(cfg.writeOnUpdate)) {
      const target = path.join(process.cwd(), rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    }
  }
  process.stdout.write("Updated to revision 2600.\\n");
  process.exit(0);
}

if (sub === "add" || sub === "delete") {
  if (sub === "delete") {
    for (const item of args.slice(1)) {
      if (item.startsWith("-")) continue;
      fs.rmSync(path.join(process.cwd(), item.replace(/@$/, "")), { recursive: true, force: true });
    }
  }
  process.exit(0);
}

process.exit(0);
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  if (process.platform === "win32") {
    fs.writeFileSync(binPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
  } else {
    fs.writeFileSync(binPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf8");
    fs.chmodSync(binPath, 0o755);
  }
  return { binPath, readLog: () => JSON.parse(fs.readFileSync(logPath, "utf8")) };
}

test("syncSourceToSvn --svn-update stops immediately when svn update fails and touches no files", (t) => {
  const { root, repoDir, svnDir, statePath } = createFixture(t);
  const fakeSvn = createFakeSvnBin(root, { failUpdate: true });

  assert.throws(
    () =>
      syncSourceToSvn({
        repoRoot: repoDir,
        svnDir,
        statePath,
        svnUpdate: true,
        svnBin: fakeSvn.binPath,
      }),
    /svn update 失败，已停止同步[\s\S]*No route to host/,
  );

  // Target files must remain untouched.
  assert.equal(fs.readFileSync(path.join(svnDir, "src", "app.js"), "utf8"), "export const v = 0;\r\n");
  assert.equal(fs.existsSync(path.join(svnDir, "src", "icon.png")), false);
  assert.equal(fs.existsSync(path.join(svnDir, "src", "old", "legacy.js")), true);
});

test("syncSourceToSvn --svn-update stops on post-update conflicts or unmerged remote edits", (t) => {
  const { root, repoDir, svnDir, statePath } = createFixture(t);

  // Case 1: post-update conflict stops immediately.
  const conflictSvn = createFakeSvnBin(root, { postStatus: ["C       src/app.js"] });
  assert.throws(
    () =>
      syncSourceToSvn({
        repoRoot: repoDir,
        svnDir,
        statePath,
        svnUpdate: true,
        svnBin: conflictSvn.binPath,
      }),
    /svn update 后产生冲突，已停止同步/,
  );

  // Case 2: initial clean sync, then a subsequent svn update pulls an unmerged remote change.
  const cleanSvn = createFakeSvnBin(root, {});
  const initial = syncSourceToSvn({
    repoRoot: repoDir,
    svnDir,
    statePath,
    svnUpdate: true,
    svnBin: cleanSvn.binPath,
  });
  assert.equal(initial.svnUpdated, true);
  assert.equal(initial.svnUrl, "https://svn.example.local/repo/blackcat");
  assert.ok(cleanSvn.readLog().some((cmd) => cmd[0] === "update" && cmd.includes("--non-interactive")));
  assert.ok(cleanSvn.readLog().some((cmd) => cmd[0] === "add"));

  const remoteEditSvn = createFakeSvnBin(root, {
    writeOnUpdate: { "src/app.js": "export const v = 777;\r\n" },
  });
  assert.throws(
    () =>
      syncSourceToSvn({
        repoRoot: repoDir,
        svnDir,
        statePath,
        svnUpdate: true,
        svnBin: remoteEditSvn.binPath,
      }),
    /未合并回 Git 的改动[\s\S]*src\/app\.js/,
  );
  // Must preserve the remote SVN edit instead of overwriting it.
  assert.equal(fs.readFileSync(path.join(svnDir, "src", "app.js"), "utf8"), "export const v = 777;\r\n");

  // Contradictory flags are rejected.
  assert.throws(
    () =>
      syncSourceToSvn({
        repoRoot: repoDir,
        svnDir,
        statePath,
        svnUpdate: true,
        skipSvnCli: true,
      }),
    /--svn-update 不能与 --skip-svn-cli 同时使用/,
  );
});
