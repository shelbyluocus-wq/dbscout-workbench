import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 5_000;
const MAX_COLUMNS_PER_SHEET = 200;
const MAX_TOTAL_CELLS = 200_000;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const EXCEL_CELL_TEXT_LIMIT = 32_767;
const ARTIFACT_VERSION = 1;

const TEXT_FORMATS = new Set(["txt", "md", "json", "csv", "html", "sql"]);
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const cellSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export function defaultArtifactOutputDir(home = homedir()) {
  return path.join(home, "Documents", "DB Scout Workbench", "Agent Files");
}

export function resolveArtifactOutputDir() {
  const configured = String(process.env.DBSCOUT_AGENT_OUTPUT_DIR || "").trim();
  return path.resolve(configured || defaultArtifactOutputDir());
}

function ensureOutputDir(outputDir) {
  const resolved = path.resolve(String(outputDir || resolveArtifactOutputDir()));
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function normalizedExtension(format) {
  const value = String(format || "").trim().toLowerCase().replace(/^\./, "");
  if (value === "markdown") return "md";
  if (value === "text") return "txt";
  return value;
}

function safeFileName(input, extension, fallbackStem) {
  const raw = path.basename(String(input || "").trim() || `${fallbackStem}.${extension}`);
  const currentExtension = path.extname(raw);
  let stem = (currentExtension ? raw.slice(0, -currentExtension.length) : raw)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  if (!stem || WINDOWS_RESERVED_NAMES.test(stem)) stem = fallbackStem;
  return `${stem}.${extension}`;
}

function uniqueOutputPath(outputDir, fileName) {
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, -extension.length);
  for (let index = 1; index <= 9_999; index += 1) {
    const candidateName = index === 1 ? fileName : `${stem}-${index}${extension}`;
    const candidate = path.join(outputDir, candidateName);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("同名文件过多，无法分配新的文件名。");
}

function safeSheetName(input, usedNames) {
  const base = String(input || "Sheet")
    .replace(/[\[\]:*?/\\]/g, "_")
    .trim()
    .slice(0, 31) || "Sheet";
  let candidate = base;
  for (let index = 2; usedNames.has(candidate.toLowerCase()); index += 1) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function normalizeCell(value) {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value);
  return text.length > EXCEL_CELL_TEXT_LIMIT
    ? `${text.slice(0, EXCEL_CELL_TEXT_LIMIT - 1)}…`
    : text;
}

function columnWidth(rows, columnIndex) {
  let width = 8;
  for (const row of rows.slice(0, 1_000)) {
    const text = String(row[columnIndex] ?? "");
    let visualLength = 0;
    for (const character of text.slice(0, 80)) {
      visualLength += character.charCodeAt(0) > 255 ? 2 : 1;
    }
    width = Math.max(width, visualLength + 2);
  }
  return Math.min(width, 40);
}

function artifactMetadata(filePath, details) {
  const stat = statSync(filePath);
  return {
    artifactVersion: ARTIFACT_VERSION,
    fileName: path.basename(filePath),
    path: filePath,
    directory: path.dirname(filePath),
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
    ...details,
  };
}

function writeExclusive(filePath, data) {
  try {
    writeFileSync(filePath, data, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("文件名刚刚被占用，请重新生成一次。");
    }
    throw error;
  }
}

export async function createSpreadsheetForTest(args, options = {}) {
  const outputDir = ensureOutputDir(options.outputDir);
  const sheets = Array.isArray(args?.sheets) ? args.sheets : [];
  if (!sheets.length) throw new Error("Excel 至少需要一个工作表。");
  if (sheets.length > MAX_SHEETS) throw new Error(`Excel 最多支持 ${MAX_SHEETS} 个工作表。`);

  let totalRows = 0;
  let totalCells = 0;
  const workbook = XLSX.utils.book_new();
  const usedNames = new Set();

  for (const sheet of sheets) {
    const headers = Array.isArray(sheet?.headers) ? sheet.headers.map(normalizeCell) : [];
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    if (!headers.length) throw new Error("每个工作表都需要 headers。 ");
    if (headers.length > MAX_COLUMNS_PER_SHEET) {
      throw new Error(`每个工作表最多支持 ${MAX_COLUMNS_PER_SHEET} 列。`);
    }
    if (rows.length > MAX_ROWS_PER_SHEET) {
      throw new Error(`每个工作表最多支持 ${MAX_ROWS_PER_SHEET} 行。`);
    }

    const normalizedRows = rows.map((row) => {
      if (!Array.isArray(row)) throw new Error("工作表 rows 中的每一项都必须是单元格数组。");
      if (row.length > headers.length) throw new Error("数据行的列数不能超过 headers 的列数。");
      return headers.map((_, index) => normalizeCell(row[index]));
    });
    totalRows += normalizedRows.length;
    totalCells += (normalizedRows.length + 1) * headers.length;
    if (totalCells > MAX_TOTAL_CELLS) {
      throw new Error(`单个 Excel 最多支持 ${MAX_TOTAL_CELLS} 个单元格。`);
    }

    const aoa = [headers, ...normalizedRows];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    worksheet["!cols"] = headers.map((_, index) => ({ wch: columnWidth(aoa, index) }));
    worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: normalizedRows.length, c: headers.length - 1 } }) };
    const name = safeSheetName(sheet?.name, usedNames);
    XLSX.utils.book_append_sheet(workbook, worksheet, name);
  }

  const fileName = safeFileName(args?.fileName, "xlsx", "agent-export");
  const filePath = uniqueOutputPath(outputDir, fileName);
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "buffer", compression: true });
  writeExclusive(filePath, bytes);
  return artifactMetadata(filePath, {
    kind: "spreadsheet",
    format: "xlsx",
    sheetCount: sheets.length,
    rowCount: totalRows,
  });
}

