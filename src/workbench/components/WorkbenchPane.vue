<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { tabRowAt, tabRowCount, tabRows } from "../rowStore.js";
import { columnName } from "../utils/normalize.js";
import { highlightCellResult, displayCellValue } from "../utils/cellDisplay.js";
import { replaceSearchText } from "../utils/searchMatch.js";
import { buildRowKey, buildRowIdentity, buildRowKeyFromIdentity } from "../utils/rowIdentity.js";
import { createRowIndex } from "../utils/rowIndex.js";
import {
  captureTableTabViewState,
  readTableTabViewState,
  tableTabViewRevision,
} from "../utils/tabActivation.js";
import { useGridEditor } from "../composables/useGridEditor.js";
import { useRowSelection } from "../composables/useRowSelection.js";
import { useTableSearch } from "../composables/useTableSearch.js";
import { useUndo } from "../composables/useUndo.js";
import { useVirtualGrid } from "../composables/useVirtualGrid.js";
import { useFreezePanes } from "../composables/useFreezePanes.js";
import { applyResolvedFreeze } from "../utils/freezeSelection.js";
import { useConfirm } from "../composables/useConfirm.js";
import { isTauriRuntime } from "../utils/tauriBridge.js";

import WorkbenchTabs from "./WorkbenchTabs.vue";
import DataGrid from "./DataGrid.vue";
import TableDesignEditor from "./TableDesignEditor.vue";
import CellDetailPanel from "./CellDetailPanel.vue";
import DatabaseHome from "./DatabaseHome.vue";
const SqlQueryWorkspace = defineAsyncComponent(() => import("./SqlQueryWorkspace.vue"));
const SqlQueryLibrary = defineAsyncComponent(() => import("./SqlQueryLibrary.vue"));

const props = defineProps({
  pane: { type: Object, required: true },
  tabs: { type: Array, default: () => [] },
  allTabs: { type: Array, default: () => [] },
  activeTab: { type: Object, default: null },
  editState: { type: Object, required: true },
  invokeWorkbench: { type: Function, required: true },
  appState: { type: Object, required: true },
  homeTables: { type: Array, default: () => [] },
  homeClipboard: { type: Object, default: null },
  recentTableNames: { type: Array, default: () => [] },
  schema: { type: Array, default: () => [] },
  connections: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
  sqlDocuments: { type: Array, default: () => [] },
  currentConnectionId: { type: String, default: "" },
  isFocused: { type: Boolean, default: false },
  fetchPage: { type: Function, required: true },
  loadNextPage: { type: Function, required: true },
  loadPreviousPage: { type: Function, required: true },
  jumpToTableBoundary: { type: Function, required: true },
  loadSearchResultPage: { type: Function, default: null },
  loadNextSearchResultPage: { type: Function, default: null },
  cancelSearchResultPage: { type: Function, default: null },
  toggleSort: { type: Function, required: true },
  applySort: { type: Function, required: true },
  rootPaneCount: { type: Number, default: 1 },
  leftEdge: { type: Boolean, default: true },
  rightEdge: { type: Boolean, default: true },
  topEdge: { type: Boolean, default: true },
});

const emit = defineEmits([
  "focus-pane",
  "split-pane",
  "close-pane",
  "activate-tab",
  "close-tab",
  "reorder-tab",
  "copy-tab-name",
  "tab-contextmenu",
  "table-contextmenu",
  "row-contextmenu",
  "detail-contextmenu",
  "open-design",
  "design-applied",
  "export",
  "import",
  "batch-export",
  "batch-import",
  "replace",
  "save-reminder",
  "state-change",
  "page-refreshed",
  "cell-committed",
  "schema-search-previous",
  "schema-search-next",
  "open-home-table",
  "copy-home-tables",
  "paste-home-tables",
  "rename-home-table",
  "delete-home-tables",
  "refresh-home",
  "home-visible-tables",
  "focus-home-table",
  "sql-schema-changed",
  "open-sql-library",
  "new-sql-query",
  "open-sql-document",
  "duplicate-sql-document",
  "rename-sql-document",
  "delete-sql-document",
  "open-sql-file",
]);

const activeDataTab = computed(() => {
  const tab = props.activeTab;
  return tab && (tab.kind || "data") === "data" ? tab : null;
});
const activeDesignTab = computed(() => (props.activeTab?.kind === "design" ? props.activeTab : null));
const activeHomeTab = computed(() => (props.activeTab?.kind === "home" ? props.activeTab : null));
const activeSqlTab = computed(() => (props.activeTab?.kind === "sql" ? props.activeTab : null));
const activeSqlLibraryTab = computed(() => (props.activeTab?.kind === "sql-library" ? props.activeTab : null));
const activeSourceTab = computed(() => activeDataTab.value || activeDesignTab.value);
const activeDataReadOnly = computed(() => Boolean(activeDataTab.value?.readOnly || activeDataTab.value?.read_only));
const activeSourceReadOnly = computed(() => Boolean(activeSourceTab.value?.readOnly || activeSourceTab.value?.read_only));
const busy = computed(() => Boolean(props.appState?.busy?.value ?? props.appState?.busy));
const statusText = props.appState.statusText;
const { confirm: confirmDialog } = useConfirm();
const SPLIT_MENU_WIDTH = 104;
const splitMenuOpen = ref(false);
const splitMenuAnchor = ref(null);
const splitMenuPosition = ref({ left: 8, top: 32 });
const databaseHomeRef = ref(null);

const {
  gridWrapRef,
  virtualRange,
  onGridScroll,
  restoreGridScroll,
  resetGridScroll,
  offsetGridScroll,
  scrollRowIntoView,
  scrollColumnIntoView,
  scrollCellIntoView,
  scrollInsertCellIntoView,
  visibleRows,
  activeColumnMeta,
  scrollTop,
  viewportHeight,
  rowHeight,
  frozenRowsActive,
} = useVirtualGrid(activeDataTab, props.editState);
const paneFreezePanes = useFreezePanes();

