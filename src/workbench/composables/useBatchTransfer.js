import { computed, reactive } from "vue";
import { columnName, normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import { spreadsheetCellDraftValue } from "../utils/valueValidation.js";
import { clampCellValue } from "../utils/xlsxLimit.js";
import { worksheetToDisplayRows } from "../utils/xlsxWorkbook.js";

export const BATCH_EXPORT_PAGE_SIZE = 10000;
export const BATCH_IMPORT_PAGE_SIZE = 1;
export const BATCH_IMPORT_CHUNK_SIZE = 100;
export const BATCH_TRANSFER_MODE = Object.freeze({
  WORKBOOK: "workbook",
  SEPARATE: "separate",
});
const FIELD_COMMENTS_SHEET_SUFFIX = "字段备注";
const FIELD_COMMENTS_SHEET_HEADERS = Object.freeze([
  "表名",
  "字段名",
  "字段类型",
  "可为空",
  "主键",
  "默认值",
  "字段备注",
]);

const BATCH_PROGRESS_PHASE = Object.freeze({
  READ_TABLE: "读取表数据",
  BUILD_EXCEL: "生成 Excel",
  SAVE_FILE: "保存文件",
  READ_EXCEL: "读取 Excel",
  VALIDATE: "校验数据",
  WRITE_DB: "写入数据库",
});

let xlsxModule = null;
let xlsxModulePromise = null;

async function loadXlsx() {
  if (xlsxModule) return xlsxModule;
  if (!xlsxModulePromise) xlsxModulePromise = import("xlsx");
  xlsxModule = await xlsxModulePromise;
  return xlsxModule;
}

function tableOptionName(table) {
  return normalizeTableName(table) || String(table?.name || table || "").trim();
}

function normalizeTables(tables = []) {
  return (Array.isArray(tables) ? tables : [])
    .map((table) => ({
      ...((table && typeof table === "object") ? table : {}),
      table_name: tableOptionName(table),
      table_comment: normalizeTableComment(table),
    }))
    .filter((table) => table.table_name);
}

function safeFilePart(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || fallback;
}

function stripExcelExtension(value) {
  return String(value || "").replace(/\.(xlsx|xls)$/i, "");
}

function safeSheetName(value, fallback = "Sheet") {
  const cleaned = String(value || fallback)
    .replace(/[\[\]:*?/\\]/g, "_")
    .trim()
    .slice(0, 31);
  return cleaned || fallback;
}

function uniqueFileName(baseName, usedNames) {
  const cleaned = String(baseName || "table.xlsx").trim() || "table.xlsx";
  const dotIndex = cleaned.lastIndexOf(".");
  const rawStem = dotIndex > 0 ? cleaned.slice(0, dotIndex) : cleaned;
  const rawExt = dotIndex > 0 ? cleaned.slice(dotIndex) : ".xlsx";
  const stem = safeFilePart(rawStem, "table");
  const ext = rawExt.toLowerCase() === ".xls" ? ".xlsx" : rawExt;
  const first = `${stem}${ext}`;
  if (!usedNames.has(first.toLowerCase())) {
    usedNames.add(first.toLowerCase());
    return first;
  }
  for (let i = 2; i < 1000; i += 1) {
    const next = `${stem}-${i}${ext}`;
    if (!usedNames.has(next.toLowerCase())) {
      usedNames.add(next.toLowerCase());
      return next;
    }
  }
  const fallback = `table-${usedNames.size + 1}${ext}`;
  usedNames.add(fallback.toLowerCase());
  return fallback;
}

function uniqueLabel(baseName, usedNames) {
  const base = String(baseName || `Excel ${usedNames.size + 1}`).trim() || `Excel ${usedNames.size + 1}`;
  if (!usedNames.has(base.toLowerCase())) {
    usedNames.add(base.toLowerCase());
    return base;
  }
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base} (${i})`;
    if (!usedNames.has(next.toLowerCase())) {
      usedNames.add(next.toLowerCase());
      return next;
    }
  }
  const fallback = `Excel ${usedNames.size + 1}`;
  usedNames.add(fallback.toLowerCase());
  return fallback;
}

function uniqueSheetName(baseName, usedNames) {
  const base = safeSheetName(baseName);
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  for (let i = 2; i < 1000; i += 1) {
    const suffix = `_${i}`;
    const next = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    if (!usedNames.has(next)) {
      usedNames.add(next);
      return next;
    }
  }
  const fallback = `Sheet_${usedNames.size + 1}`.slice(0, 31);
  usedNames.add(fallback);
  return fallback;
}

function fieldCommentsSheetName(tableName, usedNames) {
  const suffix = "字段备注";
  const normalizedTableName = String(tableName || "表")
    .replace(/[\[\]:*?/\\]/g, "_")
    .trim() || "表";
  for (let i = 1; i < 1000; i += 1) {
    const discriminator = i === 1 ? "" : `_${i}`;
    const tableNameLimit = Math.max(1, 31 - suffix.length - discriminator.length);
    const candidate = `${normalizedTableName.slice(0, tableNameLimit)}${discriminator}${suffix}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  return uniqueSheetName(suffix, usedNames);
}

