<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { GRID_ROW_HEIGHT } from "../constants.js";
import { tabRowAt, tabRowCount, tabRows } from "../rowStore.js";
import { columnName } from "../utils/normalize.js";
import { highlightCellResult } from "../utils/cellDisplay.js";
import { buildRowKey } from "../utils/rowIdentity.js";
import { createRowIndex } from "../utils/rowIndex.js";
import { shouldResetGridForTabActivation } from "../utils/tabActivation.js";
import { useGridEditor } from "../composables/useGridEditor.js";
import { useRowSelection } from "../composables/useRowSelection.js";
import { useTableSearch } from "../composables/useTableSearch.js";
import { useUndo } from "../composables/useUndo.js";
import { useVirtualGrid } from "../composables/useVirtualGrid.js";
import { useConfirm } from "../composables/useConfirm.js";

import WorkbenchTabs from "./WorkbenchTabs.vue";
import DataGrid from "./DataGrid.vue";
import TableDesignEditor from "./TableDesignEditor.vue";
import CellDetailPanel from "./CellDetailPanel.vue";
import DatabaseHome from "./DatabaseHome.vue";

const props = defineProps({
  pane: { type: Object, required: true },
  tabs: { type: Array, default: () => [] },
  activeTab: { type: Object, default: null },
  editState: { type: Object, required: true },
  invokeWorkbench: { type: Function, required: true },
  appState: { type: Object, required: true },
  homeTables: { type: Array, default: () => [] },
  homeClipboard: { type: Object, default: null },
  recentTableNames: { type: Array, default: () => [] },
  isFocused: { type: Boolean, default: false },
  fetchPage: { type: Function, required: true },
  loadNextPage: { type: Function, required: true },
  loadSearchResultPage: { type: Function, default: null },
  loadNextSearchResultPage: { type: Function, default: null },
  cancelSearchResultPage: { type: Function, default: null },
  toggleSort: { type: Function, required: true },
  applySort: { type: Function, required: true },
});

const emit = defineEmits([
  "focus-pane",
  "split-pane",
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
]);

