<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import {
  applyTableSchemaToDataTab,
  buildSchemaSearchResults,
  closeAllTableTabs,
  closeDatabaseTabs,
  closeTableTab,
  createWorkspaceState,
  findTableDataTabs,
  getActiveTab,
  markTableDataTabSchemaStale,
  moveTableTab,
  openTableDesignTab,
} from "./workspaceState.js";
import {
  beginValueSearch,
  clearValueSearchResults,
  createSidebarSearchState,
  failValueSearch,
  finishValueSearch,
  normalizeSidebarSearchQuery,
  setSidebarSearchQuery,
} from "./sidebarSearchState.js";
import {
  createEditState,
  clearCellErrorsForTable,
  isCellPending,
  getCellError,
} from "./editState.js";
import { invokeWorkbench } from "./utils/tauriBridge.js";
import { GRID_ROW_HEIGHT } from "./constants.js";
import {
  buildWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  loadWorkspaceSnapshot,
} from "./utils/workspacePersistence.js";
import {
  normalizeTableName,
  normalizeTableComment,
  columnName,
} from "./utils/normalize.js";
import { highlightCell as _highlightCell } from "./utils/cellDisplay.js";
import { buildRowKey } from "./utils/rowIdentity.js";
import { markPerf, sampleNextFrame } from "./utils/performanceMarks.js";

import WorkbenchSidebar from "./components/WorkbenchSidebar.vue";
import WorkbenchTabs from "./components/WorkbenchTabs.vue";
import DataGrid from "./components/DataGrid.vue";
import TableDesignEditor from "./components/TableDesignEditor.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import PaneDivider from "./components/PaneDivider.vue";
import ContextMenu from "./components/ContextMenu.vue";
import DatabaseSyncDialog from "./components/DatabaseSyncDialog.vue";
import ImportWizardDialog from "./components/ImportWizardDialog.vue";
import ConnectionDialog from "./components/ConnectionDialog.vue";
import SelectedCellIdentity from "./components/SelectedCellIdentity.vue";
import UpdateDialog from "./components/UpdateDialog.vue";

import { useConnection } from "./composables/useConnection.js";
import { useTableSession } from "./composables/useTableSession.js";
import { useTableSearch } from "./composables/useTableSearch.js";
import { useVirtualGrid } from "./composables/useVirtualGrid.js";
import { useGridEditor } from "./composables/useGridEditor.js";
import { useRowSelection } from "./composables/useRowSelection.js";
import { useContextMenu } from "./composables/useContextMenu.js";
import { useDatabaseSync } from "./composables/useDatabaseSync.js";
import { useImportWizard } from "./composables/useImportWizard.js";
import { useExport } from "./composables/useExport.js";
import { useUndo } from "./composables/useUndo.js";
import { usePaneResize } from "./composables/usePaneResize.js";
import { useTheme } from "./composables/useTheme.js";
import { useUpdater } from "./composables/useUpdater.js";

markPerf("workbench.module-loaded");

