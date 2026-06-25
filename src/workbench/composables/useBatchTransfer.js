import { computed, reactive } from "vue";
import { columnName, normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import { validateRowDraft } from "../utils/valueValidation.js";

export const BATCH_EXPORT_PAGE_SIZE = 10000;
export const BATCH_IMPORT_PAGE_SIZE = 10000;
export const BATCH_TRANSFER_MODE = Object.freeze({
  WORKBOOK: "workbook",
  SEPARATE: "separate",
});

const IMPORT_INSERT_YIELD_EVERY = 25;

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

function tableColumns(tableOrPage = {}) {
  return Array.isArray(tableOrPage.columns) ? tableOrPage.columns : [];
}

function primaryKeysFor(tableOrPage = {}) {
  if (Array.isArray(tableOrPage.primaryKeys)) return tableOrPage.primaryKeys;
  return tableColumns(tableOrPage)
    .filter((column) => column?.is_primary_key || column?.isPrimaryKey)
    .map(columnName)
    .filter(Boolean);
}

function tableForValidation(tableOrPage = {}, tableName = "") {
  return {
    table_name: tableOrPage.table_name || tableOrPage.tableName || tableName,
    columns: tableColumns(tableOrPage),
    primaryKeys: primaryKeysFor(tableOrPage),
  };
}

function rowsToSheet(XLSX, columns, rows) {
  const header = columns.map(columnName).filter(Boolean);
  const body = (Array.isArray(rows) ? rows : []).map((row) => header.map((name) => row?.[name] ?? ""));
  return XLSX.utils.aoa_to_sheet([header, ...body]);
}

function workbookPayload(XLSX, workbook, fileName) {
  const wbout = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  return {
    fileName,
    data: Array.from(new Uint8Array(wbout)),
  };
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
  batchImport.selectedSheetNames.clear();
  batchImport.progress = { ...makeProgress(), inserted: 0, skipped: 0 };
  batchImport.result = null;
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
  batchImport.status = "idle";
  batchImport.errorMessage = "";
}

function tableLookup(tables) {
  const lookup = new Map();
  normalizeTables(tables).forEach((table) => lookup.set(table.table_name.toLowerCase(), table));
  return lookup;
}

async function buildImportSheets(XLSX, workbook, tables, { onProgress, scheduleYield } = {}) {
  const lookup = tableLookup(tables);
  const sheetNames = workbook?.SheetNames || [];
  const result = [];
  for (let index = 0; index < sheetNames.length; index += 1) {
    const sheetName = sheetNames[index];
    if (onProgress) onProgress({ current: sheetName, done: index, total: sheetNames.length });
    if (scheduleYield) await scheduleYield();
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" });
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
  return result;
}

async function buildSeparateImportSheets(XLSX, files, tables, { onProgress, scheduleYield } = {}) {
  const lookup = tableLookup(tables);
  const usedNames = new Set();
  const result = [];
  let index = 0;
  for (const file of files) {
    index += 1;
    const sourceFileName = file?.name || `table-${index}.xlsx`;
    if (onProgress) onProgress({ current: sourceFileName, done: index - 1, total: files.length });
    if (scheduleYield) await scheduleYield();
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: "array" });
    const workbookSheetName = workbook?.SheetNames?.[0] || "";
    const rows = workbookSheetName
      ? XLSX.utils.sheet_to_json(workbook.Sheets[workbookSheetName], { header: 1, defval: "" })
      : [];
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
  return result;
}

function mapSheetColumns(sheet, table) {
  const columns = tableColumns(table);
  const tableColumnsByLowerName = new Map(columns.map((column) => [columnName(column).toLowerCase(), columnName(column)]));
  return (sheet.headers || []).map((header, index) => {
    const tableCol = tableColumnsByLowerName.get(String(header || "").toLowerCase()) || "";
    return { fileCol: String(header || ""), index, tableCol, skip: !tableCol };
  });
}

function mappedDrafts(sheet, mapping) {
  return (sheet.rawRows || []).slice(1).map((row, rowIndex) => {
    const draft = {};
    let hasContent = false;
    mapping.forEach((item) => {
      if (item.skip || !item.tableCol) return;
      const value = row?.[item.index];
      const textValue = value == null ? "" : String(value);
      draft[item.tableCol] = textValue;
      if (textValue.trim() !== "") hasContent = true;
    });
    return { row: rowIndex + 2, draft, hasContent };
  });
}

function validateDrafts(table, existingRows, drafts) {
  const errors = [];
  const acceptedDrafts = [];
  for (const item of drafts) {
    if (!item.hasContent) continue;
    const result = validateRowDraft({
      table,
      rows: existingRows,
      draft: item.draft,
      draftRows: acceptedDrafts,
    });
    if (result.valid) {
      acceptedDrafts.push(item.draft);
    } else {
      errors.push(...result.errors.map((error) => ({
        row: item.row,
        columnName: error.columnName,
        code: error.code,
        value: item.draft[error.columnName] ?? "",
        error: error.message,
        message: error.message,
        shortMessage: error.shortMessage,
      })));
    }
  }
  return errors;
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
    sheets: [],
    selectedSheetNames: reactive(new Set()),
    importing: false,
    status: "idle",
    errorMessage: "",
    progress: { ...makeProgress(), inserted: 0, skipped: 0 },
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
    const firstPage = await invokeWorkbench("open_table_session", {
      connectionId: batchExport.connectionId,
      database: batchExport.database,
      tableName,
      options: { page: 1, pageSize: BATCH_EXPORT_PAGE_SIZE },
    });
    const rows = Array.isArray(firstPage.rows) ? [...firstPage.rows] : [];
    const totalRows = Number(firstPage.totalRows || rows.length || 0);
    const pageSize = Math.max(1, Number(firstPage.pageSize || BATCH_EXPORT_PAGE_SIZE));
    let page = Number(firstPage.page || 1);
    while (firstPage.sessionId && rows.length < totalRows) {
      page += 1;
      const nextPage = await invokeWorkbench("fetch_table_page", {
        sessionId: firstPage.sessionId,
        request: { page, pageSize },
      });
      const nextRows = Array.isArray(nextPage.rows) ? nextPage.rows : [];
      if (!nextRows.length) break;
      rows.push(...nextRows);
    }
    return { ...firstPage, rows };
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
            const ws = rowsToSheet(XLSX, tableColumns(page), page.rows);
            XLSX.utils.book_append_sheet(tableWorkbook, ws, safeSheetName(tableName));
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
      for (const tableName of tableNames) {
        setProgressPhase(batchExport.progress, BATCH_PROGRESS_PHASE.READ_TABLE, tableName);
        await yieldToUi();
        try {
          const page = await readExportTableRows(tableName);
          setProgressPhase(batchExport.progress, BATCH_PROGRESS_PHASE.BUILD_EXCEL, tableName);
          await yieldToUi();
          const ws = rowsToSheet(XLSX, tableColumns(page), page.rows);
          XLSX.utils.book_append_sheet(workbook, ws, uniqueSheetName(tableName, usedSheetNames));
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
        fallbackMessage: `批量导出完成：${workbook.SheetNames.length} 张表，${exportedRows} 行`,
        scheduleYield: yieldToUi,
      });
      if (saved.cancelled) {
        batchExport.status = "idle";
        return null;
      }
      batchExport.status = batchExport.progress.errors.length ? "partial" : "succeeded";
      batchExport.result = {
        tableCount: workbook.SheetNames.length,
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
      batchImport.progress = { ...makeProgress(), phase: BATCH_PROGRESS_PHASE.READ_EXCEL, total: fileList.length, inserted: 0, skipped: 0 };
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
        batchImport.sheets = await buildSeparateImportSheets(XLSX, fileList, batchImport.tables, {
          onProgress: updateReadProgress,
          scheduleYield: yieldToUi,
        });
      } else {
        const file = fileList[0];
        updateReadProgress({ current: file.name || "batch.xlsx", done: 0, total: 1 });
        await yieldToUi();
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: "array" });
        batchImport.fileName = file.name || "batch.xlsx";
        batchImport.workbook = workbook;
        batchImport.sourceFileCount = 1;
        batchImport.sheets = await buildImportSheets(XLSX, workbook, batchImport.tables, {
          onProgress: updateReadProgress,
          scheduleYield: yieldToUi,
        });
      }
      batchImport.selectedSheetNames.clear();
      batchImport.sheets.forEach((sheet) => {
        if (sheet.targetTableName && sheet.rowCount > 0) batchImport.selectedSheetNames.add(sheet.sheetName);
      });
      batchImport.progress = { ...makeProgress(), inserted: 0, skipped: 0 };
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
    const page = await invokeWorkbench("open_table_session", {
      connectionId: batchImport.connectionId,
      database: batchImport.database,
      tableName: sheet.targetTableName,
      options: { page: 1, pageSize: BATCH_IMPORT_PAGE_SIZE },
    });
    const table = tableForValidation(schema, sheet.targetTableName);
    const mapping = mapSheetColumns(sheet, schema);
    const drafts = mappedDrafts(sheet, mapping);
    const validDrafts = drafts.filter((item) => item.hasContent);
    if (!mapping.some((item) => !item.skip && item.tableCol)) {
      batchImport.progress.done += sheet.rowCount;
      await yieldToUi();
      return { inserted: 0, skipped: sheet.rowCount, errors: [{ sheetName: sheet.sheetName, error: "没有可导入的列映射" }] };
    }
    const validationErrors = validateDrafts(table, [], validDrafts);
    if (validationErrors.length) {
      batchImport.progress.done += sheet.rowCount;
      await yieldToUi();
      return {
        inserted: 0,
        skipped: sheet.rowCount,
        errors: validationErrors.map((error) => ({ ...error, sheetName: sheet.sheetName, tableName: sheet.targetTableName })),
      };
    }
    let inserted = 0;
    const errors = [];
    setProgressPhase(batchImport.progress, BATCH_PROGRESS_PHASE.WRITE_DB, sheet.sheetName);
    await yieldToUi();
    for (let index = 0; index < validDrafts.length; index += 1) {
      const item = validDrafts[index];
      try {
        await invokeWorkbench("insert_row", {
          request: {
            sessionId: page.sessionId,
            draft: item.draft,
          },
        });
        inserted += 1;
      } catch (error) {
        errors.push({
          sheetName: sheet.sheetName,
          tableName: sheet.targetTableName,
          row: item.row,
          error: String(error?.message || error),
        });
      } finally {
        batchImport.progress.done += 1;
        if (index === 0 || (index + 1) % IMPORT_INSERT_YIELD_EVERY === 0) {
          await yieldToUi();
        }
      }
    }
    const skipped = sheet.rowCount - validDrafts.length;
    batchImport.progress.done += Math.max(0, skipped);
    await yieldToUi();
    return { inserted, skipped, errors };
  }

  async function executeBatchImport() {
    if (!canExecuteBatchImport.value) return null;
    const selectedSheets = batchImport.sheets.filter((sheet) => batchImport.selectedSheetNames.has(sheet.sheetName));
    batchImport.importing = true;
    batchImport.status = "running";
    batchImport.errorMessage = "";
    batchImport.progress = {
      ...makeProgress(),
      total: selectedSheets.reduce((sum, sheet) => sum + sheet.rowCount, 0),
      inserted: 0,
      skipped: 0,
    };
    batchImport.result = null;
    await yieldToUi();
    try {
      const importedTables = new Set();
      for (const sheet of selectedSheets) {
        setProgressPhase(batchImport.progress, BATCH_PROGRESS_PHASE.VALIDATE, sheet.sheetName);
        await yieldToUi();
        try {
          const result = await executeSheetImport(sheet);
          batchImport.progress.inserted += result.inserted;
          batchImport.progress.skipped += result.skipped;
          if (result.inserted > 0) importedTables.add(sheet.targetTableName);
          batchImport.progress.errors.push(...result.errors);
          sheet.status = result.errors.length ? (result.inserted ? "partial" : "failed") : "succeeded";
          sheet.message = result.errors.length ? `${result.errors.length} 个错误` : `导入 ${result.inserted} 行`;
        } catch (error) {
          sheet.status = "failed";
          sheet.message = String(error?.message || error);
          batchImport.progress.errors.push({ sheetName: sheet.sheetName, tableName: sheet.targetTableName, error: sheet.message });
          batchImport.progress.done += sheet.rowCount;
          await yieldToUi();
        }
      }
      batchImport.status = batchImport.progress.errors.length ? "partial" : "succeeded";
      batchImport.result = {
        inserted: batchImport.progress.inserted,
        skipped: batchImport.progress.skipped,
        errors: [...batchImport.progress.errors],
        tableNames: [...importedTables],
      };
      batchImport.progress.phase = "完成";
      batchImport.progress.current = "";
      statusText.value = `批量导入完成：${batchImport.result.inserted} 行成功，${batchImport.result.errors.length} 个错误`;
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

  return {
    batchExport,
    batchImport,
    selectedExportCount,
    selectedImportCount,
    canExecuteBatchExport,
    canExecuteBatchImport,
    openBatchExport,
    setBatchExportMode,
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
  };
}
