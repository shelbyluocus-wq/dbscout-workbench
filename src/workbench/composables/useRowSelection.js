import {
  GRID_FIELD_COMMENT_COLLAPSED_HEIGHT,
  GRID_HEADER_HEIGHT,
} from "../constants.js";
import { buildRowIdentity, rowIdentityLabel } from "../utils/rowIdentity.js";
import { gridRowKey, insertRowIdFromRow, isInsertDraftRow } from "../utils/gridRowIdentity.js";
import { tabRowAt, tabRowCount } from "../rowStore.js";
import { resolveFieldCommentHeight, resolveGridRowHeight } from "../utils/gridRowHeight.js";
import { useConfirm } from "./useConfirm.js";

const ROW_SELECTION_INDEX_ATTRIBUTE = "data-row-selection-index";

export function useRowSelection(
  invokeWorkbench,
  { statusText },
  {
    fetchPage,
    prepareForDelete = async () => true,
    getVisualRowModel = null,
    removeInsertRows = () => 0,
  },
) {
  const { confirm } = useConfirm();
  let rowSelectionAnchor = null;
  let rowSelectionFocus = null;
  let rowDragState = null;
  let suppressNextRowClick = false;

  function allRowEntries(tab) {
    if (!tab) return [];
    if (typeof getVisualRowModel === "function") {
      const model = getVisualRowModel(tab);
      if (model && typeof model[Symbol.iterator] === "function") return [...model];
    }
    return Array.from({ length: tabRowCount(tab) }, (_, dataIndex) => ({
      type: "data",
      dataIndex,
      row: tabRowAt(tab, dataIndex),
    }));
  }

  function allRowKeys(tab) {
    return allRowEntries(tab).map((entry) => gridRowKey(tab, entry.row));
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
    const rowCount = allRowEntries(tab).length;
    if (rowCount === 0) return -1;
    const renderedRowIndex = renderedRowIndexFromPointer(wrap, event);
    if (Number.isInteger(renderedRowIndex)) {
      return Math.max(0, Math.min(rowCount - 1, renderedRowIndex));
    }

    const rect = wrap.getBoundingClientRect();
    const fieldCommentHeight = tab?.fieldCommentsExpanded === false
      ? GRID_FIELD_COMMENT_COLLAPSED_HEIGHT
      : resolveFieldCommentHeight(tab);
    const y = event.clientY - rect.top + wrap.scrollTop - GRID_HEADER_HEIGHT - fieldCommentHeight;
    return Math.max(0, Math.min(
      rowCount - 1,
      Math.floor(y / resolveGridRowHeight(tab)),
    ));
  }

  function clearRowSelection(tab) {
    tab?.selectedRowKeys?.clear();
    rowSelectionAnchor = null;
    rowSelectionFocus = null;
  }

  function toggleRowSelect(tab, row, event) {
    const key = gridRowKey(tab, row);
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

  function ensureRowContextSelection(tab, row) {
    if (!tab || !row) return false;
    if (!(tab.selectedRowKeys instanceof Set)) tab.selectedRowKeys = new Set();
    const key = gridRowKey(tab, row);
    if (tab.selectedRowKeys.has(key)) return false;
    toggleRowSelect(tab, row, {});
    return true;
  }

  function toggleAllRows(tab) {
    if (allRowEntries(tab).length === 0) return;
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
    if (allRowEntries(tab).length === 0 || !tab.selectedRowKeys?.size) return false;
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
    const key = gridRowKey(tab, row);
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
    const selectedEntries = allRowEntries(tab)
      .filter((entry) => tab.selectedRowKeys.has(gridRowKey(tab, entry.row)));
    const insertEntries = selectedEntries.filter((entry) => entry.type === "insert" || isInsertDraftRow(entry.row));
    const dataEntries = selectedEntries.filter((entry) => entry.type === "data" && entry.row);
    const insertRowIds = insertEntries.map((entry) => insertRowIdFromRow(entry.row)).filter(Boolean);
    if (dataEntries.length === 0) {
      const removed = removeInsertRows(tab, insertRowIds);
      clearRowSelection(tab);
      if (removed > 0) {
        statusText.value = removed > 1 ? `已移除 ${removed} 条新增未保存行` : "已移除新增未保存行";
      }
      return;
    }
    if (tab.readOnly || tab.read_only) {
      statusText.value = "只读连接不能删除数据";
      return;
    }
    const count = dataEntries.length;
    const sourceName = tab.database ? `${tab.database}.${tab.tableName}` : tab.tableName;
    const insertNotice = insertRowIds.length > 0 ? `，并移除 ${insertRowIds.length} 条未保存新增行` : "";
    const confirmed = await confirm({
      title: "删除选中行",
      message: `将删除 ${sourceName} 中已选的 ${count} 行${insertNotice}。删除后可在备份中心回滚。`,
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!confirmed) return;
    try {
      if (!(await prepareForDelete(tab, { excludeInsertRowIds: insertRowIds }))) return;
      const identities = dataEntries.map((entry) => buildRowIdentity(tab, entry.row));
      await invokeWorkbench("delete_rows", {
        request: {
          sessionId: tab.sessionId,
          rowIdentities: identities,
        },
      });
      if (insertRowIds.length > 0) {
        removeInsertRows(tab, insertRowIds, { recordHistory: false, updateStatus: false, refocus: false });
      }
      tab.selectedRowKeys = new Set();
      rowSelectionAnchor = null;
      rowSelectionFocus = null;
      await fetchPage(tab, 1);
      statusText.value = insertRowIds.length > 0
        ? `已删除 ${count} 行，并移除 ${insertRowIds.length} 条未保存新增行`
        : `已删除 ${count} 行`;
    } catch (error) {
      statusText.value = `删除失败：${String(error)}`;
    }
  }

  async function deleteRow(tab, row) {
    if (isInsertDraftRow(row)) {
      removeInsertRows(tab, [insertRowIdFromRow(row)]);
      return;
    }
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
      if (!(await prepareForDelete(tab))) return;
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
    ensureRowContextSelection,
    toggleAllRows,
    moveRowSelection,
    startRowDragSelection,
    extendRowDragSelectionFromPointer,
    finishRowDragSelection,
    consumeRowDragClickSuppression,
    selectedRowIndexes,
    allRowEntries,
    deleteSelectedRows,
    deleteRow,
  };
}
