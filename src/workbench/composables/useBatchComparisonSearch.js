import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { matchSearchText } from "../utils/searchMatch.js";
import {
  DEFAULT_TABLE_FILTER_MODE,
  normalizeTableFilterMode,
} from "../utils/tableFilterMode.js";

const EMPTY_MATCH = Object.freeze({ matched: false, ranges: [] });

function readSource(source) {
  if (typeof source === "function") return source();
  return source?.value ?? source;
}

function normalizedComparisonColumns(columns = []) {
  const seen = new Set();
  return columns
    .map((column) => (
      typeof column === "string"
        ? { name: column, primaryKey: false }
        : { name: String(column?.name || ""), primaryKey: Boolean(column?.primaryKey) }
    ))
    .filter((column) => {
      if (!column.name || seen.has(column.name)) return false;
      seen.add(column.name);
      return true;
    });
}

export function comparisonSearchColumns(columns = [], showPrimaryKeys = true) {
  const visible = normalizedComparisonColumns(columns)
    .filter((column) => showPrimaryKeys || !column.primaryKey);
  return [
    ...visible.filter((column) => column.primaryKey),
    ...visible.filter((column) => !column.primaryKey),
  ];
}

export function comparisonCellSearchText(value) {
  return value === null || value === undefined ? "NULL" : String(value);
}

function sideMatch(row, side, columnName, query, mode) {
  const source = row?.[side];
  if (!source || !Object.hasOwn(source, columnName)) return EMPTY_MATCH;
  return matchSearchText(comparisonCellSearchText(source[columnName]), query, { mode });
}

function rowSearchMatches(row, rowIndex, columns, query, mode, matches) {
  if (!row || row.status === "error") return;
  for (const column of columns) {
    const after = sideMatch(row, "after", column.name, query, mode);
    const before = sideMatch(row, "before", column.name, query, mode);
    if (!after.matched && !before.matched) continue;
    matches.push({
      row,
      rowId: row.id ?? `comparison-row-${rowIndex}`,
      rowIndex,
      columnName: column.name,
      after,
      before,
    });
  }
}

export function findBatchComparisonSearchMatches(rows, columns, query, options = {}) {
  const text = String(query ?? "").trim();
  if (!text) return [];
  const mode = normalizeTableFilterMode(options.mode);
  const searchColumns = comparisonSearchColumns(columns, options.showPrimaryKeys !== false);
  const matches = [];
  for (let rowIndex = 0; rowIndex < (rows || []).length; rowIndex += 1) {
    rowSearchMatches(rows[rowIndex], rowIndex, searchColumns, text, mode, matches);
  }
  return matches;
}

function yieldToInterface() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function findBatchComparisonSearchMatchesAsync(rows, columns, query, options = {}) {
  const text = String(query ?? "").trim();
  if (!text) return [];
  const mode = normalizeTableFilterMode(options.mode);
  const searchColumns = comparisonSearchColumns(columns, options.showPrimaryKeys !== false);
  const chunkSize = Math.max(50, Number(options.chunkSize) || 500);
  const shouldCancel = options.shouldCancel || (() => false);
  const yieldControl = options.yieldControl || yieldToInterface;
  const sourceRows = rows || [];
  const matches = [];

  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
    if (shouldCancel()) return null;
    rowSearchMatches(sourceRows[rowIndex], rowIndex, searchColumns, text, mode, matches);
    if ((rowIndex + 1) % chunkSize === 0 && rowIndex + 1 < sourceRows.length) {
      await yieldControl();
    }
  }
  return shouldCancel() ? null : matches;
}

export function nextBatchComparisonSearchIndex(currentIndex, total, direction) {
  const count = Math.max(0, Number(total) || 0);
  if (!count) return 0;
  const delta = direction < 0 ? -1 : 1;
  return ((Number(currentIndex) + delta) % count + count) % count;
}

