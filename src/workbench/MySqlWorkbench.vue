<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from "vue";

import {
  applyTableSchemaToDataTab,
  buildSchemaSearchResults,
  closeDatabaseTabs,
  closeConnectionTabs,
  closePaneTabs,
  closePaneTab,
  createWorkspaceState,
  findTableDataTabs,
  getActiveTab,
  getFocusedTab,
  focusPane as focusWorkspacePane,
  activateTableTab,
  markTableDataTabSchemaStale,
  moveTabBetweenPanes,
  moveTableTab,
  openTableDesignTab,
  renameTableTab,
} from "./workspaceState.js";
import {
  closePaneInLayout,
  normalizePaneLayoutState,
  pruneEmptyPanesInLayout,
  resizeSplitInLayout,
  splitPaneInLayout,
} from "./paneLayoutState.js";
import {
  beginValueSearch,
  cancelValueSearch,
  clearValueSearchResults,
  createSidebarSearchState,
  failValueSearch,
  finishValueSearch,
  normalizeSidebarSearchQuery,
  setSidebarSearchQuery,
  updateValueSearchProgress,
} from "./sidebarSearchState.js";
import {
  createEditState,
  clearCellErrorsForTable,
  isCellPending,
  getCellError,
} from "./editState.js";
import { invokeWorkbench, listenWorkbenchEvent } from "./utils/tauriBridge.js";
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
import WorkbenchSplitLayout from "./components/WorkbenchSplitLayout.vue";
import DataGrid from "./components/DataGrid.vue";
import TableDesignEditor from "./components/TableDesignEditor.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import AgentPanel from "./components/AgentPanel.vue";
import PaneDivider from "./components/PaneDivider.vue";
import ContextMenu from "./components/ContextMenu.vue";
import DatabaseSyncDialog from "./components/DatabaseSyncDialog.vue";
import TableCopyDialog from "./components/TableCopyDialog.vue";
import ImportWizardDialog from "./components/ImportWizardDialog.vue";
import ConnectionDialog from "./components/ConnectionDialog.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import BackupCenterDialog from "./components/BackupCenterDialog.vue";

import { useConnection } from "./composables/useConnection.js";
import { useTableSession } from "./composables/useTableSession.js";
import { useTableSearch } from "./composables/useTableSearch.js";
import { useVirtualGrid } from "./composables/useVirtualGrid.js";
import { useGridEditor } from "./composables/useGridEditor.js";
import { useRowSelection } from "./composables/useRowSelection.js";
import { useContextMenu } from "./composables/useContextMenu.js";
import { useDatabaseSync } from "./composables/useDatabaseSync.js";
import { useBackupCenter } from "./composables/useBackupCenter.js";
import { useTableCopy } from "./composables/useTableCopy.js";
import { useImportWizard } from "./composables/useImportWizard.js";
import { useExport } from "./composables/useExport.js";
import { useUndo } from "./composables/useUndo.js";
import { usePaneResize } from "./composables/usePaneResize.js";
import { useTheme } from "./composables/useTheme.js";
import { useUpdater } from "./composables/useUpdater.js";
import { useAgent } from "./composables/useAgent.js";

markPerf("workbench.module-loaded");

const SEARCH_VALUES_PROGRESS_EVENT = "search-values-progress";

// ── Shared state ──────────────────────────────────────────────────────────
const workspace = reactive(createWorkspaceState());
const editState = reactive(createEditState());
const sidebarSearch = reactive(createSidebarSearchState());
const treeQuery = computed({
  get: () => sidebarSearch.query,
  set: (value) => setSidebarSearchQuery(sidebarSearch, value),
});
const tabContextMenu = reactive({ open: false, x: 0, y: 0, paneId: "" });
const tableRename = reactive({ open: false, connectionId: "", database: "", tableName: "", newName: "", busy: false, error: "" });
const saveReminders = ref([]);
let nextSaveReminderId = 1;

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value ?? "")) : String(value ?? "").replace(/["\\]/g, "\\$&");
}

// ── Composables ───────────────────────────────────────────────────────────
const conn = useConnection(workspace, invokeWorkbench);
const {
  connections,
  visibleConnections,
  databases,
  selectedConnectionId,
  selectedDatabase,
  connDialog,
  busy,
  connTestBusy,
  statusText,
  loadConnections,
  selectConnection,
  selectDatabase,
  reorderConnections,
  reorderDatabases,
  loadTables,
  ensureTableSchema,
  isReadOnlyConnection,
  openConnDialog,
  cancelConnDialog,
  testConnDialog,
  onConnDialogFieldChange,
  submitConnDialog,
  removeConnection,
} = conn;

watch(
  () => [selectedConnectionId.value, selectedDatabase.value],
  () => {
    clearValueSearchResults(sidebarSearch);
    sidebarSearch.valueSearchToken += 1;
  },
  { deep: false },
);

const { openTable, fetchPage, loadNextPage, toggleSort, applySort } = useTableSession(
  workspace,
  invokeWorkbench,
  { busy: conn.busy, statusText: conn.statusText },
);

const focusedPaneState = reactive({
  paneId: "",
  activeDataTab: null,
  activeDesignTab: null,
  activeColumns: [],
  selectedCell: null,
  selectedRange: null,
  textDraft: "",
  setTextDraft: null,
  saveTextPanel: null,
  commitInsertRowsAndRefresh: null,
  handleWorkbenchKeydown: null,
  clearSelection: null,
  resetGridScroll: null,
  scrollColumnIntoView: null,
  runTableSearch: null,
  goToNextSchemaSearchMatch: null,
  goToPreviousSchemaSearchMatch: null,
});

const activeTab = computed(() => getFocusedTab(workspace) || getActiveTab(workspace));
const activeDataTab = computed(() => {
  const tab = activeTab.value;
  if (focusedPaneState.activeDataTab?.id && focusedPaneState.activeDataTab.id === tab?.id) {
    return focusedPaneState.activeDataTab;
  }
  return tab && (tab.kind || "data") === "data" ? tab : null;
});
const activeDesignTab = computed(() => {
  const tab = activeTab.value;
  if (focusedPaneState.activeDesignTab?.id && focusedPaneState.activeDesignTab.id === tab?.id) {
    return focusedPaneState.activeDesignTab;
  }
  return tab?.kind === "design" ? tab : null;
});
const focusedInspectorTab = computed(() => focusedPaneState.activeDataTab || activeTab.value || null);
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

const focusedActiveColumns = computed(() =>
  focusedPaneState.activeDataTab?.id === activeDataTab.value?.id ? focusedPaneState.activeColumns : activeColumns.value || [],
);
const focusedSelectedCell = computed(() =>
  focusedPaneState.selectedCell?.tabId === activeDataTab.value?.id ? focusedPaneState.selectedCell : selectedCell.value || null,
);
const focusedSelectedRange = computed(() =>
  focusedPaneState.selectedRange?.tabId === activeDataTab.value?.id ? focusedPaneState.selectedRange : selectedRange.value || null,
);
const focusedTextDraft = computed({
  get: () => focusedPaneState.textDraft ?? textDraft.value ?? "",
  set: (value) => {
    if (typeof focusedPaneState.setTextDraft === "function") focusedPaneState.setTextDraft(value);
    else textDraft.value = String(value ?? "");
    focusedPaneState.textDraft = String(value ?? "");
  },
});

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
} =
  useRowSelection(invokeWorkbench, { statusText: conn.statusText }, { fetchPage: refreshTabPage });

