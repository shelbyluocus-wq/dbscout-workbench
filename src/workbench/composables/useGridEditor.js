import { computed, nextTick, reactive, ref } from "vue";
import { GRID_ROW_HEIGHT } from "../constants.js";
import { columnName } from "../utils/normalize.js";

const GRID_HEADER_HEIGHT = 28;
const ROW_INDEX_WIDTH = 38;
const RANGE_AUTOSCROLL_EDGE = 28;
const RANGE_AUTOSCROLL_MAX_STEP = 18;
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
 * @param {{ scrollRowIntoView: Function, scrollCellIntoView?: Function }} virtualGrid – from useVirtualGrid
 * @param {{ busy: import('vue').Ref<boolean>, statusText: import('vue').Ref<string> }} appState
 */
export function useGridEditor(
  editState,
  invokeWorkbench,
  activeTab,
  gridWrapRef,
  { scrollRowIntoView, scrollCellIntoView = scrollRowIntoView, scrollInsertCellIntoView = () => {} },
  { busy, statusText },
) {
  // ── Selection & editing state ─────────────────────────────────────────
  const selectedCell = ref(null);
  const selectedRange = ref(null);
  const selectedInsertCell = ref(null);
  const isSelectingRange = ref(false);
  const editingCell = ref(null);
  const editDraft = ref("");
  const textDraft = ref("");
  const insertDrafts = reactive({});

  const activeColumns = computed(() => activeTab.value?.columns || []);
  let lastRangePointerEvent = null;
  let rangeAutoscrollFrame = 0;

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

  function positionFromIndexes(tab, rowIndex, columnIndex) {
    const row = tab?.rows?.[rowIndex];
    const column = activeColumns.value[columnIndex];
    const name = columnName(column);
    if (!row || !name) return null;
    return { row, position: cellPosition(tab, row, name, rowIndex, columnIndex) };
  }

  function updateRangeFocus(tab, rowIndex, columnIndex) {
    const range = selectedRange.value;
    if (!range || !tab || range.tabId !== tab.id) return;
    const resolved = positionFromIndexes(tab, rowIndex, columnIndex);
    if (!resolved) return;
    selectedRange.value = { ...range, focus: resolved.position };
    setSelectedCellFromPosition(tab, resolved.row, resolved.position);
  }

  function columnIndexFromPointer(wrap, clientX) {
    const cells = [...wrap.querySelectorAll("th[data-column-index], td[data-column-index]")];
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const cell of cells) {
      const index = Number(cell.dataset.columnIndex);
      if (!Number.isFinite(index)) continue;
      const rect = cell.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) return index;
      const distance = clientX < rect.left ? rect.left - clientX : clientX - rect.right;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    if (cells.length === 0) {
      const fallback = Math.floor((clientX - wrap.getBoundingClientRect().left - ROW_INDEX_WIDTH + wrap.scrollLeft) / 126);
      nearestIndex = fallback;
    }
    return Math.max(0, Math.min(activeColumns.value.length - 1, nearestIndex));
  }

  function rowIndexFromPointer(wrap, clientY, tab) {
    const rect = wrap.getBoundingClientRect();
    const y = clientY - rect.top + wrap.scrollTop - GRID_HEADER_HEIGHT;
    return Math.max(0, Math.min(tab.rows.length - 1, Math.floor(y / GRID_ROW_HEIGHT)));
  }

  function updateRangeFocusFromPointer(event) {
    const tab = activeTab.value;
    const wrap = gridWrapRef.value;
    const range = selectedRange.value;
    if (!tab || !wrap || !range || range.tabId !== tab.id || tab.rows.length === 0 || activeColumns.value.length === 0) return;
    const rowIndex = rowIndexFromPointer(wrap, event.clientY, tab);
    const columnIndex = columnIndexFromPointer(wrap, event.clientX);
    updateRangeFocus(tab, rowIndex, columnIndex);
  }

  function autoscrollStep(distance) {
    if (distance <= 0) return 0;
    return Math.min(RANGE_AUTOSCROLL_MAX_STEP, Math.ceil(distance / 3));
  }

  function stopRangeAutoscroll() {
    if (rangeAutoscrollFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rangeAutoscrollFrame);
    rangeAutoscrollFrame = 0;
  }

  function runRangeAutoscroll() {
    rangeAutoscrollFrame = 0;
    if (!isSelectingRange.value || !lastRangePointerEvent) return;
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const event = lastRangePointerEvent;
    let nextTop = wrap.scrollTop;
    let nextLeft = wrap.scrollLeft;
    if (event.clientY < rect.top + RANGE_AUTOSCROLL_EDGE) nextTop -= autoscrollStep(rect.top + RANGE_AUTOSCROLL_EDGE - event.clientY);
    else if (event.clientY > rect.bottom - RANGE_AUTOSCROLL_EDGE) nextTop += autoscrollStep(event.clientY - (rect.bottom - RANGE_AUTOSCROLL_EDGE));
    if (event.clientX < rect.left + ROW_INDEX_WIDTH + RANGE_AUTOSCROLL_EDGE) nextLeft -= autoscrollStep(rect.left + ROW_INDEX_WIDTH + RANGE_AUTOSCROLL_EDGE - event.clientX);
    else if (event.clientX > rect.right - RANGE_AUTOSCROLL_EDGE) nextLeft += autoscrollStep(event.clientX - (rect.right - RANGE_AUTOSCROLL_EDGE));
    wrap.scrollTop = Math.max(0, nextTop);
    wrap.scrollLeft = Math.max(0, nextLeft);
    updateRangeFocusFromPointer(event);
    rangeAutoscrollFrame = requestAnimationFrame(runRangeAutoscroll);
  }

  function startRangeAutoscroll(event) {
    lastRangePointerEvent = event;
    if (!rangeAutoscrollFrame && typeof requestAnimationFrame === "function") rangeAutoscrollFrame = requestAnimationFrame(runRangeAutoscroll);
  }

  function clearSelection() {
    selectedCell.value = null;
    selectedRange.value = null;
    selectedInsertCell.value = null;
    isSelectingRange.value = false;
    editingCell.value = null;
    editDraft.value = "";
    textDraft.value = "";
    lastRangePointerEvent = null;
    stopRangeAutoscroll();
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
    selectedInsertCell.value = null;
    collapseRangeToCell(tab, row, column, rowIndex, columnIndex);
    setSelectedCellFromPosition(tab, row, selectedRange.value.anchor);
    nextTick(() => gridWrapRef.value?.focus());
  }

  function startRangeSelection(tab, row, column, rowIndex, columnIndex, event) {
    if (event?.button != null && event.button !== 0) return;
    event?.preventDefault?.();
    if (editingCell.value) finishEditing();
    selectedInsertCell.value = null;
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

  function extendRangeSelectionFromPointer(event) {
    if (!isSelectingRange.value) return;
    lastRangePointerEvent = event;
    updateRangeFocusFromPointer(event);
    startRangeAutoscroll(event);
  }

  function finishRangeSelection() {
    isSelectingRange.value = false;
    lastRangePointerEvent = null;
    stopRangeAutoscroll();
  }

  function isMultiCellRange(range) {
    return range && (range.anchor.rowIndex !== range.focus.rowIndex || range.anchor.columnIndex !== range.focus.columnIndex);
  }

  function getSelectedRangeMatrix(tab) {
    const range = selectedRange.value;
    if (!tab || !range || range.tabId !== tab.id) return null;
    const bounds = getRangeBounds(range);
    const colNames = activeColumns.value.map(columnName);
    const rows = [];
    for (let rowIndex = bounds.top; rowIndex <= bounds.bottom; rowIndex++) {
      const row = tab.rows[rowIndex];
      if (!row) continue;
      rows.push(
        colNames
          .slice(bounds.left, bounds.right + 1)
          .map((col) => displayCellValue(editState, tab, row, col))
      );
    }
    return rows;
  }

  function rangeStartPosition(tab) {
    const range = selectedRange.value;
    if (range?.tabId === tab?.id) return range.anchor;
    return currentCellPosition(tab);
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

  function focusInsertInput(columnIndex) {
    nextTick(() => {
      const input = gridWrapRef.value?.querySelector(`input[data-insert-column-index="${columnIndex}"]`);
      input?.focus();
    });
  }

  function selectInsertCell(tab, columnIndex) {
    if (!tab || activeColumns.value.length === 0) return;
    const clampedColumnIndex = Math.max(0, Math.min(activeColumns.value.length - 1, columnIndex));
    const column = columnName(activeColumns.value[clampedColumnIndex]);
    if (editingCell.value) finishEditing();
    selectedCell.value = null;
    selectedRange.value = null;
    selectedInsertCell.value = { tabId: tab.id, columnIndex: clampedColumnIndex, column };
    scrollInsertCellIntoView(clampedColumnIndex);
    focusInsertInput(clampedColumnIndex);
  }

  function leaveInsertCell() {
    selectedInsertCell.value = null;
    nextTick(() => gridWrapRef.value?.focus());
  }

  function handleInsertKeydown(tab, columnIndex, event) {
    if (!tab || activeColumns.value.length === 0) return;
    const maxColumnIndex = activeColumns.value.length - 1;
    if (event?.key === "ArrowUp") {
      selectedInsertCell.value = null;
      const rowIndex = Math.max(0, tab.rows.length - 1);
      const position = positionFromIndexes(tab, rowIndex, Math.max(0, Math.min(maxColumnIndex, columnIndex)))?.position;
      if (position) applySelectedPosition(tab, position);
      nextTick(() => gridWrapRef.value?.focus());
      return;
    }
    if (event?.key === "ArrowLeft") {
      selectInsertCell(tab, Math.max(0, columnIndex - 1));
      return;
    }
    if (event?.key === "ArrowRight") {
      selectInsertCell(tab, Math.min(maxColumnIndex, columnIndex + 1));
      return;
    }
    if (event?.key === "Tab") {
      selectInsertCell(tab, Math.max(0, Math.min(maxColumnIndex, columnIndex + (event.shiftKey ? -1 : 1))));
      return;
    }
    if (event?.key === "Escape") {
      leaveInsertCell();
    }
  }

  function currentCellPosition(tab) {
    const cell = selectedCell.value;
    if (!tab || !cell || cell.tabId !== tab.id) return null;
    const allRowKeys = tab.rows.map((r) => buildRowKey(tab, r));
    const rowIndex = allRowKeys.indexOf(cell.rowKey);
    const colNames = activeColumns.value.map(columnName);
    const columnIndex = colNames.indexOf(cell.column);
    if (rowIndex < 0 || columnIndex < 0) return null;
    return { rowIndex, columnIndex, rowKey: allRowKeys[rowIndex], column: colNames[columnIndex] };
  }

  function nextCellPosition(tab, deltaRow, deltaCol) {
    const current = currentCellPosition(tab);
    if (!current) return null;
    const colNames = activeColumns.value.map(columnName);
    let rowIndex = current.rowIndex + deltaRow;
    let columnIndex = current.columnIndex + deltaCol;
    if (columnIndex < 0) { columnIndex = colNames.length - 1; rowIndex--; }
    if (columnIndex >= colNames.length) { columnIndex = 0; rowIndex++; }
    rowIndex = Math.max(0, Math.min(tab.rows.length - 1, rowIndex));
    columnIndex = Math.max(0, Math.min(colNames.length - 1, columnIndex));
    return positionFromIndexes(tab, rowIndex, columnIndex)?.position || null;
  }

  function applySelectedPosition(tab, position, { extendRange = false } = {}) {
    const row = tab.rows[position.rowIndex];
    if (extendRange && selectedRange.value?.tabId === tab.id) {
      selectedRange.value = { ...selectedRange.value, focus: position };
    } else {
      selectedRange.value = { tabId: tab.id, anchor: position, focus: position };
    }
    setSelectedCellFromPosition(tab, row, position);
    scrollCellIntoView(position.rowIndex, position.columnIndex);
  }

  function navigateCell(deltaRow, deltaCol, options = {}) {
    const tab = activeTab.value;
    if (!tab?.rows?.length || activeColumns.value.length === 0) return;
    const current = currentCellPosition(tab);
    if (!options.extendRange && deltaRow > 0 && deltaCol === 0 && current?.rowIndex === tab.rows.length - 1) {
      selectInsertCell(tab, current.columnIndex);
      return;
    }
    const position = nextCellPosition(tab, deltaRow, deltaCol);
    if (!position) return;
    selectedInsertCell.value = null;
    applySelectedPosition(tab, position, options);
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
    if (!tab?.sessionId) return false;
    const draft = { ...getInsertDraft(tab) };
    const cleaned = Object.fromEntries(
      Object.entries(draft).filter(([, value]) => String(value ?? "").trim() !== ""),
    );
    if (Object.keys(cleaned).length === 0) return false;
    try {
      await invokeWorkbench("insert_row", {
        request: {
          sessionId: tab.sessionId,
          draft: cleaned,
        },
      });
      clearInsertDraft(tab);
      await nextTick();
      statusText.value = "已插入 1 行";
      return true;
    } catch (error) {
      statusText.value = `插入失败：${String(error)}`;
      return false;
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
    const key = String(event.key || "").toLowerCase();
    const isCopy = (event.ctrlKey || event.metaKey) && key === "c";
    const isPaste = (event.ctrlKey || event.metaKey) && key === "v";

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
      } else if (isMultiCellRange(selectedRange.value)) {
        const matrix = getSelectedRangeMatrix(tab);
        if (matrix?.length) {
          await navigator.clipboard.writeText(matrix.map((row) => row.join("\t")).join("\n"));
          statusText.value = `已复制 ${matrix.length}×${matrix[0]?.length || 0} 区域`;
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
      const start = rangeStartPosition(tab);
      if (!start) return;
      try {
        const text = await navigator.clipboard.readText();
        if (text == null) return;
        const matrix = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((line) => line.split("\t"));
        let committed = 0;
        let skipped = 0;
        for (let rowOffset = 0; rowOffset < matrix.length; rowOffset++) {
          for (let colOffset = 0; colOffset < matrix[rowOffset].length; colOffset++) {
            const rowIndex = start.rowIndex + rowOffset;
            const columnIndex = start.columnIndex + colOffset;
            const row = tab.rows[rowIndex];
            const column = activeColumns.value[columnIndex];
            if (!row || !column) {
              skipped++;
              continue;
            }
            await commitCellValue(tab, row, columnName(column), matrix[rowOffset][colOffset]);
            committed++;
          }
        }
        statusText.value = skipped > 0 ? `已粘贴 ${committed} 个单元格，${skipped} 个超出当前页面` : `已粘贴 ${committed} 个单元格`;
      } catch {
        statusText.value = "读取剪贴板失败";
      }
      return;
    }

    // Arrow key navigation
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      if (editingCell.value) finishEditing();
      const dirs = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      navigateCell(...dirs[event.key], { extendRange: event.shiftKey });
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
    selectedInsertCell,
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
    clearSelection,
    focusTextCell,
    selectCell,
    startRangeSelection,
    extendRangeSelection,
    extendRangeSelectionFromPointer,
    finishRangeSelection,
    isCellInSelectedRange,
    getCellRangeClasses,
    // inline editing
    startEditing,
    finishEditing,
    cancelEditing,
    // navigation
    navigateCell,
    selectInsertCell,
    handleInsertKeydown,
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