export function useBatchComparisonSearch(options = {}) {
  const query = ref("");
  const mode = ref(DEFAULT_TABLE_FILTER_MODE);
  const matches = shallowRef([]);
  const activeSearchMatchIndex = ref(0);
  const searching = ref(false);
  const partial = ref(false);
  const error = ref("");
  const debounceMs = Math.max(0, Number(options.debounceMs) || 150);
  const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
  const cancelSchedule = options.cancelSchedule || ((timer) => clearTimeout(timer));
  let scheduledSearch = null;
  let searchRunId = 0;
  let disposed = false;

  const canSearch = computed(() => options.canSearch == null || Boolean(readSource(options.canSearch)));
  const activeSearchMatch = computed(() => matches.value[activeSearchMatchIndex.value] || null);
  const hasSearchMatches = computed(() => matches.value.length > 0);
  const searchHitSummary = computed(() => {
    if (!query.value.trim() || !canSearch.value) return { current: 0, total: 0, label: "" };
    const total = matches.value.length;
    if (!total) return { current: 0, total: 0, label: `0/0${partial.value ? "+" : ""}` };
    const current = Math.min(total - 1, Math.max(0, activeSearchMatchIndex.value)) + 1;
    return { current, total, label: `${current}/${total}${partial.value ? "+" : ""}` };
  });

  function cancelScheduledSearch() {
    if (scheduledSearch == null) return;
    cancelSchedule(scheduledSearch);
    scheduledSearch = null;
  }

  function clearResults() {
    matches.value = [];
    activeSearchMatchIndex.value = 0;
    partial.value = false;
    error.value = "";
  }

  async function executeSearch(runId) {
    const text = query.value.trim();
    if (!text || !canSearch.value || disposed || runId !== searchRunId) return false;
    searching.value = true;
    error.value = "";
    try {
      const prepared = await options.prepareSearch?.();
      if (disposed || runId !== searchRunId) return false;
      const found = await findBatchComparisonSearchMatchesAsync(
        readSource(options.rows) || [],
        readSource(options.columns) || [],
        text,
        {
          mode: mode.value,
          showPrimaryKeys: readSource(options.showPrimaryKeys) !== false,
          shouldCancel: () => disposed || runId !== searchRunId,
          yieldControl: options.yieldControl,
        },
      );
      if (!found || disposed || runId !== searchRunId) return false;
      matches.value = found;
      activeSearchMatchIndex.value = 0;
      partial.value = prepared?.complete === false;
      error.value = String(prepared?.error || "");
      return true;
    } catch (searchError) {
      if (disposed || runId !== searchRunId) return false;
      clearResults();
      error.value = String(searchError?.message || searchError || "搜索失败");
      return false;
    } finally {
      if (runId === searchRunId) searching.value = false;
    }
  }

  function runSearchNow() {
    cancelScheduledSearch();
    const runId = ++searchRunId;
    clearResults();
    if (!query.value.trim() || !canSearch.value) {
      searching.value = false;
      return Promise.resolve(false);
    }
    return executeSearch(runId);
  }

  function scheduleSearch() {
    cancelScheduledSearch();
    const runId = ++searchRunId;
    clearResults();
    if (!query.value.trim() || !canSearch.value) {
      searching.value = false;
      return;
    }
    searching.value = true;
    scheduledSearch = schedule(() => {
      scheduledSearch = null;
      void executeSearch(runId);
    }, debounceMs);
  }

  function setMode(nextMode) {
    mode.value = normalizeTableFilterMode(nextMode);
  }

  function moveSearchMatch(direction) {
    if (!matches.value.length || searching.value) return false;
    activeSearchMatchIndex.value = nextBatchComparisonSearchIndex(
      activeSearchMatchIndex.value,
      matches.value.length,
      direction,
    );
    return true;
  }

  const stopWatching = watch(
    () => [
      query.value,
      mode.value,
      readSource(options.scopeKey),
      readSource(options.showPrimaryKeys) !== false,
      canSearch.value,
    ],
    scheduleSearch,
    { flush: "sync" },
  );

  function dispose() {
    disposed = true;
    searchRunId += 1;
    cancelScheduledSearch();
    stopWatching();
  }

  onBeforeUnmount(dispose);

  return {
    query,
    mode,
    matches,
    activeSearchMatchIndex,
    activeSearchMatch,
    hasSearchMatches,
    searchHitSummary,
    searching,
    partial,
    error,
    runSearchNow,
    setMode,
    goToNextSearchMatch: () => moveSearchMatch(1),
    goToPreviousSearchMatch: () => moveSearchMatch(-1),
    dispose,
  };
}
