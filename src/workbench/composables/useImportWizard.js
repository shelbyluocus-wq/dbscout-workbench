import { reactive, ref } from "vue";
import { columnName } from "../utils/normalize.js";
import { validateRowDraft } from "../utils/valueValidation.js";
import { worksheetToDisplayRows } from "../utils/xlsxWorkbook.js";

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
  return { done: 0, total: 0, inserted: 0, skipped: 0, errors: [], ...overrides };
}

export function useImportWizard(invokeWorkbench, activeTab, { fetchPage }, { statusText }) {
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
      columns: tab?.columns || [],
      primaryKeys: Array.isArray(tab?.primaryKeys) ? tab.primaryKeys : [],
    };
  }

  function mappedImportDrafts(rows, mapping, startIdx) {
    return rows.map((row, rowIndex) => {
      const draft = {};
      let hasContent = false;
      mapping.forEach((m) => {
        const fileColIdx = Number.isInteger(m.fileColIndex) ? m.fileColIndex : importWizard.mapping.indexOf(m);
        const value = row?.[fileColIdx];
        const textValue = value == null ? "" : String(value);
        draft[m.tableCol] = textValue;
        if (textValue.trim() !== "") hasContent = true;
      });
      return { row: startIdx + rowIndex + 1, draft, hasContent };
    });
  }

  function validateImportDrafts(tab, drafts) {
    const errors = [];
    const acceptedDrafts = [];
    const table = tableForImportValidation(tab);
    for (const item of drafts) {
      if (!item.hasContent) continue;
      const result = validateRowDraft({
        table,
        rows: [],
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

  async function executeImport() {
    const tab = activeTab.value;
    if (!tab?.sessionId) return;
    if (isReadOnlyTab(tab)) {
      importWizard.importing = false;
      statusText.value = "只读连接不能导入数据";
      return;
    }

    const startIdx = 1;
    const rows = importWizard.rawRows.slice(startIdx);
    const mapping = importWizard.mapping.filter((m) => !m.skip && m.tableCol);

    if (mapping.length === 0) { statusText.value = "没有有效的列映射"; return; }

    const drafts = mappedImportDrafts(rows, mapping, startIdx);
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

    for (let i = 0; i < drafts.length; i++) {
      // 用户点取消或关闭对话框时中止循环，已提交的行不会被回滚。
      if (importWizard.cancelled) break;
      const draft = drafts[i].draft;
      try {
        if (drafts[i].hasContent) {
          await invokeWorkbench("insert_row", { request: { sessionId: tab.sessionId, draft } });
          importWizard.progress.inserted++;
        } else {
          importWizard.progress.skipped++;
        }
        importWizard.progress.done++;
      } catch (error) {
        importWizard.progress.errors.push({ row: drafts[i].row, error: String(error) });
        importWizard.progress.done++;
      }
    }

    importWizard.importing = false;
    const statusPrefix = importWizard.cancelled ? "导入（已取消）" : "导入完成";
    await fetchPage(tab, tab.page);
    const skippedText = importWizard.progress.skipped ? `，${importWizard.progress.skipped} 跳过` : "";
    statusText.value = `${statusPrefix}：${importWizard.progress.inserted} 成功，${importWizard.progress.errors.length} 失败${skippedText}`;
  }

  function cancelImport() {
    importWizard.cancelled = true;
  }

  function closeImportWizard() {
    // 关闭对话框时若仍在导入，标记取消以中止后续 INSERT。循环会在下一轮检查时退出。
    if (importWizard.importing) importWizard.cancelled = true;
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
    cancelImport,
    closeImportWizard,
  };
}