// ── Shared state ──────────────────────────────────────────────────────────
const workspace = reactive(createWorkspaceState());
const editState = reactive(createEditState());
const sidebarSearch = reactive(createSidebarSearchState());
const treeQuery = computed({
  get: () => sidebarSearch.query,
  set: (value) => setSidebarSearchQuery(sidebarSearch, value),
});
const tabContextMenu = reactive({ open: false, x: 0, y: 0 });
const saveReminders = ref([]);
let nextSaveReminderId = 1;

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value ?? "")) : String(value ?? "").replace(/["\\]/g, "\\$&");
}

// ── Composables ───────────────────────────────────────────────────────────
const conn = useConnection(workspace, invokeWorkbench);
const {
  connections,
  databases,
  selectedConnectionId,
  selectedDatabase,
  connDialog,
  busy,
  statusText,
  loadConnections,
  selectConnection,
  selectDatabase,
  reorderConnections,
  reorderDatabases,
  loadTables,
  ensureTableSchema,
  openConnDialog,
  cancelConnDialog,
  submitConnDialog,
} = conn;

watch(
  () => [selectedConnectionId.value, selectedDatabase.value],
  () => {
    clearValueSearchResults(sidebarSearch);
    sidebarSearch.valueSearchToken += 1;
  },
  { deep: false },
);

const { openTable, fetchPage, loadNextPage, toggleSort } = useTableSession(
  workspace,
  invokeWorkbench,
  { busy: conn.busy, statusText: conn.statusText },
);

const activeTab = computed(() => getActiveTab(workspace));
const activeDataTab = computed(() => {
  const tab = activeTab.value;
  return tab && (tab.kind || "data") === "data" ? tab : null;
});
const activeDesignTab = computed(() => {
  const tab = activeTab.value;
  return tab?.kind === "design" ? tab : null;
});
const schemaSearchSource = computed(() =>
  workspace.schema.map((table) => ({
    tableName: normalizeTableName(table),
    tableComment: normalizeTableComment(table),
    columns: table.columns || [],
    raw: {
      ...table,
      connectionId: selectedConnectionId.value,
      database: selectedDatabase.value,
    },
  })),
);
const schemaSearchResults = computed(() =>
  buildSchemaSearchResults(schemaSearchSource.value, treeQuery.value),
);
const filteredTables = computed(() => schemaSearchResults.value.map((result) => result.table));

const {
  gridWrapRef,
  virtualRange,
  onGridScroll,
  scrollRowIntoView,
  scrollColumnIntoView,
  scrollCellIntoView,
  scrollInsertCellIntoView,
  visibleRows,
} = useVirtualGrid(activeDataTab, editState);

const editor = useGridEditor(
  editState,
  invokeWorkbench,
  activeDataTab,
  gridWrapRef,
  { scrollRowIntoView, scrollCellIntoView, scrollInsertCellIntoView },
  { busy: conn.busy, statusText: conn.statusText, onSaveFeedback: showSaveReminder },
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
  insertDrafts,
  activeColumns,
  isInsertRowVisible,
  getInsertRows,
  hasInsertDrafts,
  clearSelection,
  focusTextCell,
  selectCell,
  startRangeSelection,
  extendRangeSelection,
  extendRangeSelectionFromPointer,
  finishRangeSelection,
  isCellInSelectedRange,
  getCellRangeClasses,
  startEditing,
  finishEditing,
  cancelEditing,
  navigateCell,
  selectInsertCell,
  selectInsertRow,
  handleInsertKeydown,
  commitCellValue,
  saveTextPanel,
  commitInsertRows,
  handleGridKeydown,
  getInsertDraft,
  updateInsertDraft,
  clearInsertDraft,
  pasteIntoInsertInput,
} = editor;

const {
  clearRowSelection,
  toggleRowSelect,
  toggleAllRows,
  moveRowSelection,
  startRowDragSelection,
  extendRowDragSelection,
  finishRowDragSelection,
  consumeRowDragClickSuppression,
  deleteSelectedRows,
  deleteRow,
} =
  useRowSelection(invokeWorkbench, { statusText: conn.statusText }, { fetchPage: refreshTabPage });

const {
  contextMenu,
  contextMenuStyle,
  openContextMenu,
  closeContextMenu,
  refreshFromContextMenu,
  openDesignFromContextMenu,
} = useContextMenu(
  { statusText: conn.statusText },
  { loadTables: conn.loadTables, ensureTableSchema: conn.ensureTableSchema, fetchPage: refreshTabPage },
  activeDataTab,
  { openTableDesign, onTablePageRefreshed: clearTabCellErrors },
);

async function listenWorkbenchEvent(eventName, handler) {
  if (!globalThis.__TAURI_INTERNALS__) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen(eventName, handler);
}

const databaseSync = useDatabaseSync({
  connections,
  databases,
  invokeWorkbench,
  listen: listenWorkbenchEvent,
});

const {
  importWizard,
  importInput,
  triggerImport,
  onImportFileSelected,
  parseImportSheet,
  goToImportStep,
  executeImport,
  closeImportWizard,
} = useImportWizard(invokeWorkbench, activeDataTab, { fetchPage: refreshTabPage }, { statusText: conn.statusText });

const { exportTable } = useExport(invokeWorkbench, { statusText: conn.statusText });

const { handleUndoKeydown } = useUndo(editState, invokeWorkbench, activeDataTab, {
  statusText: conn.statusText,
});

const {
  workspaceRef: paneWorkspaceRef,
  isDragging: paneIsDragging,
  sidebarWidth,
  inspectorWidth,
  sidebarCollapsed,
  inspectorCollapsed,
  sidebarStyle,
  inspectorStyle,
  onDividerMouseDown,
  toggleSidebar,
  toggleInspector,
} = usePaneResize();

const { effectiveTheme, isDark, toggleTheme } = useTheme();
const updater = useUpdater();
const isStatusError = computed(() => /失败|错误|不能|冲突|重复/.test(statusText.value || ""));

const workbenchStyle = computed(() => ({
  "--wb-sidebar-width": sidebarCollapsed.value ? "0px" : `${sidebarWidth.value}px`,
}));

function showSaveReminder({ tabId, rowKey, column, kind, message }) {
  if (activeDataTab.value?.id !== tabId || !gridWrapRef.value) return;
  const cell = gridWrapRef.value.querySelector(`td[data-row-key="${cssEscape(rowKey)}"][data-column-name="${cssEscape(column)}"]`);
  if (!cell) return;
  const rootRect = gridWrapRef.value.closest(".mysql-workbench")?.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  if (!rootRect || cellRect.bottom < rootRect.top || cellRect.top > rootRect.bottom) return;
  const id = nextSaveReminderId++;
  saveReminders.value = [
    ...saveReminders.value.slice(-4),
    {
      id,
      kind,
      message,
      x: Math.min(cellRect.right - rootRect.left - 12, rootRect.width - 92),
      y: Math.max(36, cellRect.top - rootRect.top - 8),
    },
  ];
  globalThis.setTimeout?.(() => {
    saveReminders.value = saveReminders.value.filter((reminder) => reminder.id !== id);
  }, 1300);
}

async function withCurrentWindow(action) {
  if (!globalThis.__TAURI_INTERNALS__) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await action(getCurrentWindow());
  } catch (error) {
    statusText.value = `窗口操作失败：${String(error)}`;
  }
}

