import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createZipArchive } from "./zip-archive.mjs";
import {
  SVN_PACKAGE,
  SVN_COMPAT_PACKAGE,
  bundledSvnClientsExist,
  bundledSvnExists,
  bundledSvnPath,
  fetchSvn,
  isBundledSvnEntry,
  relativeBundledSvnPath,
  verifyFileSha256,
} from "./fetch-svn.mjs";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

test("bundled SVN package is a pinned VisualSVN Apache Subversion zip", () => {
  assert.match(SVN_PACKAGE.url, /Apache-Subversion-1\.14\.5\.zip$/);
  assert.match(SVN_PACKAGE.sha256, /^[a-f0-9]{64}$/);
  assert.ok(SVN_PACKAGE.size > 1_000_000);
});

test("bundled SVN keeps the command-line client, libraries, and licenses", () => {
  assert.equal(isBundledSvnEntry("bin/svn.exe"), true);
  assert.equal(isBundledSvnEntry("BIN/LIBSVN_RA-1.DLL"), true);
  assert.equal(isBundledSvnEntry("Licenses/Subversion License.txt"), true);
  assert.equal(isBundledSvnEntry("bin/svnadmin.exe"), false);
  assert.equal(isBundledSvnEntry("bin/svnserve.exe"), false);
  assert.equal(isBundledSvnEntry("readme.txt"), false);
  assert.equal(relativeBundledSvnPath("bin/svn.exe"), "svn.exe");
  assert.equal(relativeBundledSvnPath("Licenses/APR License.txt"), path.join("Licenses", "APR License.txt"));
});

test("fetchSvn installs only the updater files from a verified archive", async (t) => {
  const root = tempDir(t, "dbscout-svn-root-");
  const staging = tempDir(t, "dbscout-svn-src-");
  writeFile(path.join(staging, "svn.exe"), "svn-binary");
  writeFile(path.join(staging, "libsvn_ra-1.dll"), "ra-dll");
  writeFile(path.join(staging, "svnadmin.exe"), "admin-binary");
  writeFile(path.join(staging, "license.txt"), "Apache-2.0");
  const archivePath = path.join(tempDir(t, "dbscout-svn-zip-"), "svn.zip");
  await createZipArchive([
    { sourcePath: path.join(staging, "svn.exe"), name: "bin/svn.exe" },
    { sourcePath: path.join(staging, "libsvn_ra-1.dll"), name: "bin/libsvn_ra-1.dll" },
    { sourcePath: path.join(staging, "svnadmin.exe"), name: "bin/svnadmin.exe" },
    { sourcePath: path.join(staging, "license.txt"), name: "Licenses/Subversion License.txt" },
  ], archivePath);
  const sha256 = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");

  const installed = await fetchSvn({
    root,
    force: true,
    packageSpec: {
      ...SVN_PACKAGE,
      url: "https://example.test/svn.zip",
      sha256,
      size: fs.statSync(archivePath).size,
    },
    download: async (_url, dest) => {
      fs.copyFileSync(archivePath, dest);
    },
  });

  assert.equal(installed, bundledSvnPath(root));
  assert.equal(bundledSvnExists(root), true);
  assert.equal(fs.readFileSync(path.join(root, "src-tauri", "resources", "svn", "svn.exe"), "utf8"), "svn-binary");
  assert.equal(fs.readFileSync(path.join(root, "src-tauri", "resources", "svn", "libsvn_ra-1.dll"), "utf8"), "ra-dll");
  assert.equal(
    fs.readFileSync(path.join(root, "src-tauri", "resources", "svn", "Licenses", "Subversion License.txt"), "utf8"),
    "Apache-2.0",
  );
  assert.equal(fs.existsSync(path.join(root, "src-tauri", "resources", "svn", "svnadmin.exe")), false);
});

test("fetchSvn rejects an archive whose hash does not match the pin", async (t) => {
  const root = tempDir(t, "dbscout-svn-bad-");
  const archivePath = path.join(tempDir(t, "dbscout-svn-badzip-"), "svn.zip");
  const source = path.join(tempDir(t, "dbscout-svn-badsrc-"), "svn.exe");
  writeFile(source, "svn-binary");
  await createZipArchive([{ sourcePath: source, name: "bin/svn.exe" }], archivePath);

  await assert.rejects(
    () => fetchSvn({
      root,
      force: true,
      packageSpec: {
        ...SVN_PACKAGE,
        url: "https://example.test/svn.zip",
        sha256: "0".repeat(64),
        size: fs.statSync(archivePath).size,
      },
      download: async (_url, dest) => {
        fs.copyFileSync(archivePath, dest);
      },
    }),
    /SHA-256/,
  );
  assert.equal(bundledSvnExists(root), false);
});

test("verifyFileSha256 reports the actual digest on mismatch", async (t) => {
  const filePath = path.join(tempDir(t, "dbscout-svn-hash-"), "file.bin");
  fs.writeFileSync(filePath, "payload");
  const digest = createHash("sha256").update("payload").digest("hex");
  assert.equal(verifyFileSha256(filePath, digest), digest);
  assert.throws(() => verifyFileSha256(filePath, "0".repeat(64)), /SHA-256/);
});

test("both SVN clients retain their own DLLs and licenses across refreshes", async (t) => {
  const root = tempDir(t, "dbscout-svn-dual-");
  const source = tempDir(t, "dbscout-svn-dual-src-");
  for (const [spec, label] of [[SVN_PACKAGE, "current"], [SVN_COMPAT_PACKAGE, "compat"]]) {
    const entries = [];
    for (const name of ["bin/svn.exe", "bin/libsvn_ra-1.dll", "Licenses/Subversion License.txt"]) {
      const sourcePath = path.join(source, label, name);
      writeFile(sourcePath, `${label}: ${name}`);
      entries.push({ sourcePath, name });
    }
    const archivePath = path.join(source, `${label}.zip`);
    await createZipArchive(entries, archivePath);
    const packageSpec = {
      ...spec,
      size: fs.statSync(archivePath).size,
      sha256: createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex"),
    };
    const download = async (_url, dest) => fs.copyFileSync(archivePath, dest);
    await fetchSvn({ root, packageSpec, download });
    await fetchSvn({ root, packageSpec, download, force: true });
    const directory = path.dirname(bundledSvnPath(root, spec));
    assert.equal(fs.readFileSync(path.join(directory, "libsvn_ra-1.dll"), "utf8"), `${label}: bin/libsvn_ra-1.dll`);
    assert.equal(fs.readFileSync(path.join(directory, "Licenses/Subversion License.txt"), "utf8"), `${label}: Licenses/Subversion License.txt`);
    assert.equal(bundledSvnClientsExist(root), label === "compat");
  }
  assert.equal(fs.readFileSync(bundledSvnPath(root), "utf8"), "current: bin/svn.exe");
  assert.equal(fs.readFileSync(bundledSvnPath(root, SVN_COMPAT_PACKAGE), "utf8"), "compat: bin/svn.exe");
});
