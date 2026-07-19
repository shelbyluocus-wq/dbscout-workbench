import { computed, nextTick, ref } from "vue";
import {
  GRID_FIELD_COMMENT_COLLAPSED_HEIGHT,
  GRID_HEADER_HEIGHT,
  GRID_ROW_HEIGHT,
} from "../constants.js";
import {
  appendTabRows,
  mutateTabRow,
  tabRowAt,
  tabRowCount,
  tabRows,
} from "../rowStore.js";
import { columnName } from "../utils/normalize.js";
import {
  clipboardMaskIsSparse,
  clipboardMasksEqual,
  fullClipboardMask,
  tileClipboardMatrixToSelection,
  tileClipboardPayload,
} from "../utils/gridClipboardFill.js";
import {
  createGridSelection,
  gridCellCoordinateKey,
  gridSelectionActualBounds,
  gridSelectionBaseBounds,
  gridSelectionCount,
  gridSelectionIsContiguous,
  gridSelectionMask,
  gridSelectionToggleMap,
  isCoordinateInGridSelectionBase,
  isGridCellSelected,
  toggleGridSelectionCell,
} from "../utils/gridCellSelection.js";
import { getGridClipboardPayload, setGridClipboardPayload } from "../utils/gridClipboardStore.js";
import { parseGridTsv, serializeGridTsv } from "../utils/gridClipboardTsv.js";
import { resolveFieldCommentHeight, resolveGridRowHeight } from "../utils/gridRowHeight.js";
import {
  getInsertRowKey,
  gridRowKey,
  INSERT_ROW_ID_FIELD,
  insertRowIdFromKey,
  insertRowIdFromRow,
  isInsertDraftRow,
  isInsertRowKey,
} from "../utils/gridRowIdentity.js";
import { createRowIndex } from "../utils/rowIndex.js";
import { createVisualRowModel } from "../utils/visualRows.js";
import {
  clearedCellValue,
  columnConstraint,
  validateBatchEdits,
  validateCellValue,
  validateRowDraft,
} from "../utils/valueValidation.js";