function tableColumns(tableOrPage = {}) {
  return Array.isArray(tableOrPage.columns) ? tableOrPage.columns : [];
}

function rowsToSheet(XLSX, columns, rows) {
  const header = columns.map(columnName).filter(Boolean);
  const body = (Array.isArray(rows) ? rows : []).map((row) => header.map((name) => clampCellValue(row?.[name] ?? "")));
  return XLSX.utils.aoa_to_sheet([header, ...body]);
}

function columnMetadataRows(tableName, columns) {
  return (Array.isArray(columns) ? columns : []).map((column) => {
    const nullable = column?.is_nullable ?? column?.isNullable ?? column?.nullable;
    const primaryKey = column?.is_primary_key ?? column?.isPrimaryKey ?? column?.primaryKey;
    const defaultValue = column?.column_default ?? column?.columnDefault ?? column?.default_value ?? column?.defaultValue ?? "";
    return [
      clampCellValue(tableName),
      clampCellValue(columnName(column)),
      clampCellValue(column?.column_type ?? column?.columnType ?? column?.type ?? ""),
      nullable === true || nullable === 1 || /^(yes|true|1)$/i.test(String(nullable ?? "")) ? "是" : "否",
      primaryKey === true || primaryKey === 1 || /^(yes|true|1)$/i.test(String(primaryKey ?? "")) ? "是" : "否",
      clampCellValue(defaultValue),
      clampCellValue(column?.column_comment ?? column?.columnComment ?? column?.comment ?? ""),
    ];
  });
}

function columnMetadataSheet(XLSX, tables) {
  const rows = (Array.isArray(tables) ? tables : []).flatMap((table) =>
    columnMetadataRows(table.tableName, table.columns)
  );
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["表名", "字段名", "字段类型", "可为空", "主键", "默认值", "字段备注"],
    ...rows,
  ]);
  worksheet["!cols"] = [
    { wch: 24 },
    { wch: 24 },
    { wch: 22 },
    { wch: 10 },
    { wch: 10 },
    { wch: 20 },
    { wch: 48 },
  ];
  return worksheet;
}

function workbookPayload(XLSX, workbook, fileName) {
  const wbout = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  return {
    fileName,
    data: Array.from(new Uint8Array(wbout)),
  };
}

function compactTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function batchImportErrorRows(batchImport) {
  const sheetByName = new Map(batchImport.sheets.map((sheet) => [sheet.sheetName, sheet]));
  return batchImport.progress.errors.map((error) => {
    const sheet = sheetByName.get(error.sheetName) || {};
    return [
      clampCellValue(error.sourceFileName || sheet.sourceFileName || batchImport.fileName || ""),
      clampCellValue(error.workbookSheetName || sheet.workbookSheetName || error.sheetName || ""),
      clampCellValue(error.tableName || sheet.targetTableName || ""),
      Number.isFinite(Number(error.row)) ? Number(error.row) : "",
      clampCellValue(error.columnName || ""),
      clampCellValue(error.value ?? ""),
      clampCellValue(error.error || error.message || ""),
    ];
  });
}

