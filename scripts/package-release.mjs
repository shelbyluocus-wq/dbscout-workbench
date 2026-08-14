import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createManifest,
  windowsInstallerName,
} from "./svn-updater-manifest.mjs";
import { bundledSvnExists } from "./fetch-svn.mjs";
import { ensureSvn } from "./ensure-svn.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MAX_WINDOWS_INSTALLER_BYTES = 20 * 1024 * 1024;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resourceStrings(resources) {
  if (Array.isArray(resources)) return resources.map(String);
  if (resources && typeof resources === "object") {
    return Object.entries(resources).flatMap(([source, destination]) => [
      String(source),
      String(destination),
    ]);
  }
  return [];
}

export function assertSlimBundleConfiguration(workspaceRoot) {
  const configPaths = [
    path.join(workspaceRoot, "src-tauri", "tauri.conf.json"),
    path.join(workspaceRoot, "src-tauri", "tauri.windows.conf.json"),
  ];
  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) throw new Error(`Tauri config not found: ${configPath}`);
    const resources = resourceStrings(readJson(configPath).bundle?.resources);
    const forbidden = resources.find((value) => {
      const normalized = value.replaceAll("\\", "/").toLowerCase();
      return normalized.includes("resources/node") || normalized.includes("claude-code-native");
    });
    if (forbidden) {
      throw new Error(`AI runtime must not be bundled in the main installer: ${forbidden}`);
    }
  }
}

export function readPackageVersion(workspaceRoot) {
  const packagePath = path.join(workspaceRoot, "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
}

export function finalizeWindowsRelease({
  root: workspaceRoot,
  version,
  pubDate = new Date().toISOString(),
  notes,
} = {}) {
  if (!workspaceRoot) throw new Error("workspace root is required");
  assertSlimBundleConfiguration(workspaceRoot);

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
  const installerSize = fs.statSync(sourcePath).size;
  if (installerSize > MAX_WINDOWS_INSTALLER_BYTES) {
    throw new Error(
      `main installer is ${(installerSize / 1024 / 1024).toFixed(1)} MB; ` +
      `it must stay at or below ${MAX_WINDOWS_INSTALLER_BYTES / 1024 / 1024} MB`,
    );
  }

  const manifest = createManifest({
    version,
    notes: notes?.trim() || `DB Scout Workbench ${version}`,
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

  return { artifactPath, installerSize, manifest: writtenManifest, manifestPath };
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function resolveReleaseNotes(workspaceRoot) {
  const notesFile = readArg("--notes-file");
  if (notesFile) {
    const notesPath = path.resolve(workspaceRoot, notesFile);
    if (!fs.existsSync(notesPath)) {
      throw new Error(`release notes file not found: ${notesPath}`);
    }
    return fs.readFileSync(notesPath, "utf8");
  }
  return readArg("--notes");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = readPackageVersion(root);
  const notes = resolveReleaseNotes(root);
  assertSlimBundleConfiguration(root);
  if (!process.argv.includes("--skip-build")) {
    await ensureSvn();
    if (process.platform === "win32" && !bundledSvnExists(root)) {
      throw new Error("Windows release requires a bundled svn.exe under src-tauri/resources/svn/");
    }
    execSync("npm run tauri -- build", {
      cwd: root,
      stdio: "inherit",
    });
  }
  const result = finalizeWindowsRelease({ root, version, notes });
  console.log(`Release installer: ${result.artifactPath}`);
  console.log(`Release manifest: ${result.manifestPath}`);
}