const {
  contextMenu,
  contextMenuStyle,
  openContextMenu,
  closeContextMenu,
  refreshFromContextMenu,
  openDesignFromContextMenu,
  renameFromContextMenu,
} = useContextMenu(
  { statusText: conn.statusText },
  {
    loadTables: conn.loadTables,
    ensureTableSchema: conn.ensureTableSchema,
    fetchPage: refreshTabPage,
    refreshDatabases: conn.refreshDatabases,
  },
  activeDataTab,
  { openTableDesign, onTablePageRefreshed: clearTabCellErrors },
);

let unlistenValueSearchProgress = null;

function handleValueSearchProgress(event) {
  const payload = event?.payload || event || {};
  if (updateValueSearchProgress(sidebarSearch, payload)) {
    const done = sidebarSearch.valueProgress.done || 0;
    const total = sidebarSearch.valueProgress.total || 0;
    const matches = sidebarSearch.valueProgress.matches || 0;
    statusText.value = total
      ? `搜索值 ${done}/${total}，命中 ${matches}`
      : `搜索值… 命中 ${matches}`;
  }
}

async function ensureValueSearchProgressListener() {
  if (unlistenValueSearchProgress) return;
  const unlisten = await listenWorkbenchEvent(SEARCH_VALUES_PROGRESS_EVENT, handleValueSearchProgress);
  unlistenValueSearchProgress = typeof unlisten === "function" ? unlisten : null;
}

const databaseSync = useDatabaseSync({
  connections,
  databases,
  invokeWorkbench,
  listen: listenWorkbenchEvent,
});

const backupCenter = useBackupCenter({
  onDataChanged: () => {
    const tab = activeDataTab.value;
    if (tab) {
      refreshTabPage(tab, tab.page || 1);
    }
  },
});

function openBackupCenter() {
  backupCenter.filters.connectionId = selectedConnectionId.value || "";
  backupCenter.filters.database = selectedDatabase.value || "";
  backupCenter.open();
}