const ROW_INDEX_WIDTH = 38;
const RANGE_AUTOSCROLL_EDGE = 28;
const RANGE_AUTOSCROLL_MAX_STEP = 18;
const MAX_SPARSE_CLIPBOARD_CELLS = 100_000;
const ATOMIC_BATCH_CELL_THRESHOLD = 9;
// 足够大的位移，配合 navigateCell 的 clamp 实现「跳到数据区边缘」(Ctrl+方向/Home/End)。
const EDGE_JUMP = 1_000_000;
const DUPLICATE_PRIMARY_KEY_MESSAGE = "主键重复，不能保存";
let nextInsertRowId = 1;
import { buildRowKey, buildRowIdentity, findRowByKey } from "../utils/rowIdentity.js";
import {
  startCellCommit,
  finishCellCommit,
  failCellCommit,
  discardCellCommit,
  clearCellError,
  isCellPending,
  getCellError,
  recordUndoEntry,
  startUndoGroup,
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
  const editDraftDirty = ref(false);
  const textDraft = ref("");
  const pendingInsertRows = ref(new Set());
  const insertSavePromises = new Map();
  const insertRowSavePromises = new Map();
  const latestCellCommits = new WeakMap();

  const activeColumns = computed(() => activeTab.value?.columns || []);
  const selectionToggleKeys = computed(() => new Set(gridSelectionToggleMap(selectedRange.value).keys()));
  let lastRangePointerEvent = null;
  let rangeAutoscrollFrame = 0;
  let suppressNextCellClick = false;
  let suppressNextCellClickTimer = null;
  const primaryKeyBuilders = new Map();

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
    selectedRange.value = createGridSelection(tab.id, start.position, end.position);
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
    selectedRange.value = createGridSelection(tab.id, start.position, end.position);
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
    if (!tab || selectedRange.value?.tabId !== tab.id) return false;
    return selectedColumnSet.value.has(columnIndex);
  }

  function tabScopeKey(tab) {
    return tab?.tableKey || tab?.tableName || "";
  }

  function tabDisplayName(tab) {
    return tab?.database ? `${tab.database}.${tab.tableName}` : tab?.tableName || "";
  }

  function editableCellValue(row, column) {
    const value = row?.[column];
    return value == null ? "" : String(value);
  }

  function clipboardCellValue(row, column) {
    return editableCellValue(row, column);
  }

  function syncSelectedTextDraft(tab) {
    const cell = selectedCell.value;
    if (!tab || !cell || cell.tabId !== tab.id) return;
    if (isInsertRowKey(cell.rowKey)) {
      textDraft.value = insertDraftValue(tab, cell.rowKey, cell.column);
      return;
    }
    const row = findRowByKey(tab, cell.rowKey);
    if (row) textDraft.value = editableCellValue(row, cell.column);
  }

  function setLatestCellCommit(row, column, commitId) {
    let commits = latestCellCommits.get(row);
    if (!commits) {
      commits = new Map();
      latestCellCommits.set(row, commits);
    }
    commits.set(column, commitId);
  }

  function isLatestCellCommit(row, column, commitId) {
    return latestCellCommits.get(row)?.get(column) === commitId;
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

  function isInsertDraftRowObject(row) {
    return isInsertDraftRow(row);
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
  // （>= 已加载行数，例如删除/刷新后行数变少）也视为末尾追加，
  // 与 DataGrid 的 insertRowsByAnchor 分组保持一致，避免定位与渲染错位。
  function insertRowAnchorIndex(tab, row) {
    if (row?.anchorIndex == null) return null;
    const value = Number(row.anchorIndex);
    if (!Number.isFinite(value) || value < 0) return null;
    const rowCount = tabRowCount(tab);
    return value < rowCount ? value : null;
  }

  function visualRowEntries(tab) {
    return createVisualRowModel({
      dataRowCount: tabRowCount(tab),
      dataRowAt: (dataIndex) => tabRowAt(tab, dataIndex),
      insertRows: getVisibleInsertRows(tab),
      makeInsertRow: (insertRow) => ({ ...insertRow.draft, [INSERT_ROW_ID_FIELD]: insertRow.id }),
    });
  }

  function visualRowIndexOfInsertRow(tab, rowId) {
    return visualRowEntries(tab).visualIndexOfInsert(rowId);
  }

  function visualRowIndexOfDataRow(tab, dataIndex) {
    return visualRowEntries(tab).visualIndexOfData(dataIndex);
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
      : tabRowCount(tab) + Math.max(0, insertRowIndex(tab, rowId));
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
    if (!Array.isArray(tab.insertDrafts)) tab.insertDrafts = [];
    return tab.insertDrafts;
  }

  function insertDraftSnapshot(row, index) {
    return {
      id: row.id,
      draft: { ...(row.draft || {}) },
      anchorIndex: row.anchorIndex ?? null,
      visible: row.visible !== false,
      index,
    };
  }

  function captureInsertDraftState(tab) {
    return getInsertRows(tab).map(insertDraftSnapshot);
  }

  function sameInsertDraftSnapshot(left, right) {
    if (!left || !right) return left === right;
    return left.id === right.id
      && left.anchorIndex === right.anchorIndex
      && left.visible === right.visible
      && JSON.stringify(left.draft) === JSON.stringify(right.draft);
  }

  function changedInsertDraftRows(beforeRows, afterRows) {
    const beforeById = new Map(beforeRows.map((row) => [row.id, row]));
    const afterById = new Map(afterRows.map((row) => [row.id, row]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    const changes = [];
    for (const rowId of ids) {
      const before = beforeById.get(rowId) || null;
      const after = afterById.get(rowId) || null;
      if (!sameInsertDraftSnapshot(before, after)) changes.push({ rowId, before, after });
    }
    return changes;
  }

  function recordInsertDraftHistory(tab, beforeRows, { label = "编辑新增行", cellCount = 0 } = {}) {
    const changes = changedInsertDraftRows(beforeRows, captureInsertDraftState(tab));
    if (changes.length === 0) return false;
    return recordUndoEntry(editState, {
      kind: "insert-draft-batch",
      tableName: tabScopeKey(tab),
      tabId: tab.id,
      label,
      cellCount: Math.max(0, Number(cellCount) || 0),
      changes,
    });
  }

  function pruneInsertDraftHistory(tab, rowIds = null) {
    const ids = rowIds == null
      ? null
      : new Set((Array.isArray(rowIds) ? rowIds : [rowIds]).filter(Boolean));
    for (const stack of [editState.undoStack, editState.redoStack]) {
      if (!Array.isArray(stack)) continue;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const entry = stack[index];
        if (entry?.kind !== "insert-draft-batch"
          || entry.tabId !== tab?.id
          || entry.tableName !== tabScopeKey(tab)) continue;
        if (ids) entry.changes = entry.changes.filter((change) => !ids.has(change.rowId));
        else entry.changes = [];
        if (entry.changes.length === 0) stack.splice(index, 1);
      }
    }
  }

  function reconcileInsertDraftSelection(tab) {
    const existingIds = new Set(getInsertRows(tab).map((row) => row.id));
    if (tab?.selectedRowKeys instanceof Set) {
      for (const rowKey of [...tab.selectedRowKeys]) {
        if (isInsertRowKey(rowKey) && !existingIds.has(insertRowIdFromKey(tab, rowKey))) {
          tab.selectedRowKeys.delete(rowKey);
        }
      }
    }
    const selectedRowId = selectedInsertRow.value?.tabId === tab.id ? selectedInsertRow.value.rowId : "";
    if (selectedRowId && !existingIds.has(selectedRowId)) selectedInsertRow.value = null;
    const selectedCellRowId = selectedCell.value?.tabId === tab.id && isInsertRowKey(selectedCell.value.rowKey)
      ? insertRowIdFromKey(tab, selectedCell.value.rowKey)
      : "";
    if (selectedCellRowId && !existingIds.has(selectedCellRowId)) {
      selectedCell.value = null;
      selectedRange.value = null;
      selectedInsertCell.value = null;
      editingCell.value = null;
      editDraft.value = "";
      textDraft.value = "";
    } else {
      syncSelectedTextDraft(tab);
    }
  }

  function applyInsertDraftHistoryEntry(entry, direction) {
    const tab = activeTab.value;
    if (!tab || entry?.kind !== "insert-draft-batch"
      || entry.tabId !== tab.id
      || entry.tableName !== tabScopeKey(tab)) {
      return { ok: false, reason: "当前表不匹配" };
    }
    const targetField = direction === "redo" ? "after" : "before";
    const changedIds = new Set(entry.changes.map((change) => change.rowId));
    const rows = getInsertRows(tab);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (changedIds.has(rows[index].id)) rows.splice(index, 1);
    }
    const targets = entry.changes
      .map((change) => change[targetField])
      .filter(Boolean)
      .sort((left, right) => left.index - right.index);
    for (const target of targets) {
      const restored = {
        id: target.id,
        draft: { ...(target.draft || {}) },
        anchorIndex: target.anchorIndex ?? null,
        visible: target.visible !== false,
      };
      rows.splice(Math.max(0, Math.min(rows.length, target.index)), 0, restored);
    }
    reconcileInsertDraftSelection(tab);
    refreshInsertDraftPrimaryKeyFeedback(tab);
    return {
      ok: true,
      count: entry.cellCount || entry.changes.length,
      label: entry.label || "新增行编辑",
    };
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

  function insertSavingKey(tab, rowId) {
    return `${tab?.id || ""}:${rowId || ""}`;
  }

  function markInsertRowSaving(tab, rowId, saving) {
    const next = new Set(pendingInsertRows.value);
    const key = insertSavingKey(tab, rowId);
    if (saving) next.add(key);
    else next.delete(key);
    pendingInsertRows.value = next;
  }

  function isInsertRowSaving(tab, rowId) {
    return pendingInsertRows.value.has(insertSavingKey(tab, rowId));
  }

  function rejectInsertRowMutationWhileSaving(tab, rowId) {
    if (!isInsertRowSaving(tab, rowId)) return false;
    statusText.value = "新增行正在保存，请稍候";
    return true;
  }

  function hasDraftInput(row) {
    return Object.keys(row?.draft || {}).length > 0;
  }

  function hasInsertDrafts(tab) {
    return getInsertRows(tab).some(hasDraftInput);
  }

  function firstEditableColumnIndex() {
    const cols = activeColumns.value;
    // 只跳过由数据库生成的列。普通/复合主键必须允许用户从第一列录入，
    // 否则整行 TSV 粘贴会错位并把必填主键留空。
    const editable = cols.findIndex((col) => !isDatabaseGeneratedColumn(col));
    if (editable >= 0) return editable;
    return 0;
  }

  function resolveInsertTarget(tab, target) {
    if (target == null) return null;
    const row = target && typeof target === "object" && "row" in target ? target.row : null;
    if (isInsertDraftRowObject(row)) {
      const rowId = insertRowIdFromRow(row);
      const insertRow = getInsertRows(tab).find((candidate) => candidate.id === rowId);
      if (insertRow) return { type: "insert", insertRow, storageIndex: getInsertRows(tab).indexOf(insertRow) };
    }
    if (row) {
      const dataIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(buildRowKey(tab, row));
      if (dataIndex >= 0) return { type: "data", dataIndex };
    }
    const value = Number(target && typeof target === "object" ? target.rowIndex : target);
    if (Number.isInteger(value) && value >= 0 && value < tabRowCount(tab)) {
      return { type: "data", dataIndex: value };
    }
    return null;
  }

  function insertDraftRelative(tab, target, direction) {
    if (!tab?.id) return;
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
    const beforeRows = captureInsertDraftState(tab);
    const rows = getInsertRows(tab);
    const resolved = resolveInsertTarget(tab, target);
    let anchorIndex = null;
    let storageIndex = rows.length;
    if (resolved?.type === "insert") {
      anchorIndex = insertRowAnchorIndex(tab, resolved.insertRow);
      storageIndex = resolved.storageIndex + (direction === "below" ? 1 : 0);
    } else if (resolved?.type === "data") {
      const targetDataIndex = resolved.dataIndex;
      anchorIndex = direction === "above" ? targetDataIndex : targetDataIndex + 1;
      if (anchorIndex >= tabRowCount(tab)) anchorIndex = null;
      const matchingIndexes = rows
        .map((row, index) => (insertRowAnchorIndex(tab, row) === anchorIndex ? index : -1))
        .filter((index) => index >= 0);
      if (matchingIndexes.length > 0) {
        storageIndex = direction === "above" ? matchingIndexes.at(-1) + 1 : matchingIndexes[0];
      }
    }
    const newRow = createInsertRow(anchorIndex);
    rows.splice(storageIndex, 0, newRow);
    recordInsertDraftHistory(tab, beforeRows, { label: "新增行" });
    const columnIndex = firstEditableColumnIndex();
    selectInsertCell(tab, newRow.id, columnIndex, { scrollColumn: false });
    return newRow;
  }

  function insertDraftAbove(tab, target) {
    return insertDraftRelative(tab, target, "above");
  }

  function insertDraftBelow(tab, target) {
    return insertDraftRelative(tab, target, "below");
  }

  function getInsertDraft(tab, rowId) {
    if (!tab?.id) return {};
    if (rowId) return ensureInsertRow(tab, rowId, { visible: false }).draft;
    return getVisibleInsertRows(tab).at(-1)?.draft || {};
  }

  function applyInsertDraftValue(tab, row, column, value, {
    updateSelection = true,
    columnIndex = activeColumnNames().indexOf(column),
  } = {}) {
    if (!row || rejectInsertRowMutationWhileSaving(tab, row.id)) return false;
    row.draft[column] = String(value ?? "");
    const rowKey = getInsertRowKey(tab, row.id);
    if (updateSelection) {
      const position = insertPosition(tab, row.id, Math.max(0, columnIndex));
      if (!selectedCell.value && !selectedInsertRow.value) {
        selectedInsertCell.value = { tabId: tab.id, rowId: row.id, columnIndex, column };
        selectedCell.value = { tabId: tab.id, rowKey, column };
        selectedRange.value = createGridSelection(tab.id, position);
      }
      if (selectedInsertCellMatches(tab, row.id, column)) textDraft.value = String(value ?? "");
    }
    clearCellError(editState, tabScopeKey(tab), rowKey, column);
    return true;
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
    applyInsertDraftValue(tab, row, column, value);
    refreshInsertDraftPrimaryKeyFeedback(tab);
  }

  function clearInsertDraft(tab, rowId) {
    if (!tab?.id) return;
    if (!rowId) {
      pruneInsertDraftHistory(tab);
      getInsertRows(tab).splice(0);
      selectedInsertCell.value = null;
      selectedInsertRow.value = null;
      selectedCell.value = null;
      selectedRange.value = null;
      editingCell.value = null;
      editDraft.value = "";
      textDraft.value = "";
      return;
    }
    pruneInsertDraftHistory(tab, rowId);
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
    return removeInsertDraftRows(tab, [rowId]) > 0;
  }

  function removeInsertDraftRows(tab, rowIds, options = {}) {
    const ids = new Set((Array.isArray(rowIds) ? rowIds : [rowIds]).filter(Boolean));
    if (!tab?.id || ids.size === 0) return 0;
    for (const rowId of ids) {
      if (rejectInsertRowMutationWhileSaving(tab, rowId)) return 0;
    }
    const beforeRows = captureInsertDraftState(tab);
    const rows = getInsertRows(tab);
    let removed = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (!ids.has(rows[index].id)) continue;
      rows.splice(index, 1);
      removed += 1;
    }
    if (removed === 0) return 0;
    if (options.recordHistory === false) pruneInsertDraftHistory(tab, [...ids]);
    else recordInsertDraftHistory(tab, beforeRows, { label: "移除新增行" });
    reconcileInsertDraftSelection(tab);
    selectedCell.value = null;
    selectedRange.value = null;
    selectedInsertCell.value = null;
    selectedInsertRow.value = null;
    editingCell.value = null;
    editDraft.value = "";
    textDraft.value = "";
    if (options.updateStatus !== false) {
      statusText.value = removed > 1 ? `已移除 ${removed} 条新增未保存行` : "已移除新增未保存行";
    }
    if (options.refocus !== false) nextTick(() => gridWrapRef.value?.focus());
    return removed;
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
    clearColumnSelection();
    const colNames = activeColumns.value.map(columnName);
    const resolvedRowIndex = rowIndex ?? (
      isInsertDraftRowObject(row)
        ? tabRowCount(tab) + Math.max(0, insertRowIndex(tab, insertRowIdFromRow(row)))
        : createRowIndex(tab, { buildRowKey }).indexOfKey(buildRowKey(tab, row))
    );
    const resolvedColumnIndex = columnIndex ?? colNames.indexOf(column);
    const position = cellPosition(tab, row, column, resolvedRowIndex, resolvedColumnIndex);
    selectedRange.value = createGridSelection(tab.id, position);
  }

  function getRangeBounds(range) {
    return gridSelectionBaseBounds(range);
  }

  function isCellInSelectedRange(tab, rowKey, column, rowIndex, columnIndex) {
    const range = selectedRange.value;
    if (!tab || !range || range.tabId !== tab.id) return false;
    return isGridCellSelected(range, rowIndex, columnIndex, selectionToggleKeys.value);
  }

  function getCellRangeClasses(tab, rowKey, column, rowIndex, columnIndex) {
    const inRange = isCellInSelectedRange(tab, rowKey, column, rowIndex, columnIndex);
    const range = selectedRange.value;
    if (!inRange || !range) return {
      "range-selected": false,
      "range-top": false,
      "range-bottom": false,
      "range-left": false,
      "range-right": false,
      "range-anchor": false,
      "range-discrete": false,
    };
    const isAnchor =
      range.shiftAnchor?.rowIndex === rowIndex &&
      range.shiftAnchor?.columnIndex === columnIndex;
    const selectedAt = (nextRow, nextColumn) => isGridCellSelected(
      range,
      nextRow,
      nextColumn,
      selectionToggleKeys.value,
    );
    const classes = {
      "range-selected": inRange,
      "range-top": !selectedAt(rowIndex - 1, columnIndex),
      "range-bottom": !selectedAt(rowIndex + 1, columnIndex),
      "range-left": !selectedAt(rowIndex, columnIndex - 1),
      "range-right": !selectedAt(rowIndex, columnIndex + 1),
      "range-anchor": isAnchor,
    };
    const baseBounds = gridSelectionBaseBounds(range);
    const singletonBaseWithToggles = baseBounds
      && baseBounds.top === baseBounds.bottom
      && baseBounds.left === baseBounds.right
      && (range.toggledCells?.length || 0) > 0;
    if (singletonBaseWithToggles || !isCoordinateInGridSelectionBase(range, rowIndex, columnIndex)) {
      classes["range-discrete"] = true;
    }
    return classes;
  }

  function setSelectedCellFromPosition(tab, row, position) {
    selectedCell.value = { tabId: tab.id, rowKey: position.rowKey, column: position.column };
    textDraft.value = isInsertRowKey(position.rowKey)
      ? insertDraftValue(tab, position.rowKey, position.column)
      : editableCellValue(row, position.column);
  }

  function firstSelectedPosition(tab, selection = selectedRange.value) {
    const bounds = gridSelectionActualBounds(selection);
    if (!tab || !selection || !bounds) return null;
    const toggleKeys = new Set(gridSelectionToggleMap(selection).keys());
    for (let rowIndex = bounds.top; rowIndex <= bounds.bottom; rowIndex++) {
      for (let columnIndex = bounds.left; columnIndex <= bounds.right; columnIndex++) {
        if (!isGridCellSelected(selection, rowIndex, columnIndex, toggleKeys)) continue;
        const resolved = positionFromIndexes(tab, rowIndex, columnIndex);
        if (resolved) return resolved;
      }
    }
    return null;
  }

  function setActiveSelectionPosition(tab, resolved) {
    if (!resolved?.row || !resolved.position) return;
    const { position, row } = resolved;
    setSelectedCellFromPosition(tab, row, position);
    if (isInsertRowKey(position.rowKey)) {
      const rowId = insertRowIdFromKey(tab, position.rowKey);
      selectedInsertCell.value = { tabId: tab.id, rowId, columnIndex: position.columnIndex, column: position.column };
      selectedInsertRow.value = null;
    } else {
      selectedInsertCell.value = null;
      selectedInsertRow.value = null;
    }
  }

  function positionFromIndexes(tab, rowIndex, columnIndex) {
    const column = activeColumns.value[columnIndex];
    const name = columnName(column);
    if (!tab || !name) return null;
    const entry = visualRowEntries(tab).at(rowIndex);
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
    selectedRange.value = createGridSelection(tab.id, range.anchor, resolved.position, {
      shiftAnchor: range.shiftAnchor || range.anchor,
      toggledCells: range.toggledCells || [],
    });
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
    const fieldCommentBandHeight = tab?.fieldCommentsExpanded === false
      ? GRID_FIELD_COMMENT_COLLAPSED_HEIGHT
      : resolveFieldCommentHeight(tab);
    const headerBandHeight = GRID_HEADER_HEIGHT + fieldCommentBandHeight;
    const y = clientY - rect.top + wrap.scrollTop - headerBandHeight;
    return Math.max(0, Math.min(tabRowCount(tab) - 1, Math.floor(y / resolveGridRowHeight(tab))));
  }

  function updateRangeFocusFromPointer(event) {
    const tab = activeTab.value;
    const wrap = gridWrapRef.value;
    const range = selectedRange.value;
    if (!tab || !wrap || !range || range.tabId !== tab.id || tabRowCount(tab) === 0 || activeColumns.value.length === 0) return;
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

  function captureTableViewSelection() {
    return {
      selectedCell: selectedCell.value,
      selectedRange: selectedRange.value,
      selectedInsertCell: selectedInsertCell.value,
      selectedInsertRow: selectedInsertRow.value,
      textDraft: textDraft.value,
    };
  }

  function restoreTableViewSelection(state = null) {
    selectedCell.value = state?.selectedCell || null;
    selectedRange.value = state?.selectedRange || null;
    selectedInsertCell.value = state?.selectedInsertCell || null;
    selectedInsertRow.value = state?.selectedInsertRow || null;
    textDraft.value = String(state?.textDraft || "");
    editingCell.value = null;
    editDraft.value = "";
    isSelectingRange.value = false;
    lastRangePointerEvent = null;
    clearColumnSelection();
    stopRangeAutoscroll();
  }

  function focusTextCell(tab, row, column) {
    saveTextPanel();
    clearColumnSelection();
    const rowKey = buildRowKey(tab, row);
    clearCellError(editState, tabScopeKey(tab), rowKey, column);
    selectedCell.value = { tabId: tab.id, rowKey, column };
    textDraft.value = editableCellValue(row, column);
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

  function consumeCellPointerClick() {
    if (!suppressNextCellClick) return false;
    suppressNextCellClick = false;
    if (suppressNextCellClickTimer != null) clearTimeout(suppressNextCellClickTimer);
    suppressNextCellClickTimer = null;
    return true;
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
    if (selectedColumnSet.value.size > 0) {
      clearColumnSelection();
      selectedRange.value = null;
    }
    if (suppressNextCellClickTimer != null) clearTimeout(suppressNextCellClickTimer);
    suppressNextCellClickTimer = null;
    suppressNextCellClick = true;
    if (editingCell.value) finishEditing();
    const insertCell = isInsertDraftRowObject(row);
    if (!insertCell) {
      hideInsertRow(tab);
    } else {
      const rowId = insertRowIdFromRow(row);
      showInsertRow(tab, { rowId, ensureTrailing: false });
      selectedInsertCell.value = { tabId: tab.id, rowId, columnIndex, column };
      selectedInsertRow.value = null;
    }
    const position = cellPosition(tab, row, column, rowIndex, columnIndex);
    const shiftSelect = Boolean(event?.shiftKey && !insertCell);
    const toggleSelect = Boolean((event?.ctrlKey || event?.metaKey) && !event?.shiftKey && !insertCell);

    if (shiftSelect) {
      const anchor = selectedRange.value?.tabId === tab.id
        ? selectedRange.value.shiftAnchor || selectedRange.value.anchor
        : position;
      selectedRange.value = createGridSelection(tab.id, anchor, position, { shiftAnchor: anchor });
      isSelectingRange.value = true;
      setActiveSelectionPosition(tab, { row, position });
    } else if (toggleSelect) {
      const toggledActiveCell = selectedCell.value?.tabId === tab.id
        && selectedCell.value?.rowKey === position.rowKey
        && selectedCell.value?.column === position.column;
      const result = toggleGridSelectionCell(selectedRange.value, tab.id, position);
      selectedRange.value = result.selection;
      isSelectingRange.value = false;
      if (!result.selection) {
        selectedCell.value = null;
        selectedInsertCell.value = null;
        selectedInsertRow.value = null;
        textDraft.value = "";
      } else if (result.selected) {
        result.selection.shiftAnchor = { ...position };
        setActiveSelectionPosition(tab, { row, position });
      } else if (toggledActiveCell) {
        const fallback = firstSelectedPosition(tab, result.selection);
        if (fallback) {
          result.selection.shiftAnchor = { ...fallback.position };
          setActiveSelectionPosition(tab, fallback);
        }
      }
    } else {
      selectedRange.value = createGridSelection(tab.id, position);
      isSelectingRange.value = !insertCell;
      setActiveSelectionPosition(tab, { row, position });
    }
    nextTick(() => gridWrapRef.value?.focus());
  }

  function extendRangeSelection(tab, row, column, rowIndex, columnIndex) {
    const range = selectedRange.value;
    if (!isSelectingRange.value || !range || range.tabId !== tab.id) return;
    const position = cellPosition(tab, row, column, rowIndex, columnIndex);
    selectedRange.value = createGridSelection(tab.id, range.anchor, position, {
      shiftAnchor: range.shiftAnchor || range.anchor,
      toggledCells: range.toggledCells || [],
    });
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
    if (suppressNextCellClickTimer != null) clearTimeout(suppressNextCellClickTimer);
    suppressNextCellClickTimer = setTimeout(() => {
      suppressNextCellClick = false;
      suppressNextCellClickTimer = null;
    }, 0);
  }

  function isMultiCellRange(range) {
    return gridSelectionCount(range) > 1;
  }

  function activeColumnNames() {
    return activeColumns.value.map(columnName);
  }

  function selectedWholeRows(tab) {
    const selectedKeys = tab?.selectedRowKeys;
    if (!(selectedKeys instanceof Set) || selectedKeys.size === 0) return [];
    return visualRowEntries(tab).map((entry) => ({
      entry,
      row: entry.type === "insert" ? entry.insertRow?.draft || {} : entry.row,
      rowKey: gridRowKey(tab, entry.row),
    })).filter((item) => selectedKeys.has(item.rowKey));
  }

  function columnsForTab(tab) {
    return Array.isArray(tab?.columns) ? tab.columns : activeColumns.value;
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
    if (activeTab.value?.id === tab.id) {
      selectInsertCell(tab, rowId, Math.max(0, activeColumnNames().indexOf(columns[0])));
    }
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

    const loadedIndex = createRowIndex(tab, {
      buildRowKey: primaryKeyBuilder(keys),
    });
    const draftGroups = new Map();
    for (const row of rows) {
      const signature = primaryKeySignature(cleanDraftValues(row.draft), keys);
      if (!signature) continue;
      if (!draftGroups.has(signature)) draftGroups.set(signature, []);
      draftGroups.get(signature).push(row);
    }

    const duplicateRows = new Set();
    for (const [signature, group] of draftGroups.entries()) {
      if (loadedIndex.hasPrimaryKeySignature(signature) || group.length > 1) {
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

  function cloneClipboardMatrix(matrix) {
    return matrix.map((row) => row.map((value) => String(value ?? "")));
  }

  async function writeGridClipboard(text, payload = null) {
    await navigator.clipboard.writeText(text);
    setGridClipboardPayload(text, payload);
  }

  async function writeGridMatrix(matrix, payload = {}) {
    const copiedMatrix = cloneClipboardMatrix(matrix);
    await writeGridClipboard(serializeGridTsv(copiedMatrix), { ...payload, matrix: copiedMatrix });
  }

  function copiedFullRowPayload(text, matrix) {
    const payload = getGridClipboardPayload(text);
    return payload?.kind === "full-row"
      && Array.isArray(payload.columnNames)
      && payload.columnNames.length > 0
      && matrix.length > 0
      && matrix.every((row) => row.length === payload.columnNames.length)
      ? payload
      : null;
  }

  function clipboardShapeLabel(shape) {
    return `${shape.rowCount}×${shape.columnCount}`;
  }

  function clipboardFillErrorMessage(result, hasSelectedTarget = false) {
    const selectedTarget = result.selection || result.target;
    const targetExpanded = hasSelectedTarget
      && (selectedTarget.rowCount !== result.target.rowCount
        || selectedTarget.columnCount !== result.target.columnCount);
    const targetDescription = hasSelectedTarget
      ? `，目标选区为 ${clipboardShapeLabel(selectedTarget)}${targetExpanded ? `（粘贴范围扩展为 ${clipboardShapeLabel(result.target)}）` : ""}`
      : "";
    if (result.reason === "irregular-source") {
      const rowWidths = result.source.columnCounts
        .map((count) => count < 0 ? "无效" : count)
        .join("/");
      return `无法粘贴：剪贴板数据不是规则矩形（${result.source.rowCount} 行，各行 ${rowWidths || 0} 列）${targetDescription}`;
    }
    if (result.reason === "incompatible-size") {
      return `无法粘贴：剪贴板为 ${clipboardShapeLabel(result.source)}${targetDescription}；目标行列必须分别是剪贴板的整数倍`;
    }
    return "无法粘贴：目标选区无效";
  }

  function insertDraftRow(tab, rowId) {
    const draft = getInsertDraft(tab, rowId);
    return activeColumnNames().map((col) => draft[col] ?? "");
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
    const dataIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(cell.rowKey);
    return {
      rowIndex: visualRowIndexOfDataRow(tab, dataIndex),
      columnIndex,
    };
  }

  function selectedGridCells(tab, range = selectedRange.value) {
    if (!tab || !range || range.tabId !== tab.id) return [];
    const bounds = gridSelectionActualBounds(range);
    if (!bounds) return [];
    const toggleKeys = new Set(gridSelectionToggleMap(range).keys());
    const colNames = activeColumnNames();
    const model = visualRowEntries(tab);
    const cells = [];
    for (let rowIndex = bounds.top; rowIndex <= bounds.bottom; rowIndex++) {
      const entry = model.at(rowIndex);
      if (!entry) continue;
      for (let columnIndex = bounds.left; columnIndex <= bounds.right; columnIndex++) {
        if (!isGridCellSelected(range, rowIndex, columnIndex, toggleKeys)) continue;
        const column = colNames[columnIndex];
        if (!column) continue;
        cells.push({ entry, rowIndex, columnIndex, column });
      }
    }
    return cells;
  }

  function getSelectedClipboardData(tab) {
    const range = selectedRange.value;
    if (!tab || !range || range.tabId !== tab.id) return null;
    const bounds = gridSelectionActualBounds(range);
    if (!bounds) return null;
    const rowCount = bounds.bottom - bounds.top + 1;
    const columnCount = bounds.right - bounds.left + 1;
    const selectedCount = gridSelectionCount(range);
    const sparse = !gridSelectionIsContiguous(range);
    if (sparse && rowCount * columnCount > MAX_SPARSE_CLIPBOARD_CELLS) {
      return { ok: false, reason: "sparse-too-large", bounds, rowCount, columnCount, selectedCount, sparse };
    }

    const mask = gridSelectionMask(range, bounds);
    const colNames = activeColumnNames();
    const model = visualRowEntries(tab);
    const matrix = Array.from({ length: rowCount }, (_, rowOffset) => {
      const entry = model.at(bounds.top + rowOffset);
      return Array.from({ length: columnCount }, (_, columnOffset) => {
        if (!mask[rowOffset][columnOffset] || !entry) return "";
        const column = colNames[bounds.left + columnOffset];
        if (!column) return "";
        return entry.type === "insert"
          ? String(entry.insertRow?.draft?.[column] ?? "")
          : clipboardCellValue(entry.row, column);
      });
    });
    return { ok: true, matrix, mask, bounds, rowCount, columnCount, selectedCount, sparse };
  }

  // 按 Excel 语义清空一个数据单元格：用户操作统一写空字符串，绝不把空白
  // 静默转换成 SQL NULL；不可清空的列保持不动。
  async function clearCellValue(tab, row, column, options = {}) {
    const meta = activeColumns.value.find((item) => columnName(item) === column);
    if (!meta) return { ok: true, changed: false };
    const cleared = clearedCellValue(meta);
    if (!cleared.canClear) return { ok: true, changed: false };
    return await commitCellValue(tab, row, column, cleared.value, options);
  }

  function clearInsertDraftCell(tab, insertRow, column, columnIndex = activeColumnNames().indexOf(column)) {
    const meta = activeColumns.value[columnIndex];
    if (!insertRow || !meta) return false;
    if (rejectInsertRowMutationWhileSaving(tab, insertRow.id)) return false;
    const cleared = clearedCellValue(meta);
    if (!cleared.canClear) return false;
    delete insertRow.draft[column];
    clearCellError(editState, tabScopeKey(tab), getInsertRowKey(tab, insertRow.id), column);
    if (selectedInsertCellMatches(tab, insertRow.id, column)) {
      textDraft.value = String(insertRow.draft[column] ?? "");
    }
    return true;
  }

  // 把最终有效选区内所有可清空、非主键单元格清空（剪切 / Delete 时使用）。
  async function clearSelectedRange(tab) {
    const range = selectedRange.value;
    if (!tab || !range || range.tabId !== tab.id) return;
    const beforeInsertRows = captureInsertDraftState(tab);
    const edits = [];
    let clearedDrafts = 0;
    for (const { entry, columnIndex, column } of selectedGridCells(tab, range)) {
      if (entry.type === "insert") {
        if (clearInsertDraftCell(tab, entry.insertRow, column, columnIndex)) clearedDrafts++;
        continue;
      }
      if (entry.type !== "data" || !entry.row) continue;
      const meta = activeColumns.value[columnIndex];
      const cleared = clearedCellValue(meta);
      if (cleared.canClear) edits.push({ row: entry.row, column, value: cleared.value });
    }
    if (clearedDrafts > 0) {
      recordInsertDraftHistory(tab, beforeInsertRows, {
        label: "清空新增行单元格",
        cellCount: clearedDrafts,
      });
    }
    if (edits.length === 0) {
      if (clearedDrafts > 0) statusText.value = `已清空 ${clearedDrafts} 个单元格`;
      return { ok: true, successCount: clearedDrafts, failureCount: 0 };
    }
    return await commitCellBatch(tab, edits, {
      successMessage: (count) => `已清空 ${count + clearedDrafts} 个单元格`,
      failureLabel: "批量清空保存",
    });
  }

  function rangeStartPosition(tab) {
    const range = selectedRange.value;
    if (range?.tabId === tab?.id) return currentCellPosition(tab) || range.shiftAnchor || range.anchor;
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
    if (isInsertDraftRowObject(row) && rejectInsertRowMutationWhileSaving(tab, insertRowIdFromRow(row))) {
      editingCell.value = null;
      return;
    }
    const rowKey = isInsertDraftRowObject(row) ? getInsertRowKey(tab, insertRowIdFromRow(row)) : buildRowKey(tab, row);
    clearCellError(editState, tabScopeKey(tab), rowKey, column);
    selectedCell.value = { tabId: tab.id, rowKey, column };
    collapseRangeToCell(tab, row, column, rowIndex, columnIndex);
    editingCell.value = { tabId: tab.id, rowKey, column };
    editDraft.value = isInsertRowKey(rowKey)
      ? insertDraftValue(tab, rowKey, column)
      : editableCellValue(row, column);
    editDraftDirty.value = false;
    textDraft.value = editDraft.value;
    focusEditingInputAtEnd();
  }

  function updateEditDraft(value) {
    editDraft.value = String(value ?? "");
    textDraft.value = editDraft.value;
    editDraftDirty.value = true;
  }

  function finishEditing(options = {}) {
    if (!editingCell.value) return;
    const tab = activeTab.value;
    if (!tab) { editingCell.value = null; return; }
    const { rowKey, column } = editingCell.value;
    const draft = editDraft.value;
    const dirty = editDraftDirty.value;
    const rangeAtCommit = selectedRange.value;
    editingCell.value = null;
    editDraftDirty.value = false;
    if (isInsertRowKey(rowKey)) {
      // 新增行：仅把录入值写回草稿，不在此处自动提交。
      // 自动提交会立刻 clearInsertDraft + hideInsertRow，导致行号消失（双击录入后行不见）。
      // 保存仍走 Ctrl+S / 失焦 / 文本面板提交链路。
      const rowId = insertRowIdFromKey(tab, rowKey);
      if (dirty || draft !== insertDraftValue(tab, rowKey, column)) {
        const beforeRows = captureInsertDraftState(tab);
        updateInsertDraft(tab, rowId, column, draft);
        recordInsertDraftHistory(tab, beforeRows, { label: "编辑新增行", cellCount: 1 });
      }
      if (!options.skipRefocus) nextTick(() => gridWrapRef.value?.focus());
      return;
    }
    const row = findRowByKey(tab, rowKey);
    let commitResult;
    const changedFromLoadedValue = row && draft !== editableCellValue(row, column);
    if (row && (dirty || changedFromLoadedValue)) {
      if (rangeAtCommit?.tabId === tab.id && isMultiCellRange(rangeAtCommit)) {
        commitResult = commitValueToSelectedRange(tab, rangeAtCommit, draft);
      } else {
        const current = editableCellValue(row, column);
        if (draft !== current) commitResult = commitCellValue(tab, row, column, draft);
      }
    }
    if (!options.skipRefocus) nextTick(() => gridWrapRef.value?.focus());
    return commitResult;
  }

  function selectedRangeEdits(tab, range, value) {
    if (!tab || !range || range.tabId !== tab.id) return [];
    const edits = [];
    for (const { entry, column } of selectedGridCells(tab, range)) {
      if (entry.type !== "data" || !entry.row) continue;
      edits.push({ row: entry.row, column, value });
    }
    return edits;
  }

  function commitValueToSelectedRange(tab, range, value) {
    return commitCellBatch(tab, selectedRangeEdits(tab, range, value), {
      successMessage: (count) => `已保存 ${count} 个单元格`,
      failureLabel: "批量保存",
    });
  }

  function cancelEditing(options = {}) {
    editingCell.value = null;
    editDraftDirty.value = false;
    if (!options.skipRefocus) nextTick(() => gridWrapRef.value?.focus());
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
    clearColumnSelection();
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
    selectedRange.value = createGridSelection(tab.id, position);
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
    clearColumnSelection();
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
    if (!selectedCell.value
      || selectedCell.value.tabId !== tab.id
      || selectedCell.value.rowKey !== getInsertRowKey(tab, row.id)
      || selectedCell.value.column !== columnName(activeColumns.value[columnIndex])) {
      selectInsertCell(tab, row.id, columnIndex);
    }
    if (event && typeof event.preventDefault !== "function") event.preventDefault = () => {};
    return handleGridKeydown(event || {});
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
    const dataIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(cell.rowKey);
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
    const leavingInsertCell = selectedCell.value?.tabId === tab.id
      && isInsertRowKey(selectedCell.value.rowKey)
      && !isInsertRowKey(position.rowKey);
    clearColumnSelection();
    const resolved = positionFromIndexes(tab, position.rowIndex, position.columnIndex);
    const row = resolved?.row;
    if (!row) return;
    if (extendRange && selectedRange.value?.tabId === tab.id) {
      const anchor = selectedRange.value.shiftAnchor || selectedRange.value.anchor;
      selectedRange.value = createGridSelection(tab.id, anchor, position, { shiftAnchor: anchor });
    } else {
      selectedRange.value = createGridSelection(tab.id, position);
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
      if (leavingInsertCell) nextTick(() => gridWrapRef.value?.focus());
    }
  }

  function navigateCell(deltaRow, deltaCol, options = {}) {
    const tab = activeTab.value;
    if (tabRowCount(tab) === 0 || activeColumns.value.length === 0) return;
    const current = currentCellPosition(tab);
    const lastDataRowIndex = visualRowIndexOfDataRow(tab, tabRowCount(tab) - 1);
    if (!isReadOnlyTab(tab) && !options.extendRange && deltaRow > 0 && deltaCol === 0 && current?.rowIndex === lastDataRowIndex) {
      const firstTrailingRow = getVisibleInsertRows(tab).find((row) => insertRowAnchorIndex(tab, row) == null);
      if (firstTrailingRow) selectInsertCell(tab, firstTrailingRow.id, current.columnIndex);
      else selectInsertCell(tab, current.columnIndex);
      return;
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
    if (tabRowCount(tab) === 0 || activeColumns.value.length === 0) return;
    const firstDataRow = visualRowIndexOfDataRow(tab, 0);
    const lastDataRow = visualRowIndexOfDataRow(tab, tabRowCount(tab) - 1);
    const anchor = positionFromIndexes(tab, firstDataRow, 0)?.position;
    const focus = positionFromIndexes(tab, lastDataRow, activeColumns.value.length - 1)?.position;
    if (!anchor || !focus) return;
    clearColumnSelection();
    hideInsertRow(tab);
    selectedInsertCell.value = null;
    selectedInsertRow.value = null;
    if (!selectedCell.value || selectedCell.value.tabId !== tab.id || isInsertRowKey(selectedCell.value.rowKey)) {
      const resolved = positionFromIndexes(tab, firstDataRow, 0);
      if (resolved?.row) setSelectedCellFromPosition(tab, resolved.row, anchor);
    }
    selectedRange.value = createGridSelection(tab.id, anchor, focus);
  }

  // ── Cell commits ──────────────────────────────────────────────────────

  function tableForValidation(tab) {
    return {
      table_name: tab?.tableName || "",
      columns: columnsForTab(tab),
      primaryKeys: primaryKeyColumns(tab),
    };
  }

  function firstValidationError(result) {
    return result?.errors?.[0] || null;
  }

  function cellErrorKey(tab, rowKey, column) {
    return [tabScopeKey(tab), rowKey, column].map((value) => String(value ?? "")).join("\x1f");
  }

  function setValidationFeedback(tab, rowKey, column, validationError, options = {}) {
    const { showFeedback = true, updateStatus = true } = options;
    const message = validationError?.message || "输入不符合字段约束";
    const shortMessage = validationError?.shortMessage || "格式错误";
    if (updateStatus) statusText.value = message;
    if (rowKey && column) {
      editState.cellErrors.set(cellErrorKey(tab, rowKey, column), message);
      if (showFeedback) onSaveFeedback({ kind: "error", tabId: tab.id, rowKey, column, message: shortMessage });
    }
    return message;
  }

  function errorMessage(error) {
    return String(error?.message || error || "未知错误");
  }

  function showCopyFeedback(tab, cell = selectedCell.value, message = "复制成功") {
    if (!tab || !cell || cell.tabId !== tab.id || !cell.rowKey || !cell.column) return;
    statusText.value = message;
    onSaveFeedback({ kind: "copy", tabId: tab.id, rowKey: cell.rowKey, column: cell.column, message });
  }

  function showEditingClipboardFeedback(tab, message) {
    showCopyFeedback(tab, editingCell.value, message);
  }

  function remapSelectedRowKey(tab, previousRowKey, nextRowKey) {
    if (!tab || !previousRowKey || previousRowKey === nextRowKey) return;
    if (selectedCell.value?.tabId === tab.id && selectedCell.value.rowKey === previousRowKey) {
      selectedCell.value = { ...selectedCell.value, rowKey: nextRowKey };
    }
    if (selectedRange.value?.tabId === tab.id) {
      const remapPosition = (position) => position?.rowKey === previousRowKey
        ? { ...position, rowKey: nextRowKey }
        : position;
      selectedRange.value = createGridSelection(
        tab.id,
        remapPosition(selectedRange.value.anchor),
        remapPosition(selectedRange.value.focus),
        {
          shiftAnchor: remapPosition(selectedRange.value.shiftAnchor || selectedRange.value.anchor),
          toggledCells: (selectedRange.value.toggledCells || []).map(remapPosition),
        },
      );
    }
    if (tab.selectedRowKeys?.delete(previousRowKey)) tab.selectedRowKeys.add(nextRowKey);
  }

  async function commitCellValue(tab, row, column, nextValue, options = {}) {
    const {
      showFeedback = true,
      updateStatus = true,
      undoGroupId = null,
      undoRowId = null,
    } = options;
    const oldValue = row?.[column] == null ? null : String(row[column]);
    // Preserve a real SQL NULL: null stays null (sent as JSON null → backend
    // writes SET col = NULL). An explicit empty string stays "" (#5). Do NOT
    // collapse null into "" here.
    const value = nextValue == null ? null : String(nextValue);
    if (!tab) return { ok: false, changed: false, reason: "当前表不可用" };
    if (oldValue === value) return { ok: true, changed: false };
    if (isReadOnlyTab(tab)) {
      if (updateStatus) setReadOnlyStatus(tab);
      return { ok: false, changed: false, reason: `${tabDisplayName(tab)} 是只读连接，不能编辑` };
    }
    const beforeRow = { ...row };
    const afterRow = { ...beforeRow, [column]: value };
    const rowKey = buildRowKey(tab, beforeRow);
    const savedRowKey = buildRowKey(tab, afterRow);
    const beforeIdentity = buildRowIdentity(tab, beforeRow);
    const afterIdentity = buildRowIdentity(tab, afterRow);
    const validation = validateCellValue({
      table: tableForValidation(tab),
      rows: tabRows(tab),
      row,
      columnName: column,
      value,
    });
    if (!validation.valid) {
      const reason = setValidationFeedback(tab, rowKey, column, firstValidationError(validation), { showFeedback, updateStatus });
      return { ok: false, changed: false, reason, rowKey, column };
    }
    const key = startCellCommit(editState, {
      tableName: tabScopeKey(tab),
      rowKey,
      columnName: column,
      oldValue,
      newValue: value,
      beforeRowKey: rowKey,
      afterRowKey: savedRowKey,
      beforeIdentity,
      afterIdentity,
      undoGroupId,
      undoRowId,
    });
    const commitId = editState.pendingCells.get(key)?.commitId;
    setLatestCellCommit(row, column, commitId);
    const rowIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(rowKey);
    mutateTabRow(tab, rowIndex, (current) => {
      current[column] = value;
      return current;
    });
    try {
      const result = await invokeWorkbench("update_cell", {
        request: {
          sessionId: tab.sessionId,
          rowIdentity: beforeIdentity,
          columnName: column,
          oldValue,
          newValue: value,
        },
      });
      if (result?.conflict) throw new Error("数据已被别人修改，请刷新后再试");
      if (result?.updated === false) throw new Error("保存未影响任何数据，请刷新后再试");
      if (!isLatestCellCommit(row, column, commitId)) {
        discardCellCommit(editState, key, commitId);
        return { ok: true, changed: true, stale: true, rowKey: savedRowKey, column };
      }
      if (!finishCellCommit(editState, key, commitId, {
        rowKey: savedRowKey,
        beforeRowKey: rowKey,
        afterRowKey: savedRowKey,
        beforeIdentity,
        afterIdentity,
      })) {
        return { ok: true, changed: true, stale: true, rowKey: savedRowKey, column };
      }
      remapSelectedRowKey(tab, rowKey, savedRowKey);
      syncSelectedTextDraft(tab);
      if (updateStatus) statusText.value = `已保存 ${tabDisplayName(tab)}.${column}`;
      if (showFeedback) onSaveFeedback({ kind: "success", tabId: tab.id, rowKey: savedRowKey, column, message: "已保存" });
      onCellCommitted({ tab, rowKey, column, oldValue, newValue: value });
      return { ok: true, changed: true, rowKey: savedRowKey, column };
    } catch (error) {
      const message = errorMessage(error);
      if (!isLatestCellCommit(row, column, commitId)) {
        discardCellCommit(editState, key, commitId);
        return { ok: false, changed: false, stale: true, reason: message, rowKey, column };
      }
      if (!failCellCommit(editState, key, message, commitId)) {
        return { ok: false, changed: false, stale: true, reason: message, rowKey, column };
      }
      mutateTabRow(tab, rowIndex, (current) => {
        const currentValue = current?.[column] == null ? null : String(current[column]);
        if (currentValue === value) current[column] = oldValue;
        return current;
      });
      remapSelectedRowKey(tab, savedRowKey, rowKey);
      syncSelectedTextDraft(tab);
      if (updateStatus) statusText.value = `保存失败：${message}`;
      if (showFeedback) onSaveFeedback({ kind: "error", tabId: tab.id, rowKey, column, message: `保存失败：${message}` });
      return { ok: false, changed: false, reason: message, rowKey, column };
    }
  }

  function batchFeedbackCell(tab, results) {
    const current = selectedCell.value;
    if (current?.tabId === tab?.id && current.rowKey && current.column) return current;
    const result = results.find((item) => item?.rowKey && item?.column);
    return result ? { tabId: tab.id, rowKey: result.rowKey, column: result.column } : null;
  }

  function reportBatchOutcome(tab, results, options = {}) {
    const extraFailures = Math.max(0, Number(options.extraFailures) || 0);
    const successCount = results.filter((result) => result?.ok && result.changed).length;
    const failedResults = results.filter((result) => result && !result.ok);
    const failureCount = failedResults.length + extraFailures;
    const firstFailure = options.firstFailure || failedResults.find((result) => result.reason)?.reason || "";
    const target = batchFeedbackCell(tab, results);

    if (failureCount > 0) {
      const prefix = options.failureLabel || "批量保存";
      const message = `${prefix}失败：成功 ${successCount} 个，失败 ${failureCount} 个${firstFailure ? `。${firstFailure}` : ""}`;
      statusText.value = message;
      if (target) onSaveFeedback({ kind: "error", ...target, message });
      return { ok: false, successCount, failureCount, results, message };
    }

    if (successCount > 0) {
      const message = typeof options.successMessage === "function"
        ? options.successMessage(successCount)
        : options.successMessage || `已保存 ${successCount} 个单元格`;
      statusText.value = message;
      if (target) onSaveFeedback({ kind: "success", ...target, message });
      return { ok: true, successCount, failureCount: 0, results, message };
    }

    return { ok: true, successCount: 0, failureCount: 0, results, message: "" };
  }

  async function commitCellBatch(tab, edits, options = {}) {
    const undoGroupId = edits.length > 1 ? startUndoGroup(editState) : null;
    const rowIds = new WeakMap();
    let nextUndoRowId = 1;
    const undoRowIdFor = (row) => {
      if (!row || undoGroupId == null) return null;
      if (!rowIds.has(row)) rowIds.set(row, nextUndoRowId++);
      return rowIds.get(row);
    };
    if (edits.length >= ATOMIC_BATCH_CELL_THRESHOLD) {
      const results = await commitCellBatchAtomic(tab, edits, { undoGroupId, undoRowIdFor });
      if (options.report === false) return { results };
      return reportBatchOutcome(tab, results, options);
    }
    const results = [];
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index];
      results.push(await commitCellValue(tab, edit.row, edit.column, edit.value, {
        showFeedback: false,
        updateStatus: false,
        undoGroupId,
        undoRowId: undoRowIdFor(edit.row),
      }));
    }
    if (options.report === false) return { results };
    return reportBatchOutcome(tab, results, options);
  }

  async function commitCellBatchAtomic(tab, edits, { undoGroupId = null, undoRowIdFor = () => null } = {}) {
    const results = [];
    const groups = new Map();
    const prepared = [];

    for (const edit of edits) {
      const row = edit?.row;
      const column = edit?.column;
      if (!row || !column) {
        results.push({ ok: false, changed: false, reason: "目标单元格不存在" });
        continue;
      }
      const oldValue = row[column] == null ? null : String(row[column]);
      const value = edit.value == null ? null : String(edit.value);
      const rowKey = buildRowKey(tab, row);
      let group = groups.get(row);
      if (!group) {
        const beforeRow = { ...row };
        group = {
          row,
          rowIndex: createRowIndex(tab, { buildRowKey }).indexOfKey(buildRowKey(tab, beforeRow)),
          beforeRow,
          beforeRowKey: buildRowKey(tab, beforeRow),
          beforeIdentity: buildRowIdentity(tab, beforeRow),
          changes: [],
          requestChanges: [],
        };
        groups.set(row, group);
      }
      if (oldValue === value) {
        group.requestChanges.push({ columnName: column, oldValue, newValue: value });
        results.push({ ok: true, changed: false, rowKey, column });
        continue;
      }
      const validation = validateCellValue({
        table: tableForValidation(tab),
        rows: tabRows(tab),
        row,
        columnName: column,
        value,
      });
      if (!validation.valid) {
        const reason = setValidationFeedback(tab, rowKey, column, firstValidationError(validation), {
          showFeedback: false,
          updateStatus: false,
        });
        results.push({ ok: false, changed: false, reason, rowKey, column });
        continue;
      }
      group.requestChanges.push({ columnName: column, oldValue, newValue: value });
      const item = { group, row, column, oldValue, value };
      group.changes.push(item);
      prepared.push(item);
    }

    if (prepared.length === 0) return results;
    const activeGroups = [...groups.values()].filter((group) => group.changes.length > 0);

    for (const group of activeGroups) {
      group.afterRow = { ...group.beforeRow };
      for (const item of group.changes) {
        item.beforeRowKey = buildRowKey(tab, group.afterRow);
        item.beforeIdentity = buildRowIdentity(tab, group.afterRow);
        group.afterRow[item.column] = item.value;
        item.afterRowKey = buildRowKey(tab, group.afterRow);
        item.afterIdentity = buildRowIdentity(tab, group.afterRow);
      }
      group.afterRowKey = buildRowKey(tab, group.afterRow);
      group.afterIdentity = buildRowIdentity(tab, group.afterRow);
      for (const item of group.changes) {
        item.key = startCellCommit(editState, {
          tableName: tabScopeKey(tab),
          rowKey: group.beforeRowKey,
          columnName: item.column,
          oldValue: item.oldValue,
          newValue: item.value,
          beforeRowKey: item.beforeRowKey,
          afterRowKey: item.afterRowKey,
          beforeIdentity: item.beforeIdentity,
          afterIdentity: item.afterIdentity,
          undoGroupId,
          undoRowId: undoRowIdFor(item.row),
        });
        item.commitId = editState.pendingCells.get(item.key)?.commitId;
        setLatestCellCommit(item.row, item.column, item.commitId);
      }
      mutateTabRow(tab, group.rowIndex, (current) => {
        for (const item of group.changes) current[item.column] = item.value;
        return current;
      });
    }

    try {
      const result = await invokeWorkbench("update_cells", {
        request: {
          sessionId: tab.sessionId,
          rows: activeGroups.map((group) => ({
            rowIdentity: group.beforeIdentity,
            changes: group.requestChanges,
          })),
        },
      });
      if (result?.conflict) throw new Error("数据已被别人修改，请刷新后再试");
      const updatedRows = Number(result?.updated);
      if (Number.isFinite(updatedRows) && updatedRows !== activeGroups.length) {
        throw new Error(`保存结果不完整：预期 ${activeGroups.length} 行，实际 ${updatedRows} 行`);
      }

      for (const group of activeGroups) {
        for (const item of group.changes) {
          if (!isLatestCellCommit(item.row, item.column, item.commitId)) {
            discardCellCommit(editState, item.key, item.commitId);
            results.push({ ok: true, changed: true, stale: true, rowKey: group.afterRowKey, column: item.column });
            continue;
          }
          finishCellCommit(editState, item.key, item.commitId, {
            rowKey: item.afterRowKey,
            beforeRowKey: item.beforeRowKey,
            afterRowKey: item.afterRowKey,
            beforeIdentity: item.beforeIdentity,
            afterIdentity: item.afterIdentity,
          });
          results.push({ ok: true, changed: true, rowKey: group.afterRowKey, column: item.column });
          onCellCommitted({
            tab,
            rowKey: group.beforeRowKey,
            column: item.column,
            oldValue: item.oldValue,
            newValue: item.value,
          });
        }
        remapSelectedRowKey(tab, group.beforeRowKey, group.afterRowKey);
      }
      syncSelectedTextDraft(tab);
      return results;
    } catch (error) {
      const message = errorMessage(error);
      for (const group of activeGroups) {
        mutateTabRow(tab, group.rowIndex, (current) => {
          for (const item of group.changes) {
            if (!isLatestCellCommit(item.row, item.column, item.commitId)) {
              discardCellCommit(editState, item.key, item.commitId);
              results.push({ ok: false, changed: false, stale: true, reason: message, rowKey: group.beforeRowKey, column: item.column });
              continue;
            }
            if (failCellCommit(editState, item.key, message, item.commitId)) {
              const currentValue = current[item.column] == null ? null : String(current[item.column]);
              if (currentValue === item.value) current[item.column] = item.oldValue;
            }
            results.push({ ok: false, changed: false, reason: message, rowKey: group.beforeRowKey, column: item.column });
          }
          return current;
        });
        remapSelectedRowKey(tab, group.afterRowKey, group.beforeRowKey);
      }
      syncSelectedTextDraft(tab);
      return results;
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
      const rowId = insertRowIdFromKey(tab, cell.rowKey);
      if (editingCell.value) {
        updateEditDraft(textDraft.value);
        finishEditing();
      } else {
        updateInsertDraft(tab, rowId, cell.column, textDraft.value);
      }
      const inserted = await commitInsertRow(tab, rowId);
      return { insertedRows: inserted ? 1 : 0, failedRowId: inserted ? null : rowId };
    }
    if (isMultiCellRange(selectedRange.value) && selectedRange.value?.tabId === tab.id) {
      if (editingCell.value) {
        editDraft.value = textDraft.value;
        return await finishEditing();
      }
      return await commitValueToSelectedRange(tab, selectedRange.value, textDraft.value);
    }
    const row = findRowByKey(tab, cell.rowKey);
    if (!row) return;
    if (editingCell.value) {
      return await finishEditing();
    } else {
      const current = editableCellValue(row, cell.column);
      if (textDraft.value !== current) {
        return await commitCellValue(tab, row, cell.column, textDraft.value);
      }
    }
  }

  // 详细输入框失焦即保存：textarea 的 blur 晚于 mousedown 触发，此时点击别的
  // 单元格可能已把 selectedCell/textDraft 切走。组件带上本地 editorDraft 与原单
  // 元格身份（tabId/rowKey/column）调用本函数，按原单元格提交，避免草稿丢失或
  // 写错行。未带身份时退化为按当前 selectedCell 提交（兼容 Ctrl+S 等路径）。
  async function commitDetailDraft(payload) {
    if (!payload) return;
    const tab = activeTab.value;
    if (!tab) return;
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
    const draft = payload.draft != null ? String(payload.draft) : textDraft.value;
    const targetTabId = payload.tabId || selectedCell.value?.tabId;
    const targetRowKey = payload.rowKey || selectedCell.value?.rowKey;
    const targetColumn = payload.column || selectedCell.value?.column;
    if (!targetTabId || !targetRowKey || !targetColumn) return;
    if (targetTabId !== tab.id) return;

    if (isInsertRowKey(targetRowKey)) {
      const rowId = insertRowIdFromKey(tab, targetRowKey);
      if (editingCell.value) {
        updateEditDraft(draft);
        finishEditing();
      } else {
        updateInsertDraft(tab, rowId, targetColumn, draft);
      }
      const inserted = await commitInsertRow(tab, rowId);
      return { insertedRows: inserted ? 1 : 0, failedRowId: inserted ? null : rowId };
    }
    const currentCell = selectedCell.value;
    const commitsActiveRange = isMultiCellRange(selectedRange.value)
      && selectedRange.value?.tabId === tab.id
      && currentCell?.tabId === targetTabId
      && currentCell?.rowKey === targetRowKey
      && currentCell?.column === targetColumn;
    if (commitsActiveRange) {
      if (editingCell.value) {
        updateEditDraft(draft);
        return await finishEditing();
      }
      return await commitValueToSelectedRange(tab, selectedRange.value, draft);
    }
    const row = findRowByKey(tab, targetRowKey);
    if (!row) return;
    if (editingCell.value) {
      updateEditDraft(draft);
      finishEditing();
    } else {
      await commitCellValue(tab, row, targetColumn, draft);
    }
  }

  function isPrimaryKeyColumn(column) {
    return Boolean(column?.is_primary_key || column?.isPrimaryKey);
  }

  function isDatabaseGeneratedColumn(column) {
    const constraint = columnConstraint(column);
    return constraint.isAutoIncrement || constraint.isGenerated;
  }

  function primaryKeyColumns(tab) {
    const keys = [];
    for (const key of Array.isArray(tab?.primaryKeys) ? tab.primaryKeys : []) {
      const normalized = String(key || "").trim();
      if (normalized && !keys.includes(normalized)) keys.push(normalized);
    }
    for (const column of columnsForTab(tab)) {
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

  function primaryKeyBuilder(keys) {
    const shape = keys.join("\u001f");
    if (!primaryKeyBuilders.has(shape)) {
      primaryKeyBuilders.set(shape, (_tab, row) => primaryKeySignature(row, keys));
    }
    return primaryKeyBuilders.get(shape);
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

  function rowFromDraft(tab, draft) {
    const row = {};
    for (const column of columnsForTab(tab)) {
      const name = columnName(column);
      if (name && Object.prototype.hasOwnProperty.call(draft, name)) row[name] = String(draft[name] ?? "");
    }
    for (const [key, value] of Object.entries(draft)) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) row[key] = String(value ?? "");
    }
    return row;
  }

  function promoteSavedDraft(tab, draft, saveResult = null) {
    if (!tab) return;
    const returnedRow = saveResult?.row && typeof saveResult.row === "object"
      ? { ...saveResult.row }
      : null;
    const row = returnedRow || rowFromDraft(tab, draftValuesForSave(draft));
    for (const column of saveResult?.nullColumns || saveResult?.null_columns || []) {
      if (column) row[column] = null;
    }
    if (Object.keys(row).length === 0) return;
    const keys = primaryKeyColumns(tab);
    const signature = primaryKeySignature(row, keys);
    if (keys.length > 0 && !signature) return;
    if (signature && tabRows(tab).some((row) => primaryKeySignature(row, keys) === signature)) return;
    appendTabRows(tab, [row]);
    tab.totalRows = Math.max(Number(tab.totalRows || 0), tabRowCount(tab));
  }

  async function commitDraftObject(tab, draft, rowId, { allowDefaults = false } = {}) {
    if (!tab?.sessionId) return { ok: false, reason: "" };
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return { ok: false, reason: statusText.value };
    }
    const cleaned = cleanDraftValues(draft);
    const valuesForSave = draftValuesForSave(draft);
    if (!allowDefaults && Object.keys(cleaned).length === 0 && Object.keys(valuesForSave).length === 0) {
      return { ok: false, reason: "" };
    }
    const otherDrafts = getInsertRows(tab)
      .filter((candidate) => candidate.id !== rowId)
      .map((candidate) => draftValuesForSave(candidate.draft));
    const validation = validateRowDraft({
      table: tableForValidation(tab),
      rows: tabRows(tab),
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
      const saveResult = await invokeWorkbench("insert_row", {
        request: {
          sessionId: tab.sessionId,
          draft: valuesForSave,
        },
      });
      return { ok: true, reason: "", saveResult };
    } catch (error) {
      const reason = errorMessage(error);
      statusText.value = `插入失败：${reason}`;
      return { ok: false, reason };
    }
  }

  function commitInsertDraftRow(tab, row, { allowDefaults = false } = {}) {
    const key = insertSavingKey(tab, row?.id);
    const pending = insertRowSavePromises.get(key);
    if (pending) return pending;
    const draft = draftValuesForSave(row?.draft);
    const promise = (async () => {
      markInsertRowSaving(tab, row.id, true);
      let result;
      try {
        result = await commitDraftObject(tab, draft, row.id, { allowDefaults });
      } finally {
        markInsertRowSaving(tab, row.id, false);
      }
      if (!result.ok) return { ok: false, rowId: row.id, reason: result.reason || statusText.value || "" };
      promoteSavedDraft(tab, draft, result.saveResult);
      clearInsertDraft(tab, row.id);
      return { ok: true, rowId: row.id };
    })().finally(() => {
      if (insertRowSavePromises.get(key) === promise) insertRowSavePromises.delete(key);
    });
    insertRowSavePromises.set(key, promise);
    return promise;
  }

  async function commitInsertRowsUnlocked(tab, { rowIds = null, allowDefaults = false } = {}) {
    if (!tab?.sessionId) return { insertedRows: 0, failedRowId: null };
    flushEditingInsertDraft(tab);
    refreshInsertDraftPrimaryKeyFeedback(tab);
    const requestedIds = Array.isArray(rowIds) ? new Set(rowIds.filter(Boolean)) : null;
    const rowsToSave = requestedIds
      ? getInsertRows(tab).filter((row) => requestedIds.has(row.id))
      : getInsertRows(tab).filter(hasDraftInput);
    const totalToSave = rowsToSave.length;
    let insertedRows = 0;
    for (const row of rowsToSave) {
      const result = await commitInsertDraftRow(tab, row, { allowDefaults });
      if (!result.ok) {
        if (activeTab.value?.id === tab.id) {
          selectInsertCell(tab, row.id, selectedInsertCell.value?.columnIndex ?? 0);
        }
        return { insertedRows, failedRowId: row.id, failedReason: result.reason || statusText.value || "" };
      }
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

  function commitInsertRows(tab, options = {}) {
    const tabId = tab?.id || "";
    if (!tabId) return Promise.resolve({ insertedRows: 0, failedRowId: null });
    const rowScope = Array.isArray(options.rowIds) && options.rowIds.length > 0
      ? [...new Set(options.rowIds.filter(Boolean))].sort().join(",")
      : "*";
    const key = `${tabId}:${rowScope}`;
    const pending = insertSavePromises.get(key);
    if (pending) return pending;
    const promise = commitInsertRowsUnlocked(tab, options).finally(() => {
      if (insertSavePromises.get(key) === promise) insertSavePromises.delete(key);
    });
    insertSavePromises.set(key, promise);
    return promise;
  }

  async function commitInsertRow(tab, rowId) {
    const result = await commitInsertRows(tab, { rowIds: [rowId], allowDefaults: true });
    if (result.insertedRows === 1 && !result.failedRowId) {
      statusText.value = "已插入 1 行";
      return true;
    }
    return false;
  }

  function pasteIntoInsertCell(
    tab,
    matrix,
    rowId = selectedInsertCell.value?.rowId,
    columnIndex = selectedInsertCell.value?.columnIndex,
    clipboardPayload = null,
  ) {
    if (!tab || !isInsertRowVisible(tab) || rowId == null || columnIndex == null) return;
    const beforeRows = captureInsertDraftState(tab);
    const rows = getInsertRows(tab);
    const selectedTargetRow = rows.find((row) => row.id === rowId);
    if (!selectedTargetRow) return;
    const targetAnchor = insertRowAnchorIndex(tab, selectedTargetRow);
    const targetGroup = getVisibleInsertRows(tab)
      .filter((row) => insertRowAnchorIndex(tab, row) === targetAnchor);
    const targetGroupIndex = Math.max(0, targetGroup.findIndex((row) => row.id === rowId));
    const startColumnIndex = columnIndex;
    const columns = activeColumns.value;
    const sourceColumnNames = clipboardPayload?.kind === "full-row" && Array.isArray(clipboardPayload.columnNames)
      ? clipboardPayload.columnNames
      : null;
    const sourceStartsWithPrimaryKey = !sourceColumnNames
      && startColumnIndex === 0
      && isPrimaryKeyColumn(columns[0])
      && matrix.some((row) => row.length === columns.length);
    let pastedCells = 0;
    for (let rowOffset = 0; rowOffset < matrix.length; rowOffset++) {
      let targetRow = targetGroup[targetGroupIndex + rowOffset];
      if (!targetRow) {
        const previousRow = targetGroup.at(-1) || selectedTargetRow;
        targetRow = createInsertRow(targetAnchor);
        rows.splice(rows.indexOf(previousRow) + 1, 0, targetRow);
        targetGroup.push(targetRow);
      }
      for (let colOffset = 0; colOffset < matrix[rowOffset].length; colOffset++) {
        const targetColumnIndex = sourceColumnNames
          ? columns.findIndex((column) => columnName(column) === sourceColumnNames[colOffset])
          : sourceStartsWithPrimaryKey ? colOffset : startColumnIndex + colOffset;
        const column = columns[targetColumnIndex];
        if (!column || (sourceColumnNames && isDatabaseGeneratedColumn(column))) continue;
        const applied = applyInsertDraftValue(tab, targetRow, columnName(column), matrix[rowOffset][colOffset], {
          updateSelection: false,
          columnIndex: targetColumnIndex,
        });
        if (applied) pastedCells += 1;
      }
    }
    const selected = selectedInsertCell.value;
    if (selected?.tabId === tab.id) {
      textDraft.value = String(getInsertDraft(tab, selected.rowId)?.[selected.column] ?? "");
    }
    refreshInsertDraftPrimaryKeyFeedback(tab);
    recordInsertDraftHistory(tab, beforeRows, { label: "粘贴到新增行", cellCount: pastedCells });
    statusText.value = matrix.length > 1 ? `已粘贴到 ${matrix.length} 条新增行` : `已粘贴 ${pastedCells} 个新增单元格`;
  }

  async function pasteIntoInsertInput(tab, rowId, columnIndex, event) {
    const text = event?.clipboardData?.getData?.("text/plain") ?? "";
    if (!text) return;
    pasteIntoInsertCell(tab, parseGridTsv(text), rowId, columnIndex, getGridClipboardPayload(text));
  }

  async function pasteIntoSelectedInsertRow(tab, matrix, clipboardPayload) {
    if (!tab || !isInsertRowVisible(tab) || selectedInsertRow.value?.tabId !== tab.id) return { insertedRows: 0 };
    const columns = activeColumns.value;
    const sourceColumnNames = Array.isArray(clipboardPayload?.columnNames) ? clipboardPayload.columnNames : [];
    let insertedRows = 0;
    let failedRows = 0;
    const selectedDraftRow = getInsertRows(tab).find((candidate) => candidate.id === selectedInsertRow.value.rowId);
    for (const row of matrix) {
      const draft = {};
      for (let sourceIndex = 0; sourceIndex < sourceColumnNames.length; sourceIndex++) {
        const name = sourceColumnNames[sourceIndex];
        const column = columns.find((candidate) => columnName(candidate) === name);
        if (!column || isDatabaseGeneratedColumn(column)) continue;
        draft[name] = row[sourceIndex] ?? "";
      }
      const result = await commitDraftObject(tab, draft, undefined);
      if (result.ok) {
        promoteSavedDraft(tab, draft, result.saveResult);
        insertedRows++;
      } else {
        const failedDraftRow = failedRows === 0 && selectedDraftRow
          ? selectedDraftRow
          : createInsertRow(null);
        failedDraftRow.draft = { ...draft };
        failedDraftRow.visible = true;
        if (!getInsertRows(tab).includes(failedDraftRow)) getInsertRows(tab).push(failedDraftRow);
        failedRows++;
      }
    }
    if (insertedRows > 0 && failedRows === 0) clearInsertDraft(tab, selectedInsertRow.value.rowId);
    ensureTrailingInsertRow(tab);
    statusText.value = failedRows > 0
      ? `粘贴新增完成：成功 ${insertedRows} 行，失败 ${failedRows} 行；失败内容已保留为未保存行`
      : `已粘贴新增 ${insertedRows} 行`;
    return failedRows > 0 ? { insertedRows, failedRows } : { insertedRows };
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
  // 否则清空单个选中单元格。方案 A 统一写空字符串；SQL NULL 只通过
  // 明确的「设为 NULL」操作产生。
  async function clearSelectedCells() {
    const tab = activeTab.value;
    if (!tab) return;
    if (isMultiCellRange(selectedRange.value)) {
      await clearSelectedRange(tab);
      return;
    }
    const cell = selectedCell.value;
    if (!cell || cell.tabId !== tab.id) return;
    if (isInsertRowKey(cell.rowKey)) {
      const insertRow = insertRowByKey(tab, cell.rowKey);
      const columnIndex = activeColumnNames().indexOf(cell.column);
      const beforeRows = captureInsertDraftState(tab);
      if (clearInsertDraftCell(tab, insertRow, cell.column, columnIndex)) {
        recordInsertDraftHistory(tab, beforeRows, { label: "清空新增行单元格", cellCount: 1 });
        statusText.value = "已清空 1 个单元格";
      }
      return;
    }
    const row = findRowByKey(tab, cell.rowKey);
    if (row) await clearCellValue(tab, row, cell.column);
  }

  function clipboardSource(text) {
    const internal = getGridClipboardPayload(text);
    const matrix = Array.isArray(internal?.matrix) ? cloneClipboardMatrix(internal.matrix) : parseGridTsv(text);
    const mask = Array.isArray(internal?.mask) ? internal.mask.map((row) => row.map(Boolean)) : fullClipboardMask(matrix);
    return {
      matrix,
      mask,
      internal,
      sparse: clipboardMaskIsSparse(mask),
    };
  }

  function sparsePasteError(source, target) {
    const sourceShape = `${source.matrix.length}×${source.matrix[0]?.length || 0}`;
    const targetShape = target?.bounds
      ? `${target.bounds.bottom - target.bounds.top + 1}×${target.bounds.right - target.bounds.left + 1}`
      : "无效";
    return `无法粘贴：离散剪贴板布局 ${sourceShape} 与目标选区 ${targetShape} 不匹配`;
  }

  function planGridPaste(tab, source) {
    const selection = selectedRange.value?.tabId === tab.id ? selectedRange.value : null;
    const selectedCount = gridSelectionCount(selection);
    const selectionBounds = gridSelectionActualBounds(selection);
    const targetSparse = selectedCount > 1 && !gridSelectionIsContiguous(selection);
    const sourceRows = source.matrix.length;
    const sourceColumns = source.matrix[0]?.length || 0;

    if (targetSparse) {
      if (sourceRows === 1 && sourceColumns === 1 && source.mask[0]?.[0]) {
        return { ok: true, directCells: selectedGridCells(tab, selection), value: source.matrix[0][0] };
      }
      const targetMask = gridSelectionMask(selection, selectionBounds);
      const sameShape = sourceRows === targetMask.length && sourceColumns === (targetMask[0]?.length || 0);
      if (!source.internal || !source.sparse || !sameShape || !clipboardMasksEqual(source.mask, targetMask)) {
        return { ok: false, message: sparsePasteError(source, { bounds: selectionBounds }) };
      }
      return {
        ok: true,
        start: { rowIndex: selectionBounds.top, columnIndex: selectionBounds.left },
        matrix: source.matrix,
        mask: source.mask,
      };
    }

    if (selectedCount > 1 && selectionBounds) {
      const rowCount = selectionBounds.bottom - selectionBounds.top + 1;
      const columnCount = selectionBounds.right - selectionBounds.left + 1;
      const fill = source.sparse
        ? tileClipboardPayload(source.matrix, source.mask, rowCount, columnCount)
        : tileClipboardMatrixToSelection(source.matrix, rowCount, columnCount);
      if (!fill.ok) return { ok: false, message: clipboardFillErrorMessage(fill, true) };
      return {
        ok: true,
        start: { rowIndex: selectionBounds.top, columnIndex: selectionBounds.left },
        matrix: fill.matrix,
        mask: fill.mask || fullClipboardMask(fill.matrix),
      };
    }

    const start = rangeStartPosition(tab);
    const fill = tileClipboardPayload(source.matrix, source.mask, sourceRows, sourceColumns);
    if (!fill.ok) return { ok: false, message: clipboardFillErrorMessage(fill, false) };
    return { ok: true, start, matrix: fill.matrix, mask: fill.mask };
  }

  async function applyGridPastePlan(tab, plan) {
    if (!plan?.ok) return;
    const model = visualRowEntries(tab);
    const targets = [];

    if (Array.isArray(plan.directCells)) {
      for (const cell of plan.directCells) targets.push({ ...cell, value: plan.value });
    } else {
      if (!plan.start) return;
      for (let rowOffset = 0; rowOffset < plan.matrix.length; rowOffset++) {
        for (let columnOffset = 0; columnOffset < (plan.matrix[rowOffset]?.length || 0); columnOffset++) {
          if (!plan.mask[rowOffset]?.[columnOffset]) continue;
          const rowIndex = plan.start.rowIndex + rowOffset;
          const columnIndex = plan.start.columnIndex + columnOffset;
          const entry = model.at(rowIndex);
          const column = activeColumnNames()[columnIndex];
          if (!entry || !column) {
            statusText.value = "无法粘贴：目标范围超出已加载的可编辑区域";
            return;
          }
          targets.push({ entry, rowIndex, columnIndex, column, value: plan.matrix[rowOffset][columnOffset] });
        }
      }
    }

    if (targets.length === 0) {
      statusText.value = "无法粘贴：目标选区没有可写入的单元格";
      return;
    }

    const edits = [];
    const draftEdits = [];
    for (const target of targets) {
      if (!target.entry || !target.column) {
        statusText.value = "无法粘贴：目标范围超出已加载的可编辑区域";
        return;
      }
      if (target.entry.type === "insert") {
        if (isInsertRowSaving(tab, target.entry.insertRow?.id)) {
          statusText.value = "新增行正在保存，请稍候";
          return;
        }
        draftEdits.push(target);
      } else if (target.entry.type === "data" && target.entry.row) {
        edits.push({
          row: target.entry.row,
          rowIndex: target.entry.dataIndex,
          columnName: target.column,
          value: target.value,
        });
      } else {
        statusText.value = "无法粘贴：目标范围超出已加载的可编辑区域";
        return;
      }
    }

    const beforeInsertRows = draftEdits.length > 0 ? captureInsertDraftState(tab) : null;
    for (const target of draftEdits) {
      applyInsertDraftValue(tab, target.entry.insertRow, target.column, target.value, {
        updateSelection: false,
        columnIndex: target.columnIndex,
      });
    }
    if (draftEdits.length > 0) {
      refreshInsertDraftPrimaryKeyFeedback(tab);
      recordInsertDraftHistory(tab, beforeInsertRows, {
        label: "粘贴到新增行",
        cellCount: draftEdits.length,
      });
    }

    const validation = validateBatchEdits({ table: tableForValidation(tab), rows: tabRows(tab), edits });
    for (const validationError of validation.errors) {
      const row = tabRowAt(tab, validationError.rowIndex);
      const rowKey = row ? buildRowKey(tab, row) : "";
      setValidationFeedback(tab, rowKey, validationError.columnName, validationError, {
        showFeedback: false,
        updateStatus: false,
      });
    }
    const batch = await commitCellBatch(
      tab,
      validation.validEdits.map((edit) => ({ row: edit.row, column: edit.columnName, value: edit.value })),
      { report: false },
    );
    if (edits.length === 0 && draftEdits.length > 0) {
      statusText.value = `已粘贴 ${draftEdits.length} 个新增单元格`;
      return { ok: true, successCount: draftEdits.length, failureCount: 0 };
    }
    return reportBatchOutcome(tab, batch.results, {
      extraFailures: validation.errors.length,
      firstFailure: validation.errors[0]?.message || "",
      successMessage: (count) => `已粘贴 ${count + draftEdits.length} 个单元格`,
      failureLabel: "批量粘贴保存",
    });
  }

  // Keyboard paste in a focused webview is delivered as a ClipboardEvent.
  // Consuming its text directly avoids WebKit's programmatic clipboard-read
  // permission menu while keeping the same validation and atomic-save path.
  async function pasteGridText(text) {
    const tab = activeTab.value;
    if (!tab) return;
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
    const clipboardText = String(text ?? "");
    if (clipboardText === "" && !getGridClipboardPayload(clipboardText)) {
      statusText.value = "剪贴板为空，未修改数据";
      return;
    }
    const source = clipboardSource(clipboardText);
    const matrix = source.matrix;
    if (matrix.length === 0) {
      statusText.value = "剪贴板为空，未修改数据";
      return;
    }
    if (isInsertRowVisible(tab) && selectedInsertCell.value?.tabId === tab.id) {
      pasteIntoInsertCell(tab, matrix, undefined, undefined, source.internal);
      return;
    }
    if (isInsertRowVisible(tab) && selectedInsertRow.value?.tabId === tab.id) {
      const fullRowPayload = copiedFullRowPayload(clipboardText, matrix);
      if (!fullRowPayload) {
        statusText.value = "请先通过行号复制整行，再粘贴到新增行";
        return { insertedRows: 0 };
      }
      return await pasteIntoSelectedInsertRow(tab, matrix, fullRowPayload);
    }
    const plan = planGridPaste(tab, source);
    if (!plan.ok) {
      statusText.value = plan.message;
      return;
    }
    return await applyGridPastePlan(tab, plan);
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

    if (editingCell.value && (isCopy || isCut || isPaste)) {
      if (isCopy) showEditingClipboardFeedback(tab, "复制成功");
      else if (isPaste) showEditingClipboardFeedback(tab, "粘贴成功");
      return;
    }

    // Ctrl+X 剪切：先复制到剪贴板，再把可清空单元格写成空字符串。
    if (isCut) {
      event.preventDefault();
      const writeClipboard = async (text, feedback, payload = null) => {
        try {
          await writeGridClipboard(text, payload);
          if (feedback) showCopyFeedback(tab, feedback.anchor, feedback.message);
          return true;
        } catch {
          statusText.value = "写入剪贴板失败，未剪切";
          return false;
        }
      };
      if (tab.selectedRowKeys.size > 0) {
        // 整行剪切不自动清空（风险大），退化为仅复制。
        const selectedRows = selectedWholeRows(tab);
        if (selectedRows.length > 0) {
          const columnNames = activeColumnNames();
          const matrix = selectedRows.map(({ row }) => columnNames.map((col) => clipboardCellValue(row, col)));
          await writeClipboard(
            serializeGridTsv(matrix),
            { anchor: { tabId: tab.id, rowKey: selectedRows[0].rowKey, column: columnNames[0] }, message: `已复制 ${selectedRows.length} 行（整行不支持剪切清空）` },
            { kind: "full-row", columnCount: columnsForTab(tab).length, columnNames, matrix },
          );
        }
      } else if (isMultiCellRange(selectedRange.value)) {
        const copied = getSelectedClipboardData(tab);
        if (copied?.ok === false) {
          statusText.value = `无法复制：离散选区跨度为 ${copied.rowCount}×${copied.columnCount}，请缩小范围`;
          return;
        }
        if (copied?.matrix?.length) {
          const message = copied.sparse
            ? `已剪切 ${copied.selectedCount} 个单元格（范围 ${copied.rowCount}×${copied.columnCount}）`
            : `已剪切 ${copied.rowCount}×${copied.columnCount} 区域`;
          const written = await writeClipboard(
            serializeGridTsv(copied.matrix),
            { anchor: copied.sparse ? selectedCell.value : selectedRange.value?.anchor, message },
            { kind: copied.sparse ? "sparse" : "range", matrix: copied.matrix, mask: copied.mask, bounds: copied.bounds },
          );
          if (written && !isReadOnlyTab(tab)) await clearSelectedRange(tab);
        }
      } else if (selectedCell.value && !isInsertRowKey(selectedCell.value.rowKey)) {
        const row = rowForSelectedCell(tab, selectedCell.value);
        if (row) {
          const value = clipboardCellValue(row, selectedCell.value.column);
          const copied = await writeClipboard(value, { anchor: selectedCell.value, message: "已剪切" }, { kind: "cell", matrix: [[value]] });
          if (copied && !isReadOnlyTab(tab)) await clearCellValue(tab, row, selectedCell.value.column);
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
      if (isInsertRowVisible(tab) && hasInsertDrafts(tab)) {
        return await commitInsertRows(tab);
      }
      if (selectedCell.value) return await saveTextPanel();
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
        const selectedRows = selectedWholeRows(tab);
        if (selectedRows.length > 0) {
          const columnNames = activeColumnNames();
          const matrix = selectedRows.map(({ row }) => columnNames.map((col) => clipboardCellValue(row, col)));
          await writeGridMatrix(matrix, { kind: "full-row", columnCount: columnsForTab(tab).length, columnNames });
          const message = `已复制 ${selectedRows.length} 行`;
          const anchorRowKey = selectedRows[0].rowKey;
          showCopyFeedback(tab, { tabId: tab.id, rowKey: anchorRowKey, column: activeColumnNames()[0] }, message);
        }
      } else if (isMultiCellRange(selectedRange.value)) {
        const copied = getSelectedClipboardData(tab);
        if (copied?.ok === false) {
          statusText.value = `无法复制：离散选区跨度为 ${copied.rowCount}×${copied.columnCount}，请缩小范围`;
          return;
        }
        if (copied?.matrix?.length) {
          await writeGridMatrix(copied.matrix, {
            kind: copied.sparse ? "sparse" : "range",
            mask: copied.mask,
            bounds: copied.bounds,
          });
          const message = copied.sparse
            ? `已复制 ${copied.selectedCount} 个单元格（范围 ${copied.rowCount}×${copied.columnCount}）`
            : `已复制 ${copied.rowCount}×${copied.columnCount} 区域`;
          const feedbackCell = copied.sparse
            ? selectedCell.value
            : selectedRange.value?.anchor
              ? { tabId: tab.id, rowKey: selectedRange.value.anchor.rowKey, column: selectedRange.value.anchor.column }
              : selectedCell.value;
          showCopyFeedback(tab, feedbackCell, message);
        }
      } else if (selectedCell.value) {
        if (isInsertRowKey(selectedCell.value.rowKey)) {
          await writeGridMatrix([[insertDraftValue(tab, selectedCell.value.rowKey, selectedCell.value.column)]], { kind: "cell" });
          showCopyFeedback(tab);
          return;
        }
        const row = findRowByKey(tab, selectedCell.value.rowKey);
        if (row) {
          const value = clipboardCellValue(row, selectedCell.value.column);
          await writeGridMatrix([[value]], { kind: "cell" });
          showCopyFeedback(tab);
        }
      } else if (isInsertRowVisible(tab) && selectedInsertRow.value?.tabId === tab.id) {
        await writeGridMatrix([insertDraftRow(tab, selectedInsertRow.value.rowId)], {
          kind: "full-row",
          columnCount: activeColumns.value.length,
          columnNames: activeColumnNames(),
        });
        statusText.value = "已复制新增行";
      } else if (isInsertRowVisible(tab) && selectedInsertCell.value?.tabId === tab.id) {
        const draft = getInsertDraft(tab, selectedInsertCell.value.rowId);
        await writeGridMatrix([[draft[selectedInsertCell.value.column] ?? ""]], { kind: "cell" });
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
      try {
        const text = await navigator.clipboard.readText();
        return await pasteGridText(text);
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
      if (selectedInsertRow.value?.tabId === tab.id) {
        event.preventDefault?.();
        removeInsertDraftRow(tab, selectedInsertRow.value.rowId);
        return;
      }
      // 普通数据单元格：Delete/Backspace 写入空字符串；不可清空的列保持不动。
      if (!isReadOnlyTab(tab)
        && (isMultiCellRange(selectedRange.value)
          || selectedCell.value?.tabId === tab.id)) {
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
          editDraftDirty.value = true;
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
    editDraftDirty,
    textDraft,
    pendingInsertRows,
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
    isInsertRowSaving,
    hideInsertRow,
    visualRowEntries,
    insertAwareVisualRowIndex,
    // cell selection
    clearSelection,
    captureTableViewSelection,
    restoreTableViewSelection,
    focusTextCell,
    selectCell,
    consumeCellPointerClick,
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
    updateEditDraft,
    finishEditing,
    cancelEditing,
    // navigation
    navigateCell,
    selectInsertCell,
    insertDraftAbove,
    insertDraftBelow,
    insertPosition,
    selectInsertRow,
    removeInsertDraftRow,
    removeInsertDraftRows,
    applyInsertDraftHistoryEntry,
    handleInsertKeydown,
    // commits
    commitCellValue,
    saveTextPanel,
    commitDetailDraft,
    commitInsertRow,
    commitInsertRows,
    setCellToNull,
    pasteIntoInsertInput,
    pasteGridText,
    // keyboard
    handleGridKeydown,
  };
}
