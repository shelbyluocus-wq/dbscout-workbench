import { computed, ref } from "vue";
import { columnName } from "../utils/normalize.js";
import { displayCellValue } from "../utils/cellDisplay.js";
import { matchSearchText } from "../utils/searchMatch.js";
import { getEditMutationVersion } from "../editState.js";

export function cellMatchesSearch(value, query, mode = "fuzzy") {
  return matchSearchText(value, query, { mode }).matched;
}

const searchCacheByTab = new WeakMap();

function searchColumnNames(tab) {
  return (Array.isArray(tab?.columns) ? tab.columns : []).map(columnName);
}

function searchCacheSignature(editState, tab, query, mode, columns) {
  return [
    tab?.id || "",
    tab?.tableKey || tab?.tableName || "",
    query,
    mode,
    columns.join("\u001f"),
    getEditMutationVersion(editState),
    tab?.rowKeyCacheVersion || 0,
  ].join("\u001e");
}

function getSearchCache(tab, signature) {
  const cached = searchCacheByTab.get(tab);
  if (cached?.signature === signature) return cached;
  const next = {
    signature,
    scannedRows: 0,
    matches: [],
  };
  searchCacheByTab.set(tab, next);
  return next;
}

export function findSearchMatches(editState, tab, options = {}) {
  const query = String(options.query ?? tab?.filter ?? "").trim();
  if (!tab || !query) return [];
  const columns = searchColumnNames(tab);
  const rows = Array.isArray(tab.rows) ? tab.rows : [];
  const mode = tab.filterMode || "fuzzy";
  const displayValue = options.displayCellValue || displayCellValue;
  const signature = searchCacheSignature(editState, tab, query, mode, columns);
  const cache = getSearchCache(tab, signature);
  if (cache.scannedRows > rows.length) {
    cache.scannedRows = 0;
    cache.matches = [];
  }
  for (let rowIndex = cache.scannedRows; rowIndex < rows.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex];
      const value = displayValue(editState || {}, tab, rows[rowIndex], column);
      const match = matchSearchText(value, query, { mode });
      if (match.matched) cache.matches.push({ rowIndex, columnIndex, rank: match.rank, score: match.score });
    }
  }
  cache.scannedRows = rows.length;
  return cache.matches
    .sort((left, right) => left.rank - right.rank || left.score - right.score || left.rowIndex - right.rowIndex || left.columnIndex - right.columnIndex)
    .map(({ rowIndex, columnIndex }) => ({ rowIndex, columnIndex }));
}

export function findFirstSearchMatch(editState, tab) {
  return findSearchMatches(editState, tab)[0] || null;
}

export function useTableSearch(activeTab, { editState = {}, loadNextPage, selectCellAt, statusText }) {
  const searchInputRef = ref(null);
  const searchMatches = ref([]);
  const activeSearchMatchIndex = ref(0);
  const hasSearchMatches = computed(() => searchMatches.value.length > 0);
  let searchRunId = 0;
  const pageLoadPromises = new Map();

  function loadNextSearchPage(tab) {
    if (!pageLoadPromises.has(tab)) {
      const pageLoadPromise = Promise.resolve(loadNextPage(tab)).finally(() => {
        pageLoadPromises.delete(tab);
      });
      pageLoadPromises.set(tab, pageLoadPromise);
    }
    return pageLoadPromises.get(tab);
  }

  function focusTableSearch() {
    searchInputRef.value?.focus();
    searchInputRef.value?.select?.();
  }

  function resetSearchMatches() {
    searchMatches.value = [];
    activeSearchMatchIndex.value = 0;
  }

  function refreshSearchMatches(tab) {
    searchMatches.value = findSearchMatches(editState, tab);
    if (activeSearchMatchIndex.value >= searchMatches.value.length) activeSearchMatchIndex.value = 0;
    return searchMatches.value;
  }

  function selectSearchMatch(tab, matchIndex) {
    const matches = searchMatches.value;
    if (!matches.length) return false;
    activeSearchMatchIndex.value = ((matchIndex % matches.length) + matches.length) % matches.length;
    const match = matches[activeSearchMatchIndex.value];
    selectCellAt(tab, match.rowIndex, match.columnIndex);
    if (statusText) statusText.value = `搜索命中第 ${match.rowIndex + 1} 行`;
    return true;
  }

  async function runTableSearch(query) {
    const tab = activeTab.value;
    if (!tab) return;
    tab.filter = String(query ?? "");
    tab.searchQuery = String(query ?? "");
    const runId = ++searchRunId;
    resetSearchMatches();
    if (!tab.filter.trim()) return;

    while (runId === searchRunId) {
      if (activeTab.value !== tab) return;
      refreshSearchMatches(tab);
      if (hasSearchMatches.value) {
        if (activeTab.value !== tab) return;
        selectSearchMatch(tab, activeSearchMatchIndex.value);
        return;
      }
      if (tab.fullyLoaded) {
        if (statusText) statusText.value = "当前表未找到匹配内容";
        return;
      }
      const loaded = await loadNextSearchPage(tab);
      if (runId !== searchRunId || activeTab.value !== tab) return;
      if (!loaded) return;
    }
  }

  async function goToNextSearchMatch() {
    const tab = activeTab.value;
    if (!tab) return;
    const runId = ++searchRunId;
    refreshSearchMatches(tab);
    if (!hasSearchMatches.value) {
      await runTableSearch(tab.searchQuery || tab.filter || "");
      return;
    }
    const nextMatchIndex = activeSearchMatchIndex.value + 1;
    if (nextMatchIndex < searchMatches.value.length) {
      selectSearchMatch(tab, nextMatchIndex);
      return;
    }
    while (!tab.fullyLoaded && runId === searchRunId) {
      const loaded = await loadNextSearchPage(tab);
      if (runId !== searchRunId || activeTab.value !== tab) return;
      refreshSearchMatches(tab);
      if (nextMatchIndex < searchMatches.value.length) {
        selectSearchMatch(tab, nextMatchIndex);
        return;
      }
      if (!loaded) break;
    }
    if (runId !== searchRunId || activeTab.value !== tab) return;
    selectSearchMatch(tab, nextMatchIndex);
  }

  async function goToPreviousSearchMatch() {
    const tab = activeTab.value;
    if (!tab) return;
    const runId = ++searchRunId;
    refreshSearchMatches(tab);
    if (!hasSearchMatches.value) {
      await runTableSearch(tab.searchQuery || tab.filter || "");
      return;
    }
    const previousMatchIndex = activeSearchMatchIndex.value - 1;
    if (previousMatchIndex >= 0) {
      selectSearchMatch(tab, previousMatchIndex);
      return;
    }
    while (!tab.fullyLoaded && runId === searchRunId) {
      const loaded = await loadNextSearchPage(tab);
      if (runId !== searchRunId || activeTab.value !== tab) return;
      refreshSearchMatches(tab);
      if (!loaded) break;
    }
    if (runId !== searchRunId || activeTab.value !== tab) return;
    selectSearchMatch(tab, previousMatchIndex);
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
    searchMatches,
    hasSearchMatches,
    focusTableSearch,
    runTableSearch,
    goToNextSearchMatch,
    goToPreviousSearchMatch,
    handleTableFindKeydown,
  };
}
