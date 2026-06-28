import test from "node:test";
import assert from "node:assert/strict";

import { createManifest } from "./svn-updater-manifest.mjs";

test("createManifest writes a local SVN updater manifest", () => {
  const manifest = createManifest({
    version: "0.1.5",
    notes: "Release notes",
    pubDate: "2026-06-28T12:00:00Z",
    artifactPath: "E:/release/blackcat_0.1.5_x64-setup.exe",
    signature: "abc",
  });

  assert.equal(manifest.version, "0.1.5");
  assert.equal(manifest.notes, "Release notes");
  assert.equal(manifest.pub_date, "2026-06-28T12:00:00Z");
  assert.equal(manifest.platforms["windows-x86_64"].path, "blackcat_0.1.5_x64-setup.exe");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "abc");
  assert.equal(manifest.platforms["windows-x86_64"].url, undefined);
});

test("createManifest validates version and artifact file name", () => {
  assert.throws(
    () => createManifest({ version: "bad", artifactPath: "setup.exe" }),
    /SemVer/,
  );
  assert.throws(
    () => createManifest({ version: "0.1.5" }),
    /artifact path is required/,
  );
});