function defaultScheduleYield() {
  if (typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function saveWorkbook({ XLSX, invokeWorkbench, workbook, fileName, statusText, fallbackMessage, scheduleYield }) {
  if (scheduleYield) await scheduleYield();
  const payload = workbookPayload(XLSX, workbook, fileName);
  if (scheduleYield) await scheduleYield();
  try {
    const savedPath = await invokeWorkbench("save_export_file", {
      fileName: payload.fileName,
      data: payload.data,
    });
    return { saved: true, savedPath };
  } catch (error) {
    if (String(error).includes("取消了")) return { saved: false, cancelled: true };
    if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
      throw error;
    }
    const blob = new Blob([Uint8Array.from(payload.data)], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = payload.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    statusText.value = fallbackMessage;
    return { saved: true, savedPath: "" };
  }
}

async function saveWorkbookFiles({ invokeWorkbench, files, statusText, fallbackMessage, scheduleYield }) {
  if (scheduleYield) await scheduleYield();
  try {
    const savedPath = await invokeWorkbench("save_export_files", { files });
    return { saved: true, savedPath };
  } catch (error) {
    if (String(error).includes("取消了")) return { saved: false, cancelled: true };
    if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
      throw error;
    }
    for (const file of files) {
      const blob = new Blob([Uint8Array.from(file.data || [])], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }
    statusText.value = fallbackMessage;
    return { saved: true, savedPath: "" };
  }
}

function makeProgress() {
  return { done: 0, total: 0, current: "", phase: "", detail: "", errors: [] };
}

function normalizeBatchMode(mode) {
  return mode === BATCH_TRANSFER_MODE.SEPARATE ? BATCH_TRANSFER_MODE.SEPARATE : BATCH_TRANSFER_MODE.WORKBOOK;
}

function resetExportState(batchExport, source = {}) {
  const tables = normalizeTables(source.tables || []);
  batchExport.open = true;
  batchExport.connectionId = String(source.connectionId || source.connection_id || "");
  batchExport.database = String(source.database || "");
  batchExport.mode = BATCH_TRANSFER_MODE.WORKBOOK;
  batchExport.includeColumnComments = false;
  batchExport.tables = tables;
  batchExport.selectedTableNames.clear();
  tables.forEach((table) => batchExport.selectedTableNames.add(table.table_name));
  batchExport.exporting = false;
  batchExport.status = "idle";
  batchExport.errorMessage = "";
  batchExport.progress = makeProgress();
  batchExport.result = null;
}

function resetImportFileSelection(batchImport) {
  batchImport.fileName = "";
  batchImport.workbook = null;
  batchImport.sheets = [];
  batchImport.sourceFileCount = 0;
  batchImport.ignoredSheetCount = 0;
  batchImport.selectedSheetNames.clear();
  batchImport.progress = { ...makeProgress(), inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  batchImport.result = null;
  batchImport.cancelRequested = false;
}

function resetImportState(batchImport, source = {}) {
  batchImport.open = true;
  batchImport.connectionId = String(source.connectionId || source.connection_id || "");
  batchImport.database = String(source.database || "");
  batchImport.readOnly = Boolean(source.readOnly || source.read_only);
  batchImport.mode = BATCH_TRANSFER_MODE.WORKBOOK;
  batchImport.tables = normalizeTables(source.tables || []);
  resetImportFileSelection(batchImport);
  batchImport.importing = false;
  batchImport.cancelRequested = false;
  batchImport.status = "idle";
  batchImport.errorMessage = "";
}

function tableLookup(tables) {
  const lookup = new Map();
  normalizeTables(tables).forEach((table) => lookup.set(table.table_name.toLowerCase(), table));
  return lookup;
}

function isFieldCommentsSheet(sheetName, rows, lookup) {
  const normalizedName = String(sheetName || "").trim();
  if (!normalizedName.endsWith(FIELD_COMMENTS_SHEET_SUFFIX)) return false;
  if (lookup.has(normalizedName.toLowerCase())) return false;
  const headers = (rows?.[0] || []).map((value) => String(value ?? "").trim());
  return FIELD_COMMENTS_SHEET_HEADERS.every((header, index) => headers[index] === header);
}

async function buildImportSheets(XLSX, workbook, tables, { onProgress, scheduleYield } = {}) {
  const lookup = tableLookup(tables);
  const sheetNames = workbook?.SheetNames || [];
  const result = [];
  let ignoredSheetCount = 0;
  for (let index = 0; index < sheetNames.length; index += 1) {
    const sheetName = sheetNames[index];
    if (onProgress) onProgress({ current: sheetName, done: index, total: sheetNames.length });
    if (scheduleYield) await scheduleYield();
    const rows = worksheetToDisplayRows(XLSX, workbook.Sheets[sheetName]);
    if (isFieldCommentsSheet(sheetName, rows, lookup)) {
      ignoredSheetCount += 1;
      if (onProgress) onProgress({ current: sheetName, done: index + 1, total: sheetNames.length });
      continue;
    }
    const match = lookup.get(String(sheetName).toLowerCase());
    const rowCount = Math.max(0, rows.length - 1);
    result.push({
      sheetName,
      sourceFileName: "",
      workbookSheetName: sheetName,
      targetTableName: match?.table_name || "",
      rowCount,
      rawRows: rows,
      headers: (rows[0] || []).map((value) => String(value ?? "")),
      status: match && rowCount > 0 ? "ready" : "skipped",
      message: match ? "" : "未匹配到目标表",
    });
    if (onProgress) onProgress({ current: sheetName, done: index + 1, total: sheetNames.length });
  }
  return { sheets: result, ignoredSheetCount };
}

async function buildSeparateImportSheets(XLSX, files, tables, { onProgress, scheduleYield } = {}) {
  const lookup = tableLookup(tables);
  const usedNames = new Set();
  const result = [];
  let ignoredSheetCount = 0;
  let index = 0;
  for (const file of files) {
    index += 1;
    const sourceFileName = file?.name || `table-${index}.xlsx`;
    if (onProgress) onProgress({ current: sourceFileName, done: index - 1, total: files.length });
    if (scheduleYield) await scheduleYield();
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: "array" });
    let workbookSheetName = "";
    let rows = [];
    for (const candidateName of workbook?.SheetNames || []) {
      const candidateRows = worksheetToDisplayRows(XLSX, workbook.Sheets[candidateName]);
      if (isFieldCommentsSheet(candidateName, candidateRows, lookup)) {
        ignoredSheetCount += 1;
      } else if (!workbookSheetName) {
        workbookSheetName = candidateName;
        rows = candidateRows;
      }
    }
    const targetKey = stripExcelExtension(sourceFileName).trim().toLowerCase();
    const sheetKey = String(workbookSheetName || "").trim().toLowerCase();
    const match = lookup.get(targetKey) || lookup.get(sheetKey);
    const rowCount = Math.max(0, rows.length - 1);
    result.push({
      sheetName: uniqueLabel(sourceFileName, usedNames),
      sourceFileName,
      workbookSheetName,
      targetTableName: match?.table_name || "",
      rowCount,
      rawRows: rows,
      headers: (rows[0] || []).map((value) => String(value ?? "")),
      status: match && rowCount > 0 ? "ready" : "skipped",
      message: match ? "" : "未匹配到目标表",
    });
    if (onProgress) onProgress({ current: sourceFileName, done: index, total: files.length });
    if (scheduleYield) await scheduleYield();
  }
  return { sheets: result, ignoredSheetCount };
}

function mapSheetColumns(sheet, table) {
  const columns = tableColumns(table);
  const tableColumnsByLowerName = new Map(columns.map((column) => [columnName(column).toLowerCase(), columnName(column)]));
  return (sheet.headers || []).map((header, index) => {
    const tableCol = tableColumnsByLowerName.get(String(header || "").toLowerCase()) || "";
    return { fileCol: String(header || ""), index, tableCol, skip: !tableCol };
  });
}

function mappedDrafts(sheet, mapping, table) {
  const columnsByName = new Map(tableColumns(table).map((column) => [columnName(column), column]));
  return (sheet.rawRows || []).slice(1).map((row, rowIndex) => {
    const draft = {};
    let hasContent = false;
    mapping.forEach((item) => {
      if (item.skip || !item.tableCol) return;
      const value = row?.[item.index];
      const normalized = spreadsheetCellDraftValue(columnsByName.get(item.tableCol), value);
      if (normalized.present) draft[item.tableCol] = normalized.value;
      if (normalized.value.trim() !== "") hasContent = true;
    });
    return { row: rowIndex + 2, draft, hasContent };
  });
}

export function useBatchTransfer({
  invokeWorkbench,
  statusText = { value: "" },
  scheduleYield = defaultScheduleYield,
} = {}) {
  const batchExport = reactive({
    open: false,
    connectionId: "",
    database: "",
    mode: BATCH_TRANSFER_MODE.WORKBOOK,
    includeColumnComments: false,
    tables: [],
    selectedTableNames: reactive(new Set()),
    exporting: false,
    status: "idle",
    errorMessage: "",
    progress: makeProgress(),
    result: null,
  });

  const batchImport = reactive({
    open: false,
    connectionId: "",
    database: "",
    readOnly: false,
    mode: BATCH_TRANSFER_MODE.WORKBOOK,
    tables: [],
    fileName: "",
    workbook: null,
    sourceFileCount: 0,
    ignoredSheetCount: 0,
    sheets: [],
    selectedSheetNames: reactive(new Set()),
    importing: false,
    cancelRequested: false,
    status: "idle",
    errorMessage: "",
    progress: { ...makeProgress(), inserted: 0, updated: 0, unchanged: 0, skipped: 0 },
    result: null,
  });

  const selectedExportCount = computed(() => batchExport.selectedTableNames.size);
  const canExecuteBatchExport = computed(() =>
    Boolean(invokeWorkbench && batchExport.connectionId && batchExport.database && selectedExportCount.value > 0 && !batchExport.exporting),
  );
  const selectedImportCount = computed(() => batchImport.selectedSheetNames.size);
  const canExecuteBatchImport = computed(() =>
    Boolean(
      invokeWorkbench &&
      !batchImport.readOnly &&
      batchImport.connectionId &&
      batchImport.database &&
      selectedImportCount.value > 0 &&
      !batchImport.importing &&
      batchImport.status !== "reading",
    ),
  );

  function openBatchExport(source = {}) {
    resetExportState(batchExport, source);
  }

  async function yieldToUi() {
    await scheduleYield();
  }

  function setProgressPhase(progress, phase, current = progress.current, detail = "") {
    progress.phase = phase;
    progress.current = current;
    progress.detail = detail;
  }

  function setBatchExportMode(mode) {
    if (batchExport.exporting) return;
    batchExport.mode = normalizeBatchMode(mode);
    batchExport.status = "idle";
    batchExport.errorMessage = "";
    batchExport.progress = makeProgress();
    batchExport.result = null;
  }

  function setBatchExportIncludeColumnComments(checked) {
    if (batchExport.exporting) return;
    batchExport.includeColumnComments = Boolean(checked);
    batchExport.status = "idle";
    batchExport.errorMessage = "";
    batchExport.progress = makeProgress();
    batchExport.result = null;
  }

  function closeBatchExport() {
    if (batchExport.exporting) return;
    batchExport.open = false;
  }

  function toggleExportTable(tableName) {
    const name = String(tableName || "");
    if (!name) return;
    if (batchExport.selectedTableNames.has(name)) batchExport.selectedTableNames.delete(name);
    else batchExport.selectedTableNames.add(name);
  }

  function setAllExportTables(checked) {
    batchExport.selectedTableNames.clear();
    if (checked) batchExport.tables.forEach((table) => batchExport.selectedTableNames.add(table.table_name));
  }

  function selectedExportNames() {
    const selected = batchExport.selectedTableNames;
    return batchExport.tables
      .map((table) => table.table_name)
      .filter((name) => selected.has(name));
  }

  async function readExportTableRows(tableName) {
    let sessionId = "";
    try {
      const firstPage = await invokeWorkbench("open_table_session", {
        connectionId: batchExport.connectionId,
        database: batchExport.database,
        tableName,
        options: { page: 1, pageSize: BATCH_EXPORT_PAGE_SIZE },
      });
      sessionId = String(firstPage.sessionId || "");
      const rows = Array.isArray(firstPage.rows) ? [...firstPage.rows] : [];
      const totalRows = Number(firstPage.totalRows || rows.length || 0);
      const pageSize = Math.max(1, Number(firstPage.pageSize || BATCH_EXPORT_PAGE_SIZE));
      let page = Number(firstPage.page || 1);
      while (sessionId && rows.length < totalRows) {
        page += 1;
        const nextPage = await invokeWorkbench("fetch_table_page", {
          sessionId,
          request: { page, pageSize },
        });
        const nextRows = Array.isArray(nextPage.rows) ? nextPage.rows : [];
        if (!nextRows.length) break;
        rows.push(...nextRows);
      }
      return { ...firstPage, rows };
    } finally {
      if (sessionId) {
        try {
          await invokeWorkbench("close_table_session", { sessionId });
        } catch {
          // Cleanup is best-effort and must not replace the export result/error.
        }
      }
    }
  }

  async function executeBatchExport() {
    if (!canExecuteBatchExport.value) return null;
    const tableNames = selectedExportNames();
    const XLSX = await loadXlsx();
    const workbook = XLSX.utils.book_new();
    const usedSheetNames = new Set();
    batchExport.exporting = true;
    batchExport.status = "running";
    batchExport.errorMessage = "";
    batchExport.progress = { ...makeProgress(), total: tableNames.length };
    batchExport.result = null;
    await yieldToUi();
    try {
      let exportedRows = 0;
      if (batchExport.mode === BATCH_TRANSFER_MODE.SEPARATE) {
        const files = [];
        const usedFileNames = new Set();
        for (const tableName of tableNames) {
          setProgressPhase(batchExport.progress, BATCH_PROGRESS_PHASE.READ_TABLE, tableName);
          await yieldToUi();
          try {
            const page = await readExportTableRows(tableName);
            setProgressPhase(batchExport.progress, BATCH_PROGRESS_PHASE.BUILD_EXCEL, tableName);
            await yieldToUi();
            const tableWorkbook = XLSX.utils.book_new();
            const columns = tableColumns(page);
            const ws = rowsToSheet(XLSX, columns, page.rows);
            XLSX.utils.book_append_sheet(tableWorkbook, ws, safeSheetName(tableName));
            if (batchExport.includeColumnComments) {
              const metadataSheetName = fieldCommentsSheetName(tableName, new Set(tableWorkbook.SheetNames));
              XLSX.utils.book_append_sheet(
                tableWorkbook,
                columnMetadataSheet(XLSX, [{ tableName, columns }]),
                metadataSheetName,
              );
            }
            files.push(workbookPayload(
              XLSX,
              tableWorkbook,
              uniqueFileName(`${safeFilePart(tableName, "table")}.xlsx`, usedFileNames),
            ));
            exportedRows += page.rows.length;
          } catch (error) {
            batchExport.progress.errors.push({ tableName, error: String(error?.message || error) });
          } finally {
            batchExport.progress.done += 1;
            await yieldToUi();
          }
        }
        if (!files.length) throw new Error("没有可导出的表");
        setProgressPhase(batchExport.progress, BATCH_PROGRESS_PHASE.SAVE_FILE, `${files.length} 个 Excel`);
        await yieldToUi();
        const saved = await saveWorkbookFiles({
          invokeWorkbench,
          files,
          statusText,
          fallbackMessage: `批量导出完成：${files.length} 个 Excel，${exportedRows} 行`,
          scheduleYield: yieldToUi,
        });
        if (saved.cancelled) {
          batchExport.status = "idle";
          return null;
        }
        batchExport.status = batchExport.progress.errors.length ? "partial" : "succeeded";
        batchExport.result = {
          tableCount: files.length,
          fileCount: files.length,
          rowCount: exportedRows,
          savedPath: saved.savedPath || "",
          errors: [...batchExport.progress.errors],
        };
        batchExport.progress.phase = "完成";
        batchExport.progress.current = "";
        statusText.value = `批量导出完成：${batchExport.result.tableCount} 张表，${files.length} 个 Excel，${exportedRows} 行${saved.savedPath ? ` → ${saved.savedPath}` : ""}`;
        return batchExport.result;
      }
      let exportedTableCount = 0;
      for (const tableName of tableNames) {
        setProgressPhase(batchExport.progress, BATCH_PROGRESS_PHASE.READ_TABLE, tableName);
        await yieldToUi();
        try {
          const page = await readExportTableRows(tableName);
          setProgressPhase(batchExport.progress, BATCH_PROGRESS_PHASE.BUILD_EXCEL, tableName);
          await yieldToUi();
          const columns = tableColumns(page);
          const ws = rowsToSheet(XLSX, columns, page.rows);
          XLSX.utils.book_append_sheet(workbook, ws, uniqueSheetName(tableName, usedSheetNames));
          if (batchExport.includeColumnComments) {
            XLSX.utils.book_append_sheet(
              workbook,
              columnMetadataSheet(XLSX, [{ tableName, columns }]),
              fieldCommentsSheetName(tableName, usedSheetNames),
            );
          }
          exportedTableCount += 1;
          exportedRows += page.rows.length;
        } catch (error) {
          batchExport.progress.errors.push({ tableName, error: String(error?.message || error) });
        } finally {
          batchExport.progress.done += 1;
          await yieldToUi();
        }
      }
      if (!workbook.SheetNames.length) throw new Error("没有可导出的表");
      const fileName = `${safeFilePart(batchExport.database, "database")}-tables.xlsx`;
      setProgressPhase(batchExport.progress, BATCH_PROGRESS_PHASE.SAVE_FILE, fileName);
      await yieldToUi();
      const saved = await saveWorkbook({
        XLSX,
        invokeWorkbench,
        workbook,
        fileName,
        statusText,
        fallbackMessage: `批量导出完成：${exportedTableCount} 张表，${exportedRows} 行`,
        scheduleYield: yieldToUi,
      });
      if (saved.cancelled) {
        batchExport.status = "idle";
        return null;
      }
      batchExport.status = batchExport.progress.errors.length ? "partial" : "succeeded";
      batchExport.result = {
        tableCount: exportedTableCount,
        fileCount: 1,
        rowCount: exportedRows,
        savedPath: saved.savedPath || "",
        errors: [...batchExport.progress.errors],
      };
      batchExport.progress.phase = "完成";
      batchExport.progress.current = "";
      statusText.value = `批量导出完成：${batchExport.result.tableCount} 张表，${exportedRows} 行${saved.savedPath ? ` → ${saved.savedPath}` : ""}`;
      return batchExport.result;
    } catch (error) {
      batchExport.status = "failed";
      batchExport.errorMessage = String(error?.message || error || "批量导出失败");
      statusText.value = `批量导出失败：${batchExport.errorMessage}`;
      return null;
    } finally {
      batchExport.exporting = false;
      batchExport.progress.current = "";
    }
  }

  function openBatchImport(source = {}) {
    resetImportState(batchImport, source);
    if (batchImport.readOnly) {
      batchImport.status = "failed";
      batchImport.errorMessage = "只读连接不能导入数据";
      statusText.value = batchImport.errorMessage;
    }
  }

  function setBatchImportMode(mode) {
    if (batchImport.importing || batchImport.status === "reading") return;
    const nextMode = normalizeBatchMode(mode);
    if (batchImport.mode === nextMode) return;
    batchImport.mode = nextMode;
    resetImportFileSelection(batchImport);
    batchImport.status = "idle";
    batchImport.errorMessage = "";
  }

  function closeBatchImport() {
    if (batchImport.importing || batchImport.status === "reading") return;
    batchImport.open = false;
  }

  async function loadBatchImportFile(file) {
    await loadBatchImportFiles(file ? [file] : []);
  }

  async function loadBatchImportFiles(files) {
    try {
      const fileList = Array.from(files || []).filter(Boolean);
      if (!fileList.length) return;
      const XLSX = await loadXlsx();
      batchImport.status = "reading";
      batchImport.errorMessage = "";
      batchImport.ignoredSheetCount = 0;
      batchImport.progress = {
        ...makeProgress(),
        phase: BATCH_PROGRESS_PHASE.READ_EXCEL,
        total: fileList.length,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
      };
      await yieldToUi();
      const updateReadProgress = ({ current, done, total }) => {
        batchImport.progress.phase = BATCH_PROGRESS_PHASE.READ_EXCEL;
        batchImport.progress.current = current || "";
        batchImport.progress.done = done;
        batchImport.progress.total = total;
      };
      if (batchImport.mode === BATCH_TRANSFER_MODE.SEPARATE) {
        batchImport.fileName = fileList.length === 1 ? (fileList[0].name || "table.xlsx") : `${fileList.length} 个 Excel 文件`;
        batchImport.workbook = null;
        batchImport.sourceFileCount = fileList.length;
        const importResult = await buildSeparateImportSheets(XLSX, fileList, batchImport.tables, {
          onProgress: updateReadProgress,
          scheduleYield: yieldToUi,
        });
        batchImport.sheets = importResult.sheets;
        batchImport.ignoredSheetCount = importResult.ignoredSheetCount;
      } else {
        const file = fileList[0];
        updateReadProgress({ current: file.name || "batch.xlsx", done: 0, total: 1 });
        await yieldToUi();
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: "array" });
        batchImport.fileName = file.name || "batch.xlsx";
        batchImport.workbook = workbook;
        batchImport.sourceFileCount = 1;
        const importResult = await buildImportSheets(XLSX, workbook, batchImport.tables, {
          onProgress: updateReadProgress,
          scheduleYield: yieldToUi,
        });
        batchImport.sheets = importResult.sheets;
        batchImport.ignoredSheetCount = importResult.ignoredSheetCount;
      }
      batchImport.selectedSheetNames.clear();
      batchImport.sheets.forEach((sheet) => {
        if (sheet.targetTableName && sheet.rowCount > 0) batchImport.selectedSheetNames.add(sheet.sheetName);
      });
      batchImport.progress = { ...makeProgress(), inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      batchImport.status = "idle";
      batchImport.errorMessage = "";
    } catch (error) {
      batchImport.status = "failed";
      batchImport.errorMessage = String(error?.message || error || "读取 Excel 失败");
      batchImport.progress.current = "";
      statusText.value = `读取 Excel 失败：${batchImport.errorMessage}`;
    }
  }

  function toggleImportSheet(sheetName) {
    const name = String(sheetName || "");
    if (!name) return;
    if (batchImport.selectedSheetNames.has(name)) batchImport.selectedSheetNames.delete(name);
    else batchImport.selectedSheetNames.add(name);
  }

  function setAllImportSheets(checked) {
    batchImport.selectedSheetNames.clear();
    if (checked) {
      batchImport.sheets.forEach((sheet) => {
        if (sheet.targetTableName && sheet.rowCount > 0) batchImport.selectedSheetNames.add(sheet.sheetName);
      });
    }
  }

  function setImportSheetTarget(sheetName, tableName) {
    const sheet = batchImport.sheets.find((item) => item.sheetName === sheetName);
    if (!sheet) return;
    sheet.targetTableName = String(tableName || "");
    sheet.status = sheet.targetTableName && sheet.rowCount > 0 ? "ready" : "skipped";
    sheet.message = sheet.targetTableName ? "" : "未匹配到目标表";
    if (sheet.targetTableName && sheet.rowCount > 0) batchImport.selectedSheetNames.add(sheet.sheetName);
    else batchImport.selectedSheetNames.delete(sheet.sheetName);
  }

  async function executeSheetImport(sheet) {
    setProgressPhase(batchImport.progress, BATCH_PROGRESS_PHASE.VALIDATE, sheet.sheetName);
    await yieldToUi();
    const schema = await invokeWorkbench("get_table_schema", {
      connectionId: batchImport.connectionId,
      database: batchImport.database,
      tableName: sheet.targetTableName,
    });
    const hasPrimaryKey = (schema?.columns || []).some((column) =>
      column?.is_primary_key || column?.isPrimaryKey
    );
    if (!hasPrimaryKey) {
      batchImport.progress.done += sheet.rowCount;
      await yieldToUi();
      return {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        errors: [{
          sheetName: sheet.sheetName,
          tableName: sheet.targetTableName,
          error: "目标表没有主键，无法安全批量导入和回滚",
        }],
        cancelled: false,
      };
    }
    let sessionId = "";
    try {
      const page = await invokeWorkbench("open_table_session", {
        connectionId: batchImport.connectionId,
        database: batchImport.database,
        tableName: sheet.targetTableName,
        options: { page: 1, pageSize: BATCH_IMPORT_PAGE_SIZE },
      });
      sessionId = String(page.sessionId || "");
      const mapping = mapSheetColumns(sheet, schema);
      const drafts = mappedDrafts(sheet, mapping, schema);
      const validDrafts = drafts.filter((item) => item.hasContent);
      if (!mapping.some((item) => !item.skip && item.tableCol)) {
        batchImport.progress.done += sheet.rowCount;
        await yieldToUi();
        return {
          inserted: 0,
          updated: 0,
          unchanged: 0,
          skipped: sheet.rowCount,
          errors: [{ sheetName: sheet.sheetName, error: "没有可导入的列映射" }],
        };
      }
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let processedValidRows = 0;
      const errors = [];
      setProgressPhase(batchImport.progress, BATCH_PROGRESS_PHASE.WRITE_DB, sheet.sheetName);
      await yieldToUi();
      for (let offset = 0; offset < validDrafts.length; offset += BATCH_IMPORT_CHUNK_SIZE) {
        if (batchImport.cancelRequested) break;
        const chunk = validDrafts.slice(offset, offset + BATCH_IMPORT_CHUNK_SIZE);
        try {
          const chunkResult = await invokeWorkbench("import_rows", {
            request: {
              sessionId,
              rows: chunk.map((item) => item.draft),
            },
          });
          inserted += Number(chunkResult?.inserted || 0);
          updated += Number(chunkResult?.updated || 0);
          unchanged += Number(chunkResult?.unchanged || 0);
          for (const error of Array.isArray(chunkResult?.errors) ? chunkResult.errors : []) {
            const item = chunk[Number(error?.index)] || chunk[0];
            errors.push({
              sheetName: sheet.sheetName,
              tableName: sheet.targetTableName,
              row: item?.row,
              columnName: error?.columnName || "",
              value: item?.draft?.[error?.columnName] ?? "",
              error: String(error?.error || error?.message || "导入失败"),
            });
          }
        } catch (error) {
          const message = String(error?.message || error);
          errors.push(...chunk.map((item) => ({
            sheetName: sheet.sheetName,
            tableName: sheet.targetTableName,
            row: item.row,
            error: message,
          })));
        } finally {
          batchImport.progress.done += chunk.length;
          processedValidRows += chunk.length;
          await yieldToUi();
        }
      }
      const skipped = sheet.rowCount - validDrafts.length;
      batchImport.progress.done += Math.max(0, skipped);
      await yieldToUi();
      return {
        inserted,
        updated,
        unchanged,
        skipped,
        errors,
        cancelled: batchImport.cancelRequested && processedValidRows < validDrafts.length,
      };
    } finally {
      if (sessionId) {
        try {
          await invokeWorkbench("close_table_session", { sessionId });
        } catch {
          // Cleanup is best-effort and must not replace the import result/error.
        }
      }
    }
  }

  function cancelBatchImport() {
    if (!batchImport.importing || batchImport.cancelRequested) return;
    batchImport.cancelRequested = true;
    batchImport.progress.phase = "正在取消";
  }

  async function executeBatchImport() {
    if (!canExecuteBatchImport.value) return null;
    const selectedSheets = batchImport.sheets.filter((sheet) => batchImport.selectedSheetNames.has(sheet.sheetName));
    batchImport.importing = true;
    batchImport.cancelRequested = false;
    batchImport.status = "running";
    batchImport.errorMessage = "";
    batchImport.progress = {
      ...makeProgress(),
      total: selectedSheets.reduce((sum, sheet) => sum + sheet.rowCount, 0),
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    };
    batchImport.result = null;
    await yieldToUi();
    try {
      const importedTables = new Set();
      let cancellationStoppedWork = false;
      for (const sheet of selectedSheets) {
        if (batchImport.cancelRequested) {
          cancellationStoppedWork = true;
          break;
        }
        setProgressPhase(batchImport.progress, BATCH_PROGRESS_PHASE.VALIDATE, sheet.sheetName);
        await yieldToUi();
        try {
          const result = await executeSheetImport(sheet);
          batchImport.progress.inserted += result.inserted;
          batchImport.progress.updated += result.updated;
          batchImport.progress.unchanged += result.unchanged;
          batchImport.progress.skipped += result.skipped;
          if (result.inserted + result.updated > 0) importedTables.add(sheet.targetTableName);
          batchImport.progress.errors.push(...result.errors);
          const handled = result.inserted + result.updated + result.unchanged;
          if (result.cancelled) {
            sheet.status = "cancelled";
            sheet.message = `已取消，已处理 ${handled + result.errors.length} 行`;
          } else {
            sheet.status = result.errors.length ? (handled ? "partial" : "failed") : "succeeded";
            sheet.message = result.errors.length
              ? `${result.errors.length} 个错误`
              : `新增 ${result.inserted}，更新 ${result.updated}，未变化 ${result.unchanged}`;
          }
          if (result.cancelled) {
            cancellationStoppedWork = true;
            break;
          }
        } catch (error) {
          sheet.status = "failed";
          sheet.message = String(error?.message || error);
          batchImport.progress.errors.push({ sheetName: sheet.sheetName, tableName: sheet.targetTableName, error: sheet.message });
          batchImport.progress.done += sheet.rowCount;
          await yieldToUi();
        }
      }
      const cancelled = cancellationStoppedWork;
      batchImport.cancelRequested = cancelled;
      batchImport.status = cancelled
        ? "cancelled"
        : (batchImport.progress.errors.length ? "partial" : "succeeded");
      batchImport.result = {
        inserted: batchImport.progress.inserted,
        updated: batchImport.progress.updated,
        unchanged: batchImport.progress.unchanged,
        skipped: batchImport.progress.skipped,
        errors: [...batchImport.progress.errors],
        tableNames: [...importedTables],
        cancelled,
      };
      batchImport.progress.phase = cancelled ? "已取消" : "完成";
      batchImport.progress.current = "";
      statusText.value = `${cancelled ? "批量导入已取消" : "批量导入完成"}：新增 ${batchImport.result.inserted}，更新 ${batchImport.result.updated}，未变化 ${batchImport.result.unchanged}，${batchImport.result.errors.length} 个错误`;
      return batchImport.result;
    } catch (error) {
      batchImport.status = "failed";
      batchImport.errorMessage = String(error?.message || error || "批量导入失败");
      statusText.value = `批量导入失败：${batchImport.errorMessage}`;
      return null;
    } finally {
      batchImport.importing = false;
      batchImport.progress.current = "";
    }
  }

  async function exportBatchImportErrors() {
    if (!batchImport.progress.errors.length || batchImport.importing) return null;
    try {
      const XLSX = await loadXlsx();
      const workbook = XLSX.utils.book_new();
      const rows = [
        ["来源文件", "工作表", "目标表", "Excel 行号", "字段", "原值", "错误原因"],
        ...batchImportErrorRows(batchImport),
      ];
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet(rows),
        "批量导入错误日志",
      );
      const fileName = `${safeFilePart(batchImport.database, "database")}-import-errors-${compactTimestamp()}.xlsx`;
      const payload = workbookPayload(XLSX, workbook, fileName);
      const savedPath = await invokeWorkbench("save_export_file", payload);
      statusText.value = savedPath ? `错误日志已导出：${savedPath}` : "错误日志已导出";
      return savedPath;
    } catch (error) {
      if (String(error).includes("取消了")) return null;
      statusText.value = `导出错误日志失败：${String(error?.message || error)}`;
      return null;
    }
  }

  return {
    batchExport,
    batchImport,
    selectedExportCount,
    selectedImportCount,
    canExecuteBatchExport,
    canExecuteBatchImport,
    openBatchExport,
    setBatchExportMode,
    setBatchExportIncludeColumnComments,
    closeBatchExport,
    toggleExportTable,
    setAllExportTables,
    executeBatchExport,
    openBatchImport,
    setBatchImportMode,
    closeBatchImport,
    loadBatchImportFile,
    loadBatchImportFiles,
    toggleImportSheet,
    setAllImportSheets,
    setImportSheetTarget,
    executeBatchImport,
    cancelBatchImport,
    exportBatchImportErrors,
  };
}
