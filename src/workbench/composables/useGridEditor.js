import { computed, nextTick, ref, toRaw } from "vue";
import {
  GRID_FIELD_COMMENT_COLLAPSED_HEIGHT,
  GRID_HEADER_HEIGHT,
  GRID_ROW_HEIGHT,
} from "../constants.js";
import {
  appendTabRows,
  ensureTabRowStore,
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
  isGridCellSelected,
  toggleGridSelectionCell,
} from "../utils/gridCellSelection.js";
import {
  getGridClipboardPayload,
  peekGridClipboardPayload,
  setGridClipboardPayload,
} from "../utils/gridClipboardStore.js";
import { displayCellValue } from "../utils/cellDisplay.js";
import { replaceSearchText } from "../utils/searchMatch.js";
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
const VISUAL_ROW_INDEX_ATTRIBUTE = "data-visual-row-index";
const COLUMN_INDEX_ATTRIBUTE = "data-column-index";
const MAX_SPARSE_CLIPBOARD_CELLS = 100_000;
const EMPTY_CELL_RANGE_CLASSES = Object.freeze({
  "range-selected": false,
  "range-top": false,
  "range-bottom": false,
  "range-left": false,
  "range-right": false,
  "range-anchor": false,
  "range-discrete": false,
});
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
  beginHistoryOperation,
  beginMutationTurn,
  commitUndoTransaction,
  createUndoTransaction,
  enqueueMutationTask,
  finishHistoryOperation,
  finishMutationTurn,
  rebaseRowSaveLane,
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
  const textDraftRevision = ref(0);
  const detailIdentityRemap = ref(null);
  let nextDetailIdentityRemapId = 1;
  if (!(editState.pendingInsertRows instanceof Set)) editState.pendingInsertRows = new Set();
  if (!(editState.insertRowReservations instanceof Map)) editState.insertRowReservations = new Map();
  const pendingInsertRows = computed(() => editState.pendingInsertRows);
  const insertRowReservations = toRaw(editState.insertRowReservations);
  const latestCellCommits = new WeakMap();

  const activeColumns = computed(() => activeTab.value?.columns || []);
  const selectionRenderState = computed(() => {
    const selection = selectedRange.value;
    return {
      selection,
      bounds: gridSelectionBaseBounds(selection),
      toggleKeys: new Set(gridSelectionToggleMap(selection).keys()),
    };
  });
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

  function updateTextDraft(value) {
    textDraft.value = String(value ?? "");
    textDraftRevision.value += 1;
  }

  function captureHistoryViewState() {
    return {
      selectedCell: selectedCell.value ? { ...selectedCell.value } : null,
      textDraftRevision: textDraftRevision.value,
    };
  }

  function sameSelectedCellIdentity(left, right) {
    if (!left || !right) return left === right;
    return left.tabId === right.tabId
      && left.rowKey === right.rowKey
      && left.column === right.column
      && (left.kind || "data") === (right.kind || "data");
  }

  function forEachHistoryCellGroup(entry, direction, visit) {
    if (!entry) return;
    if (entry.kind === "history-composite") {
      const entries = direction === "undo" ? [...(entry.entries || [])].reverse() : entry.entries || [];
      for (const child of entries) forEachHistoryCellGroup(child, direction, visit);
      return;
    }
    if (entry.kind === "insert-draft-batch") return;
    const entries = entry.kind === "cell-batch" ? entry.entries || [] : [entry];
    const groups = new Map();
    for (const item of entries) {
      if (!item?.columnName) continue;
      const sourceRowKey = direction === "undo"
        ? item.afterRowKey || item.rowKey
        : item.beforeRowKey || item.rowKey;
      const targetRowKey = direction === "undo"
        ? item.beforeRowKey || item.rowKey
        : item.afterRowKey || item.rowKey;
      const key = `${String(sourceRowKey || "")}\x1f${String(targetRowKey || "")}`;
      if (!groups.has(key)) groups.set(key, { sourceRowKey, targetRowKey, entries: [] });
      groups.get(key).entries.push(item);
    }
    for (const group of groups.values()) visit(group);
  }

  function syncSelectionAfterHistory(
    entry,
    direction,
    tab = activeTab.value,
    _result = null,
    historyView = null,
  ) {
    if (!tab || !entry || (direction !== "undo" && direction !== "redo")) return;
    let selectedValueChanged = false;
    let expectedSelectedDraft = null;
    const draftBeforeSync = textDraft.value;
    const selectedBeforeMapping = selectedCell.value ? { ...selectedCell.value } : null;
    const capturedCell = historyView?.selectedCell ? { ...historyView.selectedCell } : null;

    forEachHistoryCellGroup(entry, direction, ({ sourceRowKey, targetRowKey, entries }) => {
      const cell = selectedCell.value;
      const selectedRowMatches = cell?.tabId === tab.id && cell.rowKey === sourceRowKey;
      if (selectedRowMatches) {
        const selectedEntry = entries.find((item) => item.columnName === cell.column);
        if (selectedEntry && !selectedValueChanged) {
          selectedValueChanged = true;
          const sourceValue = direction === "undo" ? selectedEntry.newValue : selectedEntry.oldValue;
          expectedSelectedDraft = String(sourceValue ?? "");
        }
      }
      if (capturedCell?.tabId === tab.id && capturedCell.rowKey === sourceRowKey) {
        capturedCell.rowKey = targetRowKey;
      }
      if (sourceRowKey && targetRowKey && sourceRowKey !== targetRowKey) {
        remapSelectedRowKey(tab, sourceRowKey, targetRowKey, { signalDetail: false });
        if (editingCell.value?.tabId === tab.id && editingCell.value.rowKey === sourceRowKey) {
          editingCell.value = { ...editingCell.value, rowKey: targetRowKey };
        }
      }
    });

    const selectedAfterMapping = selectedCell.value;
    if (selectedBeforeMapping?.tabId === tab.id
      && selectedAfterMapping?.tabId === tab.id
      && selectedBeforeMapping.rowKey !== selectedAfterMapping.rowKey
      && selectedBeforeMapping.column === selectedAfterMapping.column) {
      signalDetailIdentityRemap(tab, selectedBeforeMapping, selectedAfterMapping.rowKey);
    }

    const capturedSelectionStillActive = !historyView?.selectedCell
      || sameSelectedCellIdentity(selectedAfterMapping, capturedCell);
    const draftRevisionUnchanged = historyView?.textDraftRevision == null
      || textDraftRevision.value === historyView.textDraftRevision;

    if (selectedCell.value?.tabId === tab.id && isInsertRowKey(selectedCell.value.rowKey)) {
      if (capturedSelectionStillActive && draftRevisionUnchanged) syncSelectedTextDraft(tab);
      return;
    }
    if (selectedValueChanged
      && !editingCell.value
      && capturedSelectionStillActive
      && draftRevisionUnchanged
      && draftBeforeSync === expectedSelectedDraft
      && textDraft.value === draftBeforeSync) {
      syncSelectedTextDraft(tab);
    }
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

  function rowSaveToken(tab, initialRow) {
    const identity = buildRowIdentity(tab, initialRow);
    return `${tabScopeKey(tab)}\u001f${JSON.stringify(identity)}`;
  }

  function acquireRowSaveLane(tab, row, initialRow) {
    if (!(editState.rowSaveTokens instanceof WeakMap)) editState.rowSaveTokens = new WeakMap();
    if (!(editState.rowSaveLanes instanceof Map)) editState.rowSaveLanes = new Map();
    let lane = editState.rowSaveTokens.get(row);
    if (lane && typeof lane !== "object") lane = editState.rowSaveLanes.get(lane) || null;
    const tokenForRow = (candidate) => rowSaveToken(tab, candidate);
    const token = tokenForRow(initialRow);
    if (!lane) lane = editState.rowSaveLanes.get(token);
    if (!lane) {
      lane = { token, tokenForRow, confirmedRow: { ...initialRow }, pendingCount: 0 };
    }
    editState.rowSaveTokens.set(row, lane);
    editState.rowSaveLanes.set(lane.token, lane);
    lane.pendingCount += 1;
    return lane;
  }

  function releaseRowSaveLane(lane) {
    if (!lane) return;
    lane.pendingCount -= 1;
    if (lane.pendingCount === 0 && editState.rowSaveLanes.get(lane.token) === lane) {
      editState.rowSaveLanes.delete(lane.token);
    }
  }

  function enqueueRowSave(tab, row, initialRow, undoTransaction, worker) {
    const lane = acquireRowSaveLane(tab, row, initialRow);
    const run = enqueueMutationTask(undoTransaction?.mutationTurn, () => worker(lane));
    return run.finally(() => {
      releaseRowSaveLane(lane);
    });
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

  function recordInsertDraftHistory(
    tab,
    beforeRows,
    { label = "编辑新增行", cellCount = 0, undoTransaction = null, afterRows = null } = {},
  ) {
    const changes = changedInsertDraftRows(beforeRows, afterRows || captureInsertDraftState(tab));
    if (changes.length === 0) return false;
    const ownsTransaction = !undoTransaction;
    const transaction = undoTransaction || createUndoTransaction(editState, {
      tableName: tabScopeKey(tab),
      tabId: tab.id,
      label,
    });
    const recorded = recordUndoEntry(editState, {
      kind: "insert-draft-batch",
      tableName: tabScopeKey(tab),
      tabId: tab.id,
      label,
      cellCount: Math.max(0, Number(cellCount) || 0),
      changes,
    }, transaction);
    if (ownsTransaction) commitUndoTransaction(editState, transaction);
    return recorded;
  }

  function pruneInsertDraftHistory(tab, rowIds = null) {
    const ids = rowIds == null
      ? null
      : new Set((Array.isArray(rowIds) ? rowIds : [rowIds]).filter(Boolean));
    const scope = tabScopeKey(tab);
    const pruneEntry = (entry) => {
      if (entry?.kind === "history-composite") {
        const entries = (Array.isArray(entry.entries) ? entry.entries : []).map(pruneEntry).filter(Boolean);
        if (entries.length === 0) return null;
        if (entries.length === 1) {
          if (entry.historyTransactionId != null) entries[0].historyTransactionId = entry.historyTransactionId;
          return entries[0];
        }
        entry.entries = entries;
        return entry;
      }
      if (entry?.kind !== "insert-draft-batch"
        || entry.tabId !== tab?.id
        || entry.tableName !== scope) return entry;
      entry.changes = ids
        ? entry.changes.filter((change) => !ids.has(change.rowId))
        : [];
      if (entry.changes.length === 0) entry.invalidated = true;
      return entry.changes.length > 0 ? entry : null;
    };
    for (const stack of [editState.undoStack, editState.redoStack]) {
      if (!Array.isArray(stack)) continue;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const entry = pruneEntry(stack[index]);
        if (entry) stack[index] = entry;
        else stack.splice(index, 1);
      }
    }
    if (editState.pendingUndoTransactions instanceof Map) {
      for (const transaction of editState.pendingUndoTransactions.values()) {
        if (transaction?.committed || transaction?.tableName !== scope) continue;
        transaction.entries = (Array.isArray(transaction.entries) ? transaction.entries : [])
          .map(pruneEntry)
          .filter(Boolean);
      }
    }
    if (editState.activeHistoryEntries instanceof Map) {
      for (const action of editState.activeHistoryEntries.values()) {
        if (!action?.entry) continue;
        action.entry = pruneEntry(action.entry);
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

  function cloneInsertDraftSnapshot(snapshot) {
    return snapshot ? { ...snapshot, draft: { ...(snapshot.draft || {}) } } : null;
  }

  function applyInsertDraftSnapshotDelta(base, before, after) {
    if (!before) return cloneInsertDraftSnapshot(after || base);
    if (!after) return null;
    if (!base) return cloneInsertDraftSnapshot(after);
    const result = cloneInsertDraftSnapshot(base);
    const beforeDraft = before.draft || {};
    const afterDraft = after.draft || {};
    for (const column of new Set([...Object.keys(beforeDraft), ...Object.keys(afterDraft)])) {
      const beforeHas = Object.prototype.hasOwnProperty.call(beforeDraft, column);
      const afterHas = Object.prototype.hasOwnProperty.call(afterDraft, column);
      const beforeValue = beforeHas ? String(beforeDraft[column] ?? "") : null;
      const afterValue = afterHas ? String(afterDraft[column] ?? "") : null;
      if (beforeHas === afterHas && beforeValue === afterValue) continue;
      if (afterHas) result.draft[column] = afterDraft[column];
      else delete result.draft[column];
    }
    if ((before.anchorIndex ?? null) !== (after.anchorIndex ?? null)) {
      result.anchorIndex = after.anchorIndex ?? null;
    }
    if ((before.visible !== false) !== (after.visible !== false)) {
      result.visible = after.visible !== false;
    }
    return result;
  }

  function forEachInsertDraftHistoryEntry(entry, visit) {
    if (!entry) return;
    if (entry.kind === "history-composite") {
      for (const child of entry.entries || []) forEachInsertDraftHistoryEntry(child, visit);
      return;
    }
    if (entry.kind === "insert-draft-batch") visit(entry);
  }

  function rebaseFutureInsertDraftHistory(tab, rowId, source, target, mutationTurnId) {
    const turnId = Number(mutationTurnId);
    if (!Number.isFinite(turnId)) return;
    const scope = tabScopeKey(tab);
    const tabId = tab?.id;
    let sourceState = cloneInsertDraftSnapshot(source);
    let targetState = cloneInsertDraftSnapshot(target);
    const roots = [];
    const seen = new Set();
    const addRoot = (entry, candidateTurnId = entry?.mutationTurnId) => {
      const futureTurnId = Number(candidateTurnId);
      if (!entry || seen.has(entry) || !Number.isFinite(futureTurnId) || futureTurnId <= turnId) return;
      seen.add(entry);
      roots.push({ entry, futureTurnId });
    };
    for (const rootEntry of editState.undoStack || []) addRoot(rootEntry);
    for (const transaction of editState.pendingUndoTransactions?.values?.() || []) {
      for (const entry of transaction?.entries || []) addRoot(entry, transaction?.mutationTurn?.id);
    }
    for (const action of editState.activeHistoryEntries?.values?.() || []) addRoot(action?.entry);
    roots.sort((left, right) => left.futureTurnId - right.futureTurnId);
    for (const { entry: rootEntry } of roots) {
      forEachInsertDraftHistoryEntry(rootEntry, (draftEntry) => {
        if (draftEntry.tableName !== scope || draftEntry.tabId !== tabId) return;
        const change = draftEntry.changes?.find((candidate) => candidate.rowId === rowId);
        if (!change || !sameInsertDraftSnapshot(change.before, sourceState)) return;
        const originalAfter = cloneInsertDraftSnapshot(change.after);
        const rebasedAfter = applyInsertDraftSnapshotDelta(targetState, change.before, change.after);
        change.before = cloneInsertDraftSnapshot(targetState);
        change.after = cloneInsertDraftSnapshot(rebasedAfter);
        sourceState = originalAfter;
        targetState = cloneInsertDraftSnapshot(rebasedAfter);
      });
    }
  }

  function applyInsertDraftHistoryEntry(entry, direction, targetTab = null, historyContext = null) {
    const tab = targetTab || activeTab.value;
    if (!tab || entry?.kind !== "insert-draft-batch"
      || entry.tabId !== tab.id
      || entry.tableName !== tabScopeKey(tab)) {
      return { ok: false, reason: "当前表不匹配" };
    }
    const sourceField = direction === "redo" ? "before" : "after";
    const targetField = direction === "redo" ? "after" : "before";
    const rows = getInsertRows(tab);
    for (const change of entry.changes) {
      const source = change[sourceField];
      const target = change[targetField];
      rebaseFutureInsertDraftHistory(
        tab,
        change.rowId,
        source,
        target,
        historyContext?.mutationTurnId,
      );
      const currentIndex = rows.findIndex((row) => row.id === change.rowId);
      const current = currentIndex >= 0 ? rows[currentIndex] : null;
      if (source && !target) {
        if (current && sameInsertDraftSnapshot(insertDraftSnapshot(current, currentIndex), source)) {
          rows.splice(currentIndex, 1);
        }
        continue;
      }
      if (!source && target) {
        if (!current) {
          rows.splice(Math.max(0, Math.min(rows.length, target.index)), 0, {
            id: target.id,
            draft: { ...(target.draft || {}) },
            anchorIndex: target.anchorIndex ?? null,
            visible: target.visible !== false,
          });
        }
        continue;
      }
      if (!source || !target || !current) continue;
      const sourceDraft = source.draft || {};
      const targetDraft = target.draft || {};
      for (const column of new Set([...Object.keys(sourceDraft), ...Object.keys(targetDraft)])) {
        const sourceHas = Object.prototype.hasOwnProperty.call(sourceDraft, column);
        const currentHas = Object.prototype.hasOwnProperty.call(current.draft || {}, column);
        const sourceValue = sourceHas ? String(sourceDraft[column] ?? "") : null;
        const currentValue = currentHas ? String(current.draft[column] ?? "") : null;
        if (sourceHas !== currentHas || sourceValue !== currentValue) continue;
        if (Object.prototype.hasOwnProperty.call(targetDraft, column)) {
          current.draft[column] = targetDraft[column];
        } else {
          delete current.draft[column];
        }
      }
      if ((current.anchorIndex ?? null) === (source.anchorIndex ?? null)) {
        current.anchorIndex = target.anchorIndex ?? null;
      }
      if ((current.visible !== false) === (source.visible !== false)) {
        current.visible = target.visible !== false;
      }
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
    const next = new Set(editState.pendingInsertRows);
    const key = insertSavingKey(tab, rowId);
    if (saving) next.add(key);
    else next.delete(key);
    editState.pendingInsertRows = next;
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

  function insertDraftBatchRelative(tab, target, direction, count = 1, options = {}) {
    if (!tab?.id) return;
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
    const maxCount = Math.max(1, Math.floor(Number(options.maxCount) || 99));
    const normalizedCount = Math.max(1, Math.min(maxCount, Math.floor(Number(count) || 1)));
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
    const drafts = Array.isArray(options.drafts) ? options.drafts : [];
    const newRows = [];
    for (let index = 0; index < normalizedCount; index++) {
      const newRow = createInsertRow(anchorIndex);
      newRow.draft = { ...(drafts[index] || {}) };
      rows.splice(storageIndex + index, 0, newRow);
      newRows.push(newRow);
    }
    refreshInsertDraftPrimaryKeyFeedback(tab);
    recordInsertDraftHistory(tab, beforeRows, {
      label: options.label || (normalizedCount > 1 ? `新增 ${normalizedCount} 行` : "新增行"),
      cellCount: Math.max(0, Number(options.cellCount) || 0),
    });
    const columnIndex = firstEditableColumnIndex();
    selectInsertCell(tab, newRows[0].id, columnIndex, { scrollColumn: false });
    return newRows;
  }

  function insertDraftRelative(tab, target, direction) {
    return insertDraftBatchRelative(tab, target, direction, 1)?.[0];
  }

  function insertDraftAbove(tab, target) {
    return insertDraftRelative(tab, target, "above");
  }

  function insertDraftBelow(tab, target) {
    return insertDraftRelative(tab, target, "below");
  }

  function insertDraftsAbove(tab, target, count) {
    return insertDraftBatchRelative(tab, target, "above", count);
  }

  function insertDraftsBelow(tab, target, count) {
    return insertDraftBatchRelative(tab, target, "below", count);
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
    if (selectedInsertCellMatches(tab, row.id, column)) updateTextDraft(value);
    refreshInsertDraftPrimaryKeyFeedback(tab);
  }

  function clearInsertDraft(tab, rowId, { force = false } = {}) {
    if (!tab?.id) return false;
    if (!force) {
      const lockedRowId = rowId || getInsertRows(tab).find((row) => isInsertRowSaving(tab, row.id))?.id;
      if (lockedRowId && rejectInsertRowMutationWhileSaving(tab, lockedRowId)) return false;
    }
    if (!rowId) {
      pruneInsertDraftHistory(tab);
      getInsertRows(tab).splice(0);
      reconcileInsertDraftSelection(tab);
      selectedInsertCell.value = null;
      selectedInsertRow.value = null;
      selectedCell.value = null;
      selectedRange.value = null;
      editingCell.value = null;
      editDraft.value = "";
      textDraft.value = "";
      return true;
    }
    pruneInsertDraftHistory(tab, rowId);
    const rows = getInsertRows(tab);
    const index = rows.findIndex((row) => row.id === rowId);
    if (index >= 0) rows.splice(index, 1);
    reconcileInsertDraftSelection(tab);
    if (selectedInsertCell.value?.tabId === tab.id && selectedInsertCell.value.rowId === rowId) selectedInsertCell.value = null;
    if (selectedInsertRow.value?.tabId === tab.id && selectedInsertRow.value.rowId === rowId) selectedInsertRow.value = null;
    return true;
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

  // 查找替换在选区内导航（Excel 行为）：保留选区，仅移动活动单元格高亮、
  // 文本面板与滚动位置，不收拢 selectedRange。
  function activateCellInRange(tab, target) {
    if (!tab || !target) return;
    if (target.kind === "insert") {
      const rowId = target.insertRow?.id;
      if (rowId == null) return;
      showInsertRow(tab, { rowId, ensureTrailing: false });
      const position = insertPosition(tab, rowId, target.columnIndex);
      selectedInsertRow.value = null;
      selectedInsertCell.value = { tabId: tab.id, rowId, columnIndex: target.columnIndex, column: target.column };
      selectedCell.value = { tabId: tab.id, rowKey: position.rowKey, column: target.column };
      textDraft.value = insertDraftValue(tab, rowId, target.column);
      scrollInsertCellIntoView(target.columnIndex, position.rowIndex, { scrollColumn: false });
      return;
    }
    selectedInsertCell.value = null;
    const position = cellPosition(tab, target.row, target.column, target.rowIndex, target.columnIndex);
    selectedCell.value = { tabId: tab.id, rowKey: position.rowKey, column: target.column };
    textDraft.value = editableCellValue(target.row, target.column);
    scrollCellIntoView(target.rowIndex, target.columnIndex);
  }

  function isCoordinateInBounds(bounds, rowIndex, columnIndex) {
    return Boolean(bounds)
      && rowIndex >= bounds.top
      && rowIndex <= bounds.bottom
      && columnIndex >= bounds.left
      && columnIndex <= bounds.right;
  }

  function isRenderedSelectionCoordinateSelected(state, rowIndex, columnIndex) {
    if (!state?.selection || !state.bounds) return false;
    const baseSelected = isCoordinateInBounds(state.bounds, rowIndex, columnIndex);
    if (state.toggleKeys.size === 0) return baseSelected;
    return state.toggleKeys.has(gridCellCoordinateKey(rowIndex, columnIndex)) ? !baseSelected : baseSelected;
  }

  function isCellInSelectedRange(tab, rowKey, column, rowIndex, columnIndex) {
    const state = selectionRenderState.value;
    if (!tab || !state.selection || state.selection.tabId !== tab.id) return false;
    return isRenderedSelectionCoordinateSelected(state, rowIndex, columnIndex);
  }

  function getCellRangeClasses(tab, rowKey, column, rowIndex, columnIndex) {
    const state = selectionRenderState.value;
    const range = state.selection;
    const inRange = tab && range?.tabId === tab.id
      && isRenderedSelectionCoordinateSelected(state, rowIndex, columnIndex);
    if (!inRange || !range) return EMPTY_CELL_RANGE_CLASSES;
    const isAnchor =
      range.shiftAnchor?.rowIndex === rowIndex &&
      range.shiftAnchor?.columnIndex === columnIndex;
    const selectedAt = (nextRow, nextColumn) => (
      isRenderedSelectionCoordinateSelected(state, nextRow, nextColumn)
    );
    const classes = {
      "range-selected": inRange,
      "range-top": !selectedAt(rowIndex - 1, columnIndex),
      "range-bottom": !selectedAt(rowIndex + 1, columnIndex),
      "range-left": !selectedAt(rowIndex, columnIndex - 1),
      "range-right": !selectedAt(rowIndex, columnIndex + 1),
      "range-anchor": isAnchor,
    };
    const baseBounds = state.bounds;
    const singletonBaseWithToggles = baseBounds
      && baseBounds.top === baseBounds.bottom
      && baseBounds.left === baseBounds.right
      && (range.toggledCells?.length || 0) > 0;
    if (singletonBaseWithToggles || !isCoordinateInBounds(baseBounds, rowIndex, columnIndex)) {
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
    if (range.focus?.rowIndex === rowIndex && range.focus?.columnIndex === columnIndex) return;
    const resolved = positionFromIndexes(tab, rowIndex, columnIndex);
    if (!resolved) return;
    selectedRange.value = createGridSelection(tab.id, range.anchor, resolved.position, {
      shiftAnchor: range.shiftAnchor || range.anchor,
      toggledCells: range.toggledCells || [],
    });
    setActiveSelectionPosition(tab, resolved);
  }

  function renderedCellIndexesFromPointer(wrap, event) {
    const selector = `td[${VISUAL_ROW_INDEX_ATTRIBUTE}][${COLUMN_INDEX_ATTRIBUTE}]`;
    let cell = event?.target?.closest?.(selector) || null;
    if (
      !cell
      && Number.isFinite(event?.clientX)
      && Number.isFinite(event?.clientY)
    ) {
      cell = wrap?.ownerDocument
        ?.elementFromPoint?.(event.clientX, event.clientY)
        ?.closest?.(selector) || null;
    }
    if (!cell) return null;
    if (typeof wrap?.contains === "function" && !wrap.contains(cell)) return null;
    const rowIndexValue = cell.getAttribute?.(VISUAL_ROW_INDEX_ATTRIBUTE);
    const columnIndexValue = cell.getAttribute?.(COLUMN_INDEX_ATTRIBUTE);
    if (rowIndexValue == null || columnIndexValue == null) return null;
    const rowIndex = Number(rowIndexValue);
    const columnIndex = Number(columnIndexValue);
    if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndex)) return null;
    return { rowIndex, columnIndex };
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
    const rowCount = selectableRowCount(tab);
    if (rowCount === 0) return -1;
    const rect = wrap.getBoundingClientRect();
    const fieldCommentBandHeight = tab?.fieldCommentsExpanded === false
      ? GRID_FIELD_COMMENT_COLLAPSED_HEIGHT
      : resolveFieldCommentHeight(tab);
    const headerBandHeight = GRID_HEADER_HEIGHT + fieldCommentBandHeight;
    const y = clientY - rect.top + wrap.scrollTop - headerBandHeight;
    return Math.max(0, Math.min(rowCount - 1, Math.floor(y / resolveGridRowHeight(tab))));
  }

  function updateRangeFocusFromPointer(event) {
    const tab = activeTab.value;
    const wrap = gridWrapRef.value;
    const range = selectedRange.value;
    if (!tab || !wrap || !range || range.tabId !== tab.id || selectableRowCount(tab) === 0 || activeColumns.value.length === 0) return;
    const renderedIndexes = renderedCellIndexesFromPointer(wrap, event);
    const rowIndex = renderedIndexes?.rowIndex ?? rowIndexFromPointer(wrap, event.clientY, tab);
    const columnIndex = renderedIndexes?.columnIndex ?? columnIndexFromPointer(wrap, event.clientX);
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

  function rangeAutoscrollTarget(wrap, event) {
    const rect = wrap.getBoundingClientRect();
    let nextTop = wrap.scrollTop;
    let nextLeft = wrap.scrollLeft;
    if (event.clientY < rect.top + RANGE_AUTOSCROLL_EDGE) nextTop -= autoscrollStep(rect.top + RANGE_AUTOSCROLL_EDGE - event.clientY);
    else if (event.clientY > rect.bottom - RANGE_AUTOSCROLL_EDGE) nextTop += autoscrollStep(event.clientY - (rect.bottom - RANGE_AUTOSCROLL_EDGE));
    if (event.clientX < rect.left + ROW_INDEX_WIDTH + RANGE_AUTOSCROLL_EDGE) nextLeft -= autoscrollStep(rect.left + ROW_INDEX_WIDTH + RANGE_AUTOSCROLL_EDGE - event.clientX);
    else if (event.clientX > rect.right - RANGE_AUTOSCROLL_EDGE) nextLeft += autoscrollStep(event.clientX - (rect.right - RANGE_AUTOSCROLL_EDGE));
    return {
      top: Math.max(0, nextTop),
      left: Math.max(0, nextLeft),
    };
  }

  function runRangeAutoscroll() {
    rangeAutoscrollFrame = 0;
    if (!isSelectingRange.value || !lastRangePointerEvent) return;
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    const event = lastRangePointerEvent;
    const previousTop = wrap.scrollTop;
    const previousLeft = wrap.scrollLeft;
    const target = rangeAutoscrollTarget(wrap, event);
    if (target.top === previousTop && target.left === previousLeft) return;
    wrap.scrollTop = target.top;
    wrap.scrollLeft = target.left;
    if (wrap.scrollTop === previousTop && wrap.scrollLeft === previousLeft) return;
    updateRangeFocusFromPointer(event);
    rangeAutoscrollFrame = requestAnimationFrame(runRangeAutoscroll);
  }

  function startRangeAutoscroll(event) {
    lastRangePointerEvent = event;
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    const target = rangeAutoscrollTarget(wrap, event);
    if (target.top === wrap.scrollTop && target.left === wrap.scrollLeft) {
      stopRangeAutoscroll();
      return;
    }
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
    // CellDetailPanel commits only its own dirty draft before a selection
    // change. Re-saving the shared textDraft here can race an optimistic paste
    // and write the previous cell value back over the pasted cells.
    clearColumnSelection();
    const rowKey = buildRowKey(tab, row);
    clearCellError(editState, tabScopeKey(tab), rowKey, column);
    selectedCell.value = { tabId: tab.id, rowKey, column };
    textDraft.value = editableCellValue(row, column);
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
    const shiftSelect = Boolean(event?.shiftKey);
    const toggleSelect = Boolean((event?.ctrlKey || event?.metaKey) && !event?.shiftKey);

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
      isSelectingRange.value = true;
      setActiveSelectionPosition(tab, { row, position });
    }
    nextTick(() => gridWrapRef.value?.focus());
  }

  function extendRangeSelection(tab, row, column, rowIndex, columnIndex) {
    const range = selectedRange.value;
    if (!isSelectingRange.value || !range || range.tabId !== tab.id) return;
    if (range.focus?.rowIndex === rowIndex && range.focus?.columnIndex === columnIndex) return;
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
    return visualRowEntries(tab).map((entry, rowIndex) => ({
      entry,
      rowIndex,
      row: entry.type === "insert" ? entry.insertRow?.draft || {} : entry.row,
      rowKey: gridRowKey(tab, entry.row),
    })).filter((item) => selectedKeys.has(item.rowKey));
  }

  function selectedInsertDraftRows(tab) {
    const rows = selectedWholeRows(tab)
      .filter(({ entry }) => entry.type === "insert" && entry.insertRow)
      .map(({ entry }) => entry.insertRow);
    const activeRowId = selectedInsertRow.value?.tabId === tab?.id
      ? selectedInsertRow.value.rowId
      : null;
    const activeRow = activeRowId
      ? getInsertRows(tab).find((candidate) => candidate.id === activeRowId)
      : null;
    if (activeRow && !rows.some((candidate) => candidate.id === activeRow.id)) rows.unshift(activeRow);
    return rows;
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

  function canInsertCopiedRows(tab = activeTab.value) {
    if (!tab || isReadOnlyTab(tab)) return false;
    const payload = peekGridClipboardPayload();
    if (payload?.kind !== "full-row" || !Array.isArray(payload.matrix) || payload.matrix.length === 0) return false;
    const targetColumns = new Map(columnsForTab(tab).map((column) => [columnName(column), column]));
    return Array.isArray(payload.columnNames) && payload.columnNames.some((name) => {
      const column = targetColumns.get(name);
      return column && !isDatabaseGeneratedColumn(column);
    });
  }

  function insertCopiedRowsAbove(tab, target, text) {
    if (!tab?.id) return { ok: false, message: "当前表不可用" };
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return { ok: false, message: statusText.value };
    }
    const cachedPayload = text == null ? peekGridClipboardPayload() : null;
    const clipboardText = String(text ?? cachedPayload?.text ?? "");
    const matrix = parseGridTsv(clipboardText);
    const payload = copiedFullRowPayload(clipboardText, matrix);
    if (!payload) {
      statusText.value = "剪贴板内容已变化，请重新复制整行";
      return { ok: false, message: statusText.value };
    }
    const targetColumns = new Map(columnsForTab(tab).map((column) => [columnName(column), column]));
    const writableSourceIndexes = payload.columnNames
      .map((name, sourceIndex) => {
        const column = targetColumns.get(name);
        return column && !isDatabaseGeneratedColumn(column) ? sourceIndex : -1;
      })
      .filter((sourceIndex) => sourceIndex >= 0);
    if (writableSourceIndexes.length === 0) {
      statusText.value = "无法插入复制行：当前表没有可写入的匹配字段";
      return { ok: false, message: statusText.value };
    }
    const drafts = matrix.map((sourceRow) => {
      const draft = {};
      for (const sourceIndex of writableSourceIndexes) {
        draft[payload.columnNames[sourceIndex]] = String(sourceRow[sourceIndex] ?? "");
      }
      return draft;
    });
    const insertedRows = insertDraftBatchRelative(tab, target, "above", drafts.length, {
      drafts,
      label: "粘贴整行到当前行上方",
      cellCount: drafts.length * writableSourceIndexes.length,
      maxCount: drafts.length,
    });
    if (!insertedRows?.length) return { ok: false, message: statusText.value || "无法插入复制行" };
    statusText.value = `已在当前行上方插入 ${insertedRows.length} 条复制行，保存后写入数据库`;
    return {
      ok: true,
      insertedRows: insertedRows.length,
      pastedCells: drafts.length * writableSourceIndexes.length,
    };
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
    const afterInsertRows = clearedDrafts > 0 ? captureInsertDraftState(tab) : null;
    const undoTransaction = clearedDrafts > 0 && edits.length > 0
      ? createUndoTransaction(editState, { tableName: tabScopeKey(tab), tabId: tab.id, label: "清空选区" })
      : null;
    const historyOperation = undoTransaction ? beginHistoryOperation(editState, tabScopeKey(tab)) : null;
    if (edits.length === 0) {
      if (clearedDrafts > 0) {
        recordInsertDraftHistory(tab, beforeInsertRows, {
          label: "清空新增行单元格",
          cellCount: clearedDrafts,
          afterRows: afterInsertRows,
        });
      }
      if (clearedDrafts > 0) statusText.value = `已清空 ${clearedDrafts} 个单元格`;
      return { ok: true, successCount: clearedDrafts, failureCount: 0 };
    }
    let keepDraftClears = clearedDrafts === 0;
    try {
      const batch = await commitCellBatch(tab, edits, {
        successMessage: (count) => `已清空 ${count + clearedDrafts} 个单元格`,
        failureLabel: "批量清空保存",
        undoTransaction,
        historyOperation,
      });
      const savedEditFailed = batch.results?.some((result) => result && !result.ok) || false;
      if (!savedEditFailed && clearedDrafts > 0) {
        keepDraftClears = true;
        recordInsertDraftHistory(tab, beforeInsertRows, {
          label: "清空新增行单元格",
          cellCount: clearedDrafts,
          undoTransaction,
          afterRows: afterInsertRows,
        });
      }
      return batch;
    } finally {
      if (!keepDraftClears && afterInsertRows) {
        rollbackInsertDraftPaste(
          tab,
          beforeInsertRows,
          afterInsertRows,
          undoTransaction?.mutationTurn?.id,
        );
      }
      if (undoTransaction) commitUndoTransaction(editState, undoTransaction);
      if (historyOperation) finishHistoryOperation(editState, historyOperation);
    }
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
    updateTextDraft(editDraft.value);
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

  // 单个新增行草稿格的值替换（查找替换"替换当前"用），带独立历史记录。
  function commitInsertDraftCellValue(tab, rowId, column, value) {
    if (rejectInsertRowMutationWhileSaving(tab, rowId)) return { ok: false, reason: "新增行正在保存" };
    const beforeRows = captureInsertDraftState(tab);
    updateInsertDraft(tab, rowId, column, value);
    recordInsertDraftHistory(tab, beforeRows, { label: "查找替换新增行", cellCount: 1 });
    return { ok: true };
  }

  // 选区内查找替换：数据行单元格走 commitCellBatch 原子批量提交，新增行草稿
  // 格走 insert-draft 历史；两者共享同一个撤销事务，Ctrl+Z 一次全部撤回。
  async function replaceSelectionCells(tab, range, { query, replacement, caseSensitive } = {}) {
    if (!tab || !range || range.tabId !== tab.id) return { ok: false, reason: "当前没有多选单元格" };
    const beforeInsertRows = captureInsertDraftState(tab);
    const edits = [];
    const draftEdits = [];
    let replacedCount = 0;
    for (const { entry, column } of selectedGridCells(tab, range)) {
      if (entry.type === "insert") {
        if (rejectInsertRowMutationWhileSaving(tab, entry.insertRow?.id)) continue;
        const draftText = String(entry.insertRow?.draft?.[column] ?? "");
        const next = replaceSearchText(draftText, query, replacement, { caseSensitive });
        if (!next.replacedCount) continue;
        replacedCount += next.replacedCount;
        draftEdits.push({ insertRow: entry.insertRow, column, value: next.text });
        continue;
      }
      if (entry.type !== "data" || !entry.row) continue;
      const value = displayCellValue(editState, tab, entry.row, column);
      const next = replaceSearchText(value, query, replacement, { caseSensitive });
      if (!next.replacedCount) continue;
      replacedCount += next.replacedCount;
      edits.push({ row: entry.row, column, value: next.text });
    }
    if (!edits.length && !draftEdits.length) return { ok: true, replaced: 0, cells: 0 };

    const undoTransaction = createUndoTransaction(editState, {
      tableName: tabScopeKey(tab),
      tabId: tab.id,
      label: "查找替换",
    });
    const historyOperation = beginHistoryOperation(editState, tabScopeKey(tab));
    try {
      let batch = { ok: true, successCount: 0, results: [] };
      if (edits.length) {
        batch = await commitCellBatch(tab, edits, {
          successMessage: (count) => `已在选区内替换 ${count + draftEdits.length} 个单元格`,
          failureLabel: "选区替换",
          undoTransaction,
          historyOperation,
        });
      }
      const savedEditFailed = batch.results?.some((result) => result && !result.ok) || false;
      if (!savedEditFailed && draftEdits.length) {
        for (const { insertRow, column, value } of draftEdits) {
          updateInsertDraft(tab, insertRow.id, column, value);
        }
        recordInsertDraftHistory(tab, beforeInsertRows, {
          label: "查找替换新增行",
          cellCount: draftEdits.length,
          undoTransaction,
        });
      }
      if (!edits.length && draftEdits.length) {
        statusText.value = `已在选区内替换 ${draftEdits.length} 个新增行单元格`;
      }
      return {
        ok: batch.ok,
        replaced: replacedCount,
        cells: Number(batch.successCount ?? 0) + (savedEditFailed ? 0 : draftEdits.length),
        reason: batch.ok ? "" : batch.message || "选区替换失败",
      };
    } finally {
      commitUndoTransaction(editState, undoTransaction);
      finishHistoryOperation(editState, historyOperation);
    }
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
      (input || gridWrapRef.value)?.focus?.();
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

  function signalDetailIdentityRemap(tab, previousCell, nextRowKey) {
    if (!tab || !previousCell || previousCell.rowKey === nextRowKey) return;
    detailIdentityRemap.value = {
      id: nextDetailIdentityRemapId++,
      tabId: tab.id,
      previousRowKey: previousCell.rowKey,
      nextRowKey,
      column: previousCell.column,
      kind: previousCell.kind || "data",
    };
  }

  function remapSelectedRowKey(tab, previousRowKey, nextRowKey, { signalDetail = true } = {}) {
    if (!tab || !previousRowKey || previousRowKey === nextRowKey) return;
    const errorPrefix = `${tabScopeKey(tab)}\x1f${previousRowKey}\x1f`;
    for (const [key, message] of [...(editState.cellErrors?.entries?.() || [])]) {
      if (!String(key).startsWith(errorPrefix)) continue;
      const nextErrorKey = cellErrorKey(tab, nextRowKey, String(key).slice(errorPrefix.length));
      editState.cellErrors.delete(key);
      if (!editState.cellErrors.has(nextErrorKey)) editState.cellErrors.set(nextErrorKey, message);
    }
    const previousCell = selectedCell.value?.tabId === tab.id && selectedCell.value.rowKey === previousRowKey
      ? { ...selectedCell.value }
      : null;
    if (previousCell) {
      if (signalDetail) signalDetailIdentityRemap(tab, previousCell, nextRowKey);
      selectedCell.value = { ...selectedCell.value, rowKey: nextRowKey };
    }
    if (selectedRange.value?.tabId === tab.id) {
      const dataIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(nextRowKey);
      const visualRowIndex = dataIndex >= 0 ? visualRowIndexOfDataRow(tab, dataIndex) : -1;
      const remapPosition = (position) => position?.rowKey === previousRowKey
        ? {
            ...position,
            rowKey: nextRowKey,
            ...(visualRowIndex >= 0 ? { rowIndex: visualRowIndex } : {}),
          }
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

  function loadedMutationRow(tab, row) {
    const referencedRow = row ? toRaw(row) : null;
    if (!referencedRow) return null;
    const loadedRows = tabRows(tab);
    const loadedIndex = loadedRows.indexOf(referencedRow);
    if (loadedIndex < 0) return null;
    const absoluteStart = ensureTabRowStore(tab)?.absoluteStart || 0;
    return { row: loadedRows[loadedIndex], rowIndex: absoluteStart + loadedIndex };
  }

  function mutationCellValue(value) {
    return value == null ? null : String(value);
  }

  function rowMatchesSnapshot(row, snapshot) {
    if (!row || !snapshot) return false;
    return Object.keys(snapshot).every((column) => (
      mutationCellValue(row[column]) === mutationCellValue(snapshot[column])
    ));
  }

  function resolveMutationRow(tab, originalRow, candidates = []) {
    const loaded = loadedMutationRow(tab, originalRow);
    if (loaded) return loaded;
    const index = createRowIndex(tab, { buildRowKey });
    for (const candidate of candidates) {
      if (!candidate?.rowKey) continue;
      const row = index.rowForKey(candidate.rowKey);
      const rowIndex = index.indexOfKey(candidate.rowKey);
      if (!row || rowIndex < 0) continue;
      if (candidate.snapshot && !rowMatchesSnapshot(row, candidate.snapshot)) continue;
      return { row, rowIndex };
    }
    return { row: null, rowIndex: -1 };
  }

  function rebaseResolvedRow(row, confirmedRow) {
    if (row && confirmedRow) rebaseRowSaveLane(editState, row, confirmedRow);
  }

  async function commitCellValue(tab, row, column, nextValue, options = {}) {
    const {
      showFeedback = true,
      updateStatus = true,
      undoGroupId = null,
      undoRowId = null,
      undoTransaction = null,
      historyOperation = null,
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
    const sessionId = tab.sessionId;
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
    const ownsUndoTransaction = !undoTransaction;
    const activeUndoTransaction = undoTransaction || createUndoTransaction(editState, {
      tableName: tabScopeKey(tab),
      tabId: tab.id,
      label: "编辑单元格",
    });
    const ownsHistoryOperation = !historyOperation;
    const activeHistoryOperation = historyOperation || beginHistoryOperation(editState, tabScopeKey(tab));
    try {
      const key = startCellCommit(editState, {
        tableName: tabScopeKey(tab),
        tabId: tab.id,
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
        rowRef: row,
      });
    const commitId = editState.pendingCells.get(key)?.commitId;
    setLatestCellCommit(row, column, commitId);
    const rowIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(rowKey);
    mutateTabRow(tab, rowIndex, (current) => {
      current[column] = value;
      return current;
    });
    let confirmedBeforeRow = beforeRow;
    let confirmedAfterRow = afterRow;
    try {
      const save = await enqueueRowSave(tab, row, beforeRow, activeUndoTransaction, async (lane) => {
        confirmedBeforeRow = { ...lane.confirmedRow };
        confirmedAfterRow = { ...confirmedBeforeRow, [column]: value };
        const confirmedOldValue = confirmedBeforeRow[column] == null ? null : String(confirmedBeforeRow[column]);
        if (confirmedOldValue === value) return { skipped: true };
        const result = await invokeWorkbench("update_cell", {
          request: {
            sessionId,
            rowIdentity: buildRowIdentity(tab, confirmedBeforeRow),
            columnName: column,
            oldValue: confirmedOldValue,
            newValue: value,
          },
        });
        if (result?.conflict) throw new Error("数据已被别人修改，请刷新后再试");
        if (result?.updated === false) throw new Error("保存未影响任何数据，请刷新后再试");
        rebaseRowSaveLane(editState, row, confirmedAfterRow);
        return { skipped: false };
      });
      const confirmedRowKey = buildRowKey(tab, confirmedBeforeRow);
      const confirmedSavedRowKey = buildRowKey(tab, confirmedAfterRow);
      const confirmedOldValue = confirmedBeforeRow[column] == null ? null : String(confirmedBeforeRow[column]);
      const resolvedRow = resolveMutationRow(tab, row, [
        { rowKey: confirmedSavedRowKey },
        { rowKey: confirmedRowKey, snapshot: confirmedBeforeRow },
      ]);
      if (resolvedRow.row) {
        mutateTabRow(tab, resolvedRow.rowIndex, (current) => {
          const currentValue = mutationCellValue(current?.[column]);
          if (currentValue === confirmedOldValue) current[column] = value;
          return current;
        });
        rebaseResolvedRow(resolvedRow.row, confirmedAfterRow);
      }
      if (save.skipped) {
        discardCellCommit(editState, key, commitId);
        if (resolvedRow.row) remapSelectedRowKey(tab, confirmedRowKey, confirmedSavedRowKey);
        return { ok: true, changed: false, rowKey: confirmedSavedRowKey, column };
      }
      if (!finishCellCommit(editState, key, commitId, {
        rowKey: confirmedSavedRowKey,
        beforeRowKey: confirmedRowKey,
        afterRowKey: confirmedSavedRowKey,
        beforeIdentity: buildRowIdentity(tab, confirmedBeforeRow),
        afterIdentity: buildRowIdentity(tab, confirmedAfterRow),
        oldValue: confirmedOldValue,
        newValue: value,
        undoTransaction: activeUndoTransaction,
      })) {
        return { ok: true, changed: true, stale: true, rowKey: confirmedSavedRowKey, column };
      }
      if (resolvedRow.row) remapSelectedRowKey(tab, confirmedRowKey, confirmedSavedRowKey);
      onCellCommitted({ tab, rowKey: confirmedRowKey, column, oldValue: confirmedOldValue, newValue: value });
      if (!isLatestCellCommit(row, column, commitId)) {
        return { ok: true, changed: true, stale: true, rowKey: confirmedSavedRowKey, column };
      }
      syncSelectedTextDraft(tab);
      if (updateStatus) statusText.value = `已保存 ${tabDisplayName(tab)}.${column}`;
      if (showFeedback) onSaveFeedback({ kind: "success", tabId: tab.id, rowKey: confirmedSavedRowKey, column, message: "已保存" });
      return { ok: true, changed: true, rowKey: confirmedSavedRowKey, column };
    } catch (error) {
      const message = errorMessage(error);
      if (!isLatestCellCommit(row, column, commitId)) {
        discardCellCommit(editState, key, commitId);
        return { ok: false, changed: false, stale: true, reason: message, rowKey, column };
      }
      if (!failCellCommit(editState, key, message, commitId)) {
        return { ok: false, changed: false, stale: true, reason: message, rowKey, column };
      }
      const failedRowKey = buildRowKey(tab, confirmedAfterRow);
      const confirmedRowKey = buildRowKey(tab, confirmedBeforeRow);
      const resolvedRow = resolveMutationRow(tab, row, [
        { rowKey: failedRowKey, snapshot: confirmedAfterRow },
        { rowKey: confirmedRowKey, snapshot: confirmedBeforeRow },
      ]);
      if (resolvedRow.row) {
        mutateTabRow(tab, resolvedRow.rowIndex, (current) => {
          const currentValue = mutationCellValue(current?.[column]);
          if (currentValue === value) current[column] = confirmedBeforeRow[column] ?? null;
          return current;
        });
        rebaseResolvedRow(resolvedRow.row, confirmedBeforeRow);
        remapSelectedRowKey(tab, failedRowKey, confirmedRowKey);
      }
      syncSelectedTextDraft(tab);
      if (updateStatus) statusText.value = `保存失败：${message}`;
      if (showFeedback) onSaveFeedback({ kind: "error", tabId: tab.id, rowKey: confirmedRowKey, column, message: `保存失败：${message}` });
      return { ok: false, changed: false, reason: message, rowKey: confirmedRowKey, column };
      }
    } finally {
      if (ownsUndoTransaction) commitUndoTransaction(editState, activeUndoTransaction);
      if (ownsHistoryOperation) finishHistoryOperation(editState, activeHistoryOperation);
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
    const extraSuccesses = Math.max(0, Number(options.extraSuccesses) || 0);
    const successCount = results.filter((result) => result?.ok && result.changed).length + extraSuccesses;
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
    const ownsUndoTransaction = !options.undoTransaction;
    const undoTransaction = options.undoTransaction || createUndoTransaction(editState, {
      tableName: tabScopeKey(tab),
      tabId: tab?.id,
      label: options.historyLabel || "批量编辑单元格",
    });
    const ownsHistoryOperation = !options.historyOperation;
    const historyOperation = options.historyOperation || beginHistoryOperation(editState, tabScopeKey(tab));
    const undoGroupId = edits.length > 1 ? startUndoGroup(editState) : null;
    const rowIds = new WeakMap();
    let nextUndoRowId = 1;
    const undoRowIdFor = (row) => {
      if (!row || undoGroupId == null) return null;
      if (!rowIds.has(row)) rowIds.set(row, nextUndoRowId++);
      return rowIds.get(row);
    };
    try {
      if (edits.length > 1) {
        let preparedEdits = edits;
        const validationResults = [];
        if (!options.prevalidated) {
          const indexedRows = new Map(tabRows(tab).map((row, index) => [row, index]));
          const validation = validateBatchEdits({
            table: tableForValidation(tab),
            rows: tabRows(tab),
            edits: edits.map((edit) => ({
              ...edit,
              columnName: edit.column,
              rowIndex: indexedRows.get(edit.row) ?? -1,
            })),
          });
          preparedEdits = validation.validEdits.map((edit) => ({
            row: edit.row,
            column: edit.columnName,
            value: edit.value,
          }));
          for (const validationError of validation.errors) {
            const row = tabRowAt(tab, validationError.rowIndex);
            const rowKey = row ? buildRowKey(tab, row) : "";
            const reason = setValidationFeedback(
              tab,
              rowKey,
              validationError.columnName,
              validationError,
              { showFeedback: false, updateStatus: false },
            );
            validationResults.push({
              ok: false,
              changed: false,
              reason,
              rowKey,
              column: validationError.columnName,
            });
          }
        }
        const results = await commitCellBatchAtomic(tab, preparedEdits, {
          undoGroupId,
          undoRowIdFor,
          undoTransaction,
        });
        results.unshift(...validationResults);
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
          undoTransaction,
          historyOperation,
        }));
      }
      if (options.report === false) return { results };
      return reportBatchOutcome(tab, results, options);
    } finally {
      if (ownsUndoTransaction) commitUndoTransaction(editState, undoTransaction);
      if (ownsHistoryOperation) finishHistoryOperation(editState, historyOperation);
    }
  }

  async function commitCellBatchAtomic(
    tab,
    edits,
    { undoGroupId = null, undoRowIdFor = () => null, undoTransaction = null } = {},
  ) {
    const sessionId = tab?.sessionId;
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
          changes: [],
        };
        groups.set(row, group);
      }
      if (oldValue === value) {
        results.push({ ok: true, changed: false, rowKey, column });
        continue;
      }
      const item = { group, row, column, oldValue, value };
      group.changes.push(item);
      prepared.push(item);
    }

    if (prepared.length === 0) return results;
    const activeGroups = [...groups.values()].filter((group) => group.changes.length > 0);

    for (const group of activeGroups) {
      group.lane = acquireRowSaveLane(tab, group.row, group.beforeRow);
      const optimisticAfterRow = { ...group.beforeRow };
      for (const item of group.changes) {
        const optimisticBeforeRow = { ...optimisticAfterRow };
        optimisticAfterRow[item.column] = item.value;
        item.key = startCellCommit(editState, {
          tableName: tabScopeKey(tab),
          tabId: tab.id,
          rowKey: buildRowKey(tab, group.beforeRow),
          columnName: item.column,
          oldValue: item.oldValue,
          newValue: item.value,
          beforeRowKey: buildRowKey(tab, optimisticBeforeRow),
          afterRowKey: buildRowKey(tab, optimisticAfterRow),
          beforeIdentity: buildRowIdentity(tab, optimisticBeforeRow),
          afterIdentity: buildRowIdentity(tab, optimisticAfterRow),
          undoGroupId,
          undoRowId: undoRowIdFor(item.row),
          rowRef: item.row,
        });
        item.commitId = editState.pendingCells.get(item.key)?.commitId;
        setLatestCellCommit(item.row, item.column, item.commitId);
      }
      group.optimisticAfterRow = optimisticAfterRow;
      mutateTabRow(tab, group.rowIndex, (current) => {
        for (const item of group.changes) current[item.column] = item.value;
        return current;
      });
    }

    try {
      const result = await enqueueMutationTask(undoTransaction?.mutationTurn, async () => {
        const requestGroups = [];
        for (const group of activeGroups) {
          group.confirmedBeforeRow = {
            ...(group.lane?.confirmedRow || group.beforeRow),
          };
          const cursor = { ...group.confirmedBeforeRow };
          group.confirmedChanges = [];
          for (const item of group.changes) {
            item.oldValue = cursor[item.column] == null ? null : String(cursor[item.column]);
            if (item.oldValue === item.value) {
              item.skipped = true;
              discardCellCommit(editState, item.key, item.commitId);
              results.push({
                ok: true,
                changed: false,
                rowKey: buildRowKey(tab, cursor),
                column: item.column,
              });
              continue;
            }
            item.beforeRowKey = buildRowKey(tab, cursor);
            item.beforeIdentity = buildRowIdentity(tab, cursor);
            cursor[item.column] = item.value;
            item.afterRowKey = buildRowKey(tab, cursor);
            item.afterIdentity = buildRowIdentity(tab, cursor);
            group.confirmedChanges.push(item);
          }
          group.confirmedAfterRow = cursor;
          group.beforeRowKey = buildRowKey(tab, group.confirmedBeforeRow);
          group.afterRowKey = buildRowKey(tab, group.confirmedAfterRow);
          if (group.confirmedChanges.length > 0) {
            requestGroups.push({
              rowIdentity: buildRowIdentity(tab, group.confirmedBeforeRow),
              changes: group.confirmedChanges.map((item) => ({
                columnName: item.column,
                oldValue: item.oldValue,
                newValue: item.value,
              })),
            });
          }
        }
        if (requestGroups.length === 0) return { updated: 0, expectedRows: 0 };
        const saveResult = await invokeWorkbench("update_cells", {
          request: { sessionId, rows: requestGroups },
        });
        return { ...saveResult, expectedRows: requestGroups.length };
      });
      if (result?.conflict) throw new Error("数据已被别人修改，请刷新后再试");
      const updatedRows = Number(result?.updated);
      if (Number.isFinite(updatedRows) && updatedRows !== result.expectedRows) {
        throw new Error(`保存结果不完整：预期 ${result.expectedRows} 行，实际 ${updatedRows} 行`);
      }

      for (const group of activeGroups) {
        rebaseRowSaveLane(editState, group.row, group.confirmedAfterRow);
        const resolvedRow = resolveMutationRow(tab, group.row, [
          { rowKey: group.afterRowKey },
          { rowKey: group.beforeRowKey, snapshot: group.confirmedBeforeRow },
        ]);
        if (resolvedRow.row) {
          mutateTabRow(tab, resolvedRow.rowIndex, (current) => {
            for (const item of group.confirmedChanges || []) {
              if (mutationCellValue(current[item.column]) === item.oldValue) {
                current[item.column] = item.value;
              }
            }
            return current;
          });
          rebaseResolvedRow(resolvedRow.row, group.confirmedAfterRow);
        }
        for (const item of group.confirmedChanges || []) {
          const stale = !isLatestCellCommit(item.row, item.column, item.commitId);
          finishCellCommit(editState, item.key, item.commitId, {
            rowKey: item.afterRowKey,
            beforeRowKey: item.beforeRowKey,
            afterRowKey: item.afterRowKey,
            beforeIdentity: item.beforeIdentity,
            afterIdentity: item.afterIdentity,
            oldValue: item.oldValue,
            newValue: item.value,
            undoTransaction,
          });
          results.push({ ok: true, changed: true, stale, rowKey: group.afterRowKey, column: item.column });
          onCellCommitted({
            tab,
            rowKey: item.beforeRowKey,
            beforeRowKey: item.beforeRowKey,
            afterRowKey: item.afterRowKey,
            beforeIdentity: item.beforeIdentity,
            afterIdentity: item.afterIdentity,
            column: item.column,
            oldValue: item.oldValue,
            newValue: item.value,
          });
        }
        if (resolvedRow.row) remapSelectedRowKey(tab, group.beforeRowKey, group.afterRowKey);
      }
      syncSelectedTextDraft(tab);
      return results;
    } catch (error) {
      const message = errorMessage(error);
      for (const group of activeGroups) {
        const confirmedBeforeRow = group.confirmedBeforeRow || group.beforeRow;
        const confirmedAfterRow = group.confirmedAfterRow || group.optimisticAfterRow;
        const confirmedChanges = group.confirmedChanges || group.changes.filter((item) => !item.skipped);
        const beforeRowKey = group.beforeRowKey || buildRowKey(tab, confirmedBeforeRow);
        const afterRowKey = group.afterRowKey || buildRowKey(tab, confirmedAfterRow);
        rebaseRowSaveLane(editState, group.row, confirmedBeforeRow);
        const rollbackChanges = [];
        for (const item of confirmedChanges) {
          if (!isLatestCellCommit(item.row, item.column, item.commitId)) {
            discardCellCommit(editState, item.key, item.commitId);
            results.push({ ok: false, changed: false, stale: true, reason: message, rowKey: beforeRowKey, column: item.column });
            continue;
          }
          if (failCellCommit(editState, item.key, message, item.commitId)) rollbackChanges.push(item);
          results.push({ ok: false, changed: false, reason: message, rowKey: beforeRowKey, column: item.column });
        }
        const resolvedRow = resolveMutationRow(tab, group.row, [
          { rowKey: afterRowKey, snapshot: confirmedAfterRow },
          { rowKey: beforeRowKey, snapshot: confirmedBeforeRow },
        ]);
        if (resolvedRow.row) {
          mutateTabRow(tab, resolvedRow.rowIndex, (current) => {
            for (const item of rollbackChanges) {
              if (mutationCellValue(current[item.column]) === item.value) {
                current[item.column] = confirmedBeforeRow[item.column] ?? null;
              }
            }
            return current;
          });
          rebaseResolvedRow(resolvedRow.row, confirmedBeforeRow);
          remapSelectedRowKey(tab, afterRowKey, beforeRowKey);
        }
      }
      syncSelectedTextDraft(tab);
      return results;
    } finally {
      for (const group of activeGroups) releaseRowSaveLane(group.lane);
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

  async function commitDraftObject(
    tab,
    draft,
    rowId,
    { allowDefaults = false, peerDrafts = null, sessionId = tab?.sessionId } = {},
  ) {
    if (!sessionId) return { ok: false, reason: "" };
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return { ok: false, reason: statusText.value };
    }
    const cleaned = cleanDraftValues(draft);
    const valuesForSave = draftValuesForSave(draft);
    if (!allowDefaults && Object.keys(cleaned).length === 0 && Object.keys(valuesForSave).length === 0) {
      return { ok: false, reason: "" };
    }
    const otherDrafts = Array.isArray(peerDrafts)
      ? peerDrafts
      : getInsertRows(tab)
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
          sessionId,
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

  function reserveInsertDraft(tab, rowId) {
    const key = insertSavingKey(tab, rowId);
    const existing = insertRowReservations.get(key);
    if (existing) return { reservation: existing, owned: false };
    let resolveOutcome;
    const outcome = new Promise((resolve) => { resolveOutcome = resolve; });
    const reservation = {
      key,
      rowId,
      outcome,
      resolveOutcome,
      settled: false,
    };
    insertRowReservations.set(key, reservation);
    markInsertRowSaving(tab, rowId, true);
    return { reservation, owned: true };
  }

  function settleInsertDraftReservation(tab, reservation, outcome) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    if (insertRowReservations.get(reservation.key) === reservation) {
      insertRowReservations.delete(reservation.key);
      markInsertRowSaving(tab, reservation.rowId, false);
    }
    reservation.resolveOutcome(outcome);
  }

  function prepareInsertSaveEntries(tab, options = {}) {
    flushEditingInsertDraft(tab);
    refreshInsertDraftPrimaryKeyFeedback(tab);
    const requestedIds = Array.isArray(options.rowIds)
      ? new Set(options.rowIds.filter(Boolean))
      : null;
    const snapshots = getInsertRows(tab).map((row) => ({
      rowId: row.id,
      draft: draftValuesForSave(row.draft),
      hasInput: hasDraftInput(row),
    }));
    const targets = requestedIds
      ? snapshots.filter((row) => requestedIds.has(row.rowId))
      : snapshots.filter((row) => row.hasInput);
    return targets.map((target) => ({
      ...target,
      ...reserveInsertDraft(tab, target.rowId),
      allowDefaults: Boolean(options.allowDefaults),
      sessionId: tab.sessionId,
      peerDrafts: snapshots
        .filter((candidate) => candidate.rowId !== target.rowId)
        .map((candidate) => ({ ...candidate.draft })),
    }));
  }

  async function runInsertSaveRequest(tab, entries) {
    let insertedRows = 0;
    let failure = null;
    let activeEntry = null;
    try {
      for (const entry of entries) {
        activeEntry = entry;
        let result;
        if (entry.owned) {
          const saved = await commitDraftObject(tab, entry.draft, entry.rowId, {
            allowDefaults: entry.allowDefaults,
            peerDrafts: entry.peerDrafts,
            sessionId: entry.sessionId,
          });
          if (saved.ok) {
            promoteSavedDraft(tab, entry.draft, saved.saveResult);
            clearInsertDraft(tab, entry.rowId, { force: true });
            result = { ok: true, rowId: entry.rowId };
          } else {
            result = {
              ok: false,
              rowId: entry.rowId,
              reason: saved.reason || statusText.value || "",
            };
          }
          settleInsertDraftReservation(tab, entry.reservation, result);
        } else {
          result = await entry.reservation.outcome;
        }
        if (!result.ok) {
          failure = result;
          break;
        }
        insertedRows += 1;
        if (entries.length > 3) {
          statusText.value = `正在保存新增行 ${insertedRows}/${entries.length}…`;
        }
      }
    } catch (error) {
      failure = {
        ok: false,
        rowId: activeEntry?.rowId || entries[insertedRows]?.rowId || null,
        reason: errorMessage(error),
      };
      statusText.value = `插入失败：${failure.reason}`;
    } finally {
      for (const entry of entries) {
        if (!entry.owned || entry.reservation.settled) continue;
        settleInsertDraftReservation(tab, entry.reservation, {
          ok: false,
          skipped: true,
          rowId: entry.rowId,
          reason: failure?.reason || "前一新增行保存失败，本行未提交",
        });
      }
    }
    if (failure) {
      if (activeTab.value?.id === tab.id && failure.rowId) {
        selectInsertCell(tab, failure.rowId, selectedInsertCell.value?.columnIndex ?? 0);
      }
      return {
        insertedRows,
        failedRowId: failure.rowId || null,
        failedReason: failure.reason || statusText.value || "",
      };
    }
    if (insertedRows > 0) statusText.value = `已保存新增 ${insertedRows} 行`;
    return { insertedRows, failedRowId: null };
  }

  function commitInsertRows(tab, options = {}) {
    if (!tab?.id || !tab?.sessionId) {
      return Promise.resolve({ insertedRows: 0, failedRowId: null });
    }
    const entries = prepareInsertSaveEntries(tab, options);
    if (entries.length === 0) {
      return Promise.resolve({ insertedRows: 0, failedRowId: null });
    }
    const mutationTurn = beginMutationTurn(editState, tabScopeKey(tab), { kind: "insert" });
    return enqueueMutationTask(
      mutationTurn,
      () => runInsertSaveRequest(tab, entries),
    ).finally(() => finishMutationTurn(editState, mutationTurn));
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
    if (!tab || !isInsertRowVisible(tab) || rowId == null || columnIndex == null) return { ok: false };
    const rows = getInsertRows(tab);
    const selectedTargetRow = rows.find((row) => row.id === rowId);
    if (!selectedTargetRow) return { ok: false };
    const sourceColumnCount = matrix[0]?.length || 0;
    const sourceMask = Array.isArray(clipboardPayload?.mask)
      ? clipboardPayload.mask
      : fullClipboardMask(matrix);
    const fill = tileClipboardPayload(matrix, sourceMask, matrix.length, sourceColumnCount);
    if (!fill.ok) {
      statusText.value = clipboardFillErrorMessage(fill, false);
      return { ok: false, message: statusText.value };
    }
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
      && fill.matrix.some((row) => row.length === columns.length);
    const targetColumnIndexes = fill.matrix.map((sourceRow, rowOffset) => sourceRow.map((_value, colOffset) => {
      if (!fill.mask[rowOffset]?.[colOffset]) return -1;
      if (sourceColumnNames) {
        const mappedIndex = columns.findIndex((column) => columnName(column) === sourceColumnNames[colOffset]);
        return mappedIndex >= 0 && !isDatabaseGeneratedColumn(columns[mappedIndex]) ? mappedIndex : -1;
      }
      const mappedIndex = sourceStartsWithPrimaryKey ? colOffset : startColumnIndex + colOffset;
      if (!columns[mappedIndex]) return null;
      return isDatabaseGeneratedColumn(columns[mappedIndex]) ? -1 : mappedIndex;
    }));
    if (targetColumnIndexes.some((indexes) => indexes.some((index) => index == null))) {
      statusText.value = "无法粘贴：目标范围超出可编辑列";
      return { ok: false, message: statusText.value };
    }
    if (!targetColumnIndexes.some((indexes) => indexes.some((index) => index >= 0))) {
      statusText.value = "无法粘贴：没有可写入的匹配字段";
      return { ok: false, message: statusText.value };
    }
    const existingTargets = fill.matrix
      .map((_row, rowOffset) => targetGroup[targetGroupIndex + rowOffset])
      .filter(Boolean);
    if (existingTargets.some((row) => isInsertRowSaving(tab, row.id))) {
      statusText.value = "新增行正在保存，请稍候";
      return { ok: false, message: statusText.value };
    }
    const beforeRows = captureInsertDraftState(tab);
    let pastedCells = 0;
    for (let rowOffset = 0; rowOffset < fill.matrix.length; rowOffset++) {
      let targetRow = targetGroup[targetGroupIndex + rowOffset];
      if (!targetRow) {
        const previousRow = targetGroup.at(-1) || selectedTargetRow;
        targetRow = createInsertRow(targetAnchor);
        rows.splice(rows.indexOf(previousRow) + 1, 0, targetRow);
        targetGroup.push(targetRow);
      }
      for (let colOffset = 0; colOffset < fill.matrix[rowOffset].length; colOffset++) {
        const targetColumnIndex = targetColumnIndexes[rowOffset][colOffset];
        if (targetColumnIndex < 0) continue;
        const column = columns[targetColumnIndex];
        const applied = applyInsertDraftValue(tab, targetRow, columnName(column), fill.matrix[rowOffset][colOffset], {
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
    statusText.value = fill.matrix.length > 1 ? `已粘贴到 ${fill.matrix.length} 条新增行` : `已粘贴 ${pastedCells} 个新增单元格`;
    return { ok: true, draftRows: fill.matrix.length, pastedCells, insertedRows: 0 };
  }

  async function pasteIntoInsertInput(tab, rowId, columnIndex, event) {
    const text = event?.clipboardData?.getData?.("text/plain") ?? "";
    if (!text) return;
    const matrix = parseGridTsv(text);
    const isBatchPaste = matrix.length > 1 || matrix.some((row) => row.length > 1);
    if (!isBatchPaste) return false;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    cancelEditing({ skipRefocus: true });
    pasteIntoInsertCell(tab, matrix, rowId, columnIndex, getGridClipboardPayload(text));
    nextTick(() => gridWrapRef.value?.focus());
    return true;
  }

  function pasteIntoSelectedInsertRows(tab, matrix, clipboardPayload) {
    if (!tab || !isInsertRowVisible(tab)) {
      return { ok: false, insertedRows: 0 };
    }
    const columns = activeColumns.value;
    const sourceColumnNames = Array.isArray(clipboardPayload?.columnNames) ? clipboardPayload.columnNames : [];
    const beforeRows = captureInsertDraftState(tab);
    const insertRows = getInsertRows(tab);
    const selectedTargets = selectedInsertDraftRows(tab);
    if (selectedTargets.length === 0) return { ok: false, insertedRows: 0 };
    if (selectedTargets.slice(0, matrix.length).some((row) => isInsertRowSaving(tab, row.id))) {
      statusText.value = "新增行正在保存，请稍候";
      return { ok: false, insertedRows: 0, message: statusText.value };
    }
    const writableSourceIndexes = sourceColumnNames
      .map((name, sourceIndex) => {
        const column = columns.find((candidate) => columnName(candidate) === name);
        return column && !isDatabaseGeneratedColumn(column) ? sourceIndex : -1;
      })
      .filter((sourceIndex) => sourceIndex >= 0);
    if (writableSourceIndexes.length === 0) {
      statusText.value = "无法粘贴：没有可写入的匹配字段";
      return { ok: false, insertedRows: 0, message: statusText.value };
    }
    let pastedCells = 0;
    for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
      let targetRow = selectedTargets[rowIndex];
      if (!targetRow) {
        const previousRow = selectedTargets.at(-1);
        targetRow = createInsertRow(previousRow.anchorIndex ?? null);
        insertRows.splice(insertRows.indexOf(previousRow) + 1, 0, targetRow);
        selectedTargets.push(targetRow);
      }
      for (let sourceIndex = 0; sourceIndex < sourceColumnNames.length; sourceIndex++) {
        const name = sourceColumnNames[sourceIndex];
        const column = columns.find((candidate) => columnName(candidate) === name);
        if (!column || isDatabaseGeneratedColumn(column)) continue;
        if (applyInsertDraftValue(tab, targetRow, name, matrix[rowIndex][sourceIndex] ?? "", {
          updateSelection: false,
          columnIndex: columns.indexOf(column),
        })) pastedCells += 1;
      }
    }
    refreshInsertDraftPrimaryKeyFeedback(tab);
    recordInsertDraftHistory(tab, beforeRows, {
      label: "粘贴整行到新增行",
      cellCount: pastedCells,
    });
    statusText.value = `已粘贴到 ${matrix.length} 条新增行，保存后写入数据库`;
    return { ok: true, draftRows: matrix.length, insertedRows: 0 };
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

  function planWholeRowPaste(tab, matrix, clipboardPayload, targetRows) {
    if (matrix.length !== targetRows.length) {
      return {
        ok: false,
        message: `无法粘贴：复制了 ${matrix.length} 行，但目标行头选区包含 ${targetRows.length} 行`,
      };
    }
    const columns = activeColumns.value;
    const columnIndexes = new Map(columns.map((column, index) => [columnName(column), index]));
    const sourceColumnNames = clipboardPayload.columnNames;
    const targets = [];
    for (let rowOffset = 0; rowOffset < matrix.length; rowOffset++) {
      const targetRow = targetRows[rowOffset];
      for (let sourceIndex = 0; sourceIndex < sourceColumnNames.length; sourceIndex++) {
        const targetColumnIndex = columnIndexes.get(sourceColumnNames[sourceIndex]);
        if (targetColumnIndex == null) continue;
        targets.push({
          entry: targetRow.entry,
          rowIndex: targetRow.rowIndex,
          columnIndex: targetColumnIndex,
          column: columnName(columns[targetColumnIndex]),
          value: matrix[rowOffset][sourceIndex] ?? "",
        });
      }
    }
    return { ok: true, targets };
  }

  function rollbackInsertDraftPaste(tab, beforeRows, afterRows, mutationTurnId) {
    const changes = changedInsertDraftRows(beforeRows, afterRows);
    if (changes.length === 0) return;
    applyInsertDraftHistoryEntry({
      kind: "insert-draft-batch",
      tableName: tabScopeKey(tab),
      tabId: tab.id,
      changes,
    }, "undo", tab, { mutationTurnId });
  }

  async function applyGridPastePlan(tab, plan) {
    if (!plan?.ok) return { ok: false, message: plan?.message || "无法粘贴" };
    const model = visualRowEntries(tab);
    const targets = [];

    if (Array.isArray(plan.targets)) {
      targets.push(...plan.targets);
    } else if (Array.isArray(plan.directCells)) {
      for (const cell of plan.directCells) targets.push({ ...cell, value: plan.value });
    } else {
      if (!plan.start) return { ok: false, message: "无法粘贴：目标选区无效" };
      for (let rowOffset = 0; rowOffset < plan.matrix.length; rowOffset++) {
        for (let columnOffset = 0; columnOffset < (plan.matrix[rowOffset]?.length || 0); columnOffset++) {
          if (!plan.mask[rowOffset]?.[columnOffset]) continue;
          const rowIndex = plan.start.rowIndex + rowOffset;
          const columnIndex = plan.start.columnIndex + columnOffset;
          const entry = model.at(rowIndex);
          const column = activeColumnNames()[columnIndex];
          if (!entry || !column) {
            statusText.value = "无法粘贴：目标范围超出已加载的可编辑区域";
            return { ok: false, message: statusText.value };
          }
          targets.push({ entry, rowIndex, columnIndex, column, value: plan.matrix[rowOffset][columnOffset] });
        }
      }
    }

    if (targets.length === 0) {
      statusText.value = "无法粘贴：目标选区没有可写入的单元格";
      return { ok: false, message: statusText.value };
    }

    const writableTargets = targets.filter((target) => {
      const column = activeColumns.value[target.columnIndex]
        || activeColumns.value.find((candidate) => columnName(candidate) === target.column);
      return column && !isDatabaseGeneratedColumn(column);
    });
    if (writableTargets.length === 0) {
      statusText.value = "无法粘贴：目标只包含数据库生成字段";
      return { ok: false, message: statusText.value };
    }

    const edits = [];
    const draftEdits = [];
    for (const target of writableTargets) {
      if (!target.entry || !target.column) {
        statusText.value = "无法粘贴：目标范围超出已加载的可编辑区域";
        return { ok: false, message: statusText.value };
      }
      if (target.entry.type === "insert") {
        if (isInsertRowSaving(tab, target.entry.insertRow?.id)) {
          statusText.value = "新增行正在保存，请稍候";
          return { ok: false, message: statusText.value };
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
        return { ok: false, message: statusText.value };
      }
    }

    const undoTransaction = createUndoTransaction(editState, {
      tableName: tabScopeKey(tab),
      tabId: tab.id,
      label: "批量粘贴",
    });
    const historyOperation = beginHistoryOperation(editState, tabScopeKey(tab));
    let beforeInsertRows = null;
    let afterInsertRows = null;
    let draftSuccessCount = 0;
    let keepDraftEdits = draftEdits.length === 0;
    try {
      beforeInsertRows = draftEdits.length > 0 ? captureInsertDraftState(tab) : null;
      for (const target of draftEdits) {
        const draft = target.entry.insertRow?.draft || {};
        const beforeHasValue = Object.prototype.hasOwnProperty.call(draft, target.column);
        const beforeValue = beforeHasValue ? String(draft[target.column] ?? "") : null;
        const nextValue = String(target.value ?? "");
        const applied = applyInsertDraftValue(tab, target.entry.insertRow, target.column, nextValue, {
          updateSelection: false,
          columnIndex: target.columnIndex,
        });
        if (applied && (!beforeHasValue || beforeValue !== nextValue)) draftSuccessCount += 1;
      }
      if (draftEdits.length > 0) {
        refreshInsertDraftPrimaryKeyFeedback(tab);
        afterInsertRows = captureInsertDraftState(tab);
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
        { report: false, prevalidated: true, undoTransaction, historyOperation },
      );
      const savedEditFailed = batch.results.some((result) => result && !result.ok);
      if (!savedEditFailed && draftEdits.length > 0) {
        keepDraftEdits = true;
        recordInsertDraftHistory(tab, beforeInsertRows, {
          label: "粘贴到新增行",
          cellCount: draftSuccessCount,
          undoTransaction,
          afterRows: afterInsertRows,
        });
      }
      if (edits.length === 0 && draftEdits.length > 0) {
        statusText.value = `已粘贴 ${draftSuccessCount} 个新增单元格`;
        return { ok: true, successCount: draftSuccessCount, failureCount: 0, message: statusText.value };
      }
      return reportBatchOutcome(tab, batch.results, {
        extraSuccesses: keepDraftEdits ? draftSuccessCount : 0,
        extraFailures: validation.errors.length,
        firstFailure: validation.errors[0]?.message || "",
        successMessage: (count) => `已粘贴 ${count} 个单元格`,
        failureLabel: "批量粘贴保存",
      });
    } finally {
      if (!keepDraftEdits && beforeInsertRows && afterInsertRows) {
        rollbackInsertDraftPaste(
          tab,
          beforeInsertRows,
          afterInsertRows,
          undoTransaction.mutationTurn?.id,
        );
      }
      commitUndoTransaction(editState, undoTransaction);
      finishHistoryOperation(editState, historyOperation);
    }
  }

  // Keyboard paste in a focused webview is delivered as a ClipboardEvent.
  // Consuming its text directly avoids WebKit's programmatic clipboard-read
  // permission menu while keeping the same validation and atomic-save path.
  async function pasteGridText(text) {
    const tab = activeTab.value;
    if (!tab) return { ok: false, message: "当前表不可用" };
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return { ok: false, message: statusText.value };
    }
    const clipboardText = String(text ?? "");
    if (clipboardText === "" && !getGridClipboardPayload(clipboardText)) {
      statusText.value = "剪贴板为空，未修改数据";
      return { ok: false, message: statusText.value };
    }
    const source = clipboardSource(clipboardText);
    const matrix = source.matrix;
    if (matrix.length === 0) {
      statusText.value = "剪贴板为空，未修改数据";
      return { ok: false, message: statusText.value };
    }
    const selectedRows = selectedWholeRows(tab);
    const hasSelectedDataRow = selectedRows.some(({ entry }) => entry.type === "data");
    if (hasSelectedDataRow) {
      const fullRowPayload = copiedFullRowPayload(clipboardText, matrix);
      if (!fullRowPayload) {
        statusText.value = "请先通过行号复制整行，再粘贴到行头选区";
        return { ok: false, message: statusText.value };
      }
      const wholeRowPlan = planWholeRowPaste(tab, matrix, fullRowPayload, selectedRows);
      if (!wholeRowPlan.ok) {
        statusText.value = wholeRowPlan.message;
        return { ok: false, message: statusText.value };
      }
      return await applyGridPastePlan(tab, wholeRowPlan);
    }
    const activeSelection = selectedRange.value?.tabId === tab.id ? selectedRange.value : null;
    if (gridSelectionCount(activeSelection) <= 1
      && isInsertRowVisible(tab)
      && selectedInsertCell.value?.tabId === tab.id) {
      return pasteIntoInsertCell(tab, matrix, undefined, undefined, source.internal);
    }
    if (isInsertRowVisible(tab) && selectedInsertDraftRows(tab).length > 0) {
      const fullRowPayload = copiedFullRowPayload(clipboardText, matrix);
      if (!fullRowPayload) {
        statusText.value = "请先通过行号复制整行，再粘贴到新增行";
        return { ok: false, insertedRows: 0, message: statusText.value };
      }
      return pasteIntoSelectedInsertRows(tab, matrix, fullRowPayload);
    }
    const plan = planGridPaste(tab, source);
    if (!plan.ok) {
      statusText.value = plan.message;
      return { ok: false, message: plan.message };
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
        const save = finishEditing();
        if (isInsertRowKey(editing.rowKey)) return await commitInsertRows(tab);
        return await save;
      }
      if (isInsertRowVisible(tab) && hasInsertDrafts(tab)) {
        return await commitInsertRows(tab);
      }
      // Grid edits and pastes persist as part of their own operation. The
      // detail textarea owns a separate dirty-gated Ctrl+S handler; treating a
      // plain grid selection as an unsaved detail draft can overwrite a
      // pending multi-cell paste with stale textDraft data.
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
          updateTextDraft(event.key);
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
    detailIdentityRemap,
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
    captureHistoryViewState,
    updateTextDraft,
    focusTextCell,
    selectCell,
    consumeCellPointerClick,
    startRangeSelection,
    extendRangeSelection,
    extendRangeSelectionFromPointer,
    finishRangeSelection,
    isCellInSelectedRange,
    selectedGridCells,
    isMultiCellRange,
    activateCellInRange,
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
    insertDraftsAbove,
    insertDraftsBelow,
    canInsertCopiedRows,
    insertCopiedRowsAbove,
    insertPosition,
    selectInsertRow,
    removeInsertDraftRow,
    removeInsertDraftRows,
    applyInsertDraftHistoryEntry,
    syncSelectionAfterHistory,
    handleInsertKeydown,
    // commits
    commitCellValue,
    commitCellBatch,
    replaceSelectionCells,
    commitInsertDraftCellValue,
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
