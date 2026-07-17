import {
  GRID_FIELD_COMMENT_COLLAPSED_HEIGHT,
  GRID_HEADER_HEIGHT,
} from "../constants.js";
import { buildRowKey, buildRowIdentity, rowIdentityLabel } from "../utils/rowIdentity.js";
import { tabRowCount } from "../rowStore.js";
import { createRowIndex } from "../utils/rowIndex.js";
import { resolveFieldCommentHeight, resolveGridRowHeight } from "../utils/gridRowHeight.js";
import { useConfirm } from "./useConfirm.js";

const ROW_SELECTION_INDEX_ATTRIBUTE = "data-row-selection-index";

export function useRowSelection(
  invokeWorkbench,
  { statusText },
  { fetchPage },
) {
  const { confirm } = useConfirm();
  let rowSelectionAnchor = null;
  let rowSelectionFocus = null;
  let rowDragState = null;
  let suppressNextRowClick = false;

  function allRowKeys(tab) {
    return tab ? createRowIndex(tab, { buildRowKey }).keys() : [];
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

  function renderedRowIndexFromPointer(wrap, event) {
    const selector = `[${ROW_SELECTION_INDEX_ATTRIBUTE}]`;
    let rowElement = event?.target?.closest?.(selector) || null;
    if (
      !rowElement &&
      Number.isFinite(event?.clientX) &&
      Number.isFinite(event?.clientY)
    ) {
      rowElement = wrap?.ownerDocument
        ?.elementFromPoint?.(event.clientX, event.clientY)
        ?.closest?.(selector) || null;
    }
    if (!rowElement) return null;
    if (typeof wrap?.contains === "function" && !wrap.contains(rowElement)) return null;
    const rowIndex = Number(rowElement.getAttribute?.(ROW_SELECTION_INDEX_ATTRIBUTE));
    return Number.isInteger(rowIndex) ? rowIndex : null;
  }

  function rowIndexFromPointer(wrap, event, tab) {
    const renderedRowIndex = renderedRowIndexFromPointer(wrap, event);
    if (Number.isInteger(renderedRowIndex)) {
      return Math.max(0, Math.min(tabRowCount(tab) - 1, renderedRowIndex));
    }

    const rect = wrap.getBoundingClientRect();
    const fieldCommentHeight = tab?.fieldCommentsExpanded === false
      ? GRID_FIELD_COMMENT_COLLAPSED_HEIGHT
      : resolveFieldCommentHeight(tab);
    const y = event.clientY - rect.top + wrap.scrollTop - GRID_HEADER_HEIGHT - fieldCommentHeight;
    return Math.max(0, Math.min(
      tabRowCount(tab) - 1,
      Math.floor(y / resolveGridRowHeight(tab)),
    ));
  }

  function clearRowSelection(tab) {
    tab?.selectedRowKeys?.clear();
    rowSelectionAnchor = null;
    rowSelectionFocus = null;
  }

  function toggleRowSelect(tab, row, event) {
    const key = buildRowKey(tab, row);
    const keys = tab.selectedRowKeys;

    if (event?.shiftKey) {
      const allKeys = allRowKeys(tab);
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

    if (event?.ctrlKey || event?.metaKey) {
      if (keys.has(key)) {
        keys.delete(key);
      } else {
        keys.add(key);
      }
      rowSelectionAnchor = key;
      rowSelectionFocus = key;
      return;
    }

    keys.clear();
    keys.add(key);
    rowSelectionAnchor = key;
    rowSelectionFocus = key;
  }

  function toggleAllRows(tab) {
    if (tabRowCount(tab) === 0) return;
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
    if (tabRowCount(tab) === 0 || !tab.selectedRowKeys?.size) return false;
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

  function startRowDragSelection(tab, row, event, wrap) {
    if (!tab || !row || (event?.button != null && event.button !== 0)) return false;
    finishRowDragSelection();
    const key = buildRowKey(tab, row);
    rowDragState = {
      tab,
      wrap,
      anchorKey: key,
      focusKey: key,
      active: false,
      additive: Boolean(event?.ctrlKey || event?.metaKey),
      baseKeys: [...(tab.selectedRowKeys || [])],
    };
    return true;
  }

  function extendRowDragSelectionFromPointer(tab, event) {
    if (!rowDragState || rowDragState.tab !== tab || !event) return false;
    const wrap = rowDragState.wrap;
    if (!wrap) return false;
    const rowIndex = rowIndexFromPointer(wrap, event, tab);
    const allKeys = allRowKeys(tab);
    const focusKey = allKeys[rowIndex];
    if (!focusKey) return false;
    const focusChanged = rowDragState.focusKey !== focusKey;
    rowDragState.focusKey = focusKey;
    if (!rowDragState.active && focusChanged) {
      rowDragState.active = true;
    }
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
    if (tab.readOnly || tab.read_only) {
      statusText.value = "只读连接不能删除数据";
      return;
    }
    const count = tab.selectedRowKeys.size;
    const sourceName = tab.database ? `${tab.database}.${tab.tableName}` : tab.tableName;
    const confirmed = await confirm({
      title: "删除选中行",
      message: `将删除 ${sourceName} 中已选的 ${count} 行。删除后可在备份中心回滚。`,
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const index = createRowIndex(tab, { buildRowKey });
      const identities = [...tab.selectedRowKeys]
        .map((key) => index.rowForKey(key))
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
    if (tab?.readOnly || tab?.read_only) {
      statusText.value = "只读连接不能删除数据";
      return;
    }
    const sourceName = tab.database ? `${tab.database}.${tab.tableName}` : tab.tableName;
    const identityLabel = rowIdentityLabel(tab, row);
    const targetText = identityLabel ? `${sourceName} 中 ${identityLabel} 的行` : `${sourceName} 的当前行`;
    const confirmed = await confirm({
      title: "删除当前行",
      message: `删除 ${targetText}？删除后可在备份中心回滚。`,
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await invokeWorkbench("delete_rows", {
        request: {
          sessionId: tab.sessionId,
          rowIdentities: [buildRowIdentity(tab, row)],
        },
      });
      const page = tabRowCount(tab) <= 1 && tab.page > 1 ? tab.page - 1 : tab.page;
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
    extendRowDragSelectionFromPointer,
    finishRowDragSelection,
    consumeRowDragClickSuppression,
    deleteSelectedRows,
    deleteRow,
  };
}
