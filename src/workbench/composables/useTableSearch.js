import { computed, ref } from "vue";
import { columnName } from "../utils/normalize.js";
import { displayCellValue } from "../utils/cellDisplay.js";
import { tabRows } from "../rowStore.js";
import { matchSearchText } from "../utils/searchMatch.js";
import { getEditMutationVersion } from "../editState.js";
import { buildRowKey } from "../utils/rowIdentity.js";
import { createRowIndex } from "../utils/rowIndex.js";

export function cellMatchesSearch(value, query, mode = "fuzzy") {
  return matchSearchText(value, query, { mode }).matched;
}

const searchCacheByTab = new WeakMap();

function traceTableSearchPhase(phase) {
  const trace = globalThis.__DBSCOUT_TABLE_SEARCH_TRACE__;
  if (!Array.isArray(trace)) return;
  trace.push({ phase, at: globalThis.performance?.now?.() ?? Date.now() });
}

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
  const next = { signature, rows, scannedRows: 0, matches: [] };
  searchCacheByTab.set(tab, next);
  return next;
}

export function findSearchMatches(editState, tab, options = {}) {
  const query = String(options.query ?? tab?.filter ?? "").trim();
  if (!tab || !query) return [];
  const columns = searchColumnNames(tab);
  const rows = tabRows(tab);
  const mode = tab.filterMode || "fuzzy";
  const displayValue = options.displayCellValue || displayCellValue;
  const signature = searchCacheSignature(editState, tab, query, mode, columns);
  const cache = getSearchCache(tab, signature, rows);
  if (cache.scannedRows > rows.length) {
    cache.scannedRows = 0;
    cache.matches = [];
  }
  for (let rowIndex = cache.scannedRows; rowIndex < rows.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const column = columns[columnIndex];
      const value = displayValue(editState || {}, tab, rows[rowIndex], column);
      if (matchSearchText(value, query, { mode }).matched) {
        cache.matches.push({ rowIndex, columnIndex });
      }
    }
  }
  cache.scannedRows = rows.length;
  return cache.matches
    .sort((left, right) => left.rowIndex - right.rowIndex || left.columnIndex - right.columnIndex)
    .map(({ rowIndex, columnIndex }) => ({ rowIndex, columnIndex }));
}

export function findFirstSearchMatch(editState, tab) {
  return findSearchMatches(editState, tab)[0] || null;
}

function navigationMatches(tab, editState) {
  const query = String(tab?.searchQuery || tab?.filter || "").trim();
  if (!tab || !query) return [];
  if (tab.searchResultMode && Array.isArray(tab.searchResultMatches)) {
    return tab.searchResultMatches.map((match) => ({
      rowIndex: Number(match.rowIndex) || 0,
      columnIndex: Number(match.columnIndex) || 0,
    }));
  }
  return findSearchMatches(editState, tab, { query });
}

