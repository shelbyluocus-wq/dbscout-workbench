// Downloads a portable Node.js runtime and stores `node[.exe]` under
// `src-tauri/resources/node/` for desktop development and separate AI-runtime
// packaging. Production installs obtain this binary from the versioned runtime
// ZIP instead of the main app bundle. Pinning a specific runtime version keeps
// every environment aligned.
//
// Usage:
//   npm run fetch-node                  # fetch for the host platform
//   npm run fetch-node -- --target=win32-x64
//   npm run fetch-node -- --target=darwin-arm64
//
// Run this for desktop development or before publishing a separate AI runtime;
// the file is gitignored and is not included in the main installer.
// `fetchNode()` is also exported so `ensure-node.mjs` can call it when the
// local binary is missing during `tauri dev`.
import { existsSync, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";

const NODE_VERSION = "22.11.0"; // Active LTS at time of writing.

// Use the official distribution host by default. DBSCOUT_NODE_MIRROR can
// prepend an explicitly configured mirror; every URL receives the pinned
// version and archive name.
const DEFAULT_MIRRORS = ["https://nodejs.org/dist/"];

function resolveMirrors() {
  const override = process.env.DBSCOUT_NODE_MIRROR;
  if (!override) return DEFAULT_MIRRORS;
  const extra = override.endsWith("/") ? override : `${override}/`;
  return [extra, ...DEFAULT_MIRRORS];
}

const TARGETS = {
  "win32-x64": {
    archive: `node-v${NODE_VERSION}-win-x64.zip`,
    bin: "node.exe",
    inner: `node-v${NODE_VERSION}-win-x64/node.exe`,
  },
  "darwin-x64": {
    archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    bin: "node",
    inner: `node-v${NODE_VERSION}-darwin-x64/bin/node`,
  },
  "darwin-arm64": {
    archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    bin: "node",
    inner: `node-v${NODE_VERSION}-darwin-arm64/bin/node`,
  },
  "linux-x64": {
    archive: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
    bin: "node",
    inner: `node-v${NODE_VERSION}-linux-x64/bin/node`,
  },
  "linux-arm64": {
    archive: `node-v${NODE_VERSION}-linux-arm64.tar.xz`,
    bin: "node",
    inner: `node-v${NODE_VERSION}-linux-arm64/bin/node`,
  },
};

function resolvePlatformKey(argv) {
  for (const arg of argv) {
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
  }
  const platformMap = { win32: "win32", darwin: "darwin", linux: "linux" };
  const platform = platformMap[process.platform] || process.platform;
  return `${platform}-${process.arch}`;
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolveFn, rejectFn) => {
    if (redirects > 5) {
      rejectFn(new Error("Too many redirects"));
      return;
    }
    const client = url.startsWith("http://") ? http : https;
    const req = client.get(url, { timeout: 30000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        downloadFile(res.headers.location, dest, redirects + 1).then(resolveFn, rejectFn);
        return;
      }
      if (res.statusCode !== 200) {
        rejectFn(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const total = Number(res.headers["content-length"]) || 0;
      let received = 0;
      let lastPctReported = -1;
      const file = createWriteStream(dest);
      res.on("data", (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPctReported && pct % 10 === 0) {
            lastPctReported = pct;
            process.stdout.write(`  ${pct}%\r`);
          }
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        process.stdout.write("       \r");
        file.close((err) => (err ? rejectFn(err) : resolveFn()));
      });
      file.on("error", rejectFn);
    });
    req.on("error", rejectFn);
    req.on("timeout", () => {
      req.destroy(new Error("connection timed out"));
    });
  });
}

async function downloadFromMirrors(archive, dest) {
  const mirrors = resolveMirrors();
  let lastError = null;
  for (const mirror of mirrors) {
    const url = `${mirror}v${NODE_VERSION}/${archive}`;
    try {
      console.log(`  → ${url}`);
      await downloadFile(url, dest);
      return;
    } catch (err) {
      lastError = err;
      console.log(`    failed: ${err.message || err}`);
    }
  }
  throw new Error(
    `All mirrors failed to fetch ${archive}. Last error: ${lastError?.message || lastError}`
  );
}

