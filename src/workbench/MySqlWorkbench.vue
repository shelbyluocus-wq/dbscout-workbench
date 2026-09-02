<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from "vue";
import { Pin } from "lucide-vue-next";

import {
  applyTableSchemaToDataTab,
  reapplyTabColumnOrder,
  buildSchemaSearchResults,
  closeDatabaseTabs,
  closeConnectionTabs,
  closeTableObjectTabs,
  closePaneTabs,
  closePaneTabsRelative,
  closePaneTab,
  discardPaneHomeTabs,
  createWorkspaceState,
  findTableDataTabs,
  getActiveTab,
  getFocusedPane,
  getFocusedTab,
  focusPane as focusWorkspacePane,
  activateTableTab,
  markTableDataTabSchemaStale,
  moveTabBetweenPanes,
  moveTableTab,
  normalizeHomeTabOrder,
  openDatabaseHomeTab,
  openSqlLibraryTab,
  openSqlQueryTab,
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
  recordTableReplaceHistory,
} from "./editState.js";
import { tabRowAt, tabRowCount, tabRows } from "./rowStore.js";
import { createHomeTablePasteCoordinator } from "./homeTablePasteCoordinator.js";
import { invokeWorkbench, isTauriRuntime, listenWorkbenchEvent } from "./utils/tauriBridge.js";
import { formatShortcutForPlatform, isMacOSPlatform } from "./utils/desktopPlatform.js";
import { dispatchSqlExecutionEvent } from "./sqlExecutionState.js";
import { rememberRecentSqlFile } from "./utils/sqlRecentFiles.js";
import { useSqlQueryDocumentStore } from "./composables/sqlQueryDocumentStore.js";
import { MAX_FROZEN_ROWS, MAX_FROZEN_COLS } from "./constants.js";
import { resolveFieldCommentHeight, resolveGridRowHeight } from "./utils/gridRowHeight.js";
import {
  SHORTCUT_LABELS,
  matchesShortcutCombo,
  sameShortcutCombo,
  useShortcuts,
} from "./composables/useShortcuts.js";
import { HOME_DATABASE_FAVORITES_CONTEXT } from "./composables/homeDatabaseFavoritesContext.js";
import { useWindowPin } from "./composables/useWindowPin.js";
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
import { isCustomColumnOrder } from "./utils/columnOrder.js";
import { highlightCellResult as _highlightCellResult } from "./utils/cellDisplay.js";
import { buildRowKey } from "./utils/rowIdentity.js";
import { gridRowKey } from "./utils/gridRowIdentity.js";
import { createRowIndex } from "./utils/rowIndex.js";
import { applyCommittedCellToTab } from "./utils/committedCellSync.js";
import { isGridCellSelected } from "./utils/gridCellSelection.js";
import { markPerf, sampleNextFrame } from "./utils/performanceMarks.js";
import { resolveHomeDesignTargets } from "./utils/homeDesignTargets.js";
import { adjacentPublishedTabId } from "./utils/tabPublication.js";
import { normalizeTableFilterMode } from "./utils/tableFilterMode.js";
import {
  closableRelativeTabsInPane,
  closableTabsInPane,
  guardInsertDraftTabs,
  INSERT_DRAFT_CLOSE_DECISION,
} from "./utils/insertDraftLifecycle.js";
import {
  addPinnedDatabase,
  readPinnedDatabases,
  removePinnedDatabase,
  setPinnedDatabaseShortcut,
  togglePinnedDatabase as togglePinnedInStore,
  removePinnedDatabasesForConnection,
} from "./utils/pinnedDatabases.js";

import WorkbenchSidebar from "./components/WorkbenchSidebar.vue";
import WorkbenchSplitLayout from "./components/WorkbenchSplitLayout.vue";
import DataGrid from "./components/DataGrid.vue";
import TableDesignEditor from "./components/TableDesignEditor.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import AgentPanel from "./components/AgentPanel.vue";
import PaneDivider from "./components/PaneDivider.vue";
import QuickOpenPalette from "./components/QuickOpenPalette.vue";
import ContextMenu from "./components/ContextMenu.vue";
import DatabaseSyncDialog from "./components/DatabaseSyncDialog.vue";
import TableCopyDialog from "./components/TableCopyDialog.vue";
import FindReplaceDialog from "./components/FindReplaceDialog.vue";
import ImportWizardDialog from "./components/ImportWizardDialog.vue";
import BatchExportDialog from "./components/BatchExportDialog.vue";
import BatchImportDialog from "./components/BatchImportDialog.vue";
import DatabaseDisplayDialog from "./components/DatabaseDisplayDialog.vue";
import ConnectionDialog from "./components/ConnectionDialog.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import UpdateNotice from "./components/UpdateNotice.vue";
import BackupCenterDialog from "./components/BackupCenterDialog.vue";
import TableTransferDialog from "./components/TableTransferDialog.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";

import { useConnection } from "./composables/useConnection.js";
import { createDatabaseSwitchGlow, resolveSwitchGlow } from "./composables/useDatabaseSwitchGlow.js";
import { databaseTextColorCss } from "./composables/databaseDecorationStore.js";
import DatabaseGlowOverlay from "./components/DatabaseGlowOverlay.vue";
import { createTableModifiedTimeAutoRefresh } from "./composables/tableModifiedTimeRefresh.js";
import { useTableSession } from "./composables/useTableSession.js";
import { useTableSearch } from "./composables/useTableSearch.js";
import { useVirtualGrid } from "./composables/useVirtualGrid.js";
import { useFreezePanes } from "./composables/useFreezePanes.js";
import { applyResolvedFreeze } from "./utils/freezeSelection.js";
import { useGridEditor } from "./composables/useGridEditor.js";
import { useRowSelection } from "./composables/useRowSelection.js";
import { useContextMenu } from "./composables/useContextMenu.js";
import { useDatabaseSync } from "./composables/useDatabaseSync.js";
import { useBackupCenter } from "./composables/useBackupCenter.js";
import { useTableTransfer } from "./composables/useTableTransfer.js";
import { useAccount } from "./composables/useAccount.js";
import { useTableCopy } from "./composables/useTableCopy.js";
import { useImportWizard } from "./composables/useImportWizard.js";
import { useExport } from "./composables/useExport.js";
import { useBatchTransfer } from "./composables/useBatchTransfer.js";
import { useUndo } from "./composables/useUndo.js";
import { useConfirm } from "./composables/useConfirm.js";
import { useEscClose } from "./composables/useEscClose.js";
import { dialogLayerManager } from "./dialogLayerManager.js";
import {
  INSPECTOR_MIN_WIDTH,
  usePaneResize,
} from "./composables/usePaneResize.js";
import { useQuickOpenClearance } from "./composables/useQuickOpenClearance.js";
import { useTheme } from "./composables/useTheme.js";
import { createColorThemeController } from "./colorThemeController.js";
import { useFontPreference } from "./composables/useFontPreference.js";
import { useUpdater } from "./composables/useUpdater.js";
import { useAgent } from "./composables/useAgent.js";
import { useAgentProjects } from "./composables/useAgentProjects.js";

markPerf("workbench.module-loaded");

const SEARCH_VALUES_PROGRESS_EVENT = "search-values-progress";
const DETAIL_CONTEXT_MENU_HEIGHT = 112;
const usesNativeMacWindowControls = isTauriRuntime() && isMacOSPlatform();

// ── Shared state ──────────────────────────────────────────────────────────
const workspace = reactive(createWorkspaceState());
const sqlDocumentStore = useSqlQueryDocumentStore();
const sqlDocuments = sqlDocumentStore.documents;
const editState = reactive(createEditState());
const sidebarSearch = reactive(createSidebarSearchState());
const quickOpenValueSearch = reactive(createSidebarSearchState());
const treeQuery = computed({
  get: () => sidebarSearch.query,
  set: (value) => setSidebarSearchQuery(sidebarSearch, value),
});
const tabContextMenu = reactive({ open: false, x: 0, y: 0, paneId: "", tabId: "" });
const tableRename = reactive({ open: false, connectionId: "", database: "", tableName: "", newName: "", busy: false, error: "" });
const tableRenameDialogRef = ref(null);
const homeTableClipboard = ref(null);
const recentHomeTableNames = ref([]);
// 本地别名编辑（连接 / 数据库通用）：仅改本地显示，不改真实名。
const aliasDialog = reactive({ open: false, type: "database", connectionId: "", database: "", realName: "", alias: "", icon: "database", color: "", textColor: "" });
const connectionAliasDialogRef = ref(null);

useEscClose(() => tableRename.open, closeTableRename, () => tableRename.busy, { dialogRef: tableRenameDialogRef });
useEscClose(
  () => aliasDialog.open && aliasDialog.type === "connection",
  closeAliasDialog,
  null,
  { dialogRef: connectionAliasDialogRef },
);
const saveReminders = ref([]);
let nextSaveReminderId = 1;
const SAVE_REMINDER_DURATION_MS = Object.freeze({ default: 1300, error: 4000, warning: 4000 });
const sidebarRef = ref(null);
// Quick Open 浮层（Ctrl+P 快速切表 + 切库）。独立于侧栏内嵌搜索框，侧栏收起/
// 展开态均可触发，契合"降低信息密度、保留留白"的诉求。
const quickOpenVisible = ref(false);
const findReplaceVisible = ref(false);
const findReplaceTab = ref("find");
const quickOpenQuery = ref("");
// 常驻数据库（跨连接混合展示），持久化到 localStorage。
const pinnedDatabases = ref(readPinnedDatabases());
// 浮层打开时预拉取所有可见连接的库列表，供「连接 → 库」级联子菜单即时展示。
// 关闭时不清缓存（连接未变则下次命中），但每次打开都重新拉取以反映远端变更。
watch(quickOpenVisible, (open) => {
  if (open) fetchAllConnectionsDatabases();
});
// Shortcut bindings (persisted in localStorage; the settings dialog can
// rebind the global "open window" shortcut via the Rust backend). Used so
// the Ctrl+P database-search shortcut reads the configured binding (#8/#9).
const shortcutHelper = useShortcuts(invokeWorkbench);
const quickOpenShortcutLabel = computed(() =>
  formatShortcutForPlatform(shortcutHelper.get("searchDatabase")),
);
const quickOpenEntryTitle = computed(() =>
  quickOpenShortcutLabel.value
    ? `快速打开（${quickOpenShortcutLabel.value}）`
    : "快速打开",
);
const quickOpenEntryAriaLabel = computed(() =>
  quickOpenShortcutLabel.value
    ? `快速打开表和搜索值（${quickOpenShortcutLabel.value}）`
    : "快速打开表和搜索值",
);
const windowPin = useWindowPin();
const windowPinButtonLabel = computed(() => {
  const action = windowPin.pinned.value ? "解除钉住" : "钉住窗口";
  const shortcut = shortcutHelper.get("pinWindow");
  return shortcut ? `${action}（${shortcut}）` : action;
});

