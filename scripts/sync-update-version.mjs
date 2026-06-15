import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version must be SemVer x.y.z: ${version}`);
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function syncVersionInWorkspace(workspaceRoot, version) {
  assertSemver(version);

  const packagePath = path.join(workspaceRoot, "package.json");
  const packageLockPath = path.join(workspaceRoot, "package-lock.json");
  const tauriConfigPath = path.join(workspaceRoot, "src-tauri", "tauri.conf.json");
  const cargoTomlPath = path.join(workspaceRoot, "src-tauri", "Cargo.toml");
  const appVersionPath = path.join(workspaceRoot, "src", "workbench", "appVersion.js");

  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  pkg.version = version;
  writeJson(packagePath, pkg);

  if (fs.existsSync(packageLockPath)) {
    const lock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    writeJson(packageLockPath, lock);
  }

  const tauri = JSON.parse(fs.readFileSync(tauriConfigPath, "utf8"));
  tauri.version = version;
  writeJson(tauriConfigPath, tauri);

  const cargo = fs.readFileSync(cargoTomlPath, "utf8").replace(
    /(^version\s*=\s*")([^"]+)(")/m,
    `$1${version}$3`,
  );
  fs.writeFileSync(cargoTomlPath, cargo);

  fs.writeFileSync(appVersionPath, `export const APP_VERSION = "${version}";\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) throw new Error("usage: node scripts/sync-update-version.mjs 0.2.0");
  syncVersionInWorkspace(root, version);
}
