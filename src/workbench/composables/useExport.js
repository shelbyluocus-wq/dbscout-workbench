import { columnName } from "../utils/normalize.js";

let xlsxModule = null;
let xlsxModulePromise = null;

async function loadXlsx() {
  if (xlsxModule) return xlsxModule;
  if (!xlsxModulePromise) xlsxModulePromise = import("xlsx");
  xlsxModule = await xlsxModulePromise;
  return xlsxModule;
}

export function useExport(invokeWorkbench, { statusText, onSuccessFeedback } = {}) {
  async function exportTable(tab) {
    if (!tab?.rows?.length) return;
    const XLSX = await loadXlsx();
    const sourceName = tab.tableName;
    const header = tab.columns.map(columnName);
    const data = tab.rows.map(row => header.map(col => row[col] ?? ""));
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sourceName.slice(0, 31));
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    try {
      const savedPath = await invokeWorkbench("save_export_file", {
        fileName: `${sourceName}.xlsx`,
        data: Array.from(new Uint8Array(wbout)),
      });
      statusText.value = `已导出 ${tab.rows.length} 行 → ${savedPath}`;
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
      statusText.value = `已导出 ${tab.rows.length} 行`;
      onSuccessFeedback?.("导出成功");
    }
  }

  return { exportTable };
}