// On startup, push the persisted global "open window" binding to the Rust
// backend so a user-rebound shortcut overrides the hardcoded Alt+Shift+F this
// session (analysis point #2). Best-effort: in mock/browser dev there is no
// backend command, and registration errors must not block the UI.
async function syncGlobalShortcutBinding() {
  const binding = shortcutHelper.get("openWindow");
  if (!binding) return;
  try {
    await invokeWorkbench("register_global_shortcut", { binding });
  } catch {
    // Non-fatal: the Rust default (Alt+Shift+F) remains active.
  }
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value ?? "")) : String(value ?? "").replace(/["\\]/g, "\\$&");
}

const HOME_FIELD_COUNT_LOAD_CONCURRENCY = 4;
const homeFieldCountInFlight = new Set();

// ── Composables ───────────────────────────────────────────────────────────
const conn = useConnection(workspace, invokeWorkbench);
const {
  connections,
  visibleConnections,
  databases,
  databasesByConnection,
  databaseFetchErrors,
  fetchDatabasesForConnection,
  fetchAllConnectionsDatabases,
  getDatabaseAlias,
  setDatabaseAlias,
  databaseLabel,
  getConnectionAlias,
  setConnectionAlias,
  connectionLabel,
  getDatabaseDecoration,
  setDatabaseDecoration,
  selectedConnectionId,
  selectedDatabase,
  connDialog,
  busy,
  connTestBusy,
  statusText,
  statusError,
  setStatus,
  loadConnections,
  selectConnection,
  selectDatabase,
  reorderConnections,
  reorderDatabases,
  loadTables,
  refreshTableModifiedTimes,
  ensureTableSchema,
  isReadOnlyConnection,
  openConnDialog,
  cancelConnDialog,
  applyConnConfigImport,
  rejectConnConfigImport,
  testConnDialog,
  onConnDialogFieldChange,
  submitConnDialog,
  removeConnection,
  dispose: disposeConnection,
} = conn;

const tableModifiedTimeAutoRefresh = createTableModifiedTimeAutoRefresh({
  refresh: refreshTableModifiedTimes,
  getSource: () => ({
    connectionId: selectedConnectionId.value,
    database: selectedDatabase.value,
  }),
});

const homeTablePasteCoordinator = createHomeTablePasteCoordinator({
  getCommittedSource: () => ({
    connectionId: workspace.connectionId,
    database: workspace.database,
  }),
  onWaitForNavigation: ({ database }) => {
    statusText.value = `正在切换到 ${database}，完成后继续粘贴…`;
  },
});

const selectDatabaseWithHome = async (event) => {
  await openDatabaseHomeTarget(event);
};

watch(
  () => [selectedConnectionId.value, selectedDatabase.value],
  () => {
    clearValueSearchResults(sidebarSearch);
    clearValueSearchResults(quickOpenValueSearch);
    sidebarSearch.valueSearchToken += 1;
    quickOpenValueSearch.valueSearchToken += 1;
  },
  { deep: false },
);

const {
  openTable,
  pendingTableOpenCount,
  cancelPendingTableActivation,
  fetchPage,
  loadNextPage,
  loadPreviousPage,
  jumpToTableBoundary,
  loadSearchResultPage,
  loadNextSearchResultPage,
  cancelSearchResultPage,
  reopenTableSession,
  toggleSort,
  applySort,
  dispose: disposeTableSessions,
} = useTableSession(
  workspace,
  invokeWorkbench,
  {
    busy: conn.busy,
    statusText: conn.statusText,
    setStatus: conn.setStatus,
    ensureTableSchema: conn.ensureTableSchema,
  },
);

const focusedPaneState = reactive({
  paneId: "",
  activeDataTab: null,
  activeDesignTab: null,
  activeHomeTab: null,
  activeColumns: [],
  selectedCell: null,
  selectedRange: null,
  textDraft: "",
  setTextDraft: null,
  saveTextPanel: null,
  commitInsertRowsAndRefresh: null,
  prepareInsertDraftsForRefresh: null,
  clearInsertDraftsAfterRefresh: null,
  insertDraftAbove: null,
  insertDraftBelow: null,
  insertDraftsAbove: null,
  insertDraftsBelow: null,
  pasteCopiedRowsAbove: null,
  deleteRow: null,
  handleWorkbenchKeydown: null,
  clearSelection: null,
  resetGridScroll: null,
  selectCellAt: null,
  selectVisualCellAt: null,
  selectCurrentRowColumn: null,
  selectInsertCell: null,
  scrollColumnIntoView: null,
  focusTableSearch: null,
  focusCurrentSearch: null,
  runTableSearch: null,
  refreshCurrentSearchMatches: null,
  goToNextSearchMatch: null,
  goToPreviousSearchMatch: null,
  replaceActiveSearchMatch: null,
  replaceCellsInSelection: null,
  countSelectionMatches: null,
  findNextSelectionMatch: null,
  replaceSelectionMatch: null,
  activeSearchQuery: "",
  searchMatchCount: 0,
  hasSearchMatches: false,
  applyColumnSearch: null,
  goToNextSchemaSearchMatch: null,
  goToPreviousSchemaSearchMatch: null,
  copyHomeSelection: null,
  pasteHomeTables: null,
  copyGridSelection: null,
  pasteGridSelection: null,
  captureActiveTableViewState: null,
  isEditing: () => false,
  commitEditingWithoutRefocus: () => {},
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
const focusedHomeInspectorSchema = computed(() => {
  const home = focusedPaneState.activeHomeTab || (activeTab.value?.kind === "home" ? activeTab.value : null);
  const tableName = String(home?.focusedTableName || home?.selectedTableNames?.at?.(-1) || "");
  if (!home || !tableName) return null;
  const schema = workspace.schema.find((table) => normalizeTableName(table) === tableName) || null;
  return schema ? { home, schema, tableName } : { home, schema: null, tableName };
});
const activeSqlTab = computed(() => activeTab.value?.kind === "sql" ? activeTab.value : null);
const focusedInspectorTab = computed(() => {
  if (focusedPaneState.activeDataTab) return focusedPaneState.activeDataTab;
  const homeTarget = focusedHomeInspectorSchema.value;
  if (homeTarget) {
    return {
      ...homeTarget.home,
      kind: "home-inspector",
      tableName: homeTarget.tableName,
      tableComment: normalizeTableComment(homeTarget.schema) || homeTarget.home.focusedTableComment || "",
      columns: homeTarget.schema?.columns || [],
    };
  }
  return activeTab.value || null;
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
const quickOpenSchemaSearchResults = computed(() =>
  buildSchemaSearchResults(schemaSearchSource.value, quickOpenQuery.value),
);
const filteredTables = computed(() => schemaSearchResults.value.map((result) => result.table));

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
  scrollTop,
  viewportHeight,
} = useVirtualGrid(activeDataTab, editState);
const fallbackFreezePanes = useFreezePanes();

function applyFocusedFreezeTarget(tab, target) {
  if (typeof focusedPaneState.applyFreezeTarget === "function") {
    return focusedPaneState.applyFreezeTarget(target);
  }
  return applyResolvedFreeze({
    freezePanes: fallbackFreezePanes,
    tab,
    target,
    scrollTop: gridWrapRef.value?.scrollTop ?? scrollTop.value,
    viewportHeight: gridWrapRef.value?.clientHeight ?? viewportHeight.value,
  });
}

const editor = useGridEditor(
  editState,
  invokeWorkbench,
  activeDataTab,
  gridWrapRef,
  { scrollRowIntoView, scrollCellIntoView, scrollInsertCellIntoView },
  {
    busy: conn.busy,
    statusText: conn.statusText,
    onSaveFeedback: showSaveReminder,
    onCellCommitted: syncCommittedCellToSiblingTabs,
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
  isInsertRowSaving,
  getInsertRows,
  getInsertRowKey,
  clearSelection,
  focusTextCell,
  selectCell,
  consumeCellPointerClick,
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
  insertDraftAbove,
  insertDraftBelow,
  insertDraftsAbove,
  insertDraftsBelow,
  canInsertCopiedRows,
  insertCopiedRowsAbove,
  selectInsertRow,
  removeInsertDraftRow,
  removeInsertDraftRows,
  applyInsertDraftHistoryEntry,
  handleInsertKeydown,
  commitCellValue,
  saveTextPanel,
  commitInsertRows,
  handleGridKeydown,
  getInsertDraft,
  updateInsertDraft,
  clearInsertDraft,
  pasteIntoInsertInput,
  setCellToNull,
} = editor;

const focusedActiveColumns = computed(() =>
  focusedHomeInspectorSchema.value
    ? focusedHomeInspectorSchema.value.schema?.columns || []
    : focusedPaneState.activeDataTab?.id === activeDataTab.value?.id ? focusedPaneState.activeColumns : activeColumns.value || [],
);
const focusedSelectedCell = computed(() =>
  focusedPaneState.selectedCell?.tabId === activeDataTab.value?.id ? focusedPaneState.selectedCell : selectedCell.value || null,
);
const focusedSelectedRange = computed(() =>
  focusedPaneState.selectedRange?.tabId === activeDataTab.value?.id ? focusedPaneState.selectedRange : selectedRange.value || null,
);

watch(
  focusedSelectedCell,
  (cell) => {
    workspace.selectedCell = cell ? { ...cell } : null;
  },
  { immediate: true },
);
// Whether the focused cell's column may be set to SQL NULL via the context
// menu: requires a selected data cell on a nullable, non-primary-key column.
const canSetCellNull = computed(() => {
  const cell = focusedPaneState.selectedCell || selectedCell.value;
  if (!cell?.column) return false;
  // 表格本体的通用菜单也会覆盖表头与空画布。只有右键确实命中了
  // 数据单元格时才显示「设为 NULL」，避免把旧选区误当作右键目标。
  if (
    contextMenu.surface === "grid" &&
    contextMenu.kind !== "grid-row" &&
    (!Number.isFinite(Number(contextMenu.anchorIndex)) || Number(contextMenu.targetColumnIndex) < 0)
  ) return false;
  const columns = focusedPaneState.activeDataTab?.id === cell.tabId
    ? (focusedPaneState.activeColumns || [])
    : activeColumns.value || [];
  const column = columns.find((item) => (item.column_name || item.columnName) === cell.column);
  if (!column) return false;
  const isPk = Boolean(column.is_primary_key || column.isPrimaryKey);
  const isNullable = column.is_nullable ?? column.isNullable ?? column.nullable;
  return !isPk && Boolean(isNullable);
});

// ── Freeze panes context-menu state ───────────────────────────────────────
// The freeze menu acts on the focused tab. 「冻结到此行」uses the right-clicked
// row as the lower-pane boundary; 「冻结到此列」uses the selected cell's column index
// (row right-click happens on the row-index gutter, so the column comes from
// the currently selected data cell) or the right-clicked column (table/menu).
const focusedFreezeTab = computed(() => focusedPaneState.activeDataTab || activeDataTab.value);

// Column index targeted by the context menu: prefer the menu's recorded target
// (set when right-clicking a column header / data cell), else the selected cell.
const contextMenuTargetColumnIndex = computed(() => {
  const idx = Number(contextMenu.targetColumnIndex);
  if (Number.isFinite(idx) && idx >= 0) return idx;
  const cell = focusedPaneState.selectedCell || selectedCell.value;
  if (!cell?.column) return -1;
  const columns = columnsForCell(cell);
  const i = columns.findIndex((item) => (item.column_name || item.columnName) === cell.column);
  return i;
});

function columnsForCell(cell) {
  return focusedPaneState.activeDataTab?.id === cell.tabId
    ? (focusedPaneState.activeColumns || [])
    : activeColumns.value || [];
}

const hasFreeze = computed(() => {
  const tab = focusedFreezeTab.value;
  return Boolean(tab && (Number(tab.frozenRowCount) > 0 || Number(tab.frozenColumnCount) > 0));
});

const canFreezeRow = computed(() => {
  const tab = focusedFreezeTab.value;
  if (tabRowCount(tab) === 0) return false;
  return contextMenu.kind === "grid-row" && Number.isFinite(contextMenu.anchorIndex);
});

const canFreezeColumn = computed(() => contextMenuTargetColumnIndex.value >= 0);

// 「冻结到此单元格」：同时钉住该单元格上方所有行 + 左侧所有列（Excel「冻结窗格」语义）。
// 当右键能同时取到行（anchorIndex 或从 selectedCell 反查）和列时出现。
const contextMenuTargetRowIndex = computed(() => {
  // 行右键时直接有 anchorIndex
  const idx = Number(contextMenu.anchorIndex);
  if (Number.isFinite(idx) && idx >= 0) return idx;
  // 表格右键（数据单元格）时，从 selectedCell 的 rowKey 反查行号
  const cell = focusedPaneState.selectedCell || selectedCell.value;
  if (!cell?.rowKey) return -1;
  const tab = focusedFreezeTab.value;
  if (tabRowCount(tab) === 0) return -1;
  return createRowIndex(tab, { buildRowKey }).indexOfKey(cell.rowKey);
});

const canFreezeCell = computed(() => {
  const tab = focusedFreezeTab.value;
  if (tabRowCount(tab) === 0) return false;
  return contextMenuTargetRowIndex.value >= 0 && contextMenuTargetColumnIndex.value >= 0;
});

const freezeCellLabel = computed(() => {
  const r = contextMenuTargetRowIndex.value;
  const c = contextMenuTargetColumnIndex.value;
  if (r >= 0 && c >= 0) return `冻结到第 ${r + 1} 行第 ${c + 1} 列`;
  return "冻结到此单元格";
});

const freezeRowLabel = computed(() => {
  const idx = contextMenu.anchorIndex;
  return Number.isFinite(idx) ? `冻结到第 ${idx + 1} 行` : "冻结到此行";
});

const freezeColumnLabel = computed(() => {
  const idx = contextMenuTargetColumnIndex.value;
  return idx >= 0 ? `冻结到第 ${idx + 1} 列` : "冻结到此列";
});

function onFreezeRow() {
  const tab = focusedFreezeTab.value;
  const idx = contextMenu.anchorIndex;
  closeContextMenu();
  if (!tab || !Number.isFinite(idx)) return;
  // Excel semantics: the clicked row starts the lower pane; rows above it
  // remain frozen without changing the current viewport.
  applyFocusedFreezeTarget(tab, { freezeRows: Math.max(0, Math.floor(idx)), freezeColumns: 0 });
}
function onFreezeColumn() {
  const tab = focusedFreezeTab.value;
  const idx = contextMenuTargetColumnIndex.value;
  closeContextMenu();
  if (!tab || idx < 0) return;
  // 替换语义：只冻列，清掉行冻结。
  tab.frozenColumnCount = Math.max(0, Math.min(MAX_FROZEN_COLS, idx + 1));
  tab.frozenRowStart = 0;
  tab.frozenRowCount = 0;
}
function onFreezeCell() {
  const tab = focusedFreezeTab.value;
  const r = contextMenuTargetRowIndex.value;
  const c = contextMenuTargetColumnIndex.value;
  closeContextMenu();
  if (!tab || r < 0 || c < 0) return;
  applyFocusedFreezeTarget(tab, {
    freezeRows: Math.max(0, Math.floor(r)),
    freezeColumns: Math.max(0, Math.min(MAX_FROZEN_COLS, c + 1)),
  });
}
function onFreezeTopRow() {
  const tab = focusedFreezeTab.value;
  closeContextMenu();
  if (!tab) return;
  // 切换：已有冻结则清空，否则只冻首行（替换列冻结）。
  if (tab.frozenRowCount > 0 || tab.frozenColumnCount > 0) {
    tab.frozenRowStart = 0;
    tab.frozenRowCount = 0;
    tab.frozenColumnCount = 0;
  } else {
    tab.frozenRowStart = 0;
    tab.frozenRowCount = 1;
    tab.frozenColumnCount = 0;
  }
}
function onFreezeFirstColumn() {
  const tab = focusedFreezeTab.value;
  closeContextMenu();
  if (!tab) return;
  if (tab.frozenRowCount > 0 || tab.frozenColumnCount > 0) {
    tab.frozenRowStart = 0;
    tab.frozenRowCount = 0;
    tab.frozenColumnCount = 0;
  } else {
    tab.frozenRowStart = 0;
    tab.frozenRowCount = 0;
    tab.frozenColumnCount = 1;
  }
}
function onUnfreeze() {
  const tab = focusedFreezeTab.value;
  closeContextMenu();
  if (!tab) return;
  tab.frozenRowStart = 0;
  tab.frozenRowCount = 0;
  tab.frozenColumnCount = 0;
}

const canResetColumnOrder = computed(() => {
  const tab = focusedFreezeTab.value;
  return Boolean(
    contextMenu.fromColumnHeader
    && tab
    && isCustomColumnOrder(tab.columns, tab.schemaColumnNames),
  );
});

function onResetColumnOrder() {
  closeContextMenu();
  focusedPaneState.resetGridColumnOrder?.(focusedFreezeTab.value);
}
// 右键行菜单的删除按钮文字：选中多行时显示「删除 X 行」。
const contextMenuDeleteLabel = computed(() => {
  const count = contextMenu.selectedRowCount || 0;
  return count > 1 ? `删除 ${count} 行` : "删除行";
});
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
  selectedRowIndexes: selectedGridRowIndexes,
  allRowEntries: gridRowEntries,
  deleteSelectedRows,
  deleteRow,
} =
  useRowSelection(invokeWorkbench, { statusText: conn.statusText }, {
    fetchPage: refreshTabPage,
    getVisualRowModel: editor.visualRowEntries,
    removeInsertRows: removeInsertDraftRows,
  });

const {
  contextMenu,
  contextMenuStyle,
  openContextMenu,
  openRowContextMenu,
  closeContextMenu,
  copyFromContextMenu,
  pasteFromContextMenu,
  refreshFromContextMenu,
  openDesignFromContextMenu,
  renameFromContextMenu,
  renameDatabaseFromContextMenu,
  renameConnectionFromContextMenu,
} = useContextMenu(
  { statusText: conn.statusText },
  {
    loadTables: conn.loadTables,
    ensureTableSchema: conn.ensureTableSchema,
    fetchPage: refreshTabPage,
    refreshDatabases: conn.refreshDatabases,
  },
  activeDataTab,
  { openTableDesign, onTablePageRefreshed: resumeSearchAfterTableRefresh },
);

async function resumeSearchAfterTableRefresh(tab) {
  clearTabCellErrors(tab);
  if (focusedPaneState.activeDataTab?.id !== tab?.id) return;
  await focusedPaneState.resumeCurrentSearchResults?.({ select: true });
}

let unlistenValueSearchProgress = null;
let unlistenSqlExecution = null;

function handleSqlExecutionEvent(event) {
  const payload = event?.payload || event || {};
  dispatchSqlExecutionEvent(workspace, payload);
  if (payload.type === "schema-changed") {
    void conn.loadTables({ connectionId: payload.connectionId, database: payload.database }).catch(() => {});
  }
}

async function ensureSqlExecutionListener() {
  if (unlistenSqlExecution) return;
  const unlisten = await listenWorkbenchEvent("sql-execution-event", handleSqlExecutionEvent);
  unlistenSqlExecution = typeof unlisten === "function" ? unlisten : null;
}

function handleValueSearchProgress(event) {
  const payload = event?.payload || event || {};
  const updatedSidebar = updateValueSearchProgress(sidebarSearch, payload);
  const updatedQuickOpen = updateValueSearchProgress(quickOpenValueSearch, payload);
  const progressState = updatedQuickOpen ? quickOpenValueSearch : updatedSidebar ? sidebarSearch : null;
  if (progressState) {
    const done = progressState.valueProgress.done || 0;
    const total = progressState.valueProgress.total || 0;
    const matches = progressState.valueProgress.matches || 0;
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

// 一键转表：打开对话框，由用户点「开始转表」再跑脚本 → SVN → 覆盖拷贝。
const tableTransfer = useTableTransfer({
  invokeWorkbench,
  listen: listenWorkbenchEvent,
});

function openTableTransfer() {
  if (tableTransfer.dialog.open) return;
  tableTransfer.open();
}

const account = useAccount({
  onSessionChanged: async () => {
    // After login/logout, refresh the audit view. If the user just logged in
    // and the dialog is showing the audit tab, switch to the shared view so
    // they immediately see everyone's changes.
    if (backupCenter.dialog.open && backupCenter.dialog.tab === "audit") {
      if (account.isLoggedIn.value && backupCenter.auditMode.mode !== "shared") {
        await backupCenter.setAuditMode("shared");
      } else {
        await backupCenter.loadAuditLogs();
      }
    }
  },
});

async function openBackupCenter() {
  // Change logs are a cross-connection history, so open with the broadest
  // view instead of silently narrowing the list to the active workspace.
  backupCenter.setFilters({ connectionId: "", database: "", tableName: "" });
  // Ensure the account state is fresh before the dialog reads it.
  await account.loadAccount();
  backupCenter.open();
}

const tableCopy = useTableCopy({
  connections,
  invokeWorkbench,
});

const {
  importWizard,
  triggerImport,
  selectImportFile,
  onImportFileSelected,
  parseImportSheet,
  goToImportStep,
  executeImport,
  compareImportChanges,
  cancelImport,
  closeImportWizard,
} = useImportWizard(
  invokeWorkbench,
  activeDataTab,
  { fetchPage: refreshTabPage, reopenTableSession },
  { statusText: conn.statusText },
);

const { exportTable } = useExport(invokeWorkbench, {
  statusText: conn.statusText,
  onSuccessFeedback: (message) => showWorkbenchReminder("export-success", message),
});
const batchTransfer = useBatchTransfer({
  invokeWorkbench,
  statusText: conn.statusText,
  onSuccessFeedback: (message) => showWorkbenchReminder("export-success", message),
  onWarningFeedback: (message) => showWorkbenchReminder("warning", message),
});

const { handleUndoKeydown, handleRedoKeydown } = useUndo(editState, invokeWorkbench, activeDataTab, {
  statusText: conn.statusText,
  applyLocalHistoryEntry: applyInsertDraftHistoryEntry,
  captureHistoryView: editor.captureHistoryViewState,
  onHistoryApplied: editor.syncSelectionAfterHistory,
  onCellCommitted: syncCommittedCellToSiblingTabs,
});

// 全局确认对话框：替代原生 window.confirm，提供统一的视觉风格。
const { confirmDialog: globalConfirmDialog, confirm: confirmDialogConfirm, close: closeGlobalConfirm } = useConfirm();

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

const { quickOpenEntryRef, quickOpenClearanceVars } = useQuickOpenClearance();
const { effectiveTheme, isDark, toggleTheme } = useTheme();
const {
  currentTheme: currentColorTheme,
  themes: colorThemes,
  setColorTheme,
  start: startColorTheme,
} = createColorThemeController();
startColorTheme();
// 切库流光：跨数据库切换标签时沿内容区三边播放流光并浮现库名（见 watcher 与 DatabaseGlowOverlay）
const { playback: switchGlowPlayback, play: playSwitchGlow } = createDatabaseSwitchGlow();

// 触发口径：打开的标签覆盖 ≥2 个数据库，且切到另一个库的标签才播放（同库互切不播）。
// 分屏焦点切换、关闭标签导致的激活变化同样走这里；启动恢复时 prevTabId 为空，自然不播。
watch(
  () => workspace.activeTabId,
  (nextTabId, prevTabId) => {
    const hit = resolveSwitchGlow({ tabs: workspace.tabs, prevTabId, nextTabId });
    if (!hit) return;
    const connection = connections.value.find((item) => item.id === hit.connectionId);
    const decoration = getDatabaseDecoration(hit.connectionId, hit.database);
    playSwitchGlow({
      service: connectionLabel(hit.connectionId, connection?.label || ""),
      label: databaseLabel(hit.connectionId, hit.database),
      markerColor: databaseTextColorCss(decoration?.textColor) || decoration?.color || "",
    });
  },
);
const {
  preference: fontPreference,
  weight: fontWeight,
  label: fontLabel,
  setPreference: setFontPreference,
  setWeight: setFontWeight,
} = useFontPreference();
const workbenchFontSignature = computed(() => `${fontPreference.value}\u001f${fontWeight.value}`);

function applyFontSettings(settings) {
  setFontPreference(settings?.preference);
  setFontWeight(settings?.weight);
}

provide("suspendGridAutoFit", sidebarPaneAnimating);
provide("workbenchFontSignature", workbenchFontSignature);
provide("theme", effectiveTheme);
provide(HOME_DATABASE_FAVORITES_CONTEXT, {
  favorites: pinnedDatabases,
  connections: visibleConnections,
  databases,
  databasesByConnection,
  databaseFetchErrors,
  currentConnectionId: selectedConnectionId,
  currentDatabase: selectedDatabase,
  theme: effectiveTheme,
  loadDatabases: loadFavoriteDatabaseOptions,
  openDatabase: openFavoriteDatabase,
  addFavorite: addFavoriteDatabase,
  removeFavorite: removeFavoriteDatabase,
  setShortcut: updateFavoriteDatabaseShortcut,
});
const updater = useUpdater();
const agentProjects = useAgentProjects(invokeWorkbench);
const agent = useAgent(workspace, invokeWorkbench, agentProjects);
watch(
  () => updater.agentRuntimeUpdate.value,
  (update) => {
    if (!update?.available) return;
    void agent.handleAvailableRuntimeUpdate(update).then((installed) => {
      if (installed) updater.markAgentRuntimeHandled(update.version);
    });
  },
);
const inspectorMode = ref("notes");
// 错误态判定：先用显式的结构化标志（statusError），回退到关键词启发式，
// 兼容那些直接给 statusText 赋值而未设置标志的历史调用点。
const isStatusError = computed(
  () => Boolean(statusError.value) || /失败|错误|不能|冲突|重复|超时|拒绝/.test(statusText.value || ""),
);

// 窗口宽度检测：窄窗口下提示收起侧边栏，避免网格被挤到不可用。
const windowWidth = ref(typeof window !== "undefined" ? window.innerWidth : 1280);
function onWindowResize() {
  windowWidth.value = window.innerWidth;
}
// 窄窗口且侧边栏仍展开时显示提示条。
const showNarrowHint = computed(
  () => !sidebarCollapsed.value && windowWidth.value > 0 && windowWidth.value < 1000,
);
// "只看当前表"：关闭除当前聚焦分屏外的所有分屏，回到单分屏布局。
function focusCurrentTableOnly() {
  const panes = workspace.panes ? Object.values(workspace.panes) : [];
  for (const pane of panes) {
    if (pane.id && pane.id !== workspace.focusedPaneId) {
      closePane(pane.id);
    }
  }
}

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
    : `${Math.max(inspectorWidth.value, INSPECTOR_MIN_WIDTH)}px`,
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
  }, saveReminderDuration(kind));
}

function saveReminderDuration(kind) {
  return SAVE_REMINDER_DURATION_MS[kind] ?? SAVE_REMINDER_DURATION_MS.default;
}

function showSaveReminderAt({ x, y, kind, message }) {
  const id = nextSaveReminderId++;
  saveReminders.value = [
    ...saveReminders.value.slice(-4),
    { id, kind, message, x, y },
  ];
  globalThis.setTimeout?.(() => {
    saveReminders.value = saveReminders.value.filter((reminder) => reminder.id !== id);
  }, saveReminderDuration(kind));
}

function showWorkbenchReminder(kind, message) {
  const rootRect = paneWorkspaceRef.value?.getBoundingClientRect?.();
  showSaveReminderAt({
    kind,
    message,
    x: rootRect ? Math.max(72, rootRect.width / 2 - 36) : 160,
    y: 58,
  });
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

function openCurrentDatabaseHome({ paneId = workspace.focusedPaneId, activate = true } = {}) {
  if (!selectedDatabase.value) return null;
  return openDatabaseHomeTab(workspace, {
    connectionId: selectedConnectionId.value,
    database: selectedDatabase.value,
    readOnly: isReadOnlyConnection(selectedConnectionId.value),
  }, { paneId, activate });
}

function ensureCurrentDatabaseHome() {
  const activate = !workspace.activeTabId;
  return openCurrentDatabaseHome({ activate });
}

function openSqlLibrary(paneId = workspace.focusedPaneId) {
  return openSqlLibraryTab(workspace, { paneId, activate: true });
}

function openSqlQuery({ paneId = workspace.focusedPaneId, values = {} } = {}) {
  const document = values.documentId
    ? sqlDocumentStore.findDocument(values.documentId)
    : sqlDocumentStore.createDocument({
        connectionId: selectedConnectionId.value,
        database: selectedDatabase.value,
        readOnly: isReadOnlyConnection(selectedConnectionId.value),
        ...values,
      });
  const source = document || values;
  const tab = openSqlQueryTab(workspace, {
    connectionId: source.connectionId || selectedConnectionId.value,
    database: source.database || selectedDatabase.value,
    readOnly: source.readOnly ?? isReadOnlyConnection(source.connectionId || selectedConnectionId.value),
    ...source,
    documentId: document?.id || values.documentId || "",
  }, { paneId, activate: true });
  if (tab) sqlDocumentStore.upsertFromTab(tab);
  return tab;
}

function paneIdForTab(tabId) {
  return Object.values(workspace.panes || {}).find((pane) => pane.tabIds?.includes(tabId))?.id || "";
}

function syncSqlDocumentsFromTabs() {
  workspace.tabs.filter((tab) => tab.kind === "sql").forEach((tab) => sqlDocumentStore.upsertFromTab(tab));
}

async function openSqlDocument({ documentId } = {}, paneId = workspace.focusedPaneId) {
  const document = sqlDocumentStore.findDocument(documentId);
  if (!document) return null;
  const existing = workspace.tabs.find((tab) => tab.kind === "sql" && tab.documentId === document.id);
  sqlDocumentStore.markOpened(document.id);
  if (existing) {
    await activateTab(paneIdForTab(existing.id) || paneId, existing.id);
    return existing;
  }
  if (document.connectionId && document.connectionId !== selectedConnectionId.value) {
    await selectConnection(document.connectionId);
  }
  if (document.database && document.database !== selectedDatabase.value) {
    await selectDatabase({ connectionId: document.connectionId, database: document.database });
  }
  return openSqlQuery({ paneId, values: { ...document, documentId: document.id } });
}

function newSqlQuery(values = {}, paneId = workspace.focusedPaneId) {
  return openSqlQuery({ paneId, values });
}

async function duplicateSqlDocument({ documentId } = {}, paneId = workspace.focusedPaneId) {
  const document = sqlDocumentStore.duplicateDocument(documentId);
  if (!document) return null;
  return openSqlDocument({ documentId: document.id }, paneId);
}

function renameSqlDocument({ documentId, title } = {}) {
  const document = sqlDocumentStore.updateDocument(documentId, { title: String(title || "").trim() });
  if (!document) return;
  workspace.tabs
    .filter((tab) => tab.kind === "sql" && tab.documentId === document.id)
    .forEach((tab) => { tab.title = document.title; });
}

async function deleteSqlDocument({ documentId } = {}) {
  const document = sqlDocumentStore.findDocument(documentId);
  if (!document) return;
  const confirmed = await confirmDialogConfirm({
    title: `删除“${document.title}”？`,
    message: document.filePath
      ? "查询将从黑猫的查询列表中删除，磁盘上的 SQL 文件会保留。"
      : "查询内容将从本机查询列表中删除，且无法恢复。",
    confirmText: "删除查询",
    cancelText: "保留查询",
    danger: true,
  });
  if (!confirmed) return;
  const openTabs = workspace.tabs.filter((tab) => tab.kind === "sql" && tab.documentId === document.id);
  for (const tab of openTabs) {
    if (!(await guardSqlTabDeparture(tab, { skipUnsaved: true }))) return;
    closePaneTab(workspace, paneIdForTab(tab.id), tab.id);
  }
  sqlDocumentStore.removeDocument(document.id);
  pruneEmptyPanesInLayout(workspace);
}

async function openSqlFile({ path = "" } = {}, paneId = workspace.focusedPaneId) {
  const knownDocument = path ? sqlDocumentStore.findByFilePath(path) : null;
  if (knownDocument) return openSqlDocument({ documentId: knownDocument.id }, paneId);
  try {
    const result = await invokeWorkbench("open_sql_file", { path: path || null });
    if (!result) return null;
    rememberRecentSqlFile(result);
    const existing = sqlDocumentStore.findByFilePath(result.path);
    const values = {
      title: result.fileName,
      fileName: result.fileName,
      filePath: result.path,
      sql: result.content,
      savedSql: result.content,
      dirty: false,
      connectionId: selectedConnectionId.value,
      database: selectedDatabase.value,
      readOnly: isReadOnlyConnection(selectedConnectionId.value),
    };
    const document = existing
      ? sqlDocumentStore.updateDocument(existing.id, values)
      : sqlDocumentStore.createDocument(values);
    return openSqlDocument({ documentId: document.id }, paneId);
  } catch (error) {
    if (!String(error).includes("取消")) statusText.value = `打开 SQL 文件失败：${String(error)}`;
    return null;
  }
}

async function saveSqlTab(tab, { saveAs = false } = {}) {
  try {
    const result = await invokeWorkbench("save_sql_file", {
      request: {
        path: saveAs ? null : tab.filePath || null,
        fileName: tab.fileName || `${tab.title || "query"}.sql`,
        content: tab.sql || "",
      },
    });
    tab.filePath = String(result.path || tab.filePath || "");
    tab.fileName = String(result.fileName || tab.fileName || "");
    tab.title = tab.fileName || tab.title;
    tab.savedSql = tab.sql || "";
    tab.dirty = false;
    rememberRecentSqlFile(result);
    return true;
  } catch (error) {
    if (!String(error).includes("取消")) statusText.value = `保存 SQL 失败：${String(error)}`;
    return false;
  }
}

async function guardSqlTabDeparture(tab, { skipUnsaved = false } = {}) {
  if (!tab || tab.kind !== "sql") return true;
  if (tab.running) {
    const stop = await confirmDialogConfirm({
      title: "查询仍在执行",
      message: "停止当前查询后再离开此标签？",
      confirmText: "停止并继续",
      cancelText: "留在当前标签",
      danger: true,
    });
    if (!stop) return false;
    if (tab.jobId) await invokeWorkbench("cancel_sql_execution", { jobId: tab.jobId }).catch(() => {});
  }
  if (tab.transactionSessionId) {
    const commit = await confirmDialogConfirm({
      title: "事务尚未提交",
      message: "提交当前事务后继续？选择其他选项后仍可回滚事务。",
      confirmText: "提交并继续",
      cancelText: "其他选项",
    });
    if (commit) {
      try { await invokeWorkbench("commit_sql_transaction", { sessionId: tab.transactionSessionId }); }
      catch (error) { statusText.value = `提交事务失败：${String(error)}`; return false; }
    } else {
      const rollback = await confirmDialogConfirm({
        title: "回滚当前事务？",
        message: "事务内尚未提交的修改将全部撤销。",
        confirmText: "回滚并继续",
        cancelText: "留在当前标签",
        danger: true,
      });
      if (!rollback) return false;
      try { await invokeWorkbench("rollback_sql_transaction", { sessionId: tab.transactionSessionId }); }
      catch (error) { statusText.value = `回滚事务失败：${String(error)}`; return false; }
    }
    tab.transactionSessionId = "";
    tab.transactionState = "idle";
  }
  if (skipUnsaved || tab.documentId || !tab.dirty) return true;
  const save = await confirmDialogConfirm({
    title: "SQL 尚未保存",
    message: `保存“${tab.title || "SQL 查询"}”后继续？`,
    confirmText: "保存并继续",
    cancelText: "其他选项",
  });
  if (save) return saveSqlTab(tab);
  return confirmDialogConfirm({
    title: "放弃未保存修改？",
    message: "草稿仍会随工作区恢复，但文件中的内容不会更新。",
    confirmText: "放弃并继续",
    cancelText: "留在当前标签",
    danger: true,
  });
}

async function decideInsertDraftDeparture({ tabs, rowCount }) {
  const tableCount = tabs.length;
  const result = await confirmDialogConfirm({
    title: "新增行尚未保存",
    message: tableCount > 1
      ? `${tableCount} 个表中共有 ${rowCount} 条新增记录尚未保存。关闭前请选择如何处理。`
      : `当前表有 ${rowCount} 条新增记录尚未保存。关闭前请选择如何处理。`,
    confirmText: "保存并关闭",
    alternativeText: "放弃并关闭",
    alternativeDanger: true,
    cancelText: "取消",
  });
  if (result === true) return INSERT_DRAFT_CLOSE_DECISION.SAVE;
  if (result === "alternative") return INSERT_DRAFT_CLOSE_DECISION.DISCARD;
  return INSERT_DRAFT_CLOSE_DECISION.CANCEL;
}

async function focusInsertDraftFailure(guardResult) {
  const tab = guardResult?.failedTab;
  if (!tab?.id) return;
  const pane = Object.values(workspace.panes || {})
    .find((candidate) => candidate?.tabIds?.includes(tab.id));
  if (pane) await activateTab(pane.id, tab.id);
  await nextTick();
  const rowId = guardResult?.result?.failedRowId;
  if (rowId) {
    focusedPaneState.selectInsertCell?.(tab, rowId, 0, { scrollColumn: false });
  }
  const reason = guardResult?.result?.failedReason;
  statusText.value = reason ? `新增行未能保存：${reason}` : "新增行未能全部保存，标签已保留";
}

async function guardTabDepartures(tabs) {
  const candidates = [...new Map(
    (Array.isArray(tabs) ? tabs : [])
      .filter((tab) => tab?.id && String(tab.kind || "data") !== "home")
      .map((tab) => [tab.id, tab]),
  ).values()];
  for (const tab of candidates) {
    if (tab.kind === "sql") sqlDocumentStore.upsertFromTab(tab);
    if (!(await guardSqlTabDeparture(tab))) return false;
  }
  const insertGuard = await guardInsertDraftTabs(candidates, {
    decide: decideInsertDraftDeparture,
    isDraftSaving: (tab, rowId) => isInsertRowSaving(tab, rowId),
    discardDrafts: (tab) => clearInsertDraft(tab),
    saveDrafts: (tab, rowIds) => commitInsertRows(tab, {
      rowIds,
      allowDefaults: true,
    }),
  });
  if (!insertGuard.proceed && insertGuard.blockedTab) {
    statusText.value = "新增行正在保存，完成后再关闭标签";
    return false;
  }
  if (!insertGuard.proceed && insertGuard.failedTab) {
    await focusInsertDraftFailure(insertGuard);
  }
  return insertGuard.proceed;
}

function rememberOpenedHomeTable(tableName) {
  const name = String(tableName || "").trim();
  if (!name) return;
  recentHomeTableNames.value = [
    name,
    ...recentHomeTableNames.value.filter((item) => item !== name),
  ].slice(0, 40);
}

function tableHasFieldCount(table) {
  if (!table) return false;
  for (const value of [table.columnCount, table.column_count, table.fieldCount, table.field_count]) {
    if (value === null || value === undefined || value === "") continue;
    const count = Number(value);
    if (Number.isInteger(count) && count >= 0) return true;
  }
  return Array.isArray(table.columns) && table.schemaLoaded !== false;
}

async function loadVisibleHomeTableCounts(payload = {}) {
  const tableNames = Array.isArray(payload) ? payload : payload?.tableNames;
  const connectionId = String(Array.isArray(payload) ? selectedConnectionId.value : payload?.connectionId || selectedConnectionId.value || "");
  const database = String(Array.isArray(payload) ? selectedDatabase.value : payload?.database || selectedDatabase.value || "");
  if (!connectionId || !database || !Array.isArray(tableNames) || tableNames.length === 0) return;

  const pending = [];
  const seen = new Set();
  for (const rawName of tableNames) {
    const tableName = String(rawName || "").trim();
    if (!tableName || seen.has(tableName)) continue;
    seen.add(tableName);
    const table = workspace.schema.find((item) =>
      normalizeTableName(item) === tableName &&
      String(item.connectionId || item.connection_id || connectionId) === connectionId &&
      String(item.database || database) === database
    );
    if (!table || tableHasFieldCount(table)) continue;
    const key = [connectionId, database, tableName].join("\u001f");
    if (homeFieldCountInFlight.has(key)) continue;
    homeFieldCountInFlight.add(key);
    pending.push({ tableName, key });
  }

  if (!pending.length) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(HOME_FIELD_COUNT_LOAD_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      try {
        await ensureTableSchema(item.tableName, { connectionId, database });
      } catch {
        // Keep the row visible; a later refresh/scroll can retry the metadata load.
      } finally {
        homeFieldCountInFlight.delete(item.key);
      }
    }
  });
  await Promise.all(workers);
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

function hitResultContext(tab = focusedPaneState.activeDataTab, paneId = focusedPaneState.paneId || workspace.focusedPaneId) {
  const query = String(tab?.searchQuery || tab?.filter || "").trim();
  if (!tab || (tab.kind || "data") !== "data" || tab.hitResultMode || !query) return null;
  return {
    connectionId: String(tab.connectionId || ""),
    database: String(tab.database || ""),
    tableName: String(tab.tableName || ""),
    tableComment: String(tab.tableComment || ""),
    query,
    filterMode: normalizeTableFilterMode(tab.filterMode),
    sourceTabId: String(tab.id || ""),
    sourcePaneId: String(paneId || ""),
  };
}

function sameHitResultContext(tab, context) {
  if (!tab || !context || tab.hitResultMode !== true) return false;
  return (
    String(tab.connectionId || "") === context.connectionId &&
    String(tab.database || "") === context.database &&
    String(tab.tableName || "") === context.tableName &&
    String(tab.searchQuery || tab.filter || "").trim() === context.query &&
    normalizeTableFilterMode(tab.filterMode) === context.filterMode
  );
}

function paneIdForTabId(tabId) {
  return Object.values(workspace.panes || {}).find((pane) => pane.tabIds?.includes(tabId))?.id || "";
}

function findMatchingHitResult(context) {
  if (!context) return null;
  const tab = workspace.tabs.find((candidate) => sameHitResultContext(candidate, context));
  if (!tab) return null;
  return { tab, paneId: paneIdForTabId(tab.id) };
}

function closeHitResultPane(match, fallbackPaneId = "") {
  if (!match?.tab?.id) return;
  closePaneTab(workspace, match.paneId, match.tab.id);
  pruneEmptyPanesInLayout(workspace);
  const targetPaneId = fallbackPaneId && workspace.panes?.[fallbackPaneId]
    ? fallbackPaneId
    : (workspace.panes?.[workspace.focusedPaneId] ? workspace.focusedPaneId : Object.keys(workspace.panes || {})[0]);
  if (targetPaneId) focusPane(targetPaneId);
}

async function openHitResultPane(context) {
  if (!context?.tableName) return null;
  const newPane = splitPaneInLayout(workspace, context.sourcePaneId || workspace.focusedPaneId, "right");
  if (!newPane) return null;
  focusPane(newPane.id);
  return openTable({
    connectionId: context.connectionId,
    database: context.database,
    tableName: context.tableName,
    tableComment: context.tableComment,
  }, {
    paneId: newPane.id,
    activate: true,
    duplicate: true,
    initialState: {
      filter: context.query,
      searchQuery: context.query,
      filterMode: context.filterMode,
      hitResultMode: true,
      hitResultSourceTabId: context.sourceTabId,
      hitResultSourcePaneId: context.sourcePaneId,
    },
  });
}

async function toggleHitResultPane() {
  const context = {
    connectionId: contextMenu.connectionId,
    database: contextMenu.database,
    tableName: contextMenu.tableName,
    tableComment: contextMenu.tableComment,
    query: contextMenu.hitResultQuery,
    filterMode: normalizeTableFilterMode(contextMenu.hitResultFilterMode),
    sourceTabId: contextMenu.hitResultSourceTabId,
    sourcePaneId: contextMenu.hitResultSourcePaneId || focusedPaneState.paneId || workspace.focusedPaneId,
  };
  closeContextMenu();
  if (!context.query || !context.tableName) return;
  const match = findMatchingHitResult(context);
  if (match) {
    closeHitResultPane(match, context.sourcePaneId);
    return;
  }
  await openHitResultPane(context);
}

async function splitPane(paneId, direction) {
  const sourcePane = workspace.panes?.[paneId];
  const sourceTab = workspace.tabs.find((tab) => tab.id === sourcePane?.activeTabId) || null;
  const newPane = splitPaneInLayout(workspace, paneId, direction);
  if (!newPane) return;
  focusPane(newPane.id);
  const source = sourceFromTab(sourceTab);
  if (source?.kind === "home") {
    openDatabaseHomeTab(workspace, source, { paneId: newPane.id, activate: true });
    return;
  }
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
        filterMode: normalizeTableFilterMode(sourceTab.filterMode),
        searchQuery: sourceTab.searchQuery || sourceTab.filter || "",
        hitResultMode: false,
        sort: sourceTab.sort ? { ...sourceTab.sort } : null,
      },
    });
    await nextTick();
    focusedPaneState.refreshCurrentSearchMatches?.();
  }
}

