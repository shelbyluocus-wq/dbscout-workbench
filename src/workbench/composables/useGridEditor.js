import { computed, nextTick, reactive, ref } from "vue";
import { GRID_ROW_HEIGHT, GRID_HEADER_HEIGHT } from "../constants.js";
import { columnName } from "../utils/normalize.js";
import {
  clearedCellValue,
  validateBatchEdits,
  validateCellValue,
  validateRowDraft,
} from "../utils/valueValidation.js";

const ROW_INDEX_WIDTH = 38;
const RANGE_AUTOSCROLL_EDGE = 28;
const RANGE_AUTOSCROLL_MAX_STEP = 18;
// 足够大的位移，配合 navigateCell 的 clamp 实现「跳到数据区边缘」(Ctrl+方向/Home/End)。
const EDGE_JUMP = 1_000_000;
const INSERT_ROW_KEY_PREFIX = "__insert__:";
const INSERT_ROW_ID_FIELD = "__insertRowId";
const DUPLICATE_PRIMARY_KEY_MESSAGE = "主键重复，不能保存";
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

  const activeColumns = computed(() => activeTab.value?.columns || []);
  let lastRangePointerEvent = null;
  let rangeAutoscrollFrame = 0;
  let nextInsertRowId = 1;

  // ── Column selection state ────────────────────────────────────────────
  const selectedColumnAnchor = ref(-1);
  const selectedColumnSet = ref(new Set());

  function lastSelectableRowIndex(tab) {
    return selectableRowCount(tab) - 1;
  }

  function columnIndexByName(name) {
    return activeColumns.value.map(columnName).indexOf(name);
  }

  function setColumnRange(tab, columnIndex) {
    const lastRow = lastSelectableRowIndex(tab);
    const start = positionFromIndexes(tab, 0, columnIndex);
    const end = positionFromIndexes(tab, lastRow, columnIndex);
    if (!start || !end) return;
    selectedCell.value = { tabId: tab.id, rowKey: start.position.rowKey, column: start.position.column };
    selectedRange.value = { tabId: tab.id, anchor: start.position, focus: end.position };
  }

  function clearColumnSelection() {
    selectedColumnAnchor.value = -1;
    selectedColumnSet.value = new Set();
  }

  function updateColumnRangeFromSet(tab) {
    const indices = Array.from(selectedColumnSet.value).sort((a, b) => a - b);
    if (indices.length === 0) {
      selectedRange.value = null;
      selectedCell.value = null;
      return;
    }
    const lastRow = lastSelectableRowIndex(tab);
    const left = indices[0];
    const right = indices[indices.length - 1];
    const start = positionFromIndexes(tab, 0, left);
    const end = positionFromIndexes(tab, lastRow, right);
    if (!start || !end) return;
    selectedCell.value = { tabId: tab.id, rowKey: start.position.rowKey, column: start.position.column };
    selectedRange.value = { tabId: tab.id, anchor: start.position, focus: end.position };
  }

  function selectColumn(tab, columnNameValue, event) {
    if (!tab || activeColumns.value.length === 0) return;
    if (editingCell.value) finishEditing();
    hideInsertRow(tab);
    selectedInsertCell.value = null;
    selectedInsertRow.value = null;
    isSelectingRange.value = false;
    lastRangePointerEvent = null;
    stopRangeAutoscroll();

    const columnIndex = columnIndexByName(columnNameValue);
    if (columnIndex < 0) return;

    const isCtrl = event?.ctrlKey || event?.metaKey;
    const isShift = event?.shiftKey;

    if (isCtrl) {
      if (selectedColumnSet.value.has(columnIndex)) {
        selectedColumnSet.value.delete(columnIndex);
      } else {
        selectedColumnSet.value.add(columnIndex);
      }
      if (selectedColumnAnchor.value < 0) {
        selectedColumnAnchor.value = columnIndex;
      }
      updateColumnRangeFromSet(tab);
    } else if (isShift && selectedColumnAnchor.value >= 0) {
      selectedColumnSet.value = new Set();
      const start = Math.min(selectedColumnAnchor.value, columnIndex);
      const end = Math.max(selectedColumnAnchor.value, columnIndex);
      for (let i = start; i <= end; i++) {
        selectedColumnSet.value.add(i);
      }
      updateColumnRangeFromSet(tab);
    } else {
      selectedColumnAnchor.value = columnIndex;
      selectedColumnSet.value = new Set([columnIndex]);
      setColumnRange(tab, columnIndex);
    }

    nextTick(() => gridWrapRef.value?.focus());
  }

  function isColumnSelected(tab, columnIndex) {
    const range = selectedRange.value;
    if (!tab || !range || range.tabId !== tab.id) return false;
    const bounds = getRangeBounds(range);
    return columnIndex >= bounds.left && columnIndex <= bounds.right;
  }

  function tabScopeKey(tab) {
    return tab?.tableKey || tab?.tableName || "";
  }

  function tabDisplayName(tab) {
    return tab?.database ? `${tab.database}.${tab.tableName}` : tab?.tableName || "";
  }

  // ── Insert-draft helpers ──────────────────────────────────────────────

  function isReadOnlyTab(tab) {
    return Boolean(tab?.readOnly || tab?.read_only);
  }

  function setReadOnlyStatus(tab) {
    statusText.value = `${tabDisplayName(tab)} 是只读连接，不能编辑`;
  }

  function createInsertRow(anchorIndex = null, { visible = true } = {}) {
    return { id: `insert-${nextInsertRowId++}`, draft: {}, anchorIndex, visible };
  }

  function getInsertRowKey(tab, rowId) {
    return rowId ? `${INSERT_ROW_KEY_PREFIX}${tab?.id || ""}:${rowId}` : "";
  }

  function isInsertRowKey(rowKey) {
    return String(rowKey || "").startsWith(INSERT_ROW_KEY_PREFIX);
  }

  function insertRowIdFromKey(tab, rowKey) {
    const value = String(rowKey || "");
    const tabPrefix = `${INSERT_ROW_KEY_PREFIX}${tab?.id || ""}:`;
    if (value.startsWith(tabPrefix)) return value.slice(tabPrefix.length);
    if (!value.startsWith(INSERT_ROW_KEY_PREFIX)) return "";
    return value.slice(INSERT_ROW_KEY_PREFIX.length).split(":").slice(1).join(":");
  }

  function insertRowIdFromRow(row) {
    return row?.[INSERT_ROW_ID_FIELD] || row?.__insert_row_id || "";
  }

  function isInsertDraftRowObject(row) {
    return Boolean(insertRowIdFromRow(row));
  }

  function insertRowIndex(tab, rowId) {
    return getInsertRows(tab).findIndex((row) => row.id === rowId);
  }

  function isInsertDraftVisible(row) {
    return row?.visible !== false;
  }

  function showInsertDraftRow(row) {
    if (row) row.visible = true;
    return row;
  }

  function hideInsertDraftRow(row) {
    if (row) row.visible = false;
    return row;
  }

  // 草稿行的有效 anchorIndex：null 表示末尾追加。anchorIndex 越界
  // （>= tab.rows.length，例如删除/刷新后行数变少）也视为末尾追加，
  // 与 DataGrid 的 insertRowsByAnchor 分组保持一致，避免定位与渲染错位。
  function insertRowAnchorIndex(tab, row) {
    if (row?.anchorIndex == null) return null;
    const value = Number(row.anchorIndex);
    if (!Number.isFinite(value) || value < 0) return null;
    const rowCount = tab?.rows?.length || 0;
    return value < rowCount ? value : null;
  }

  function visualRowEntries(tab) {
    const dataRows = tab?.rows || [];
    const insertRows = getVisibleInsertRows(tab);
    const entries = [];
    for (let dataIndex = 0; dataIndex < dataRows.length; dataIndex++) {
      for (const insertRow of insertRows) {
        if (insertRowAnchorIndex(tab, insertRow) === dataIndex) {
          entries.push({
            type: "insert",
            rowId: insertRow.id,
            insertRow,
            row: { ...insertRow.draft, [INSERT_ROW_ID_FIELD]: insertRow.id },
          });
        }
      }
      entries.push({ type: "data", dataIndex, row: dataRows[dataIndex] });
    }
    for (const insertRow of insertRows) {
      if (insertRowAnchorIndex(tab, insertRow) == null) {
        entries.push({
          type: "insert",
          rowId: insertRow.id,
          insertRow,
          row: { ...insertRow.draft, [INSERT_ROW_ID_FIELD]: insertRow.id },
        });
      }
    }
    return entries;
  }

  function visualRowIndexOfInsertRow(tab, rowId) {
    return visualRowEntries(tab).findIndex((entry) => entry.type === "insert" && entry.rowId === rowId);
  }

  function visualRowIndexOfDataRow(tab, dataIndex) {
    return visualRowEntries(tab).findIndex((entry) => entry.type === "data" && entry.dataIndex === dataIndex);
  }

  function insertRowByKey(tab, rowKey) {
    const rowId = insertRowIdFromKey(tab, rowKey);
    return getInsertRows(tab).find((row) => row.id === rowId) || null;
  }

  function insertPosition(tab, rowId, columnIndex) {
    const column = columnName(activeColumns.value[columnIndex]);
    const visualIndex = visualRowIndexOfInsertRow(tab, rowId);
    const resolvedRowIndex = visualIndex >= 0
      ? visualIndex
      : tab.rows.length + Math.max(0, insertRowIndex(tab, rowId));
    return { rowIndex: resolvedRowIndex, columnIndex, rowKey: getInsertRowKey(tab, rowId), column };
  }

  function insertDraftValue(tab, rowKeyOrRowId, column) {
    const rowId = isInsertRowKey(rowKeyOrRowId) ? insertRowIdFromKey(tab, rowKeyOrRowId) : rowKeyOrRowId;
    const row = ensureInsertRow(tab, rowId);
    return String(row.draft?.[column] ?? "");
  }

  function selectableRowCount(tab) {
    return visualRowEntries(tab).length;
  }

  function selectedInsertCellMatches(tab, rowId, column) {
    return selectedCell.value?.tabId === tab?.id
      && selectedCell.value?.rowKey === getInsertRowKey(tab, rowId)
      && selectedCell.value?.column === column;
  }

  function getInsertRows(tab) {
    if (!tab?.id) return [];
    if (!Array.isArray(insertDrafts[tab.id])) insertDrafts[tab.id] = [];
    return insertDrafts[tab.id];
  }

  function getVisibleInsertRows(tab) {
    if (!tab?.id || isReadOnlyTab(tab)) return [];
    return getInsertRows(tab).filter(isInsertDraftVisible);
  }

  function insertAwareVisualRowIndex(tab, dataIndex) {
    return visualRowIndexOfDataRow(tab, dataIndex);
  }

  // 末尾追加草稿（anchorIndex==null）。始终保证存在一条可录入的空末尾草稿；
  // 已有非空末尾草稿时再追加一条空草稿。
  function ensureTrailingInsertRow(tab, { visible = true } = {}) {
    const rows = getInsertRows(tab);
    const trailingRows = rows.filter((row) => row.anchorIndex == null && (!visible || isInsertDraftVisible(row)));
    const lastTrailing = trailingRows.at(-1);
    if (!lastTrailing || hasDraftValues(lastTrailing)) {
      const nextRow = createInsertRow(null, { visible });
      rows.push(nextRow);
      return nextRow;
    }
    if (visible) showInsertDraftRow(lastTrailing);
    return lastTrailing;
  }

  // 无 rowId 时定位到「最后一条空末尾草稿」：键盘导航到末尾追加区时，
  // 应聚焦到一条新的空草稿（而不是已有录入值的草稿）。
  function ensureInsertRow(tab, rowId, { visible = true, create = true } = {}) {
    const rows = getInsertRows(tab);
    if (rowId) {
      const existing = rows.find((row) => row.id === rowId);
      if (existing) {
        if (visible) showInsertDraftRow(existing);
        return existing;
      }
      if (!create) return null;
      const nextRow = createInsertRow(null, { visible });
      rows.push(nextRow);
      return nextRow;
    }
    return ensureTrailingInsertRow(tab, { visible });
  }

  function hasDraftValues(row) {
    return Object.values(row?.draft || {}).some((value) => String(value ?? "").trim() !== "");
  }

  function hasInsertDrafts(tab) {
    return getInsertRows(tab).some(hasDraftValues);
  }

  function firstEditableColumnIndex() {
    const cols = activeColumns.value;
    // 优先：非主键的第一列
    const nonPk = cols.findIndex((col) => !isPrimaryKeyColumn(col));
    if (nonPk >= 0) return nonPk;
    // 全是主键时取第一列（自增主键留空由后端生成）
    return 0;
  }

  function insertDraftAbove(tab, anchorIndex) {
    if (!tab?.id) return;
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
    const rows = getInsertRows(tab);
    const newRow = createInsertRow(anchorIndex);
    rows.push(newRow);
    const columnIndex = firstEditableColumnIndex();
    selectInsertCell(tab, newRow.id, columnIndex, { scrollColumn: false });
  }

  function getInsertDraft(tab, rowId) {
    if (!tab?.id) return {};
    if (rowId) return ensureInsertRow(tab, rowId, { visible: false }).draft;
    return getVisibleInsertRows(tab).at(-1)?.draft || {};
  }

  function updateInsertDraft(tab, rowIdOrColumn, columnOrValue, maybeValue) {
    if (!tab?.id) return;
    if (isReadOnlyTab(tab)) return;
    const rowAware = arguments.length >= 4;
    const column = rowAware ? columnOrValue : rowIdOrColumn;
    const value = rowAware ? maybeValue : columnOrValue;
    if (!column) return;
    // 无 rowId（3 参数形式）时优先写回当前选中的新增行，避免连续录入因
    // ensureTrailingInsertRow 追加新空行而落到不同草稿行上。
    const explicitRowId = rowAware ? rowIdOrColumn : undefined;
    const rowId = explicitRowId || (selectedInsertCell.value?.tabId === tab.id ? selectedInsertCell.value.rowId : undefined);
    const row = ensureInsertRow(tab, rowId);
    const columnIndex = activeColumnNames().indexOf(column);
    row.draft[column] = String(value ?? "");
    const position = insertPosition(tab, row.id, Math.max(0, columnIndex));
    if (!selectedCell.value && !selectedInsertRow.value) {
      selectedInsertCell.value = { tabId: tab.id, rowId: row.id, columnIndex, column };
      selectedCell.value = { tabId: tab.id, rowKey: position.rowKey, column };
      selectedRange.value = { tabId: tab.id, anchor: position, focus: position };
    }
    if (selectedInsertCellMatches(tab, row.id, column)) textDraft.value = String(value ?? "");
    clearCellError(editState, tabScopeKey(tab), position.rowKey, column);
    refreshInsertDraftPrimaryKeyFeedback(tab);
  }

  function clearInsertDraft(tab, rowId) {
    if (!tab?.id) return;
    if (!rowId) {
      insertDrafts[tab.id] = [];
      selectedInsertCell.value = null;
      selectedInsertRow.value = null;
      selectedCell.value = null;
      selectedRange.value = null;
      editingCell.value = null;
      editDraft.value = "";
      textDraft.value = "";
      return;
    }
    const rows = getInsertRows(tab);
    const index = rows.findIndex((row) => row.id === rowId);
    if (index >= 0) rows.splice(index, 1);
    if (selectedInsertCell.value?.tabId === tab.id && selectedInsertCell.value.rowId === rowId) selectedInsertCell.value = null;
    if (selectedInsertRow.value?.tabId === tab.id && selectedInsertRow.value.rowId === rowId) selectedInsertRow.value = null;
  }

  function isInsertRowVisible(tab) {
    return getVisibleInsertRows(tab).length > 0;
  }

  function showInsertRow(tab, { ensureTrailing = true, rowId = null } = {}) {
    if (!tab?.id) return;
    if (isReadOnlyTab(tab)) return;
    if (rowId) showInsertDraftRow(ensureInsertRow(tab, rowId));
    if (ensureTrailing) ensureTrailingInsertRow(tab);
  }

  function hideInsertRow(tab, { clearDraft = false, preserveDrafts = false, rowId = null } = {}) {
    if (!tab?.id) return;
    if (clearDraft) {
      clearInsertDraft(tab, rowId);
    } else if (preserveDrafts) {
      for (const row of getInsertRows(tab)) {
        if (!rowId || row.id === rowId) hideInsertDraftRow(row);
      }
    }
    selectedInsertCell.value = null;
    selectedInsertRow.value = null;
  }

  function removeInsertDraftRow(tab, rowId) {
    if (!tab?.id || !rowId) return false;
    const existed = getInsertRows(tab).some((row) => row.id === rowId);
    if (!existed) return false;
    clearInsertDraft(tab, rowId);
    if (getInsertRows(tab).length === 0) clearInsertDraft(tab);
    selectedCell.value = null;
    selectedRange.value = null;
    selectedInsertCell.value = null;
    selectedInsertRow.value = null;
    editingCell.value = null;
    editDraft.value = "";
    textDraft.value = "";
    statusText.value = "已移除新增未保存行";
    nextTick(() => gridWrapRef.value?.focus());
    return true;
  }

  // ── Cell selection ────────────────────────────────────────────────────

  function cellPosition(tab, row, column, rowIndex, columnIndex) {
    return {
      rowIndex,
      columnIndex,
      rowKey: isInsertDraftRowObject(row) ? getInsertRowKey(tab, insertRowIdFromRow(row)) : buildRowKey(tab, row),
      column,
    };
  }

  function collapseRangeToCell(tab, row, column, rowIndex, columnIndex) {
    const colNames = activeColumns.value.map(columnName);
    const resolvedRowIndex = rowIndex ?? (
      isInsertDraftRowObject(row)
        ? tab.rows.length + Math.max(0, insertRowIndex(tab, insertRowIdFromRow(row)))
        : tab.rows.findIndex((candidate) => buildRowKey(tab, candidate) === buildRowKey(tab, row))
    );
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
    textDraft.value = isInsertRowKey(position.rowKey)
      ? insertDraftValue(tab, position.rowKey, position.column)
      : displayCellValue(editState, tab, row, position.column, position.rowKey);
  }

  function positionFromIndexes(tab, rowIndex, columnIndex) {
    const column = activeColumns.value[columnIndex];
    const name = columnName(column);
    if (!tab || !name) return null;
    const entry = visualRowEntries(tab)[rowIndex];
    if (!entry) return null;
    if (entry.type === "insert") {
      return {
        row: entry.row,
        position: insertPosition(tab, entry.rowId, columnIndex),
      };
    }
    return { row: entry.row, position: cellPosition(tab, entry.row, name, rowIndex, columnIndex) };
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

  function clearSelection({ clearInsertDrafts = false } = {}) {
    const tab = activeTab.value;
    selectedCell.value = null;
    selectedRange.value = null;
    selectedInsertCell.value = null;
    selectedInsertRow.value = null;
    clearColumnSelection();
    if (tab) hideInsertRow(tab);
    isSelectingRange.value = false;
    editingCell.value = null;
    editDraft.value = "";
    textDraft.value = "";
    if (tab && clearInsertDrafts) clearInsertDraft(tab);
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
    // 双击进入编辑后，再单击同一个单元格应切换光标位置而非退出编辑。
    // 此处与 selectInsertCell 的 editingSameCell 守卫保持一致，且 rowKey 的取法与
    // startEditing 一致（新增行用 getInsertRowKey，普通行用 buildRowKey）。
    const rowKey = isInsertDraftRowObject(row) ? getInsertRowKey(tab, insertRowIdFromRow(row)) : buildRowKey(tab, row);
    const editingSameCell = editingCell.value?.tabId === tab.id
      && editingCell.value?.rowKey === rowKey
      && editingCell.value?.column === column;
    if (editingCell.value && !editingSameCell) finishEditing();
    if (!isInsertDraftRowObject(row)) {
      hideInsertRow(tab);
    } else {
      const rowId = insertRowIdFromRow(row);
      showInsertRow(tab, { rowId, ensureTrailing: false });
      selectedInsertCell.value = { tabId: tab.id, rowId, columnIndex, column };
      selectedInsertRow.value = null;
    }
    collapseRangeToCell(tab, row, column, rowIndex, columnIndex);
    setSelectedCellFromPosition(tab, row, selectedRange.value.anchor);
    // 编辑同一个单元格时不要把焦点抢回网格，否则输入框失焦、光标无法定位。
    if (editingSameCell) return;
    if (focusGrid) nextTick(() => gridWrapRef.value?.focus());
  }

  function startRangeSelection(tab, row, column, rowIndex, columnIndex, event) {
    if (event?.button != null && event.button !== 0) return;
    // 双击进入编辑后，在同一个单元格上按下鼠标应把光标交给输入框定位，
    // 而非结束编辑并把焦点切回网格（否则单击会把编辑态打回选中态）。
    // 注意：必须在 preventDefault 之前返回，否则输入框拿不到焦点。
    const sameEditingCell = editingCell.value?.tabId === tab.id
      && editingCell.value?.rowKey === (isInsertDraftRowObject(row) ? getInsertRowKey(tab, insertRowIdFromRow(row)) : buildRowKey(tab, row))
      && editingCell.value?.column === column;
    if (sameEditingCell) return;
    event?.preventDefault?.();
    if (editingCell.value) finishEditing();
    if (!isInsertDraftRowObject(row)) {
      hideInsertRow(tab);
    } else {
      const rowId = insertRowIdFromRow(row);
      showInsertRow(tab, { rowId, ensureTrailing: false });
      selectedInsertCell.value = { tabId: tab.id, rowId, columnIndex, column };
      selectedInsertRow.value = null;
    }
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
    if (isInsertDraftRowObject(row)) {
      selectedInsertCell.value = { tabId: tab.id, rowId: insertRowIdFromRow(row), columnIndex, column };
      selectedInsertRow.value = null;
    } else {
      selectedInsertCell.value = null;
    }
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

  function insertDraftErrorColumns(validationError) {
    if (validationError?.code === "duplicate-primary-key" && Array.isArray(validationError.columns)) {
      return validationError.columns.filter(Boolean);
    }
    return validationError?.columnName ? [validationError.columnName] : [];
  }

  function setInsertDraftValidationFeedback(tab, rowId, validationError) {
    const rowKey = getInsertRowKey(tab, rowId);
    const columns = insertDraftErrorColumns(validationError);
    if (columns.length === 0) {
      statusText.value = validationError?.message || "输入不符合字段约束";
      return;
    }
    for (const column of columns) {
      setValidationFeedback(tab, rowKey, column, validationError);
    }
    selectInsertCell(tab, rowId, Math.max(0, activeColumnNames().indexOf(columns[0])));
  }

  function clearInsertDraftPrimaryKeyErrors(tab, rowId) {
    const rowKey = getInsertRowKey(tab, rowId);
    for (const key of primaryKeyColumns(tab)) {
      const current = getCellError(editState, tabScopeKey(tab), rowKey, key);
      if (current === DUPLICATE_PRIMARY_KEY_MESSAGE) {
        clearCellError(editState, tabScopeKey(tab), rowKey, key);
      }
    }
  }

  function refreshInsertDraftPrimaryKeyFeedback(tab) {
    const keys = primaryKeyColumns(tab);
    if (keys.length === 0) return;
    const allRows = getInsertRows(tab);
    for (const row of allRows) clearInsertDraftPrimaryKeyErrors(tab, row.id);
    const rows = allRows.filter(hasDraftValues);

    const loadedSignatures = new Set(
      (tab.rows || [])
        .map((row) => primaryKeySignature(row, keys))
        .filter(Boolean),
    );
    const draftGroups = new Map();
    for (const row of rows) {
      const signature = primaryKeySignature(cleanDraftValues(row.draft), keys);
      if (!signature) continue;
      if (!draftGroups.has(signature)) draftGroups.set(signature, []);
      draftGroups.get(signature).push(row);
    }

    const duplicateRows = new Set();
    for (const [signature, group] of draftGroups.entries()) {
      if (loadedSignatures.has(signature) || group.length > 1) {
        for (const row of group) duplicateRows.add(row);
      }
    }

    for (const row of duplicateRows) {
      const rowKey = getInsertRowKey(tab, row.id);
      for (const key of keys) {
        editState.cellErrors.set(cellErrorKey(tab, rowKey, key), DUPLICATE_PRIMARY_KEY_MESSAGE);
      }
    }
  }

  function flushEditingInsertDraft(tab) {
    const editing = editingCell.value;
    if (!tab || !editing || editing.tabId !== tab.id || !isInsertRowKey(editing.rowKey)) return false;
    updateInsertDraft(tab, insertRowIdFromKey(tab, editing.rowKey), editing.column, editDraft.value);
    editingCell.value = null;
    return true;
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

  function rowValueForRange(tab, rowIndex, col) {
    const entry = visualRowEntries(tab)[rowIndex];
    if (!entry) return "";
    return entry.type === "insert"
      ? String(entry.insertRow?.draft?.[col] ?? "")
      : displayCellValue(editState, tab, entry.row, col);
  }

  function rowForSelectedCell(tab, cell) {
    if (!tab || !cell || cell.tabId !== tab.id) return null;
    if (isInsertRowKey(cell.rowKey)) {
      const row = insertRowByKey(tab, cell.rowKey);
      return row ? { ...row.draft, [INSERT_ROW_ID_FIELD]: row.id } : null;
    }
    return findRowByKey(tab, cell.rowKey);
  }

  function selectedCellPositionIndexes(tab, cell) {
    if (!tab || !cell || cell.tabId !== tab.id) return { rowIndex: undefined, columnIndex: undefined };
    const columnIndex = activeColumnNames().indexOf(cell.column);
    if (isInsertRowKey(cell.rowKey)) {
      const rowId = insertRowIdFromKey(tab, cell.rowKey);
      return { rowIndex: visualRowIndexOfInsertRow(tab, rowId), columnIndex };
    }
    const dataIndex = tab.rows.findIndex((row) => buildRowKey(tab, row) === cell.rowKey);
    return {
      rowIndex: visualRowIndexOfDataRow(tab, dataIndex),
      columnIndex,
    };
  }

  function getSelectedRangeMatrix(tab) {
    const range = selectedRange.value;
    if (!tab || !range || range.tabId !== tab.id) return null;
    const bounds = getRangeBounds(range);
    const colNames = activeColumnNames();
    const rows = [];
    for (let rowIndex = bounds.top; rowIndex <= bounds.bottom; rowIndex++) {
      rows.push(
        colNames
          .slice(bounds.left, bounds.right + 1)
          .map((col) => rowValueForRange(tab, rowIndex, col))
      );
    }
    return rows;
  }

  // 按 Excel 语义清空一个数据单元格：文本列写 ""，可空的其它类型写 NULL，
  // 不可清空的列（非空数值/主键等）保持不动。
  async function clearCellValue(tab, row, column) {
    const meta = activeColumns.value.find((item) => columnName(item) === column);
    if (!meta) return;
    const cleared = clearedCellValue(meta);
    if (!cleared.canClear) return;
    await commitCellValue(tab, row, column, cleared.value);
  }

  // 把选中的矩形范围内所有可清空、非主键单元格清空（剪切 / Delete 时使用）。
  async function clearSelectedRange(tab) {
    const range = selectedRange.value;
    if (!tab || !range || range.tabId !== tab.id) return;
    const bounds = getRangeBounds(range);
    const colNames = activeColumnNames();
    for (let rowIndex = bounds.top; rowIndex <= bounds.bottom; rowIndex++) {
      const row = tab.rows[rowIndex];
      if (!row) continue;
      for (let colIndex = bounds.left; colIndex <= bounds.right; colIndex++) {
        await clearCellValue(tab, row, colNames[colIndex]);
      }
    }
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
    if (isReadOnlyTab(tab)) {
      editingCell.value = null;
      setReadOnlyStatus(tab);
      return;
    }
    const rowKey = isInsertDraftRowObject(row) ? getInsertRowKey(tab, insertRowIdFromRow(row)) : buildRowKey(tab, row);
    clearCellError(editState, tabScopeKey(tab), rowKey, column);
    selectedCell.value = { tabId: tab.id, rowKey, column };
    collapseRangeToCell(tab, row, column, rowIndex, columnIndex);
    editingCell.value = { tabId: tab.id, rowKey, column };
    const initialValue = isInsertRowKey(rowKey)
      ? insertDraftValue(tab, rowKey, column)
      : displayCellValue(editState, tab, row, column, rowKey);
    // 编辑真实 NULL 单元格时输入框显示为空，而非字面 "NULL"（Excel 式，且与
    // 网格里 NULL 渲染为空白保持一致）。字面文本 "NULL" 不受影响。
    const isRealNull = !isInsertRowKey(rowKey)
      && getOptimisticCellValue(editState, tab.tableKey || tab.tableName, rowKey, column) == null
      && row?.[column] == null;
    editDraft.value = isRealNull ? "" : initialValue;
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
    if (isInsertRowKey(rowKey)) {
      // 新增行：仅把录入值写回草稿，不在此处自动提交。
      // 自动提交会立刻 clearInsertDraft + hideInsertRow，导致行号消失（双击录入后行不见）。
      // 保存仍走 Ctrl+S / 失焦 / 文本面板提交链路。
      const rowId = insertRowIdFromKey(tab, rowKey);
      updateInsertDraft(tab, rowId, column, draft);
      nextTick(() => gridWrapRef.value?.focus());
      return;
    }
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

  function selectInsertCell(tab, rowIdOrColumnIndex, maybeColumnIndex, options = {}) {
    if (!tab || activeColumns.value.length === 0) return;
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
    const rowAware = maybeColumnIndex != null;
    const row = rowAware ? ensureInsertRow(tab, rowIdOrColumnIndex, { create: false }) : ensureInsertRow(tab);
    if (!row) return;
    const columnIndex = rowAware ? maybeColumnIndex : rowIdOrColumnIndex;
    const clampedColumnIndex = Math.max(0, Math.min(activeColumns.value.length - 1, columnIndex));
    const column = columnName(activeColumns.value[clampedColumnIndex]);
    const rowKey = getInsertRowKey(tab, row.id);
    const editingSameCell = editingCell.value?.tabId === tab.id
      && editingCell.value?.rowKey === rowKey
      && editingCell.value?.column === column;
    if (editingCell.value && !editingSameCell) finishEditing();
    showInsertRow(tab, { rowId: row.id, ensureTrailing: false });
    const position = insertPosition(tab, row.id, clampedColumnIndex);
    selectedInsertRow.value = null;
    selectedInsertCell.value = { tabId: tab.id, rowId: row.id, columnIndex: clampedColumnIndex, column };
    selectedCell.value = { tabId: tab.id, rowKey: position.rowKey, column };
    selectedRange.value = { tabId: tab.id, anchor: position, focus: position };
    textDraft.value = editingSameCell ? editDraft.value : insertDraftValue(tab, row.id, column);
    scrollInsertCellIntoView(clampedColumnIndex, position.rowIndex, options);
    if (!editingSameCell) focusInsertInput(row.id, clampedColumnIndex);
  }

  function selectInsertRow(tab, rowId) {
    if (!tab) return;
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
    const row = ensureInsertRow(tab, rowId);
    if (editingCell.value) finishEditing();
    showInsertRow(tab, { rowId: row.id, ensureTrailing: false });
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
    if (editingCell.value) cancelEditing();
    hideInsertRow(tab, options);
    nextTick(() => gridWrapRef.value?.focus());
  }

  function handleInsertKeydown(tab, rowIdOrColumnIndex, columnIndexOrEvent, maybeEvent) {
    if (!tab || activeColumns.value.length === 0) return;
    const rowAware = maybeEvent != null;
    const row = rowAware ? ensureInsertRow(tab, rowIdOrColumnIndex) : ensureInsertRow(tab);
    const columnIndex = rowAware ? columnIndexOrEvent : rowIdOrColumnIndex;
    const event = rowAware ? maybeEvent : columnIndexOrEvent;
    const rows = getVisibleInsertRows(tab);
    const rowIndex = rows.findIndex((candidate) => candidate.id === row.id);
    const maxColumnIndex = activeColumns.value.length - 1;
    if (event?.shiftKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      const dirs = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (!selectedCell.value || selectedCell.value.tabId !== tab.id || selectedCell.value.rowKey !== getInsertRowKey(tab, row.id)) {
        selectInsertCell(tab, row.id, columnIndex);
      }
      navigateCell(...dirs[event.key], { extendRange: true });
      return;
    }
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
      const insertRows = getVisibleInsertRows(tab);
      let nextRow = insertRows[rowIndex + 1];
      if (!nextRow) {
        nextRow = createInsertRow();
        getInsertRows(tab).push(nextRow);
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
      removeInsertDraftRow(tab, row.id);
    }
  }

  function currentCellPosition(tab) {
    const cell = selectedCell.value;
    if (!tab || !cell || cell.tabId !== tab.id) return null;
    const colNames = activeColumns.value.map(columnName);
    const columnIndex = colNames.indexOf(cell.column);
    if (isInsertRowKey(cell.rowKey)) {
      const rowId = insertRowIdFromKey(tab, cell.rowKey);
      const rowIndex = visualRowIndexOfInsertRow(tab, rowId);
      if (rowIndex < 0 || columnIndex < 0) return null;
      return { rowIndex, columnIndex, rowKey: cell.rowKey, column: colNames[columnIndex] };
    }
    const dataIndex = tab.rows.findIndex((r) => buildRowKey(tab, r) === cell.rowKey);
    const rowIndex = visualRowIndexOfDataRow(tab, dataIndex);
    if (rowIndex < 0 || columnIndex < 0) return null;
    return { rowIndex, columnIndex, rowKey: cell.rowKey, column: colNames[columnIndex] };
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
    rowIndex = Math.max(0, Math.min(selectableRowCount(tab) - 1, rowIndex));
    columnIndex = Math.max(0, Math.min(colNames.length - 1, columnIndex));
    if (!wrapColumns && rowIndex === current.rowIndex && columnIndex === current.columnIndex) return null;
    return positionFromIndexes(tab, rowIndex, columnIndex)?.position || null;
  }

  function applySelectedPosition(tab, position, { extendRange = false } = {}) {
    const resolved = positionFromIndexes(tab, position.rowIndex, position.columnIndex);
    const row = resolved?.row;
    if (!row) return;
    if (extendRange && selectedRange.value?.tabId === tab.id) {
      selectedRange.value = { ...selectedRange.value, focus: position };
    } else {
      selectedRange.value = { tabId: tab.id, anchor: position, focus: position };
    }
    setSelectedCellFromPosition(tab, row, position);
    if (isInsertRowKey(position.rowKey)) {
      const rowId = insertRowIdFromKey(tab, position.rowKey);
      selectedInsertCell.value = { tabId: tab.id, rowId, columnIndex: position.columnIndex, column: position.column };
      selectedInsertRow.value = null;
      scrollInsertCellIntoView(position.columnIndex, position.rowIndex);
      focusInsertInput(rowId, position.columnIndex);
    } else {
      selectedInsertCell.value = null;
      selectedInsertRow.value = null;
      scrollCellIntoView(position.rowIndex, position.columnIndex);
    }
  }

  function navigateCell(deltaRow, deltaCol, options = {}) {
    const tab = activeTab.value;
    if (!tab?.rows?.length || activeColumns.value.length === 0) return;
    const current = currentCellPosition(tab);
    const lastDataRowIndex = visualRowIndexOfDataRow(tab, tab.rows.length - 1);
    if (!isReadOnlyTab(tab) && !options.extendRange && deltaRow > 0 && deltaCol === 0 && current?.rowIndex === lastDataRowIndex) {
      const firstTrailingRow = getVisibleInsertRows(tab).find((row) => insertRowAnchorIndex(tab, row) == null);
      if (firstTrailingRow) selectInsertCell(tab, firstTrailingRow.id, current.columnIndex);
      else selectInsertCell(tab, current.columnIndex);
      return;
    }
    if (!isReadOnlyTab(tab) && !options.extendRange && deltaRow > 0 && deltaCol === 0 && current && isInsertRowKey(current.rowKey)) {
      const rowId = insertRowIdFromKey(tab, current.rowKey);
      const currentInsertRow = getInsertRows(tab).find((row) => row.id === rowId);
      const trailingRows = getVisibleInsertRows(tab).filter((row) => insertRowAnchorIndex(tab, row) == null);
      if (currentInsertRow && insertRowAnchorIndex(tab, currentInsertRow) == null && trailingRows.at(-1)?.id === rowId) {
        const nextRow = createInsertRow();
        getInsertRows(tab).push(nextRow);
        selectInsertCell(tab, nextRow.id, current.columnIndex);
        return;
      }
    }
    const position = nextCellPosition(tab, deltaRow, deltaCol, options);
    if (!position) return;
    if (!isInsertRowKey(position.rowKey)) hideInsertRow(tab);
    applySelectedPosition(tab, position, options);
  }

  // 一屏可见的数据行数（PageUp/PageDown 用），按视口高度动态计算。
  function pageRowCount() {
    const height = gridWrapRef.value?.clientHeight || 0;
    const rows = Math.floor((height - GRID_HEADER_HEIGHT) / GRID_ROW_HEIGHT) - 1;
    return Math.max(1, Number.isFinite(rows) && rows > 0 ? rows : 20);
  }

  // Ctrl/⌘ + A：选中整个数据区域 (0,0) → (末行, 末列)。
  function selectAllCells(tab) {
    if (!tab?.rows?.length || activeColumns.value.length === 0) return;
    const anchor = positionFromIndexes(tab, 0, 0)?.position;
    const focus = positionFromIndexes(tab, tab.rows.length - 1, activeColumns.value.length - 1)?.position;
    if (!anchor || !focus) return;
    hideInsertRow(tab);
    selectedInsertCell.value = null;
    selectedInsertRow.value = null;
    if (!selectedCell.value || selectedCell.value.tabId !== tab.id || isInsertRowKey(selectedCell.value.rowKey)) {
      const resolved = positionFromIndexes(tab, 0, 0);
      if (resolved?.row) setSelectedCellFromPosition(tab, resolved.row, anchor);
    }
    selectedRange.value = { tabId: tab.id, anchor, focus };
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

  function errorMessage(error) {
    return String(error?.message || error || "未知错误");
  }

  function showCopyFeedback(tab, cell = selectedCell.value, message = "复制成功") {
    if (!tab || !cell || cell.tabId !== tab.id || !cell.rowKey || !cell.column) return;
    statusText.value = message;
    onSaveFeedback({ kind: "copy", tabId: tab.id, rowKey: cell.rowKey, column: cell.column, message });
  }

  async function commitCellValue(tab, row, column, nextValue) {
    const oldValue = String(row?.[column] ?? "");
    // Preserve a real SQL NULL: null stays null (sent as JSON null → backend
    // writes SET col = NULL). An explicit empty string stays "" (#5). Do NOT
    // collapse null into "" here.
    const value = nextValue == null ? null : String(nextValue);
    if (!tab || oldValue === value) return;
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
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
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
    if (isInsertRowKey(cell.rowKey)) {
      if (editingCell.value) {
        editDraft.value = textDraft.value;
        finishEditing();
      } else {
        updateInsertDraft(tab, insertRowIdFromKey(tab, cell.rowKey), cell.column, textDraft.value);
      }
      return await commitInsertRows(tab);
    }
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
    const keys = [];
    for (const key of Array.isArray(tab?.primaryKeys) ? tab.primaryKeys : []) {
      const normalized = String(key || "").trim();
      if (normalized && !keys.includes(normalized)) keys.push(normalized);
    }
    for (const column of activeColumns.value) {
      const name = columnName(column);
      if (isPrimaryKeyColumn(column) && name && !keys.includes(name)) keys.push(name);
    }
    return keys;
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

  function draftValuesForSave(draft) {
    return Object.fromEntries(
      Object.entries(draft || {}).map(([key, value]) => [key, String(value ?? "")]),
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
    if (!tab?.sessionId) return { ok: false, reason: "" };
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return { ok: false, reason: statusText.value };
    }
    const cleaned = cleanDraftValues(draft);
    const valuesForSave = draftValuesForSave(draft);
    if (Object.keys(cleaned).length === 0 && Object.keys(valuesForSave).length === 0) return { ok: false, reason: "" };
    const otherDrafts = getInsertRows(tab)
      .filter((candidate) => candidate.id !== rowId)
      .map((candidate) => draftValuesForSave(candidate.draft));
    const validation = validateRowDraft({
      table: tableForValidation(tab),
      rows: tab.rows || [],
      draft: valuesForSave,
      draftRows: otherDrafts,
    });
    if (!validation.valid) {
      const validationError = firstValidationError(validation);
      const reason = validationError?.message || "输入不符合字段约束";
      if (rowId && (validationError?.columnName || validationError?.code === "duplicate-primary-key")) {
        setInsertDraftValidationFeedback(tab, rowId, validationError);
        return { ok: false, reason };
      }
      statusText.value = reason;
      return { ok: false, reason };
    }
    try {
      await invokeWorkbench("insert_row", {
        request: {
          sessionId: tab.sessionId,
          draft: valuesForSave,
        },
      });
      return { ok: true, reason: "" };
    } catch (error) {
      const reason = errorMessage(error);
      statusText.value = `插入失败：${reason}`;
      return { ok: false, reason };
    }
  }

  async function commitInsertRow(tab, rowId) {
    flushEditingInsertDraft(tab);
    refreshInsertDraftPrimaryKeyFeedback(tab);
    const row = ensureInsertRow(tab, rowId);
    const draft = draftValuesForSave(row.draft);
    const result = await commitDraftObject(tab, draft, row.id);
    if (!result.ok) return false;
    promoteSavedDraft(tab, draft);
    clearInsertDraft(tab, row.id);
    if (!hasInsertDrafts(tab)) hideInsertRow(tab, { clearDraft: true });
    await nextTick();
    statusText.value = "已插入 1 行";
    return true;
  }

  async function commitInsertRows(tab) {
    if (!tab?.sessionId) return { insertedRows: 0, failedRowId: null };
    flushEditingInsertDraft(tab);
    refreshInsertDraftPrimaryKeyFeedback(tab);
    const rowsToSave = getInsertRows(tab).filter(hasDraftValues);
    const totalToSave = rowsToSave.length;
    let insertedRows = 0;
    for (const row of rowsToSave) {
      const draft = draftValuesForSave(row.draft);
      const result = await commitDraftObject(tab, draft, row.id);
      if (!result.ok) {
        selectInsertCell(tab, row.id, selectedInsertCell.value?.columnIndex ?? 0);
        return { insertedRows, failedRowId: row.id, failedReason: result.reason || statusText.value || "" };
      }
      promoteSavedDraft(tab, draft);
      clearInsertDraft(tab, row.id);
      insertedRows++;
      // 多行提交时更新进度。
      if (totalToSave > 3) {
        statusText.value = `正在保存新增行 ${insertedRows}/${totalToSave}…`;
      }
    }
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
      const result = await commitDraftObject(tab, draft, undefined);
      if (result.ok) {
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

  // Delete/Backspace 使用：清空当前选区。选中多个单元格时整块清空，
  // 否则清空单个选中单元格（Excel 式：文本→""，可空其它→NULL）。
  async function clearSelectedCells() {
    const tab = activeTab.value;
    if (!tab) return;
    if (isMultiCellRange(selectedRange.value)) {
      await clearSelectedRange(tab);
      return;
    }
    const cell = selectedCell.value;
    if (!cell || cell.tabId !== tab.id) return;
    const row = findRowByKey(tab, cell.rowKey);
    if (row) await clearCellValue(tab, row, cell.column);
  }

  // ── Grid keyboard handler ─────────────────────────────────────────────

  async function handleGridKeydown(event) {
    const tab = activeTab.value;
    if (!tab) return;

    // Clipboard shortcuts
    const key = String(event.key || "").toLowerCase();
    const isCopy = (event.ctrlKey || event.metaKey) && key === "c";
    const isPaste = (event.ctrlKey || event.metaKey) && key === "v";
    const isCut = (event.ctrlKey || event.metaKey) && key === "x";
    const isSave = (event.ctrlKey || event.metaKey) && key === "s";
    const isSelectAll = (event.ctrlKey || event.metaKey) && key === "a";

    // Ctrl+X 剪切：先复制到剪贴板，再把选中的可空、非主键单元格清为 NULL。
    if (isCut) {
      event.preventDefault();
      const writeClipboard = async (text, feedback) => {
        try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
        if (feedback) showCopyFeedback(tab, feedback.anchor, feedback.message);
      };
      if (tab.selectedRowKeys.size > 0) {
        // 整行剪切不自动清空（风险大），退化为仅复制。
        const selectedRows = tab.rows.filter((r) => tab.selectedRowKeys.has(buildRowKey(tab, r)));
        if (selectedRows.length > 0) {
          const body = matrixToTsv(selectedRows.map((row) => activeColumnNames().map((col) => displayCellValue(editState, tab, row, col))));
          await writeClipboard(body, { anchor: { tabId: tab.id, rowKey: buildRowKey(tab, selectedRows[0]), column: activeColumnNames()[0] }, message: `已复制 ${selectedRows.length} 行（整行不支持剪切清空）` });
        }
      } else if (isMultiCellRange(selectedRange.value)) {
        const matrix = getSelectedRangeMatrix(tab);
        if (matrix?.length) {
          await writeClipboard(matrixToTsv(matrix), { anchor: selectedRange.value?.anchor || null, message: `已剪切 ${matrix.length}×${matrix[0]?.length || 0} 区域` });
          if (!isReadOnlyTab(tab)) clearSelectedRange(tab);
        }
      } else if (selectedCell.value && !isInsertRowKey(selectedCell.value.rowKey)) {
        const row = rowForSelectedCell(tab, selectedCell.value);
        if (row) {
          await writeClipboard(String(displayCellValue(editState, tab, row, selectedCell.value.column) ?? ""), { anchor: selectedCell.value, message: "已剪切" });
          if (!isReadOnlyTab(tab)) await clearCellValue(tab, row, selectedCell.value.column);
        }
      }
      return;
    }

    if (isSave) {
      event.preventDefault();
      if (isReadOnlyTab(tab)) {
        setReadOnlyStatus(tab);
        return;
      }
      if (editingCell.value) {
        const editing = editingCell.value;
        finishEditing();
        if (isInsertRowKey(editing.rowKey)) return await commitInsertRows(tab);
        return;
      }
      if (selectedCell.value) return await saveTextPanel();
      if (isInsertRowVisible(tab) && hasInsertDrafts(tab)) {
        return await commitInsertRows(tab);
      }
      return;
    }

    // Ctrl/⌘ + A：选中整个数据区域（编辑中让输入框自行全选文本）。
    if (isSelectAll) {
      if (editingCell.value) return;
      event.preventDefault();
      selectAllCells(tab);
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
          const message = `已复制 ${selectedRows.length} 行`;
          const anchorRowKey = buildRowKey(tab, selectedRows[0]);
          showCopyFeedback(tab, { tabId: tab.id, rowKey: anchorRowKey, column: activeColumnNames()[0] }, message);
        }
      } else if (isMultiCellRange(selectedRange.value)) {
        const matrix = getSelectedRangeMatrix(tab);
        if (matrix?.length) {
          await navigator.clipboard.writeText(matrixToTsv(matrix));
          const message = `已复制 ${matrix.length}×${matrix[0]?.length || 0} 区域`;
          const anchor = selectedRange.value?.anchor;
          showCopyFeedback(tab, anchor ? { tabId: tab.id, rowKey: anchor.rowKey, column: anchor.column } : null, message);
        }
      } else if (selectedCell.value) {
        if (isInsertRowKey(selectedCell.value.rowKey)) {
          await navigator.clipboard.writeText(insertDraftValue(tab, selectedCell.value.rowKey, selectedCell.value.column));
          showCopyFeedback(tab);
          return;
        }
        const row = findRowByKey(tab, selectedCell.value.rowKey);
        if (row) {
          const value = displayCellValue(editState, tab, row, selectedCell.value.column);
          await navigator.clipboard.writeText(value);
          showCopyFeedback(tab);
        }
      } else if (isInsertRowVisible(tab) && selectedInsertRow.value?.tabId === tab.id) {
        await navigator.clipboard.writeText(matrixToTsv([insertDraftRow(tab, selectedInsertRow.value.rowId)]));
        statusText.value = "已复制新增行";
      } else if (isInsertRowVisible(tab) && selectedInsertCell.value?.tabId === tab.id) {
        const draft = getInsertDraft(tab, selectedInsertCell.value.rowId);
        await navigator.clipboard.writeText(String(draft[selectedInsertCell.value.column] ?? ""));
        showCopyFeedback(tab, {
          tabId: tab.id,
          rowKey: getInsertRowKey(tab, selectedInsertCell.value.rowId),
          column: selectedInsertCell.value.column,
        });
      }
      return;
    }

    if (isPaste) {
      event.preventDefault();
      if (isReadOnlyTab(tab)) {
        setReadOnlyStatus(tab);
        return;
      }
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
            if (rowIndex >= tab.rows.length) {
              const insertRow = getInsertRows(tab)[rowIndex - tab.rows.length];
              const column = activeColumns.value[columnIndex];
              if (!insertRow || !column) {
                skipped++;
                continue;
              }
              updateInsertDraft(tab, insertRow.id, columnName(column), matrix[rowOffset][colOffset]);
              continue;
            }
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
        for (let i = 0; i < validation.validEdits.length; i++) {
          const edit = validation.validEdits[i];
          await commitCellValue(tab, edit.row, edit.columnName, edit.value);
          // 大批量粘贴时周期性更新进度，避免界面像卡住。
          if (validation.validEdits.length > 8 && (i + 1) % 10 === 0) {
            statusText.value = `正在粘贴 ${i + 1}/${validation.validEdits.length}…`;
          }
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

    // Arrow key navigation. Ctrl/⌘ = 跳到数据区边缘；Shift = 扩选。
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      // While inline-editing, Left/Right must move the text caret inside the
      // input (including Ctrl+Left/Right word-jump) rather than committing the
      // edit and jumping cells (#4). Up/Down keep the "commit and move" behaviour.
      if (editingCell.value && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        return;
      }
      event.preventDefault();
      if (editingCell.value) finishEditing();
      const step = (event.ctrlKey || event.metaKey) ? EDGE_JUMP : 1;
      const dirs = {
        ArrowUp: [-step, 0],
        ArrowDown: [step, 0],
        ArrowLeft: [0, -step],
        ArrowRight: [0, step],
      };
      navigateCell(...dirs[event.key], { extendRange: event.shiftKey });
      return;
    }

    // Home/End 跳到行首/行末列；Ctrl+Home/End 跳到左上角/右下角；Shift 扩选。
    // 编辑中交给输入框处理光标（移动到文本行首/行末）。
    if (event.key === "Home") {
      if (editingCell.value) return;
      event.preventDefault();
      navigateCell((event.ctrlKey || event.metaKey) ? -EDGE_JUMP : 0, -EDGE_JUMP, { extendRange: event.shiftKey });
      return;
    }
    if (event.key === "End") {
      if (editingCell.value) return;
      event.preventDefault();
      navigateCell((event.ctrlKey || event.metaKey) ? EDGE_JUMP : 0, EDGE_JUMP, { extendRange: event.shiftKey });
      return;
    }
    if (event.key === "PageUp") {
      event.preventDefault();
      if (editingCell.value) finishEditing();
      navigateCell(-pageRowCount(), 0, { extendRange: event.shiftKey });
      return;
    }
    if (event.key === "PageDown") {
      event.preventDefault();
      if (editingCell.value) finishEditing();
      navigateCell(pageRowCount(), 0, { extendRange: event.shiftKey });
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
        const row = rowForSelectedCell(tab, selectedCell.value);
        const { rowIndex, columnIndex } = selectedCellPositionIndexes(tab, selectedCell.value);
        if (row) startEditing(tab, row, selectedCell.value.column, rowIndex, columnIndex);
      }
      return;
    }

    if (event.key === "Escape") {
      if (editingCell.value) {
        cancelEditing();
        return;
      }
      if (selectedCell.value?.tabId === tab.id && isInsertRowKey(selectedCell.value.rowKey)) {
        event.preventDefault?.();
        removeInsertDraftRow(tab, insertRowIdFromKey(tab, selectedCell.value.rowKey));
        return;
      }
      if (selectedInsertRow.value?.tabId === tab.id) {
        event.preventDefault?.();
        removeInsertDraftRow(tab, selectedInsertRow.value.rowId);
        return;
      }
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      if (editingCell.value) return;
      if (selectedCell.value?.tabId === tab.id && isInsertRowKey(selectedCell.value.rowKey)) {
        event.preventDefault?.();
        removeInsertDraftRow(tab, insertRowIdFromKey(tab, selectedCell.value.rowKey));
        return;
      }
      if (selectedInsertRow.value?.tabId === tab.id) {
        event.preventDefault?.();
        removeInsertDraftRow(tab, selectedInsertRow.value.rowId);
        return;
      }
      // 普通数据单元格：Delete/Backspace 清空内容（文本列写 ""，可空的其它
      // 类型写 NULL，不可清空的列保持不动）。选中多个单元格时整块清空。
      if (!isReadOnlyTab(tab)
        && (isMultiCellRange(selectedRange.value)
          || (selectedCell.value?.tabId === tab.id && !isInsertRowKey(selectedCell.value.rowKey)))) {
        event.preventDefault?.();
        await clearSelectedCells();
        return;
      }
      return;
    }

    if (event.key === "F2") {
      event.preventDefault();
      if (editingCell.value) {
        focusEditingInputAtEnd();
      } else if (selectedCell.value) {
        const row = rowForSelectedCell(tab, selectedCell.value);
        const { rowIndex, columnIndex } = selectedCellPositionIndexes(tab, selectedCell.value);
        if (row) startEditing(tab, row, selectedCell.value.column, rowIndex, columnIndex);
      }
      return;
    }

    // Typing a printable character starts editing
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !isReadOnlyTab(tab)) {
      if (selectedCell.value && !editingCell.value) {
        event.preventDefault();
        const row = rowForSelectedCell(tab, selectedCell.value);
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

  // ── Undo/Redo handlers live in useUndo.js (single source of truth) ─────

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
    getInsertRowKey,
    isInsertRowKey,
    getInsertRows,
    getInsertDraft,
    hasInsertDrafts,
    updateInsertDraft,
    clearInsertDraft,
    isInsertRowVisible,
    getVisibleInsertRows,
    hideInsertRow,
    visualRowEntries,
    insertAwareVisualRowIndex,
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
    // column selection
    selectColumn,
    isColumnSelected,
    // inline editing
    startEditing,
    finishEditing,
    cancelEditing,
    // navigation
    navigateCell,
    selectInsertCell,
    insertDraftAbove,
    insertPosition,
    selectInsertRow,
    removeInsertDraftRow,
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
  };
}
