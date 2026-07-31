import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createZipArchive } from "./zip-archive.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), "..");
const MANIFEST_NAME = "agent-runtime.json";

function requiredPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || String(value).trim() !== String(number)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function normalizeTarget(value) {
  const aliases = {
    "win-x64": "win-x64",
    "win32-x64": "win-x64",
    "windows-x86_64": "win-x64",
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
  };
  const target = aliases[String(value || "").trim()];
  if (!target) throw new Error(`unsupported AI runtime target: ${value}`);
  return target;
}

function isNumericAppVersion(value) {
  return /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value || "").trim());
}

function hostTarget() {
  if (process.platform === "win32" && process.arch === "x64") return "win-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  throw new Error(`unsupported host for AI runtime packaging: ${process.platform}-${process.arch}`);
}

function runtimeEntries(root, target) {
  const resources = path.join(root, "src-tauri", "resources");
  const windows = target === "win-x64";
  return [
    {
      sourcePath: path.join(resources, "node", windows ? "node.exe" : path.join("bin", "node")),
      name: windows ? "node/node.exe" : "node/node",
    },
    {
      sourcePath: path.join(resources, windows ? "claude-code-native.exe" : "claude-code-native"),
      name: windows ? "claude-code-native.exe" : "claude-code-native",
    },
  ];
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readExistingManifest(manifestPath) {
  try {
    const value = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    value.version = requiredPositiveInteger(value.version, "existing runtime version");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`cannot read existing ${MANIFEST_NAME}: ${error.message || error}`);
  }
}

async function writeManifest(manifestPath, manifest) {
  const temporary = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  try {
    await fs.promises.rm(manifestPath, { force: true });
    await fs.promises.rename(temporary, manifestPath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function packageAgentRuntime({
  root,
  version,
  minAppVersion,
  target = hostTarget(),
  outputDirectory = root,
  entries,
} = {}) {
  if (!root) throw new Error("workspace root is required");
  const runtimeVersion = requiredPositiveInteger(version, "AI runtime version");
  const minimumVersion = String(minAppVersion || "").trim();
  if (!isNumericAppVersion(minimumVersion)) {
    throw new Error("minAppVersion must be a numeric application version");
  }
  const normalizedTarget = normalizeTarget(target);
  const resolvedOutput = path.resolve(outputDirectory);
  const packageName = `agent-runtime-v${runtimeVersion}-${normalizedTarget}.zip`;
  const packagePath = path.join(resolvedOutput, packageName);
  const manifestPath = path.join(resolvedOutput, MANIFEST_NAME);
  const existing = await readExistingManifest(manifestPath);

  if (existing && runtimeVersion < existing.version) {
    throw new Error(
      `AI runtime version cannot go backwards (${runtimeVersion} < ${existing.version})`,
    );
  }

  const archiveEntries = entries || runtimeEntries(path.resolve(root), normalizedTarget);
  for (const entry of archiveEntries) {
    const stat = await fs.promises.stat(entry.sourcePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`AI runtime source file not found: ${entry.sourcePath}`);
  }

  await fs.promises.mkdir(resolvedOutput, { recursive: true });
  const temporaryPackage = `${packagePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await createZipArchive(archiveEntries, temporaryPackage);

  try {
    const packageStat = await fs.promises.stat(temporaryPackage);
    const sha256 = await sha256File(temporaryPackage);
    const manifest = {
      version: runtimeVersion,
      minAppVersion: minimumVersion,
      package: packageName,
      sha256,
      size: packageStat.size,
    };

    if (existing && existing.version === runtimeVersion) {
      const unchanged =
        existing.minAppVersion === manifest.minAppVersion &&
        existing.package === manifest.package &&
        String(existing.sha256 || "").toLowerCase() === manifest.sha256 &&
        Number(existing.size) === manifest.size;
      if (!unchanged) {
        throw new Error(
          `AI runtime v${runtimeVersion} already exists with different content; bump --version`,
        );
      }
      const publishedHash = fs.existsSync(packagePath)
        ? await sha256File(packagePath)
        : "";
      if (publishedHash === sha256) {
        await fs.promises.rm(temporaryPackage, { force: true });
        return { packagePath, manifestPath, manifest, unchanged: true };
      }
      await fs.promises.rm(packagePath, { force: true });
      await fs.promises.rename(temporaryPackage, packagePath);
      await writeManifest(manifestPath, manifest);
      return { packagePath, manifestPath, manifest, unchanged: false };
    }

    if (fs.existsSync(packagePath)) {
      const existingHash = await sha256File(packagePath);
      if (existingHash !== sha256) {
        throw new Error(`AI runtime package already exists with different content: ${packagePath}`);
      }
      await fs.promises.rm(temporaryPackage, { force: true });
    } else {
      await fs.promises.rename(temporaryPackage, packagePath);
    }
    await writeManifest(manifestPath, manifest);
    return { packagePath, manifestPath, manifest, unchanged: false };
  } catch (error) {
    await fs.promises.rm(temporaryPackage, { force: true }).catch(() => {});
    throw error;
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

if (process.argv[1] === scriptPath) {
  const version = readArg("--version");
  if (!version) {
    throw new Error(
      "AI runtime version is required. Example: npm run release:agent-runtime -- --version 1",
    );
  }
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
  ).version;
  if (!process.argv.includes("--skip-prepare")) {
    execSync("npm run ensure-node", { cwd: workspaceRoot, stdio: "inherit" });
    execSync("npm run build:sidecar", { cwd: workspaceRoot, stdio: "inherit" });
  }
  const result = await packageAgentRuntime({
    root: workspaceRoot,
    version,
    minAppVersion: readArg("--min-app-version") || packageVersion,
    target: readArg("--target") || hostTarget(),
    outputDirectory: readArg("--output-dir")
      ? path.resolve(workspaceRoot, readArg("--output-dir"))
      : workspaceRoot,
  });
  console.log(result.unchanged ? "AI runtime package unchanged." : "AI runtime package created.");
  console.log(`Runtime package: ${result.packagePath}`);
  console.log(`Runtime manifest: ${result.manifestPath}`);
  console.log(`SHA-256: ${result.manifest.sha256}`);
  console.log(`Size: ${result.manifest.size} bytes`);
}
