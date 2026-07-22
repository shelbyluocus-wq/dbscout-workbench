import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { finalizeWindowsRelease } from "./package-release.mjs";

function createReleaseRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dbscout-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nsisDir = path.join(root, "target", "release", "bundle", "nsis");
  fs.mkdirSync(nsisDir, { recursive: true });
  return { root, nsisDir };
}

test("finalizeWindowsRelease renames the installer and writes a matching manifest", (t) => {
  const { root, nsisDir } = createReleaseRoot(t);
  const sourcePath = path.join(nsisDir, "黑猫_0.1.10_x64-setup.exe");
  fs.writeFileSync(sourcePath, "installer");

  const result = finalizeWindowsRelease({
    root,
    version: "0.1.10",
    pubDate: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(
    path.basename(result.artifactPath),
    "blackcat_0.1.10_x64-setup.exe",
  );
  assert.equal(fs.existsSync(sourcePath), false);
  assert.equal(fs.readFileSync(result.artifactPath, "utf8"), "installer");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, "latest.json"), "utf8")),
    result.manifest,
  );
  assert.equal(result.manifest.version, "0.1.10");
  assert.equal(result.manifest.notes, "DB Scout Workbench 0.1.10");
  assert.equal(
    result.manifest.platforms["windows-x86_64"].path,
    path.basename(result.artifactPath),
  );
});

test("finalizeWindowsRelease writes injected release notes into the manifest", (t) => {
  const { root, nsisDir } = createReleaseRoot(t);
  const sourcePath = path.join(nsisDir, "黑猫_0.1.11_x64-setup.exe");
  fs.writeFileSync(sourcePath, "installer");
  const notes = "新增整表查找替换\n修复导入向导闪烁";

  const result = finalizeWindowsRelease({
    root,
    version: "0.1.11",
    notes,
  });

  assert.equal(result.manifest.notes, notes);
});

test("finalizeWindowsRelease falls back to the default notes when blank", (t) => {
  const { root, nsisDir } = createReleaseRoot(t);
  const sourcePath = path.join(nsisDir, "黑猫_0.1.12_x64-setup.exe");
  fs.writeFileSync(sourcePath, "installer");

  const result = finalizeWindowsRelease({
    root,
    version: "0.1.12",
    notes: "   ",
  });

  assert.equal(result.manifest.notes, "DB Scout Workbench 0.1.12");
});

test("finalizeWindowsRelease does not overwrite an existing canonical installer", (t) => {
  const { root, nsisDir } = createReleaseRoot(t);
  const sourcePath = path.join(nsisDir, "黑猫_0.1.10_x64-setup.exe");
  const destinationPath = path.join(nsisDir, "blackcat_0.1.10_x64-setup.exe");
  fs.writeFileSync(sourcePath, "new installer");
  fs.writeFileSync(destinationPath, "existing installer");

  assert.throws(
    () => finalizeWindowsRelease({ root, version: "0.1.10" }),
    /already exists/,
  );
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "new installer");
  assert.equal(fs.readFileSync(destinationPath, "utf8"), "existing installer");
  assert.equal(fs.existsSync(path.join(root, "latest.json")), false);
});