function startWindowDrag(event) {
  if (event?.button !== 0 || event?.target?.closest?.(".wb-titlebar-controls, .wb-update-button")) return;
  withCurrentWindow((window) => window.startDragging());
}

function minimizeWindow() {
  withCurrentWindow((window) => window.minimize());
}

function toggleMaximizeWindow() {
  withCurrentWindow(async (window) => {
    if (await window.isMaximized()) await window.unmaximize();
    else await window.maximize();
  });
}

function closeWindow() {
  withCurrentWindow((window) => window.close());
}

function openUpdateDialog() {
  updater.openDialog();
  if (updater.status.value === "idle" || updater.status.value === "current" || updater.status.value === "error" || updater.status.value === "unavailable") {
    void updater.checkForUpdates({ openOnError: true });
  }
}

// ── Local helpers ─────────────────────────────────────────────────────────
const totalPages = computed(() => {
  const tab = activeDataTab.value;
  if (!tab) return 1;
  return Math.max(1, Math.ceil(tab.totalRows / tab.pageSize));
});

function rowCountLabel(totalRows) {
  const count = Number(totalRows);
  return `${Number.isFinite(count) ? count.toLocaleString("zh-CN") : "0"} 行`;
}

const activeStatusLabel = computed(() => (
  activeDataTab.value ? rowCountLabel(activeDataTab.value.totalRows) : activeDesignTab.value ? "表设计" : ""
));

function highlightCell(tab, row, column, rowKey) {
  return _highlightCell(editState, tab, row, column, rowKey);
}

function setGridWrapElement(element) {
  gridWrapRef.value = element;
}

function resetGridScroll() {
  if (!gridWrapRef.value) return;
  gridWrapRef.value.scrollTop = 0;
  gridWrapRef.value.scrollLeft = 0;
}

function resetGridState() {
  clearSelection();
  resetGridScroll();
}

function tabErrorScopeKey(tab) {
  return tab?.tableKey || tab?.tableName || "";
}

function clearTabCellErrors(tab) {
  clearCellErrorsForTable(editState, tabErrorScopeKey(tab));
}

async function refreshTabPage(tab, page) {
  const result = await fetchPage(tab, page);
  if (result?.ok) clearTabCellErrors(tab);
  return result;
}

async function runSidebarValueSearch() {
  const query = normalizeSidebarSearchQuery(treeQuery.value);
  if (!query) return;
  const searchConnectionId = selectedConnectionId.value;
  const searchDatabase = selectedDatabase.value;
  const sourceStillSelected = () =>
    selectedConnectionId.value === searchConnectionId &&
    selectedDatabase.value === searchDatabase;

  if (!searchDatabase) {
    sidebarSearch.valueError = "请先选择数据库";
    statusText.value = "请先选择数据库";
    return;
  }

  const token = beginValueSearch(sidebarSearch, query);
  statusText.value = "搜索值...";
  try {
    const results = await invokeWorkbench("search_values", {
      request: {
        connectionId: selectedConnectionId.value,
        database: selectedDatabase.value,
        query,
        limit: 50,
      },
    });
    const sourcedResults = Array.isArray(results)
      ? results.map((result) => ({
          ...result,
          connectionId: searchConnectionId,
          database: searchDatabase,
        }))
      : results;
    if (!sourceStillSelected()) return;
    if (finishValueSearch(sidebarSearch, query, sourcedResults, token)) {
      statusText.value = `值命中 ${sidebarSearch.valueResults.length} 张表`;
    }
  } catch (error) {
    if (!sourceStillSelected()) return;
    if (failValueSearch(sidebarSearch, query, String(error), token)) {
      statusText.value = `值搜索失败：${String(error)}`;
    }
  }
}

async function openSidebarSchemaResult(result) {
  const table = result?.table?.raw || result?.table;
  if (!table) return;
  resetGridState();
  const tab = await openTable(table);
  const firstColumn = result.visibleColumns?.[0] || result.matchedColumns?.[0];
  const targetColumn = columnName(firstColumn);
  if (!tab || !targetColumn) return;
  await nextTick();
  const columnIndex = (tab.columns || []).findIndex((column) => columnName(column) === targetColumn);
  if (columnIndex >= 0) scrollColumnIntoView(columnIndex, "th");
}

async function openSidebarValueResult(result) {
  if (!result?.tableName) return;
  const query = normalizeSidebarSearchQuery(sidebarSearch.valueSearchedQuery || treeQuery.value);
  resetGridState();
  const tab = await openTable({
    tableName: result.tableName,
    tableComment: result.tableComment || "",
    connectionId: result.connectionId || selectedConnectionId.value,
    database: result.database || selectedDatabase.value,
  });
  if (!tab || !query) return;
  tab.filter = query;
  tab.searchQuery = query;
  await nextTick();
  await runTableSearch(query);
}

