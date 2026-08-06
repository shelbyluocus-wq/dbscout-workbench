import { reactive, ref, toRaw } from "vue";
import { columnName } from "../utils/normalize.js";
import { createRowDraftValidationContext, spreadsheetCellDraftValue } from "../utils/valueValidation.js";
import { worksheetToDisplayRows } from "../utils/xlsxWorkbook.js";
import { isSessionInvalidError } from "./useTableSession.js";
import {
  appendBatchImportComparisonRows,
  comparisonErrorRows,
  comparisonRowsForReplacement,
  createBatchImportComparison,
} from "./batchImportComparison.js";

let xlsxModule = null;
let xlsxModulePromise = null;

async function loadXlsx() {
  if (xlsxModule) return xlsxModule;
  if (!xlsxModulePromise) xlsxModulePromise = import("xlsx");
  xlsxModule = await xlsxModulePromise;
  return xlsxModule;
}

function isReadOnlyTab(tab) {
  return Boolean(tab?.readOnly || tab?.read_only);
}

function importProgress(overrides = {}) {
  return {
    done: 0,
    total: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
    ...overrides,
  };
}

function replacementImportError(error) {
  const message = String(error);
  const rowMatch = message.match(/Excel\s+第\s*(\d+)\s*行[：:]\s*(.*)$/);
  if (!rowMatch) return { error: message };
  return {
    row: Number(rowMatch[1]),
    error: rowMatch[2] || message,
  };
}