function applyFreezeTarget(target) {
  return applyResolvedFreeze({
    freezePanes: paneFreezePanes,
    tab: activeDataTab.value,
    target,
    scrollTop: gridWrapRef.value?.scrollTop ?? scrollTop.value,
    viewportHeight: gridWrapRef.value?.clientHeight ?? viewportHeight.value,
  });
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value ?? "")) : String(value ?? "").replace(/["\\]/g, "\\$&");
}

function showSaveReminder({ tabId, rowKey, column, kind, message }) {
  if (activeDataTab.value?.id !== tabId || !gridWrapRef.value) return;
  const cell = gridWrapRef.value.querySelector(`td[data-row-key="${cssEscape(rowKey)}"][data-column-name="${cssEscape(column)}"]`);
  if (!cell) return;
  const rootRect = gridWrapRef.value.closest(".mysql-workbench")?.getBoundingClientRect();
  const gridRect = gridWrapRef.value.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const detailRect = gridWrapRef.value.closest(".wb-workbench-pane")
    ?.querySelector(".wb-cell-detail")
    ?.getBoundingClientRect();
  const visibleBottom = detailRect?.top < gridRect.bottom && detailRect?.bottom > gridRect.top
    ? Math.min(gridRect.bottom, detailRect.top)
    : gridRect.bottom;
  if (!rootRect || cellRect.bottom < gridRect.top || cellRect.top > visibleBottom) return;
  emit("save-reminder", {
    kind,
    message,
    x: Math.min(cellRect.right - rootRect.left - 12, rootRect.width - 92),
    y: Math.max(36, cellRect.top - rootRect.top - 8),
  });
}

const editor = useGridEditor(
  props.editState,
  props.invokeWorkbench,
  activeDataTab,
  gridWrapRef,
  { scrollRowIntoView, scrollCellIntoView, scrollInsertCellIntoView },
  {
    busy: props.appState.busy,
    statusText,
    onSaveFeedback: showSaveReminder,
    onCellCommitted: (event) => emit("cell-committed", event),
  },
);

const {
  selectedCell,
  selectedRange,
  selectedInsertCell,
  selectedInsertRow,
  isSelectingRange,
  editingCell,
  editDraft,
  textDraft,
  detailIdentityRemap,
  activeColumns,
  isInsertRowVisible,
  getInsertRowKey,
  getInsertRows,
  getVisibleInsertRows,
  isInsertRowSaving,
  isInsertRowKey,
  insertAwareVisualRowIndex,
  clearSelection,
  captureTableViewSelection,
  restoreTableViewSelection,
  captureHistoryViewState,
  updateTextDraft,
  selectCell,
  consumeCellPointerClick,
  startRangeSelection,
  extendRangeSelection,
  extendRangeSelectionFromPointer,
  finishRangeSelection,
  startEditing,
  updateEditDraft,
  finishEditing,
  cancelEditing,
  navigateCell,
  selectInsertCell,
  insertDraftAbove: createInsertDraftAbove,
  insertDraftBelow: createInsertDraftBelow,
  insertDraftsAbove: createInsertDraftsAbove,
  insertDraftsBelow: createInsertDraftsBelow,
  canInsertCopiedRows,
  insertCopiedRowsAbove: createCopiedRowsAbove,
  selectInsertRow,
  handleInsertKeydown,
  saveTextPanel,
  commitDetailDraft,
  commitInsertRows,
  commitInsertRow,
  removeInsertDraftRow,
  removeInsertDraftRows,
  applyInsertDraftHistoryEntry,
  syncSelectionAfterHistory,
  handleGridKeydown,
  pasteGridText,
  getInsertDraft,
  updateInsertDraft,
  clearInsertDraft,
  pasteIntoInsertInput,
  isCellInSelectedRange,
  getCellRangeClasses,
  isColumnSelected,
  setCellToNull,
} = editor;

async function refreshTabPage(tab, page) {
  const ready = await prepareInsertDraftsForRefresh(tab);
  if (!ready) return { ok: false, cancelled: true };
  const result = await props.fetchPage(tab, page, { skipInsertDraftCheck: true });
  if (result?.ok) {
    clearInsertDraftsAfterRefresh(tab);
    emit("page-refreshed", tab);
  }
  return result;
}

// 加载失败后的"重试"：直接重新拉取第一页，跳过插入草稿检查（加载失败时
// 不可能有未保存草稿需要保留），让用户能从错误态恢复。
async function retryGridLoad(tab) {
  if (!tab?.sessionId) return;
  await props.fetchPage(tab, tab.page || 1, { skipInsertDraftCheck: true });
}

async function jumpGridBoundary(boundary) {
  const tab = activeDataTab.value;
  if (!tab) return;
  const ready = await prepareInsertDraftsForRefresh(tab);
  if (!ready) return;
  gridPagingSuspended = true;
  try {
    const result = await props.jumpToTableBoundary(tab, boundary);
    if (!result?.ok) return;
    resetGridState();
    await nextTick();
    const wrap = gridWrapRef.value;
    if (!wrap) return;
    restoreGridScroll({
      top: boundary === "bottom" ? Math.max(0, wrap.scrollHeight - wrap.clientHeight) : 0,
      left: wrap.scrollLeft,
    });
    rememberGridScrollPosition(wrap);
    wrap.focus();
  } finally {
    gridPagingSuspended = false;
  }
}

const {
  clearRowSelection,
  toggleRowSelect,
  ensureRowContextSelection,
  toggleAllRows,
  moveRowSelection,
  startRowDragSelection,
  extendRowDragSelectionFromPointer,
  finishRowDragSelection,
  consumeRowDragClickSuppression,
  selectedRowIndexes: selectedGridRowIndexes,
  allRowEntries: gridRowEntries,
  deleteSelectedRows,
  deleteRow,
} = useRowSelection(props.invokeWorkbench, { statusText }, {
  fetchPage: refreshTabPage,
  prepareForDelete: prepareInsertDraftsForRefresh,
  getVisualRowModel: editor.visualRowEntries,
  removeInsertRows: removeInsertDraftRows,
});

function insertDraftAbove(tab, target) {
  clearRowSelection(tab);
  return createInsertDraftAbove(tab, target);
}

function insertDraftBelow(tab, target) {
  clearRowSelection(tab);
  return createInsertDraftBelow(tab, target);
}

function insertDraftsAbove(tab, target, count) {
  clearRowSelection(tab);
  return createInsertDraftsAbove(tab, target, count);
}

function insertDraftsBelow(tab, target, count) {
  clearRowSelection(tab);
  return createInsertDraftsBelow(tab, target, count);
}

function pasteCopiedRowsAbove(tab, target) {
  clearRowSelection(tab);
  if (!isTauriRuntime()) return createCopiedRowsAbove(tab, target);
  return props.invokeWorkbench("read_clipboard_text")
    .then((text) => createCopiedRowsAbove(tab, target, text))
    .catch(() => {
      statusText.value = "读取剪贴板失败";
      return { ok: false, message: statusText.value };
    });
}

function commitEditingBeforeSelectionChange() {
  if (editingCell.value) finishEditing({ skipRefocus: true });
}

function selectCellAt(tab, rowIndex, columnIndex) {
  const row = tabRowAt(tab, rowIndex);
  const column = tab?.columns?.[columnIndex];
  if (!row || !column) return;
  commitEditingBeforeSelectionChange();
  clearRowSelection(tab);
  clearSelection();
  selectCell(tab, row, columnName(column), rowIndex, columnIndex, { focusGrid: false });
  scrollCellIntoView(rowIndex, columnIndex);
}

function selectVisualCellAt(tab, visualRowIndex, columnIndex) {
  const entry = editor.visualRowEntries(tab).at(visualRowIndex);
  if (!entry) return;
  commitEditingBeforeSelectionChange();
  clearRowSelection(tab);
  clearSelection();
  if (entry.type === "insert") {
    const rowId = entry.rowId || entry.insertRow?.id;
    if (rowId) selectInsertCell(tab, rowId, columnIndex, { scrollColumn: false });
    return;
  }
  const row = tabRowAt(tab, entry.dataIndex);
  const column = tab?.columns?.[columnIndex];
  if (!row || !column) return;
  selectCell(tab, row, columnName(column), visualRowIndex, columnIndex, { focusGrid: false });
  scrollCellIntoView(entry.dataIndex, columnIndex);
}

function selectCurrentRowColumn(targetColumn) {
  const tab = activeDataTab.value;
  const cell = selectedCell.value;
  if (!tab) return false;
  const columnIndex = activeColumns.value.findIndex((column) => columnName(column) === targetColumn);
  if (columnIndex < 0) return false;

  const visualRows = editor.visualRowEntries(tab);
  let visualRowIndex = -1;
  let targetsInsertRow = false;
  if (cell?.tabId === tab.id && isInsertRowKey(cell.rowKey)) {
    const insertRow = getInsertRows(tab).find((row) => getInsertRowKey(tab, row.id) === cell.rowKey);
    if (insertRow) {
      targetsInsertRow = true;
      visualRowIndex = visualRows.visualIndexOfInsert(insertRow.id);
    }
  } else if (cell?.tabId === tab.id && cell.kind !== "fieldComment") {
    const dataRowIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(cell.rowKey);
    visualRowIndex = visualRows.visualIndexOfData(dataRowIndex);
  }

  if (visualRowIndex < 0 && visualRows.length > 0) {
    visualRowIndex = 0;
    targetsInsertRow = visualRows.at(0)?.type === "insert";
  }
  if (visualRowIndex < 0) {
    const column = activeColumns.value[columnIndex];
    selectGridFieldComment(tab, {
      name: targetColumn,
      comment: column?.column_comment || column?.columnComment || "",
    });
    return true;
  }

  selectVisualCellAt(tab, visualRowIndex, columnIndex);
  if (targetsInsertRow) requestAnimationFrame(() => scrollColumnIntoView(columnIndex));
  return true;
}

// 当前选中单元格在数据区里的坐标 { rowIndex, columnIndex }，用于让搜索优先
// 保留用户当前单元格（若它本身就是匹配项，则不跳到其它字段）。
function currentSearchPosition() {
  const tab = activeDataTab.value;
  const cell = selectedCell.value;
  if (!tab || !cell || cell.tabId !== tab.id) return null;
  const columns = Array.isArray(tab.columns) ? tab.columns : [];
  const rowIndex = createRowIndex(tab, { buildRowKey }).indexOfKey(cell.rowKey);
  const columnIndex = columns.findIndex((column) => columnName(column) === cell.column);
  if (rowIndex < 0 || columnIndex < 0) return null;
  return { rowIndex, columnIndex, rowKey: cell.rowKey };
}

const {
  searchInputRef,
  focusTableSearch,
  runTableSearch,
  handleTableFindKeydown,
  searchMatches,
  activeSearchQuery,
  hasSearchMatches,
  searchHitSummary,
  refreshCurrentSearchMatches,
  resumeCurrentSearchResults,
  goToNextSearchMatch,
  goToPreviousSearchMatch,
  dispose: disposeTableSearch,
} = useTableSearch(activeDataTab, {
  editState: props.editState,
  loadNextPage: props.loadNextPage,
  loadSearchResultPage: props.loadSearchResultPage,
  loadNextSearchResultPage: props.loadNextSearchResultPage,
  cancelSearchResultPage: props.cancelSearchResultPage,
  selectCellAt,
  statusText,
  isEditing: () => !!editingCell.value,
  getSelectedPosition: currentSearchPosition,
});

watch(viewportHeight, (height, previousHeight) => {
  if (!previousHeight || height >= previousHeight || !activeSearchQuery.value) return;
  const position = currentSearchPosition();
  if (!position) return;
  nextTick(() => scrollCellIntoView(position.rowIndex, position.columnIndex));
});

onBeforeUnmount(() => {
  captureActiveTableViewState();
  void disposeTableSearch();
});

const { handleUndoKeydown, handleRedoKeydown } = useUndo(
  props.editState,
  props.invokeWorkbench,
  activeDataTab,
  {
    statusText,
    applyLocalHistoryEntry: applyInsertDraftHistoryEntry,
    captureHistoryView: captureHistoryViewState,
    onHistoryApplied: syncSelectionAfterHistory,
    onCellCommitted: (event) => emit("cell-committed", event),
  },
);

const schemaSearchMatches = computed(() => (
  Array.isArray(activeDataTab.value?.schemaSearchMatches)
    ? activeDataTab.value.schemaSearchMatches
    : []
));
const schemaSearchIndex = computed(() => {
  const index = Number(activeDataTab.value?.schemaSearchIndex);
  return Number.isFinite(index) ? index : -1;
});
const schemaSearchSummary = computed(() => {
  const total = schemaSearchMatches.value.length;
  if (!total) return "";
  const current = Math.max(0, Math.min(total - 1, schemaSearchIndex.value));
  return `结构命中 ${current + 1}/${total}`;
});

function schemaSearchColumnName(match) {
  return typeof match === "string" ? match : match?.columnName || "";
}

function focusSchemaSearchMatch(index) {
  const tab = activeDataTab.value;
  const matches = schemaSearchMatches.value;
  if (!tab || !matches.length) return;
  const nextIndex = ((index % matches.length) + matches.length) % matches.length;
  tab.schemaSearchIndex = nextIndex;
  const targetColumn = schemaSearchColumnName(matches[nextIndex]);
  const columnIndex = activeColumns.value.findIndex((column) => columnName(column) === targetColumn);
  if (columnIndex >= 0) {
    nextTick(() => scrollColumnIntoView(columnIndex, "th"));
  }
  emitPaneState();
}

function goToNextSchemaSearchMatch() {
  focusPane();
  focusSchemaSearchMatch(schemaSearchIndex.value + 1);
}

function goToPreviousSchemaSearchMatch() {
  focusPane();
  focusSchemaSearchMatch(schemaSearchIndex.value - 1);
}

function handleSchemaSearchNext() {
  goToNextSchemaSearchMatch();
}

function handleSchemaSearchPrevious() {
  goToPreviousSchemaSearchMatch();
}

function focusPane() {
  emit("focus-pane", props.pane.id);
  emitPaneState();
}

function updateSplitMenuPosition() {
  const rect = splitMenuAnchor.value?.getBoundingClientRect?.();
  if (!rect) return;
  const viewportWidth = globalThis.innerWidth || globalThis.document?.documentElement?.clientWidth || rect.right;
  const maxLeft = Math.max(8, viewportWidth - SPLIT_MENU_WIDTH - 8);
  splitMenuPosition.value = {
    left: Math.min(Math.max(8, rect.right - SPLIT_MENU_WIDTH), maxLeft),
    top: Math.max(8, rect.bottom - 2),
  };
}

function toggleSplitMenu() {
  focusPane();
  if (splitMenuOpen.value) {
    splitMenuOpen.value = false;
    return;
  }
  updateSplitMenuPosition();
  splitMenuOpen.value = true;
  nextTick(updateSplitMenuPosition);
}

function openSplitMenuFromToolbar(event) {
  splitMenuAnchor.value = event?.currentTarget || event?.target || null;
  toggleSplitMenu();
}

function splitPaneFromMenu(direction) {
  splitMenuOpen.value = false;
  emit("split-pane", props.pane.id, direction);
}

function splitPaneFromToolbar(direction) {
  focusPane();
  emit("split-pane", props.pane.id, direction);
}

function exportFromMenu() {
  splitMenuOpen.value = false;
  triggerExport();
}

function importFromMenu() {
  splitMenuOpen.value = false;
  triggerImport();
}

function batchExportFromMenu() {
  splitMenuOpen.value = false;
  focusPane();
  emit("batch-export", activeDataTab.value || activeDesignTab.value);
}

function batchImportFromMenu() {
  splitMenuOpen.value = false;
  focusPane();
  emit("batch-import", activeDataTab.value || activeDesignTab.value);
}

function handlePanePointerDown(event) {
  focusPane();
  if (!event?.target?.closest?.(".wb-split-more-btn, .wb-split-menu")) splitMenuOpen.value = false;
}

function setGridWrapElement(element) {
  gridWrapRef.value = element;
}

function setSearchInputElement(element) {
  searchInputRef.value = element;
}

function resetGridState() {
  clearSelection();
  resetGridScroll();
  rememberGridScrollPosition(gridWrapRef.value);
}

function captureActiveTableViewState(tab = activeDataTab.value) {
  if (!tab) return null;
  const wrap = gridWrapRef.value;
  return captureTableTabViewState(tab, {
    scrollTop: wrap?.scrollTop ?? scrollTop.value,
    scrollLeft: wrap?.scrollLeft ?? 0,
    editor: captureTableViewSelection(),
  });
}

let tableViewRestoreSequence = 0;
function restoreActiveTableViewState(tab) {
  const state = readTableTabViewState(tab);
  restoreTableViewSelection(state?.editor || null);
  const sequence = ++tableViewRestoreSequence;
  nextTick(() => {
    if (sequence !== tableViewRestoreSequence || activeDataTab.value?.id !== tab?.id) return;
    restoreGridScroll({
      top: state?.scrollTop || 0,
      left: state?.scrollLeft || 0,
    });
    rememberGridScrollPosition(gridWrapRef.value);
  });
}

function highlightCell(tab, row, column, rowKey) {
  return highlightCellResult(props.editState, tab, row, column, rowKey);
}

function exitRowSelectionToCell(tab) {
  const indexes = selectedGridRowIndexes(tab);
  const visualRowIndex = indexes[0];
  const entry = gridRowEntries(tab)[visualRowIndex];
  const row = entry?.row;
  const columnIndex = 0;
  const column = activeColumns.value[columnIndex];
  const col = columnName(column);
  if (!row || !col) return false;
  clearRowSelection(tab);
  clearSelection();
  selectCell(tab, row, col, visualRowIndex, columnIndex);
  if (entry.type === "insert") scrollInsertCellIntoView(columnIndex, visualRowIndex);
  else scrollCellIntoView(entry.dataIndex, columnIndex);
  return true;
}

function selectGridCell(...args) {
  focusPane();
  if (consumeCellPointerClick()) return;
  clearRowSelection(activeDataTab.value);
  selectCell(...args);
}

function selectGridFieldComment(tab, columnMeta) {
  if (!tab || !columnMeta?.name) return;
  focusPane();
  clearRowSelection(tab);
  if (editingCell.value) finishEditing({ skipRefocus: true });
  clearSelection();
  selectedCell.value = {
    tabId: tab.id,
    rowKey: "__field_comment__",
    column: columnMeta.name,
    kind: "fieldComment",
  };
  textDraft.value = String(columnMeta.comment || "");
}

const detailReadOnly = computed(() => activeDataReadOnly.value || selectedCell.value?.kind === "fieldComment");
const selectedCellIsNull = computed(() => {
  const tab = activeDataTab.value;
  const cell = selectedCell.value;
  if (!tab || !cell || cell.tabId !== tab.id || cell.kind === "fieldComment" || isInsertRowKey(cell.rowKey)) return false;
  const row = createRowIndex(tab, { buildRowKey }).rowForKey(cell.rowKey);
  return Boolean(row && Object.prototype.hasOwnProperty.call(row, cell.column) && row[cell.column] == null);
});

async function saveInsertDraftRow(tab, rowId) {
  await commitInsertRow(tab, rowId);
}

function cancelInsertDraftRow(tab, rowId) {
  removeInsertDraftRow(tab, rowId);
}

function startGridRangeSelection(...args) {
  focusPane();
  clearRowSelection(activeDataTab.value);
  startRangeSelection(...args);
}

function selectGridRow(tab, row, event) {
  focusPane();
  if (consumeRowDragClickSuppression()) {
    gridWrapRef.value?.focus();
    return;
  }
  commitEditingBeforeSelectionChange();
  clearSelection();
  toggleRowSelect(tab, row, event);
  gridWrapRef.value?.focus();
}

function startGridRowDragSelection(tab, row, rowIndex, event, wrap) {
  focusPane();
  commitEditingBeforeSelectionChange();
  clearSelection();
  startRowDragSelection(tab, row, event, wrap);
  gridWrapRef.value?.focus();
}

function extendGridRowDragSelection(tab, event) {
  extendRowDragSelectionFromPointer(tab, event);
}

function toggleAllGridRows(tab) {
  focusPane();
  commitEditingBeforeSelectionChange();
  clearSelection();
  toggleAllRows(tab);
  gridWrapRef.value?.focus();
}

function selectGridInsertRow(tab, rowId, event) {
  focusPane();
  if (consumeRowDragClickSuppression()) {
    gridWrapRef.value?.focus();
    return;
  }
  commitEditingBeforeSelectionChange();
  clearSelection();
  const insertRow = getInsertRows(tab).find((row) => row.id === rowId);
  if (!insertRow) return;
  toggleRowSelect(tab, { ...insertRow.draft, __insertRowId: rowId }, event);
  if (tab.selectedRowKeys.has(getInsertRowKey(tab, rowId))) selectInsertRow(tab, rowId);
  else selectedInsertRow.value = null;
  gridWrapRef.value?.focus();
}

async function handleGridKeydownWithRows(event) {
  focusPane();
  const tab = activeDataTab.value;
  const key = String(event.key || "").toLowerCase();
  const pasteShortcut = (event.metaKey || event.ctrlKey) && key === "v";
  // Let the browser dispatch a real ClipboardEvent for grid paste. Reading
  // navigator.clipboard from keydown opens an extra macOS WebKit Paste menu.
  if (pasteShortcut && !editingCell.value) return;
  if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && tab?.selectedRowKeys?.size > 0) {
    if (exitRowSelectionToCell(tab)) {
      event.preventDefault();
      gridWrapRef.value?.focus();
      return;
    }
  }
  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && tab?.selectedRowKeys?.size > 0) {
    if (moveRowSelection(tab, event.key, { extendRange: event.shiftKey })) {
      event.preventDefault();
      const selectedIndexes = selectedGridRowIndexes(tab);
      const targetIndex = event.key === "ArrowUp" ? selectedIndexes[0] : selectedIndexes.at(-1);
      const targetEntry = targetIndex == null ? null : gridRowEntries(tab)[targetIndex];
      if (targetEntry?.type === "insert") scrollInsertCellIntoView(0, targetIndex, { scrollColumn: false });
      else if (targetEntry) scrollRowIntoView(targetEntry.dataIndex);
      gridWrapRef.value?.focus();
      return;
    }
  }
  if ((event.key === "Delete" || event.key === "Backspace") && tab?.selectedRowKeys?.size > 0) {
    event.preventDefault();
    if (tab.readOnly || tab.read_only) {
      statusText.value = "只读连接不能删除数据";
      return;
    }
    deleteSelectedRows(tab);
    return;
  }
  const result = await handleGridKeydown(event);
  if (result?.insertedRows > 0 && !result?.failedRowId && tab) {
    await refreshTabPage(tab, tab.page || 1);
  }
}