async function activateTab(tabId) {
  const tab = workspace.tabs.find((t) => t.id === tabId);
  if (tab) {
    if (tab.connectionId && tab.connectionId !== selectedConnectionId.value) {
      await selectConnection(tab.connectionId);
    }
    if (tab.database && tab.database !== selectedDatabase.value) {
      await selectDatabase({ connectionId: tab.connectionId, database: tab.database });
    }
  }
  workspace.activeTabId = tabId;
  resetGridState();
}

function closeTab(tabId) {
  const tab = workspace.tabs.find((item) => item.id === tabId);
  clearTabCellErrors(tab);
  resetGridState();
  closeTableTab(workspace, tabId);
}

function reorderTab(sourceId, targetId, options) {
  moveTableTab(workspace, sourceId, targetId, options);
}

function openTabContextMenu({ x, y }) {
  if (workspace.tabs.length === 0) return;
  closeContextMenu();
  tabContextMenu.open = true;
  tabContextMenu.x = x;
  tabContextMenu.y = y;
}

function closeTabContextMenu() {
  tabContextMenu.open = false;
}

function closeAllTabsFromMenu() {
  closeTabContextMenu();
  resetGridState();
  workspace.tabs.forEach(clearTabCellErrors);
  closeAllTableTabs(workspace);
}

function closeAllContextMenus() {
  closeContextMenu();
  closeTabContextMenu();
}

function openDatabaseSync(target) {
  closeContextMenu();
  closeTabContextMenu();
  databaseSync.open(target);
}

async function executeDatabaseSync() {
  const target = {
    connectionId: databaseSync.dialog.connectionId,
    database: databaseSync.dialog.targetDatabase,
  };
  await databaseSync.execute();
  if (databaseSync.dialog.status !== "succeeded") return;
  resetGridState();
  closeDatabaseTabs(workspace, target);
  if (selectedConnectionId.value === target.connectionId && selectedDatabase.value === target.database) {
    await loadTables(target);
  }
}

async function openTableFromSidebar(table) {
  resetGridState();
  await openTable(table);
}

function openTableDesign(tableLike = null) {
  const source = tableLike || activeDataTab.value;
  const fallback = activeDataTab.value;
  const tableName = normalizeTableName(source) || fallback?.tableName || "";
  if (!tableName) return null;
  const connectionId = String(source?.connectionId || source?.connection_id || fallback?.connectionId || "");
  const database = String(source?.database || fallback?.database || "");
  const tableComment = normalizeTableComment(source) || fallback?.tableComment || "";
  const tab = openTableDesignTab(workspace, { connectionId, database, tableName, tableComment });
  if (tab) statusText.value = `已打开表设计：${tableName}`;
  return tab;
}

function designAppliedSource(event = {}) {
  const schema = event.schema || event.result?.schema || event.result || {};
  const source = event.source || {};
  const fallback = activeDesignTab.value || {};
  const tableName = normalizeTableName(schema) || source.tableName || source.table_name || fallback.tableName || "";
  const connectionId = String(source.connectionId || source.connection_id || fallback.connectionId || "");
  const database = String(source.database || fallback.database || "");
  return {
    connectionId,
    database,
    tableName,
    tableKey: source.tableKey || fallback.tableKey,
  };
}

async function handleTableDesignApplied(event = {}) {
  const source = designAppliedSource(event);
  const { connectionId, database, tableName } = source;
  if (!tableName) {
    statusText.value = "表设计已保存";
    return;
  }
  const appliedSchema = event.schema || event.result?.schema || event.result || null;
  const affectedTabs = findTableDataTabs(workspace, source);
  try {
    const refreshedSchema = await ensureTableSchema(tableName, { connectionId, database });
    const schema = refreshedSchema || appliedSchema;
    const refreshErrors = [];
    for (const tab of affectedTabs) {
      applyTableSchemaToDataTab(tab, schema);
      const refreshResult = await refreshTabPage(tab, 1);
      if (!refreshResult?.ok && !refreshResult?.stale) {
        markTableDataTabSchemaStale(tab, schema);
        refreshErrors.push(refreshResult?.error || new Error("table data refresh failed"));
      }
    }
    if (refreshErrors.length > 0) {
      statusText.value = `表设计已保存，刷新失败，请重新打开或刷新表：${String(refreshErrors[0])}`;
      return;
    }
    statusText.value = `表设计已保存：${tableName}`;
  } catch (error) {
    statusText.value = `表设计已保存，刷新失败，请重新打开或刷新表：${String(error)}`;
  }
}

function openSidebarContextMenu(event, table) {
  closeTabContextMenu();
  openContextMenu(event, table);
}

function openGeneralContextMenu(event) {
  closeTabContextMenu();
  openContextMenu(event);
}

