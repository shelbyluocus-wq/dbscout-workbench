import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version must be SemVer x.y.z: ${version}`);
  }
}

export function createManifest({
  version,
  notes = "",
  pubDate = new Date().toISOString(),
  platform = "windows-x86_64",
  artifactPath,
  signature = "",
} = {}) {
  assertSemver(version);
  if (!artifactPath) throw new Error("artifact path is required");
  const artifactName = path.basename(artifactPath);
  if (!artifactName || artifactName === "." || artifactName === "..") {
    throw new Error("artifact path must include a file name");
  }
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      [platform]: {
        path: artifactName,
        signature,
      },
    },
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
  const notes = readArg("--notes");
  const platform = readArg("--platform") || "windows-x86_64";
  const out = readArg("--out") || "latest.json";
  const pubDate = readArg("--pub-date") || new Date().toISOString();

  if (!version || !artifactPath) {
    throw new Error("usage: node scripts/svn-updater-manifest.mjs --version 0.1.5 --artifact src-tauri/target/release/bundle/nsis/blackcat_0.1.5_x64-setup.exe --signature src-tauri/target/release/bundle/nsis/blackcat_0.1.5_x64-setup.exe.sig --out latest.json");
  }

  const signature = signaturePath && fs.existsSync(signaturePath)
    ? fs.readFileSync(signaturePath, "utf8").trim()
    : "";
  const manifest = createManifest({
    version,
    notes,
    pubDate,
    platform,
    artifactPath,
    signature,
  });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
}