export function useImportWizard(invokeWorkbench, activeTab, { fetchPage, reopenTableSession = null }, { statusText }) {
  const importInput = ref(null);
  const importWizard = reactive({
    open: false,
    step: 1,
    fileName: "",
    sheetNames: [],
    selectedSheet: 0,
    rawRows: [],
    workbook: null,
    preview: [],
    mapping: [],
    importing: false,
    cancelled: false,
    progress: importProgress(),
    warnings: [],
      comparison: createBatchImportComparison(),
    step4View: "summary",
  });

  function triggerImport() {
    if (!activeTab.value?.sessionId) return;
    if (isReadOnlyTab(activeTab.value)) {
      statusText.value = "只读连接不能导入数据";
      return;
    }
    importWizard.open = true;
    importWizard.step = 1;
    importWizard.fileName = "";
    importWizard.sheetNames = [];
    importWizard.selectedSheet = 0;
    importWizard.rawRows = [];
    importWizard.workbook = null;
    importWizard.preview = [];
    importWizard.mapping = [];
    importWizard.importing = false;
    importWizard.cancelled = false;
    importWizard.progress = importProgress();
    importWizard.warnings = [];
    importWizard.comparison = createBatchImportComparison();
    importWizard.step4View = "summary";
  }

  async function selectImportFile(file) {
    if (!file) return;
    try {
      const XLSX = await loadXlsx();
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      importWizard.fileName = file.name;
      importWizard.sheetNames = wb.SheetNames;
      importWizard.selectedSheet = 0;
      importWizard.workbook = wb;
      parseImportSheet();
    } catch (error) {
      statusText.value = `读取文件失败：${String(error)}`;
    }
  }

  async function onImportFileSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    await selectImportFile(file);
  }

  function parseImportSheet() {
    const wb = importWizard.workbook;
    if (!wb || !xlsxModule) return;
    const sheetName = wb.SheetNames[importWizard.selectedSheet];
    const ws = wb.Sheets[sheetName];
    importWizard.rawRows = worksheetToDisplayRows(xlsxModule, ws);
    importWizard.mapping = [];
    importWizard.warnings = [];
    importWizard.comparison.stale = true;
    importWizard.step = 2;
  }

  function goToImportStep(n) {
    if (n === 3) {
      buildColumnMapping();
      checkImportWarnings();
    }
    importWizard.step = n;
  }

  function checkImportWarnings() {
    const tab = activeTab.value;
    if (!tab) return;
    const warnings = [];
    if (importWizard.rawRows.length <= 1) {
      importWizard.warnings = ["没有可导入的数据行"];
      return;
    }
    const tableColNames = tab.columns.map((c) => columnName(c).toLowerCase());
    const fileColNames = importWizard.mapping.map((m) => m.fileCol.toLowerCase());
    const matchedCount = importWizard.mapping.filter((m) => !m.skip && m.tableCol).length;

    if (matchedCount === 0) {
      warnings.push("没有任何列能匹配到目标表字段，请检查文件是否正确。");
    } else {
      const matchRate = matchedCount / importWizard.mapping.length;
      if (matchRate < 0.3) {
        warnings.push(`仅 ${matchedCount}/${importWizard.mapping.length} 列匹配目标表，文件可能不属于此表。`);
      }
    }

    const missingCols = tableColNames.filter((tc) => !fileColNames.includes(tc));
    const requiredMissing = missingCols.filter((tc) => {
      const col = tab.columns.find((c) => columnName(c).toLowerCase() === tc);
      return col && !col.is_nullable && !col.is_primary_key;
    });
    if (requiredMissing.length > 0) {
      warnings.push(`缺少必填字段：${requiredMissing.join("、")}，导入时这些列将留空。`);
    }

    const extraCols = fileColNames.filter((fc) => !tableColNames.includes(fc));
    if (extraCols.length > 0 && extraCols.length === fileColNames.length) {
      warnings.push("文件中所有列名都无法匹配目标表，请确认文件。");
    }

    importWizard.warnings = warnings;
  }

  function buildColumnMapping() {
    const tab = activeTab.value;
    if (!tab) return;
    // Mapping is rebuilt from scratch here; any earlier comparison no
    // longer reflects the file→table assignment.
    importWizard.comparison.stale = true;
    const startIdx = 1;
    const rows = importWizard.rawRows;
    if (rows.length <= startIdx) {
      importWizard.mapping = [];
      return;
    }

    const fileCols = rows[0].map((v) => String(v ?? ""));

    const tableCols = tab.columns.map((c) => ({
      name: columnName(c),
      type: c.column_type || "",
      nullable: c.is_nullable,
    }));

    importWizard.mapping = fileCols.map((fc, fileColIndex) => {
      const match = tableCols.find((tc) => tc.name.toLowerCase() === fc.toLowerCase());
      return { fileCol: fc, fileColIndex, tableCol: match ? match.name : "", tableCols, skip: !match };
    });
  }

  function tableForImportValidation(tab) {
    return {
      table_name: tab?.tableName || "",
      columns: toRaw(tab?.columns || []),
      primaryKeys: Array.isArray(tab?.primaryKeys) ? toRaw(tab.primaryKeys) : [],
    };
  }

  function mappedImportDrafts(rows, mapping, startIdx, columns) {
    const columnsByName = new Map(columns.map((column) => [columnName(column), column]));
    return rows.map((row, rowIndex) => {
      const draft = {};
      let hasContent = false;
      mapping.forEach((m) => {
        const fileColIdx = Number.isInteger(m.fileColIndex) ? m.fileColIndex : mapping.indexOf(m);
        const value = row?.[fileColIdx];
        const normalized = spreadsheetCellDraftValue(columnsByName.get(m.tableCol), value);
        if (normalized.present) draft[m.tableCol] = normalized.value;
        if (normalized.value.trim() !== "") hasContent = true;
      });
      return { row: startIdx + rowIndex + 1, draft, hasContent };
    });
  }

  function validateImportDrafts(tab, drafts) {
    const errors = [];
    const table = tableForImportValidation(tab);
    const validation = createRowDraftValidationContext({ table, rows: [] });
    for (const item of drafts) {
      if (!item.hasContent) continue;
      const result = validation.validate(item.draft);
      if (!result.valid) {
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

  function buildImportDrafts(tab) {
    const startIdx = 1;
    const rows = toRaw(importWizard.rawRows).slice(startIdx);
    const mapping = toRaw(importWizard.mapping).filter((m) => !m.skip && m.tableCol);
    const drafts = mappedImportDrafts(rows, mapping, startIdx, tab.columns);
    return { startIdx, rows, mapping, drafts };
  }

  async function executeImport() {
    const tab = activeTab.value;
    if (!tab?.sessionId) return;
    if (isReadOnlyTab(tab)) {
      importWizard.importing = false;
      statusText.value = "只读连接不能导入数据";
      return;
    }

    const { rows, mapping, drafts } = buildImportDrafts(tab);

    if (mapping.length === 0) { statusText.value = "没有有效的列映射"; return; }

    const preflightErrors = validateImportDrafts(tab, drafts);
    if (preflightErrors.length > 0) {
      importWizard.importing = false;
      importWizard.progress = importProgress({ total: rows.length, errors: preflightErrors });
      statusText.value = `导入校验失败：${preflightErrors.length} 个错误，未执行导入`;
      return;
    }

    importWizard.importing = true;
    importWizard.cancelled = false;
    importWizard.progress = importProgress({ total: rows.length });

    const validDrafts = drafts.filter((item) => item.hasContent);
    importWizard.progress.skipped = drafts.length - validDrafts.length;
    const runReplacement = (sessionId) => invokeWorkbench("replace_table_rows", {
      request: {
        sessionId,
        rows: validDrafts.map((item) => item.draft),
        mappedColumns: mapping.map((item) => item.tableCol),
      },
    });
    try {
      let result;
      try {
        result = await runReplacement(tab.sessionId);
      } catch (firstError) {
        if (!isSessionInvalidError(firstError) || typeof reopenTableSession !== "function") {
          throw firstError;
        }
        const reopened = await reopenTableSession(tab);
        if (!reopened || !tab.sessionId) throw firstError;
        statusText.value = "表会话已过期，已自动重新连接并重试";
        result = await runReplacement(tab.sessionId);
      }
      importWizard.progress.inserted = Number(result?.inserted || 0);
      importWizard.progress.updated = Number(result?.updated || 0);
      importWizard.progress.unchanged = Number(result?.unchanged || 0);
      importWizard.progress.deleted = Number(result?.deleted || 0);
      importWizard.progress.done = rows.length;
      await fetchPage(tab, tab.page);
      const skippedText = importWizard.progress.skipped ? `，跳过 ${importWizard.progress.skipped}` : "";
      const backupText = result?.backupPath ? `；原表已备份至 ${result.backupPath}` : "";
      statusText.value = `导入完成：新增 ${importWizard.progress.inserted}，覆盖 ${importWizard.progress.updated}，删除 ${importWizard.progress.deleted}，未变化 ${importWizard.progress.unchanged}${skippedText}${backupText}`;
      // The table now matches the spreadsheet; an earlier comparison no
      // longer reflects the database state.
      importWizard.comparison.stale = true;
    } catch (error) {
      importWizard.progress.done = rows.length;
      importWizard.progress.errors = [replacementImportError(error)];
      statusText.value = `导入失败：${String(error)}`;
    } finally {
      importWizard.importing = false;
    }
  }


  /**
   * Read-only change preview for the single-table import. Uses the exact same
   * replace_table_rows command as the real import with previewOnly: true, so
   * what the diff view shows is precisely what executeImport would write.
   */
  async function compareImportChanges() {
    const tab = activeTab.value;
    if (!tab?.sessionId) return null;
    if (isReadOnlyTab(tab)) {
      statusText.value = "只读连接不能对比变化";
      return null;
    }
    const { rows, mapping, drafts } = buildImportDrafts(tab);
    if (mapping.length === 0) {
      statusText.value = "没有有效的列映射";
      return null;
    }
    const validDrafts = drafts.filter((item) => item.hasContent);

    const nextRunId = Number(importWizard.comparison?.runId || 0) + 1;
    importWizard.comparison = createBatchImportComparison(nextRunId);
    const comparison = importWizard.comparison;
    comparison.running = true;
    comparison.status = "running";
    comparison.progress.total = rows.length;

    const sheet = {
      sheetName: tab.tableName || "导入",
      targetTableName: tab.tableName || "",
    };
    const columns = (tab.columns || [])
      .map((column) => ({
        name: columnName(column),
        primaryKey: Boolean(column?.is_primary_key || column?.isPrimaryKey),
      }))
      .filter((column) => column.name);

    // Client-side preflight errors become visible "error" rows in the
    // comparison view instead of blocking the preview outright.
    const preflightErrors = validateImportDrafts(tab, drafts);

    let result = null;
    let invokeError = null;
    const runPreview = (sessionId) => invokeWorkbench("replace_table_rows", {
      request: {
        sessionId,
        rows: validDrafts.map((item) => item.draft),
        mappedColumns: mapping.map((item) => item.tableCol),
        previewOnly: true,
      },
    });
    try {
      try {
        result = await runPreview(tab.sessionId);
      } catch (firstError) {
        if (!isSessionInvalidError(firstError) || typeof reopenTableSession !== "function") {
          throw firstError;
        }
        const reopened = await reopenTableSession(tab);
        if (!reopened || !tab.sessionId) throw firstError;
        statusText.value = "表会话已过期，已自动重新连接并重试";
        result = await runPreview(tab.sessionId);
      }
    } catch (error) {
      invokeError = error;
    }

    const inserted = Number(result?.inserted || 0);
    const updated = Number(result?.updated || 0);
    const deleted = Number(result?.deleted || 0);
    const unchanged = Number(result?.unchanged || 0);
    if (result) {
      appendBatchImportComparisonRows(
        comparison,
        comparisonRowsForReplacement(sheet, validDrafts, result),
        inserted + updated + deleted,
      );
    }
    if (invokeError) {
      appendBatchImportComparisonRows(
        comparison,
        comparisonErrorRows(sheet, [{ row: null }], invokeError),
      );
    }
    for (const error of preflightErrors) {
      appendBatchImportComparisonRows(
        comparison,
        comparisonErrorRows(sheet, [{ row: error.row }], error.message || error.error),
      );
    }
    const errorCount = preflightErrors.length + (invokeError ? 1 : 0);

    comparison.summary.inserted = inserted;
    comparison.summary.updated = updated;
    comparison.summary.deleted = deleted;
    comparison.summary.unchanged = unchanged;
    comparison.summary.skipped = drafts.length - validDrafts.length;
    comparison.summary.errors = errorCount;
    comparison.tables.push({
      sheetName: sheet.sheetName,
      tableName: sheet.targetTableName,
      inserted,
      updated,
      deleted,
      unchanged,
      skipped: comparison.summary.skipped,
      errors: errorCount,
      columns,
    });
    comparison.progress.done = rows.length;
    comparison.running = false;
    comparison.status = invokeError && !result ? "failed" : (errorCount ? "partial" : "succeeded");
    comparison.errorMessage = invokeError ? String(invokeError?.message || invokeError) : "";
    importWizard.step4View = "comparison";
    statusText.value = invokeError && !result
      ? `对比变化失败：${comparison.errorMessage}`
      : `变化对比完成：预计新增 ${inserted}，覆盖 ${updated}，删除 ${deleted}，未变化 ${unchanged}，${errorCount} 个异常`;
    return comparison;
  }

  function cancelImport() {
    if (!importWizard.importing) importWizard.cancelled = true;
  }

  function closeImportWizard() {
    if (importWizard.importing) return;
    importWizard.open = false;
  }

  return {
    importWizard,
    importInput,
    triggerImport,
    selectImportFile,
    onImportFileSelected,
    parseImportSheet,
    goToImportStep,
    checkImportWarnings,
    buildColumnMapping,
    executeImport,
    compareImportChanges,
    cancelImport,
    closeImportWizard,
  };
}