function openActiveTableContextMenu(event) {
  closeTabContextMenu();
  openContextMenu(event, activeDataTab.value);
}

function selectGridCell(...args) {
  clearRowSelection(activeDataTab.value);
  selectCell(...args);
}

function startGridRangeSelection(...args) {
  clearRowSelection(activeDataTab.value);
  startRangeSelection(...args);
}

function selectGridRow(tab, row, event) {
  if (consumeRowDragClickSuppression()) {
    gridWrapRef.value?.focus();
    return;
  }
  clearSelection();
  toggleRowSelect(tab, row, event);
  gridWrapRef.value?.focus();
}

function startGridRowDragSelection(tab, row, rowIndex, event) {
  clearSelection();
  startRowDragSelection(tab, row, event);
  gridWrapRef.value?.focus();
}

function extendGridRowDragSelection(tab, row) {
  extendRowDragSelection(tab, row);
}

function finishGridRowDragSelection() {
  finishRowDragSelection();
}

function toggleAllGridRows(tab) {
  clearSelection();
  toggleAllRows(tab);
  gridWrapRef.value?.focus();
}

function selectGridInsertRow(tab, rowId) {
  clearRowSelection(tab);
  selectInsertRow(tab, rowId);
  gridWrapRef.value?.focus();
}

function selectedGridRowIndexes(tab) {
  if (!tab?.selectedRowKeys?.size) return [];
  return tab.rows
    .map((row, index) => (tab.selectedRowKeys.has(buildRowKey(tab, row)) ? index : -1))
    .filter((index) => index >= 0);
}

function exitRowSelectionToCell(tab) {
  const indexes = selectedGridRowIndexes(tab);
  const rowIndex = indexes[0];
  const row = tab?.rows?.[rowIndex];
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

function selectCellAt(tab, rowIndex, columnIndex) {
  const row = tab?.rows?.[rowIndex];
  const column = tab?.columns?.[columnIndex];
  if (!row || !column) return;
  clearRowSelection(tab);
  clearSelection();
  selectCell(tab, row, columnName(column), rowIndex, columnIndex, { focusGrid: false });
  scrollCellIntoView(rowIndex, columnIndex);
}

const {
  searchInputRef,
  runTableSearch,
  handleTableFindKeydown,
  hasSearchMatches,
  goToNextSearchMatch,
  goToPreviousSearchMatch,
} = useTableSearch(activeDataTab, {
  editState,
  loadNextPage,
  selectCellAt,
  statusText: conn.statusText,
});

function setSearchInputElement(element) {
  searchInputRef.value = element;
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
  event.preventDefault();
  event.stopPropagation();
  openTableDesign(activeDataTab.value);
  return true;
}

function handleWorkbenchKeydown(event) {
  if (handleTableFindKeydown(event)) return;
  if (handleOpenDesignKeydown(event)) return;
  handleUndoKeydown(event);
}

async function handleGridKeydownWithRows(event) {
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
    deleteSelectedRows(tab);
    return;
  }
  const result = await handleGridKeydown(event);
  if (result?.insertedRows > 0 && tab) {
    await refreshTabPage(tab, tab.page || 1);
  }
}

function matchesInsertedDraft(row, draft) {
  const entries = Object.entries(draft).filter(([, value]) => String(value ?? "").trim() !== "");
  return entries.length > 0 && entries.every(([column, value]) => String(row?.[column] ?? "") === String(value ?? ""));
}