function closePane(paneId) {
  if (Object.keys(workspace.panes || {}).length <= 1) return;
  discardPaneHomeTabs(workspace, paneId);
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
    applyCommittedCellToTab(tab, { rowKey, column, oldValue, newValue });
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

function minimizeWindow() {
  withCurrentWindow((window) => window.minimize());
}

function toggleMaximizeWindow() {
  withCurrentWindow(async (window) => {
    if (await window.isMaximized()) await window.unmaximize();
    else await window.maximize();
  });
}

function handleTitlebarDoubleClick() {
  if (!usesNativeMacWindowControls) toggleMaximizeWindow();
}

function closeWindow() {
  withCurrentWindow((window) => window.close());
}

async function toggleWindowPin() {
  const result = await windowPin.toggle();
  if (result.busy) return false;
  if (!result.ok) {
    const message = `窗口置顶失败：${result.error || "请重试"}`;
    statusText.value = message;
    showWorkbenchReminder("error", message);
    return false;
  }
  const message = result.pinned
    ? "已钉住：窗口将保持在最上层"
    : "已解除钉住：窗口恢复正常层级";
  statusText.value = message;
  showWorkbenchReminder("success", message);
  return true;
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
    void agent.ensureRuntime();
  }
}

function sendAgentMessage() {
  void agent.send(focusedInspectorTab.value);
}