async function handleGridPaste(event) {
  const editableTarget = event.target?.closest?.("input, textarea, [contenteditable='true']");
  if (editableTarget) return;
  const text = event.clipboardData?.getData("text/plain");
  if (typeof text !== "string") return;
  event.preventDefault();
  event.stopPropagation();
  focusPane();
  const tab = activeDataTab.value;
  try {
    const result = await pasteGridText(text);
    if (result?.insertedRows > 0 && !result?.failedRowId && tab) {
      await refreshTabPage(tab, tab.page || 1);
    }
  } catch {
    statusText.value = "粘贴失败，请重试";
  }
}

function matchesInsertedDraft(row, draft) {
  const entries = Object.entries(draft).filter(([, value]) => String(value ?? "").trim() !== "");
  return entries.length > 0 && entries.every(([column, value]) => String(row?.[column] ?? "") === String(value ?? ""));
}

function selectVisibleInsertedRow(tab, draft) {
  if (tabRowCount(tab) === 0) return false;
  const rowIndex = tabRows(tab).findLastIndex((row) => matchesInsertedDraft(row, draft));
  if (rowIndex < 0) return false;
  const rowKey = buildRowKey(tab, tabRowAt(tab, rowIndex));
  clearSelection();
  tab.selectedRowKeys.clear();
  tab.selectedRowKeys.add(rowKey);
  scrollRowIntoView(rowIndex);
  gridWrapRef.value?.focus();
  return true;
}