const tableCopy = useTableCopy({
  connections,
  databases,
  invokeWorkbench,
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
  sidebarPaneAnimating,
  sidebarPanePhase,
  sidebarLayoutVars,
  inspectorStyle,
  onDividerMouseDown,
  onSidebarLayoutTransitionEnd,
  toggleSidebar,
  toggleInspector,
} = usePaneResize();

provide("suspendGridAutoFit", sidebarPaneAnimating);

const { effectiveTheme, isDark, toggleTheme } = useTheme();
const updater = useUpdater();
const agent = useAgent(workspace, invokeWorkbench);
const inspectorMode = ref("notes");
const isStatusError = computed(() => /失败|错误|不能|冲突|重复/.test(statusText.value || ""));

function sourceConnectionId(source = {}, fallback = null) {
  return String(source?.connectionId || source?.connection_id || fallback?.connectionId || fallback?.connection_id || "");
}

function isReadOnlySource(source = {}, fallback = null) {
  return Boolean(
    source?.readOnly ||
      source?.read_only ||
      fallback?.readOnly ||
      fallback?.read_only ||
      isReadOnlyConnection(sourceConnectionId(source, fallback)),
  );
}

function blockReadOnlyAction(action) {
  statusText.value = `只读连接不能${action}`;
}

const INSPECTOR_TITLEBAR_COLLAPSED_WIDTH = 32;
const inspectorTitlebarStyle = computed(() => ({
  width: inspectorCollapsed.value
    ? `${INSPECTOR_TITLEBAR_COLLAPSED_WIDTH}px`
    : `${inspectorWidth.value}px`,
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

function showSaveReminderAt({ x, y, kind, message }) {
  const id = nextSaveReminderId++;
  saveReminders.value = [
    ...saveReminders.value.slice(-4),
    { id, kind, message, x, y },
  ];
  globalThis.setTimeout?.(() => {
    saveReminders.value = saveReminders.value.filter((reminder) => reminder.id !== id);
  }, 1300);
}

async function copyTextToClipboard(text) {
  const value = String(text ?? "");
  if (!value) return false;
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(value);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand?.("copy") === true;
  } finally {
    textarea.remove();
  }
}

async function copyTabName({ tab, x = 0, y = 0 } = {}) {
  const tableName = String(tab?.tableName || "").trim();
  if (!tableName) return;
  try {
    const copied = await copyTextToClipboard(tableName);
    if (!copied) throw new Error("clipboard unavailable");
    const rootRect = paneWorkspaceRef.value?.getBoundingClientRect?.();
    showSaveReminderAt({
      kind: "tab-copy",
      message: "已复制表名",
      x: rootRect ? Math.max(72, Math.min(x - rootRect.left, rootRect.width - 72)) : x,
      y: rootRect ? Math.max(38, Math.min(y - rootRect.top - 10, rootRect.height - 38)) : y,
    });
    statusText.value = `已复制表名：${tableName}`;
  } catch (error) {
    statusText.value = `复制表名失败：${String(error?.message || error)}`;
  }
}

function handlePaneStateChange(state) {
  if (!state?.paneId) return;
  if (state.paneId !== workspace.focusedPaneId) return;
  Object.assign(focusedPaneState, state);
}

function saveFocusedTextPanel() {
  const tab = focusedPaneState.activeDataTab;
  const cell = focusedPaneState.selectedCell;
  if (cell?.tabId === tab?.id && String(cell?.rowKey || "").startsWith("__insert__:")) {
    return focusedPaneState.commitInsertRowsAndRefresh?.(tab);
  }
  return focusedPaneState.saveTextPanel?.();
}

function focusPane(paneId) {
  focusWorkspacePane(workspace, paneId);
}

function paneTabIds(paneId) {
  return workspace.panes?.[paneId]?.tabIds || [];
}

function tabInPane(paneId, tabId) {
  return paneTabIds(paneId).includes(tabId);
}

function sourceFromTab(tab) {
  if (!tab) return null;
  return {
    connectionId: tab.connectionId,
    database: tab.database,
    tableName: tab.tableName,
    tableComment: tab.tableComment || "",
    kind: tab.kind || "data",
  };
}

async function splitPane(paneId, direction) {
  const sourcePane = workspace.panes?.[paneId];
  const sourceTab = workspace.tabs.find((tab) => tab.id === sourcePane?.activeTabId) || null;
  const newPane = splitPaneInLayout(workspace, paneId, direction);
  if (!newPane) return;
  focusPane(newPane.id);
  const source = sourceFromTab(sourceTab);
  if (!source?.tableName) return;
  if (source.kind === "design") {
    openTableDesignTab(workspace, source, { paneId: newPane.id, activate: true });
  } else {
    await openTable(source, {
      paneId: newPane.id,
      activate: true,
      duplicate: true,
      initialState: {
        filter: sourceTab.filter || "",
        filterMode: sourceTab.filterMode || "fuzzy",
        searchQuery: sourceTab.searchQuery || sourceTab.filter || "",
        sort: sourceTab.sort ? { ...sourceTab.sort } : null,
      },
    });
  }
}

function closePane(paneId) {
  const result = closePaneInLayout(workspace, paneId);
  if (!result) return;
  focusPane(result.targetPaneId);
}

function resizeSplit(splitId, ratio) {
  resizeSplitInLayout(workspace.layout, splitId, ratio);
}

function syncCommittedCellToSiblingTabs({ tab: sourceTab, rowKey, column, oldValue, newValue }) {
  if (!sourceTab?.tableKey || !rowKey || !column) return;
  for (const tab of workspace.tabs) {
    if (tab.id === sourceTab.id || (tab.kind || "data") !== "data" || tab.tableKey !== sourceTab.tableKey) continue;
    const row = tab.rows?.find((candidate) => {
      if (buildRowKey(tab, candidate) === rowKey) return true;
      return buildRowKey(tab, { ...candidate, [column]: oldValue }) === rowKey;
    });
    if (row) row[column] = newValue;
  }
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
  if (event?.button !== 0 || event?.target?.closest?.(".wb-titlebar-controls, .wb-update-button, .wb-ai-entry-button")) return;
  if (event?.target?.closest?.('button, [role="button"], input, textarea, select, a, menu')) return;
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

function toggleAiAssistant() {
  inspectorMode.value = inspectorMode.value === "ai" ? "notes" : "ai";
  if (inspectorCollapsed.value) toggleInspector();
  if (inspectorMode.value === "ai") {
    void agent.prewarm(focusedInspectorTab.value);
  }
}

function sendAgentMessage() {
  void agent.send(focusedInspectorTab.value);
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

function uniqueSchemaSearchPriorityTables(results = []) {
  const seen = new Set();
  const names = [];
  for (const result of results) {
    const name = normalizeTableName(result?.table?.raw || result?.table || result);
    const key = name.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

async function refreshTabPage(tab, page) {
  const result = await fetchPage(tab, page);
  if (result?.ok) clearTabCellErrors(tab);
  return result;
}

function cancelSidebarValueSearch() {
  if (cancelValueSearch(sidebarSearch)) {
    statusText.value = "已取消值搜索";
  }
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
  statusText.value = "搜索值…";
  try {
    await ensureValueSearchProgressListener();
    const results = await invokeWorkbench("search_values", {
      request: {
        connectionId: selectedConnectionId.value,
        database: selectedDatabase.value,
        query,
        limit: 1500,
        jobId: sidebarSearch.valueSearchJobId,
        priorityTables: uniqueSchemaSearchPriorityTables(schemaSearchResults.value),
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

function setSchemaSearchMatches(tab, result, query, targetColumnName = "") {
  if (!tab) return [];
  const columns = [
    ...(Array.isArray(result?.matchedColumns) ? result.matchedColumns : []),
    ...(Array.isArray(result?.visibleColumns) ? result.visibleColumns : []),
  ];
  const matches = [];
  const seen = new Set();
  for (const column of columns) {
    const name = columnName(column);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    matches.push({
      columnName: name,
      matchKind: column?.searchMatchKind || result?.matchKind || "columnName",
    });
  }
  const targetIndex = Math.max(0, matches.findIndex((match) => match.columnName === targetColumnName));
  tab.schemaSearchQuery = query;
  tab.schemaSearchMatches = matches;
  tab.schemaSearchIndex = matches.length ? targetIndex : -1;
  return matches;
}

async function openSidebarSchemaResult(result) {
  const table = result?.table?.raw || result?.table;
  if (!table) return;
  focusedPaneState.clearSelection?.();
  focusedPaneState.resetGridScroll?.();
  const tab = await openTable(table, { paneId: workspace.focusedPaneId });
  const query = normalizeSidebarSearchQuery(sidebarSearch.valueSearchedQuery || treeQuery.value);
  const firstColumn = result.visibleColumns?.[0] || result.matchedColumns?.[0];
  const targetColumn = columnName(firstColumn);
  if (!tab) return;
  setSchemaSearchMatches(tab, result, query, targetColumn);
  if (!targetColumn) return;
  await nextTick();
  const columnIndex = (tab.columns || []).findIndex((column) => columnName(column) === targetColumn);
  if (columnIndex >= 0) focusedPaneState.scrollColumnIntoView?.(columnIndex, "th");
}

async function openSidebarValueResult(result) {
  if (!result?.tableName) return;
  const query = normalizeSidebarSearchQuery(sidebarSearch.valueSearchedQuery || treeQuery.value);
  focusedPaneState.clearSelection?.();
  focusedPaneState.resetGridScroll?.();
  const tab = await openTable({
    tableName: result.tableName,
    tableComment: result.tableComment || "",
    connectionId: result.connectionId || selectedConnectionId.value,
    database: result.database || selectedDatabase.value,
  }, { paneId: workspace.focusedPaneId });
  if (!tab || !query) return;
  tab.filter = query;
  tab.searchQuery = query;
  await nextTick();
  await focusedPaneState.runTableSearch?.(query);
}

async function activateTab(paneIdOrTabId, maybeTabId) {
  const paneId = maybeTabId ? paneIdOrTabId : workspace.focusedPaneId;
  const tabId = maybeTabId || paneIdOrTabId;
  const tab = workspace.tabs.find((t) => t.id === tabId);
  if (tab) {
    if (tab.connectionId && tab.connectionId !== selectedConnectionId.value) {
      await selectConnection(tab.connectionId);
    }
    if (tab.database && tab.database !== selectedDatabase.value) {
      await selectDatabase({ connectionId: tab.connectionId, database: tab.database });
    }
  }
  if (paneId) focusWorkspacePane(workspace, paneId);
  activateTableTab(workspace, tabId);
  focusedPaneState.clearSelection?.();
}

function closeTab(paneIdOrTabId, maybeTabId) {
  const paneId = maybeTabId ? paneIdOrTabId : workspace.focusedPaneId;
  const tabId = maybeTabId || paneIdOrTabId;
  const tab = workspace.tabs.find((item) => item.id === tabId);
  clearTabCellErrors(tab);
  focusedPaneState.clearSelection?.();
  closePaneTab(workspace, paneId, tabId);
  pruneEmptyPanesInLayout(workspace);
}

function reorderTab(paneIdOrSourceId, sourceIdOrTargetId, targetIdOrOptions, maybeOptions) {
  const hasPane = Boolean(workspace.panes?.[paneIdOrSourceId]);
  const targetPaneId = hasPane ? paneIdOrSourceId : workspace.focusedPaneId;
  const sourceId = hasPane ? sourceIdOrTargetId : paneIdOrSourceId;
  const targetId = hasPane ? targetIdOrOptions : sourceIdOrTargetId;
  const options = hasPane ? (maybeOptions || {}) : (targetIdOrOptions || {});
  if (!sourceId) return;
  if (!targetId) {
    moveTabBetweenPanes(workspace, sourceId, targetPaneId, { activate: true });
    return;
  }
  if (tabInPane(targetPaneId, sourceId) && tabInPane(targetPaneId, targetId)) {
    moveTableTab(workspace, sourceId, targetId, options);
  } else {
    moveTabBetweenPanes(workspace, sourceId, targetPaneId, {
      targetTabId: targetId,
      position: options?.position || "after",
      activate: true,
    });
  }
}

function openTabContextMenu({ x, y, paneId }) {
  const targetPaneId = paneId || workspace.focusedPaneId;
  if ((workspace.panes?.[targetPaneId]?.tabIds || []).length === 0) return;
  closeContextMenu();
  tabContextMenu.open = true;
  tabContextMenu.x = x;
  tabContextMenu.y = y;
  tabContextMenu.paneId = targetPaneId;
}

function closeTabContextMenu() {
  tabContextMenu.open = false;
  tabContextMenu.paneId = "";
}

async function refreshTabsFromMenu() {
  const paneId = tabContextMenu.paneId || workspace.focusedPaneId;
  const pane = workspace.panes?.[paneId];
  const tab = workspace.tabs.find((item) => item.id === pane?.activeTabId);
  closeTabContextMenu();
  if (!tab || (tab.kind || "data") !== "data") return;
  await refreshTabPage(tab, tab.page || 1);
}

function closeAllTabsFromMenu() {
  const paneId = tabContextMenu.paneId || workspace.focusedPaneId;
  closeTabContextMenu();
  resetGridState();
  const closedTabs = closePaneTabs(workspace, paneId);
  closedTabs.forEach(clearTabCellErrors);
  pruneEmptyPanesInLayout(workspace);
}

function closeAllContextMenus() {
  closeContextMenu();
  closeTabContextMenu();
}

function openDatabaseSync(target) {
  closeContextMenu();
  closeTabContextMenu();
  if (isReadOnlySource(target)) {
    blockReadOnlyAction("执行覆盖同步");
    return;
  }
  databaseSync.open(target);
}

async function executeDatabaseSync() {
  const target = {
    connectionId: databaseSync.dialog.connectionId,
    database: databaseSync.dialog.targetDatabase,
  };
  const confirmed = globalThis.confirm(
    `覆盖同步目标库？\n\n源库：${databaseSync.dialog.sourceDatabase}\n目标库：${databaseSync.dialog.targetDatabase}\n\n执行后将清空目标库现有数据，并用源库数据覆盖。此操作不可撤销。`,
  );
  if (!confirmed) return;
  await databaseSync.execute();
  if (databaseSync.dialog.status !== "succeeded") return;
  resetGridState();

  // 刷新目标数据库的表列表缓存（无论当前是否选中目标库）
  await loadTables(target);

  // 找到目标数据库中所有打开的标签页
  const syncedTabs = workspace.tabs.filter(
    (tab) => tab.connectionId === target.connectionId && tab.database === target.database
  );

  // 刷新目标数据库中所有打开的表的schema和数据
  for (const tab of syncedTabs) {
    if (tab.tableName) {
      try {
        await ensureTableSchema(tab.tableName, target);
        await refreshTabPage(tab, 1);
      } catch (error) {
        console.error(`刷新表 ${tab.tableName} 失败:`, error);
      }
    }
  }
}

function openTableCopyFromContext() {
  const source = {
    connectionId: contextMenu.connectionId,
    database: contextMenu.database,
    tableName: contextMenu.tableName,
  };
  closeContextMenu();
  closeTabContextMenu();
  if (isReadOnlySource(source)) {
    blockReadOnlyAction("发送表");
    return;
  }
  tableCopy.open(source);
}

function openTableRenameFromSource(source) {
  const tableName = normalizeTableName(source);
  if (!tableName) return;
  if (isReadOnlySource(source)) {
    blockReadOnlyAction("重命名表");
    return;
  }
  tableRename.connectionId = source.connectionId;
  tableRename.database = source.database;
  tableRename.tableName = tableName;
  tableRename.newName = tableName;
  tableRename.error = "";
  tableRename.open = true;
}

function openTableRenameFromContext() {
  const source = renameFromContextMenu();
  closeTabContextMenu();
  openTableRenameFromSource(source);
}

async function executeTableRename() {
  if (!tableRename.newName || tableRename.newName === tableRename.tableName) {
    tableRename.open = false;
    return;
  }
  if (isReadOnlyConnection(tableRename.connectionId)) {
    tableRename.error = "只读连接不能重命名表";
    return;
  }
  tableRename.busy = true;
  tableRename.error = "";
  try {
    await invokeWorkbench("rename_table", {
      connectionId: tableRename.connectionId,
      database: tableRename.database,
      tableName: tableRename.tableName,
      newName: tableRename.newName,
    });
    tableRename.open = false;
    statusText.value = `已重命名 ${tableRename.tableName} → ${tableRename.newName}`;
    renameTableTab(workspace, {
      connectionId: tableRename.connectionId,
      database: tableRename.database,
      oldName: tableRename.tableName,
      newName: tableRename.newName,
    });
    await conn.loadTables({ connectionId: tableRename.connectionId, database: tableRename.database });
  } catch (error) {
    tableRename.error = String(error);
  } finally {
    tableRename.busy = false;
  }
}

function closeTableRename() {
  tableRename.open = false;
}

async function executeTableCopy() {
  await tableCopy.execute();
  if (tableCopy.dialog.status !== "succeeded") return;
  // Refresh the target database sidebar
  const target = {
    connectionId: tableCopy.dialog.targetConnectionId,
    database: tableCopy.dialog.targetDatabase,
  };
  await loadTables(target);
}

async function handleTableCopyTargetConnection(connectionId) {
  tableCopy.setTargetConnection(connectionId);
  if (!invokeWorkbench || !connectionId || !tableCopy.dialog.targetConnectionId) return;
  try {
    const dbList = await invokeWorkbench("list_databases", { connectionId });
    databases.value = Array.isArray(dbList) ? dbList : [];
  } catch {
    // Keep current database list on failure
  }
}

async function openTableFromSidebar(table) {
  focusedPaneState.clearSelection?.();
  focusedPaneState.resetGridScroll?.();
  await openTable(table, { paneId: workspace.focusedPaneId });
}

function openTableDesign(tableLike = null, paneId = workspace.focusedPaneId) {
  const source = tableLike || activeDataTab.value;
  const fallback = activeDataTab.value;
  const tableName = normalizeTableName(source) || fallback?.tableName || "";
  if (!tableName) return null;
  if (isReadOnlySource(source, fallback)) {
    blockReadOnlyAction("打开表设计");
    return null;
  }
  const connectionId = String(source?.connectionId || source?.connection_id || fallback?.connectionId || "");
  const database = String(source?.database || fallback?.database || "");
  const tableComment = normalizeTableComment(source) || fallback?.tableComment || "";
  const tab = openTableDesignTab(workspace, { connectionId, database, tableName, tableComment }, { paneId });
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

async function removeConnectionFromContext() {
  const connectionId = contextMenu.connectionId;
  closeContextMenu();
  if (!connectionId) return;
  closeConnectionTabs(workspace, { connectionId });
  await removeConnection(connectionId);
}

function openGeneralContextMenu(event) {
  closeTabContextMenu();
  openContextMenu(event);
}

function openActiveTableContextMenu(event, targetTab = activeDataTab.value) {
  closeTabContextMenu();
  openContextMenu(event, targetTab);
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

function startGridRowDragSelection(tab, row, rowIndex, event, wrap) {
  clearSelection();
  startRowDragSelection(tab, row, event, wrap);
  gridWrapRef.value?.focus();
}

function extendGridRowDragSelection(tab, event) {
  extendRowDragSelectionFromPointer(tab, event);
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
  if (typeof focusedPaneState.handleWorkbenchKeydown === "function") {
    focusedPaneState.handleWorkbenchKeydown(event);
    return;
  }
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
  const tab = focusedPaneState.activeDataTab || activeDataTab.value;
  if (!tab || !hasInsertDrafts(tab)) return;
  if (event?.target?.closest?.(".wb-insert-row")) return;
  if (autoSaveInsertPromise) return;
  const save = typeof focusedPaneState.commitInsertRowsAndRefresh === "function"
    ? focusedPaneState.commitInsertRowsAndRefresh
    : commitInsertRowsAndRefresh;
  autoSaveInsertPromise = Promise.resolve(save(tab)).finally(() => {
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
      panes: workspace.panes,
      layout: workspace.layout,
      focusedPaneId: workspace.focusedPaneId,
    }),
  );
}

watch(
  () => [
    selectedConnectionId.value,
    selectedDatabase.value,
    workspace.tabs.length,
    workspace.activeTabId,
    workspace.focusedPaneId,
    JSON.stringify(workspace.panes),
    JSON.stringify(workspace.layout),
  ],
  () => persistWorkspace(),
  { deep: false },
);

async function restoreSavedTabs() {
  const snapshot = loadWorkspaceSnapshot();
  if (!snapshot) return;

  const currentConnectionId = selectedConnectionId.value;
  const currentDatabase = selectedDatabase.value;
  const availableTableNames = new Set(
    workspace.schema.map((table) => normalizeTableName(table)),
  );

  const basePaneState = normalizePaneLayoutState({
    panes: snapshot.panes,
    layout: snapshot.layout,
    focusedPaneId: snapshot.focusedPaneId,
  });
  const savedPanes = basePaneState.panes;
  const savedTabToPane = new Map();
  Object.values(savedPanes).forEach((pane) => {
    pane.tabIds.forEach((tabId) => savedTabToPane.set(tabId, pane.id));
  });
  const savedToRestoredTabId = new Map();
  workspace.panes = Object.fromEntries(
    Object.keys(savedPanes).map((paneId) => [paneId, { id: paneId, tabIds: [], activeTabId: "" }]),
  );
  workspace.layout = basePaneState.layout;
  workspace.focusedPaneId = basePaneState.focusedPaneId;
  workspace.nextPaneSeq = basePaneState.nextPaneSeq;
  workspace.nextSplitSeq = basePaneState.nextSplitSeq;

  for (const savedTab of snapshot.tabs) {
    if (savedTab.connectionId && savedTab.connectionId !== currentConnectionId) continue;
    if (savedTab.database && savedTab.database !== currentDatabase) continue;
    if (!availableTableNames.has(savedTab.tableName)) continue;

    const tableMeta = workspace.schema.find(
      (table) => normalizeTableName(table) === savedTab.tableName,
    );
    const readOnly = Boolean(savedTab.readOnly || savedTab.read_only || tableMeta?.readOnly || tableMeta?.read_only || isReadOnlyConnection(currentConnectionId));
    if (readOnly && savedTab.kind === "design") continue;
    const tableForOpen = {
      ...(tableMeta || {}),
      tableName: savedTab.tableName,
      tableComment: savedTab.tableComment || "",
      connectionId: currentConnectionId,
      database: currentDatabase,
      readOnly,
    };
    const paneId = savedTabToPane.get(savedTab.id) || snapshot.focusedPaneId || workspace.focusedPaneId;
    let restoredTab = null;
    if (savedTab.kind === "design") {
      restoredTab = openTableDesignTab(workspace, tableForOpen, { activate: false, paneId });
    } else {
      restoredTab = await openTable(tableForOpen, { activate: false, paneId });
    }
    if (restoredTab) {
      if (savedTab.filter) restoredTab.filter = savedTab.filter;
      if (savedTab.filterMode) restoredTab.filterMode = savedTab.filterMode;
      if (savedTab.sort) restoredTab.sort = savedTab.sort;
      savedToRestoredTabId.set(savedTab.id, restoredTab.id);
    }
  }

  const restoredPanes = {};
  for (const [paneId, pane] of Object.entries(savedPanes)) {
    const tabIds = pane.tabIds.map((tabId) => savedToRestoredTabId.get(tabId)).filter(Boolean);
    restoredPanes[paneId] = {
      id: paneId,
      tabIds,
      activeTabId: savedToRestoredTabId.get(pane.activeTabId) || tabIds[0] || "",
    };
  }
  const restoredPaneState = normalizePaneLayoutState({
    panes: restoredPanes,
    layout: snapshot.layout,
    focusedPaneId: snapshot.focusedPaneId,
    nextPaneSeq: basePaneState.nextPaneSeq,
    nextSplitSeq: basePaneState.nextSplitSeq,
  });
  workspace.panes = restoredPaneState.panes;
  workspace.layout = restoredPaneState.layout;
  workspace.nextPaneSeq = restoredPaneState.nextPaneSeq;
  workspace.nextSplitSeq = restoredPaneState.nextSplitSeq;
  workspace.focusedPaneId = restoredPaneState.focusedPaneId;
  const activeId = savedToRestoredTabId.get(snapshot.activeTabId);
  if (activeId) {
    activateTableTab(workspace, activeId);
  } else {
    const focusedPane = workspace.panes[workspace.focusedPaneId];
    workspace.activeTabId = focusedPane?.activeTabId || workspace.tabs[0]?.id || "";
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
    window.setTimeout(() => {
      void agent.prewarm(focusedInspectorTab.value);
    }, 450);
  } catch (e) {
    conn.statusText.value = `初始化失败：${String(e)}`;
  }
  persistenceReady = true;
  persistWorkspace();
  void updater.checkForUpdates();
});

onBeforeUnmount(() => {
  databaseSync.dispose();
  backupCenter.dispose();
  unlistenValueSearchProgress?.();
  unlistenValueSearchProgress = null;
});
</script>

<template>
  <main
    class="mysql-workbench"
    :class="{
      'is-dragging': paneIsDragging,
      'is-inspector-collapsed': inspectorCollapsed,
    }"
    :data-theme="effectiveTheme"
    :style="sidebarLayoutVars"
    @transitionend="onSidebarLayoutTransitionEnd"
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
      @dblclick.self="toggleMaximizeWindow"
    >
      <div
        class="wb-titlebar-sidebar"
        :class="{
          'is-collapsed': sidebarCollapsed && !sidebarPaneAnimating,
          'is-retracted': sidebarCollapsed,
        }"
        id="wb-topbar-sidebar-actions"
        aria-label="数据库操作"
      >
        <button
          type="button"
          class="wb-header-btn wb-topbar-collapse-btn"
          :aria-label="sidebarCollapsed ? '展开数据库栏' : '收起数据库栏'"
          :title="sidebarCollapsed ? '展开数据库栏' : '收起数据库栏'"
          @click.stop="toggleSidebar()"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline v-if="sidebarCollapsed" points="5,3 9,7 5,11" />
            <polyline v-else points="9,3 5,7 9,11" />
          </svg>
        </button>
      </div>


      <div class="wb-titlebar-tabs" id="wb-topbar-tabs" aria-label="表标签"></div>


      <div
        class="wb-titlebar-inspector-controls"
        :class="{ 'is-collapsed': inspectorCollapsed }"
        :style="inspectorTitlebarStyle"
        aria-label="备注区域操作"
      >
        <button
          type="button"
          class="wb-header-btn wb-topbar-collapse-btn"
          :aria-label="inspectorCollapsed ? '展开备注栏' : '收起备注栏'"
          :title="inspectorCollapsed ? '展开备注栏' : '收起备注栏'"
          @click.stop="toggleInspector()"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline v-if="inspectorCollapsed" points="9,3 5,7 9,11" />
            <polyline v-else points="5,3 9,7 5,11" />
          </svg>
        </button>
      </div>

      <button
        type="button"
        class="wb-ai-entry-button"
        :class="{ 'is-active': inspectorMode === 'ai', 'is-thinking': agent.isBusy.value || agent.isStarting.value }"
        :title="inspectorMode === 'ai' ? '切回备注栏' : '打开数据库 Agent'"
        :aria-label="inspectorMode === 'ai' ? '切回备注栏' : '打开数据库 Agent'"
        :aria-pressed="inspectorMode === 'ai'"
        @click.stop="toggleAiAssistant"
      >
        <span class="wb-ai-entry-icon" aria-hidden="true"></span>
      </button>

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

    <section
      class="wb-workspace"
      ref="paneWorkspaceRef"
      :class="{ 'is-dragging': paneIsDragging }"
    >
      <div
        class="wb-sidebar-slot"
        :class="{
          'is-pane-animating': sidebarPaneAnimating,
          'is-expanding': sidebarPanePhase === 'expanding',
        }"
      >
        <WorkbenchSidebar
          :class="{
            'is-collapsed': sidebarCollapsed,
            'is-pane-animating': sidebarPaneAnimating,
            'is-expanding': sidebarPanePhase === 'expanding',
          }"
        :selected-connection-id="selectedConnectionId"
        :selected-database="selectedDatabase"
        :connections="visibleConnections"
        :databases="databases"
        :filtered-tables="filteredTables"
        :schema-search-results="schemaSearchResults"
        :sidebar-search-state="sidebarSearch"
        :tree-query="treeQuery"
        :active-tab="activeTab"
        :is-dark="isDark"
        @update:tree-query="treeQuery = $event"
        @search-values="runSidebarValueSearch"
        @cancel-search-values="cancelSidebarValueSearch"
        @open-schema-result="openSidebarSchemaResult"
        @open-value-result="openSidebarValueResult"
        @select-connection="selectConnection($event)"
        @select-database="selectDatabase($event)"
        @reorder-connections="reorderConnections"
        @reorder-databases="reorderDatabases"
        @open-table="openTableFromSidebar"
        @rename-table="openTableRenameFromSource"
        @open-connection="openConnDialog"
        @open-backup-center="openBackupCenter"
        @contextmenu="openSidebarContextMenu"
        @toggle-theme="toggleTheme"
        />
      </div>

      <PaneDivider
        side="left"
        :collapsed="sidebarCollapsed"
        @drag-start="onDividerMouseDown($event, 'sidebar')"
        @toggle="toggleSidebar()"
      />

      <section class="wb-main">
        <WorkbenchSplitLayout
          :layout="workspace.layout"
          :panes="workspace.panes"
          :tabs="workspace.tabs"
          :focused-pane-id="workspace.focusedPaneId"
          :edit-state="editState"
          :invoke-workbench="invokeWorkbench"
          :app-state="{ busy: conn.busy, statusText: conn.statusText }"
          :fetch-page="refreshTabPage"
          :load-next-page="loadNextPage"
          :toggle-sort="toggleSort"
          :apply-sort="applySort"
          @focus-pane="focusPane"
          @split-pane="splitPane"
          @close-pane="closePane"
          @resize-split="resizeSplit"
          @activate-tab="activateTab"
          @close-tab="closeTab"
          @reorder-tab="reorderTab"
          @copy-tab-name="copyTabName"
          @tab-contextmenu="openTabContextMenu"
          @table-contextmenu="openActiveTableContextMenu"
          @open-design="openTableDesign"
          @design-applied="handleTableDesignApplied"
          @export="exportTable"
          @import="triggerImport"
          @save-reminder="showSaveReminderAt"
          @state-change="handlePaneStateChange"
          @page-refreshed="clearTabCellErrors"
          @cell-committed="syncCommittedCellToSiblingTabs"
          @schema-search-previous="focusedPaneState.goToPreviousSchemaSearchMatch?.()"
          @schema-search-next="focusedPaneState.goToNextSchemaSearchMatch?.()"
        />
      </section>

      <PaneDivider
        side="right"
        :collapsed="inspectorCollapsed"
        @drag-start="onDividerMouseDown($event, 'inspector')"
        @toggle="toggleInspector()"
      />

      <AgentPanel
        v-if="inspectorMode === 'ai'"
        :class="{ 'is-collapsed': inspectorCollapsed }"
        :style="inspectorStyle"
        :assistant="agent"
        :active-tab="focusedInspectorTab"
        :schema="workspace.schema"
        :selected-cell="focusedSelectedCell"
        :selected-range="focusedSelectedRange"
        @send="sendAgentMessage"
      />
      <InspectorPanel
        v-else
        :class="{ 'is-collapsed': inspectorCollapsed }"
        :style="inspectorStyle"
        :active-tab="focusedInspectorTab"
        :active-columns="focusedActiveColumns"
        :selected-cell="focusedSelectedCell"
        :selected-range="focusedSelectedRange"
        :text-draft="focusedTextDraft"
        :active-status-label="activeStatusLabel"
        :schema-search-query="focusedPaneState.activeDataTab?.schemaSearchQuery || ''"
        :schema-search-matches="focusedPaneState.activeDataTab?.schemaSearchMatches || []"
        :schema-search-index="focusedPaneState.activeDataTab?.schemaSearchIndex ?? -1"
        @update:text-draft="focusedTextDraft = $event"
        @save-text-panel="saveFocusedTextPanel"
        @contextmenu="openActiveTableContextMenu"
      />
    </section>

    <section
      class="wb-operation-status-live wb-visually-hidden"
      :class="{ 'is-error': isStatusError }"
      role="status"
      aria-live="polite"
      :title="statusText"
    >
      {{ statusText }}
    </section>

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
      @send-table="openTableCopyFromContext"
      @rename="openTableRenameFromContext"
      @remove-connection="removeConnectionFromContext"
    />

    <menu
      v-if="tabContextMenu.open"
      class="wb-context-menu wb-tab-context-menu"
      :style="{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }"
      @click.stop
    >
      <button type="button" @click="refreshTabsFromMenu">刷新</button>
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
      @add-exclusions="databaseSync.addSelectedExclusion"
      @remove-exclusion="databaseSync.removeExcludedTable"
    />

    <TableCopyDialog
      v-if="tableCopy.dialog.open"
      :copy="tableCopy"
      :databases="databases"
      :connections="visibleConnections"
      @close="tableCopy.close"
      @execute="executeTableCopy"
      @target-connection-change="handleTableCopyTargetConnection"
    />

    <BackupCenterDialog
      v-if="backupCenter.dialog.open"
      :backup="backupCenter"
      :connections="visibleConnections"
      @close="backupCenter.close"
    />

    <!-- Table Rename Dialog -->
    <div v-if="tableRename.open" class="wb-dialog-overlay" @click.self="closeTableRename">
      <form class="wb-dialog" @submit.prevent="executeTableRename">
        <header class="wb-dialog-header">
          <strong>重命名表</strong>
          <button type="button" class="wb-dialog-close" @click="closeTableRename">×</button>
        </header>
        <p style="margin: 0 0 10px; font-size: 12px; color: var(--wb-secondary-text);">
          {{ tableRename.database }} · {{ tableRename.tableName }}
        </p>
        <label class="wb-dialog-field">
          <span>新名称</span>
          <input v-model="tableRename.newName" placeholder="输入新表名" />
        </label>
        <p v-if="tableRename.error" class="wb-dialog-error">{{ tableRename.error }}</p>
        <footer class="wb-dialog-actions">
          <button type="button" @click="closeTableRename">取消</button>
          <button type="submit" :disabled="tableRename.busy || !tableRename.newName || tableRename.newName === tableRename.tableName">
            {{ tableRename.busy ? "重命名中…" : "重命名表" }}
          </button>
        </footer>
      </form>
    </div>

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
      :test-busy="connTestBusy"
      @submit="submitConnDialog"
      @cancel="cancelConnDialog"
      @test="testConnDialog"
      @field-change="onConnDialogFieldChange"
    />

  </main>
</template>