let agentWorkbenchActionProcessing = false;

function controlContextSnapshot(tab = activeDataTab.value) {
  const connectionId = String(tab?.connectionId || selectedConnectionId.value || "");
  const connection = connections.value.find((item) => item.id === connectionId);
  return {
    connectionId,
    connectionLabel: connectionLabel(connectionId, connection?.label || connectionId),
    database: String(tab?.database || selectedDatabase.value || ""),
    activeView: tab ? "table" : String(activeTab.value?.kind || "home"),
    tableName: String(tab?.tableName || ""),
    page: Number(tab?.page || 1),
    loadedRowCount: tab ? tabRows(tab).length : 0,
    columns: Array.isArray(tab?.columns) ? tab.columns.map((column) => columnName(column)) : [],
  };
}

const controlContextSignature = computed(() => JSON.stringify(controlContextSnapshot()));

watch(controlContextSignature, () => {
  void agent.updateControlContext(controlContextSnapshot());
}, { immediate: true });

async function processNextAgentWorkbenchAction() {
  if (agentWorkbenchActionProcessing) return;
  const action = agent.pendingWorkbenchActions.value[0];
  if (!action) return;
  agentWorkbenchActionProcessing = true;
  let message = "";
  try {
    if (action.action === "open_table") {
      await openAgentTableAction(action);
      message = `已打开表：${action.tableName}`;
    } else if (action.action === "focus_column" || action.action === "focus_row" || action.action === "focus_cell") {
      await focusAgentReferenceAction(action);
      message = statusText.value;
    } else if (action.action === "refresh_table") {
      await refreshAgentTableAction(action);
      message = `已刷新表：${action.tableName}`;
    }
    try {
      await agent.completeControlWorkbenchAction(action, {
        ok: true,
        message,
        context: controlContextSnapshot(),
      });
    } catch {
      // The action itself succeeded even if the external caller disconnected.
    }
  } catch (error) {
    const reason = String(error?.message || error || "界面动作执行失败");
    statusText.value = reason;
    try {
      await agent.completeControlWorkbenchAction(action, {
        ok: false,
        message: reason,
        context: controlContextSnapshot(),
      });
    } catch {
      // The MCP caller may already have timed out; keep the workbench usable.
    }
  } finally {
    agent.markWorkbenchActionHandled(action.requestId);
    agentWorkbenchActionProcessing = false;
    if (agent.pendingWorkbenchActions.value.length > 0) {
      void processNextAgentWorkbenchAction();
    }
  }
}

watch(
  () => agent.pendingWorkbenchActions.value.map((action) => action.requestId).join("\x1f"),
  () => {
    void processNextAgentWorkbenchAction();
  },
);

async function openAgentTableReference(tableName) {
  const name = String(tableName || "").trim();
  if (!name) return;
  const table = workspace.schema.find((item) => normalizeTableName(item) === name);
  if (!table) {
    statusText.value = `未找到表：${name}`;
    return;
  }
  await openAgentTableAction({
    tableName: name,
    tableComment: normalizeTableComment(table),
    connectionId: table.connectionId || table.connection_id || selectedConnectionId.value,
    database: table.database || selectedDatabase.value,
  });
}

async function openAgentReference(action) {
  if (!action || typeof action !== "object") return;
  if (action.action === "open_table") {
    await openAgentTableAction(action);
  } else if (action.action === "focus_column" || action.action === "focus_row" || action.action === "focus_cell") {
    await focusAgentReferenceAction(action);
  }
}

async function openAgentTableAction(action) {
  const name = String(action?.tableName || "").trim();
  if (!name) throw new Error("缺少要打开的表名");
  const connectionId = action.connectionId || selectedConnectionId.value;
  const database = action.database || selectedDatabase.value;
  const table = workspace.schema.find((item) =>
    normalizeTableName(item) === name &&
    (!database || !item.database || item.database === database) &&
    (!connectionId || !item.connectionId || item.connectionId === connectionId)
  );
  focusedPaneState.captureActiveTableViewState?.();
  const openedTab = await openTable({
    ...(table || {}),
    tableName: table ? normalizeTableName(table) : name,
    tableComment: table ? normalizeTableComment(table) : String(action.tableComment || ""),
    connectionId,
    database,
    readOnly: Boolean(table?.readOnly || table?.read_only || isReadOnlyConnection(connectionId)),
  }, { paneId: workspace.focusedPaneId });
  const tab = openedTab || workspace.tabs.find((candidate) =>
    normalizeTableName(candidate) === name &&
    (!database || !candidate.database || candidate.database === database) &&
    (!connectionId || !candidate.connectionId || candidate.connectionId === connectionId)
  ) || null;
  if (!tab) throw new Error(`打开表失败：${name}`);
  if (tab.loadError) throw new Error(`打开表失败：${tab.loadError}`);
  statusText.value = `已打开表：${name}`;
  return tab;
}

async function refreshAgentTableAction(action) {
  const tab = workspace.tabs.find((candidate) =>
    (candidate.kind || "data") === "data" &&
    normalizeTableName(candidate) === action.tableName &&
    (!action.database || candidate.database === action.database) &&
    (!action.connectionId || candidate.connectionId === action.connectionId)
  );
  if (!tab) {
    await openAgentTableAction(action);
    return;
  }
  const result = await fetchPage(tab, 1);
  if (!result?.ok) {
    throw new Error(`刷新表失败：${String(result?.error?.message || result?.error || tab.loadError || "未知错误")}`);
  }
  clearTabCellErrors(tab);
  statusText.value = `已刷新表：${action.tableName}`;
}

async function focusAgentReferenceAction(action) {
  const tab = await openAgentTableAction(action);
  await nextTick();
  const targetTab = tab || activeDataTab.value;
  if (!targetTab) throw new Error(`打开表失败：${action.tableName}`);
  const columnIndex = action.columnName
    ? targetTab.columns.findIndex((column) => columnName(column) === action.columnName)
    : 0;
  const rowIndex = resolveAgentActionRowIndex(targetTab, action);
  if (action.action === "focus_column") {
    if (columnIndex >= 0) {
      if (targetTab.id === focusedPaneState.activeDataTab?.id) {
        focusedPaneState.scrollColumnIntoView?.(columnIndex, "td");
      } else {
        scrollCellIntoView(Math.max(0, rowIndex), columnIndex);
      }
      statusText.value = `已定位列：${action.tableName}.${action.columnName}`;
    } else {
      statusText.value = `未找到列：${action.columnName}`;
      throw new Error(statusText.value);
    }
    return;
  }
  if (rowIndex < 0) {
    statusText.value = `未找到行：${action.tableName}`;
    throw new Error(statusText.value);
  }
  const targetColumnIndex = columnIndex >= 0 ? columnIndex : 0;
  if (targetTab.id === focusedPaneState.activeDataTab?.id && typeof focusedPaneState.selectCellAt === "function") {
    focusedPaneState.selectCellAt(targetTab, rowIndex, targetColumnIndex);
  } else {
    selectCellAt(targetTab, rowIndex, targetColumnIndex);
  }
  statusText.value = action.action === "focus_cell" && action.columnName
    ? `已定位单元格：${action.tableName}.${action.columnName}`
    : `已定位行：${action.tableName}`;
}

function resolveAgentActionRowIndex(tab, action) {
  if (tabRowCount(tab) === 0) return -1;
  const rowKey = String(action.rowKey || "").trim();
  if (rowKey) {
    const byKey = createRowIndex(tab, { buildRowKey }).indexOfKey(rowKey);
    if (byKey >= 0) return byKey;
    const identity = parseAgentRowKey(rowKey);
    const byParsedIdentity = findRowIndexByIdentity(tab, identity);
    if (byParsedIdentity >= 0) return byParsedIdentity;
  }
  return findRowIndexByIdentity(tab, action.rowIdentity || {});
}

function parseAgentRowKey(rowKey) {
  const out = {};
  for (const part of String(rowKey || "").split("&")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    out[part.slice(0, index)] = part.slice(index + 1);
  }
  return out;
}

function findRowIndexByIdentity(tab, identity) {
  const entries = Object.entries(identity || {}).filter(([key]) => key);
  if (!entries.length) return -1;
  return tabRows(tab).findIndex((row) =>
    entries.every(([key, value]) => String(row?.[key] ?? "") === String(value ?? "")),
  );
}

// ── Local helpers ─────────────────────────────────────────────────────────
const totalPages = computed(() => {
  const tab = activeDataTab.value;
  if (!tab) return 1;
  return Math.max(1, Math.ceil(tab.totalRows / tab.pageSize));
});

function rowCountLabel(tab) {
  const loadedRows = tabRowCount(tab);
  if (tab?.totalRowsExact === false) {
    if (tab.hasMore === false) return `已加载全部 ${loadedRows.toLocaleString("zh-CN")} 行`;
    return `已加载 ${loadedRows.toLocaleString("zh-CN")}+ 行${tab.totalRowsLoading ? " · 计算中" : ""}`;
  }
  const count = Number(tab?.totalRows);
  return `${Number.isFinite(count) ? count.toLocaleString("zh-CN") : "0"} 行`;
}

const activeStatusLabel = computed(() => (
  activeDataTab.value ? rowCountLabel(activeDataTab.value) : activeDesignTab.value ? "表设计" : ""
));

function highlightCell(tab, row, column, rowKey) {
  return _highlightCellResult(editState, tab, row, column, rowKey);
}

