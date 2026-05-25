import { computed, nextTick, reactive, ref } from "vue";
import { columnName } from "../utils/normalize.js";
import { buildRowKey, buildRowIdentity, findRowByKey } from "../utils/rowIdentity.js";
import { displayCellValue } from "../utils/cellDisplay.js";
import {
  startCellCommit,
  finishCellCommit,
  failCellCommit,
  isCellPending,
  getCellError,
  getOptimisticCellValue,
  popUndo,
} from "../editState.js";

/**
 * Manages cell selection, inline editing, keyboard navigation, insert-row
 * drafts and cell commits for the data grid.
 *
 * @param {object}   editState        – reactive edit state (from createEditState)
 * @param {Function} invokeWorkbench  – async (command, payload) => result
 * @param {import('vue').ComputedRef} activeTab – computed active tab
 * @param {import('vue').Ref<HTMLElement|null>} gridWrapRef – grid container element
 * @param {{ scrollRowIntoView: Function }} virtualGrid – from useVirtualGrid
 * @param {{ busy: import('vue').Ref<boolean>, statusText: import('vue').Ref<string> }} appState
 */
export function useGridEditor(
  editState,
  invokeWorkbench,
  activeTab,
  gridWrapRef,
  { scrollRowIntoView },
  { busy, statusText },
) {
  // ── Selection & editing state ─────────────────────────────────────────
  const selectedCell = ref(null);
  const selectedRange = ref(null);
  const isSelectingRange = ref(false);
  const editingCell = ref(null);
  const editDraft = ref("");
  const textDraft = ref("");
  const insertDrafts = reactive({});

  const activeColumns = computed(() => activeTab.value?.columns || []);

  // ── Insert-draft helpers ──────────────────────────────────────────────

  function getInsertDraft(tab) {
    if (!tab?.id) return {};
    if (!insertDrafts[tab.id]) insertDrafts[tab.id] = {};
    return insertDrafts[tab.id];
  }

  function updateInsertDraft(tab, column, value) {
    if (!tab?.id || !column) return;
    getInsertDraft(tab)[column] = String(value ?? "");
  }

  function clearInsertDraft(tab) {
    if (tab?.id) insertDrafts[tab.id] = {};
  }

  // ── Cell selection ────────────────────────────────────────────────────

  function cellPosition(tab, row, column, rowIndex, columnIndex) {
    return {
      rowIndex,
      columnIndex,
      rowKey: buildRowKey(tab, row),
      column,
    };
  }

  function collapseRangeToCell(tab, row, column, rowIndex, columnIndex) {
    const colNames = activeColumns.value.map(columnName);
    const resolvedRowIndex = rowIndex ?? tab.rows.findIndex((candidate) => buildRowKey(tab, candidate) === buildRowKey(tab, row));
    const resolvedColumnIndex = columnIndex ?? colNames.indexOf(column);
    const position = cellPosition(tab, row, column, resolvedRowIndex, resolvedColumnIndex);
    selectedRange.value = { tabId: tab.id, anchor: position, focus: position };
  }

  function getRangeBounds(range) {
    if (!range) return null;
    return {
      top: Math.min(range.anchor.rowIndex, range.focus.rowIndex),
      bottom: Math.max(range.anchor.rowIndex, range.focus.rowIndex),
      left: Math.min(range.anchor.columnIndex, range.focus.columnIndex),
      right: Math.max(range.anchor.columnIndex, range.focus.columnIndex),
    };
  }

  function isCellInSelectedRange(tab, rowKey, column, rowIndex, columnIndex) {
    const range = selectedRange.value;
    if (!tab || !range || range.tabId !== tab.id) return false;
    const bounds = getRangeBounds(range);
    return rowIndex >= bounds.top && rowIndex <= bounds.bottom && columnIndex >= bounds.left && columnIndex <= bounds.right;
  }

  function getCellRangeClasses(tab, rowKey, column, rowIndex, columnIndex) {
    const inRange = isCellInSelectedRange(tab, rowKey, column, rowIndex, columnIndex);
    const bounds = getRangeBounds(selectedRange.value);
    const isAnchor =
      inRange &&
      selectedRange.value?.anchor.rowKey === rowKey &&
      selectedRange.value?.anchor.column === column;
    return {
      "range-selected": inRange,
      "range-top": inRange && rowIndex === bounds.top,
      "range-bottom": inRange && rowIndex === bounds.bottom,
      "range-left": inRange && columnIndex === bounds.left,
      "range-right": inRange && columnIndex === bounds.right,
      "range-anchor": isAnchor,
    };
  }

  function setSelectedCellFromPosition(tab, row, position) {
    selectedCell.value = { tabId: tab.id, rowKey: position.rowKey, column: position.column };
    textDraft.value = displayCellValue(editState, tab, row, position.column, position.rowKey);
  }

  function focusTextCell(tab, row, column) {
    saveTextPanel();
    const rowKey = buildRowKey(tab, row);
    editState.cellErrors.delete([tab.tableName, rowKey, column].map((v) => String(v ?? "")).join(""));
    selectedCell.value = { tabId: tab.id, rowKey, column };
    textDraft.value = displayCellValue(editState, tab, row, column);
    try {
      const parsed = JSON.parse(textDraft.value);
      if (typeof parsed === "object") textDraft.value = JSON.stringify(parsed, null, 2);
    } catch {}
  }

  function selectCell(tab, row, column, rowIndex, columnIndex) {
    if (isSelectingRange.value) return;
    if (editingCell.value) finishEditing();
    collapseRangeToCell(tab, row, column, rowIndex, columnIndex);
    setSelectedCellFromPosition(tab, row, selectedRange.value.anchor);
    nextTick(() => gridWrapRef.value?.focus());
  }

  function startRangeSelection(tab, row, column, rowIndex, columnIndex, event) {
    if (event?.button != null && event.button !== 0) return;
    event?.preventDefault?.();
    if (editingCell.value) finishEditing();
    const position = cellPosition(tab, row, column, rowIndex, columnIndex);
    selectedRange.value = { tabId: tab.id, anchor: position, focus: position };
    isSelectingRange.value = true;
    setSelectedCellFromPosition(tab, row, position);
    nextTick(() => gridWrapRef.value?.focus());
  }

  function extendRangeSelection(tab, row, column, rowIndex, columnIndex) {
    const range = selectedRange.value;
    if (!isSelectingRange.value || !range || range.tabId !== tab.id) return;
    const position = cellPosition(tab, row, column, rowIndex, columnIndex);
    selectedRange.value = { ...range, focus: position };
    setSelectedCellFromPosition(tab, row, position);
  }

  function finishRangeSelection() {
    isSelectingRange.value = false;
  }

  // ── Inline editing ────────────────────────────────────────────────────

  function focusEditingInputAtEnd() {
    nextTick(() => {
      const input = gridWrapRef.value?.querySelector("td.editing input");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  }

  function startEditing(tab, row, column, rowIndex, columnIndex) {
    const rowKey = buildRowKey(tab, row);
    selectedCell.value = { tabId: tab.id, rowKey, column };
    collapseRangeToCell(tab, row, column, rowIndex, columnIndex);
    editingCell.value = { tabId: tab.id, rowKey, column };
    editDraft.value = displayCellValue(editState, tab, row, column, rowKey);
    textDraft.value = editDraft.value;
    focusEditingInputAtEnd();
  }

  function finishEditing() {
    if (!editingCell.value) return;
    const tab = activeTab.value;
    if (!tab) { editingCell.value = null; return; }
    const { rowKey, column } = editingCell.value;
    const draft = editDraft.value;
    editingCell.value = null;
    const row = findRowByKey(tab, rowKey);
    if (row) {
      const current = displayCellValue(editState, tab, row, column, rowKey);
      if (draft !== current) commitCellValue(tab, row, column, draft);
    }
    nextTick(() => gridWrapRef.value?.focus());
  }

  function cancelEditing() {
    editingCell.value = null;
    nextTick(() => gridWrapRef.value?.focus());
  }

  // ── Keyboard navigation ───────────────────────────────────────────────

  function navigateCell(deltaRow, deltaCol) {
    const tab = activeTab.value;
    const cell = selectedCell.value;
    if (!tab || !cell || cell.tabId !== tab.id) return;
    const allRowKeys = tab.rows.map((r) => buildRowKey(tab, r));
    const currentRowIndex = allRowKeys.indexOf(cell.rowKey);
    if (currentRowIndex < 0) return;
    const colNames = activeColumns.value.map(columnName);
    const currentColIndex = colNames.indexOf(cell.column);
    if (currentColIndex < 0) return;
    let newRow = currentRowIndex + deltaRow;
    let newCol = currentColIndex + deltaCol;
    if (newCol < 0) { newCol = colNames.length - 1; newRow--; }
    if (newCol >= colNames.length) { newCol = 0; newRow++; }
    newRow = Math.max(0, Math.min(allRowKeys.length - 1, newRow));
    newCol = Math.max(0, Math.min(colNames.length - 1, newCol));
    const newColumn = colNames[newCol];
    const row = tab.rows[newRow];
    const newRowKey = allRowKeys[newRow];
    selectedCell.value = { tabId: tab.id, rowKey: newRowKey, column: newColumn };
    selectedRange.value = { tabId: tab.id, anchor: { rowIndex: newRow, columnIndex: newCol, rowKey: newRowKey, column: newColumn }, focus: { rowIndex: newRow, columnIndex: newCol, rowKey: newRowKey, column: newColumn } };
    textDraft.value = displayCellValue(editState, tab, row, newColumn, newRowKey);
    scrollRowIntoView(newRow);
  }

  // ── Cell commits ──────────────────────────────────────────────────────

  async function commitCellValue(tab, row, column, nextValue) {
    const oldValue = String(row?.[column] ?? "");
    const value = String(nextValue ?? "");
    if (!tab || oldValue === value) return;
    const rowKey = buildRowKey(tab, row);
    const key = startCellCommit(editState, {
      tableName: tab.tableName,
      rowKey,
      columnName: column,
      oldValue,
      newValue: value,
    });
    row[column] = value;
    try {
      const result = await invokeWorkbench("update_cell", {
        request: {
          sessionId: tab.sessionId,
          rowIdentity: buildRowIdentity(tab, { ...row, [column]: oldValue }),
          columnName: column,
          oldValue,
          newValue: value,
        },
      });
      if (result?.conflict) throw new Error("数据已被别人修改，请刷新后再试");
      finishCellCommit(editState, key);
      statusText.value = `已保存 ${tab.tableName}.${column}`;
    } catch (error) {
      row[column] = oldValue;
      failCellCommit(editState, key, String(error));
      statusText.value = `保存失败：${String(error)}`;
    }
  }

  async function saveTextPanel() {
    const tab = activeTab.value;
    const cell = selectedCell.value;
    if (!tab || !cell || cell.tabId !== tab.id) return;
    const row = findRowByKey(tab, cell.rowKey);
    if (!row) return;
    if (editingCell.value) {
      editDraft.value = textDraft.value;
      finishEditing();
    } else {
      await commitCellValue(tab, row, cell.column, textDraft.value);
    }
  }

  async function commitInsertRow(tab) {
    if (!tab?.sessionId) return;
    const draft = { ...getInsertDraft(tab) };
    const cleaned = Object.fromEntries(
      Object.entries(draft).filter(([, value]) => String(value ?? "").trim() !== ""),
    );
    if (Object.keys(cleaned).length === 0) return;
    try {
      await invokeWorkbench("insert_row", {
        request: {
          sessionId: tab.sessionId,
          draft: cleaned,
        },
      });
      clearInsertDraft(tab);
      // NOTE: the caller should re-fetch the page after insert.
      await nextTick();
      statusText.value = "已插入 1 行";
    } catch (error) {
      statusText.value = `插入失败：${String(error)}`;
    }
  }

  function setCellToNull() {
    const tab = activeTab.value;
    const cell = selectedCell.value;
    if (!tab || !cell || cell.tabId !== tab.id) return;
    const row = findRowByKey(tab, cell.rowKey);
    if (row) {
      commitCellValue(tab, row, cell.column, null);
    }
  }

  // ── Grid keyboard handler ─────────────────────────────────────────────

  async function handleGridKeydown(event) {
    const tab = activeTab.value;
    if (!tab) return;

    // Clipboard shortcuts
    const isCopy = (event.ctrlKey || event.metaKey) && event.key === "c";
    const isPaste = (event.ctrlKey || event.metaKey) && event.key === "v";

    if (isCopy) {
      event.preventDefault();
      if (tab.selectedRowKeys.size > 0) {
        const selectedRows = tab.rows.filter((r) => tab.selectedRowKeys.has(buildRowKey(tab, r)));
        if (selectedRows.length > 0) {
          const header = activeColumns.value.map((c) => columnName(c)).join("\t");
          const body = selectedRows
            .map((row) => activeColumns.value.map((c) => displayCellValue(editState, tab, row, columnName(c))).join("\t"))
            .join("\n");
          await navigator.clipboard.writeText(header + "\n" + body);
          statusText.value = `已复制 ${selectedRows.length} 行`;
        }
      } else if (selectedCell.value) {
        const row = findRowByKey(tab, selectedCell.value.rowKey);
        if (row) {
          const value = displayCellValue(editState, tab, row, selectedCell.value.column);
          await navigator.clipboard.writeText(value);
          statusText.value = "已复制";
        }
      }
      return;
    }

    if (isPaste) {
      event.preventDefault();
      const cell = selectedCell.value;
      if (!cell || cell.tabId !== tab.id) return;
      try {
        const text = await navigator.clipboard.readText();
        const row = findRowByKey(tab, cell.rowKey);
        if (row && text != null) {
          const singleValue = text.includes("\n") || text.includes("\t") ? null : text;
          if (singleValue != null) {
            commitCellValue(tab, row, cell.column, singleValue);
          }
        }
      } catch {
        // clipboard read not available
      }
      return;
    }

    // Arrow key navigation
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      if (editingCell.value) finishEditing();
      const dirs = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      navigateCell(...dirs[event.key]);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      if (editingCell.value) finishEditing();
      navigateCell(0, event.shiftKey ? -1 : 1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (editingCell.value) {
        finishEditing();
        navigateCell(1, 0);
      } else if (selectedCell.value) {
        const row = findRowByKey(tab, selectedCell.value.rowKey);
        if (row) startEditing(tab, row, selectedCell.value.column);
      }
      return;
    }

    if (event.key === "Escape") {
      if (editingCell.value) cancelEditing();
      return;
    }

    if (event.key === "F2") {
      event.preventDefault();
      if (editingCell.value) {
        focusEditingInputAtEnd();
      } else if (selectedCell.value) {
        const row = findRowByKey(tab, selectedCell.value.rowKey);
        if (row) startEditing(tab, row, selectedCell.value.column);
      }
      return;
    }

    // Typing a printable character starts editing
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (selectedCell.value && !editingCell.value) {
        const row = findRowByKey(tab, selectedCell.value.rowKey);
        if (row) {
          editingCell.value = { ...selectedCell.value };
          editDraft.value = event.key;
          textDraft.value = event.key;
          nextTick(() => {
            const input = gridWrapRef.value?.querySelector("td.editing input");
            if (input) input.focus();
          });
        }
      }
      return;
    }
  }

  // ── Undo handler (Ctrl/Cmd+Z) ─────────────────────────────────────────

  async function handleUndoKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.key !== "z") return;
    event.preventDefault();
    const entry = popUndo(editState);
    if (!entry) {
      statusText.value = "无可撤销操作";
      return;
    }
    const tab = activeTab.value;
    if (!tab || tab.tableName !== entry.tableName) {
      editState.undoStack.push(entry);
      statusText.value = "无可撤销操作（当前表不匹配）";
      return;
    }
    const row = tab.rows.find((r) => buildRowKey(tab, r) === entry.rowKey);
    if (!row) {
      editState.undoStack.push(entry);
      statusText.value = "无可撤销操作（行不存在）";
      return;
    }
    try {
      await invokeWorkbench("update_cell", {
        request: {
          sessionId: tab.sessionId,
          rowIdentity: buildRowIdentity(tab, { ...row, [entry.columnName]: row[entry.columnName] }),
          columnName: entry.columnName,
          oldValue: row[entry.columnName] ?? "",
          newValue: entry.oldValue ?? "",
        },
      });
      row[entry.columnName] = entry.oldValue;
      statusText.value = "已撤销";
    } catch (error) {
      editState.undoStack.push(entry);
      statusText.value = `撤销失败：${String(error)}`;
    }
  }

  return {
    // state
    selectedCell,
    selectedRange,
    isSelectingRange,
    editingCell,
    editDraft,
    textDraft,
    insertDrafts,
    activeColumns,
    // insert draft helpers
    getInsertDraft,
    updateInsertDraft,
    clearInsertDraft,
    // cell selection
    focusTextCell,
    selectCell,
    startRangeSelection,
    extendRangeSelection,
    finishRangeSelection,
    isCellInSelectedRange,
    getCellRangeClasses,
    // inline editing
    startEditing,
    finishEditing,
    cancelEditing,
    // navigation
    navigateCell,
    // commits
    commitCellValue,
    saveTextPanel,
    commitInsertRow,
    setCellToNull,
    // keyboard
    handleGridKeydown,
    handleUndoKeydown,
  };
}
