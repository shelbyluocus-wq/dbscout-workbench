import { computed, nextTick, reactive, ref } from "vue";
import { GRID_ROW_HEIGHT } from "../constants.js";
import { columnName } from "../utils/normalize.js";
import {
  validateBatchEdits,
  validateCellValue,
  validateRowDraft,
} from "../utils/valueValidation.js";

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
  clearCellError,
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
  { busy, statusText, onSaveFeedback = () => {}, onCellCommitted = () => {} },
) {
  // ── Selection & editing state ─────────────────────────────────────────
  const selectedCell = ref(null);
  const selectedRange = ref(null);
  const selectedInsertCell = ref(null);
  const selectedInsertRow = ref(null);
  const isSelectingRange = ref(false);
  const editingCell = ref(null);
  const editDraft = ref("");
  const textDraft = ref("");
  const insertDrafts = reactive({});
  const visibleInsertRows = reactive({});

  const activeColumns = computed(() => activeTab.value?.columns || []);
  let lastRangePointerEvent = null;
  let rangeAutoscrollFrame = 0;
  let nextInsertRowId = 1;

  function tabScopeKey(tab) {
    return tab?.tableKey || tab?.tableName || "";
  }

  function tabDisplayName(tab) {
    return tab?.database ? `${tab.database}.${tab.tableName}` : tab?.tableName || "";
  }

  // ── Insert-draft helpers ──────────────────────────────────────────────

  function createInsertRow() {
    return { id: `insert-${nextInsertRowId++}`, draft: {} };
  }

  function getInsertRows(tab) {
    if (!tab?.id) return [];
    if (!Array.isArray(insertDrafts[tab.id])) insertDrafts[tab.id] = [];
    return insertDrafts[tab.id];
  }

  function ensureInsertRow(tab, rowId) {
    const rows = getInsertRows(tab);
    if (rowId) {
      const existing = rows.find((row) => row.id === rowId);
      if (existing) return existing;
    }
    if (rows.length === 0) rows.push(createInsertRow());
    return rowId ? rows.find((row) => row.id === rowId) || rows[0] : rows[0];
  }

  function hasDraftValues(row) {
    return Object.values(row?.draft || {}).some((value) => String(value ?? "").trim() !== "");
  }

  function hasInsertDrafts(tab) {
    return getInsertRows(tab).some(hasDraftValues);
  }

  function ensureTrailingInsertRow(tab) {
    const rows = getInsertRows(tab);
    if (rows.length === 0 || hasDraftValues(rows.at(-1))) rows.push(createInsertRow());
  }

  function getInsertDraft(tab, rowId) {
    if (!tab?.id) return {};
    return ensureInsertRow(tab, rowId).draft;
  }

  function updateInsertDraft(tab, rowIdOrColumn, columnOrValue, maybeValue) {
    if (!tab?.id) return;
    const rowAware = arguments.length >= 4;
    const rowId = rowAware ? rowIdOrColumn : undefined;
    const column = rowAware ? columnOrValue : rowIdOrColumn;
    const value = rowAware ? maybeValue : columnOrValue;
    if (!column) return;
    const row = ensureInsertRow(tab, rowId);
    row.draft[column] = String(value ?? "");
    selectedInsertCell.value = { tabId: tab.id, rowId: row.id, columnIndex: activeColumnNames().indexOf(column), column };
    ensureTrailingInsertRow(tab);
  }

  function clearInsertDraft(tab, rowId) {
    if (!tab?.id) return;
    if (!rowId) {
      insertDrafts[tab.id] = [];
      return;
    }
    const rows = getInsertRows(tab);
    const index = rows.findIndex((row) => row.id === rowId);
    if (index >= 0) rows.splice(index, 1);
  }

  function isInsertRowVisible(tab) {
    return Boolean(tab?.id && visibleInsertRows[tab.id]);
  }

  function showInsertRow(tab) {
    if (!tab?.id) return;
    visibleInsertRows[tab.id] = true;
    ensureTrailingInsertRow(tab);
  }

  function hideInsertRow(tab, { clearDraft = false } = {}) {
    if (!tab?.id) return;
    if (!clearDraft && hasInsertDrafts(tab)) {
      selectedInsertCell.value = null;
      selectedInsertRow.value = null;
      return;
    }
    visibleInsertRows[tab.id] = false;
    selectedInsertCell.value = null;
    selectedInsertRow.value = null;
    if (clearDraft) clearInsertDraft(tab);
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
    const tab = activeTab.value;
    selectedCell.value = null;
    selectedRange.value = null;
    selectedInsertCell.value = null;
    selectedInsertRow.value = null;
    if (tab) hideInsertRow(tab);
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
    clearCellError(editState, tabScopeKey(tab), rowKey, column);
    selectedCell.value = { tabId: tab.id, rowKey, column };
    textDraft.value = displayCellValue(editState, tab, row, column);
    try {
      const parsed = JSON.parse(textDraft.value);
      if (typeof parsed === "object") textDraft.value = JSON.stringify(parsed, null, 2);
    } catch {}
  }

  function selectCell(tab, row, column, rowIndex, columnIndex, { focusGrid = true } = {}) {
    if (isSelectingRange.value) return;
    if (editingCell.value) finishEditing();
    hideInsertRow(tab);
    collapseRangeToCell(tab, row, column, rowIndex, columnIndex);
    setSelectedCellFromPosition(tab, row, selectedRange.value.anchor);
    if (focusGrid) nextTick(() => gridWrapRef.value?.focus());
  }

  function startRangeSelection(tab, row, column, rowIndex, columnIndex, event) {
    if (event?.button != null && event.button !== 0) return;
    event?.preventDefault?.();
    if (editingCell.value) finishEditing();
    hideInsertRow(tab);
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

  function activeColumnNames() {
    return activeColumns.value.map(columnName);
  }

  function matrixToTsv(matrix) {
    return matrix.map((row) => row.map((value) => String(value ?? "")).join("\t")).join("\n");
  }

  function parseTsv(text) {
    const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
    return normalized.split("\n").map((line) => line.split("\t"));
  }

  function insertDraftRow(tab, rowId) {
    const draft = getInsertDraft(tab, rowId);
    return activeColumnNames().map((col) => draft[col] ?? "");
  }

  function getSelectedRangeMatrix(tab) {
    const range = selectedRange.value;
    if (!tab || !range || range.tabId !== tab.id) return null;
    const bounds = getRangeBounds(range);
    const colNames = activeColumnNames();
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
    clearCellError(editState, tabScopeKey(tab), rowKey, column);
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

  function focusInsertInput(rowId, columnIndex) {
    nextTick(() => {
      const input = gridWrapRef.value?.querySelector(`input[data-insert-row-id="${rowId}"][data-insert-column-index="${columnIndex}"]`)
        || gridWrapRef.value?.querySelector(`input[data-insert-column-index="${columnIndex}"]`);
      input?.focus();
    });
  }

  function selectInsertCell(tab, rowIdOrColumnIndex, maybeColumnIndex) {
    if (!tab || activeColumns.value.length === 0) return;
    const rowAware = maybeColumnIndex != null;
    const row = rowAware ? ensureInsertRow(tab, rowIdOrColumnIndex) : ensureInsertRow(tab);
    const columnIndex = rowAware ? maybeColumnIndex : rowIdOrColumnIndex;
    const clampedColumnIndex = Math.max(0, Math.min(activeColumns.value.length - 1, columnIndex));
    const column = columnName(activeColumns.value[clampedColumnIndex]);
    if (editingCell.value) finishEditing();
    showInsertRow(tab);
    selectedCell.value = null;
    selectedRange.value = null;
    selectedInsertRow.value = null;
    selectedInsertCell.value = { tabId: tab.id, rowId: row.id, columnIndex: clampedColumnIndex, column };
    scrollInsertCellIntoView(clampedColumnIndex);
    focusInsertInput(row.id, clampedColumnIndex);
  }

  function selectInsertRow(tab, rowId) {
    if (!tab) return;
    const row = ensureInsertRow(tab, rowId);
    if (editingCell.value) finishEditing();
    showInsertRow(tab);
    selectedCell.value = null;
    selectedRange.value = null;
    selectedInsertCell.value = null;
    selectedInsertRow.value = { tabId: tab.id, rowId: row.id };
    isSelectingRange.value = false;
    lastRangePointerEvent = null;
    stopRangeAutoscroll();
    nextTick(() => gridWrapRef.value?.focus());
  }

  function leaveInsertCell(tab, options) {
    hideInsertRow(tab, options);
    nextTick(() => gridWrapRef.value?.focus());
  }

  function handleInsertKeydown(tab, rowIdOrColumnIndex, columnIndexOrEvent, maybeEvent) {
    if (!tab || activeColumns.value.length === 0) return;
    const rowAware = maybeEvent != null;
    const row = rowAware ? ensureInsertRow(tab, rowIdOrColumnIndex) : ensureInsertRow(tab);
    const columnIndex = rowAware ? columnIndexOrEvent : rowIdOrColumnIndex;
    const event = rowAware ? maybeEvent : columnIndexOrEvent;
    const rows = getInsertRows(tab);
    const rowIndex = rows.findIndex((candidate) => candidate.id === row.id);
    const maxColumnIndex = activeColumns.value.length - 1;
    if (event?.key === "ArrowUp") {
      if (rowIndex > 0) {
        selectInsertCell(tab, rows[rowIndex - 1].id, columnIndex);
        return;
      }
      selectedInsertCell.value = null;
      selectedInsertRow.value = null;
      const dataRowIndex = Math.max(0, tab.rows.length - 1);
      const position = positionFromIndexes(tab, dataRowIndex, Math.max(0, Math.min(maxColumnIndex, columnIndex)))?.position;
      if (position) applySelectedPosition(tab, position);
      nextTick(() => gridWrapRef.value?.focus());
      return;
    }
    if (event?.key === "ArrowDown") {
      const insertRows = getInsertRows(tab);
      let nextRow = insertRows[rowIndex + 1];
      if (!nextRow) {
        nextRow = createInsertRow();
        insertRows.push(nextRow);
      }
      if (nextRow) selectInsertCell(tab, nextRow.id, columnIndex);
      return;
    }
    if (event?.key === "ArrowLeft") {
      selectInsertCell(tab, row.id, Math.max(0, columnIndex - 1));
      return;
    }
    if (event?.key === "ArrowRight") {
      selectInsertCell(tab, row.id, Math.min(maxColumnIndex, columnIndex + 1));
      return;
    }
    if (event?.key === "Tab") {
      selectInsertCell(tab, row.id, Math.max(0, Math.min(maxColumnIndex, columnIndex + (event.shiftKey ? -1 : 1))));
      return;
    }
    if (event?.key === "Escape") {
      leaveInsertCell(tab, { clearDraft: true });
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

  function nextCellPosition(tab, deltaRow, deltaCol, { wrapColumns = false } = {}) {
    const current = currentCellPosition(tab);
    if (!current) return null;
    const colNames = activeColumns.value.map(columnName);
    let rowIndex = current.rowIndex + deltaRow;
    let columnIndex = current.columnIndex + deltaCol;
    if (wrapColumns) {
      if (columnIndex < 0) { columnIndex = colNames.length - 1; rowIndex--; }
      if (columnIndex >= colNames.length) { columnIndex = 0; rowIndex++; }
    }
    rowIndex = Math.max(0, Math.min(tab.rows.length - 1, rowIndex));
    columnIndex = Math.max(0, Math.min(colNames.length - 1, columnIndex));
    if (!wrapColumns && rowIndex === current.rowIndex && columnIndex === current.columnIndex) return null;
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
    const position = nextCellPosition(tab, deltaRow, deltaCol, options);
    if (!position) return;
    hideInsertRow(tab);
    applySelectedPosition(tab, position, options);
  }

  // ── Cell commits ──────────────────────────────────────────────────────

  function tableForValidation(tab) {
    return {
      table_name: tab?.tableName || "",
      columns: activeColumns.value,
      primaryKeys: primaryKeyColumns(tab),
    };
  }

  function firstValidationError(result) {
    return result?.errors?.[0] || null;
  }

  function cellErrorKey(tab, rowKey, column) {
    return [tabScopeKey(tab), rowKey, column].map((value) => String(value ?? "")).join("\x1f");
  }

  function setValidationFeedback(tab, rowKey, column, validationError) {
    const message = validationError?.message || "输入不符合字段约束";
    const shortMessage = validationError?.shortMessage || "格式错误";
    statusText.value = message;
    if (rowKey && column) {
      editState.cellErrors.set(cellErrorKey(tab, rowKey, column), message);
      onSaveFeedback({ kind: "error", tabId: tab.id, rowKey, column, message: shortMessage });
    }
  }

  async function commitCellValue(tab, row, column, nextValue) {
    const oldValue = String(row?.[column] ?? "");
    const value = String(nextValue ?? "");
    if (!tab || oldValue === value) return;
    const rowKey = buildRowKey(tab, row);
    const validation = validateCellValue({
      table: tableForValidation(tab),
      rows: tab.rows || [],
      row,
      columnName: column,
      value,
    });
    if (!validation.valid) {
      setValidationFeedback(tab, rowKey, column, firstValidationError(validation));
      return;
    }
    const key = startCellCommit(editState, {
      tableName: tabScopeKey(tab),
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
      statusText.value = `已保存 ${tabDisplayName(tab)}.${column}`;
      onSaveFeedback({ kind: "success", tabId: tab.id, rowKey, column, message: "已保存" });
      onCellCommitted({ tab, rowKey, column, oldValue, newValue: value });
    } catch (error) {
      row[column] = oldValue;
      failCellCommit(editState, key, String(error));
      statusText.value = `保存失败：${String(error)}`;
      onSaveFeedback({ kind: "error", tabId: tab.id, rowKey, column, message: "保存失败" });
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

  function isPrimaryKeyColumn(column) {
    return Boolean(column?.is_primary_key || column?.isPrimaryKey);
  }

  function primaryKeyColumns(tab) {
    const explicitKeys = Array.isArray(tab?.primaryKeys)
      ? tab.primaryKeys.map((key) => String(key || "").trim()).filter(Boolean)
      : [];
    if (explicitKeys.length > 0) return explicitKeys;
    return activeColumns.value.filter(isPrimaryKeyColumn).map(columnName).filter(Boolean);
  }

  function primaryKeySignature(draft, keys) {
    if (!keys.length) return "";
    const values = keys.map((key) => String(draft?.[key] ?? "").trim());
    return values.every((value) => value !== "") ? values.join("") : "";
  }

  function cleanDraftValues(draft) {
    return Object.fromEntries(
      Object.entries(draft || {}).filter(([, value]) => String(value ?? "").trim() !== ""),
    );
  }

  function rowFromDraft(draft) {
    const row = {};
    for (const column of activeColumns.value) {
      const name = columnName(column);
      if (name && Object.prototype.hasOwnProperty.call(draft, name)) row[name] = String(draft[name] ?? "");
    }
    for (const [key, value] of Object.entries(draft)) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) row[key] = String(value ?? "");
    }
    return row;
  }

  function promoteSavedDraft(tab, draft) {
    if (!tab || !Array.isArray(tab.rows)) return;
    const cleaned = cleanDraftValues(draft);
    if (Object.keys(cleaned).length === 0) return;
    const keys = primaryKeyColumns(tab);
    const signature = primaryKeySignature(cleaned, keys);
    if (keys.length > 0 && !signature) return;
    if (signature && tab.rows.some((row) => primaryKeySignature(row, keys) === signature)) return;
    tab.rows.push(rowFromDraft(cleaned));
    tab.totalRows = Math.max(Number(tab.totalRows || 0), tab.rows.length);
  }

  async function commitDraftObject(tab, draft, rowId) {
    if (!tab?.sessionId) return false;
    const cleaned = cleanDraftValues(draft);
    if (Object.keys(cleaned).length === 0) return false;
    const otherDrafts = getInsertRows(tab)
      .filter((candidate) => candidate.id !== rowId)
      .map((candidate) => cleanDraftValues(candidate.draft));
    const validation = validateRowDraft({
      table: tableForValidation(tab),
      rows: tab.rows || [],
      draft: cleaned,
      draftRows: otherDrafts,
    });
    if (!validation.valid) {
      const validationError = firstValidationError(validation);
      statusText.value = validationError?.message || "输入不符合字段约束";
      return false;
    }
    try {
      await invokeWorkbench("insert_row", {
        request: {
          sessionId: tab.sessionId,
          draft: cleaned,
        },
      });
      return true;
    } catch (error) {
      statusText.value = `插入失败：${String(error)}`;
      return false;
    }
  }

  async function commitInsertRow(tab, rowId) {
    const row = ensureInsertRow(tab, rowId);
    const draft = cleanDraftValues(row.draft);
    const inserted = await commitDraftObject(tab, draft, row.id);
    if (!inserted) return false;
    promoteSavedDraft(tab, draft);
    clearInsertDraft(tab, row.id);
    ensureTrailingInsertRow(tab);
    if (getInsertRows(tab).every((candidate) => !hasDraftValues(candidate))) hideInsertRow(tab, { clearDraft: true });
    await nextTick();
    statusText.value = "已插入 1 行";
    return true;
  }

  async function commitInsertRows(tab) {
    if (!tab?.sessionId) return { insertedRows: 0, failedRowId: null };
    const rowsToSave = getInsertRows(tab).filter(hasDraftValues);
    let insertedRows = 0;
    for (const row of rowsToSave) {
      const draft = cleanDraftValues(row.draft);
      const inserted = await commitDraftObject(tab, draft, row.id);
      if (!inserted) {
        selectInsertCell(tab, row.id, selectedInsertCell.value?.columnIndex ?? 0);
        return { insertedRows, failedRowId: row.id };
      }
      promoteSavedDraft(tab, draft);
      clearInsertDraft(tab, row.id);
      insertedRows++;
    }
    ensureTrailingInsertRow(tab);
    if (!hasInsertDrafts(tab)) hideInsertRow(tab, { clearDraft: true });
    if (insertedRows > 0) statusText.value = `已保存新增 ${insertedRows} 行`;
    return { insertedRows, failedRowId: null };
  }

  function pasteIntoInsertCell(tab, matrix, rowId = selectedInsertCell.value?.rowId, columnIndex = selectedInsertCell.value?.columnIndex) {
    if (!tab || !isInsertRowVisible(tab) || rowId == null || columnIndex == null) return;
    const rows = getInsertRows(tab);
    const targetRowIndex = Math.max(0, rows.findIndex((row) => row.id === rowId));
    const startColumnIndex = columnIndex;
    const columns = activeColumns.value;
    const sourceStartsWithPrimaryKey = startColumnIndex === 0 && isPrimaryKeyColumn(columns[0]) && matrix.some((row) => row.length === columns.length);
    for (let rowOffset = 0; rowOffset < matrix.length; rowOffset++) {
      let targetRow = getInsertRows(tab)[targetRowIndex + rowOffset];
      while (!targetRow) {
        getInsertRows(tab).push(createInsertRow());
        targetRow = getInsertRows(tab)[targetRowIndex + rowOffset];
      }
      for (let colOffset = 0; colOffset < matrix[rowOffset].length; colOffset++) {
        const targetColumnIndex = sourceStartsWithPrimaryKey ? colOffset : startColumnIndex + colOffset;
        const column = columns[targetColumnIndex];
        if (!column) continue;
        updateInsertDraft(tab, targetRow.id, columnName(column), matrix[rowOffset][colOffset]);
      }
    }
    const pastedCells = matrix.reduce((total, row) => total + row.length, 0);
    statusText.value = matrix.length > 1 ? `已粘贴到 ${matrix.length} 条新增行` : `已粘贴 ${pastedCells} 个新增单元格`;
  }

  async function pasteIntoInsertInput(tab, rowId, columnIndex, event) {
    const text = event?.clipboardData?.getData?.("text/plain") ?? "";
    if (!text) return;
    pasteIntoInsertCell(tab, parseTsv(text), rowId, columnIndex);
  }

  async function pasteIntoSelectedInsertRow(tab, matrix) {
    if (!tab || !isInsertRowVisible(tab) || selectedInsertRow.value?.tabId !== tab.id) return { insertedRows: 0 };
    const columns = activeColumns.value;
    let insertedRows = 0;
    for (const row of matrix) {
      const draft = {};
      for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
        const column = columns[columnIndex];
        if (!column) continue;
        draft[columnName(column)] = row[columnIndex] ?? "";
      }
      if (await commitDraftObject(tab, draft, undefined)) {
        promoteSavedDraft(tab, draft);
        insertedRows++;
      }
    }
    if (insertedRows > 0) clearInsertDraft(tab, selectedInsertRow.value.rowId);
    ensureTrailingInsertRow(tab);
    statusText.value = `已粘贴新增 ${insertedRows} 行`;
    return { insertedRows };
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
    const isSave = (event.ctrlKey || event.metaKey) && key === "s";

    if (isSave) {
      event.preventDefault();
      if (editingCell.value) {
        finishEditing();
        return;
      }
      if (selectedCell.value) return await saveTextPanel();
      if (isInsertRowVisible(tab) && hasInsertDrafts(tab)) {
        return await commitInsertRows(tab);
      }
      return;
    }

    if (isCopy) {
      event.preventDefault();
      if (tab.selectedRowKeys.size > 0) {
        const selectedRows = tab.rows.filter((r) => tab.selectedRowKeys.has(buildRowKey(tab, r)));
        if (selectedRows.length > 0) {
          const body = matrixToTsv(
            selectedRows.map((row) => activeColumnNames().map((col) => displayCellValue(editState, tab, row, col)))
          );
          await navigator.clipboard.writeText(body);
          statusText.value = `已复制 ${selectedRows.length} 行`;
        }
      } else if (isMultiCellRange(selectedRange.value)) {
        const matrix = getSelectedRangeMatrix(tab);
        if (matrix?.length) {
          await navigator.clipboard.writeText(matrixToTsv(matrix));
          statusText.value = `已复制 ${matrix.length}×${matrix[0]?.length || 0} 区域`;
        }
      } else if (selectedCell.value) {
        const row = findRowByKey(tab, selectedCell.value.rowKey);
        if (row) {
          const value = displayCellValue(editState, tab, row, selectedCell.value.column);
          await navigator.clipboard.writeText(value);
          statusText.value = "已复制";
        }
      } else if (isInsertRowVisible(tab) && selectedInsertRow.value?.tabId === tab.id) {
        await navigator.clipboard.writeText(matrixToTsv([insertDraftRow(tab, selectedInsertRow.value.rowId)]));
        statusText.value = "已复制新增行";
      } else if (isInsertRowVisible(tab) && selectedInsertCell.value?.tabId === tab.id) {
        const draft = getInsertDraft(tab, selectedInsertCell.value.rowId);
        await navigator.clipboard.writeText(String(draft[selectedInsertCell.value.column] ?? ""));
        statusText.value = "已复制";
      }
      return;
    }

    if (isPaste) {
      event.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text == null) return;
        const matrix = parseTsv(text);
        if (isInsertRowVisible(tab) && selectedInsertCell.value?.tabId === tab.id) {
          pasteIntoInsertCell(tab, matrix);
          return;
        }
        if (isInsertRowVisible(tab) && selectedInsertRow.value?.tabId === tab.id) {
          return await pasteIntoSelectedInsertRow(tab, matrix);
        }
        const start = rangeStartPosition(tab);
        if (!start) return;
        const edits = [];
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
            edits.push({ row, rowIndex, columnName: columnName(column), value: matrix[rowOffset][colOffset] });
          }
        }
        const validation = validateBatchEdits({ table: tableForValidation(tab), rows: tab.rows || [], edits });
        for (const validationError of validation.errors) {
          const row = tab.rows[validationError.rowIndex];
          const rowKey = row ? buildRowKey(tab, row) : "";
          setValidationFeedback(tab, rowKey, validationError.columnName, validationError);
        }
        for (const edit of validation.validEdits) {
          await commitCellValue(tab, edit.row, edit.columnName, edit.value);
        }
        const invalidCount = validation.errors.length;
        const committed = validation.validEdits.length;
        statusText.value = invalidCount > 0 || skipped > 0
          ? `已粘贴 ${committed} 个单元格，${invalidCount + skipped} 个格式错误未保存`
          : `已粘贴 ${committed} 个单元格`;
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
      navigateCell(0, event.shiftKey ? -1 : 1, { wrapColumns: true });
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
        event.preventDefault();
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
    if (!tab || tabScopeKey(tab) !== entry.tableName) {
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
    selectedInsertRow,
    isSelectingRange,
    editingCell,
    editDraft,
    textDraft,
    insertDrafts,
    activeColumns,
    // insert draft helpers
    getInsertRows,
    getInsertDraft,
    hasInsertDrafts,
    updateInsertDraft,
    clearInsertDraft,
    isInsertRowVisible,
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
    selectInsertRow,
    handleInsertKeydown,
    // commits
    commitCellValue,
    saveTextPanel,
    commitInsertRow,
    commitInsertRows,
    setCellToNull,
    pasteIntoInsertInput,
    // keyboard
    handleGridKeydown,
    handleUndoKeydown,
  };
}