function selectVisibleInsertedRow(tab, draft) {
  if (!tab?.rows?.length) return false;
  const rowIndex = tab.rows.findLastIndex((row) => matchesInsertedDraft(row, draft));
  if (rowIndex < 0) return false;
  const rowKey = buildRowKey(tab, tab.rows[rowIndex]);
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

async function commitInsertRowsAndRefresh(tab) {
  const drafts = nonEmptyInsertDrafts(tab);
  const result = await commitInsertRows(tab);
  if (result?.insertedRows > 0) {
    await refreshTabPage(tab, tab.page || 1);
  }
  if (result?.failedRowId) return;
  const lastDraft = drafts[Math.max(0, result.insertedRows - 1)]?.draft;
  if (lastDraft && selectVisibleInsertedRow(tab, lastDraft)) return;
  gridWrapRef.value?.focus();
}

let autoSaveInsertPromise = null;

function maybeAutoSaveInsertDrafts(event) {
  const tab = activeDataTab.value;
  if (!tab || !hasInsertDrafts(tab)) return;
  if (event?.target?.closest?.(".wb-insert-row")) return;
  if (autoSaveInsertPromise) return;
  autoSaveInsertPromise = commitInsertRowsAndRefresh(tab).finally(() => {
    autoSaveInsertPromise = null;
  });
}

function sortPage(tab, col) {
  resetGridState();
  toggleSort(tab, col);
}

function maybeLoadMoreRows(event) {
  const tab = activeDataTab.value;
  const target = event?.target;
  if (!tab || !target || tab.loadingMore || tab.fullyLoaded) return;
  const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
  if (remaining < GRID_ROW_HEIGHT * 20) loadNextPage(tab);
}

const dataGridRef = ref(null);

// ── Persistence ────────────────────────────────────────────────────────────
let persistenceReady = false;

function persistWorkspace() {
  if (!persistenceReady) return;
  saveWorkspaceSnapshot(
    buildWorkspaceSnapshot({
      connectionId: selectedConnectionId.value,
      database: selectedDatabase.value,
      tabs: workspace.tabs,
      activeTabId: workspace.activeTabId,
    }),
  );
}

watch(
  () => [selectedConnectionId.value, selectedDatabase.value, workspace.tabs.length, workspace.activeTabId],
  () => persistWorkspace(),
  { deep: false },
);

async function restoreSavedTabs() {
  const snapshot = loadWorkspaceSnapshot();
  if (!snapshot?.tabs?.length) return;

  const currentConnectionId = selectedConnectionId.value;
  const currentDatabase = selectedDatabase.value;
  const availableTableNames = new Set(
    workspace.schema.map((table) => normalizeTableName(table)),
  );

  // Find the saved active tab by kind/tableName/database to match after IDs change.
  let activeTabKey = null;
  if (snapshot.activeTabId) {
    const activeSaved = snapshot.tabs.find((t) => t.id === snapshot.activeTabId);
    if (activeSaved) activeTabKey = `${activeSaved.kind || "data"}${activeSaved.tableName}`;
  }

  for (const savedTab of snapshot.tabs) {
    if (savedTab.connectionId && savedTab.connectionId !== currentConnectionId) continue;
    if (savedTab.database && savedTab.database !== currentDatabase) continue;
    if (!availableTableNames.has(savedTab.tableName)) continue;

    const tableMeta = workspace.schema.find(
      (table) => normalizeTableName(table) === savedTab.tableName,
    );
    const tableForOpen = {
      ...(tableMeta || {}),
      tableName: savedTab.tableName,
      tableComment: savedTab.tableComment || "",
      connectionId: currentConnectionId,
      database: currentDatabase,
    };
    if (savedTab.kind === "design") {
      openTableDesignTab(workspace, tableForOpen, { activate: false });
    } else {
      await openTable(tableForOpen, { activate: false });
    }
    const restoredTab = workspace.tabs.find(
      (tab) =>
        (tab.kind || "data") === (savedTab.kind || "data") &&
        tab.connectionId === currentConnectionId &&
        tab.database === currentDatabase &&
        tab.tableName === savedTab.tableName,
    );
    if (restoredTab) {
      if (savedTab.filter) restoredTab.filter = savedTab.filter;
      if (savedTab.filterMode) restoredTab.filterMode = savedTab.filterMode;
      if (savedTab.sort) restoredTab.sort = savedTab.sort;
    }
  }

  // Restore the originally active tab by kind/table name (tab IDs are regenerated on each session).
  if (activeTabKey) {
    const targetTab = workspace.tabs.find((t) => `${t.kind || "data"}${t.tableName}` === activeTabKey);
    if (targetTab) workspace.activeTabId = targetTab.id;
  }
  if (!workspace.activeTabId && workspace.tabs[0]) {
    workspace.activeTabId = workspace.tabs[0].id;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
onMounted(async () => {
  markPerf("workbench.mounted");
  try {
    await conn.loadConnections();
    markPerf("workbench.connections-ready", { connections: connections.value.length, databases: databases.value.length });
    await restoreSavedTabs();
    markPerf("workbench.tabs-restored", { tabs: workspace.tabs.length });
    sampleNextFrame("workbench.first-usable-frame", { tabs: workspace.tabs.length, tables: workspace.tables.length });
  } catch (e) {
    conn.statusText.value = `初始化失败：${String(e)}`;
  }
  persistenceReady = true;
  persistWorkspace();
  void updater.checkForUpdates();
});

onBeforeUnmount(() => {
  databaseSync.dispose();
});
</script>

<template>
  <main
    class="mysql-workbench"
    :data-theme="effectiveTheme"
    :style="workbenchStyle"
    @pointerdown.capture="maybeAutoSaveInsertDrafts"
    @click="closeAllContextMenus"
    @keydown="handleWorkbenchKeydown"
    @contextmenu.prevent="openGeneralContextMenu"
  >
    <div class="wb-save-reminder-layer" aria-hidden="true">
      <span
        v-for="reminder in saveReminders"
        :key="reminder.id"
        class="wb-save-reminder"
        :class="`is-${reminder.kind}`"
        :style="{ left: `${reminder.x}px`, top: `${reminder.y}px` }"
      >{{ reminder.message }}</span>
    </div>

    <header
      class="wb-titlebar"
      data-tauri-drag-region
      @pointerdown="startWindowDrag"
      @dblclick="toggleMaximizeWindow"
    >
      <button
        type="button"
        class="wb-update-button"
        :class="{
          'is-checking': updater.status.value === 'checking',
          'is-available': updater.status.value === 'available',
          'is-error': updater.status.value === 'error' || updater.status.value === 'unavailable',
        }"
        :title="updater.title.value"
        :aria-label="updater.title.value"
        @click.stop="openUpdateDialog"
      >
        <span class="wb-update-dot" aria-hidden="true"></span>
        <span v-if="updater.status.value === 'available'" class="wb-update-label">{{ updater.availableUpdate.value?.version }}</span>
      </button>
      <div class="wb-titlebar-controls" aria-label="窗口控制">
        <button
          type="button"
          class="wb-titlebar-button"
          aria-label="最小化窗口"
          title="最小化"
          @click.stop="minimizeWindow"
        >
          <span class="wb-window-icon is-minimize" aria-hidden="true"></span>
        </button>
        <button
          type="button"
          class="wb-titlebar-button"
          aria-label="最大化或还原窗口"
          title="最大化或还原"
          @click.stop="toggleMaximizeWindow"
        >
          <span class="wb-window-icon is-maximize" aria-hidden="true"></span>
        </button>
        <button
          type="button"
          class="wb-titlebar-button is-close"
          aria-label="关闭窗口"
          title="关闭"
          @click.stop="closeWindow"
        >
          <span class="wb-window-icon is-close" aria-hidden="true"></span>
        </button>
      </div>
    </header>

    <section class="wb-workspace" ref="paneWorkspaceRef" :class="{ 'is-dragging': paneIsDragging }">
      <WorkbenchSidebar
        :style="sidebarStyle"
        :selected-connection-id="selectedConnectionId"
        :selected-database="selectedDatabase"
        :connections="connections"
        :databases="databases"
        :filtered-tables="filteredTables"
        :schema-search-results="schemaSearchResults"
        :sidebar-search-state="sidebarSearch"
        :tree-query="treeQuery"
        :active-tab="activeTab"
        @update:tree-query="treeQuery = $event"
        @search-values="runSidebarValueSearch"
        @open-schema-result="openSidebarSchemaResult"
        @open-value-result="openSidebarValueResult"
        @select-connection="selectConnection($event)"
        @select-database="selectDatabase($event)"
        @reorder-connections="reorderConnections"
        @reorder-databases="reorderDatabases"
        @open-table="openTableFromSidebar"
        @open-connection="openConnDialog"
        @contextmenu="openSidebarContextMenu"
      />

      <PaneDivider
        side="left"
        :collapsed="sidebarCollapsed"
        @drag-start="onDividerMouseDown($event, 'sidebar')"
        @toggle="toggleSidebar()"
      />

      <section class="wb-main">
        <WorkbenchTabs
          :tabs="workspace.tabs"
          :active-tab-id="workspace.activeTabId"
          @activate-tab="activateTab"
          @close-tab="closeTab"
          @reorder-tab="reorderTab"
          @tab-contextmenu="openTabContextMenu"
        />

        <DataGrid
          v-if="activeDataTab"
          ref="dataGridRef"
          :tab="activeDataTab"
          :active-columns="activeColumns"
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
          :get-insert-rows="getInsertRows"
          :get-insert-draft="getInsertDraft"
          :is-insert-row-visible="isInsertRowVisible"
          @grid-ready="setGridWrapElement"
          @search-ready="setSearchInputElement"
          @search-input="runTableSearch"
          @search-previous="goToPreviousSearchMatch"
          @search-next="goToNextSearchMatch"
          @scroll="onGridScroll($event); maybeLoadMoreRows($event)"
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
          @toggle-row-select="selectGridRow"
          @row-select-start="startGridRowDragSelection"
          @row-select-enter="extendGridRowDragSelection"
          @row-select-end="finishGridRowDragSelection"
          @toggle-all-rows="toggleAllGridRows"
          @insert-input="updateInsertDraft"
          @insert-paste="pasteIntoInsertInput"
          @insert-focus="selectInsertCell"
          @insert-keydown="handleInsertKeydown"
          @insert-row-select="selectGridInsertRow"
          @export="exportTable(activeDataTab)"
          @import="triggerImport"
          @contextmenu="openActiveTableContextMenu"
        />

        <TableDesignEditor
          v-else-if="activeDesignTab"
          :source="activeDesignTab"
          :invoke-workbench="invokeWorkbench"
          @applied="handleTableDesignApplied"
        />

        <section v-else class="wb-empty">
          <div class="wb-empty-content">
            <svg class="wb-empty-icon" viewBox="0 0 48 48" aria-hidden="true">
              <rect x="6" y="8" width="36" height="32" rx="3" fill="none" stroke="currentColor" stroke-width="2"/>
              <line x1="6" y1="16" x2="42" y2="16" stroke="currentColor" stroke-width="2"/>
              <line x1="14" y1="24" x2="34" y2="24" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
              <line x1="14" y1="30" x2="28" y2="30" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
            </svg>
            <strong>从左侧打开一张表</strong>
            <span>或使用快捷搜索定位数据</span>
            <button type="button" class="wb-empty-action" @click="openConnDialog">+ 新建连接</button>
          </div>
        </section>
      </section>

      <PaneDivider
        side="right"
        :collapsed="inspectorCollapsed"
        @drag-start="onDividerMouseDown($event, 'inspector')"
        @toggle="toggleInspector()"
      />

      <InspectorPanel
        :style="inspectorStyle"
        :active-tab="activeDataTab"
        :active-columns="activeColumns"
        :selected-cell="selectedCell"
        :text-draft="textDraft"
        @update:text-draft="textDraft = $event"
        @save-text-panel="saveTextPanel"
        @contextmenu="openActiveTableContextMenu"
      />
    </section>

    <footer class="wb-grid-statusbar">
      <section
        v-if="activeTab"
        class="wb-sidebar-status"
        :style="sidebarStyle"
        aria-label="当前表信息"
      >
        <span
          class="wb-sidebar-status-meta"
          :class="{ 'has-comment': activeTab.tableComment }"
        >
          <span
            class="wb-sidebar-status-source"
            :title="`${activeTab.database ? `${activeTab.database}.` : ''}${activeTab.tableName}`"
          >
            {{ activeTab.database ? `${activeTab.database}.` : "" }}{{ activeTab.tableName }}
          </span>
          <span
            v-if="activeTab.tableComment"
            class="wb-sidebar-status-comment"
            :title="activeTab.tableComment"
          >
            {{ activeTab.tableComment }}
          </span>
        </span>
        <strong class="wb-sidebar-status-count">{{ activeStatusLabel }}</strong>
      </section>
      <SelectedCellIdentity
        class="wb-statusbar-cell"
        :tab="activeDataTab"
        :selected-cell="selectedCell"
        :selected-range="selectedRange"
      />
      <section
        class="wb-operation-status"
        :class="{ 'is-error': isStatusError }"
        role="status"
        aria-live="polite"
        :title="statusText"
      >
        {{ statusText }}
      </section>
    </footer>

    <button
      class="wb-theme-toggle"
      type="button"
      :aria-label="isDark ? '切换为浅色模式' : '切换为深色模式'"
      :title="isDark ? '切换为浅色模式' : '切换为深色模式'"
      @click.stop="toggleTheme"
    >
      <svg class="wb-theme-icon" viewBox="0 0 24 24" aria-hidden="true">
        <template v-if="isDark">
          <circle cx="12" cy="12" r="4.15" />
          <path d="M12 2.75v3M12 18.25v3M2.75 12h3M18.25 12h3M5.46 5.46l2.13 2.13M16.41 16.41l2.13 2.13M18.54 5.46l-2.13 2.13M7.59 16.41l-2.13 2.13" />
        </template>
        <path v-else d="M20.2 15.32a8.6 8.6 0 0 1-11.5-11.5 8.63 8.63 0 1 0 11.5 11.5Z" />
      </svg>
    </button>

    <ContextMenu
      :open="contextMenu.open"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :table-scoped="contextMenu.tableScoped"
      :kind="contextMenu.kind"
      :connection-id="contextMenu.connectionId"
      :database="contextMenu.database"
      :table-name="contextMenu.tableName"
      @refresh="refreshFromContextMenu"
      @open-design="openDesignFromContextMenu"
      @sync-database="openDatabaseSync"
    />

    <menu
      v-if="tabContextMenu.open"
      class="wb-context-menu wb-tab-context-menu"
      :style="{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }"
      @click.stop
    >
      <button type="button" @click="closeAllTabsFromMenu">全部关闭</button>
    </menu>

    <DatabaseSyncDialog
      v-if="databaseSync.dialog.open"
      :sync="databaseSync"
      @close="databaseSync.close"
      @preview="databaseSync.preview"
      @execute="executeDatabaseSync"
      @source-change="databaseSync.setSourceDatabase"
      @target-change="databaseSync.setTargetDatabase"
      @add-exclusions="databaseSync.addExclusionsFromInput"
      @remove-exclusion="databaseSync.removeExcludedTable"
    />

    <UpdateDialog
      v-if="updater.isDialogOpen.value"
      :updater="updater"
      @close="updater.closeDialog"
      @check="updater.checkForUpdates({ openOnError: true, openOnAvailable: true })"
      @download-and-install="updater.downloadAndInstall"
      @relaunch="updater.relaunch"
    />

    <ImportWizardDialog
      v-if="importWizard.open"
      :wizard="importWizard"
      :active-tab="activeDataTab"
      @close="closeImportWizard"
      @file-selected="onImportFileSelected"
      @parse-sheet="parseImportSheet"
      @go-step="goToImportStep"
      @execute="executeImport"
      @click-file-area="importInput?.click()"
    />

    <ConnectionDialog
      v-if="connDialog.open"
      :dialog="connDialog"
      :busy="busy"
      @submit="submitConnDialog"
      @cancel="cancelConnDialog"
    />

  </main>
</template>
