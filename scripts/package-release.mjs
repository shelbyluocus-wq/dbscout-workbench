import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createManifest,
  windowsInstallerName,
} from "./svn-updater-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readPackageVersion(workspaceRoot) {
  const packagePath = path.join(workspaceRoot, "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
}

export function finalizeWindowsRelease({
  root: workspaceRoot,
  version,
  pubDate = new Date().toISOString(),
} = {}) {
  if (!workspaceRoot) throw new Error("workspace root is required");

  const nsisDir = path.join(
    workspaceRoot,
    "target",
    "release",
    "bundle",
    "nsis",
  );
  const sourcePath = path.join(nsisDir, `黑猫_${version}_x64-setup.exe`);
  const artifactPath = path.join(nsisDir, windowsInstallerName(version));
  const manifestPath = path.join(workspaceRoot, "latest.json");

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`generated installer not found: ${sourcePath}`);
  }
  if (fs.existsSync(artifactPath)) {
    throw new Error(`release installer already exists: ${artifactPath}`);
  }

  const manifest = createManifest({
    version,
    notes: `DB Scout Workbench ${version}`,
    pubDate,
    artifactPath,
  });

  fs.renameSync(sourcePath, artifactPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const writtenManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const writtenArtifactName =
    writtenManifest.platforms?.["windows-x86_64"]?.path;
  if (writtenManifest.version !== version) {
    throw new Error("latest.json version does not match the package version");
  }
  if (writtenArtifactName !== path.basename(artifactPath)) {
    throw new Error("latest.json installer path does not match the release artifact");
  }
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`release installer not found after rename: ${artifactPath}`);
  }

  return { artifactPath, manifest: writtenManifest, manifestPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = readPackageVersion(root);
  if (!process.argv.includes("--skip-build")) {
    execSync("npm run tauri -- build", {
      cwd: root,
      stdio: "inherit",
    });
  }
  const result = finalizeWindowsRelease({ root, version });
  console.log(`Release installer: ${result.artifactPath}`);
  console.log(`Release manifest: ${result.manifestPath}`);
}