export async function createTextFileForTest(args, options = {}) {
  const outputDir = ensureOutputDir(options.outputDir);
  const format = normalizedExtension(args?.format || "txt");
  if (!TEXT_FORMATS.has(format)) {
    throw new Error(`不支持的文本格式: ${format || "(空)"}`);
  }
  let content = String(args?.content ?? "");
  if (format === "json") {
    try {
      content = `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
    } catch (error) {
      throw new Error(`JSON 内容无效: ${error?.message || error}`);
    }
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_TEXT_BYTES) {
    throw new Error(`文本文件不能超过 ${MAX_TEXT_BYTES / 1024 / 1024} MB。`);
  }
  if (format === "csv" && !content.startsWith("\uFEFF")) content = `\uFEFF${content}`;

  const fileName = safeFileName(args?.fileName, format, "agent-output");
  const filePath = uniqueOutputPath(outputDir, fileName);
  writeExclusive(filePath, content);
  return artifactMetadata(filePath, {
    kind: "text",
    format,
  });
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createArtifactMcpServer({
  getOutputDir = resolveArtifactOutputDir,
  onArtifact = () => {},
} = {}) {
  const emitCreated = async (factory, args) => {
    const artifact = await factory(args, { outputDir: getOutputDir() });
    onArtifact(artifact);
    return textResult(artifact);
  };

  return createSdkMcpServer({
    name: "dbscout-artifacts",
    instructions:
      "Create new user-facing local files in the dedicated DB Scout Agent output directory. " +
      "Every tool is a write operation and requires approval unless auto-approve is enabled. " +
      "Never claim a file exists until the tool returns successfully. Existing files are never overwritten.",
    tools: [
      tool(
        "create_spreadsheet",
        "Create a local .xlsx workbook. Use this for Excel reports, database exports, comparisons, and structured tables. Supports multiple sheets. Requires user approval.",
        {
          fileName: z.string().min(1).max(160),
          sheets: z.array(z.object({
            name: z.string().min(1).max(80),
            headers: z.array(z.string().max(EXCEL_CELL_TEXT_LIMIT)).min(1).max(MAX_COLUMNS_PER_SHEET),
            rows: z.array(z.array(cellSchema).max(MAX_COLUMNS_PER_SHEET)).max(MAX_ROWS_PER_SHEET),
          })).min(1).max(MAX_SHEETS),
        },
        async (args) => emitCreated(createSpreadsheetForTest, args),
      ),
      tool(
        "create_text_file",
        "Create a local UTF-8 text file. Supported formats: txt, md, json, csv, html, sql. JSON is validated and formatted; CSV receives a UTF-8 BOM. Requires user approval.",
        {
          fileName: z.string().min(1).max(160),
          format: z.enum(["txt", "md", "json", "csv", "html", "sql"]),
          content: z.string().max(MAX_TEXT_BYTES),
        },
        async (args) => emitCreated(createTextFileForTest, args),
      ),
    ],
    alwaysLoad: true,
  });
}