function setGridWrapElement(element) {
  gridWrapRef.value = element;
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

async function refreshTabPage(tab, page, options = {}) {
  if (!options.skipInsertDraftCheck && focusedPaneState.activeDataTab?.id === tab?.id) {
    const ready = await focusedPaneState.prepareInsertDraftsForRefresh?.(tab);
    if (ready === false) return { ok: false, cancelled: true };
  }
  const result = await fetchPage(tab, page);
  if (result?.ok) {
    clearTabCellErrors(tab);
    if (tab?.id === activeDataTab.value?.id) {
      if (!options.skipInsertDraftCheck) {
        focusedPaneState.clearInsertDraftsAfterRefresh?.(tab);
        clearInsertDraft(tab);
        clearSelection({ clearInsertDrafts: true });
      }
    }
  }
  return result;
}

function cancelSidebarValueSearch() {
  if (cancelValueSearch(sidebarSearch)) {
    statusText.value = "已取消值搜索";
  }
}

function cancelQuickOpenValueSearch() {
  if (cancelValueSearch(quickOpenValueSearch)) {
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

async function runQuickOpenValueSearch({ query: requestedQuery = "", includedTables = [] } = {}) {
  const query = normalizeSidebarSearchQuery(requestedQuery);
  if (!query) return;
  const searchConnectionId = selectedConnectionId.value;
  const searchDatabase = selectedDatabase.value;
  const sourceStillSelected = () =>
    selectedConnectionId.value === searchConnectionId &&
    selectedDatabase.value === searchDatabase;

  if (!searchDatabase) {
    quickOpenValueSearch.valueError = "请先选择数据库";
    statusText.value = "请先选择数据库";
    return;
  }

  const token = beginValueSearch(quickOpenValueSearch, query);
  statusText.value = "搜索值…";
  try {
    await ensureValueSearchProgressListener();
    const results = await invokeWorkbench("search_values", {
      request: {
        connectionId: selectedConnectionId.value,
        database: selectedDatabase.value,
        query,
        limit: 1500,
        jobId: quickOpenValueSearch.valueSearchJobId,
        priorityTables: uniqueSchemaSearchPriorityTables(quickOpenSchemaSearchResults.value),
        includedTables,
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
    if (finishValueSearch(quickOpenValueSearch, query, sourcedResults, token)) {
      statusText.value = `值命中 ${quickOpenValueSearch.valueResults.length} 张表`;
    }
  } catch (error) {
    if (!sourceStillSelected()) return;
    if (failValueSearch(quickOpenValueSearch, query, String(error), token)) {
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

async function openQuickOpenTable({ table } = {}) {
  // Quick Open 浮层选中表后：关浮层、清查询、走现有 openTable 流程。
  // openTable 内部已支持跨 pane 跳转——若该表已在任意分屏打开，会激活那个
  // pane 的标签页而非新建重复 tab。
  quickOpenVisible.value = false;
  quickOpenQuery.value = "";
  if (!table) return;
  focusedPaneState.captureActiveTableViewState?.();
  await openTable(table, { paneId: workspace.focusedPaneId });
}

// Quick Open 浮层里切换数据库：同连接直接切库；跨连接需先切连接（刷新 databases
// 列表）再切库。侧栏保持收起（契合"收起换留白"的整体思路）。
// 注意：跨连接时 selectConnection 内部会自动选第一个库并调 selectDatabase，
// 我们之后再 selectDatabase 指定用户选的库即可覆盖（selectDatabase 的竞态
// 保护只挡 owning token 不匹配的旧调用，新调用 owning token=null 会自增 token 正常执行）。
async function openDatabaseHomeTarget({ connectionId, database, paneId = workspace.focusedPaneId } = {}) {
  const targetConnectionId = String(connectionId || "");
  const targetDatabase = String(database || "");
  if (!targetConnectionId || !targetDatabase) return false;
  const navigation = performDatabaseHomeTargetOpen({ targetConnectionId, targetDatabase, paneId });
  return homeTablePasteCoordinator.trackNavigation(
    { connectionId: targetConnectionId, database: targetDatabase },
    navigation,
  );
}

async function performDatabaseHomeTargetOpen({ targetConnectionId, targetDatabase, paneId }) {
  const targetPaneId = workspace.panes?.[paneId] ? paneId : workspace.focusedPaneId;
  if (targetPaneId) focusWorkspacePane(workspace, targetPaneId);

  const targetPane = workspace.panes?.[targetPaneId];
  const previousHome = workspace.tabs.find((tab) => (
    tab.kind === "home" && targetPane?.tabIds?.includes(tab.id)
  ));
  const previousHomeState = previousHome
    ? { ...previousHome, selectedTableNames: [...(previousHome.selectedTableNames || [])] }
    : null;
  const sourceChanging = (
    targetConnectionId !== String(selectedConnectionId.value) ||
    targetDatabase !== String(selectedDatabase.value)
  );
  const pendingHome = openDatabaseHomeTab(workspace, {
    connectionId: targetConnectionId,
    database: targetDatabase,
    readOnly: isReadOnlyConnection(targetConnectionId),
  }, { paneId: targetPaneId, activate: true });
  if (pendingHome) pendingHome.loading = sourceChanging;

  if (targetConnectionId !== String(selectedConnectionId.value)) {
    await selectConnection(targetConnectionId, { preferredDatabase: targetDatabase });
  }
  if (targetDatabase !== String(selectedDatabase.value)) {
    await selectDatabase({ connectionId: targetConnectionId, database: targetDatabase });
  }
  if (
    targetConnectionId !== String(selectedConnectionId.value) ||
    targetDatabase !== String(selectedDatabase.value)
  ) {
    const currentHome = workspace.tabs.find((tab) => tab.id === previousHomeState?.id);
    const returnedToPreviousSource = (
      previousHomeState &&
      String(selectedConnectionId.value) === String(previousHomeState.connectionId || "") &&
      String(selectedDatabase.value) === String(previousHomeState.database || "")
    );
    if (currentHome && returnedToPreviousSource) {
      Object.assign(currentHome, previousHomeState, {
        selectedTableNames: [...previousHomeState.selectedTableNames],
        loading: false,
      });
    } else {
      const fallbackHome = openCurrentDatabaseHome({ paneId: targetPaneId, activate: true });
      if (fallbackHome) fallbackHome.loading = false;
    }
    return false;
  }
  const openedHome = openCurrentDatabaseHome({ paneId: targetPaneId, activate: true });
  if (openedHome) openedHome.loading = false;
  return true;
}

async function selectDatabaseFromPalette({ connectionId, database }) {
  // 保持 Quick Open 浮窗打开，让用户切库后继续搜表；搜索词由 QuickOpenPalette 内部清空。
  await openDatabaseHomeTarget({ connectionId, database });
}

// Quick Open 浮层里标记/取消常驻库，写回 localStorage。
function togglePinnedDatabaseFromPalette({ connectionId, database }) {
  pinnedDatabases.value = togglePinnedInStore(connectionId, database, pinnedDatabases.value);
}

async function loadFavoriteDatabaseOptions() {
  const targets = visibleConnections.value.filter((connection) => {
    const kind = String(connection?.kind || "mysql").toLowerCase();
    return connection?.connected === true && (kind === "mysql" || kind === "clickhouse");
  });
  await Promise.allSettled(targets.map((connection) => fetchDatabasesForConnection(connection.id)));
}

function favoriteDatabaseDisplayName({ connectionId, database } = {}) {
  return databaseLabel(connectionId, database) || String(database || "");
}

function addFavoriteDatabase({ connectionId, database } = {}) {
  if (!connectionId || !database) return { ok: false, error: "请选择具体数据库" };
  pinnedDatabases.value = addPinnedDatabase(connectionId, database, pinnedDatabases.value);
  statusText.value = `已收藏数据库：${favoriteDatabaseDisplayName({ connectionId, database })}`;
  return { ok: true };
}

function removeFavoriteDatabase({ connectionId, database } = {}) {
  pinnedDatabases.value = removePinnedDatabase(connectionId, database, pinnedDatabases.value);
  statusText.value = `已移除收藏：${favoriteDatabaseDisplayName({ connectionId, database })}`;
  return { ok: true };
}

function favoriteShortcutConflict(target, shortcut) {
  for (const [action, binding] of Object.entries(shortcutHelper.bindings)) {
    if (binding && sameShortcutCombo(binding, shortcut)) {
      return `与“${SHORTCUT_LABELS[action] || action}”快捷键冲突`;
    }
  }
  const duplicate = pinnedDatabases.value.find((entry) => (
    (String(entry.connectionId) !== String(target.connectionId) || String(entry.database) !== String(target.database)) &&
    entry.shortcut && sameShortcutCombo(entry.shortcut, shortcut)
  ));
  return duplicate ? `已用于收藏数据库“${favoriteDatabaseDisplayName(duplicate)}”` : "";
}

function updateFavoriteDatabaseShortcut({ connectionId, database, shortcut = "" } = {}) {
  if (!connectionId || !database) return { ok: false, error: "收藏数据库不存在" };
  const conflict = shortcut ? favoriteShortcutConflict({ connectionId, database }, shortcut) : "";
  if (conflict) return { ok: false, error: conflict };
  pinnedDatabases.value = setPinnedDatabaseShortcut(connectionId, database, shortcut, pinnedDatabases.value);
  statusText.value = shortcut
    ? `已为 ${favoriteDatabaseDisplayName({ connectionId, database })} 设置快捷键 ${shortcut}`
    : `已清除 ${favoriteDatabaseDisplayName({ connectionId, database })} 的快捷键`;
  return { ok: true };
}

async function openFavoriteDatabase(target = {}) {
  quickOpenVisible.value = false;
  const opened = await openDatabaseHomeTarget(target);
  statusText.value = opened
    ? `已切换到 ${favoriteDatabaseDisplayName(target)}`
    : `无法打开收藏数据库：${favoriteDatabaseDisplayName(target)}`;
  return { ok: opened };
}

// Quick Open 浮层里某连接的库列表拉取失败（通常是 saved 连接未恢复），用户点击
// 「重新连接」时，关闭浮层并交给 selectConnection：它内部会调 prefillConnDialog
// 弹出连接对话框让用户补密码，恢复后自动加载库列表。
async function reconnectConnectionFromPalette({ connectionId }) {
  if (!connectionId) return;
  quickOpenVisible.value = false;
  quickOpenQuery.value = "";
  await selectConnection(connectionId);
}

async function openQuickOpenValueResult(result) {
  const query = normalizeSidebarSearchQuery(quickOpenValueSearch.valueSearchedQuery || quickOpenQuery.value);
  quickOpenVisible.value = false;
  quickOpenQuery.value = "";
  await openValueResult(result, query);
}

async function openSidebarSchemaResult(result) {
  const table = result?.table?.raw || result?.table;
  if (!table) return;
  focusedPaneState.captureActiveTableViewState?.();
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
  const query = normalizeSidebarSearchQuery(sidebarSearch.valueSearchedQuery || treeQuery.value);
  await openValueResult(result, query);
}

async function openValueResult(result, query) {
  if (!result?.tableName) return;
  focusedPaneState.captureActiveTableViewState?.();
  const tab = await openTable({
    tableName: result.tableName,
    tableComment: result.tableComment || "",
    connectionId: result.connectionId || selectedConnectionId.value,
    database: result.database || selectedDatabase.value,
  }, { paneId: workspace.focusedPaneId });
  if (!tab || !query) return;
  tab.filter = query;
  tab.searchQuery = query;
  tab.filterMode = "continuous";
  await nextTick();
  const runSearch = focusedPaneState.activeDataTab?.id === tab.id
    ? focusedPaneState.runTableSearch
    : runTableSearch;
  if (typeof runSearch === "function") {
    await runSearch(query);
  }
}

async function activateTab(paneIdOrTabId, maybeTabId) {
  const paneId = maybeTabId ? paneIdOrTabId : workspace.focusedPaneId;
  const tabId = maybeTabId || paneIdOrTabId;
  const currentPane = workspace.panes?.[paneId];
  const currentTab = workspace.tabs.find((item) => item.id === currentPane?.activeTabId);
  if (currentTab?.kind === "sql") sqlDocumentStore.upsertFromTab(currentTab);
  if (currentTab?.id && currentTab.id !== tabId && !(await guardSqlTabDeparture(currentTab))) return;
  if (currentTab?.id !== tabId && focusedPaneState.paneId === paneId) {
    if (focusedPaneState.isEditing?.()) focusedPaneState.commitEditingWithoutRefocus?.();
    focusedPaneState.captureActiveTableViewState?.();
  }
  if (paneId) cancelPendingTableActivation(paneId);
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
}

async function closeTab(paneIdOrTabId, maybeTabId) {
  const paneId = maybeTabId ? paneIdOrTabId : workspace.focusedPaneId;
  const tabId = maybeTabId || paneIdOrTabId;
  const tab = workspace.tabs.find((item) => item.id === tabId);
  if (!(await guardTabDepartures([tab]))) return;
  clearTabCellErrors(tab);
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

function openTabContextMenu({ x, y, paneId, tabId = "" }) {
  const targetPaneId = paneId || workspace.focusedPaneId;
  if ((workspace.panes?.[targetPaneId]?.tabIds || []).length === 0) return;
  closeContextMenu();
  tabContextMenu.open = true;
  tabContextMenu.x = x;
  tabContextMenu.y = y;
  tabContextMenu.paneId = targetPaneId;
  tabContextMenu.tabId = tabId || workspace.panes?.[targetPaneId]?.activeTabId || "";
}

function closeTabContextMenu() {
  tabContextMenu.open = false;
  tabContextMenu.paneId = "";
  tabContextMenu.tabId = "";
}

const tabContextNeighborAvailability = computed(() => {
  const pane = workspace.panes?.[tabContextMenu.paneId || workspace.focusedPaneId];
  const tabId = tabContextMenu.tabId || pane?.activeTabId || "";
  const index = pane?.tabIds?.indexOf(tabId) ?? -1;
  const closable = (id) => workspace.tabs.some((tab) => tab.id === id && tab.kind !== "home");
  return {
    left: index > 0 && pane.tabIds.slice(0, index).some(closable),
    right: index >= 0 && pane.tabIds.slice(index + 1).some(closable),
  };
});

async function refreshTabsFromMenu() {
  const paneId = tabContextMenu.paneId || workspace.focusedPaneId;
  const pane = workspace.panes?.[paneId];
  const tab = workspace.tabs.find((item) => item.id === (tabContextMenu.tabId || pane?.activeTabId));
  closeTabContextMenu();
  if (!tab || (tab.kind || "data") !== "data") return;
  const result = await refreshTabPage(tab, 1);
  if (result?.ok) await resumeSearchAfterTableRefresh(tab);
}

async function closeAllTabsFromMenu() {
  const paneId = tabContextMenu.paneId || workspace.focusedPaneId;
  const pane = workspace.panes?.[paneId];
  const tabsToClose = closableTabsInPane(workspace.tabs, pane?.tabIds);
  closeTabContextMenu();
  if (!(await guardTabDepartures(tabsToClose))) return;
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

let databaseSyncConfirmationPending = false;

async function executeDatabaseSync() {
  if (databaseSyncConfirmationPending || !databaseSync.canExecute.value) return;
  databaseSyncConfirmationPending = true;
  try {
    const target = {
      connectionId: databaseSync.dialog.connectionId,
      database: databaseSync.dialog.targetDatabase,
    };
    const confirmed = await confirmDialogConfirm({
      title: "覆盖同步目标库",
      message: `源库：${databaseSync.dialog.sourceDatabase}\n目标库：${databaseSync.dialog.targetDatabase}`,
      note: "执行后将清空目标库现有数据，并用源库数据覆盖。执行前会自动创建目标库的本地保护快照，可在备份中心恢复。",
      confirmText: "覆盖同步",
      cancelText: "取消",
      danger: true,
    });
    if (!confirmed) return;
    // Let the confirmation overlay finish unmounting before the sync dialog
    // changes to its running state. This avoids competing modal layers during
    // the same click event in the desktop webview.
    await nextTick();
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
  } finally {
    databaseSyncConfirmationPending = false;
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

function batchTransferSource(source = null) {
  const tab = source || activeDataTab.value || activeDesignTab.value;
  const connectionId = String(tab?.connectionId || selectedConnectionId.value || "");
  const database = String(tab?.database || selectedDatabase.value || "");
  return {
    connectionId,
    database,
    readOnly: Boolean(tab?.readOnly || tab?.read_only || isReadOnlyConnection(connectionId)),
    tableName: tab?.tableName || "",
    ...(Array.isArray(tab?.selectedTableNames) ? { selectedTableNames: [...tab.selectedTableNames] } : {}),
  };
}

async function loadBatchSourceTables(source) {
  if (!source.connectionId || !source.database) return [];
  const tables = await invokeWorkbench("list_tables", {
    connectionId: source.connectionId,
    database: source.database,
  });
  return Array.isArray(tables) ? tables : [];
}

async function openBatchExport(source = null) {
  closeContextMenu();
  closeTabContextMenu();
  const resolved = batchTransferSource(source);
  if (!resolved.connectionId || !resolved.database) {
    statusText.value = "请先选择数据库";
    return;
  }
  try {
    const tables = await loadBatchSourceTables(resolved);
    batchTransfer.openBatchExport({ ...resolved, tables });
  } catch (error) {
    statusText.value = `打开批量导出失败：${String(error?.message || error)}`;
  }
}

async function openBatchImport(source = null) {
  closeContextMenu();
  closeTabContextMenu();
  const resolved = batchTransferSource(source);
  if (!resolved.connectionId || !resolved.database) {
    statusText.value = "请先选择数据库";
    return;
  }
  if (resolved.readOnly) {
    blockReadOnlyAction("导入数据");
    return;
  }
  try {
    const tables = await loadBatchSourceTables(resolved);
    batchTransfer.openBatchImport({ ...resolved, tables });
  } catch (error) {
    statusText.value = `打开批量导入失败：${String(error?.message || error)}`;
  }
}

async function onBatchImportFileSelected(event) {
  const files = Array.from(event.target.files || []);
  if (event?.target) event.target.value = "";
  if (!files.length) return;
  try {
    await batchTransfer.loadBatchImportFiles(
      batchTransfer.batchImport.mode === "separate" ? files : files.slice(0, 1),
    );
  } catch (error) {
    batchTransfer.batchImport.status = "failed";
    batchTransfer.batchImport.errorMessage = `读取文件失败：${String(error?.message || error)}`;
    statusText.value = batchTransfer.batchImport.errorMessage;
  }
}

let batchImportConfirmationPending = false;

async function executeBatchImport() {
  if (batchImportConfirmationPending) return;
  batchImportConfirmationPending = true;
  try {
    const batch = batchTransfer.batchImport;
    const comparison = batch.comparison;
    const comparisonCurrent = comparison.status === "succeeded" && !comparison.stale;
    const tableCount = batchTransfer.selectedImportCount.value;
    const comparisonMessage = comparisonCurrent
      ? `最近一次对比预计删除目标表中 ${Number(comparison.summary.deleted || 0)} 行；执行时若数据库内容已变化，实际结果可能不同。`
      : "本次未使用最新的变化对比结果，将直接按 Excel 当前内容覆盖目标表。";
    const confirmed = await confirmDialogConfirm({
      title: "覆盖同步导入",
      message: `将以 Excel 的完整内容同步 ${tableCount} 张目标表。${comparisonMessage}\n\n同步前会为每张表创建本地 XLSX 备份，写入操作也会记录到审计日志。`,
      confirmText: "确认同步",
      cancelText: "取消",
      danger: true,
    });
    if (!confirmed) return;
    await nextTick();

    const result = await batchTransfer.executeBatchImport();
    if (!result) return;
    const source = {
      connectionId: batch.connectionId,
      database: batch.database,
    };
    if (source.connectionId === selectedConnectionId.value && source.database === selectedDatabase.value) {
      await loadTables(source);
    }
    const tableNames = new Set(result.tableNames || []);
    const importedOpenTabs = workspace.tabs.filter((tab) =>
      (tab.kind || "data") === "data" &&
      tab.connectionId === source.connectionId &&
      tab.database === source.database &&
      tableNames.has(tab.tableName)
    );
    for (const tab of importedOpenTabs) {
      await refreshTabPage(tab, 1);
    }
  } finally {
    batchImportConfirmationPending = false;
  }
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

function openDatabaseAliasDialog(source) {
  const database = String(source?.database || "").trim();
  if (!database) return;
  const connectionId = String(source?.connectionId || "");
  aliasDialog.type = "database";
  aliasDialog.connectionId = connectionId;
  aliasDialog.database = database;
  aliasDialog.realName = database;
  aliasDialog.alias = getDatabaseAlias(connectionId, database);
  const decoration = getDatabaseDecoration(connectionId, database);
  aliasDialog.icon = decoration?.icon || "database";
  aliasDialog.color = decoration?.color || "";
  aliasDialog.textColor = decoration?.textColor || "";
  aliasDialog.open = true;
}

function openDatabaseAliasFromContext() {
  const source = renameDatabaseFromContextMenu();
  closeTabContextMenu();
  openDatabaseAliasDialog(source);
}

function openConnectionAliasDialog(source) {
  const connectionId = String(source?.connectionId || "");
  if (!connectionId) return;
  const connection = connections.value.find((item) => item.id === connectionId);
  aliasDialog.type = "connection";
  aliasDialog.connectionId = connectionId;
  aliasDialog.database = "";
  aliasDialog.realName = connection?.label || connectionId;
  aliasDialog.alias = getConnectionAlias(connectionId);
  aliasDialog.open = true;
}

function openConnectionAliasFromContext() {
  const source = renameConnectionFromContextMenu();
  closeTabContextMenu();
  openConnectionAliasDialog(source);
}

function closeAliasDialog() {
  aliasDialog.open = false;
}

function saveAlias() {
  const { type, connectionId, database, realName, alias } = aliasDialog;
  const trimmed = String(alias || "").trim();
  if (type === "connection") {
    setConnectionAlias(connectionId, alias);
    statusText.value = trimmed ? `已重命名连接 ${realName} → ${trimmed}` : `已清除连接 ${realName} 的本地别名`;
  } else {
    setDatabaseAlias(connectionId, database, alias);
    statusText.value = trimmed ? `已重命名数据库 ${database} → ${trimmed}` : `已清除数据库 ${database} 的本地别名`;
  }
  aliasDialog.open = false;
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
  await tableCopy.setTargetConnection(connectionId);
}

// 首页右键「发送到…」：把当前选中的表带进发送表对话框。
function sendHomeTables(source = {}) {
  const tableNames = Array.isArray(source.tableNames) ? source.tableNames.filter(Boolean) : [];
  if (!tableNames.length) return;
  if (isReadOnlyConnection(source.connectionId)) {
    blockReadOnlyAction("发送表");
    return;
  }
  tableCopy.open({
    connectionId: source.connectionId,
    database: source.database,
    tableNames,
  });
}

async function openTableFromSidebar(table) {
  focusedPaneState.captureActiveTableViewState?.();
  await openTable(table, { paneId: workspace.focusedPaneId });
  rememberOpenedHomeTable(normalizeTableName(table));
}

function saveDatabaseDisplay({ alias, icon, color, textColor } = {}) {
  const { connectionId, database } = aliasDialog;
  const trimmed = String(alias || "").trim();
  setDatabaseAlias(connectionId, database, alias);
  setDatabaseDecoration(connectionId, database, { icon, color, textColor });
  const customizedMarker = icon !== "database" || Boolean(color) || Boolean(textColor);
  statusText.value = trimmed || customizedMarker
    ? `已更新数据库 ${database} 的本地名称与标记`
    : `已恢复数据库 ${database} 的默认显示`;
  aliasDialog.open = false;
}

async function closeRelativeTabsFromMenu(direction) {
  const paneId = tabContextMenu.paneId || workspace.focusedPaneId;
  const tabId = tabContextMenu.tabId || workspace.panes?.[paneId]?.activeTabId || "";
  const pane = workspace.panes?.[paneId];
  const tabsToClose = closableRelativeTabsInPane(workspace.tabs, pane?.tabIds, tabId, direction);
  closeTabContextMenu();
  if (!(await guardTabDepartures(tabsToClose))) return;
  resetGridState();
  const closedTabs = closePaneTabsRelative(workspace, paneId, tabId, direction);
  closedTabs.forEach(clearTabCellErrors);
  pruneEmptyPanesInLayout(workspace);
}

async function focusHomeTable(table, paneId = workspace.focusedPaneId) {
  const tableName = normalizeTableName(table);
  if (!tableName) return;
  const pane = workspace.panes?.[paneId];
  const homeTab = workspace.tabs.find((tab) => tab.id === pane?.activeTabId && tab.kind === "home");
  if (homeTab) {
    homeTab.focusedTableName = tableName;
    homeTab.focusedTableComment = normalizeTableComment(table);
  }
  try {
    await ensureTableSchema(tableName, {
      connectionId: table?.connectionId || selectedConnectionId.value,
      database: table?.database || selectedDatabase.value,
      priority: "visible",
    });
  } catch {
    // The table-level comment can still be shown while field metadata retries later.
  }
}

async function openTableFromHome(table, paneId = workspace.focusedPaneId) {
  focusedPaneState.captureActiveTableViewState?.();
  await openTable(table, { paneId });
  rememberOpenedHomeTable(normalizeTableName(table));
}

function copyHomeTables(payload) {
  if (!payload?.tables?.length) return;
  homeTableClipboard.value = {
    type: "dbscout.tableObjects",
    connectionId: String(payload.connectionId || selectedConnectionId.value || ""),
    database: String(payload.database || selectedDatabase.value || ""),
    tables: [...payload.tables],
  };
  const message = `已复制 ${homeTableClipboard.value.tables.length} 张表`;
  statusText.value = message;
  showWorkbenchReminder("success", message);
}

function copiedHomeTableNames(result) {
  return (result?.copied || [])
    .map((item) => item.targetName || item.target_name || item.target)
    .filter(Boolean);
}

async function pasteHomeTables({ target, payload, onSuccess } = {}) {
  const source = payload || homeTableClipboard.value;
  const targetConnectionId = String(target?.connectionId || selectedConnectionId.value || "");
  const targetDatabase = String(target?.database || selectedDatabase.value || "");
  if (!source?.tables?.length || !targetConnectionId || !targetDatabase) return;
  if (isReadOnlyConnection(targetConnectionId)) {
    blockReadOnlyAction("粘贴表");
    return;
  }
  try {
    const paste = await homeTablePasteCoordinator.runWhenReady({
      connectionId: targetConnectionId,
      database: targetDatabase,
    }, async () => {
      busy.value = true;
      try {
        const result = await invokeWorkbench("copy_tables", {
          request: {
            sourceConnectionId: source.connectionId,
            sourceDatabase: source.database,
            tableNames: source.tables,
            targetConnectionId,
            targetDatabase,
          },
        });
        const createdNames = copiedHomeTableNames(result);
        await loadTables({ connectionId: targetConnectionId, database: targetDatabase });
        const home = openCurrentDatabaseHome({ activate: true });
        if (home) {
          home.selectedTableNames = createdNames;
          home.focusedTableName = createdNames[0] || "";
        }
        onSuccess?.(createdNames);
        statusText.value = createdNames.length
          ? `已粘贴 ${createdNames.length} 张表：${createdNames.join("、")}`
          : "已粘贴表";
        showWorkbenchReminder("success", `已粘贴 ${createdNames.length || 1} 张表`);
        return createdNames;
      } finally {
        busy.value = false;
      }
    });

    if (paste.ok) return;
    if (paste.reason === "paste-pending") {
      statusText.value = "正在粘贴表，请勿重复操作";
    } else if (paste.reason === "navigation-failed") {
      statusText.value = "目标数据库切换失败，未执行粘贴";
    } else {
      statusText.value = "目标数据库尚未就绪，未执行粘贴";
    }
  } catch (error) {
    statusText.value = `粘贴表失败：${String(error?.message || error)}`;
  }
}

async function renameHomeTable(source) {
  if (!source?.tableName || !source?.newName) {
    source?.onError?.(new Error("表名不能为空"));
    return;
  }
  if (isReadOnlyConnection(source.connectionId)) {
    blockReadOnlyAction("重命名表");
    source.onError?.(new Error("只读连接不能重命名表"));
    return;
  }
  try {
    await invokeWorkbench("rename_table", {
      connectionId: source.connectionId,
      database: source.database,
      tableName: source.tableName,
      newName: source.newName,
    });
  } catch (error) {
    source.onError?.(error);
    statusText.value = `重命名表失败：${String(error?.message || error)}`;
    return;
  }

  source.onSuccess?.();
  renameTableTab(workspace, {
    connectionId: source.connectionId,
    database: source.database,
    oldName: source.tableName,
    newName: source.newName,
  });

  try {
    await loadTables({ connectionId: source.connectionId, database: source.database });
    const home = openCurrentDatabaseHome({ activate: true });
    if (home) home.selectedTableNames = [source.newName];
    rememberOpenedHomeTable(source.newName);
    statusText.value = `已重命名 ${source.tableName} → ${source.newName}`;
  } catch (error) {
    statusText.value = `已完成重命名，但刷新表列表失败：${String(error?.message || error)}`;
  }
}

async function deleteHomeTables(source = {}) {
  const tableNames = Array.isArray(source.tableNames) ? source.tableNames.filter(Boolean) : [];
  if (!tableNames.length) return;
  if (isReadOnlyConnection(source.connectionId)) {
    blockReadOnlyAction("删除表");
    return;
  }
  const confirmed = await confirmDialogConfirm({
    title: tableNames.length === 1 ? "删除表" : `删除 ${tableNames.length} 张表`,
    message: `即将从 ${source.database} 删除以下表`,
    items: tableNames,
    note: "删除表会同时移除数据和结构，此操作不可撤销。",
    confirmText: tableNames.length === 1 ? "删除表" : "删除所选表",
    cancelText: "取消",
    danger: true,
  });
  if (!confirmed) return;
  busy.value = true;
  try {
    await invokeWorkbench("drop_tables", {
      request: {
        connectionId: source.connectionId,
        database: source.database,
        tables: tableNames,
      },
    });
    const closedTabs = closeTableObjectTabs(workspace, {
      connectionId: source.connectionId,
      database: source.database,
      tableNames,
    });
    closedTabs.forEach(clearTabCellErrors);
    await loadTables({ connectionId: source.connectionId, database: source.database });
    const home = openCurrentDatabaseHome({ activate: true });
    if (home) home.selectedTableNames = [];
    recentHomeTableNames.value = recentHomeTableNames.value.filter((name) => !tableNames.includes(name));
    statusText.value = `已删除 ${tableNames.length} 张表`;
  } catch (error) {
    statusText.value = `删除表失败：${String(error?.message || error)}`;
  } finally {
    busy.value = false;
  }
}

async function refreshHome(tab = null) {
  const connectionId = String(tab?.connectionId || selectedConnectionId.value || "");
  const database = String(tab?.database || selectedDatabase.value || "");
  if (!database) return;
  if (tab) tab.error = "";
  statusText.value = `正在刷新首页：${database}`;
  try {
    await loadTables({ connectionId, database });
    if (tab) tab.error = "";
    statusText.value = `已刷新首页：${database}`;
  } catch (error) {
    const message = `刷新首页失败：${String(error?.message || error)}`;
    if (tab) tab.error = message;
    statusText.value = message;
  }
}

function openTableDesign(tableLike = null, paneId = workspace.focusedPaneId) {
  // A home tab means "open the design for every selected table" (the home
  // page supports Ctrl/Shift multi-selection); resolve it to a target list.
  if (tableLike?.kind === "home") {
    return openTableDesign(resolveHomeDesignTargets(tableLike), paneId);
  }
  if (Array.isArray(tableLike)) {
    const targets = tableLike
      .map((target) => ({
        connectionId: String(target?.connectionId || target?.connection_id || ""),
        database: String(target?.database || ""),
        tableName: normalizeTableName(target) || String(target?.tableName || "").trim(),
      }))
      .filter((target) => target.tableName);
    if (!targets.length) return null;
    if (isReadOnlySource(targets[0])) {
      blockReadOnlyAction("打开表设计");
      return null;
    }
    let first = null;
    targets.forEach((target, index) => {
      const schemaEntry = workspace.schema.find((entry) => normalizeTableName(entry) === target.tableName);
      const tab = openTableDesignTab(
        workspace,
        { ...target, tableComment: normalizeTableComment(schemaEntry) || "" },
        // Only the first table steals focus; the rest open silently in the
        // background so a multi-select open doesn't make the tab bar jump.
        { activate: index === 0, paneId },
      );
      if (index === 0) first = tab;
    });
    statusText.value = targets.length === 1
      ? `已打开表设计：${targets[0].tableName}`
      : `已打开 ${targets.length} 个表设计`;
    return first;
  }
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
    const refreshedSchema = await ensureTableSchema(tableName, {
      connectionId,
      database,
      force: true,
    });
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
  openContextMenu(event, table, { surface: "sidebar" });
  configureHitResultContextMenu(focusedPaneState.activeDataTab);
}

async function removeConnectionFromContext() {
  const connectionId = contextMenu.connectionId;
  closeContextMenu();
  if (!connectionId) return;
  const connection = connections.value.find((item) => item.id === connectionId);
  const label = connectionLabel(connectionId, connection?.label || connectionId);
  const confirmed = await confirmDialogConfirm({
    title: "移除连接",
    message: `确定移除连接「${label}」？将同时关闭该连接下的所有标签页，之后可以重新添加。`,
    confirmText: "移除",
    cancelText: "取消",
    danger: true,
  });
  if (!confirmed) return;
  closeConnectionTabs(workspace, { connectionId });
  await removeConnection(connectionId);
  // 清理该连接的常驻库条目，避免幽灵条目残留在 Quick Open 浮层里。
  pinnedDatabases.value = removePinnedDatabasesForConnection(connectionId, pinnedDatabases.value);
}

function openGeneralContextMenu(event) {
  closeTabContextMenu();
  openContextMenu(event);
}

function configureHitResultContextMenu(targetTab = activeDataTab.value) {
  const paneId = focusedPaneState.paneId || workspace.focusedPaneId;
  const isFocusedPaneTab = targetTab?.id && targetTab.id === focusedPaneState.activeDataTab?.id;
  if (isFocusedPaneTab) focusedPaneState.refreshCurrentSearchMatches?.();
  const context = isFocusedPaneTab ? hitResultContext(targetTab, paneId) : null;
  const matchesMenuSource = Boolean(
    context &&
    context.connectionId === String(contextMenu.connectionId || "") &&
    context.database === String(contextMenu.database || "") &&
    context.tableName === String(contextMenu.tableName || ""),
  );
  const canToggle = Boolean(context && matchesMenuSource);
  const match = canToggle ? findMatchingHitResult(context) : null;
  contextMenu.canToggleHitResultPane = Boolean(canToggle);
  contextMenu.hitResultPaneOpen = Boolean(match);
  contextMenu.hitResultSourceTabId = context?.sourceTabId || "";
  contextMenu.hitResultSourcePaneId = context?.sourcePaneId || "";
  contextMenu.hitResultQuery = context?.query || "";
  contextMenu.hitResultFilterMode = normalizeTableFilterMode(context?.filterMode);
}

function openActiveTableContextMenu(event, targetTab = activeDataTab.value) {
  closeTabContextMenu();
  // 数据单元格右键时，从事件源 DOM 读取行列，让「冻结到此单元格」能一次到位。
  // （行右键走 grid-row 菜单，anchorIndex 已由 openRowContextMenu 设置。）
  const td = event.target?.closest?.('td[data-row-key][data-column-index]');
  let rowIndex = -1;
  let colIdx = -1;
  if (td) {
    const rowKey = td.getAttribute('data-row-key');
    colIdx = Number(td.getAttribute('data-column-index'));
    rowIndex = createRowIndex(targetTab, { buildRowKey }).indexOfKey(rowKey);
    const visualRowIndex = Number(td.getAttribute('data-visual-row-index'));
    const range = focusedPaneState.selectedRange;
    const insideSelectedRange = Boolean(
      range?.tabId === targetTab?.id &&
      isGridCellSelected(range, Number.isFinite(visualRowIndex) ? visualRowIndex : rowIndex, colIdx),
    );
    if (Number.isFinite(colIdx) && colIdx >= 0 && !insideSelectedRange) {
      if (Number.isInteger(visualRowIndex) && visualRowIndex >= 0) {
        focusedPaneState.selectVisualCellAt?.(targetTab, visualRowIndex, colIdx);
      } else if (rowIndex >= 0) {
        focusedPaneState.selectCellAt?.(targetTab, rowIndex, colIdx);
      }
    }
  }
  const hasGridSelection = Boolean(
    td ||
    targetTab?.selectedRowKeys?.size ||
    focusedPaneState.selectedCell?.tabId === targetTab?.id ||
    focusedPaneState.selectedRange?.tabId === targetTab?.id,
  );
  openContextMenu(event, targetTab, {
    surface: "grid",
    menuHeight: 252,
    clipboardActions: {
      canCopy: hasGridSelection && typeof focusedPaneState.copyGridSelection === "function",
      canPaste: Boolean(
        hasGridSelection &&
        !targetTab?.readOnly &&
        !targetTab?.read_only &&
        typeof focusedPaneState.pasteGridSelection === "function"
      ),
      copy: () => focusedPaneState.copyGridSelection?.(),
      paste: () => focusedPaneState.pasteGridSelection?.(),
    },
  });
  if (rowIndex >= 0) contextMenu.anchorIndex = rowIndex;
  if (Number.isFinite(colIdx) && colIdx >= 0) contextMenu.targetColumnIndex = colIdx;
  const header = event.target?.closest?.(".wb-grid-column-header-row th[data-column-index]");
  if (header) {
    const headerIndex = Number(header.dataset.columnIndex);
    if (Number.isFinite(headerIndex) && headerIndex >= 0) contextMenu.targetColumnIndex = headerIndex;
    contextMenu.fromColumnHeader = true;
  }
  configureHitResultContextMenu(targetTab);
}

function openDetailContextMenu(event, targetTab, clipboardActions) {
  closeTabContextMenu();
  openContextMenu(event, targetTab, {
    surface: "detail",
    menuHeight: DETAIL_CONTEXT_MENU_HEIGHT,
    clipboardActions,
  });
}

function openInspectorContextMenu(event, selectedText = "") {
  closeTabContextMenu();
  const text = String(selectedText ?? "");
  const hasSelectedText = Boolean(text.trim());
  openContextMenu(event, focusedInspectorTab.value, {
    surface: "inspector",
    clipboardActions: hasSelectedText
      ? {
          canCopy: true,
          canPaste: false,
          copy: () => copyTextToClipboard(text),
        }
      : null,
  });
}

function deleteGridRow(tab, row) {
  if (row?.__insertRowId) {
    removeInsertDraftRow(tab, row.__insertRowId);
    return;
  }
  deleteRow(tab, row);
}

function pasteCopiedRowsAboveFallback(tab, target) {
  if (!isTauriRuntime()) return insertCopiedRowsAbove(tab, target);
  return invokeWorkbench("read_clipboard_text")
    .then((text) => insertCopiedRowsAbove(tab, target, text))
    .catch(() => {
      statusText.value = "读取剪贴板失败";
      return { ok: false, message: statusText.value };
    });
}

function openActiveRowContextMenu(event, tab, row, originalIndex, rowActions = null) {
  closeTabContextMenu();
  const fallback = {
    insertDraftAbove,
    insertDraftBelow,
    insertDraftsAbove,
    insertDraftsBelow,
    canInsertCopiedRows: canInsertCopiedRows(tab),
    pasteCopiedRowsAbove: pasteCopiedRowsAboveFallback,
    deleteRow: deleteGridRow,
    deleteSelectedRows,
    selectedRowCount: tab?.selectedRowKeys?.size || 0,
  };
  openRowContextMenu(event, tab, row, originalIndex, rowActions || fallback);
}

function gridRowBatchInsert(direction, count) {
  const tab = contextMenu.rowTab || activeDataTab.value;
  const target = { row: contextMenu.row, rowIndex: contextMenu.anchorIndex };
  const actionName = direction === "above" ? "insertDraftsAbove" : "insertDraftsBelow";
  const fallbackAction = direction === "above" ? insertDraftsAbove : insertDraftsBelow;
  const insert = typeof contextMenu.rowActions?.[actionName] === "function"
    ? contextMenu.rowActions[actionName]
    : typeof focusedPaneState[actionName] === "function"
      ? focusedPaneState[actionName]
      : fallbackAction;
  closeContextMenu();
  if (!tab || typeof insert !== "function") return;
  insert(tab, target, count);
}

function onGridRowInsertAbove(count) {
  gridRowBatchInsert("above", count);
}

function onGridRowInsertBelow(count) {
  gridRowBatchInsert("below", count);
}

async function onGridRowPasteAbove() {
  const tab = contextMenu.rowTab || activeDataTab.value;
  const target = { row: contextMenu.row, rowIndex: contextMenu.anchorIndex };
  const paste = typeof contextMenu.rowActions?.pasteCopiedRowsAbove === "function"
    ? contextMenu.rowActions.pasteCopiedRowsAbove
    : typeof focusedPaneState.pasteCopiedRowsAbove === "function"
      ? focusedPaneState.pasteCopiedRowsAbove
      : pasteCopiedRowsAboveFallback;
  closeContextMenu();
  if (!tab) return;
  await paste(tab, target);
}

function onGridRowDelete() {
  const tab = contextMenu.rowTab || activeDataTab.value;
  const row = contextMenu.row;
  const remove = typeof contextMenu.rowActions?.deleteRow === "function"
    ? contextMenu.rowActions.deleteRow
    : typeof focusedPaneState.deleteRow === "function"
    ? focusedPaneState.deleteRow
    : deleteRow;
  closeContextMenu();
  if (!tab) return;
  // 选中了多行且右键行在其中（普通数据行）时，删除全部选中行；
  // 否则按单行删除（右键的是新增草稿行，或右键了选中范围外的行）。
  const selectedCount = tab.selectedRowKeys?.size || 0;
  const rowKey = row ? gridRowKey(tab, row) : "";
  const rowInSelection = Boolean(rowKey && tab.selectedRowKeys?.has(rowKey));
  if (selectedCount > 1 && rowInSelection) {
    const removeSelected = typeof contextMenu.rowActions?.deleteSelectedRows === "function"
      ? contextMenu.rowActions.deleteSelectedRows
      : deleteSelectedRows;
    removeSelected(tab);
    return;
  }
  if (!row) return;
  remove(tab, row);
}

function onSetCellToNull() {
  const setNull = typeof focusedPaneState.setCellToNull === "function"
    ? focusedPaneState.setCellToNull
    : setCellToNull;
  closeContextMenu();
  setNull?.();
}

function selectGridCell(...args) {
  if (consumeCellPointerClick()) return;
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

function selectGridInsertRow(tab, rowId, event) {
  if (consumeRowDragClickSuppression()) {
    gridWrapRef.value?.focus();
    return;
  }
  clearSelection();
  const insertRow = getInsertRows(tab).find((row) => row.id === rowId);
  if (!insertRow) return;
  toggleRowSelect(tab, { ...insertRow.draft, __insertRowId: rowId }, event);
  if (tab.selectedRowKeys.has(getInsertRowKey(tab, rowId))) selectInsertRow(tab, rowId);
  else selectedInsertRow.value = null;
  gridWrapRef.value?.focus();
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

function selectCellAt(tab, rowIndex, columnIndex) {
  const row = tabRowAt(tab, rowIndex);
  const column = tab?.columns?.[columnIndex];
  if (!row || !column) return;
  clearRowSelection(tab);
  clearSelection();
  selectCell(tab, row, columnName(column), rowIndex, columnIndex, { focusGrid: false });
  scrollCellIntoView(rowIndex, columnIndex);
}

// 当前选中单元格在数据区里的坐标，用于让搜索优先保留用户当前单元格。
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
  hasSearchMatches,
  goToNextSearchMatch,
  goToPreviousSearchMatch,
  dispose: disposeGlobalTableSearch,
} = useTableSearch(activeDataTab, {
  editState,
  loadNextPage,
  loadSearchResultPage,
  loadNextSearchResultPage,
  cancelSearchResultPage,
  selectCellAt,
  statusText: conn.statusText,
  isEditing: () => !!editingCell.value,
  getSelectedPosition: currentSearchPosition,
});

function setSearchInputElement(element) {
  searchInputRef.value = element;
}

function isEditableShortcutTarget(target) {
  if (!target) return false;
  return Boolean(target.isContentEditable || target.closest?.("input, textarea, select"));
}

function handleOpenDesignKeydown(event) {
  if (!shortcutHelper.matchesBinding("openDesign", event)) return false;
  if (isEditableShortcutTarget(event.target)) return false;
  if (activeDataTab.value) {
    event.preventDefault();
    event.stopPropagation();
    openTableDesign(activeDataTab.value);
    return true;
  }
  // On a home tab, open the design for every selected table (multi-select).
  const homeTab = focusedPaneState.activeHomeTab || (activeTab.value?.kind === "home" ? activeTab.value : null);
  if (!homeTab || !resolveHomeDesignTargets(homeTab).length) return false;
  event.preventDefault();
  event.stopPropagation();
  openTableDesign(homeTab, workspace.focusedPaneId);
  return true;
}

function handleSidebarSearchKeydown(event) {
  if (!shortcutHelper.matchesBinding("searchDatabase", event)) return false;
  // Ctrl+P must open the Quick Open palette from anywhere, including while the
  // user is typing inside an editable element (cell editor, AI input, …), so
  // we intentionally do NOT guard with isEditableShortcutTarget here.
  event.preventDefault();
  event.stopPropagation();
  openQuickOpenFromAnywhere();
  return true;
}

// Native Ctrl/Cmd+F must be captured before WebView find-in-page opens.
// Ctrl+P is handled by the same document-level shortcut listener below.
function isNativeFindKeydown(event) {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && String(event.key || "").toLowerCase() === "f";
}

function focusFocusedSearch() {
  if (typeof focusedPaneState.focusCurrentSearch === "function") {
    return focusedPaneState.focusCurrentSearch?.() === true;
  }
  if (!activeDataTab.value) return false;
  focusTableSearch();
  return true;
}

function handleOpenSqlQueryKeydown(event) {
  if (!shortcutHelper.matchesBinding("openSqlQuery", event)) return false;
  event.preventDefault();
  event.stopPropagation();
  openSqlQuery();
  return true;
}

function handleOpenTableTransferKeydown(event) {
  if (!shortcutHelper.matchesBinding("openTableTransfer", event)) return false;
  event.preventDefault();
  event.stopPropagation();
  openTableTransfer();
  return true;
}

function handleGlobalTableSearchKeydown(event) {
  if (!shortcutHelper.matchesBinding("searchTable", event) && !isNativeFindKeydown(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  // Ctrl+F 弹出查找替换弹窗（查找页）；没有打开的数据表时（如数据库主页）
  // 回退到原来的行为——聚焦当前页面的搜索框。
  if (activeDataTab.value) openFindReplaceDialog("find");
  else focusFocusedSearch();
  return true;
}
// Ctrl+H 打开表内替换对话框。与 Ctrl+P 一样允许从任意焦点位置唤起——若正在
// 编辑单元格，先无焦点回退地提交，避免对话框输入框抢焦点触发 cell-blur。
// 工具栏"替换"按钮也走同一入口（openReplaceDialog）。
function openFindReplaceDialog(tab) {
  if (!activeDataTab.value) return;
  if (focusedPaneState.isEditing?.()) focusedPaneState.commitEditingWithoutRefocus?.();
  findReplaceTab.value = tab === "replace" ? "replace" : "find";
  findReplaceVisible.value = true;
}

function openReplaceDialog() {
  openFindReplaceDialog("replace");
}

function handleReplaceInTableKeydown(event) {
  if (!shortcutHelper.matchesBinding("replaceInTable", event)) return false;
  if (!activeDataTab.value) return false;
  event.preventDefault();
  event.stopPropagation();
  openReplaceDialog();
  return true;
}

async function handleReplacedAll(payload) {
  const tab = payload?.tab || payload;
  if (!tab) return;
  // 登记整表替换的撤销项（Ctrl+Z），patches 为后端返回的逐行正向变更。
  if (Array.isArray(payload?.patches) && payload.patches.length) {
    recordTableReplaceHistory(editState, {
      tableName: String(tab.tableKey || tab.tableName || ""),
      tabId: tab.id,
      label: "整表替换",
      patches: payload.patches,
    });
  }
  await refreshTabPage(tab, tab.page || 1);
  focusedPaneState.refreshCurrentSearchMatches?.();
}


function handleCloseTabKeydown(event) {
  if (!shortcutHelper.matchesBinding("closeTab", event)) return false;
  if (isEditableShortcutTarget(event.target)) return false;
  const tab = activeTab.value;
  if (!tab) return false;
  event.preventDefault();
  event.stopPropagation();
  closeTab(tab.id);
  return true;
}

function handleCycleTabKeydown(event) {
  const pane = getFocusedPane(workspace);
  if (!pane) return false;
  const isNext = shortcutHelper.matchesBinding("nextTab", event);
  const isPrev = shortcutHelper.matchesBinding("previousTab", event);
  if (!isNext && !isPrev) return false;
  if (isEditableShortcutTarget(event.target)) return false;
  const direction = isPrev ? "previous" : "next";
  const nextTabId = adjacentPublishedTabId(workspace.tabs, pane, direction);
  if (!nextTabId) return false;
  event.preventDefault();
  event.stopPropagation();
  void activateTab(pane.id, nextTabId);
  return true;
}

function handleGlobalHomeClipboardKeydown(event) {
  if (activeTab.value?.kind !== "home") return false;
  if (isEditableShortcutTarget(event.target)) return false;
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return false;
  const key = String(event.key || "").toLowerCase();
  const handled = key === "c"
    ? focusedPaneState.copyHomeSelection?.() === true
    : key === "v"
      ? focusedPaneState.pasteHomeTables?.() === true
      : false;
  if (!handled) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function focusSidebarSearchFromAnywhere() {
  // If a cell is being inline-edited, commit it first WITHOUT refocusing the
  // grid. Otherwise focusSearch() moves focus to the sidebar, the editor
  // input blurs, @cell-blur fires finishEditing(), and its nextTick refocus
  // steals focus back to the grid — so the user would have to press Ctrl+P
  // twice. Clearing editingCell first (with skipRefocus) makes the subsequent
  // blur-triggered finishEditing() early-return (editingCell already null),
  // leaving focus on the sidebar search box.
  //
  // Editing state lives per-pane (each WorkbenchPane owns its useGridEditor),
  // so we reach the focused pane's editor via focusedPaneState rather than the
  // legacy top-level editor instance.
  if (focusedPaneState.isEditing?.()) focusedPaneState.commitEditingWithoutRefocus?.();
  sidebarRef.value?.focusSearch?.();
}

// Ctrl+P 入口：打开 Quick Open 浮层。沿用 focusSidebarSearchFromAnywhere 的
// 编辑态处理——若正在编辑单元格，先无焦点回退地提交，避免浮层 input 抢焦点
// 触发 cell-blur 把焦点又夺回网格。
function openQuickOpenFromAnywhere() {
  if (focusedPaneState.isEditing?.()) focusedPaneState.commitEditingWithoutRefocus?.();
  quickOpenVisible.value = true;
}

function handleFavoriteDatabaseShortcutKeydown(event) {
  const target = pinnedDatabases.value.find((entry) => entry.shortcut && matchesShortcutCombo(entry.shortcut, event));
  if (!target) return false;
  event.preventDefault();
  event.stopPropagation();
  void openFavoriteDatabase(target);
  return true;
}

function preventDialogShortcutDefault(event) {
  const matchedAction = Object.keys(shortcutHelper.bindings).find(
    (action) => action !== "openWindow" && shortcutHelper.matchesBinding(action, event),
  );
  const matchesFavorite = pinnedDatabases.value.some(
    (entry) => entry.shortcut && matchesShortcutCombo(entry.shortcut, event),
  );
  if (!matchedAction && !matchesFavorite && !isNativeFindKeydown(event)) return;
  // Keep the browser's native undo/redo inside dialog text fields. Every
  // other configured app shortcut is inert while a dialog owns the keyboard.
  if (matchedAction === "undo" && isEditableShortcutTarget(event.target)) return;
  event.preventDefault();
}

function handleGlobalShortcutKeydown(event) {
  if (event.target?.closest?.('[data-wb-shortcut-capture="true"]')) return;
  if (dialogLayerManager.hasActiveModalLayer()) {
    preventDialogShortcutDefault(event);
    return;
  }
  if (shortcutHelper.matchesBinding("pinWindow", event)) {
    event.preventDefault();
    event.stopPropagation();
    void toggleWindowPin();
    return;
  }
  if (handleOpenSqlQueryKeydown(event)) return;
  if (handleOpenTableTransferKeydown(event)) return;
  if (handleCloseTabKeydown(event)) return;
  if (handleCycleTabKeydown(event)) return;
  if (handleGlobalHomeClipboardKeydown(event)) return;
  if (handleGlobalTableSearchKeydown(event)) return;
  if (handleReplaceInTableKeydown(event)) return;
  if (shortcutHelper.matchesBinding("searchDatabase", event)) {
    // Always cancel the native print dialog — Ctrl+P is reserved for the
    // database search and must never open the browser print page, even when
    // focus is already inside an editable element such as the search box.
    event.preventDefault();
    event.stopPropagation();
    // Ctrl+P must open the Quick Open palette from anywhere — including while
    // the user is typing inside an editable element (cell editor, AI input, the
    // search box itself, …). We intentionally do NOT guard with
    // isEditableShortcutTarget so the search is always reachable.
    openQuickOpenFromAnywhere();
    return;
  }
  // Existing app shortcuts always win if a later settings change creates a
  // collision with a previously assigned favorite shortcut.
  if (Object.keys(shortcutHelper.bindings).some((action) => shortcutHelper.matchesBinding(action, event))) return;
  handleFavoriteDatabaseShortcutKeydown(event);
}

function handleWorkbenchKeydown(event) {
  if (dialogLayerManager.hasActiveModalLayer()) return;
  // Ctrl+P focuses the sidebar database search box from anywhere (#8).
  if (handleSidebarSearchKeydown(event)) return;
  if (typeof focusedPaneState.handleWorkbenchKeydown === "function") {
    focusedPaneState.handleWorkbenchKeydown(event);
    return;
  }
  if (handleTableFindKeydown(event)) return;
  if (handleOpenDesignKeydown(event)) return;
  if (handleRedoKeydown(event)) return;
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
      const targetEntry = targetIndex == null ? null : gridRowEntries(tab)[targetIndex];
      if (targetEntry?.type === "insert") scrollInsertCellIntoView(0, targetIndex, { scrollColumn: false });
      else if (targetEntry) scrollRowIntoView(targetEntry.dataIndex);
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

async function commitInsertRowsAndRefresh(tab) {
  const drafts = nonEmptyInsertDrafts(tab);
  const result = await commitInsertRows(tab);
  if (result?.insertedRows > 0) {
    await refreshTabPage(tab, tab.page || 1);
    clearInsertDraft(tab);
    clearSelection({ clearInsertDrafts: true });
  }
  if (result?.failedRowId) return;
  const lastDraft = drafts[Math.max(0, result.insertedRows - 1)]?.draft;
  if (lastDraft && selectVisibleInsertedRow(tab, lastDraft)) return;
  gridWrapRef.value?.focus();
}

function sortPage(tab, col) {
  resetGridState();
  toggleSort(tab, col);
}

let loadMoreFrame = 0;
let pendingLoadMoreTarget = null;

function maybeLoadMoreRows(target) {
  const tab = activeDataTab.value;
  if (!tab || !target || tab.loadingMore || tab.fullyLoaded) return;
  const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
  if (remaining < resolveGridRowHeight(tab) * 20) loadNextPage(tab);
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
    // Freeze-panes state lives on each tab; include the per-tab frozen counts so
    // changes persist without requiring a tab switch / length change to trigger.
    JSON.stringify(workspace.tabs.map((tab) => [
      tab?.frozenRowStart,
      tab?.frozenRowCount,
      tab?.frozenColumnCount,
      tab?.fieldCommentsExpanded,
      tab?.rowHeight,
      tab?.fieldCommentHeight,
      tab?.kind === "sql" ? tab.sql : undefined,
      tab?.kind === "sql" ? tab.dirty : undefined,
      tab?.kind === "sql" ? tab.filePath : undefined,
      tab?.kind === "sql" ? tab.documentId : undefined,
      tab?.kind === "sql" ? tab.title : undefined,
      tab?.kind === "sql" ? tab.limit : undefined,
      tab?.kind === "sql" ? tab.autoCommit : undefined,
      tab?.kind === "sql" ? tab.editorRatio : undefined,
    ])),
  ],
  () => {
    syncSqlDocumentsFromTabs();
    persistWorkspace();
  },
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
    const paneId = savedTabToPane.get(savedTab.id) || snapshot.focusedPaneId || workspace.focusedPaneId;
    if (savedTab.kind === "sql-library") {
      const restoredLibrary = openSqlLibraryTab(workspace, { paneId, activate: false });
      if (restoredLibrary) savedToRestoredTabId.set(savedTab.id, restoredLibrary.id);
      continue;
    }
    if (savedTab.kind === "sql") {
      const restoredSql = openSqlQueryTab(workspace, {
        connectionId: savedTab.connectionId || currentConnectionId,
        database: savedTab.database || currentDatabase,
        readOnly: Boolean(savedTab.readOnly || savedTab.read_only || isReadOnlyConnection(savedTab.connectionId || currentConnectionId)),
        title: savedTab.title,
        documentId: savedTab.documentId,
        sql: savedTab.sql,
        savedSql: savedTab.savedSql,
        dirty: savedTab.dirty,
        filePath: savedTab.filePath,
        fileName: savedTab.fileName,
        limit: savedTab.limit,
        timeoutSeconds: savedTab.timeoutSeconds,
        autoCommit: savedTab.autoCommit,
        editorRatio: savedTab.editorRatio,
      }, { activate: false, paneId });
      if (restoredSql) savedToRestoredTabId.set(savedTab.id, restoredSql.id);
      continue;
    }
    if (savedTab.connectionId && savedTab.connectionId !== currentConnectionId) continue;
    if (savedTab.database && savedTab.database !== currentDatabase) continue;
    if (savedTab.kind === "home") {
      const restoredHome = openDatabaseHomeTab(workspace, {
        connectionId: currentConnectionId,
        database: currentDatabase,
        readOnly: Boolean(savedTab.readOnly || savedTab.read_only || isReadOnlyConnection(currentConnectionId)),
      }, { activate: false, paneId });
      if (restoredHome) {
        restoredHome.query = savedTab.query || "";
        restoredHome.sortMode = savedTab.sortMode || "nameAsc";
        restoredHome.selectedTableNames = Array.isArray(savedTab.selectedTableNames) ? [...savedTab.selectedTableNames] : [];
        restoredHome.focusedTableName = savedTab.focusedTableName || restoredHome.selectedTableNames.at(-1) || "";
        savedToRestoredTabId.set(savedTab.id, restoredHome.id);
      }
      continue;
    }
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
      // Freeze panes: restore per-tab pinned rows/columns (default 0 when absent).
      restoredTab.frozenRowStart = Math.max(0, Math.floor(Number(savedTab.frozenRowStart) || 0));
      restoredTab.frozenRowCount = Math.max(0, Math.min(MAX_FROZEN_ROWS, Number(savedTab.frozenRowCount) || 0));
      restoredTab.frozenColumnCount = Math.max(0, Math.min(MAX_FROZEN_COLS, Number(savedTab.frozenColumnCount) || 0));
      if (Array.isArray(savedTab.columnOrder) && savedTab.columnOrder.length) {
        restoredTab.columnOrder = savedTab.columnOrder;
        reapplyTabColumnOrder(restoredTab);
      }
      restoredTab.fieldCommentsExpanded = savedTab.fieldCommentsExpanded !== false;
      restoredTab.rowHeight = resolveGridRowHeight(savedTab);
      restoredTab.fieldCommentHeight = resolveFieldCommentHeight(savedTab);
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
  normalizeHomeTabOrder(workspace);
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
  syncSqlDocumentsFromTabs();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
onMounted(async () => {
  markPerf("workbench.mounted");
  tableModifiedTimeAutoRefresh.start();
  void updater.startBackgroundListener();
  void updater.checkForUpdates({ silent: true });
  void ensureSqlExecutionListener();
  window.addEventListener("resize", onWindowResize);
  // Capture-phase listener so native WebView shortcuts are intercepted before
  // Ctrl+F opens find-in-page or Ctrl+P opens the print dialog.
  document.addEventListener("keydown", handleGlobalShortcutKeydown, true);
  void windowPin.sync();
  // Re-register the global "open window" shortcut from the persisted binding
  // so a user-rebound combo takes effect this session instead of the Rust
  // startup default (analysis point #2). Best-effort; failures don't block UI.
  void syncGlobalShortcutBinding();
  try {
    await conn.loadConnections();
    // Saved connection URLs are restored by loadConnections(). Only mark the
    // external MCP frontend ready afterwards, so a hidden cold start cannot
    // race its first DB/UI request against connection restoration.
    await agent.ensureControlListener();
    markPerf("workbench.connections-ready", { connections: connections.value.length, databases: databases.value.length });
    await restoreSavedTabs();
    await ensureCurrentDatabaseHome();
    markPerf("workbench.tabs-restored", { tabs: workspace.tabs.length });
    sampleNextFrame("workbench.first-usable-frame", { tabs: workspace.tabs.length, tables: workspace.tables.length });
  } catch (e) {
    // Still release queued MCP calls so they receive the real connection error
    // instead of waiting until the control timeout.
    await agent.ensureControlListener();
    conn.statusText.value = `初始化失败：${String(e)}`;
  }
  persistenceReady = true;
  persistWorkspace();
});

onBeforeUnmount(() => {
  tableModifiedTimeAutoRefresh.stop();
  void agent.disposeControlListener();
  agent.disposeRuntimeListener();
  disposeConnection();
  void disposeGlobalTableSearch();
  void disposeTableSessions();
  window.removeEventListener("resize", onWindowResize);
  document.removeEventListener("keydown", handleGlobalShortcutKeydown, true);
  databaseSync.dispose();
  backupCenter.dispose();
  tableTransfer.dispose();
  updater.stopBackgroundListener();
  unlistenValueSearchProgress?.();
  unlistenValueSearchProgress = null;
  unlistenSqlExecution?.();
  unlistenSqlExecution = null;
});
</script>

<template>
  <main
    class="mysql-workbench"
    :class="{
      'is-dragging': paneIsDragging,
      'is-inspector-collapsed': inspectorCollapsed,
      'is-opening-table': pendingTableOpenCount > 0,
      'is-native-macos': usesNativeMacWindowControls,
    }"
    :data-theme="effectiveTheme"
    :style="[sidebarLayoutVars, quickOpenClearanceVars]"
    @transitionend="onSidebarLayoutTransitionEnd"
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
      @dblclick.self="handleTitlebarDoubleClick"
    >
      <div
        class="wb-titlebar-sidebar"
        :class="{
          'is-collapsed': sidebarCollapsed && !sidebarPaneAnimating,
          'is-retracted': sidebarCollapsed,
        }"
        id="wb-topbar-sidebar-actions"
        aria-label="数据库操作"
        data-tauri-drag-region
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


      <div
        class="wb-titlebar-tabs"
        id="wb-topbar-tabs"
        aria-label="表标签"
        data-tauri-drag-region
      >
        <button
          type="button"
          class="wb-quick-open-entry"
          ref="quickOpenEntryRef"
          :title="quickOpenEntryTitle"
          :aria-label="quickOpenEntryAriaLabel"
          @click.stop="openQuickOpenFromAnywhere"
        >
          <svg class="wb-quick-open-entry-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="6.2" cy="6.2" r="3.4" />
            <path d="M8.8 8.8l2.4 2.4M9.8 5.2h4.1v8.7H5.2v-3.1M9.8 8.1h4.1M9.8 11h4.1" />
          </svg>
          <span class="wb-quick-open-entry-label">快速打开</span>
          <kbd v-if="quickOpenShortcutLabel">{{ quickOpenShortcutLabel }}</kbd>
        </button>
      </div>


      <div
        class="wb-titlebar-inspector-controls"
        :class="{ 'is-collapsed': inspectorCollapsed }"
        :style="inspectorTitlebarStyle"
        aria-label="备注区域操作"
        data-tauri-drag-region
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
        class="wb-pin-entry-button"
        :class="{ 'is-pinned': windowPin.pinned.value }"
        :disabled="windowPin.pending.value"
        :title="windowPinButtonLabel"
        :aria-label="windowPinButtonLabel"
        :aria-keyshortcuts="shortcutHelper.get('pinWindow') || undefined"
        :aria-pressed="windowPin.pinned.value"
        :aria-busy="windowPin.pending.value ? 'true' : undefined"
        @click.stop="toggleWindowPin"
      >
        <Pin
          :size="16"
          :stroke-width="1.65"
          :fill="windowPin.pinned.value ? 'currentColor' : 'none'"
          aria-hidden="true"
        />
      </button>

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
      <div
        v-if="!usesNativeMacWindowControls"
        class="wb-titlebar-controls"
        aria-label="窗口控制"
      >
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
      <div v-if="showNarrowHint" class="wb-narrow-hint" role="status">
        <span class="wb-narrow-hint-text">窗口较窄，建议收起侧边栏以获得更大的数据区域</span>
        <span class="wb-narrow-hint-actions">
          <button type="button" class="wb-narrow-hint-btn" @click="toggleSidebar()">收起侧边栏</button>
          <button type="button" class="wb-narrow-hint-btn" @click="focusCurrentTableOnly()">只看当前表</button>
        </span>
      </div>
      <div
        class="wb-sidebar-slot"
        :class="{
          'is-pane-animating': sidebarPaneAnimating,
          'is-expanding': sidebarPanePhase === 'expanding',
        }"
      >
        <WorkbenchSidebar
          ref="sidebarRef"
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
        :color-themes="colorThemes"
        :color-theme="currentColorTheme"
        @set-color-theme="setColorTheme"
        :font-preference="fontPreference"
        :font-weight="fontWeight"
        :font-label="fontLabel"
        :invoke-workbench="invokeWorkbench"
        :busy="busy"
        @update:tree-query="treeQuery = $event"
        @search-values="runSidebarValueSearch"
        @cancel-search-values="cancelSidebarValueSearch"
        @open-schema-result="openSidebarSchemaResult"
        @open-value-result="openSidebarValueResult"
        @select-connection="selectConnection($event)"
        @select-database="selectDatabaseWithHome($event)"
        @reorder-connections="reorderConnections"
        @reorder-databases="reorderDatabases"
        @open-table="openTableFromSidebar"
        @rename-table="openTableRenameFromSource"
        @rename-database="openDatabaseAliasDialog"
        @rename-connection="openConnectionAliasDialog"
        @open-connection="openConnDialog"
        @open-backup-center="openBackupCenter"
        @open-table-transfer="openTableTransfer"
        @contextmenu="openSidebarContextMenu"
        @toggle-theme="toggleTheme"
        @change-font="applyFontSettings"
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
          :home-tables="workspace.schema"
          :home-clipboard="homeTableClipboard"
          :recent-table-names="recentHomeTableNames"
          :sql-documents="sqlDocuments"
          :current-connection-id="selectedConnectionId"
          :schema="workspace.schema"
          :connections="visibleConnections"
          :databases="databases"
          :fetch-page="refreshTabPage"
          :load-next-page="loadNextPage"
          :load-previous-page="loadPreviousPage"
          :jump-to-table-boundary="jumpToTableBoundary"
          :load-search-result-page="loadSearchResultPage"
          :load-next-search-result-page="loadNextSearchResultPage"
          :cancel-search-result-page="cancelSearchResultPage"
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
          @row-contextmenu="openActiveRowContextMenu"
          @detail-contextmenu="openDetailContextMenu"
          @open-design="openTableDesign"
          @design-applied="handleTableDesignApplied"
          @sql-schema-changed="() => conn.loadTables({ connectionId: selectedConnectionId, database: selectedDatabase })"
          @export="exportTable"
          @import="triggerImport"
          @replace="openReplaceDialog"
          @batch-export="openBatchExport"
          @batch-import="openBatchImport"
          @save-reminder="showSaveReminderAt"
          @state-change="handlePaneStateChange"
          @page-refreshed="clearTabCellErrors"
          @cell-committed="syncCommittedCellToSiblingTabs"
          @schema-search-previous="focusedPaneState.goToPreviousSchemaSearchMatch?.()"
          @schema-search-next="focusedPaneState.goToNextSchemaSearchMatch?.()"
          @open-home-table="openTableFromHome"
          @copy-home-tables="copyHomeTables"
          @paste-home-tables="pasteHomeTables"
          @rename-home-table="renameHomeTable"
          @delete-home-tables="deleteHomeTables"
          @send-home-tables="sendHomeTables"
          @refresh-home="refreshHome"
          @home-visible-tables="loadVisibleHomeTableCounts"
          @focus-home-table="focusHomeTable"
          @open-sql-library="openSqlLibrary"
          @new-sql-query="newSqlQuery"
          @open-sql-document="openSqlDocument"
          @duplicate-sql-document="duplicateSqlDocument"
          @rename-sql-document="renameSqlDocument"
          @delete-sql-document="deleteSqlDocument"
          @open-sql-file="openSqlFile"
        />
        <DatabaseGlowOverlay :playback="switchGlowPlayback" />
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
        :projects="agentProjects"
        :active-tab="focusedInspectorTab"
        :schema="workspace.schema"
        :selected-cell="focusedSelectedCell"
        :selected-range="focusedSelectedRange"
        @send="sendAgentMessage"
        @open-table-reference="openAgentTableReference"
        @open-reference="openAgentReference"
        @open-update="openUpdateDialog"
      />
      <InspectorPanel
        v-else
        :class="{ 'is-collapsed': inspectorCollapsed }"
        :style="inspectorStyle"
        :active-tab="focusedInspectorTab"
        :active-columns="focusedActiveColumns"
        :selected-cell="focusedSelectedCell"
        :selected-range="focusedSelectedRange"
        :active-status-label="activeStatusLabel"
        :schema-search-query="focusedPaneState.activeDataTab?.schemaSearchQuery || ''"
        :schema-search-matches="focusedPaneState.activeDataTab?.schemaSearchMatches || []"
        :schema-search-index="focusedPaneState.activeDataTab?.schemaSearchIndex ?? -1"
        @contextmenu="openInspectorContextMenu"
        @select-column="focusedPaneState.selectCurrentRowColumn?.($event)"
        @schema-search="focusedPaneState.applyColumnSearch?.($event)"
        @schema-search-previous="focusedPaneState.goToPreviousSchemaSearchMatch?.()"
        @schema-search-next="focusedPaneState.goToNextSchemaSearchMatch?.()"
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

    <ConfirmDialog
      :open="globalConfirmDialog.open"
      :title="globalConfirmDialog.title"
      :message="globalConfirmDialog.message"
      :items="globalConfirmDialog.items"
      :note="globalConfirmDialog.note"
      :confirm-text="globalConfirmDialog.confirmText"
      :alternative-text="globalConfirmDialog.alternativeText"
      :cancel-text="globalConfirmDialog.cancelText"
      :danger="globalConfirmDialog.danger"
      :alternative-danger="globalConfirmDialog.alternativeDanger"
      @confirm="closeGlobalConfirm(true)"
      @alternative="closeGlobalConfirm('alternative')"
      @cancel="closeGlobalConfirm(false)"
    />

    <ContextMenu
      :open="contextMenu.open"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :table-scoped="contextMenu.tableScoped"
      :kind="contextMenu.kind"
      :surface="contextMenu.surface"
      :show-clipboard-actions="contextMenu.showClipboardActions"
      :can-copy="contextMenu.canCopy"
      :can-paste="contextMenu.canPaste"
      :connection-id="contextMenu.connectionId"
      :database="contextMenu.database"
      :table-name="contextMenu.tableName"
      :row-read-only="contextMenu.rowReadOnly"
      :can-insert-copied-rows="contextMenu.canInsertCopiedRows"
      :can-set-null="canSetCellNull"
      :can-toggle-hit-result-pane="contextMenu.canToggleHitResultPane"
      :hit-result-pane-open="contextMenu.hitResultPaneOpen"
      :delete-label="contextMenuDeleteLabel"
      :can-freeze-row="canFreezeRow"
      :can-freeze-column="canFreezeColumn"
      :can-freeze-cell="canFreezeCell"
      :has-freeze="hasFreeze"
      :can-reset-column-order="canResetColumnOrder"
      :freeze-row-label="freezeRowLabel"
      :freeze-column-label="freezeColumnLabel"
      :freeze-cell-label="freezeCellLabel"
      @refresh="refreshFromContextMenu"
      @copy="copyFromContextMenu"
      @paste="pasteFromContextMenu"
      @open-design="openDesignFromContextMenu"
      @sync-database="openDatabaseSync"
      @send-table="openTableCopyFromContext"
      @rename="openTableRenameFromContext"
      @rename-database="openDatabaseAliasFromContext"
      @rename-connection="openConnectionAliasFromContext"
      @remove-connection="removeConnectionFromContext"
      @grid-row-insert-above="onGridRowInsertAbove"
      @grid-row-insert-below="onGridRowInsertBelow"
      @grid-row-paste-above="onGridRowPasteAbove"
      @grid-row-delete="onGridRowDelete"
      @set-null="onSetCellToNull"
      @toggle-hit-result-pane="toggleHitResultPane"
      @freeze-row="onFreezeRow"
      @freeze-column="onFreezeColumn"
      @freeze-cell="onFreezeCell"
      @freeze-top-row="onFreezeTopRow"
      @freeze-first-column="onFreezeFirstColumn"
      @unfreeze="onUnfreeze"
      @reset-column-order="onResetColumnOrder"
    />

    <menu
      v-if="tabContextMenu.open"
      class="wb-context-menu wb-tab-context-menu"
      :style="{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }"
      @click.stop
    >
      <button type="button" @click="refreshTabsFromMenu">刷新</button>
      <button type="button" :disabled="!tabContextNeighborAvailability.left" @click="closeRelativeTabsFromMenu('left')">关闭左侧</button>
      <button type="button" :disabled="!tabContextNeighborAvailability.right" @click="closeRelativeTabsFromMenu('right')">关闭右侧</button>
      <button type="button" @click="closeAllTabsFromMenu">全部关闭</button>
    </menu>

    <DatabaseSyncDialog
      v-if="databaseSync.dialog.open"
      :sync="databaseSync"
      @close="databaseSync.close"
      @preview="databaseSync.preview"
      @execute="executeDatabaseSync"
      @cancel="databaseSync.cancel"
      @source-change="databaseSync.setSourceDatabase"
      @target-change="databaseSync.setTargetDatabase"
    />

    <TableCopyDialog
      v-if="tableCopy.dialog.open"
      :copy="tableCopy"
      :connections="visibleConnections"
      @close="tableCopy.close"
      @execute="executeTableCopy"
      @target-connection-change="handleTableCopyTargetConnection"
    />

    <FindReplaceDialog
      v-if="findReplaceVisible"
      :pane-state="focusedPaneState"
      :invoke-workbench="invokeWorkbench"
      :initial-tab="findReplaceTab"
      @close="findReplaceVisible = false"
      @replaced-all="handleReplacedAll"
    />

    <div v-if="editState.historyProgress" class="wb-history-progress-overlay">
      <div class="wb-history-progress" role="status" aria-live="polite">
        <div class="wb-history-progress-label">{{ editState.historyProgress.label }}</div>
        <div class="wb-history-progress-track">
          <div
            class="wb-history-progress-bar"
            :style="{ width: `${Math.round((editState.historyProgress.done / Math.max(1, editState.historyProgress.total)) * 100)}%` }"
          ></div>
        </div>
        <div class="wb-history-progress-count">
          {{ editState.historyProgress.done }} / {{ editState.historyProgress.total }}
        </div>
      </div>
    </div>

    <BatchExportDialog
      v-if="batchTransfer.batchExport.open"
      :transfer="batchTransfer"
      @close="batchTransfer.closeBatchExport"
      @execute="batchTransfer.executeBatchExport"
    />

    <BatchImportDialog
      v-if="batchTransfer.batchImport.open"
      :transfer="batchTransfer"
      @close="batchTransfer.closeBatchImport"
      @file-selected="onBatchImportFileSelected"
      @execute="executeBatchImport"
    />

    <BackupCenterDialog
      v-if="backupCenter.dialog.open"
      :backup="backupCenter"
      :connections="visibleConnections"
      :account="account"
      @close="backupCenter.close"
    />

    <TableTransferDialog
      v-if="tableTransfer.dialog.open"
      :transfer="tableTransfer"
      @close="tableTransfer.close"
    />

    <!-- Table Rename Dialog -->
    <div v-if="tableRename.open" class="wb-dialog-overlay">
      <form ref="tableRenameDialogRef" class="wb-dialog" role="dialog" aria-modal="true" aria-label="重命名表" tabindex="-1" @submit.prevent="executeTableRename">
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

    <div v-if="aliasDialog.open && aliasDialog.type === 'connection'" class="wb-dialog-overlay">
      <form ref="connectionAliasDialogRef" class="wb-dialog" role="dialog" aria-modal="true" aria-label="重命名连接" tabindex="-1" @submit.prevent="saveAlias">
        <header class="wb-dialog-header">
          <strong>{{ aliasDialog.type === "connection" ? "重命名连接（本地别名）" : "重命名数据库（本地别名）" }}</strong>
          <button type="button" class="wb-dialog-close" @click="closeAliasDialog">×</button>
        </header>
        <p style="margin: 0 0 10px; font-size: 12px; color: var(--wb-secondary-text);">
          {{ aliasDialog.type === "connection" ? "真实连接" : "真实库名" }}：{{ aliasDialog.realName }}（仅修改本地显示，不影响实际{{ aliasDialog.type === "connection" ? "连接" : "数据库" }}）
        </p>
        <label class="wb-dialog-field">
          <span>别名</span>
          <input v-model="aliasDialog.alias" placeholder="留空可恢复真实名称" maxlength="60" autofocus />
        </label>
        <footer class="wb-dialog-actions">
          <button type="button" @click="closeAliasDialog">取消</button>
          <button type="submit">保存</button>
        </footer>
      </form>
    </div>

    <DatabaseDisplayDialog
      :open="aliasDialog.open && aliasDialog.type === 'database'"
      :real-name="aliasDialog.realName"
      :alias="aliasDialog.alias"
      :icon="aliasDialog.icon"
      :color="aliasDialog.color"
      :text-color="aliasDialog.textColor"
      @close="closeAliasDialog"
      @save="saveDatabaseDisplay"
    />

    <UpdateDialog
      v-if="updater.isDialogOpen.value"
      :updater="updater"
      @close="updater.closeDialog"
      @check="updater.checkForUpdates({ openOnError: true, openOnAvailable: true })"
      @download-and-install="updater.downloadAndInstall"
      @pick-directory="updater.pickUpdateDirectory"
      @relaunch="updater.relaunch"
    />

    <Transition name="wb-update-notice">
      <UpdateNotice
        v-if="updater.isNoticeVisible.value"
        :updater="updater"
        @close="updater.closeNotice"
        @open="openUpdateDialog"
      />
    </Transition>

    <ImportWizardDialog
      v-if="importWizard.open"
      :wizard="importWizard"
      :active-tab="activeDataTab"
      @close="closeImportWizard"
      @file-selected="onImportFileSelected"
      @file-dropped="selectImportFile"
      @parse-sheet="parseImportSheet"
      @go-step="goToImportStep"
      @execute="executeImport"
      @compare="compareImportChanges"
      @cancel="cancelImport"
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
      @config-import="applyConnConfigImport"
      @config-import-error="rejectConnConfigImport"
    />

    <QuickOpenPalette
      v-model:visible="quickOpenVisible"
      v-model:query="quickOpenQuery"
      :connection-id="selectedConnectionId"
      :database="selectedDatabase"
      :tables="workspace.tables"
      :schema="schemaSearchSource"
      :databases="databases"
      :connections="visibleConnections"
      :pinned-databases="pinnedDatabases"
      :databases-by-connection="databasesByConnection"
      :database-fetch-errors="databaseFetchErrors"
      :connection-label="connectionLabel"
      :database-label="databaseLabel"
      :value-search-state="quickOpenValueSearch"
      :theme="effectiveTheme"
      @open-table="openQuickOpenTable"
      @select-database="selectDatabaseFromPalette"
      @toggle-pin-database="togglePinnedDatabaseFromPalette"
      @reconnect-connection="reconnectConnectionFromPalette"
      @search-values="runQuickOpenValueSearch"
      @cancel-search-values="cancelQuickOpenValueSearch"
      @open-value-result="openQuickOpenValueResult"
    />

  </main>
</template>