function extractArchive(archivePath, destDir) {
  // For .tar.gz / .tar.xz, system `tar` works on macOS, Linux, and Windows
  // (bsdtar). For .zip we can't rely on tar — bsdtar reads zip but Git Bash
  // ships GNU tar which doesn't, and the user might run this from either
  // shell. Use PowerShell's Expand-Archive on Windows and `unzip` on POSIX.
  if (archivePath.endsWith(".tar.xz")) {
    execFileSync("tar", ["-xJf", archivePath, "-C", destDir], { stdio: "inherit" });
    return;
  }
  if (archivePath.endsWith(".tar.gz")) {
    execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
    return;
  }
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ],
        { stdio: "inherit" }
      );
    } else {
      execFileSync("unzip", ["-q", archivePath, "-d", destDir], { stdio: "inherit" });
    }
    return;
  }
  throw new Error(`Unknown archive format: ${archivePath}`);
}

async function main() {
  const platformKey = resolvePlatformKey(process.argv.slice(2));
  await fetchNode(platformKey);
}

/**
 * Download + extract the portable Node runtime for `platformKey` into
 * `src-tauri/resources/node/`. Idempotent: if the binary already exists it
 * is left in place (pass `force: true` to re-download).
 *
 * @param {string} platformKey - e.g. "win32-x64", "darwin-arm64"
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<string>} absolute path of the placed binary
 */
export async function fetchNode(platformKey, { force = false } = {}) {
  const target = TARGETS[platformKey];
  if (!target) {
    throw new Error(
      `Unsupported target: ${platformKey}\nAvailable: ${Object.keys(TARGETS).join(", ")}`
    );
  }

  const projectRoot = pathResolve(dirname(fileURLToPath(import.meta.url)), "..");
  const destDir = join(projectRoot, "src-tauri", "resources", "node");
  const destBinary = join(destDir, target.bin);

  if (!force && existsSync(destBinary)) {
    console.log(`Node ${NODE_VERSION} already present at ${destBinary}`);
    return destBinary;
  }

  console.log(`Fetching Node ${NODE_VERSION} for ${platformKey}`);

  const stagingRoot = await mkdtemp(join(tmpdir(), "dbscout-node-"));
  try {
    const archivePath = join(stagingRoot, target.archive);
    await downloadFromMirrors(target.archive, archivePath);

    console.log(`  → extracting`);
    extractArchive(archivePath, stagingRoot);

    const innerPath = join(stagingRoot, target.inner);
    if (!existsSync(innerPath)) {
      throw new Error(
        `Expected ${target.inner} inside the archive but it wasn't found. Layout may have changed.`
      );
    }

    await mkdir(destDir, { recursive: true });
    await copyFile(innerPath, destBinary);
    console.log(`✓ ${destBinary}`);
    return destBinary;
  } finally {
    // Best-effort cleanup; ignore failures so a transient lock doesn't fail the run.
    try {
      await rm(stagingRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Resolve the host platform key (e.g. "win32-x64") the same way the CLI does
 * when no `--target` is passed. Exported so ensure-node can default sensibly.
 */
export function hostPlatformKey() {
  return resolvePlatformKey([]);
}

/**
 * Absolute path where the bundled Node binary is expected to live for the
 * given platform key (defaults to the host platform).
 */
export function bundledNodePath(platformKey = hostPlatformKey()) {
  const target = TARGETS[platformKey];
  if (!target) {
    throw new Error(`Unsupported target: ${platformKey}`);
  }
  const projectRoot = pathResolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(projectRoot, "src-tauri", "resources", "node", target.bin);
}

/**
 * True when the local portable Node binary is already present for the host
 * platform. Used by ensure-node to decide whether a download is needed.
 */
export function bundledNodeExists(platformKey = hostPlatformKey()) {
  return existsSync(bundledNodePath(platformKey));
}

// Only auto-run when invoked directly (`node scripts/fetch-node.mjs`), not
// when imported as a module by ensure-node.mjs.
const invokedDirectly =
  process.argv[1] && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
