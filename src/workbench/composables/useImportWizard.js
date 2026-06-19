import { reactive, ref } from "vue";
import { columnName } from "../utils/normalize.js";
import { validateRowDraft } from "../utils/valueValidation.js";

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

export function useImportWizard(invokeWorkbench, activeTab, { fetchPage }, { statusText }) {
  const importInput = ref(null);
  const importWizard = reactive({
    open: false,
    step: 1,
    fileName: "",
    sheetNames: [],
    selectedSheet: 0,
    headerRow: true,
    rawRows: [],
    workbook: null,
    preview: [],
    mapping: [],
    importing: false,
    progress: { done: 0, total: 0, errors: [] },
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
    importWizard.headerRow = true;
    importWizard.rawRows = [];
    importWizard.workbook = null;
    importWizard.preview = [];
    importWizard.mapping = [];
    importWizard.importing = false;
    importWizard.progress = { done: 0, total: 0, errors: [] };
    importWizard.warnings = [];
  }

  async function onImportFileSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
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

  function parseImportSheet() {
    const wb = importWizard.workbook;
    if (!wb || !xlsxModule) return;
    const sheetName = wb.SheetNames[importWizard.selectedSheet];
    const ws = wb.Sheets[sheetName];
    importWizard.rawRows = xlsxModule.utils.sheet_to_json(ws, { header: 1, defval: "" });
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
    const startIdx = importWizard.headerRow ? 1 : 0;
    const rows = importWizard.rawRows;
    if (rows.length <= startIdx) return;

    const fileCols = importWizard.headerRow
      ? rows[0].map((v) => String(v ?? ""))
      : rows[0].map((_, i) => `列${i + 1}`);

    const tableCols = tab.columns.map((c) => ({
      name: columnName(c),
      type: c.column_type || "",
      nullable: c.is_nullable,
    }));

    importWizard.mapping = fileCols.map((fc) => {
      const match = tableCols.find((tc) => tc.name.toLowerCase() === fc.toLowerCase());
      return { fileCol: fc, tableCol: match ? match.name : "", tableCols, skip: !match };
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
      mapping.forEach((m) => {
        const fileColIdx = importWizard.mapping.indexOf(m);
        const value = row?.[fileColIdx];
        if (value != null && String(value).trim() !== "") draft[m.tableCol] = String(value);
      });
      return { row: startIdx + rowIndex + 1, draft };
    });
  }

  function validateImportDrafts(tab, drafts) {
    const errors = [];
    const acceptedDrafts = [];
    const table = tableForImportValidation(tab);
    for (const item of drafts) {
      if (Object.keys(item.draft).length === 0) continue;
      const result = validateRowDraft({
        table,
        rows: tab.rows || [],
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

    const startIdx = importWizard.headerRow ? 1 : 0;
    const rows = importWizard.rawRows.slice(startIdx);
    const mapping = importWizard.mapping.filter((m) => !m.skip && m.tableCol);

    if (mapping.length === 0) { statusText.value = "没有有效的列映射"; return; }

    const drafts = mappedImportDrafts(rows, mapping, startIdx);
    const preflightErrors = validateImportDrafts(tab, drafts);
    if (preflightErrors.length > 0) {
      importWizard.importing = false;
      importWizard.progress = { done: 0, total: rows.length, errors: preflightErrors };
      statusText.value = `导入校验失败：${preflightErrors.length} 个错误，未执行导入`;
      return;
    }

    importWizard.importing = true;
    importWizard.progress = { done: 0, total: rows.length, errors: [] };

    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i].draft;
      try {
        if (Object.keys(draft).length > 0) {
          await invokeWorkbench("insert_row", { request: { sessionId: tab.sessionId, draft } });
        }
        importWizard.progress.done++;
      } catch (error) {
        importWizard.progress.errors.push({ row: drafts[i].row, error: String(error) });
        importWizard.progress.done++;
      }
    }

    importWizard.importing = false;
    await fetchPage(tab, tab.page);
    statusText.value = `导入完成：${rows.length - importWizard.progress.errors.length} 成功，${importWizard.progress.errors.length} 失败`;
  }

  function closeImportWizard() {
    importWizard.open = false;
    importWizard.importing = false;
  }

  return {
    importWizard,
    importInput,
    triggerImport,
    onImportFileSelected,
    parseImportSheet,
    goToImportStep,
    checkImportWarnings,
    buildColumnMapping,
    executeImport,
    closeImportWizard,
  };
}
