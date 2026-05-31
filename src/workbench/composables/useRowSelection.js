import { buildRowKey, buildRowIdentity } from "../utils/rowIdentity.js";

export function useRowSelection(
  invokeWorkbench,
  { statusText },
  { fetchPage },
  {
    rowDragDelayMs = 180,
    setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
  } = {},
) {
  let rowSelectionAnchor = null;
  let rowSelectionFocus = null;
  let rowDragState = null;
  let suppressNextRowClick = false;

  function allRowKeys(tab) {
    return Array.isArray(tab?.rows) ? tab.rows.map((r) => buildRowKey(tab, r)) : [];
  }

  function setRowKeys(keys, nextKeys) {
    keys.clear();
    for (const key of nextKeys) keys.add(key);
  }

  function selectRowRange(tab, anchorKey, focusKey, baseKeys = []) {
    const allKeys = allRowKeys(tab);
    const from = allKeys.indexOf(anchorKey);
    const to = allKeys.indexOf(focusKey);
    const nextKeys = new Set(baseKeys);
    if (from >= 0 && to >= 0) {
      const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
      for (let i = lo; i <= hi; i++) nextKeys.add(allKeys[i]);
    } else if (focusKey) {
      nextKeys.add(focusKey);
    }
    setRowKeys(tab.selectedRowKeys, allKeys.filter((key) => nextKeys.has(key)));
    rowSelectionAnchor = anchorKey || focusKey || rowSelectionAnchor;
    rowSelectionFocus = focusKey || anchorKey || rowSelectionFocus;
  }

  function clearRowDragTimer() {
    if (rowDragState?.timer && clearTimeoutFn) clearTimeoutFn(rowDragState.timer);
    if (rowDragState) rowDragState.timer = null;
  }

  function activateRowDragSelection() {
    if (!rowDragState) return;
    rowDragState.active = true;
    clearRowDragTimer();
    selectRowRange(
      rowDragState.tab,
      rowDragState.anchorKey,
      rowDragState.focusKey,
      rowDragState.additive ? rowDragState.baseKeys : [],
    );
  }

  function clearRowSelection(tab) {
    tab?.selectedRowKeys?.clear();
    rowSelectionAnchor = null;
    rowSelectionFocus = null;
  }

  function toggleRowSelect(tab, row, event) {
    const key = buildRowKey(tab, row);
    const keys = tab.selectedRowKeys;
    const allKeys = allRowKeys(tab);

    if (event?.shiftKey) {
      const from = allKeys.indexOf(rowSelectionAnchor || key);
      const to = allKeys.indexOf(key);
      keys.clear();
      if (from >= 0 && to >= 0) {
        const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
        for (let i = lo; i <= hi; i++) keys.add(allKeys[i]);
      } else {
        keys.add(key);
      }
      if (!rowSelectionAnchor) rowSelectionAnchor = key;
      rowSelectionFocus = key;
      return;
    }

    if (keys.has(key)) {
      keys.delete(key);
    } else {
      keys.add(key);
    }
    rowSelectionAnchor = key;
    rowSelectionFocus = key;
  }

  function toggleAllRows(tab) {
    if (!tab?.rows?.length) return;
    const keys = tab.selectedRowKeys;
    const allKeys = allRowKeys(tab);
    if (keys.size === allKeys.length) {
      keys.clear();
      rowSelectionAnchor = null;
      rowSelectionFocus = null;
    } else {
      setRowKeys(keys, allKeys);
      rowSelectionAnchor = allKeys[0] || null;
      rowSelectionFocus = allKeys.at(-1) || null;
    }
  }

  function selectedRowIndexes(tab) {
    const keys = tab?.selectedRowKeys;
    if (!keys?.size) return [];
    return allRowKeys(tab)
      .map((key, index) => (keys.has(key) ? index : -1))
      .filter((index) => index >= 0);
  }

  function indexesAreContiguous(indexes) {
    return indexes.every((index, offset) => offset === 0 || index === indexes[offset - 1] + 1);
  }

  function moveRowSelection(tab, key, { extendRange = false } = {}) {
    if (!tab?.rows?.length || !tab.selectedRowKeys?.size) return false;
    if (key === "ArrowLeft" || key === "ArrowRight") return false;
    if (key !== "ArrowUp" && key !== "ArrowDown") return false;

    const allKeys = allRowKeys(tab);
    const indexes = selectedRowIndexes(tab);
    if (indexes.length === 0) return false;
    const delta = key === "ArrowUp" ? -1 : 1;

    if (extendRange) {
      const anchorIndex = allKeys.indexOf(rowSelectionAnchor) >= 0 ? allKeys.indexOf(rowSelectionAnchor) : indexes[0];
      const fallbackFocusIndex = key === "ArrowUp" ? indexes[0] : indexes.at(-1);
      const focusIndex = allKeys.indexOf(rowSelectionFocus) >= 0 ? allKeys.indexOf(rowSelectionFocus) : fallbackFocusIndex;
      const nextFocusIndex = Math.max(0, Math.min(allKeys.length - 1, focusIndex + delta));
      selectRowRange(tab, allKeys[anchorIndex], allKeys[nextFocusIndex]);
      return true;
    }

    let nextIndexes;
    if (indexesAreContiguous(indexes)) {
      const first = indexes[0];
      const last = indexes.at(-1);
      if (delta < 0) {
        const nextFirst = Math.max(0, first - 1);
        nextIndexes = indexes.map((index) => index - (first - nextFirst));
      } else {
        const nextLast = Math.min(allKeys.length - 1, last + 1);
        nextIndexes = indexes.map((index) => index + (nextLast - last));
      }
    } else {
      const focusIndex = allKeys.indexOf(rowSelectionFocus);
      const currentIndex = focusIndex >= 0 ? focusIndex : delta < 0 ? indexes[0] : indexes.at(-1);
      nextIndexes = [Math.max(0, Math.min(allKeys.length - 1, currentIndex + delta))];
    }

    const nextKeys = nextIndexes.map((index) => allKeys[index]).filter(Boolean);
    setRowKeys(tab.selectedRowKeys, nextKeys);
    rowSelectionAnchor = nextKeys[0] || null;
    rowSelectionFocus = nextKeys.at(-1) || rowSelectionAnchor;
    return true;
  }

  function startRowDragSelection(tab, row, event) {
    if (!tab || !row || (event?.button != null && event.button !== 0)) return false;
    finishRowDragSelection();
    const key = buildRowKey(tab, row);
    rowDragState = {
      tab,
      anchorKey: key,
      focusKey: key,
      active: false,
      additive: Boolean(event?.ctrlKey || event?.metaKey),
      baseKeys: [...(tab.selectedRowKeys || [])],
      timer: null,
    };
    if (rowDragDelayMs <= 0 || !setTimeoutFn) activateRowDragSelection();
    else rowDragState.timer = setTimeoutFn(activateRowDragSelection, rowDragDelayMs);
    return true;
  }

  function extendRowDragSelection(tab, row) {
    if (!rowDragState || rowDragState.tab !== tab || !row) return false;
    rowDragState.focusKey = buildRowKey(tab, row);
    if (rowDragState.active) {
      selectRowRange(
        tab,
        rowDragState.anchorKey,
        rowDragState.focusKey,
        rowDragState.additive ? rowDragState.baseKeys : [],
      );
    }
    return rowDragState.active;
  }

  function finishRowDragSelection() {
    if (!rowDragState) return false;
    const wasActive = rowDragState.active;
    clearRowDragTimer();
    rowDragState = null;
    if (wasActive) suppressNextRowClick = true;
    return wasActive;
  }

  function consumeRowDragClickSuppression() {
    const suppressed = suppressNextRowClick;
    suppressNextRowClick = false;
    return suppressed;
  }

  async function deleteSelectedRows(tab) {
    if (!tab || tab.selectedRowKeys.size === 0) return;
    const count = tab.selectedRowKeys.size;
    if (!window.confirm(`确定删除选中的 ${count} 行？`)) return;
    try {
      const identities = [...tab.selectedRowKeys]
        .map((key) => tab.rows.find((r) => buildRowKey(tab, r) === key))
        .filter(Boolean)
        .map((row) => buildRowIdentity(tab, row));
      await invokeWorkbench("delete_rows", {
        request: {
          sessionId: tab.sessionId,
          rowIdentities: identities,
        },
      });
      tab.selectedRowKeys = new Set();
      rowSelectionAnchor = null;
      rowSelectionFocus = null;
      await fetchPage(tab, 1);
      statusText.value = `已删除 ${count} 行`;
    } catch (error) {
      statusText.value = `删除失败：${String(error)}`;
    }
  }

  async function deleteRow(tab, row) {
    const sourceName = tab.database ? `${tab.database}.${tab.tableName}` : tab.tableName;
    if (!window.confirm(`删除 ${sourceName} 当前行？`)) return;
    try {
      await invokeWorkbench("delete_rows", {
        request: {
          sessionId: tab.sessionId,
          rowIdentities: [buildRowIdentity(tab, row)],
        },
      });
      const page = tab.rows.length <= 1 && tab.page > 1 ? tab.page - 1 : tab.page;
      await fetchPage(tab, page);
      statusText.value = "已删除 1 行";
    } catch (error) {
      statusText.value = `删除失败：${String(error)}`;
    }
  }

  return {
    clearRowSelection,
    toggleRowSelect,
    toggleAllRows,
    moveRowSelection,
    startRowDragSelection,
    extendRowDragSelection,
    finishRowDragSelection,
    consumeRowDragClickSuppression,
    deleteSelectedRows,
    deleteRow,
  };
}