const activeDataTab = computed(() => {
  const tab = props.activeTab;
  return tab && (tab.kind || "data") === "data" ? tab : null;
});
const activeDesignTab = computed(() => (props.activeTab?.kind === "design" ? props.activeTab : null));
const activeHomeTab = computed(() => (props.activeTab?.kind === "home" ? props.activeTab : null));
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
  resetGridScroll,
  scrollRowIntoView,
  scrollColumnIntoView,
  scrollCellIntoView,
  scrollInsertCellIntoView,
  visibleRows,
  activeColumnMeta,
} = useVirtualGrid(activeDataTab, props.editState);

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value ?? "")) : String(value ?? "").replace(/["\\]/g, "\\$&");
}

function showSaveReminder({ tabId, rowKey, column, kind, message }) {
  if (activeDataTab.value?.id !== tabId || !gridWrapRef.value) return;
  const cell = gridWrapRef.value.querySelector(`td[data-row-key="${cssEscape(rowKey)}"][data-column-name="${cssEscape(column)}"]`);
  if (!cell) return;
  const rootRect = gridWrapRef.value.closest(".mysql-workbench")?.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  if (!rootRect || cellRect.bottom < rootRect.top || cellRect.top > rootRect.bottom) return;
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
  activeColumns,
  isInsertRowVisible,
  getInsertRowKey,
  getInsertRows,
  getVisibleInsertRows,
  insertAwareVisualRowIndex,
  clearSelection,
  selectCell,
  startRangeSelection,
  extendRangeSelection,
  extendRangeSelectionFromPointer,
  finishRangeSelection,
  startEditing,
  finishEditing,
  cancelEditing,
  navigateCell,
  selectInsertCell,
  insertDraftAbove,
  selectInsertRow,
  handleInsertKeydown,
  saveTextPanel,
  commitDetailDraft,
  commitInsertRows,
  handleGridKeydown,
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

const {
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
} = useRowSelection(props.invokeWorkbench, { statusText }, { fetchPage: refreshTabPage });

function selectCellAt(tab, rowIndex, columnIndex) {
  const row = tabRowAt(tab, rowIndex);
  const column = tab?.columns?.[columnIndex];
  if (!row || !column) return;
  clearRowSelection(tab);
  clearSelection();
  selectCell(tab, row, columnName(column), rowIndex, columnIndex, { focusGrid: false });
  scrollCellIntoView(rowIndex, columnIndex);
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

onBeforeUnmount(() => {
  void disposeTableSearch();
});

const { handleUndoKeydown, handleRedoKeydown } = useUndo(props.editState, props.invokeWorkbench, activeDataTab, { statusText });

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
}

function highlightCell(tab, row, column, rowKey) {
  return highlightCellResult(props.editState, tab, row, column, rowKey);
}

function selectedGridRowIndexes(tab) {
  if (!tab?.selectedRowKeys?.size) return [];
  return createRowIndex(tab, { buildRowKey }).keys()
    .map((rowKey, index) => (tab.selectedRowKeys.has(rowKey) ? index : -1))
    .filter((index) => index >= 0);
}

function exitRowSelectionToCell(tab) {
  const indexes = selectedGridRowIndexes(tab);
  const rowIndex = indexes[0];
  const row = tabRowAt(tab, rowIndex);
  const columnIndex = 0;
  const column = activeColumns.value[columnIndex];
  const col = columnName(column);
  if (!row || !col) return false;
  clearRowSelection(tab);
  clearSelection();
  selectCell(tab, row, col, rowIndex, columnIndex);
  scrollCellIntoView(rowIndex, columnIndex);
  return true;
}

function selectGridCell(...args) {
  focusPane();
  clearRowSelection(activeDataTab.value);
  selectCell(...args);
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
  clearSelection();
  toggleRowSelect(tab, row, event);
  gridWrapRef.value?.focus();
}

function startGridRowDragSelection(tab, row, rowIndex, event, wrap) {
  focusPane();
  clearSelection();
  startRowDragSelection(tab, row, event, wrap);
  gridWrapRef.value?.focus();
}

function extendGridRowDragSelection(tab, event) {
  extendRowDragSelectionFromPointer(tab, event);
}

function toggleAllGridRows(tab) {
  focusPane();
  clearSelection();
  toggleAllRows(tab);
  gridWrapRef.value?.focus();
}

function selectGridInsertRow(tab, rowId) {
  focusPane();
  clearRowSelection(tab);
  selectInsertRow(tab, rowId);
  gridWrapRef.value?.focus();
}

async function handleGridKeydownWithRows(event) {
  focusPane();
  const tab = activeDataTab.value;
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
      if (targetIndex != null) scrollRowIntoView(targetIndex);
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

function nonEmptyInsertDrafts(tab) {
  return getInsertRows(tab)
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

async function prepareInsertDraftsForRefresh(tab) {
  const insertRows = getInsertRows(tab);
  if (insertRows.length === 0) return true;
  const drafts = nonEmptyInsertDrafts(tab);
  if (drafts.length === 0) {
    clearInsertDraftsAfterRefresh(tab);
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
  const result = await commitInsertRows(tab);
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

function maybeLoadMoreRows(target) {
  const tab = activeDataTab.value;
  if (!tab || !target || tab.loadingMore || tab.fullyLoaded) return;
  const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
  if (remaining < GRID_ROW_HEIGHT * 20) props.loadNextPage(tab);
}

function scheduleLoadMoreRows(event) {
  const target = event?.target;
  if (!target) return;
  pendingLoadMoreTarget = target;
  if (loadMoreFrame) return;
  loadMoreFrame = requestAnimationFrame(() => {
    const target = pendingLoadMoreTarget;
    pendingLoadMoreTarget = null;
    loadMoreFrame = 0;
    maybeLoadMoreRows(target);
  });
}

function activateTab(tabId) {
  const shouldResetGrid = shouldResetGridForTabActivation(props.pane.activeTabId, tabId);
  focusPane();
  if (shouldResetGrid) resetGridState();
  emit("activate-tab", props.pane.id, tabId);
}

function closeTab(tabId) {
  focusPane();
  resetGridState();
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
  const selectedRowCount = tab?.selectedRowKeys?.size || 0;
  emit("row-contextmenu", event, tab, row, originalIndex,
    { insertDraftAbove, deleteRow: deleteGridRow, selectedRowCount });
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
  textDraft.value = String(value ?? "");
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
  return runGridClipboardShortcut("v");
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
    focusCurrentSearch,
    clearSelection,
    resetGridScroll,
    selectCellAt,
    scrollColumnIntoView,
    focusTableSearch,
    runTableSearch,
    refreshCurrentSearchMatches,
    activeSearchQuery: activeSearchQuery.value,
    searchMatchCount: searchMatches.value.length,
    hasSearchMatches: hasSearchMatches.value,
    schemaSearchMatches: schemaSearchMatches.value,
    schemaSearchIndex: schemaSearchIndex.value,
    schemaSearchQuery: activeDataTab.value?.schemaSearchQuery || "",
    insertDraftAbove,
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

    <header class="wb-pane-tabbar" :class="{ 'is-focused-pane': isFocused }" data-tauri-drag-region>
      <WorkbenchTabs
        :tabs="tabs"
        :active-tab-id="pane.activeTabId"
        :pane-id="pane.id"
        @activate-tab="activateTab"
        @close-tab="closeTab"
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
      @keydown="handleGridKeydownWithRows"
      @cell-click="selectGridCell"
      @cell-mousedown="startGridRangeSelection"
      @cell-enter="extendRangeSelection"
      @range-pointer="extendRangeSelectionFromPointer"
      @range-end="finishRangeSelection"
      @cell-dblclick="startEditing"
      @cell-blur="finishEditing"
      @edit-input="editDraft = $event; textDraft = $event"
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
      @export="triggerExport"
      @import="triggerImport"
      @batch-export="batchExportFromMenu"
      @batch-import="batchImportFromMenu"
      @split-pane="splitPaneFromToolbar"
      @select-column="editor.selectColumn"
      @contextmenu="openTableContextMenu"
      @row-contextmenu="openRowContextMenu"
      @retry-load="retryGridLoad"
    />

    <CellDetailPanel
      v-if="activeDataTab"
      :selected-cell="selectedCell"
      :text-draft="textDraft"
      :read-only="activeDataReadOnly"
      @update:text-draft="textDraft = $event"
      @save-text-panel="saveTextPanel"
      @commit-detail-draft="commitDetailDraft"
      @detail-contextmenu="openDetailContextMenu"
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