function nonEmptyInsertDrafts(tab, rows = getInsertRows(tab)) {
  return rows
    .map((row) => ({ rowId: row.id, draft: { ...row.draft } }))
    .filter(({ draft }) => Object.values(draft).some((value) => String(value ?? "").trim() !== ""));
}

function insertDraftRefreshPrompt(count) {
  return `当前有 ${count} 条新增行尚未保存。\n\n是否先保存后刷新？`;
}

function clearInsertDraftsAfterRefresh(tab) {
  clearInsertDraft(tab);
  clearSelection({ clearInsertDrafts: true });
}

async function prepareInsertDraftsForRefresh(tab, { excludeInsertRowIds = [] } = {}) {
  const excludedIds = new Set(excludeInsertRowIds);
  const insertRows = getInsertRows(tab).filter((row) => !excludedIds.has(row.id));
  if (insertRows.length === 0) return true;
  const drafts = nonEmptyInsertDrafts(tab, insertRows);
  if (drafts.length === 0) {
    if (excludedIds.size === 0) clearInsertDraftsAfterRefresh(tab);
    return true;
  }
  const confirmed = await confirmDialog({
    title: "保存新增行",
    message: insertDraftRefreshPrompt(drafts.length),
    confirmText: "保存并刷新",
    cancelText: "取消",
  });
  if (!confirmed) {
    statusText.value = "已取消刷新，新增行尚未保存";
    return false;
  }
  const result = await commitInsertRows(tab, { rowIds: drafts.map((draft) => draft.rowId) });
  if (result?.failedRowId) {
    statusText.value = `新增行保存失败：${result.failedReason || statusText.value || "请检查新增行输入"}`;
    return false;
  }
  return true;
}

