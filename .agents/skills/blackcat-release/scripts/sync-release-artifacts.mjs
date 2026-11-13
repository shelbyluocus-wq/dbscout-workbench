import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_PLATFORM = "windows-x86_64";
const scriptPath = fileURLToPath(import.meta.url);

function numericVersionParts(value, label) {
  const normalized = String(value || "").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(normalized);
  if (!match) throw new Error(`${label} must use x.y.z format`);
  return { value: normalized, parts: match.slice(1, 4).map(Number) };
}

function compareNumericVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) {
      return left.parts[index] < right.parts[index] ? -1 : 1;
    }
  }
  return 0;
}

function requiredPair(first, second, label) {
  if (Boolean(first) !== Boolean(second)) {
    throw new Error(`${label} must be provided together`);
  }
  return Boolean(first && second);
}

async function requireFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${label} does not exist: ${resolved}`);
  return resolved;
}

async function readJsonFile(filePath, label) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message || error}`);
  }
}

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function safeTarget(root, relativeValue, label) {
  const value = String(relativeValue || "").trim();
  if (!value || path.isAbsolute(value)) {
    throw new Error(`${label} must be a relative file path`);
  }
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the SVN update directory`);
  }
  return target;
}

async function findWorkingCopyRoot(directory) {
  let current = directory;
  while (true) {
    const marker = path.join(current, ".svn");
    const markerStat = await fs.promises.stat(marker).catch(() => null);
    if (markerStat?.isDirectory()) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function validateSvnDirectory(value) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error("SVN update directory must be an absolute local path");
  }
  const resolved = await fs.promises.realpath(value).catch(() => null);
  if (!resolved) throw new Error(`SVN update directory does not exist: ${value}`);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`SVN update path is not a directory: ${resolved}`);
  if (!path.basename(resolved).toLowerCase().includes("navicat")) {
    throw new Error("SVN update directory name must contain navicat");
  }
  const workingCopyRoot = await findWorkingCopyRoot(resolved);
  if (!workingCopyRoot) {
    throw new Error(`SVN metadata was not found above update directory: ${resolved}`);
  }
  return { directory: resolved, workingCopyRoot };
}

async function buildMainArtifacts({ svnDirectory, latestPath, installerPath }) {
  const latestSource = await requireFile(latestPath, "latest.json");
  const installerSource = await requireFile(installerPath, "release installer");
  const manifest = await readJsonFile(latestSource, "latest.json");
  const version = numericVersionParts(manifest.version, "application version");
  const platform = manifest?.platforms?.[WINDOWS_PLATFORM];
  if (!platform?.path) throw new Error(`latest.json is missing ${WINDOWS_PLATFORM}.path`);
  const installerTarget = safeTarget(svnDirectory, platform.path, "installer manifest path");
  if (path.basename(installerSource) !== path.basename(installerTarget)) {
    throw new Error("installer filename does not match latest.json");
  }
  if (path.basename(installerTarget) !== `blackcat_${version.value}_x64-setup.exe`) {
    throw new Error("installer filename does not match the application version");
  }
  const installerStat = await fs.promises.stat(installerSource);
  if (installerStat.size <= 0) {
    throw new Error(`release installer is empty (${installerStat.size})`);
  }
  return {
    version: version.value,
    binary: {
      kind: "installer",
      source: installerSource,
      target: installerTarget,
    },
    manifest: {
      kind: "latest-manifest",
      source: latestSource,
      target: path.join(svnDirectory, "latest.json"),
    },
  };
}

async function buildRuntimeArtifacts({ svnDirectory, manifestPath, packagePath }) {
  const manifestSource = await requireFile(manifestPath, "agent-runtime.json");
  const packageSource = await requireFile(packagePath, "AI runtime package");
  const manifest = await readJsonFile(manifestSource, "agent-runtime.json");
  if (!Number.isSafeInteger(manifest.version) || manifest.version <= 0) {
    throw new Error("AI runtime version must be a positive integer");
  }
  const minAppVersion = numericVersionParts(manifest.minAppVersion, "AI minimum app version");
  const packageTarget = safeTarget(svnDirectory, manifest.package, "AI runtime package path");
  if (path.basename(packageSource) !== path.basename(packageTarget)) {
    throw new Error("AI runtime package filename does not match agent-runtime.json");
  }
  const stat = await fs.promises.stat(packageSource);
  if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0 || stat.size !== manifest.size) {
    throw new Error(`AI runtime size mismatch (${stat.size} != ${manifest.size})`);
  }
  if (!/^[0-9a-f]{64}$/i.test(String(manifest.sha256 || ""))) {
    throw new Error("AI runtime SHA-256 must be 64 hexadecimal characters");
  }
  const sha256 = await sha256File(packageSource);
  if (sha256 !== String(manifest.sha256 || "").toLowerCase()) {
    throw new Error("AI runtime SHA-256 does not match agent-runtime.json");
  }
  return {
    version: manifest.version,
    minAppVersion,
    binary: {
      kind: "agent-runtime-package",
      source: packageSource,
      target: packageTarget,
    },
    manifest: {
      kind: "agent-runtime-manifest",
      source: manifestSource,
      target: path.join(svnDirectory, "agent-runtime.json"),
    },
  };
}

export async function buildSyncPlan({
  svnDirectory,
  latestPath,
  installerPath,
  agentManifestPath,
  agentPackagePath,
}) {
  const hasMain = requiredPair(latestPath, installerPath, "latest.json and installer");
  const hasRuntime = requiredPair(
    agentManifestPath,
    agentPackagePath,
    "agent runtime manifest and package",
  );
  if (!hasMain && !hasRuntime) throw new Error("no release artifacts were provided");

  const svn = await validateSvnDirectory(svnDirectory);
  const main = hasMain
    ? await buildMainArtifacts({
        svnDirectory: svn.directory,
        latestPath,
        installerPath,
      })
    : null;
  const runtime = hasRuntime
    ? await buildRuntimeArtifacts({
        svnDirectory: svn.directory,
        manifestPath: agentManifestPath,
        packagePath: agentPackagePath,
      })
    : null;

  let availableAppVersion = main ? numericVersionParts(main.version, "application version") : null;
  if (!availableAppVersion && runtime) {
    const publishedLatestPath = path.join(svn.directory, "latest.json");
    const publishedLatest = await fs.promises
      .readFile(publishedLatestPath, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (publishedLatest?.version) {
      availableAppVersion = numericVersionParts(
        publishedLatest.version,
        "published application version",
      );
    }
  }
  if (
    runtime &&
    availableAppVersion &&
    compareNumericVersions(runtime.minAppVersion, availableAppVersion) > 0
  ) {
    throw new Error(
      `AI runtime requires Blackcat ${runtime.minAppVersion.value}, but release provides ${availableAppVersion.value}`,
    );
  }

  return {
    svnDirectory: svn.directory,
    workingCopyRoot: svn.workingCopyRoot,
    appVersion: main?.version || null,
    agentRuntimeVersion: runtime?.version ?? null,
    artifacts: [main?.binary, runtime?.binary, runtime?.manifest, main?.manifest].filter(Boolean),
  };
}

async function copyAtomically(source, target) {
  if (path.resolve(source) === path.resolve(target)) return "already-in-place";
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const suffix = `${process.pid}.${crypto.randomUUID()}`;
  const temporary = `${target}.${suffix}.tmp`;
  const backup = `${target}.${suffix}.bak`;
  await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
  const expectedHash = await sha256File(source);
  if ((await sha256File(temporary)) !== expectedHash) {
    await fs.promises.rm(temporary, { force: true });
    throw new Error(`temporary copy verification failed: ${target}`);
  }

  const targetExists = await fs.promises
    .stat(target)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (targetExists) await fs.promises.rename(target, backup);
  try {
    await fs.promises.rename(temporary, target);
    if ((await sha256File(target)) !== expectedHash) {
      throw new Error(`target verification failed: ${target}`);
    }
    await fs.promises.rm(backup, { force: true });
    return targetExists ? "updated" : "created";
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    await fs.promises.rm(target, { force: true }).catch(() => {});
    if (targetExists) await fs.promises.rename(backup, target).catch(() => {});
    throw error;
  }
}

export async function syncReleaseArtifacts(options) {
  const plan = await buildSyncPlan(options);
  const copied = [];
  for (const artifact of plan.artifacts) {
    const action = await copyAtomically(artifact.source, artifact.target);
    copied.push({ ...artifact, action, sha256: await sha256File(artifact.target) });
  }
  return { ...plan, artifacts: copied };
}

function readArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
    values[name] = value;
    index += 1;
  }
  return {
    svnDirectory: values["--svn-dir"],
    latestPath: values["--latest"],
    installerPath: values["--installer"],
    agentManifestPath: values["--agent-manifest"],
    agentPackagePath: values["--agent-package"],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  try {
    const result = await syncReleaseArtifacts(readArguments(process.argv.slice(2)));
    console.log(`SVN update directory synchronized: ${result.svnDirectory}`);
    for (const artifact of result.artifacts) {
      console.log(`${artifact.kind}: ${artifact.target} (${artifact.action})`);
    }
    console.log("SVN remote commit was not run.");
  } catch (error) {
    console.error(`Release sync failed: ${error.message || error}`);
    process.exitCode = 1;
  }
}
