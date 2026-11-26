#!/usr/bin/env node
/**
 * Mirror clean Blackcat source code from this Git repository into a local SVN
 * working copy (e.g. `.../策划/开发工具/blackcat`).
 *
 * Design principles (方案 C — GitHub as single source of truth, on-demand SVN mirror):
 * - Never embeds a personal SVN path in the repository; resolves path from
 *   `--svn-dir`, `DBSCOUT_SVN_SOURCE_DIR`, or gitignored `.svn-sync.local.json`.
 * - Excludes build artifacts, local secrets, and Git-only AI/doc directories so
 *   the SVN mirror stays identical in scope to the existing source tree.
 * - Preserves target CRLF/LF line endings and skips files whose normalized text
 *   did not change, eliminating spurious cross-platform SVN diffs.
 * - Refuses to overwrite unmerged SVN-side changes (detected via per-file
 *   normalized hash baseline stored outside SVN in `.git/blackcat-svn-sync-state.json`)
 *   or unresolved SVN conflicts unless explicitly acknowledged with `--force`.
 * - Never executes `svn commit` automatically.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..");

export const LOCAL_CONFIG_FILENAME = ".svn-sync.local.json";
export const STATE_FILENAME = "blackcat-svn-sync-state.json";

/**
 * Top-level entries excluded from the SVN source mirror by default.
 * Matches the existing SVN `blackcat` directory layout (source code only,
 * without AI tool folders, internal agent guidelines, docs, or release manifests).
 */
export const DEFAULT_EXCLUDED_TOP_LEVEL = new Set([
  ".git",
  ".svn",
  ".agents",
  ".claude",
  ".codex",
  ".impeccable",
  ".jscpd.json",
  ".qoder",
  ".workbuddy",
  ".dev-server.tauri.json",
  ".svn-sync.local.json",
  ".DS_Store",
  "AGENTS.md",
  "CLAUDE.md",
  "PRODUCT.md",
  "docs",
  "latest.json",
  "node_modules",
  "dist",
  "target",
  "output",
  "tmp",
  ".worktrees",
  ".playwright-cli",
  "mcps",
  "agent-tools",
  "terminals",
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "output",
  ".worktrees",
  ".playwright-cli",
  "gen",
]);

const IGNORED_BASENAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "dbscout-server.sqlite",
  "dbscout-server.sqlite-wal",
  "dbscout-server.sqlite-shm",
  LOCAL_CONFIG_FILENAME,
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".icns",
  ".bmp",
  ".mp4",
  ".webm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".pdf",
  ".sqlite",
  ".db",
  ".xlsx",
]);

export function toPosixPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isExcludedRelativePath(relPath, { includeAiDocs = false } = {}) {
  const normalized = toPosixPath(relPath);
  if (!normalized || normalized.startsWith("../") || normalized === "..") return true;
  const segments = normalized.split("/");
  const top = segments[0];
  const base = segments[segments.length - 1];

  if (segments.includes(".git") || segments.includes(".svn")) return true;
  if (IGNORED_BASENAMES.has(base) || base.endsWith(".log")) return true;

  if (!includeAiDocs && DEFAULT_EXCLUDED_TOP_LEVEL.has(top)) {
    return true;
  }
  if (
    top === "node_modules" ||
    top === "dist" ||
    top === "target" ||
    top === "output" ||
    top === "tmp" ||
    top === ".worktrees" ||
    top === ".playwright-cli" ||
    top === ".dev-server.tauri.json" ||
    top === LOCAL_CONFIG_FILENAME
  ) {
    return true;
  }

  for (let i = 0; i < segments.length - 1; i += 1) {
    if (IGNORED_DIRECTORY_NAMES.has(segments[i])) return true;
  }

  if (
    normalized.startsWith("src-tauri/resources/node/") ||
    normalized === "src-tauri/resources/agent-runner.mjs" ||
    normalized === "src-tauri/resources/mcp-server.mjs" ||
    normalized === "src-tauri/resources/claude-code-native" ||
    normalized === "src-tauri/resources/claude-code-native.exe" ||
    normalized === "src-tauri/resources/agent-auth.local.json" ||
    (normalized.startsWith("src-tauri/resources/svn/") &&
      normalized !== "src-tauri/resources/svn/README.txt")
  ) {
    return true;
  }

  return false;
}

