import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSyncPlan, sha256File, syncReleaseArtifacts } from "./sync-release-artifacts.mjs";

async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "blackcat-release-skill-"));
  const workingCopy = path.join(root, "working-copy");
  const svnDirectory = path.join(workingCopy, "navicat-release");
  const sourceDirectory = path.join(root, "source");
  await fs.promises.mkdir(path.join(workingCopy, ".svn"), { recursive: true });
  await fs.promises.mkdir(svnDirectory, { recursive: true });
  await fs.promises.mkdir(sourceDirectory, { recursive: true });
  return { root, svnDirectory, sourceDirectory };
}

async function writeMainArtifacts(sourceDirectory, version = "0.1.31") {
  const installerName = `blackcat_${version}_x64-setup.exe`;
  const installerPath = path.join(sourceDirectory, installerName);
  const latestPath = path.join(sourceDirectory, "latest.json");
  await fs.promises.writeFile(installerPath, "small-installer");
  await fs.promises.writeFile(
    latestPath,
    `${JSON.stringify({
      version,
      notes: "1. 测试更新",
      platforms: { "windows-x86_64": { path: installerName, signature: "" } },
    })}\n`,
  );
  return { installerName, installerPath, latestPath };
}

async function writeRuntimeArtifacts(sourceDirectory, version = 1) {
  const packageName = `agent-runtime-v${version}-win-x64.zip`;
  const packagePath = path.join(sourceDirectory, packageName);
  const manifestPath = path.join(sourceDirectory, "agent-runtime.json");
  const content = Buffer.from("runtime-package");
  await fs.promises.writeFile(packagePath, content);
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  await fs.promises.writeFile(
    manifestPath,
    `${JSON.stringify({
      version,
      minAppVersion: "0.1.31",
      package: packageName,
      sha256,
      size: content.length,
    })}\n`,
  );
  return { packageName, packagePath, manifestPath };
}

test("syncs the installer before latest.json into the supplied SVN working copy", async (t) => {
  const current = await fixture();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));
  const main = await writeMainArtifacts(current.sourceDirectory);

  const result = await syncReleaseArtifacts({
    svnDirectory: current.svnDirectory,
    latestPath: main.latestPath,
    installerPath: main.installerPath,
  });

  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.kind),
    ["installer", "latest-manifest"],
  );
  assert.equal(
    await fs.promises.readFile(path.join(current.svnDirectory, main.installerName), "utf8"),
    "small-installer",
  );
  assert.equal(
    JSON.parse(await fs.promises.readFile(path.join(current.svnDirectory, "latest.json"), "utf8"))
      .version,
    "0.1.31",
  );
});

test("syncs an optional AI package before its manifest and verifies both hashes", async (t) => {
  const current = await fixture();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));
  const main = await writeMainArtifacts(current.sourceDirectory);
  const runtime = await writeRuntimeArtifacts(current.sourceDirectory);

  const result = await syncReleaseArtifacts({
    svnDirectory: current.svnDirectory,
    latestPath: main.latestPath,
    installerPath: main.installerPath,
    agentManifestPath: runtime.manifestPath,
    agentPackagePath: runtime.packagePath,
  });

  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.kind),
    ["installer", "agent-runtime-package", "agent-runtime-manifest", "latest-manifest"],
  );
  assert.equal(
    await sha256File(path.join(current.svnDirectory, runtime.packageName)),
    await sha256File(runtime.packagePath),
  );
});

test("supports an AI-runtime-only sync", async (t) => {
  const current = await fixture();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));
  const runtime = await writeRuntimeArtifacts(current.sourceDirectory, 2);

  const plan = await buildSyncPlan({
    svnDirectory: current.svnDirectory,
    agentManifestPath: runtime.manifestPath,
    agentPackagePath: runtime.packagePath,
  });

  assert.equal(plan.appVersion, null);
  assert.equal(plan.agentRuntimeVersion, 2);
  assert.deepEqual(
    plan.artifacts.map((artifact) => artifact.kind),
    ["agent-runtime-package", "agent-runtime-manifest"],
  );
});

test("rejects a corrupt AI package before touching the SVN directory", async (t) => {
  const current = await fixture();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));
  const runtime = await writeRuntimeArtifacts(current.sourceDirectory);
  await fs.promises.appendFile(runtime.packagePath, "corrupt");

  await assert.rejects(
    buildSyncPlan({
      svnDirectory: current.svnDirectory,
      agentManifestPath: runtime.manifestPath,
      agentPackagePath: runtime.packagePath,
    }),
    /size mismatch/,
  );
  assert.equal(fs.existsSync(path.join(current.svnDirectory, "agent-runtime.json")), false);
});

test("rejects an AI runtime that requires a newer app than the combined release", async (t) => {
  const current = await fixture();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));
  const main = await writeMainArtifacts(current.sourceDirectory, "0.1.31");
  const runtime = await writeRuntimeArtifacts(current.sourceDirectory);
  const manifest = JSON.parse(await fs.promises.readFile(runtime.manifestPath, "utf8"));
  manifest.minAppVersion = "0.1.32";
  await fs.promises.writeFile(runtime.manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    buildSyncPlan({
      svnDirectory: current.svnDirectory,
      latestPath: main.latestPath,
      installerPath: main.installerPath,
      agentManifestPath: runtime.manifestPath,
      agentPackagePath: runtime.packagePath,
    }),
    /requires Blackcat 0\.1\.32, but release provides 0\.1\.31/,
  );
});

test("rejects non-working-copy paths and manifest paths that escape the update directory", async (t) => {
  const current = await fixture();
  t.after(() => fs.promises.rm(current.root, { recursive: true, force: true }));
  const main = await writeMainArtifacts(current.sourceDirectory);
  const plainDirectory = path.join(current.root, "navicat-plain");
  await fs.promises.mkdir(plainDirectory);

  await assert.rejects(
    buildSyncPlan({
      svnDirectory: plainDirectory,
      latestPath: main.latestPath,
      installerPath: main.installerPath,
    }),
    /SVN metadata was not found/,
  );

  const escapedLatest = JSON.parse(await fs.promises.readFile(main.latestPath, "utf8"));
  escapedLatest.platforms["windows-x86_64"].path = "../outside.exe";
  await fs.promises.writeFile(main.latestPath, JSON.stringify(escapedLatest));
  await assert.rejects(
    buildSyncPlan({
      svnDirectory: current.svnDirectory,
      latestPath: main.latestPath,
      installerPath: main.installerPath,
    }),
    /escapes the SVN update directory/,
  );
});

test("the skill requires the SVN path before build and documents optional AI syncing", async () => {
  const skillPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "SKILL.md");
  const skill = await fs.promises.readFile(skillPath, "utf8");
  assert.match(skill, /必须在修改版本号、写公告或开始构建之前完成/);
  assert.match(skill, /用户已经提供路径时直接使用，不要重复询问/);
  assert.match(skill, /agent-runtime\.json/);
  assert.match(skill, /不要再让用户手动复制文件/);
  assert.match(skill, /不执行 `svn commit`/);
  assert.match(skill, /commit-release-artifacts\.mjs/);
  assert.match(skill, /提交到 main 并 push/);
  assert.match(skill, /chore\(release\): bump version to/);
  assert.match(skill, /不要在普通打包请求中执行 `svn commit`/);
  assert.match(skill, /SVN 源码目录/);
  assert.match(skill, /npm run sync:svn/);
  assert.match(skill, /--svn-update/);
  assert.match(skill, /svn update.*报错.*立即停止/s);
});
