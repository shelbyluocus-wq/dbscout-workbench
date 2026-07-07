import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".tauri",
  ".venv",
  "coverage",
]);

const SENSITIVE_NAMES = new Set([".env", ".npmrc"]);
const SENSITIVE_SUFFIXES = [".pem", ".key"];
const MAX_READ_BYTES = 120_000;
const MAX_SEARCH_FILE_BYTES = 300_000;
const MAX_LIST_ITEMS = 500;

function selectedProject(context) {
  const project = context?.project;
  if (!project?.rootPath) throw new Error("未选择项目文件夹，请先在 Agent 顶部添加项目。");
  if (project.available === false) throw new Error("当前项目文件夹不可用，请重新选择或移除该项目。");
  return project;
}

function normalizeRelative(input) {
  const raw = String(input || ".").trim() || ".";
  const value = raw.replace(/\\/g, "/");
  if (value.includes("\0")) throw new Error("路径包含非法字符。");
  if (path.isAbsolute(raw) || path.isAbsolute(value) || /^[a-zA-Z]:\//.test(value)) {
    throw new Error("只能读取当前项目内的相对路径。");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("只能读取当前项目内的文件，不能使用 .. 跳出项目。");
  }
  return normalized === "." ? "" : normalized;
}

function rootRealPath(context) {
  const root = selectedProject(context).rootPath;
  return realpathSync(root);
}

function ensureInsideProject(context, relativeInput) {
  const root = rootRealPath(context);
  const relative = normalizeRelative(relativeInput);
  const candidate = path.resolve(root, relative);
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`项目路径不存在或无法读取: ${relative || "."}`);
  }
  const relFromRoot = path.relative(root, real);
  if (relFromRoot === "" || (!relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot))) {
    return { root, real, relative: relFromRoot.replace(/\\/g, "/") || "" };
  }
  throw new Error("只能读取当前项目内的文件，不能访问项目外路径。");
}

function pathParts(relativePath) {
  return String(relativePath || "").split(/[\\/]+/).filter(Boolean);
}

function isIgnoredRelative(relativePath) {
  return pathParts(relativePath).some((part) => DEFAULT_IGNORES.has(part));
}

function isSensitiveRelative(relativePath) {
  const parts = pathParts(relativePath);
  if (parts.includes(".ssh")) return true;
  const base = parts[parts.length - 1] || "";
  if (SENSITIVE_NAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function toProjectRelative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

export async function listProjectFilesForTest(context, args = {}) {
  const { root, real, relative } = ensureInsideProject(context, args.directory || ".");
  const startStat = statSync(real);
  if (!startStat.isDirectory()) throw new Error("list_project_files 只能列出目录。");
  const limit = Math.max(1, Math.min(Number(args.limit || 100), MAX_LIST_ITEMS));
  const files = [];
  const stack = [real];
  let truncated = false;

  while (stack.length) {
    const dir = stack.shift();
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const rel = toProjectRelative(root, fullPath);
      if (isIgnoredRelative(rel) || isSensitiveRelative(rel)) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(fullPath);
      files.push({ path: rel, sizeBytes: stat.size });
      if (files.length >= limit) {
        truncated = true;
        return { directory: relative || ".", files, truncated };
      }
    }
  }
  return { directory: relative || ".", files, truncated };
}

export async function readProjectFileForTest(context, args = {}) {
  const { root, real, relative } = ensureInsideProject(context, args.path || "");
  if (!relative) throw new Error("请提供要读取的项目内文件路径。");
  if (isIgnoredRelative(relative)) throw new Error("该路径位于默认忽略目录中，第一版不会读取构建产物或依赖目录。");
  if (isSensitiveRelative(relative)) throw new Error("敏感文件默认不可读取，第一版项目接入不提供敏感文件审批。");
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error("read_project_file 只能读取文件。");
  const bytes = readFileSync(real);
  if (isLikelyBinary(bytes)) throw new Error("该文件看起来是二进制文件，无法作为文本读取。");
  const truncated = bytes.length > MAX_READ_BYTES;
  const content = bytes.subarray(0, MAX_READ_BYTES).toString("utf8");
  return {
    path: toProjectRelative(root, real),
    sizeBytes: stat.size,
    truncated,
    content,
    note: truncated ? "文件过大，已返回前 120000 字节；请使用搜索缩小范围。" : "",
  };
}

export async function searchProjectFilesForTest(context, args = {}) {
  const keyword = String(args.keyword || "").trim();
  if (!keyword) throw new Error("请提供搜索关键字。");
  const limit = Math.max(1, Math.min(Number(args.limit || 50), 200));
  const listed = await listProjectFilesForTest(context, { directory: args.directory || ".", limit: MAX_LIST_ITEMS });
  const matches = [];
  for (const file of listed.files) {
    if (matches.length >= limit) break;
    if (file.sizeBytes > MAX_SEARCH_FILE_BYTES) continue;
    let result;
    try {
      result = await readProjectFileForTest(context, { path: file.path });
    } catch {
      continue;
    }
    const lines = result.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (matches.length >= limit) return;
      if (line.toLowerCase().includes(keyword.toLowerCase())) {
        matches.push({ path: file.path, line: index + 1, text: line.slice(0, 240) });
      }
    });
  }
  return { keyword, matches, truncated: matches.length >= limit || listed.truncated };
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createProjectMcpServer(getContext) {
  const current = () => (typeof getContext === "function" ? getContext() : {});
  return createSdkMcpServer({
    name: "dbscout-project",
    instructions:
      "You are connected to the user's current local project folder in read-only mode. " +
      "Use these tools for code and documentation questions. Do not claim to edit files or run project commands.",
    tools: [
      tool(
        "list_project_files",
        "List files under the current project folder. Call this when you need to understand project structure. Read-only.",
        {
          directory: z.string().optional().default("."),
          limit: z.number().int().min(1).max(MAX_LIST_ITEMS).optional().default(100),
        },
        async (args) => textResult(await listProjectFilesForTest(current(), args)),
      ),
      tool(
        "read_project_file",
        "Read one text file from the current project folder. Call this after locating a relevant file. Read-only.",
        { path: z.string().min(1) },
        async (args) => textResult(await readProjectFileForTest(current(), args)),
      ),
      tool(
        "search_project_files",
        "Search text in the current project folder. Call this when finding symbols, text, or relevant files. Read-only.",
        {
          keyword: z.string().min(1),
          directory: z.string().optional().default("."),
          limit: z.number().int().min(1).max(200).optional().default(50),
        },
        async (args) => textResult(await searchProjectFilesForTest(current(), args)),
      ),
    ],
    alwaysLoad: true,
  });
}