export function isBinaryBuffer(buffer, relPath = "") {
  const ext = path.extname(relPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  const sampleLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleLen; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function normalizeLineEndings(buffer) {
  return buffer.toString("utf8").replace(/\r\n/g, "\n");
}

export function detectLineEnding(buffer) {
  const text = buffer.toString("utf8");
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function applyLineEnding(lfText, lineEnding) {
  if (lineEnding === "\r\n") {
    return Buffer.from(lfText.replace(/\n/g, "\r\n"), "utf8");
  }
  return Buffer.from(lfText, "utf8");
}

export function computeComparableHash(buffer, relPath = "") {
  const hash = crypto.createHash("sha256");
  if (isBinaryBuffer(buffer, relPath)) {
    hash.update("bin:");
    hash.update(buffer);
  } else {
    hash.update("txt:");
    hash.update(normalizeLineEndings(buffer), "utf8");
  }
  return hash.digest("hex");
}

export function findWorkingCopyRoot(directory) {
  let current = path.resolve(directory);
  while (true) {
    const marker = path.join(current, ".svn");
    try {
      if (fs.statSync(marker).isDirectory()) return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function validateSvnDirectory(rawDir, repoRoot = REPO_ROOT) {
  const trimmed = String(rawDir || "").trim();
  if (!trimmed) {
    throw new Error(
      `未指定 SVN 目标目录。请传入 --svn-dir <路径>，设置环境变量 DBSCOUT_SVN_SOURCE_DIR，或用 --save-config 保存到本机 ${LOCAL_CONFIG_FILENAME}`,
    );
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`SVN 目标目录必须是绝对路径，当前为: ${trimmed}`);
  }
  let resolved;
  try {
    resolved = fs.realpathSync(trimmed);
  } catch {
    throw new Error(`SVN 目标目录不存在: ${trimmed}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`SVN 目标路径不是目录: ${resolved}`);
  }

  const resolvedRepo = fs.realpathSync(repoRoot);
  const relFromRepo = path.relative(resolvedRepo, resolved);
  if (
    resolved === resolvedRepo ||
    (!relFromRepo.startsWith("..") && !path.isAbsolute(relFromRepo))
  ) {
    throw new Error(`SVN 目标目录不能位于当前 Git 仓库内部: ${resolved}`);
  }

  const workingCopyRoot = findWorkingCopyRoot(resolved);
  if (!workingCopyRoot) {
    throw new Error(`未在目录或其上层找到 .svn 元数据，拒绝同步到非 SVN 目录: ${resolved}`);
  }

  return { directory: resolved, workingCopyRoot };
}

export function loadLocalConfig(repoRoot = REPO_ROOT) {
  const configPath = path.join(repoRoot, LOCAL_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new Error(`读取 ${LOCAL_CONFIG_FILENAME} 失败: ${error.message || error}`);
  }
}

export function saveLocalConfig(repoRoot, config) {
  const configPath = path.join(repoRoot, LOCAL_CONFIG_FILENAME);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export function parseArgs(argv, { env = process.env, repoRoot = REPO_ROOT } = {}) {
  const localConfig = loadLocalConfig(repoRoot);
  const options = {
    svnDir: env.DBSCOUT_SVN_SOURCE_DIR || localConfig.svnDir || "",
    source: "auto", // "auto" | "head" | "worktree"
    dryRun: false,
    force: false,
    includeAiDocs: Boolean(localConfig.includeAiDocs),
    saveConfig: false,
    svnUpdate: false,
    skipSvnCli: false,
    help: false,
  };

  const nextValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`参数 ${flag} 缺少取值`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--svn-dir") {
      options.svnDir = nextValue(i, arg);
      i += 1;
    } else if (arg === "--head") {
      options.source = "head";
    } else if (arg === "--worktree") {
      options.source = "worktree";
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--include-ai-docs") {
      options.includeAiDocs = true;
    } else if (arg === "--save-config") {
      options.saveConfig = true;
    } else if (arg === "--svn-update") {
      options.svnUpdate = true;
    } else if (arg === "--skip-svn-cli") {
      options.skipSvnCli = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return options;
}

function runCommand(cmd, args, { cwd, input, allowFailure = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    if (allowFailure) return { ok: false, status: -1, stdout: Buffer.alloc(0), stderr: result.error.message };
    throw new Error(`执行 ${cmd} 失败: ${result.error.message}`);
  }
  const ok = result.status === 0;
  if (!ok && !allowFailure) {
    const stderr = result.stderr ? result.stderr.toString("utf8").trim() : "";
    throw new Error(`${cmd} ${args.join(" ")} 执行失败 (退出码 ${result.status}): ${stderr}`);
  }
  return {
    ok,
    status: result.status ?? -1,
    stdout: result.stdout || Buffer.alloc(0),
    stderr: result.stderr ? result.stderr.toString("utf8") : "",
  };
}

function resolveStateFilePath(repoRoot) {
  const res = runCommand("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (res.ok) {
    const gitDir = res.stdout.toString("utf8").trim();
    if (gitDir) {
      return path.resolve(repoRoot, gitDir, STATE_FILENAME);
    }
  }
  return path.join(repoRoot, ".git", STATE_FILENAME);
}

export function readSyncState(statePath) {
  if (!fs.existsSync(statePath)) return { targets: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.targets
      ? parsed
      : { targets: {} };
  } catch {
    return { targets: {} };
  }
}

export function writeSyncState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getGitHeadSha(repoRoot) {
  const res = runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot, allowFailure: true });
  return res.ok ? res.stdout.toString("utf8").trim() : null;
}

function listDirtyIncludedGitFiles(repoRoot, { includeAiDocs = false } = {}) {
  const res = runCommand("git", ["status", "--porcelain", "-z"], { cwd: repoRoot });
  const raw = res.stdout.toString("utf8");
  const dirty = [];
  const entries = raw.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const statusCode = entry.slice(0, 2);
    const filePath = toPosixPath(entry.slice(3));
    if (statusCode[0] === "R" || statusCode[0] === "C") {
      // Rename/copy entry consumes a second NUL-delimited path in porcelain -z.
      i += 1;
    }
    if (!isExcludedRelativePath(filePath, { includeAiDocs })) {
      dirty.push(filePath);
    }
  }
  return dirty;
}

function readGitHeadFiles(repoRoot, { includeAiDocs = false } = {}) {
  const treeRes = runCommand("git", ["ls-tree", "-r", "-z", "HEAD"], { cwd: repoRoot });
  const entries = [];
  for (const rawEntry of treeRes.stdout.toString("utf8").split("\0")) {
    if (!rawEntry) continue;
    const tabIndex = rawEntry.indexOf("\t");
    if (tabIndex < 0) continue;
    const meta = rawEntry.slice(0, tabIndex).split(" ");
    const type = meta[1];
    const oid = meta[2];
    const relPath = toPosixPath(rawEntry.slice(tabIndex + 1));
    if (type !== "blob") continue;
    if (isExcludedRelativePath(relPath, { includeAiDocs })) continue;
    entries.push({ oid, relPath });
  }

  const files = new Map();
  if (entries.length === 0) return files;

  const batchInput = entries.map((e) => e.oid).join("\n") + "\n";
  const batchRes = runCommand("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: batchInput,
  });
  const buf = batchRes.stdout;
  let offset = 0;
  for (const entry of entries) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) {
      throw new Error(`解析 git cat-file 输出失败: ${entry.relPath}`);
    }
    const header = buf.subarray(offset, nl).toString("utf8");
    const parts = header.split(" ");
    if (parts[1] === "missing") {
      throw new Error(`Git 对象缺失: ${entry.relPath} (${entry.oid})`);
    }
    const size = Number(parts[2]);
    const contentStart = nl + 1;
    const contentEnd = contentStart + size;
    files.set(entry.relPath, Buffer.from(buf.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1; // trailing LF after object payload
  }

  return files;
}

function readGitWorktreeFiles(repoRoot, { includeAiDocs = false } = {}) {
  const res = runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot },
  );
  const files = new Map();
  const seen = new Set();
  for (const rawPath of res.stdout.toString("utf8").split("\0")) {
    if (!rawPath) continue;
    const relPath = toPosixPath(rawPath);
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    if (isExcludedRelativePath(relPath, { includeAiDocs })) continue;
    const absPath = path.join(repoRoot, relPath);
    let stat;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      continue; // deleted in worktree
    }
    if (!stat.isFile()) continue;
    files.set(relPath, fs.readFileSync(absPath));
  }
  return files;
}

export function scanManagedTargetFiles(svnDir, { includeAiDocs = false } = {}) {
  const files = new Map();

  function walk(absDir, relPrefix) {
    for (const dirent of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (dirent.name === ".svn" || dirent.name === ".git") continue;
      const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      const absPath = path.join(absDir, dirent.name);
      if (dirent.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(dirent.name)) continue;
        if (!relPrefix && !includeAiDocs && DEFAULT_EXCLUDED_TOP_LEVEL.has(dirent.name)) {
          continue;
        }
        walk(absPath, relPath);
      } else if (dirent.isFile()) {
        if (isExcludedRelativePath(relPath, { includeAiDocs })) continue;
        files.set(relPath, absPath);
      }
    }
  }

  walk(svnDir, "");
  return files;
}

function detectTargetDefaultLineEnding(svnDir) {
  for (const probe of ["package.json", "Cargo.toml", "README.md"]) {
    const abs = path.join(svnDir, probe);
    if (fs.existsSync(abs)) {
      try {
        return detectLineEnding(fs.readFileSync(abs));
      } catch {
        // ignore probe failure
      }
    }
  }
  return "\n";
}

function readSvnMetadata(svnDir, svnBin = "svn") {
  const infoRes = runCommand(svnBin, ["info", svnDir], { allowFailure: true });
  if (!infoRes.ok) {
    return {
      available: false,
      error: infoRes.stderr.trim() || `svn info 退出码 ${infoRes.status}`,
    };
  }
  const text = infoRes.stdout.toString("utf8");
  const extract = (label) => {
    const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
    return match ? match[1].trim() : null;
  };
  return {
    available: true,
    url: extract("URL"),
    revision: extract("Revision"),
    lastChangedRev: extract("Last Changed Rev"),
    lastChangedAuthor: extract("Last Changed Author"),
    lastChangedDate: extract("Last Changed Date"),
  };
}

function readSvnStatus(svnDir, svnBin = "svn") {
  const res = runCommand(svnBin, ["status", "."], { cwd: svnDir, allowFailure: true });
  if (!res.ok) {
    return {
      available: false,
      error: res.stderr.trim() || `svn status 退出码 ${res.status}`,
      entries: [],
    };
  }
  const entries = [];
  for (const line of res.stdout.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 7);
    const relPath = toPosixPath(line.slice(8).trim());
    if (!relPath || path.basename(relPath) === ".DS_Store") continue;
    entries.push({ code, status: code[0], treeConflict: code[6] === "C", relPath });
  }
  return { available: true, entries };
}

function formatSvnStatusPreview(entries) {
  const preview = entries
    .slice(0, 10)
    .map((e) => `${e.status} ${e.relPath}`)
    .join("\n  ");
  const more = entries.length > 10 ? `\n  ... 共 ${entries.length} 项` : "";
  return `${preview}${more}`;
}

function runSvnUpdateOrThrow(svnDir, { svnBin = "svn", force = false } = {}) {
  const info = readSvnMetadata(svnDir, svnBin);
  if (!info.available) {
    throw new Error(
      `SVN 更新前置检查失败（无法执行 svn info），已停止同步：${info.error || svnDir}`,
    );
  }

  const preStatus = readSvnStatus(svnDir, svnBin);
  if (!preStatus.available) {
    throw new Error(
      `SVN 状态检查失败，已停止更新与同步：${preStatus.error || svnDir}`,
    );
  }

  const preConflicts = preStatus.entries.filter((e) => e.status === "C" || e.treeConflict);
  if (preConflicts.length > 0) {
    throw new Error(
      `SVN 目录存在未解决的冲突，已停止更新与同步：${preConflicts.map((c) => c.relPath).join(", ")}`,
    );
  }
  if (!force && preStatus.entries.length > 0) {
    throw new Error(
      `SVN 目录有未提交的本地改动，已停止 svn update 与同步：\n  ${formatSvnStatusPreview(preStatus.entries)}\n` +
        `请先在 SVN 中提交/还原，或确认要覆盖时加上 --force。`,
    );
  }

  const cleanupRes = runCommand(svnBin, ["cleanup", "."], {
    cwd: svnDir,
    allowFailure: true,
  });
  if (!cleanupRes.ok) {
    throw new Error(
      `svn cleanup 失败，已停止同步：${cleanupRes.stderr.trim() || `退出码 ${cleanupRes.status}`}`,
    );
  }

  const updateRes = runCommand(svnBin, ["update", "--non-interactive", "."], {
    cwd: svnDir,
    allowFailure: true,
  });
  if (!updateRes.ok) {
    throw new Error(
      `svn update 失败，已停止同步：${updateRes.stderr.trim() || `退出码 ${updateRes.status}`}`,
    );
  }

  const postStatus = readSvnStatus(svnDir, svnBin);
  if (!postStatus.available) {
    throw new Error(
      `svn update 后状态检查失败，已停止同步：${postStatus.error || svnDir}`,
    );
  }
  const postConflicts = postStatus.entries.filter((e) => e.status === "C" || e.treeConflict);
  if (postConflicts.length > 0) {
    throw new Error(
      `svn update 后产生冲突，已停止同步：${postConflicts.map((c) => c.relPath).join(", ")}`,
    );
  }

  return {
    info: readSvnMetadata(svnDir, svnBin),
    status: postStatus,
    updateOutput: updateRes.stdout.toString("utf8").trim(),
  };
}

function escapeSvnPath(relPath) {
  return relPath.includes("@") ? `${relPath}@` : relPath;
}

function runSvnInChunks(svnDir, subArgs, relPaths, svnBin = "svn") {
  const chunkSize = 80;
  for (let i = 0; i < relPaths.length; i += chunkSize) {
    const chunk = relPaths.slice(i, i + chunkSize).map(escapeSvnPath);
    runCommand(svnBin, [...subArgs, ...chunk], { cwd: svnDir });
  }
}

function pruneEmptyTargetDirectories(svnDir, { useSvnCli = false, svnBin = "svn" } = {}) {
  const removedDirs = [];

  function walk(absDir, relPrefix) {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const dirent of entries) {
      if (dirent.name === ".svn" || dirent.name === ".git") continue;
      if (dirent.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(dirent.name)) continue;
        const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
        walk(path.join(absDir, dirent.name), relPath);
      }
    }

    if (!relPrefix) return;
    const remaining = fs
      .readdirSync(absDir)
      .filter((name) => name !== ".svn" && name !== ".DS_Store");
    if (remaining.length === 0) {
      if (useSvnCli) {
        const res = runCommand(svnBin, ["delete", "--force", escapeSvnPath(relPrefix)], {
          cwd: svnDir,
          allowFailure: true,
        });
        if (!res.ok && fs.existsSync(absDir)) {
          fs.rmSync(absDir, { recursive: true, force: true });
        }
      } else {
        fs.rmSync(absDir, { recursive: true, force: true });
      }
      removedDirs.push(relPrefix);
    }
  }

  walk(svnDir, "");
  return removedDirs;
}

/**
 * Compute and optionally execute a source mirror sync from Git to an SVN working copy.
 */
export function syncSourceToSvn(rawOptions = {}) {
  const repoRoot = rawOptions.repoRoot ? path.resolve(rawOptions.repoRoot) : REPO_ROOT;
  const includeAiDocs = Boolean(rawOptions.includeAiDocs);
  const dryRun = Boolean(rawOptions.dryRun);
  const force = Boolean(rawOptions.force);
  const svnUpdate = Boolean(rawOptions.svnUpdate);
  const skipSvnCli = Boolean(rawOptions.skipSvnCli);
  const svnBin = rawOptions.svnBin || "svn";

  if (svnUpdate && skipSvnCli) {
    throw new Error("--svn-update 不能与 --skip-svn-cli 同时使用");
  }

  const { directory: svnDir, workingCopyRoot } = validateSvnDirectory(
    rawOptions.svnDir,
    repoRoot,
  );

  // 1. Resolve source mode (auto blocks dirty worktree unless --head or --worktree is explicit).
  let effectiveSource = rawOptions.source || "auto";
  if (effectiveSource === "auto") {
    const dirtyFiles = listDirtyIncludedGitFiles(repoRoot, { includeAiDocs });
    if (dirtyFiles.length > 0) {
      const preview = dirtyFiles.slice(0, 8).join(", ");
      const more = dirtyFiles.length > 8 ? ` 等共 ${dirtyFiles.length} 个文件` : "";
      throw new Error(
        `本地 Git 工作区有未提交的源码改动 (${preview}${more})。\n` +
          `为避免把半成品同步到 SVN，建议先 git commit 后再运行；\n` +
          `或显式指定：\n` +
          `  --head      仅同步已提交的 HEAD 版本\n` +
          `  --worktree  连同当前未提交改动一起同步`,
      );
    }
    effectiveSource = "worktree";
  }

  // 2. Optional fail-fast `svn cleanup` + `svn update --non-interactive` before scanning target files.
  let svnInfo;
  let svnStatus;
  let svnUpdated = false;
  if (svnUpdate && !dryRun) {
    const updateResult = runSvnUpdateOrThrow(svnDir, { svnBin, force });
    svnInfo = updateResult.info;
    svnStatus = updateResult.status;
    svnUpdated = true;
  } else {
    svnInfo = skipSvnCli ? { available: false } : readSvnMetadata(svnDir, svnBin);
    svnStatus = skipSvnCli ? { available: false, entries: [] } : readSvnStatus(svnDir, svnBin);
  }

  if (svnStatus.available) {
    const conflicts = svnStatus.entries.filter((e) => e.status === "C" || e.treeConflict);
    if (conflicts.length > 0) {
      throw new Error(
        `SVN 目录存在未解决的冲突，已停止同步：${conflicts.map((c) => c.relPath).join(", ")}`,
      );
    }
    if (!force && svnStatus.entries.length > 0) {
      throw new Error(
        `SVN 目录有未提交的本地改动，已停止同步以防覆盖：\n  ${formatSvnStatusPreview(svnStatus.entries)}\n` +
          `请先在 SVN 中提交/处理，或确认要覆盖时加上 --force。`,
      );
    }
  }

  const sourceFiles =
    effectiveSource === "head"
      ? readGitHeadFiles(repoRoot, { includeAiDocs })
      : readGitWorktreeFiles(repoRoot, { includeAiDocs });

  const targetFiles = scanManagedTargetFiles(svnDir, { includeAiDocs });

  // 3. Anti-clobber check against previous sync baseline (catches `svn update` changes from others!).
  const statePath = rawOptions.statePath || resolveStateFilePath(repoRoot);
  const fullState = readSyncState(statePath);
  const prevTargetState = fullState.targets[svnDir] || null;
  const prevHashes = prevTargetState?.fileHashes || null;

  const sourceHashes = new Map();
  for (const [relPath, buf] of sourceFiles.entries()) {
    sourceHashes.set(relPath, computeComparableHash(buf, relPath));
  }

  const targetBytesCache = new Map();
  const targetHashes = new Map();
  for (const [relPath, absPath] of targetFiles.entries()) {
    const bytes = fs.readFileSync(absPath);
    targetBytesCache.set(relPath, bytes);
    targetHashes.set(relPath, computeComparableHash(bytes, relPath));
  }

  const unmergedSvnChanges = [];
  if (prevHashes) {
    for (const [relPath, curTargetHash] of targetHashes.entries()) {
      const baselineHash = prevHashes[relPath];
      const curSourceHash = sourceHashes.get(relPath);
      if (baselineHash === undefined) {
        if (curSourceHash !== curTargetHash) {
          unmergedSvnChanges.push({ relPath, reason: "svn-added" });
        }
      } else if (curTargetHash !== baselineHash && curSourceHash !== curTargetHash) {
        unmergedSvnChanges.push({ relPath, reason: "svn-modified" });
      }
    }
  }

  if (!force && unmergedSvnChanges.length > 0) {
    const preview = unmergedSvnChanges
      .slice(0, 12)
      .map((item) => `${item.reason === "svn-added" ? "SVN新增" : "SVN有改动"} ${item.relPath}`)
      .join("\n  ");
    const more =
      unmergedSvnChanges.length > 12 ? `\n  ... 共 ${unmergedSvnChanges.length} 个文件` : "";
    throw new Error(
      `检测到 SVN 目录存在未合并回 Git 的改动，已停止同步以防覆盖：\n  ${preview}${more}\n` +
        `请先将这些改动合并回 Git，或确认以 Git 为准覆盖时加上 --force。`,
    );
  }

  // 4. Plan adds, updates, deletes, and unchanged files (CRLF-aware).
  const defaultLineEnding = detectTargetDefaultLineEnding(svnDir);
  const added = [];
  const updated = [];
  const deleted = [];
  let unchangedCount = 0;

  for (const [relPath, srcBuf] of sourceFiles.entries()) {
    const srcHash = sourceHashes.get(relPath);
    const dstHash = targetHashes.get(relPath);
    if (dstHash === undefined) {
      added.push(relPath);
    } else if (dstHash !== srcHash) {
      updated.push(relPath);
    } else {
      unchangedCount += 1;
    }
  }

  for (const relPath of targetFiles.keys()) {
    if (!sourceFiles.has(relPath)) {
      deleted.push(relPath);
    }
  }

  added.sort();
  updated.sort();
  deleted.sort();

  // 5. Apply changes unless --dry-run.
  const useSvnCli = !skipSvnCli && svnInfo.available;
  let removedDirs = [];
  if (!dryRun) {
    for (const relPath of [...added, ...updated]) {
      const srcBuf = sourceFiles.get(relPath);
      const dstPath = path.join(svnDir, relPath);
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });

      let outBuf;
      if (isBinaryBuffer(srcBuf, relPath)) {
        outBuf = srcBuf;
      } else {
        const existingBytes = targetBytesCache.get(relPath);
        const lineEnding = existingBytes
          ? detectLineEnding(existingBytes)
          : defaultLineEnding;
        outBuf = applyLineEnding(normalizeLineEndings(srcBuf), lineEnding);
      }
      fs.writeFileSync(dstPath, outBuf);
    }

    if (deleted.length > 0) {
      if (useSvnCli) {
        const versionedToDelete = [];
        for (const relPath of deleted) {
          const check = runCommand(svnBin, ["info", escapeSvnPath(relPath)], {
            cwd: svnDir,
            allowFailure: true,
          });
          if (check.ok) {
            versionedToDelete.push(relPath);
          } else {
            fs.rmSync(path.join(svnDir, relPath), { force: true });
          }
        }
        if (versionedToDelete.length > 0) {
          runSvnInChunks(svnDir, ["delete", "--force"], versionedToDelete, svnBin);
        }
      } else {
        for (const relPath of deleted) {
          fs.rmSync(path.join(svnDir, relPath), { force: true });
        }
      }
      removedDirs = pruneEmptyTargetDirectories(svnDir, { useSvnCli, svnBin });
    }

    if (added.length > 0 && useSvnCli) {
      runSvnInChunks(svnDir, ["add", "--parents", "--force"], added, svnBin);
    }

    // Record updated normalized hashes outside SVN so next run detects SVN-side changes.
    const nextFileHashes = {};
    for (const [relPath, hash] of [...sourceHashes.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      nextFileHashes[relPath] = hash;
    }
    fullState.targets[svnDir] = {
      lastSyncedAt: new Date().toISOString(),
      lastGitHead: getGitHeadSha(repoRoot),
      source: effectiveSource,
      lastSvnUrl: svnInfo.url || null,
      lastSvnRevision: svnInfo.revision || null,
      lastSvnChangedRev: svnInfo.lastChangedRev || null,
      lastSvnChangedAuthor: svnInfo.lastChangedAuthor || null,
      fileHashes: nextFileHashes,
    };
    writeSyncState(statePath, fullState);
  }

  return {
    svnDir,
    svnUrl: svnInfo.url || null,
    workingCopyRoot,
    source: effectiveSource,
    dryRun,
    svnUpdated,
    usedSvnCli: useSvnCli,
    added,
    updated,
    deleted,
    removedDirs,
    unchangedCount,
    unmergedSvnChanges,
  };
}

function printHelp() {
  console.log(`黑猫源码单向同步工具（GitHub/Git → 本地 SVN 工作副本）

用法:
  npm run sync:svn -- [选项]

选项:
  --svn-dir <路径>    本地 SVN 源码目录绝对路径（也可用环境变量 DBSCOUT_SVN_SOURCE_DIR
                      或通过 --save-config 保存到本机忽略文件 ${LOCAL_CONFIG_FILENAME}）
  --save-config       将当前 --svn-dir 保存到本机 ${LOCAL_CONFIG_FILENAME}（不会提交进 Git/SVN）
  --svn-update        同步前先执行 svn cleanup 与 svn update --non-interactive；
                      一旦更新失败、断网或出现冲突立即停止，绝不继续覆盖
  --head              仅同步 Git 已提交的 HEAD 快照（忽略未提交改动）
  --worktree          连同当前工作区未提交的源码改动一起同步（仍遵循 .gitignore）
  --include-ai-docs   同时同步 AGENTS.md / CLAUDE.md / docs / .agents 等目录（默认排除）
  --dry-run           仅预览新增/更新/删除清单，不写入 SVN 目录（也不执行 svn update）
  --force             忽略 SVN 本地修改与未合并差异警告，强制以 Git 覆盖
  --skip-svn-cli      仅同步文件，不调用 svn add / svn delete
  -h, --help          显示帮助

说明:
  - 默认只在 Git 工作区干净时同步，防止把半成品带进 SVN。
  - 自动跳过仅换行符不同的文件，避免 Windows/macOS 跨平台产生海量假改动。
  - 绝不会自动执行 svn commit，同步后请自行检查并在 SVN 工具中提交。
`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.saveConfig) {
    const { directory } = validateSvnDirectory(options.svnDir, REPO_ROOT);
    const saved = saveLocalConfig(REPO_ROOT, {
      svnDir: directory,
      includeAiDocs: options.includeAiDocs,
    });
    console.log(`已保存本机 SVN 目录配置到 ${saved}`);
  }

  const result = syncSourceToSvn(options);
  const tag = result.dryRun ? "[dry-run 预览]" : "[同步完成]";
  const urlSuffix = result.svnUrl ? ` | SVN 地址: ${result.svnUrl}` : "";
  console.log(`${tag} 目标 SVN 目录: ${result.svnDir}${urlSuffix} (来源: ${result.source})`);
  if (result.svnUpdated) {
    console.log("已通过 svn cleanup 与 svn update --non-interactive 更新工作副本。");
  }
  console.log(
    `统计: 新增 ${result.added.length} | 更新 ${result.updated.length} | 删除 ${result.deleted.length} | 未变 ${result.unchangedCount}`,
  );
  if (result.added.length > 0) {
    console.log("新增:");
    for (const f of result.added) console.log(`  + ${f}`);
  }
  if (result.updated.length > 0) {
    console.log("更新:");
    for (const f of result.updated) console.log(`  ~ ${f}`);
  }
  if (result.deleted.length > 0) {
    console.log("删除:");
    for (const f of result.deleted) console.log(`  - ${f}`);
  }
  if (!result.dryRun) {
    console.log(
      result.usedSvnCli
        ? "已自动处理 svn add / svn delete；未执行 svn commit，请检查差异后手动提交。"
        : "未调用 svn 命令行（仅同步文件）；请在 SVN 客户端检查差异后手动提交。",
    );
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`同步失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
