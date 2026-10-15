// Downloads a pinned Windows Apache Subversion command-line package and
// installs the updater-only files under `src-tauri/resources/svn/`.
// Production Windows installers include this directory so colleagues do not
// need a system-wide svn.exe. The binaries are gitignored; run
// `npm run fetch-svn` or let `ensure-svn` fetch them before `tauri build`.
//
// Override the download URL with DBSCOUT_SVN_URL.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SVN_PACKAGE = Object.freeze({
  url: "https://www.visualsvn.com/files/Apache-Subversion-1.14.5.zip",
  sha256: "23d393431b0aeec67490669b7d3b4a1a83332fdc184055fef48ea9123eaf7e0a",
  size: 4227878,
});

export const SVN_COMPAT_PACKAGE = Object.freeze({
  url: "https://www.visualsvn.com/files/Apache-Subversion-1.9.7.zip",
  sha256: "a2e99c9bbbf9a52cda22343e825e9c4a1b28be529cd763ca124690f549d998a2",
  size: 3358359,
  subdirectory: "compat-1.9.7",
});
export const SVN_PACKAGES = [SVN_PACKAGE, SVN_COMPAT_PACKAGE];

function projectRootFrom(root) {
  return root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function bundledSvnDir(root, packageSpec = SVN_PACKAGE) {
  return path.join(projectRootFrom(root), "src-tauri", "resources", "svn", packageSpec.subdirectory || "");
}

export function bundledSvnPath(root, packageSpec = SVN_PACKAGE) {
  return path.join(bundledSvnDir(root, packageSpec), "svn.exe");
}

export function bundledSvnExists(root, packageSpec = SVN_PACKAGE) {
  return existsSync(bundledSvnPath(root, packageSpec));
}

export function bundledSvnClientsExist(root) {
  return SVN_PACKAGES.every((spec) => bundledSvnExists(root, spec));
}

function normalizeEntry(entry) {
  return String(entry || "").replaceAll("\\", "/").replace(/^\/+/, "");
}

export function isBundledSvnEntry(entry) {
  const name = normalizeEntry(entry);
  const lower = name.toLowerCase();
  const base = lower.split("/").pop();
  if (!base) return false;
  if (lower === "licenses" || lower.endsWith("/licenses")) return false;
  if (lower === "licenses/" || lower.includes("/licenses/") || lower.startsWith("licenses/")) {
    return base !== "licenses";
  }
  if (base === "svn.exe") return true;
  return base.endsWith(".dll") && (lower.includes("/bin/") || lower.startsWith("bin/"));
}

export function relativeBundledSvnPath(entry) {
  const name = normalizeEntry(entry);
  const parts = name.split("/");
  const licenseIndex = parts.findIndex((part) => part.toLowerCase() === "licenses");
  if (licenseIndex >= 0 && licenseIndex < parts.length - 1) {
    return path.join("Licenses", ...parts.slice(licenseIndex + 1));
  }
  return parts[parts.length - 1];
}

export function verifyFileSha256(filePath, expected) {
  const digest = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  const wanted = String(expected || "").toLowerCase();
  if (digest !== wanted) {
    throw new Error(`SVN package SHA-256 mismatch: expected ${wanted}, got ${digest}`);
  }
  return digest;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("http://") ? http : https;
    const request = client.get(url, { timeout: 60000 }, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        downloadFile(response.headers.location, dest).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      const file = createWriteStream(dest);
      response.pipe(file);
      file.on("finish", () => file.close((error) => (error ? reject(error) : resolve())));
      file.on("error", reject);
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("connection timed out")));
  });
}

function extractArchive(archivePath, destDir) {
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "ignore" },
    );
    return;
  }
  execFileSync("unzip", ["-q", archivePath, "-d", destDir], { stdio: "ignore" });
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function defaultDownload(url, dest) {
  const override = url === SVN_COMPAT_PACKAGE.url ? process.env.DBSCOUT_SVN_COMPAT_URL : process.env.DBSCOUT_SVN_URL;
  const urls = [override, url].filter(Boolean);
  let lastError = null;
  for (const candidate of [...new Set(urls)]) {
    try {
      console.log(`  → ${candidate}`);
      await downloadFile(candidate, dest);
      return;
    } catch (error) {
      lastError = error;
      console.log(`    failed: ${error.message || error}`);
    }
  }
  throw new Error(`Failed to download the bundled SVN package. Last error: ${lastError?.message || lastError}`);
}

export async function fetchSvn({
  root,
  force = false,
  packageSpec = SVN_PACKAGE,
  download = defaultDownload,
} = {}) {
  const destDir = bundledSvnDir(root, packageSpec);
  const destBinary = bundledSvnPath(root, packageSpec);
  if (!force && existsSync(destBinary)) {
    console.log(`Bundled svn.exe already present at ${destBinary}`);
    return destBinary;
  }

  const stagingRoot = await mkdtemp(path.join(tmpdir(), "dbscout-svn-"));
  try {
    const archivePath = path.join(stagingRoot, "svn.zip");
    await download(packageSpec.url, archivePath);
    if (!existsSync(archivePath)) throw new Error("SVN package download produced no file");
    const actualSize = statSync(archivePath).size;
    if (Number.isFinite(packageSpec.size) && actualSize !== packageSpec.size) {
      throw new Error(`SVN package size mismatch: expected ${packageSpec.size}, got ${actualSize}`);
    }
    verifyFileSha256(archivePath, packageSpec.sha256);

    const extracted = path.join(stagingRoot, "extracted");
    mkdirSync(extracted, { recursive: true });
    extractArchive(archivePath, extracted);

    const selected = walkFiles(extracted)
      .map((filePath) => ({
        filePath,
        entry: path.relative(extracted, filePath),
      }))
      .filter((item) => isBundledSvnEntry(item.entry));
    if (!selected.some((item) => relativeBundledSvnPath(item.entry).toLowerCase() === "svn.exe")) {
      throw new Error("SVN archive did not contain bin/svn.exe");
    }

    mkdirSync(destDir, { recursive: true });
    for (const item of selected) {
      const target = path.join(destDir, relativeBundledSvnPath(item.entry));
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(item.filePath, target);
    }
    if (!existsSync(destBinary)) throw new Error(`Failed to install bundled svn.exe to ${destBinary}`);
    console.log(`✓ ${destBinary}`);
    return destBinary;
  } finally {
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  (async () => {
    for (const packageSpec of SVN_PACKAGES) {
      await fetchSvn({ packageSpec, force: process.argv.includes("--force") });
    }
  })().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
