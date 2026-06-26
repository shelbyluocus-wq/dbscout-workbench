import { columnName } from "../utils/normalize.js";
import { clampCellValue } from "../utils/xlsxLimit.js";

let xlsxModule = null;
let xlsxModulePromise = null;
const EXPORT_PAGE_SIZE = 10000;

async function loadXlsx() {
  if (xlsxModule) return xlsxModule;
  if (!xlsxModulePromise) xlsxModulePromise = import("xlsx");
  xlsxModule = await xlsxModulePromise;
  return xlsxModule;
}

function buildExportPageRequest(tab, page, pageSize) {
  const request = {
    page,
    pageSize,
    filter: tab?.filter
      ? {
          query: tab.filter,
          columns: [],
          mode: tab.filterMode || "fuzzy",
        }
      : null,
    sort: tab?.sort || null,
  };
  if (!request.filter) delete request.filter;
  if (!request.sort) delete request.sort;
  return request;
}

async function readExportRows(invokeWorkbench, tab, pageSize) {
  const requestedPageSize = Math.max(1, Math.floor(Number(pageSize) || EXPORT_PAGE_SIZE));
  if (!tab?.tableName) return { ...tab, rows: [] };
  const firstPage = await invokeWorkbench("open_table_session", {
    connectionId: tab.connectionId || tab.connection_id || "",
    database: tab.database || "",
    tableName: tab.tableName,
    options: buildExportPageRequest(tab, 1, requestedPageSize),
  });
  const rows = Array.isArray(firstPage.rows) ? [...firstPage.rows] : [];
  const totalRows = Math.max(0, Math.floor(Number(firstPage.totalRows) || rows.length || 0));
  const effectivePageSize = Math.max(1, Math.floor(Number(firstPage.pageSize) || requestedPageSize));
  let page = Math.max(1, Math.floor(Number(firstPage.page) || 1));
  while (firstPage.sessionId && rows.length < totalRows) {
    page += 1;
    const nextPage = await invokeWorkbench("fetch_table_page", {
      sessionId: firstPage.sessionId,
      request: buildExportPageRequest(tab, page, effectivePageSize),
    });
    const nextRows = Array.isArray(nextPage.rows) ? nextPage.rows : [];
    if (!nextRows.length) break;
    rows.push(...nextRows);
  }
  return {
    ...tab,
    ...firstPage,
    columns: Array.isArray(firstPage.columns) && firstPage.columns.length ? firstPage.columns : tab.columns,
    rows,
    tableName: firstPage.tableName || firstPage.table_name || tab.tableName,
  };
}

export function useExport(invokeWorkbench, { statusText, onSuccessFeedback, exportPageSize = EXPORT_PAGE_SIZE } = {}) {
  async function exportTable(tab) {
    if (!tab) return;
    const XLSX = await loadXlsx();
    statusText.value = `正在导出 ${tab.tableName || ""}…`;
    const exportPage = await readExportRows(invokeWorkbench, tab, exportPageSize);
    if (!exportPage.rows.length) return;
    const sourceName = exportPage.tableName;
    const header = exportPage.columns.map(columnName);
    const data = exportPage.rows.map(row => header.map(col => clampCellValue(row[col] ?? "")));
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sourceName.slice(0, 31));
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    try {
      const savedPath = await invokeWorkbench("save_export_file", {
        fileName: `${sourceName}.xlsx`,
        data: Array.from(new Uint8Array(wbout)),
      });
      statusText.value = `已导出 ${exportPage.rows.length} 行 → ${savedPath}`;
      onSuccessFeedback?.("导出成功");
    } catch (error) {
      if (String(error).includes("取消了")) return;
      const blob = new Blob([wbout], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sourceName}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      statusText.value = `已导出 ${exportPage.rows.length} 行`;
      onSuccessFeedback?.("导出成功");
    }
  }

  return { exportTable };
}