async function commitInsertRowsAndRefresh(tab) {
  const drafts = nonEmptyInsertDrafts(tab);
  const result = await commitInsertRows(tab);
  if (result?.failedRowId) return;
  if (result?.insertedRows > 0) {
    await refreshTabPage(tab, tab.page || 1);
    clearInsertDraftsAfterRefresh(tab);
  }
  const lastDraft = drafts[Math.max(0, result.insertedRows - 1)]?.draft;
  if (lastDraft && selectVisibleInsertedRow(tab, lastDraft)) return;
  gridWrapRef.value?.focus();
}

function sortPage(tab, col) {
  resetGridState();
  props.toggleSort(tab, col);
}

async function applyGridSort(tab, col, direction) {
  resetGridState();
  const result = await props.applySort(tab, col, direction);
  if (result?.ok) await resumeCurrentSearchResults({ select: true });
  return result;
}

let loadMoreFrame = 0;
let pendingLoadMoreTarget = null;
let pendingPreviousScrollIntent = false;
let lastObservedGridScrollTop = null;
let previousPageAnchorPending = false;
let gridPagingSuspended = false;
const PREVIOUS_PAGE_PREFETCH_ROWS = 200;
const PREVIOUS_PAGE_PREFETCH_VIEWPORTS = 4;

function rememberGridScrollPosition(target) {
  lastObservedGridScrollTop = target
    ? Math.max(0, Number(target.scrollTop) || 0)
    : null;
  pendingPreviousScrollIntent = false;
}

function maybeLoadMoreRows(target, { loadPrevious = false } = {}) {
  const tab = activeDataTab.value;
  if (!tab || !target || gridPagingSuspended) return;
  if (!tab.loadingMore && !tab.fullyLoaded) {
    const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (remaining < rowHeight.value * 20) props.loadNextPage(tab);
  }
  if (loadPrevious) void maybeLoadPreviousRows(target, tab);
}

function previousPagePrefetchDistance(target) {
  return Math.max(
    rowHeight.value * PREVIOUS_PAGE_PREFETCH_ROWS,
    target.clientHeight * PREVIOUS_PAGE_PREFETCH_VIEWPORTS,
  );
}

function wheelDeltaPixels(event, target) {
  const delta = Number(event?.deltaY);
  if (!Number.isFinite(delta)) return 0;
  if (Number(event?.deltaMode) === 1) return delta * rowHeight.value;
  if (Number(event?.deltaMode) === 2) return delta * Math.max(1, target.clientHeight);
  return delta;
}

// 向上滚动接近已加载窗口顶部时前插上一页（跳到末行后的回程）。
// 前插后做滚动锚定：补回新增行的等高距离，视口内容保持不动。
async function maybeLoadPreviousRows(target, tab, { projectedScrollTop = null } = {}) {
  if (gridPagingSuspended || previousPageAnchorPending || tab.loadingPrevious) return;
  const windowOffset = Math.max(0, Math.floor(Number(tab.rowWindowOffset) || 0));
  if (windowOffset <= 0) return;
  // 给快速触控板手势留出足够读取时间；projectedScrollTop 也覆盖一次
  // 大幅 wheel 直接越过预取区的情况，避免等到硬顶后再补一次手势。
  const currentTop = Math.max(0, Number(target.scrollTop) || 0);
  const projectedTop = Number.isFinite(projectedScrollTop)
    ? Math.max(0, projectedScrollTop)
    : currentTop;
  if (Math.min(currentTop, projectedTop) >= previousPagePrefetchDistance(target)) return;
  previousPageAnchorPending = true;
  try {
    const result = await props.loadPreviousPage(tab);
    if (!result?.ok || !result.addedRows) return;
    if (activeDataTab.value !== tab || gridWrapRef.value !== target) return;
    await nextTick();
    if (activeDataTab.value !== tab || gridWrapRef.value !== target) return;
    offsetGridScroll(result.addedRows * rowHeight.value, target);
    rememberGridScrollPosition(target);
  } finally {
    previousPageAnchorPending = false;
  }
}

function handleGridWheel(event) {
  if (gridPagingSuspended) return;
  const deltaY = Number(event?.deltaY);
  if (!Number.isFinite(deltaY) || deltaY === 0) return;
  if (deltaY > 0) {
    pendingPreviousScrollIntent = false;
    return;
  }
  pendingPreviousScrollIntent = true;
  const target = gridWrapRef.value;
  const tab = activeDataTab.value;
  if (!target || !tab) return;
  const projectedScrollTop = Math.max(
    0,
    (Number(target.scrollTop) || 0) + wheelDeltaPixels(event, target),
  );
  void maybeLoadPreviousRows(target, tab, { projectedScrollTop });
}

function scheduleLoadMoreRows(event) {
  const target = event?.target;
  if (!target) return;
  const currentTop = Math.max(0, Number(target.scrollTop) || 0);
  if (lastObservedGridScrollTop != null) {
    if (currentTop < lastObservedGridScrollTop) pendingPreviousScrollIntent = true;
    else if (currentTop > lastObservedGridScrollTop) pendingPreviousScrollIntent = false;
  }
  lastObservedGridScrollTop = currentTop;
  pendingLoadMoreTarget = target;
  if (loadMoreFrame) return;
  loadMoreFrame = requestAnimationFrame(() => {
    const target = pendingLoadMoreTarget;
    const loadPrevious = pendingPreviousScrollIntent;
    pendingLoadMoreTarget = null;
    pendingPreviousScrollIntent = false;
    loadMoreFrame = 0;
    maybeLoadMoreRows(target, { loadPrevious });
  });
}

function activateTab(tabId) {
  if (props.pane.activeTabId !== tabId) {
    if (editingCell.value) finishEditing({ skipRefocus: true });
    captureActiveTableViewState();
  }
  focusPane();
  emit("activate-tab", props.pane.id, tabId);
}

function closeTab(tabId) {
  focusPane();
  emit("close-tab", props.pane.id, tabId);
}

function reorderTab(sourceId, targetId, options) {
  emit("reorder-tab", props.pane.id, sourceId, targetId, options);
}

function openTableContextMenu(event) {
  focusPane();
  emit("table-contextmenu", event, activeDataTab.value);
}

function deleteGridRow(tab, row) {
  if (row?.__insertRowId) {
    editor.removeInsertDraftRow(tab, row.__insertRowId);
    return;
  }
  deleteRow(tab, row);
}

