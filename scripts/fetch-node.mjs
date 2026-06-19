// Downloads a portable Node.js runtime and stores `node[.exe]` under
// `src-tauri/resources/node/` so the Tauri app can spawn the agent sidecar
// without depending on the user's system Node install. Pinning a specific
// runtime version means coworkers all run the agent against an identical
// environment.
//
// Usage:
//   npm run fetch-node                  # fetch for the host platform
//   npm run fetch-node -- --target=win32-x64
//   npm run fetch-node -- --target=darwin-arm64
//
// Run this once before bundling a release; the file is gitignored.
import { existsSync, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";

const NODE_VERSION = "22.11.0"; // Active LTS at time of writing.

// Mirror order. The official nodejs.org host can be slow or blocked from some
// networks (notably mainland China), so we try a small set of well-known
// mirrors before giving up. Set DBSCOUT_NODE_MIRROR to prepend a custom one.
//
// Each entry is the prefix that gets `v<NODE_VERSION>/<archive>` appended.
const DEFAULT_MIRRORS = [
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/", // Tsinghua (CN)
  "https://npmmirror.com/mirrors/node/",                  // Aliyun (CN)
  "https://mirrors.aliyun.com/nodejs-release/",           // Aliyun raw (CN)
  "https://nodejs.org/dist/",                             // Official (global)
];

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
  const target = TARGETS[platformKey];
  if (!target) {
    console.error(
      `Unsupported target: ${platformKey}\nAvailable: ${Object.keys(TARGETS).join(", ")}`
    );
    process.exit(1);
  }

  const projectRoot = pathResolve(dirname(fileURLToPath(import.meta.url)), "..");
  const destDir = join(projectRoot, "src-tauri", "resources", "node");
  const destBinary = join(destDir, target.bin);

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
  } finally {
    // Best-effort cleanup; ignore failures so a transient lock doesn't fail the run.
    try {
      await rm(stagingRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
