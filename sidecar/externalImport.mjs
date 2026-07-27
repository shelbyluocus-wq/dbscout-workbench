import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_CELLS = 2_000_000;
const MAX_TEXT_CHARS = 25_000_000;
const PREVIEW_TTL_MS = 15 * 60 * 1000;

const previews = new Map();

function stringValue(value) {
  if (value == null) return "";
  return String(value);
}

function tableColumns(schema) {
  return Array.isArray(schema?.columns)
    ? schema.columns.map((column) => ({
        name: String(column.columnName || column.column_name || "").trim(),
        primary: Boolean(column.isPrimaryKey || column.is_primary_key),
      })).filter((column) => column.name)
    : [];
}

async function readWorkbook(sourcePath, selectedSheet = "") {
  const absolutePath = path.resolve(String(sourcePath || ""));
  if (!/\.xlsx$/i.test(absolutePath)) throw new Error("MCP 导入仅支持 .xlsx 文件");
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("导入路径不是文件");
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`XLSX 文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  }
  const bytes = await readFile(absolutePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false, dense: true });
  const sheetName = selectedSheet
    ? workbook.SheetNames.find((name) => name === selectedSheet)
    : workbook.SheetNames[0];
  if (!sheetName) throw new Error(`XLSX 中不存在工作表：${selectedSheet || "第一个工作表"}`);
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: "",
    raw: false,
    blankrows: false,
  });
  if (matrix.length < 2) throw new Error("XLSX 没有可导入的数据行");
  return { absolutePath, digest, sheetName, matrix };
}

function mapWorkbook(matrix, schema) {
  const columns = tableColumns(schema);
  if (!columns.length) throw new Error("目标表没有可导入字段");
  const byLowerName = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column]));
  const headers = matrix[0].map((value) => stringValue(value).trim());
  const seenTargets = new Set();
  const mappings = [];
  const ignoredColumns = [];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (!header) continue;
    const target = byLowerName.get(header.toLocaleLowerCase());
    if (!target) {
      ignoredColumns.push(header);
      continue;
    }
    if (seenTargets.has(target.name)) {
      throw new Error(`XLSX 中有多个字段映射到目标列：${target.name}`);
    }
    seenTargets.add(target.name);
    mappings.push({ index, source: header, target: target.name });
  }
  if (!mappings.length) throw new Error("XLSX 表头与目标表没有可匹配字段");

  const missingPrimaryKeys = columns
    .filter((column) => column.primary && !seenTargets.has(column.name))
    .map((column) => column.name);
  if (missingPrimaryKeys.length) {
    throw new Error(`整表导入必须包含主键字段：${missingPrimaryKeys.join("、")}`);
  }

  const rows = [];
  let totalTextChars = 0;
  for (const sourceRow of matrix.slice(1)) {
    const row = {};
    let hasValue = false;
    for (const mapping of mappings) {
      const value = stringValue(sourceRow[mapping.index]);
      row[mapping.target] = value;
      totalTextChars += value.length;
      if (value !== "") hasValue = true;
    }
    if (hasValue) rows.push(row);
  }
  if (!rows.length) throw new Error("XLSX 没有可导入的数据行");
  if (rows.length > MAX_ROWS) throw new Error(`MCP 单次最多导入 ${MAX_ROWS} 行`);
  if (rows.length * mappings.length > MAX_CELLS) {
    throw new Error(`导入数据不能超过 ${MAX_CELLS.toLocaleString()} 个单元格`);
  }
  if (totalTextChars > MAX_TEXT_CHARS) throw new Error("导入文本总量过大，请拆分文件");
  return {
    rows,
    mappedColumns: mappings.map((mapping) => mapping.target),
    mappings,
    ignoredColumns,
    primaryKeys: columns.filter((column) => column.primary).map((column) => column.name),
  };
}

function clearExpiredPreviews(now = Date.now()) {
  for (const [id, preview] of previews) {
    if (now - preview.createdAt > PREVIEW_TTL_MS) previews.delete(id);
  }
}

export async function previewExternalImport(control, args) {
  clearExpiredPreviews();
  const currentContext = await control.request("get_context");
  const connectionId = String(args.connectionId || currentContext?.connectionId || "").trim();
  const database = String(args.database || currentContext?.database || "").trim();
  const table = String(args.table || "").trim();
  if (!table) throw new Error("缺少目标表名");
  if (!connectionId || !database) throw new Error("请先在黑猫中选择有效的连接和数据库");
  const workbook = await readWorkbook(args.sourcePath, args.sheet);
  const schema = await control.request("db_tool", {
    func: "describe_table",
    args: { database, table, connectionId },
  });
  const mapped = mapWorkbook(workbook.matrix, schema);
  const previewId = randomUUID();
  previews.set(previewId, {
    createdAt: Date.now(),
    sourcePath: workbook.absolutePath,
    digest: workbook.digest,
    sheetName: workbook.sheetName,
    connectionId,
    database,
    table,
    ...mapped,
  });
  return {
    previewId,
    expiresInMinutes: PREVIEW_TTL_MS / 60_000,
    sourcePath: workbook.absolutePath,
    sheetName: workbook.sheetName,
    connectionId,
    database,
    tableName: table,
    rowCount: mapped.rows.length,
    mappedColumns: mapped.mappedColumns,
    ignoredColumns: mapped.ignoredColumns,
    primaryKeys: mapped.primaryKeys,
    warning: "执行后会整表覆盖。黑猫将在修改数据库前把原表数据备份为本地 XLSX；备份失败时导入不会发生。",
  };
}

export async function executeExternalImport(control, args) {
  clearExpiredPreviews();
  if (args.confirmReplace !== true) {
    throw new Error("整表导入必须显式传入 confirmReplace=true");
  }
  const preview = previews.get(String(args.previewId || ""));
  if (!preview) throw new Error("导入预览不存在或已过期，请重新预览");
  const workbook = await readWorkbook(preview.sourcePath, preview.sheetName);
  if (workbook.digest !== preview.digest) {
    throw new Error("XLSX 文件在预览后发生变化，请重新预览并确认");
  }
  const result = await control.request("import_table", {
    args: {
      connectionId: preview.connectionId,
      database: preview.database,
      table: preview.table,
      sourcePath: preview.sourcePath,
      rows: preview.rows,
      mappedColumns: preview.mappedColumns,
      confirmReplace: true,
    },
  });
  previews.delete(String(args.previewId));
  return {
    ...result,
    safety: "原表数据的 XLSX 备份已成功生成后才执行了导入",
  };
}

export const importLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxRows: MAX_ROWS,
  maxCells: MAX_CELLS,
};