function openRowContextMenu(event, tab, row, originalIndex) {
  focusPane();
  commitEditingBeforeSelectionChange();
  clearSelection();
  ensureRowContextSelection(tab, row);
  if (row?.__insertRowId) {
    selectInsertRow(tab, row.__insertRowId);
  }
  const selectedRowCount = tab?.selectedRowKeys?.size || 0;
  emit("row-contextmenu", event, tab, row, originalIndex,
    {
      insertDraftAbove,
      insertDraftBelow,
      insertDraftsAbove,
      insertDraftsBelow,
      canInsertCopiedRows: canInsertCopiedRows(tab),
      pasteCopiedRowsAbove,
      deleteRow: deleteGridRow,
      deleteSelectedRows,
      selectedRowCount,
    });
}

function openTabContextMenu(payload) {
  focusPane();
  emit("tab-contextmenu", payload);
}

function triggerExport() {
  focusPane();
  emit("export", activeDataTab.value);
}

function triggerImport() {
  if (activeDataReadOnly.value) {
    statusText.value = "只读连接不能导入数据";
    return;
  }
  focusPane();
  emit("import", activeDataTab.value);
}

function isEditableShortcutTarget(target) {
  if (!target) return false;
  return Boolean(target.isContentEditable || target.closest?.("input, textarea, select"));
}

