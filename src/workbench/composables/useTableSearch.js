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
  ].join("\u001e");
}

function rowsMatchScannedPrefix(previousRows, rows, scannedRows) {
  if (!Array.isArray(previousRows)) return false;
  const count = Math.min(scannedRows, previousRows.length, rows.length);
  for (let index = 0; index < count; index++) {
    if (previousRows[index] !== rows[index]) return false;
  }
  return scannedRows <= rows.length;
}

function getSearchCache(tab, signature, rows) {
  const cached = searchCacheByTab.get(tab);
  if (cached?.signature === signature && rowsMatchScannedPrefix(cached.rows, rows, cached.scannedRows)) {
    cached.rows = rows;
    return cached;
  }
  const next = {
    signature,
    rows,
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
  const cache = getSearchCache(tab, signature, rows);
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

export function useTableSearch(activeTab, {
  editState = {},
  loadNextPage,
  loadSearchResultPage,
  selectCellAt,
  statusText,
}) {
  const searchInputRef = ref(null);
  const searchMatches = ref([]);
  const activeSearchMatchIndex = ref(0);
  const activeSearchQuery = computed(() => String(activeTab.value?.searchQuery || activeTab.value?.filter || "").trim());
  const hasSearchMatches = computed(() => searchMatches.value.length > 0);
  const hasSearchQuery = computed(() => Boolean(activeSearchQuery.value));
  const searchHitSummary = computed(() => {
    if (!hasSearchQuery.value) return { current: 0, total: 0, label: "" };
    const total = searchMatches.value.length;
    if (!total) return { current: 0, total: 0, label: "0/0" };
    const current = Math.max(0, Math.min(total - 1, activeSearchMatchIndex.value)) + 1;
    const partial = activeTab.value && !activeTab.value.fullyLoaded ? "+" : "";
    return { current, total, label: `${current}/${total}${partial}` };
  });
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
    const query = String(tab?.searchQuery || tab?.filter || "").trim();
    searchMatches.value = query ? findSearchMatches(editState, tab, { query }) : [];
    if (activeSearchMatchIndex.value >= searchMatches.value.length) activeSearchMatchIndex.value = 0;
    return searchMatches.value;
  }

  function refreshCurrentSearchMatches() {
    return refreshSearchMatches(activeTab.value);
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

  async function loadBackendSearchResults(tab, query, runId) {
    if (typeof loadSearchResultPage !== "function") return false;
    const loaded = await loadSearchResultPage(tab, query);
    if (runId !== searchRunId || activeTab.value !== tab) return true;
    refreshSearchMatches(tab);
    if (hasSearchMatches.value) {
      selectSearchMatch(tab, activeSearchMatchIndex.value);
      return true;
    }
    if (loaded && statusText) statusText.value = "当前表未找到匹配内容";
    return true;
  }

  async function runTableSearch(query, options = {}) {
    const tab = activeTab.value;
    if (!tab) return;
    tab.filter = String(query ?? "");
    tab.searchQuery = String(query ?? "");
    const runId = ++searchRunId;
    resetSearchMatches();
    if (!tab.filter.trim()) {
      if (tab.searchResultMode && typeof loadSearchResultPage === "function") {
        await loadSearchResultPage(tab, "");
      }
      return;
    }
    if (options.preferBackendResultPage) {
      await loadBackendSearchResults(tab, tab.searchQuery || tab.filter || "", runId);
      return;
    }
    if (tab.searchResultMode && typeof loadSearchResultPage === "function") {
      await loadSearchResultPage(tab, "");
      if (runId !== searchRunId || activeTab.value !== tab) return;
      tab.filter = String(query ?? "");
      tab.searchQuery = String(query ?? "");
    }

    let selectedFirstMatch = false;
    let sawAnyMatch = false;
    while (runId === searchRunId) {
      if (activeTab.value !== tab) return;
      refreshSearchMatches(tab);
      if (hasSearchMatches.value) {
        sawAnyMatch = true;
        if (activeTab.value !== tab) return;
        if (!selectedFirstMatch) {
          selectSearchMatch(tab, activeSearchMatchIndex.value);
          selectedFirstMatch = true;
        } else if (statusText && !tab.fullyLoaded) {
          statusText.value = `已命中 ${searchMatches.value.length}+ 处，继续搜索剩余行…`;
        }
        if (tab.fullyLoaded) return;
      }
      if (tab.fullyLoaded) {
        if (!sawAnyMatch && statusText) statusText.value = "当前表未找到匹配内容";
        return;
      }
      const previousRowCount = Array.isArray(tab.rows) ? tab.rows.length : 0;
      const loaded = await loadNextSearchPage(tab);
      if (runId !== searchRunId || activeTab.value !== tab) return;
      if (!loaded) {
        refreshSearchMatches(tab);
        if (!hasSearchMatches.value && !sawAnyMatch && statusText) statusText.value = "当前表未找到匹配内容";
        return;
      }
      if ((Array.isArray(tab.rows) ? tab.rows.length : 0) <= previousRowCount && !tab.fullyLoaded) {
        if (!hasSearchMatches.value && !sawAnyMatch && statusText) statusText.value = "当前表未找到匹配内容";
        return;
      }
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
    activeSearchQuery,
    hasSearchMatches,
    searchHitSummary,
    refreshCurrentSearchMatches,
    focusTableSearch,
    runTableSearch,
    goToNextSearchMatch,
    goToPreviousSearchMatch,
    handleTableFindKeydown,
  };
}
