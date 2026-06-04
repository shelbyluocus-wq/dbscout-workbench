import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GITEE_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version must be SemVer x.y.z: ${version}`);
  }
}

export function validateArtifactForGitee({ artifactPath, signature }) {
  if (!signature || !signature.trim()) throw new Error("signature is required");
  const size = fs.statSync(artifactPath).size;
  if (size > GITEE_MAX_ATTACHMENT_BYTES) {
    throw new Error(`artifact ${path.basename(artifactPath)} exceeds Gitee free attachment limit`);
  }
  return size;
}

export function createManifest({ version, notes, pubDate, platforms }) {
  assertSemver(version);
  for (const [target, entry] of Object.entries(platforms)) {
    if (!entry.url) throw new Error(`${target} url is required`);
    if (!entry.signature) throw new Error(`${target} signature is required`);
  }
  return {
    version,
    notes: notes || "",
    pub_date: pubDate,
    platforms,
  };
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = readArg("--version");
  const artifactPath = readArg("--artifact");
  const signaturePath = readArg("--signature");
  const url = readArg("--url");
  const notes = readArg("--notes");
  const platform = readArg("--platform") || "windows-x86_64";
  const out = readArg("--out") || "latest.json";
  const pubDate = readArg("--pub-date") || new Date().toISOString();

  if (!version || !artifactPath || !signaturePath || !url) {
    throw new Error("usage: node scripts/gitee-updater-manifest.mjs --version 0.2.0 --artifact src-tauri/target/release/bundle/nsis/DBScoutWorkbench_0.2.0_x64-setup.exe --signature src-tauri/target/release/bundle/nsis/DBScoutWorkbench_0.2.0_x64-setup.exe.sig --url https://gitee.com/shelbylouis/dbscout-workbench-release/releases/download/v0.2.0/DBScoutWorkbench_0.2.0_x64-setup.exe --out latest.json");
  }

  const signature = fs.readFileSync(signaturePath, "utf8").trim();
  validateArtifactForGitee({ artifactPath, signature });
  const manifest = createManifest({
    version,
    notes,
    pubDate,
    platforms: {
      [platform]: { signature, url },
    },
  });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
}