export function useTableSearch(activeTab, {
  editState = {},
  loadSearchResultPage,
  loadNextSearchResultPage,
  cancelSearchResultPage,
  selectCellAt,
  statusText,
  isEditing = () => false,
  getSelectedPosition = () => null,
  searchDebounceMs = 150,
  scheduleSearch = (callback, delay) => setTimeout(callback, delay),
  cancelScheduledSearch = (timer) => clearTimeout(timer),
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
    const tab = activeTab.value;
    const partial = tab?.searchResultMode
      ? tab.searchResultComplete !== true
      : !tab?.fullyLoaded;
    return { current, total, label: `${current}/${total}${partial ? "+" : ""}` };
  });
  const savedSelectionByTab = new WeakMap();
  let searchRunId = 0;
  let scheduledSearchId = null;
  let scheduledSearchResolve = null;
  let disposed = false;

  function focusTableSearch() {
    searchInputRef.value?.focus();
    searchInputRef.value?.select?.();
  }

  function resetSearchMatches() {
    searchMatches.value = [];
    activeSearchMatchIndex.value = 0;
  }

  function refreshSearchMatches(tab) {
    searchMatches.value = navigationMatches(tab, editState);
    if (activeSearchMatchIndex.value >= searchMatches.value.length) {
      activeSearchMatchIndex.value = Math.max(0, searchMatches.value.length - 1);
    }
    return searchMatches.value;
  }

  function refreshCurrentSearchMatches({ select = false } = {}) {
    const tab = activeTab.value;
    const matches = refreshSearchMatches(tab);
    if (select && matches.length) selectSearchMatch(tab, preferredMatchIndex(tab, 0));
    return matches;
  }

  async function resumeCurrentSearchResults({ select = false } = {}) {
    const tab = activeTab.value;
    if (!tab) return [];
    const runId = ++searchRunId;
    if (!(await continueUntilFirstMatch(tab, runId))) return [];
    const matches = refreshSearchMatches(tab);
    if (select && matches.length) selectSearchMatch(tab, preferredMatchIndex(tab, 0));
    return matches;
  }

  function selectedPositionFor(tab) {
    return getSelectedPosition() || savedSelectionByTab.get(tab) || null;
  }

  function preferredMatchIndex(tab, fallback = 0) {
    const matches = searchMatches.value;
    if (!matches.length) return fallback;
    const position = selectedPositionFor(tab);
    if (!position) return fallback;
    const rowKeys = Array.isArray(tab?.searchResultRowKeys) ? tab.searchResultRowKeys : [];
    const selectedIndex = matches.findIndex((match) => {
      const sameColumn = match.columnIndex === position.columnIndex;
      if (!sameColumn) return false;
      if (position.rowKey && rowKeys[match.rowIndex]) return rowKeys[match.rowIndex] === position.rowKey;
      return match.rowIndex === position.rowIndex;
    });
    return selectedIndex >= 0 ? selectedIndex : fallback;
  }

  function selectSearchMatch(tab, matchIndex) {
    const matches = searchMatches.value;
    if (!matches.length) return false;
    activeSearchMatchIndex.value = ((matchIndex % matches.length) + matches.length) % matches.length;
    const match = matches[activeSearchMatchIndex.value];
    if (!isEditing()) selectCellAt(tab, match.rowIndex, match.columnIndex);
    const backendMatch = tab?.searchResultMatches?.[activeSearchMatchIndex.value];
    const sourceRow = Number.isFinite(Number(backendMatch?.sourceRowIndex))
      ? Number(backendMatch.sourceRowIndex) + 1
      : match.rowIndex + 1;
    if (statusText) statusText.value = `搜索命中第 ${sourceRow} 行`;
    return true;
  }

  function cancelScheduled({ stale = true } = {}) {
    if (scheduledSearchId != null) cancelScheduledSearch(scheduledSearchId);
    scheduledSearchId = null;
    const resolve = scheduledSearchResolve;
    scheduledSearchResolve = null;
    if (resolve) resolve(stale ? { ok: false, stale: true } : { ok: false, cancelled: true });
  }

  async function continueUntilFirstMatch(tab, runId) {
    refreshSearchMatches(tab);
    while (
      runId === searchRunId
      && activeTab.value === tab
      && !searchMatches.value.length
      && tab.searchResultMode
      && tab.searchResultComplete !== true
    ) {
      const loaded = await loadNextSearchResultPage?.(tab);
      if (runId !== searchRunId || activeTab.value !== tab || loaded?.stale) return false;
      refreshSearchMatches(tab);
      if (!loaded?.ok) break;
    }
    return runId === searchRunId && activeTab.value === tab;
  }

  async function executeSearch(tab, query, runId) {
    if (typeof loadSearchResultPage !== "function") {
      if (statusText) statusText.value = "当前搜索服务不可用";
      return { ok: false };
    }
    const loaded = await loadSearchResultPage(tab, query);
    if (runId !== searchRunId || activeTab.value !== tab || loaded?.stale) return { ok: false, stale: true };
    if (!loaded?.ok) return loaded || { ok: false };
    tab.filter = query;
    tab.searchQuery = query;
    if (!(await continueUntilFirstMatch(tab, runId))) return { ok: false, stale: true };
    if (searchMatches.value.length) {
      selectSearchMatch(tab, preferredMatchIndex(tab, 0));
    } else if (tab.searchResultComplete && statusText) {
      statusText.value = "当前表未找到匹配内容";
    }
    return loaded;
  }

  function rememberSelection(tab) {
    if (!tab || savedSelectionByTab.has(tab)) return;
    const position = getSelectedPosition();
    if (position) savedSelectionByTab.set(tab, { ...position });
  }

  async function clearSearch(tab, runId) {
    cancelScheduled({ stale: false });
    await cancelSearchResultPage?.(tab);
    const restored = await loadSearchResultPage?.(tab, "");
    if (runId !== searchRunId || activeTab.value !== tab) return { ok: false, stale: true };
    resetSearchMatches();
    const saved = savedSelectionByTab.get(tab);
    savedSelectionByTab.delete(tab);
    if (saved && !isEditing()) {
      let rowIndex = saved.rowIndex;
      if (saved.rowKey) {
        const restoredIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(saved.rowKey);
        if (restoredIndex >= 0) rowIndex = restoredIndex;
      }
      selectCellAt(tab, rowIndex, saved.columnIndex);
    }
    return restored || { ok: true };
  }

  function runTableSearch(query) {
    traceTableSearchPhase("frontend:run:start");
    const tab = activeTab.value;
    if (!tab || disposed) return Promise.resolve({ ok: false });
    const text = String(query ?? "");
    const hadPendingOrActive = scheduledSearchId != null || tab.searchResultMode || tab.searchResultJobId;
    const runId = ++searchRunId;
    cancelScheduled();
    resetSearchMatches();
    if (!text.trim()) return clearSearch(tab, runId);
    rememberSelection(tab);
    traceTableSearchPhase("frontend:selection-saved");
    if (hadPendingOrActive) {
      void Promise.resolve(cancelSearchResultPage?.(tab)).catch(() => null);
    }
    return new Promise((resolve) => {
      scheduledSearchResolve = resolve;
      scheduledSearchId = scheduleSearch(() => {
        scheduledSearchId = null;
        scheduledSearchResolve = null;
        void executeSearch(tab, text.trim(), runId).then(resolve, (error) => {
          if (runId === searchRunId && statusText) statusText.value = `全表搜索失败：${String(error?.message || error)}`;
          resolve({ ok: false, error });
        });
      }, searchDebounceMs);
      traceTableSearchPhase("frontend:scheduled");
    });
  }

  async function goToNextSearchMatch() {
    const tab = activeTab.value;
    if (!tab) return false;
    const runId = ++searchRunId;
    refreshSearchMatches(tab);
    if (!searchMatches.value.length) return false;
    const nextIndex = activeSearchMatchIndex.value + 1;
    if (nextIndex < searchMatches.value.length) return selectSearchMatch(tab, nextIndex);
    while (tab.searchResultMode && !tab.searchResultComplete) {
      const loaded = await loadNextSearchResultPage?.(tab);
      if (runId !== searchRunId || activeTab.value !== tab || loaded?.stale) return false;
      refreshSearchMatches(tab);
      if (searchMatches.value.length > nextIndex) return selectSearchMatch(tab, nextIndex);
      if (!loaded?.ok) break;
    }
    if (runId !== searchRunId || activeTab.value !== tab) return false;
    if (Number(tab.searchResultDroppedRows || 0) > 0) {
      const query = tab.searchResultQuery || tab.searchQuery || tab.filter || "";
      const loaded = await loadSearchResultPage?.(tab, query);
      if (!loaded?.ok || runId !== searchRunId || activeTab.value !== tab) return false;
      refreshSearchMatches(tab);
    }
    return selectSearchMatch(tab, 0);
  }

  async function goToPreviousSearchMatch() {
    const tab = activeTab.value;
    if (!tab) return false;
    const runId = ++searchRunId;
    refreshSearchMatches(tab);
    if (!searchMatches.value.length) return false;
    const previousIndex = activeSearchMatchIndex.value - 1;
    if (previousIndex >= 0) return selectSearchMatch(tab, previousIndex);
    while (tab.searchResultMode && !tab.searchResultComplete) {
      const loaded = await loadNextSearchResultPage?.(tab);
      if (runId !== searchRunId || activeTab.value !== tab || loaded?.stale) return false;
      refreshSearchMatches(tab);
      if (!loaded?.ok) break;
    }
    if (runId !== searchRunId || activeTab.value !== tab) return false;
    return selectSearchMatch(tab, searchMatches.value.length - 1);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    searchRunId += 1;
    cancelScheduled({ stale: false });
    await cancelSearchResultPage?.(activeTab.value);
  }

  function handleTableFindKeydown(event) {
    const key = String(event.key || "").toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || key !== "f" || !activeTab.value) return false;
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
    resumeCurrentSearchResults,
    focusTableSearch,
    runTableSearch,
    goToNextSearchMatch,
    goToPreviousSearchMatch,
    handleTableFindKeydown,
    dispose,
  };
}
