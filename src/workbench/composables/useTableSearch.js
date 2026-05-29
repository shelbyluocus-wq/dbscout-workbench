import { ref } from "vue";
import { columnName } from "../utils/normalize.js";
import { displayCellValue } from "../utils/cellDisplay.js";

export function cellMatchesSearch(value, query, mode = "fuzzy") {
  const needle = String(query ?? "").trim();
  if (!needle) return false;
  const text = String(value ?? "");
  if (mode === "exact") return text === needle;
  return text.toLowerCase().includes(needle.toLowerCase());
}

export function findFirstSearchMatch(editState, tab) {
  const query = String(tab?.filter || "").trim();
  if (!tab || !query) return null;
  const columns = Array.isArray(tab.columns) ? tab.columns : [];
  const rows = Array.isArray(tab.rows) ? tab.rows : [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columnName(columns[columnIndex]);
      const value = displayCellValue(editState || {}, tab, rows[rowIndex], column);
      if (cellMatchesSearch(value, query, tab.filterMode || "fuzzy")) return { rowIndex, columnIndex };
    }
  }
  return null;
}

export function useTableSearch(activeTab, { editState = {}, loadNextPage, selectCellAt, statusText }) {
  const searchInputRef = ref(null);
  let searchRunId = 0;

  function focusTableSearch() {
    searchInputRef.value?.focus();
    searchInputRef.value?.select?.();
  }

  async function runTableSearch(query) {
    const tab = activeTab.value;
    if (!tab) return;
    tab.filter = String(query ?? "");
    const runId = ++searchRunId;
    if (!tab.filter.trim()) return;

    while (runId === searchRunId) {
      const match = findFirstSearchMatch(editState, tab);
      if (match) {
        selectCellAt(tab, match.rowIndex, match.columnIndex);
        if (statusText) statusText.value = `搜索命中第 ${match.rowIndex + 1} 行`;
        return;
      }
      if (tab.fullyLoaded) {
        if (statusText) statusText.value = "当前表未找到匹配内容";
        return;
      }
      const loaded = await loadNextPage(tab);
      if (!loaded) return;
    }
  }

  function handleTableFindKeydown(event) {
    const key = String(event.key || "").toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || key !== "f") return false;
    const tab = activeTab.value;
    if (!tab) return false;
    event.preventDefault();
    event.stopPropagation();
    focusTableSearch();
    return true;
  }

  return {
    searchInputRef,
    focusTableSearch,
    runTableSearch,
    handleTableFindKeydown,
  };
}
