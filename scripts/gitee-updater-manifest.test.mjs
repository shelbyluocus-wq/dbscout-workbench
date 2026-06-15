import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GITEE_MAX_ATTACHMENT_BYTES,
  createManifest,
  validateArtifactForGitee,
} from "./gitee-updater-manifest.mjs";

test("createManifest writes a Tauri static updater manifest", () => {
  const manifest = createManifest({
    version: "0.2.0",
    notes: "Release notes",
    pubDate: "2026-06-04T12:00:00Z",
    platforms: {
      "windows-x86_64": {
        signature: "abc",
        url: "https://gitee.com/shelbylouis/dbscout-workbench-release/releases/download/v0.2.0/DBScoutWorkbench_0.2.0_x64-setup.exe",
      },
    },
  });

  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.notes, "Release notes");
  assert.equal(manifest.pub_date, "2026-06-04T12:00:00Z");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "abc");
  assert.match(manifest.platforms["windows-x86_64"].url, /releases\/download\/v0\.2\.0/);
});

test("validateArtifactForGitee rejects missing signatures and oversized files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbscout-manifest-"));
  const artifact = path.join(dir, "setup.exe");
  fs.writeFileSync(artifact, Buffer.alloc(16));

  assert.throws(() => validateArtifactForGitee({ artifactPath: artifact, signature: "" }), /signature is required/);
  assert.doesNotThrow(() => validateArtifactForGitee({ artifactPath: artifact, signature: "abc" }));

  const oversized = path.join(dir, "oversized.exe");
  fs.closeSync(fs.openSync(oversized, "w"));
  fs.truncateSync(oversized, GITEE_MAX_ATTACHMENT_BYTES + 1);
  assert.throws(() => validateArtifactForGitee({ artifactPath: oversized, signature: "abc" }), /exceeds Gitee free attachment limit/);
});