function handleOpenDesignKeydown(event) {
  const key = String(event.key || "");
  if (!(key.toLowerCase() === "d" && (event.ctrlKey || event.metaKey))) return false;
  if (isEditableShortcutTarget(event.target)) return false;
  if (!activeDataTab.value) return false;
  if (activeDataReadOnly.value) {
    statusText.value = "只读连接不能打开表设计";
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  emit("open-design", activeDataTab.value, props.pane.id);
  return true;
}

function handlePaneKeydown(event) {
  if (handleTableFindKeydown(event)) return;
  if (handleOpenDesignKeydown(event)) return;
  if (handleRedoKeydown(event)) return;
  handleUndoKeydown(event);
}

function setTextDraft(value) {
  updateTextDraft(value);
}

function runGridClipboardShortcut(key) {
  return handleGridKeydown({
    key,
    ctrlKey: true,
    metaKey: false,
    preventDefault() {},
  });
}

function copyGridSelection() {
  return runGridClipboardShortcut("c");
}

function pasteGridSelection() {
  return props.invokeWorkbench("read_clipboard_text")
    .then((text) => pasteGridText(text))
    .catch(() => {
      statusText.value = "读取剪贴板失败";
      return { ok: false, message: statusText.value };
    });
}

function openDetailContextMenu(event, clipboardActions) {
  focusPane();
  emit("detail-contextmenu", event, activeDataTab.value, clipboardActions);
}

function copyHomeSelection() {
  return databaseHomeRef.value?.copySelection?.() === true;
}

function pasteHomeTables() {
  return databaseHomeRef.value?.pasteTables?.() === true;
}

function focusCurrentSearch() {
  if (activeHomeTab.value) return databaseHomeRef.value?.focusSearch?.() === true;
  if (!activeDataTab.value) return false;
  focusTableSearch();
  return true;
}

// ── 查找替换弹窗（Ctrl+F / Ctrl+H 经 focusedPaneState 调用）──────────────
// 选区范围的全部替换（含新增行草稿格），数据行与草稿格共享同一个撤销事务。
async function replaceCellsInSelection({ query, replacement, caseSensitive } = {}) {
  const tab = activeDataTab.value;
  const range = selectedRange.value;
  return editor.replaceSelectionCells(tab, range, { query, replacement, caseSensitive });
}

function selectionCellValue(tab, entry, column) {
  if (entry.type === "insert") return String(entry.insertRow?.draft?.[column] ?? "");
  return displayCellValue(props.editState, tab, entry.row, column);
}

// 选区范围的命中明细列表（含新增行草稿格），供弹窗结果列表展示与导航。
function listSelectionMatches({ query, caseSensitive } = {}) {
  const tab = activeDataTab.value;
  const range = selectedRange.value;
  if (!tab || !range || range.tabId !== tab.id || !query) return [];
  const matches = [];
  for (const { entry, column, columnIndex } of editor.selectedGridCells(tab, range)) {
    if (entry.type !== "insert" && (entry.type !== "data" || !entry.row)) continue;
    const value = selectionCellValue(tab, entry, column);
    const occurrences = replaceSearchText(value, query, "", { caseSensitive }).replacedCount;
    if (!occurrences) continue;
    matches.push({
      kind: entry.type === "insert" ? "insert" : "data",
      insertRow: entry.insertRow || null,
      row: entry.row || null,
      dataIndex: entry.dataIndex,
      rowIdentity: entry.type === "data" ? buildRowIdentity(tab, entry.row) : null,
      column,
      columnName: column,
      columnIndex,
      value,
      occurrences,
    });
  }
  return matches;
}

// 按行标识定位整表命中：已加载行直接选中；未加载行渐进翻页直到出现。
async function locateTableMatch(tab, { rowIdentity, columnName: targetColumn } = {}) {
  const columns = Array.isArray(tab?.columns) ? tab.columns : [];
  const columnIndex = columns.findIndex((column) => columnName(column) === targetColumn);
  if (columnIndex < 0) return { ok: false, reason: "列不存在" };
  const findLoadedIndex = () => (
    createRowIndex(tab, { buildRowKey }).indexOfKey(buildRowKeyFromIdentity(tab, rowIdentity))
  );
  let rowIndex = findLoadedIndex();
  if (rowIndex < 0 && typeof props.loadNextPage === "function") {
    statusText.value = "正在定位命中行…";
    while (rowIndex < 0 && !tab.fullyLoaded) {
      const before = tabRowCount(tab);
      await props.loadNextPage(tab);
      rowIndex = findLoadedIndex();
      if (tabRowCount(tab) <= before && !tab.fullyLoaded) break;
    }
  }
  if (rowIndex < 0) {
    statusText.value = "未找到对应行（数据可能已变化）";
    return { ok: false, reason: "未找到对应行（数据可能已变化）" };
  }
  selectCellAt(tab, rowIndex, columnIndex);
  return { ok: true };
}

// 跳转任意列表命中：选区命中保留选区仅移动高亮；整表命中按行标识定位。
async function locateListMatch(match) {
  const tab = activeDataTab.value;
  if (!tab || !match) return { ok: false, reason: "当前没有打开的数据表" };
  if (match.row || match.insertRow) {
    editor.activateCellInRange(tab, {
      kind: match.kind,
      insertRow: match.insertRow,
      row: match.row,
      column: match.column ?? match.columnName,
      rowIndex: match.dataIndex,
      columnIndex: match.columnIndex,
    });
    return { ok: true };
  }
  return locateTableMatch(tab, match);
}

// 替换列表中的当前命中：选区数据行/已加载行走常规提交，新增行草稿走草稿
// 历史，未加载行直接按行标识 + 旧值守卫提交。返回新值供列表刷新。
async function replaceListMatch({ match, query, replacement, caseSensitive } = {}) {
  const tab = activeDataTab.value;
  if (!tab || !match) return { ok: false, reason: "当前没有打开的数据表" };
  const next = replaceSearchText(match.value, query, replacement, { caseSensitive });
  if (!next.replacedCount) return { ok: true, replaced: 0, newValue: match.value };
  if (match.kind === "insert" && match.insertRow) {
    const result = editor.commitInsertDraftCellValue(tab, match.insertRow.id, match.column, next.text);
    if (!result?.ok) return { ok: false, reason: result?.reason || "替换失败" };
    return { ok: true, replaced: next.replacedCount, newValue: next.text };
  }
  const column = match.column ?? match.columnName;
  let row = match.row || null;
  if (!row && match.rowIdentity) {
    const loadedIndex = createRowIndex(tab, { buildRowKey })
      .indexOfKey(buildRowKeyFromIdentity(tab, match.rowIdentity));
    if (loadedIndex >= 0) row = tabRowAt(tab, loadedIndex);
  }
  if (row) {
    const result = await editor.commitCellValue(tab, row, column, next.text);
    if (!result?.ok) return { ok: false, reason: result?.reason || "替换失败" };
    return { ok: true, replaced: next.replacedCount, newValue: next.text };
  }
  const result = await props.invokeWorkbench("update_cell", {
    request: {
      sessionId: tab.sessionId,
      rowIdentity: match.rowIdentity,
      columnName: column,
      oldValue: match.value,
      newValue: next.text,
    },
  });
  if (result?.conflict || result?.updated === false) {
    return { ok: false, reason: "该行已被其他操作修改，请刷新列表后重试" };
  }
  return { ok: true, replaced: next.replacedCount, newValue: next.text };
}

function emitPaneState() {
  emit("state-change", {
    paneId: props.pane.id,
    activeDataTab: activeDataTab.value,
    activeDesignTab: activeDesignTab.value,
    activeHomeTab: activeHomeTab.value,
    activeColumns: activeColumns.value,
    selectedCell: selectedCell.value,
    selectedRange: selectedRange.value,
    textDraft: textDraft.value,
    setTextDraft,
    saveTextPanel,
    commitInsertRowsAndRefresh,
    prepareInsertDraftsForRefresh,
    clearInsertDraftsAfterRefresh,
    handleWorkbenchKeydown: handlePaneKeydown,
    copyHomeSelection,
    pasteHomeTables,
    copyGridSelection,
    pasteGridSelection,
    pasteCopiedRowsAbove,
    focusCurrentSearch,
    captureActiveTableViewState,
    clearSelection,
    resetGridScroll,
    selectCellAt,
    selectVisualCellAt,
    selectCurrentRowColumn,
    selectInsertCell,
    scrollColumnIntoView,
    applyFreezeTarget,
    focusTableSearch,
    runTableSearch,
    refreshCurrentSearchMatches,
    resumeCurrentSearchResults,
    goToNextSearchMatch,
    goToPreviousSearchMatch,
    replaceCellsInSelection,
    listSelectionMatches,
    locateListMatch,
    replaceListMatch,
    activeSearchQuery: activeSearchQuery.value,
    searchMatchCount: searchMatches.value.length,
    hasSearchMatches: hasSearchMatches.value,
    schemaSearchMatches: schemaSearchMatches.value,
    schemaSearchIndex: schemaSearchIndex.value,
    schemaSearchQuery: activeDataTab.value?.schemaSearchQuery || "",
    insertDraftAbove,
    insertDraftBelow,
    insertDraftsAbove,
    insertDraftsBelow,
    deleteRow: deleteGridRow,
    setCellToNull,
    goToNextSchemaSearchMatch,
    goToPreviousSchemaSearchMatch,
    // Inline-editing hooks used by the Ctrl+P sidebar-search shortcut: when a
    // cell is being edited, the orchestrator must commit it WITHOUT refocusing
    // the grid before moving focus to the sidebar — otherwise the editor
    // input's blur fires finishEditing(), whose nextTick refocus steals focus
    // back to the grid and the user has to press Ctrl+P twice.
    isEditing: () => !!editingCell.value,
    commitEditingWithoutRefocus: () => finishEditing({ skipRefocus: true }),
  });
}

watch(
  () => [activeDataTab.value, tableTabViewRevision(activeDataTab.value)],
  ([tab], previous = []) => {
    const [previousTab] = previous;
    if (previousTab && previousTab !== tab) captureActiveTableViewState(previousTab);
    restoreActiveTableViewState(tab);
  },
  { immediate: true, flush: "sync" },
);

watch(
  () => [
    props.pane.id,
    props.activeTab?.id,
    activeColumns.value.length,
    activeDataTab.value?.schemaSearchQuery,
    activeDataTab.value?.schemaSearchMatches?.length,
    activeDataTab.value?.schemaSearchIndex,
    activeSearchQuery.value,
    searchMatches.value.length,
    tabRowCount(activeDataTab.value),
    activeDataTab.value?.columns?.length,
    activeDataTab.value?.dataVersion,
    selectedCell.value,
    selectedRange.value,
    textDraft.value,
  ],
  emitPaneState,
  { immediate: true },
);

watch(
  () => [
    activeDataTab.value?.id,
    activeSearchQuery.value,
    tabRowCount(activeDataTab.value),
    activeDataTab.value?.columns?.length,
    activeDataTab.value?.dataVersion,
  ],
  () => {
    refreshCurrentSearchMatches?.();
  },
  { immediate: true },
);

watch(
  () => props.isFocused,
  (focused) => {
    if (focused) emitPaneState();
    else splitMenuOpen.value = false;
  },
);

onMounted(() => emitPaneState());
</script>

<template>
  <section
    class="wb-workbench-pane"
    :class="{ 'is-focused': isFocused }"
    :data-pane-id="pane.id"
    @pointerdown.capture="handlePanePointerDown($event)"
  >
    <Teleport defer to=".mysql-workbench">
      <Transition name="wb-split-menu">
        <menu
          v-if="splitMenuOpen"
          class="wb-split-menu is-floating"
          :style="{ left: `${splitMenuPosition.left}px`, top: `${splitMenuPosition.top}px` }"
          @pointerdown.stop
          @click.stop
        >
          <button type="button" :disabled="busy || !activeDataTab" @click="exportFromMenu">导出</button>
          <button type="button" :disabled="busy || !activeDataTab?.sessionId" @click="importFromMenu">导入</button>
          <button type="button" :disabled="busy" @click="batchExportFromMenu">批量导出</button>
          <button type="button" :disabled="busy || activeSourceReadOnly" @click="batchImportFromMenu">批量导入</button>
          <button type="button" @click="splitPaneFromMenu('right')">左右分屏</button>
          <button type="button" @click="splitPaneFromMenu('down')">上下分屏</button>
        </menu>
      </Transition>
    </Teleport>

    <header
      class="wb-pane-tabbar"
      :class="{
        'is-focused-pane': isFocused,
        'is-left-edge-pane': leftEdge,
        'is-right-edge-pane': rightEdge,
        'is-top-edge-pane': topEdge,
      }"
      data-tauri-drag-region
    >
      <WorkbenchTabs
        :tabs="tabs"
        :active-tab-id="pane.activeTabId"
        :pane-id="pane.id"
        :can-close-pane="rootPaneCount > 1"
        @activate-tab="activateTab"
        @close-tab="closeTab"
        @close-pane="emit('close-pane', pane.id)"
        @reorder-tab="reorderTab"
        @copy-tab-name="emit('copy-tab-name', $event)"
        @tab-contextmenu="openTabContextMenu"
      />
    </header>

    <DataGrid
      v-if="activeDataTab"
      :tab="activeDataTab"
      :active-columns="activeColumns"
      :active-column-meta="activeColumnMeta"
      :visible-rows="visibleRows"
      :virtual-range="virtualRange"
      :frozen-rows-active="frozenRowsActive"
      :selected-cell="selectedCell"
      :selected-range="selectedRange"
      :is-selecting-range="isSelectingRange"
      :is-cell-in-selected-range="isCellInSelectedRange"
      :get-cell-range-classes="getCellRangeClasses"
      :editing-cell="editingCell"
      :edit-draft="editDraft"
      :selected-insert-cell="selectedInsertCell"
      :selected-insert-row="selectedInsertRow"
      :edit-state="editState"
      :busy="busy"
      :highlight-cell="highlightCell"
      :has-search-matches="hasSearchMatches"
      :search-hit-summary="searchHitSummary"
      :schema-search-matches="schemaSearchMatches"
      :schema-search-index="schemaSearchIndex"
      :schema-search-summary="schemaSearchSummary"
      :get-insert-rows="getInsertRows"
      :get-visible-insert-rows="getVisibleInsertRows"
      :get-insert-draft="getInsertDraft"
      :get-insert-row-key="getInsertRowKey"
      :is-insert-row-visible="isInsertRowVisible"
      :is-insert-row-saving="isInsertRowSaving"
      :insert-aware-visual-row-index="insertAwareVisualRowIndex"
      :is-column-selected="isColumnSelected"
      @grid-ready="setGridWrapElement"
      @search-ready="setSearchInputElement"
      @search-input="runTableSearch"
      @search-previous="goToPreviousSearchMatch"
      @search-next="goToNextSearchMatch"
      @schema-search-previous="handleSchemaSearchPrevious"
      @schema-search-next="handleSchemaSearchNext"
      @scroll="onGridScroll($event); scheduleLoadMoreRows($event)"
      @wheel="handleGridWheel"
      @keydown="handleGridKeydownWithRows"
      @paste="handleGridPaste"
      @cell-click="selectGridCell"
      @cell-mousedown="startGridRangeSelection"
      @cell-enter="extendRangeSelection"
      @range-pointer="extendRangeSelectionFromPointer"
      @range-end="finishRangeSelection"
      @cell-dblclick="startEditing"
      @cell-blur="finishEditing"
      @edit-input="updateEditDraft"
      @finish-edit="finishEditing(); navigateCell(1, 0)"
      @cancel-edit="cancelEditing"
      @tab-edit="finishEditing(); navigateCell(0, $event ? -1 : 1)"
      @toggle-sort="sortPage"
      @apply-sort="applyGridSort"
      @toggle-row-select="selectGridRow"
      @row-select-start="startGridRowDragSelection"
      @row-select-pointer="extendGridRowDragSelection"
      @row-select-end="finishRowDragSelection"
      @toggle-all-rows="toggleAllGridRows"
      @insert-input="updateInsertDraft"
      @insert-paste="pasteIntoInsertInput"
      @insert-focus="selectInsertCell"
      @insert-keydown="handleInsertKeydown"
      @insert-row-select="selectGridInsertRow"
      @save-insert-row="saveInsertDraftRow"
      @cancel-insert-row="cancelInsertDraftRow"
      @insert-first-row="insertDraftBelow"
      @append-row="insertDraftBelow"
      @export="triggerExport"
      @import="triggerImport"
      @replace="emit('replace', activeDataTab)"
      @batch-export="batchExportFromMenu"
      @batch-import="batchImportFromMenu"
      @split-pane="splitPaneFromToolbar"
      @select-column="editor.selectColumn"
      @select-field-comment="selectGridFieldComment"
      @contextmenu="openTableContextMenu"
      @row-contextmenu="openRowContextMenu"
      @retry-load="retryGridLoad"
      @jump-boundary="jumpGridBoundary"
    />

    <CellDetailPanel
      v-if="activeDataTab"
      :selected-cell="selectedCell"
      :text-draft="textDraft"
      :identity-remap="detailIdentityRemap"
      :read-only="detailReadOnly"
      :is-null="selectedCellIsNull"
      @update:text-draft="updateTextDraft"
      @save-text-panel="saveTextPanel"
      @commit-detail-draft="commitDetailDraft"
      @detail-contextmenu="openDetailContextMenu"
    />

    <SqlQueryWorkspace
      v-else-if="activeSqlTab"
      :key="activeSqlTab.id"
      :tab="activeSqlTab"
      :invoke-workbench="invokeWorkbench"
      :schema="schema"
      :connections="connections"
      :databases="databases"
      @schema-changed="emit('sql-schema-changed', $event)"
      @state-change="emitPaneState"
    />

    <SqlQueryLibrary
      v-else-if="activeSqlLibraryTab"
      :documents="sqlDocuments"
      :tabs="allTabs"
      :connections="connections"
      :connection-id="currentConnectionId"
      :invoke-workbench="invokeWorkbench"
      @new-query="emit('new-sql-query', $event, pane.id)"
      @open-query="emit('open-sql-document', $event, pane.id)"
      @duplicate-query="emit('duplicate-sql-document', $event, pane.id)"
      @rename-query="emit('rename-sql-document', $event)"
      @delete-query="emit('delete-sql-document', $event, pane.id)"
      @open-file="emit('open-sql-file', $event, pane.id)"
    />

    <DatabaseHome
      v-else-if="activeHomeTab"
      :key="activeHomeTab.tabKey || activeHomeTab.id"
      ref="databaseHomeRef"
      :tab="activeHomeTab"
      :tables="homeTables"
      :clipboard="homeClipboard"
      :recent-table-names="recentTableNames"
      :busy="busy"
      :active="isFocused"
      :can-close-pane="rootPaneCount > 1"
      @open-table="emit('open-home-table', $event, pane.id)"
      @open-design="emit('open-design', $event, pane.id)"
      @copy-tables="emit('copy-home-tables', $event)"
      @paste-tables="emit('paste-home-tables', $event)"
      @rename-table="emit('rename-home-table', $event)"
      @delete-tables="emit('delete-home-tables', $event)"
      @refresh="emit('refresh-home', $event)"
      @visible-tables="emit('home-visible-tables', $event)"
      @batch-export="emit('batch-export', $event)"
      @batch-import="emit('batch-import', $event)"
      @focus-table="emit('focus-home-table', $event, pane.id)"
      @split-pane="emit('split-pane', pane.id, $event)"
      @close-pane="emit('close-pane', pane.id)"
      @open-sql-library="emit('open-sql-library', pane.id)"
      @state-change="emit('state-change', { paneId: pane.id, activeHomeTab, activeDataTab: null, activeDesignTab: null })"
    />

    <section v-else-if="activeDesignTab" class="wb-pane-content-with-actions">
      <div class="wb-pane-inline-actions" aria-label="分屏操作">
        <button
          ref="splitMenuAnchor"
          type="button"
          class="wb-split-more-btn"
          title="更多选项"
          aria-label="更多选项"
          :aria-expanded="splitMenuOpen ? 'true' : 'false'"
          @click.stop="openSplitMenuFromToolbar($event)"
        >
          <span class="wb-split-more-dots" aria-hidden="true"></span>
        </button>
      </div>
      <TableDesignEditor
        :source="activeDesignTab"
        :invoke-workbench="invokeWorkbench"
        @applied="emit('design-applied', $event)"
      />
    </section>

    <section v-else class="wb-empty">
      <div class="wb-pane-empty-actions" aria-label="分屏操作">
        <button
          ref="splitMenuAnchor"
          type="button"
          class="wb-split-more-btn"
          title="更多选项"
          aria-label="更多选项"
          :aria-expanded="splitMenuOpen ? 'true' : 'false'"
          @click.stop="openSplitMenuFromToolbar($event)"
        >
          <span class="wb-split-more-dots" aria-hidden="true"></span>
        </button>
      </div>
      <div class="wb-empty-content">
        <svg class="wb-empty-icon" viewBox="0 0 48 48" aria-hidden="true">
          <rect x="6" y="8" width="36" height="32" rx="3" fill="none" stroke="currentColor" stroke-width="2"/>
          <line x1="6" y1="16" x2="42" y2="16" stroke="currentColor" stroke-width="2"/>
          <line x1="14" y1="24" x2="34" y2="24" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
          <line x1="14" y1="30" x2="28" y2="30" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
        </svg>
        <strong>从左侧打开一张表</strong>
        <span>或使用快捷搜索定位数据</span>
      </div>
    </section>
  </section>
</template>
