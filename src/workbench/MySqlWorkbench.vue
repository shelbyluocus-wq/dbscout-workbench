<script setup>
import { t } from "./i18n/index.js";
import WallpaperCanvas from "./components/WallpaperCanvas.vue";
import { useWallpaper } from "./composables/useWallpaper.js";
const {
  source: wallpaperSource, settings: wallpaperSettings, contentVeil: wallpaperVeil,
  setAppearance: setWallpaperAppearance,
} = useWallpaper();
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, toRaw, watch } from "vue";
import { ArrowLeftToLine, ArrowRightToLine, CopyX, DatabaseZap, Download, FolderOpen, Link2, ListX, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pencil, Pin, Plug, RefreshCw, Rocket, Send, ShieldCheck, TableProperties, Upload, X } from "lucide-vue-next";

import {
  applyTableSchemaToDataTab,
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
  openTableFoldersTab,
  openSqlQueryTab,
  openTableDesignTab,
  openCreateTableTab,
  openTableTab,
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
import { useMacosTrafficLights } from "./composables/useMacosTrafficLights.js";
import { formatShortcutForPlatform, isMacOSPlatform } from "./utils/desktopPlatform.js";
import { useNativeAppMenu } from "./composables/useNativeAppMenu.js";
import { useTableFolderStore } from "./composables/tableFolderStore.js";
import { useTableFolders } from "./composables/useTableFolders.js";
import { TABLE_FOLDER_CONTEXT } from "./composables/tableFolderContext.js";
import { currentWindowRole, isTableFolderWindowRole } from "./utils/windowRole.js";
import { createPageZoom, createPageZoomWheelHandler, pageZoomAction } from "./utils/pageZoom.js";
import { noteShortcutKeydownMatch } from "./utils/menuShortcutDedup.js";
import { useMacosTitlebarDoubleClick } from "./composables/useMacosTitlebar.js";
import { useMacosVibrancy } from "./composables/useMacosVibrancy.js";
import { APP_VERSION } from "./appVersion.js";
import { handleMenuKeydown } from "./utils/menuKeyboard.js";
import { confirmOpeningTables } from "./utils/listSelection.js";
import { dispatchSqlExecutionEvent } from "./sqlExecutionState.js";
import { rememberRecentSqlFile } from "./utils/sqlRecentFiles.js";
import { useSqlQueryDocumentStore } from "./composables/sqlQueryDocumentStore.js";
import { createCoalescedTask } from "./utils/coalescedTask.js";
import { createTabSourceSync } from "./utils/tabSourceSync.js";
import { applySavedTableTabState, savedTableTabMatchesSource } from "./utils/savedTabRestore.js";
import { MAX_FROZEN_COLS } from "./constants.js";
import { resolveGridRowHeight } from "./utils/gridRowHeight.js";
import {
  SHORTCUT_LABELS,
  isSafeInAppShortcut,
  matchesShortcutCombo,
  sameShortcutCombo,
  useShortcuts,
} from "./composables/useShortcuts.js";
import { HOME_DATABASE_FAVORITES_CONTEXT } from "./composables/homeDatabaseFavoritesContext.js";
import { useWindowPin } from "./composables/useWindowPin.js";
import { useTabShortcutHints } from "./composables/useTabShortcutHints.js";
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
import { manualColumnWidthsOf } from "./utils/columnWidth.js";
import { highlightCellResult as _highlightCellResult } from "./utils/cellDisplay.js";
import { buildRowKey } from "./utils/rowIdentity.js";
import { primaryKeyFilter } from "./utils/controlNavigation.js";
import { gridRowKey } from "./utils/gridRowIdentity.js";
import { createRowIndex } from "./utils/rowIndex.js";
import { applyCommittedCellToTab } from "./utils/committedCellSync.js";
import { gridSelectionCount, isGridCellSelected } from "./utils/gridCellSelection.js";
import { markPerf, sampleNextFrame } from "./utils/performanceMarks.js";
import { resolveHomeDesignTargets } from "./utils/homeDesignTargets.js";
import { adjacentPublishedTabId } from "./utils/tabPublication.js";
import { isReservedTabShortcutCombo, isTabShortcutEvent } from "./utils/tabShortcutHints.js";
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

import WorkbenchActivityRail from "./components/WorkbenchActivityRail.vue";
import WorkbenchSidebar from "./components/WorkbenchSidebar.vue";
import WorkbenchSplitLayout from "./components/WorkbenchSplitLayout.vue";
import DataGrid from "./components/DataGrid.vue";
import TableDesignEditor from "./components/TableDesignEditor.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import PaneDivider from "./components/PaneDivider.vue";
import QuickOpenPalette from "./components/QuickOpenPalette.vue";
import ContextMenu from "./components/ContextMenu.vue";
import CommentEditDialog from "./components/CommentEditDialog.vue";
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
// The release workspace is large and rarely opened: load it on first use.
const ReleaseFlowDialog = defineAsyncComponent(() => import("./components/ReleaseFlowDialog.vue"));
const BlackcatMcpDialog = defineAsyncComponent(() => import("./components/BlackcatMcpDialog.vue"));
const AccountStartupLoginDialog = defineAsyncComponent(() => import("./components/AccountStartupLoginDialog.vue"));
import AiActivityGlow from "./components/AiActivityGlow.vue";
import { requestSqlRun } from "./utils/sqlRunRequests.js";
import { applyAgentTableViewState } from "./utils/agentTableView.js";
import ConfigRelationsDialog from "./components/ConfigRelationsDialog.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import HomeDatabaseFavorites from "./components/HomeDatabaseFavorites.vue";
import OperationNoticeStack from "./components/OperationNoticeStack.vue";
import { createOperationNotices } from "./operationNotices.js";
import { describeStatusMessage } from "./utils/statusMessages.js";

import { SOURCE_SELECTION, useConnection } from "./composables/useConnection.js";
import { connectionHasCapability } from "./utils/connectionKinds.js";
import { createDatabaseSwitchGlow, resolveSwitchGlow } from "./composables/useDatabaseSwitchGlow.js";
import { databaseTextColorCss } from "./composables/databaseDecorationStore.js";
import DatabaseGlowOverlay from "./components/DatabaseGlowOverlay.vue";
import {
  TABLE_MODIFIED_TIMES_UPDATED_EVENT,
  createTableModifiedTimeAutoRefresh,
} from "./composables/tableModifiedTimeRefresh.js";
import { useTableSession } from "./composables/useTableSession.js";
import { useTableSearch } from "./composables/useTableSearch.js";
import { useVirtualGrid } from "./composables/useVirtualGrid.js";
import { useFreezePanes } from "./composables/useFreezePanes.js";
import { applyResolvedFreeze } from "./utils/freezeSelection.js";
import { useGridEditor } from "./composables/useGridEditor.js";
import { useRowSelection } from "./composables/useRowSelection.js";
import { useContextMenu } from "./composables/useContextMenu.js";
import { resolveInspectorCommentTarget } from "./utils/inspectorCommentTarget.js";
import { applySchemaComment } from "./utils/applySchemaComment.js";
import { useDatabaseSync } from "./composables/useDatabaseSync.js";
import { useBackupCenter } from "./composables/useBackupCenter.js";
import { useTableTransfer } from "./composables/useTableTransfer.js";
import { textInputClipboard, usesNativeTextMenu } from "./utils/textInputClipboard.js";
import { useActivityRail } from "./composables/useActivityRail.js";
import { useRailDatabases } from "./composables/useRailDatabases.js";
import { useConfigRelations } from "./composables/useConfigRelations.js";
import { CONFIG_RELATION_CONTEXT } from "./composables/configRelationContext.js";
import { normalizeRelationFilter, normalizeRelationOrigin } from "./utils/relationFilter.js";
import { connectionOffersConfigRelations } from "./utils/configRelations.js";
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
import { inspectorSurfaceFor } from "./inspectorVisibility.js";
import { applyNativeWindowTheme, useTheme } from "./composables/useTheme.js";
import { createColorThemeController } from "./colorThemeController.js";
import { useFontPreference } from "./composables/useFontPreference.js";
import { useUpdater } from "./composables/useUpdater.js";
import { useExternalMcp } from "./composables/useExternalMcp.js";

markPerf("workbench.module-loaded");

const SEARCH_VALUES_PROGRESS_EVENT = "search-values-progress";
const DETAIL_CONTEXT_MENU_HEIGHT = 112;
const usesNativeMacWindowControls = isTauriRuntime() && isMacOSPlatform();
// macOS: reads AppleActionOnDoubleClick (cached, refreshed on window focus)
// and swallows the injected drag-region double-click so only the
// setting-aware handlers act.
const macosTitlebar = useMacosTitlebarDoubleClick();

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
const WORKBENCH_REMINDER_TONES = Object.freeze({ success: "success", "export-success": "success", warning: "warning", error: "error" });
const operationNotices = createOperationNotices();
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
const { hintsVisible: tabShortcutHintsVisible, hide: hideTabShortcutHints } = useTabShortcutHints();
function withShortcutLabel(action, shortcut) {
  return shortcut ? t("shell.withShortcut", { action, shortcut: formatShortcutForPlatform(shortcut) }) : action;
}
const windowPin = useWindowPin();

// Reapply the saved global binding on startup, including a cleared binding.
async function syncGlobalShortcutBinding() {
  if (!isTauriRuntime()) return;
  try {
    await shortcutHelper.restoreGlobalBinding();
  } catch {
    // Native registration errors must not block the UI.
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
  statusRevision,
  statusError,
  drainStatusJournal,
  setStatus,
  loadConnections,
  selectConnection,
  selectDatabase,
  reorderConnections,
  reorderDatabases,
  loadTables,
  refreshTableModifiedTimes,
  applyTableModifiedUpdates,
  ensureTableSchema,
  isReadOnlyConnection,
  connectionCapability,
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
  loadVisibleDeferredTabs,
  preloadDeferredTabs,
  toggleSort,
  applySort,
  applySearchFilter,
  applyColumnFilter,
  clearColumnFilters,
  clearRelationFilter,
  dispose: disposeTableSessions,
} = useTableSession(
  workspace,
  invokeWorkbench,
  {
    busy: conn.busy,
    statusText: conn.statusText,
    setStatus: conn.setStatus,
    ensureTableSchema: conn.ensureTableSchema,
    onTableActivated: focusOpenedTableSearch,
  },
);

function focusOpenedTableSearch(tab) {
  void nextTick(() => {
    if (workspace.activeTabId !== tab.id || focusedPaneState.activeDataTab?.id !== tab.id) return;
    if (dialogLayerManager.hasActiveModalLayer()) return;
    focusedPaneState.focusTableSearch?.();
  });
}

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
  setCellToNull: null,
  clearSelectedCells: null,
  handleWorkbenchKeydown: null,
  isTableSearchTarget: null,
  clearSelection: null,
  resetGridScroll: null,
  selectCellAt: null,
  selectVisualCellAt: null,
  selectRangeAt: null,
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
  clearSelectedCells,
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

const canClearCells = computed(() => {
  if (contextMenu.surface !== "grid" || contextMenu.kind === "grid-row") return false;
  if (contextMenu.rowReadOnly || contextMenu.fromColumnHeader) return false;
  const anchor = Number(contextMenu.anchorIndex);
  if (!Number.isFinite(anchor) || anchor < 0 || Number(contextMenu.targetColumnIndex) < 0) return false;
  const range = focusedSelectedRange.value;
  if (gridSelectionCount(range) > 1) return true;
  const cell = focusedPaneState.selectedCell || selectedCell.value;
  if (!cell?.column) return false;
  const columns = columnsForCell(cell);
  const column = columns.find((item) => (item.column_name || item.columnName) === cell.column);
  if (!column) return false;
  return !Boolean(column.is_primary_key || column.isPrimaryKey);
});

const clearCellsLabel = computed(() => (
  gridSelectionCount(focusedSelectedRange.value) > 1
    ? t("contextMenu.clearCells")
    : t("contextMenu.clearCell")
));

const canGridCellRowActions = computed(() => (
  contextMenu.surface === "grid" &&
  contextMenu.kind !== "grid-row" &&
  !contextMenu.rowReadOnly &&
  !contextMenu.fromColumnHeader &&
  Boolean(contextMenu.row) &&
  Number.isFinite(Number(contextMenu.anchorIndex)) &&
  Number(contextMenu.anchorIndex) >= 0
));

const canAppendRow = computed(() => (
  contextMenu.surface === "grid" &&
  contextMenu.kind !== "grid-row" &&
  !contextMenu.rowReadOnly &&
  !contextMenu.fromColumnHeader &&
  !contextMenu.row &&
  Boolean(contextMenu.rowTab || activeDataTab.value)
));

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
  if (r >= 0 && c >= 0) return t("grid.freezeAtCell", { row: r + 1, column: c + 1 });
  return t("grid.freezeAtThisCell");
});

const freezeRowLabel = computed(() => {
  const idx = contextMenu.anchorIndex;
  return Number.isFinite(idx) ? t("grid.freezeThroughRow", { row: idx + 1 }) : t("grid.freezeThroughThisRow");
});

const freezeColumnLabel = computed(() => {
  const idx = contextMenuTargetColumnIndex.value;
  return idx >= 0 ? t("grid.freezeThroughColumn", { column: idx + 1 }) : t("grid.freezeThroughThisColumn");
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
// 右键行/单元格菜单的删除按钮文字：选中多行时显示「删除 X 行」。
const contextMenuDeleteLabel = computed(() => {
  const count = contextMenu.selectedRowCount || 0;
  if (count > 1) return `删除 ${count} 行`;
  return canGridCellRowActions.value ? t("contextMenu.deleteRow") : "删除行";
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
let unlistenTableCreated = null;
let unlistenTableModifiedTimes = null;

function handleTableModifiedTimesEvent(event) {
  applyTableModifiedUpdates(event?.payload || event || {});
}

function handleTableCreatedEvent(event) {
  const source = event?.payload || event || {};
  if (source.connectionId === selectedConnectionId.value && source.database === selectedDatabase.value) {
    void conn.loadTables(source).catch((error) => {
      setStatus(t("createTable.refreshFailed", { message: String(error?.message || error) }), { tone: "warning" });
    });
  }
  setStatus(source.warnings?.length ? source.warnings.join("；") : t("createTable.created"), { tone: source.warnings?.length ? "warning" : "success" });
}

function handleSqlExecutionEvent(event) {
  const payload = event?.payload || event || {};
  dispatchSqlExecutionEvent(workspace, payload);
  if (payload.type === "schema-changed") {
    void conn.loadTables({ connectionId: payload.connectionId, database: payload.database }).catch(() => {});
  }
}

async function ensureSqlExecutionListener() {
  if (!unlistenTableCreated) {
    const unlisten = await listenWorkbenchEvent("table-created", handleTableCreatedEvent);
    unlistenTableCreated = typeof unlisten === "function" ? unlisten : null;
  }
  if (!unlistenTableModifiedTimes) {
    const unlisten = await listenWorkbenchEvent(TABLE_MODIFIED_TIMES_UPDATED_EVENT, handleTableModifiedTimesEvent);
    unlistenTableModifiedTimes = typeof unlisten === "function" ? unlisten : null;
  }
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
  databasesByConnection,
  invokeWorkbench,
  listen: listenWorkbenchEvent,
});

const backupCenter = useBackupCenter({
  onDataChanged: (change = {}) => {
    const tabs = workspace.tabs.filter((tab) =>
      (tab.kind || "data") === "data" &&
      (!change.connectionId || tab.connectionId === change.connectionId) &&
      (!change.database || tab.database === change.database) &&
      (!change.table || tab.tableName === change.table)
    );
    // Refresh the visible tab first; other open copies refresh independently.
    tabs.sort((a, b) => Number(b.id === activeDataTab.value?.id) - Number(a.id === activeDataTab.value?.id));
    for (const tab of tabs) void refreshTabPage(tab, tab.page || 1, { inPlace: true });
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

// Release guide: the workspace keeps its own progress, so reopening it resumes.
const releaseFlowOpen = ref(false);
const releaseFlowMinimized = ref(false);
const releaseFlowStatus = ref(null);

function openReleaseFlow() {
  releaseFlowOpen.value = true;
  releaseFlowMinimized.value = false;
  // The conversion step shows each template's script; find the built-in
  // ones in the background, as the table transfer dialog does.
  void tableTransfer.discoverAndFill();
  void fetchAllConnectionsDatabases();
}

function minimizeReleaseFlow() {
  if (!releaseFlowOpen.value) return;
  releaseFlowMinimized.value = true;
}

function closeReleaseFlow() {
  releaseFlowOpen.value = false;
  releaseFlowMinimized.value = false;
  releaseFlowStatus.value = null;
}

// 配置关联：索引按（连接, 数据库）维护；侧栏入口的角标跟随当前配置库，
// 检查器里的关联页则按各自标签页的来源读取。
const configRelations = useConfigRelations({});
void configRelations.attach();

function configRelationsAvailable(connectionId) {
  if (!connectionId) return false;
  return connectionOffersConfigRelations(connections.value.find((item) => item.id === connectionId));
}

const configRelationsDialogOpen = ref(false);
// Opened from a table's relation page, the dialog reviews that table's
// database; from the activity rail, the one selected in the sidebar.
const configRelationsDialogRequest = ref(null);
const configRelationsSupported = computed(() => configRelationsAvailable(selectedConnectionId.value));
const configRelationsEntry = computed(() =>
  configRelations.entryFor({ connectionId: selectedConnectionId.value, database: selectedDatabase.value }));
const configRelationsBadge = computed(() =>
  configRelationsSupported.value ? Number(configRelationsEntry.value?.overview?.reviewCount) || 0 : 0);
const configRelationsDialogScope = computed(() =>
  configRelationsDialogRequest.value || { connectionId: selectedConnectionId.value, database: selectedDatabase.value });
const configRelationsDialogSupported = computed(() =>
  configRelationsAvailable(configRelationsDialogScope.value.connectionId));
const configRelationsScopeLabel = computed(() => {
  const { connectionId, database } = configRelationsDialogScope.value;
  const connection = connections.value.find((item) => item.id === connectionId);
  const name = connectionLabel(connectionId, connection?.label || connectionId);
  return `${name} · ${databaseLabel(connectionId, database)}`;
});

watch(
  () => [selectedConnectionId.value, selectedDatabase.value, configRelationsSupported.value],
  ([connectionId, database, supported]) => {
    if (supported && connectionId && database) {
      void configRelations.loadOverview({ connectionId, database });
    }
  },
  { immediate: true },
);

function openConfigRelationsReview(scope = null) {
  const connectionId = String(scope?.connectionId || "");
  const database = String(scope?.database || "");
  configRelationsDialogRequest.value = connectionId && database ? { connectionId, database } : null;
  configRelationsDialogOpen.value = true;
}

let relationJumpToken = 0;
async function openRelationTab({ connectionId, database, tableName, tableComment = "", readOnly = false, relationFilter, relationOrigin, rowIdentity }) {
  const token = ++relationJumpToken;
  const filter = normalizeRelationFilter(relationFilter);
  if (!filter || !tableName) return;
  const tab = await openTable(
    { connectionId, database, tableName, tableComment, readOnly },
    {
      initialState: {
        hitResultMode: true,
        relationFilter: filter,
        relationOrigin: normalizeRelationOrigin(relationOrigin),
      },
    },
  );
  if (!tab || tab.loadError || token !== relationJumpToken) return;
  if (!rowIdentity) {
    await nextTick();
    selectFirstRelationRow(tab, filter, token);
    return;
  }
  await nextTick();
  // Match all composite-key fields, continuing through the first-key filter
  // when the requested record is not in its initially loaded page.
  let rowIndex = findRowIndexByIdentity(tab, rowIdentity);
  let page = 0;
  while (rowIndex < 0 && (page === 0 || tab.hasMore) && token === relationJumpToken && tab.id === focusedPaneState.activeDataTab?.id) {
    const result = await fetchPage(tab, ++page);
    if (!result?.ok) break;
    rowIndex = findRowIndexByIdentity(tab, rowIdentity);
  }
  if (token !== relationJumpToken || tab.id !== focusedPaneState.activeDataTab?.id) return;
  if (rowIndex >= 0) {
    focusedPaneState.selectCellAt?.(tab, rowIndex, 0, { alignColumn: "center" });
  } else {
    setStatus(t("relations.incoming.rowMissing"), { tone: "warning" });
  }
}

// A jump to referenced rows lands on the first of them, so the relation page
// can follow the chain right away. A selection already made in a reused tab
// stays where the user put it while still revealing its column in view.
function selectFirstRelationRow(tab, filter, token) {
  if (token !== relationJumpToken || tab.id !== focusedPaneState.activeDataTab?.id) return;
  const wanted = String(filter?.column || "").toLowerCase();
  const columnIndex = (tab.columns || []).findIndex((column) => columnName(column).toLowerCase() === wanted);
  if (focusedSelectedCell.value?.tabId === tab.id) {
    const selectedColumn = String(focusedSelectedCell.value?.column || "").toLowerCase();
    const selectedColumnIndex = (tab.columns || []).findIndex((column) => columnName(column).toLowerCase() === selectedColumn);
    const targetColumnIndex = selectedColumnIndex >= 0 ? selectedColumnIndex : Math.max(0, columnIndex);
    focusedPaneState.scrollColumnIntoView?.(targetColumnIndex, "td", { align: "center" });
    return;
  }
  focusedPaneState.selectCellAt?.(tab, 0, Math.max(0, columnIndex), { alignColumn: "center" });
}

function openConfigRelationTable({ connectionId, database, tableName, tableComment = "" }) {
  if (!tableName) return;
  const wantedDatabase = String(database || "").toLowerCase();
  const table = workspace.schema.find((item) =>
    normalizeTableName(item) === tableName
    && (!connectionId || item.connectionId === connectionId)
    && (!wantedDatabase || String(item.database || "").toLowerCase() === wantedDatabase));
  void openTable(
    table || { connectionId, database, tableName, tableComment },
    { initialState: null },
  );
}

provide(CONFIG_RELATION_CONTEXT, {
  clearRelationFilter: (tab) => void clearRelationFilter(tab),
  relations: configRelations,
  relationsSupportedForTab,
  openRelation: (request) => void openRelationTab(request),
  locateAuditCell: async ({ rowIdentity, columnName }) => {
    if (!columnName) return;
    await focusedPaneState.locateListMatch?.({ rowIdentity, columnName });
  },
});

// A tab offers the relation page only when its own connection is a real
// MySQL config source.
function relationsSupportedForTab(tab) {
  return configRelationsAvailable(tab?.connectionId);
}

const account = useAccount({
  onSessionChanged: async () => {
    if (account.isLoggedIn.value) {
      startupAccountLoginOpen.value = false;
    }
    // Preserve the user's chosen history view; login must not replace the
    // table they are inspecting with the shared audit feed.
    if (backupCenter.dialog.open && backupCenter.dialog.tab === "audit" && backupCenter.auditMode.mode === "shared") {
      if (!account.isLoggedIn.value && backupCenter.auditMode.mode === "shared") {
        await backupCenter.setAuditMode("local");
      } else {
        await backupCenter.loadAuditLogs();
      }
    }
    if (account.isLoggedIn.value && selectedConnectionId.value && selectedDatabase.value) {
      void refreshTableModifiedTimes().catch(() => {});
    }
  },
  onSynced: () => {
    if (account.isLoggedIn.value && selectedConnectionId.value && selectedDatabase.value) {
      void refreshTableModifiedTimes().catch(() => {});
    }
  },
});

const startupAccountLoginOpen = ref(false);
let startupAccountProbeStarted = false;

async function checkStartupAccountLogin() {
  if (isFolderWindow || startupAccountProbeStarted) return;
  startupAccountProbeStarted = true;
  const probe = await account.probeStartupLogin();
  if (probe.shouldPrompt && !account.isLoggedIn.value && !backupCenter.dialog.open) {
    startupAccountLoginOpen.value = true;
  }
}

function closeStartupAccountLogin() {
  startupAccountLoginOpen.value = false;
}

function handleStartupAccountAuthenticated() {
  startupAccountLoginOpen.value = false;
  const name = account.displayName.value || account.username.value;
  if (name) {
    operationNotices.push({
      tone: "success",
      text: t("account.startup.loggedInNotice", { name }),
    });
  }
}

// 黑猫 MCP：管理外部 AI（Codex、Claude Code 等）的连接与权限分组。
const blackcatMcpOpen = ref(false);

function openBlackcatMcp() {
  blackcatMcpOpen.value = true;
}

// Table folders: named groups of one database's tables, opened together here
// or in a window of their own. A folder window is this same page started
// from a folder; it keeps no saved tabs and leaves the tray, updates and the
// external MCP connection to the main window.
const tableFolders = useTableFolderStore();
const isFolderWindow = isTableFolderWindowRole(currentWindowRole());
const tableFolderPage = useTableFolders({
  invokeWorkbench,
  workspace,
  selectedConnectionId,
  selectedDatabase,
  connections: visibleConnections,
  databases,
  databasesByConnection,
  loadDatabases: fetchAllConnectionsDatabases,
  onScopeChange: (tab) => { void tabSourceSync.syncToTab(tab); },
  databaseLabel,
  connectionLabel,
  openTable: (table) => openTable(table, { paneId: workspace.focusedPaneId }),
  openTables: (request) => openTablesFromSidebar(request),
  notify: (tone, message) => operationNotices.push({ tone, text: message }),
  confirm: (options) => confirmDialogConfirm(options),
});
provide(TABLE_FOLDER_CONTEXT, tableFolderPage.context);

function openTableFolderPage() {
  tableFolderPage.openPage();
}

async function openBackupCenter() {
  // Change logs are a cross-connection history, so open with the broadest
  // view instead of silently narrowing the list to the active workspace.
  backupCenter.setFilters({ connectionId: "", database: "", tableName: "" });
  // Local history is usable immediately; account metadata loads independently.
  backupCenter.open();
  void account.loadAccount();
}

async function openBackupCenterFromRelease(options) {
  const opts = options && typeof options === "object" && !("target" in options) ? options : null;
  if (opts) {
    backupCenter.open(opts);
  } else {
    backupCenter.setFilters({ connectionId: "", database: "", tableName: "" });
    backupCenter.open();
  }
  void account.loadAccount();
}

const homeFavoritesRef = ref(null);

function openDatabaseFavorites(event) {
  homeFavoritesRef.value?.toggle?.(event?.currentTarget);
}

function openSidebarSettings() {
  sidebarRef.value?.toggleSettings?.();
}

const {
  leadItems: activityRailLeadItems,
  items: activityRailItems,
  bottomItems: activityRailBottomItems,
  moreItem: activityRailMoreItem,
  select: selectActivityRailEntry,
  reorder: reorderActivityRailEntry,
} = useActivityRail({
  shortcuts: shortcutHelper,
  expanded: {
    settings: () => Boolean(sidebarRef.value?.settingsOpen),
  },
  badges: {
    more: () => configRelationsBadge.value,
  },
  states: {
    update: () => ({
      label: updater.title.value,
      busy: updater.isBusy.value,
      stateClass: {
        "is-checking": updater.isBusy.value,
        "is-available": updater.status.value === "available",
        "is-error": updater.status.value === "error" || updater.status.value === "unavailable",
      },
    }),
    releaseFlow: () => {
      const visible = releaseFlowOpen.value && releaseFlowMinimized.value;
      if (!visible) return { visible: false };
      const status = releaseFlowStatus.value;
      const tone = status?.tone || "idle";
      return {
        visible: true,
        busy: Boolean(status?.busy),
        statusText: status?.shortText || "",
        hint: status?.detail || t("releaseFlow.minimized.restoreHint"),
        stateClass: {
          [`is-release-${tone}`]: true,
        },
      };
    },
  },
  actions: {
    addConnection: openConnDialog,
    quickOpen: openQuickOpenFromAnywhere,
    databaseFavorites: openDatabaseFavorites,
    tableTransfer: openTableTransfer,
    releaseFlow: openReleaseFlow,
    update: openUpdateDialog,
    settings: openSidebarSettings,
  },
});

function currentRailDatabaseSource() {
  const tab = activeTab.value;
  if (tab?.database) {
    return { connectionId: tab.connectionId || selectedConnectionId.value, database: tab.database };
  }
  return { connectionId: selectedConnectionId.value, database: selectedDatabase.value };
}

const {
  items: railDatabaseItems,
  isOnRail: isRailDatabase,
  pin: pinRailDatabase,
  unpin: unpinRailDatabase,
  reorder: reorderRailDatabases,
  setAppearance: setRailDatabaseAppearance,
  resetAppearance: resetRailDatabaseAppearance,
} = useRailDatabases({
  pinnedDatabases,
  connections: visibleConnections,
  currentSource: currentRailDatabaseSource,
  databaseLabel,
  connectionLabel,
  getDatabaseDecoration,
  notify: (message) => { statusText.value = message; },
});

function toggleRailDatabaseFromContext() {
  const { connectionId, database } = contextMenu;
  closeContextMenu();
  if (isRailDatabase(connectionId, database)) unpinRailDatabase({ connectionId, database });
  else pinRailDatabase({ connectionId, database });
}

// Keep the source stable while the menu is open, including home multi-selection.
const moreSource = ref(null);
const moreActions = computed(() => {
  const source = moreSource.value || batchTransferSource(activeTab.value);
  const hasDatabase = Boolean(source.connectionId && source.database);
  const writable = hasDatabase && !isReadOnlySource(source);
  return [
    { id: "releaseFlow", icon: Rocket, label: t("releaseFlow.title"), hint: t("releaseFlow.hint") },
    { id: "relations", icon: Link2, label: t("shell.configRelations"), hint: t("shell.configRelationsHint"), badge: configRelationsBadge.value },
    { id: "tableFolders", icon: FolderOpen, label: t("tableFolders.title"), hint: t("tableFolders.hint") },
    { id: "backupCenter", icon: ShieldCheck, label: t("m_965320c43727"), hint: t("shell.backupCenterHint") },
    { id: "blackcatMcp", icon: Plug, label: t("blackcatMcp.title"), hint: t("blackcatMcp.hint") },
    { id: "pinWindow", icon: Pin, label: t(windowPin.pinned.value ? "shell.unpinWindow" : "shell.pinWindow"), pressed: windowPin.pinned.value, disabled: windowPin.pending.value },
    { id: "moreSeparator", separator: true },
    { id: "sync", icon: DatabaseZap, label: t("m_623281e9dfdb"), disabled: !writable || !sourceHasCapability("sync", source) },
    { id: "send", icon: Send, label: t("m_8f211e16faf2"), disabled: !writable || !sourceHasCapability("tableCopy", source) },
    { id: "import", icon: Upload, label: t("m_fd7719273970"), disabled: !writable || !sourceHasCapability("import", source) },
    { id: "export", icon: Download, label: t("m_d2fcdde81f06"), disabled: !hasDatabase },
  ];
});

function openMoreActions() {
  closeAllContextMenus();
  moreSource.value = batchTransferSource(activeTab.value);
}

function selectMoreAction(id) {
  const source = moreSource.value;
  if (!source || moreActions.value.find((action) => action.id === id)?.disabled) return;
  if (id === "sync") openDatabaseSync({ ...source, kind: "database" });
  else if (id === "send") tableCopy.open({ ...source, tableNames: source.selectedTableNames });
  else if (id === "import") void openBatchImport(source);
  else if (id === "export") void openBatchExport(source);
  else if (id === "relations") openConfigRelationsReview();
  else if (id === "releaseFlow") openReleaseFlow();
  else if (id === "tableFolders") openTableFolderPage();
  else if (id === "backupCenter") void openBackupCenter();
  else if (id === "blackcatMcp") openBlackcatMcp();
  else if (id === "pinWindow") void toggleWindowPin();
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

// 窗口宽度检测：窄窗口下提示收起侧边栏，并让右侧栏在空间紧张时先让位。
const windowWidth = ref(typeof window !== "undefined" ? window.innerWidth : 1280);
// Native fullscreen hides the traffic lights, so the macOS titlebar drops its
// 76px clearance. Tracked via debounced isFullscreen() reads on window
// resize — no polling.
const macosFullscreen = ref(false);
let macosFullscreenTimer = 0;
function refreshMacosFullscreen() {
  if (!usesNativeMacWindowControls) return;
  clearTimeout(macosFullscreenTimer);
  macosFullscreenTimer = setTimeout(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      macosFullscreen.value = Boolean(await getCurrentWindow().isFullscreen());
    } catch {
      // Window API unavailable — keep the last known state.
    }
  }, 80);
}
function onWindowResize() {
  windowWidth.value = window.innerWidth;
  refreshMacosFullscreen();
}

const {
  workspaceRef: paneWorkspaceRef,
  isDragging: paneIsDragging,
  sidebarWidth,
  inspectorWidth,
  sidebarCollapsed,
  inspectorCollapsed,
  inspectorSurface,
  sidebarPaneAnimating,
  sidebarPanePhase,
  sidebarLayoutVars,
  inspectorStyle,
  onDividerMouseDown,
  onSidebarLayoutTransitionEnd,
  toggleSidebar,
  toggleInspector,
  expandInspector,
} = usePaneResize({ viewportWidth: windowWidth });

const inspectorRelationSummary = ref(null);
const inspectorToggleLabel = computed(() => {
  if (!inspectorCollapsed.value) return t("m_c46872e25609");
  const total = Number(inspectorRelationSummary.value?.total) || 0;
  return total > 0
    ? t("shell.expandInspectorWithRelations", { count: total })
    : t("m_9cee1ce2caac");
});

const wallpaperStrength = ref(0);
// Low-strength wallpaper already leaves enough contrast under resting tabs.
const wallpaperTabOpacity = computed(() => `${Math.min(44, Math.max(0, (wallpaperStrength.value - 0.18) * 58))}%`);
const { effectiveTheme, isDark, toggleTheme, preference: themePreference, setThemePreference, refresh: refreshTheme } = useTheme({
  applyNativeTheme: applyNativeThemeKeepingTrafficLights,
});
watch(effectiveTheme, setWallpaperAppearance, { immediate: true });
const macosVibrancy = useMacosVibrancy({ themeRefresh: refreshTheme });
macosVibrancy.start();
const {
  currentTheme: currentColorTheme,
  themes: colorThemes,
  setColorTheme,
  start: startColorTheme,
} = createColorThemeController({
  systemAccentSupported: usesNativeMacWindowControls,
  accentProvider: usesNativeMacWindowControls
    ? () => invokeWorkbench("macos_accent_color")
    : null,
});
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
  setRail: ({ connectionId, database, rail }) => (
    rail ? pinRailDatabase({ connectionId, database }) : unpinRailDatabase({ connectionId, database })
  ),
});
const updater = useUpdater();
const agent = useExternalMcp(invokeWorkbench);
watch(
  () => inspectorSurfaceFor({ tabKind: activeTab.value?.kind }),
  (surface) => {
    inspectorSurface.value = surface;
  },
  { immediate: true },
);
// 错误态判定：先用显式的结构化标志（statusError），回退到关键词启发式，
// 兼容那些直接给 statusText 赋值而未设置标志的历史调用点。
const isStatusError = computed(
  () => Boolean(statusError.value) || /失败|错误|不能|冲突|重复|超时|拒绝/.test(statusText.value || ""),
);

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

function sourceHasCapability(name, source = {}, fallback = null) {
  const connectionId = sourceConnectionId(source, fallback);
  if (connectionId) return connectionCapability(connectionId, name);
  const kind = source?.kind || fallback?.kind;
  return connectionHasCapability(kind, name);
}

function blockUnsupportedEngine(action) {
  statusText.value = `当前连接不支持${action}`;
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
  operationNotices.suppress(message);
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
  operationNotices.suppress(message);
  const id = nextSaveReminderId++;
  saveReminders.value = [
    ...saveReminders.value.slice(-4),
    { id, kind, message, x, y },
  ];
  globalThis.setTimeout?.(() => {
    saveReminders.value = saveReminders.value.filter((reminder) => reminder.id !== id);
  }, saveReminderDuration(kind));
}

// Revision of the last status write the notice watcher has processed.
let drainedStatusRevision = 0;

// Workbench-level feedback has one home: the notice stack. Status text written
// in the same task becomes the detail line (e.g. an export's path); an older
// message would be unrelated, so it is left out.
function showWorkbenchReminder(kind, message) {
  const freshStatusText = statusRevision.value !== drainedStatusRevision ? statusText.value : "";
  operationNotices.push({
    tone: WORKBENCH_REMINDER_TONES[kind] || "info",
    text: message,
    detail: freshStatusText,
  });
}

// Status messages that deserve attention surface as notices; progress chatter
// and results already shown in place stay in the screen-reader live region.
// Drained after the current task, so feedback already shown beside a cell in
// the same task can suppress its duplicate; every journaled message is seen.
watch(statusRevision, () => {
  for (const entry of drainStatusJournal()) {
    const notice = describeStatusMessage(entry.text, { explicitError: entry.explicitError });
    if (notice) operationNotices.push({ tone: notice.tone, text: entry.text });
  }
  drainedStatusRevision = statusRevision.value;
});

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
  const tableName = String((tab?.createMode ? tab.draft?.tableName : tab?.tableName) || "").trim();
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
  if (!connectionCapability(selectedConnectionId.value, "sqlConsole")) {
    blockUnsupportedEngine("SQL 控制台");
    return null;
  }
  if (sqlDocumentStore.documents.value.length === 0) {
    return openSqlQuery({ paneId });
  }
  return openSqlLibraryTab(workspace, { paneId, activate: true });
}

function openSqlQuery({ paneId = workspace.focusedPaneId, values = {} } = {}) {
  const connectionId = values.connectionId || selectedConnectionId.value;
  if (!connectionCapability(connectionId, "sqlConsole")) {
    blockUnsupportedEngine("SQL 控制台");
    return null;
  }
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

// Last document state written per SQL tab, so a flush only rewrites the
// document library for tabs whose content or metadata actually changed.
const syncedSqlDocumentSignatures = new WeakMap();

function sqlDocumentSignature(tab) {
  return [
    tab.sql,
    tab.savedSql,
    tab.dirty,
    tab.title,
    tab.fileName,
    tab.filePath,
    tab.connectionId,
    tab.database,
    Boolean(tab.readOnly || tab.read_only),
    tab.documentId,
  ];
}

function sameSqlDocumentSignature(left, right) {
  return Boolean(left && right && left.length === right.length && left.every((value, index) => value === right[index]));
}

function syncSqlDocumentsFromTabs() {
  workspace.tabs.filter((tab) => tab.kind === "sql").forEach((tab) => {
    const rawTab = toRaw(tab);
    const signature = sqlDocumentSignature(tab);
    if (
      sameSqlDocumentSignature(syncedSqlDocumentSignatures.get(rawTab), signature)
      && sqlDocumentStore.findDocument(tab.documentId)
    ) return;
    sqlDocumentStore.upsertFromTab(tab);
    syncedSqlDocumentSignatures.set(rawTab, sqlDocumentSignature(tab));
  });
}

async function openSqlDocument({ documentId } = {}, paneId = workspace.focusedPaneId) {
  flushWorkspacePersistence();
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
    if (tab.createMode) {
      if (tab.saving) return false;
      if (tab.dirty && !(await confirmDialogConfirm({
        title: t("createTable.discardTitle"), message: t("createTable.discardMessage"),
        confirmText: t("createTable.discard"), cancelText: t("createTable.keep"), danger: true,
      }))) return false;
    }
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
  if (sourceTab?.createMode) {
    openDatabaseHomeTab(workspace, { connectionId: sourceTab.connectionId, database: sourceTab.database }, { paneId: newPane.id, activate: true });
    return;
  }
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

const titlebarHoverSuppressed = ref(false);
let titlebarSuppressCoords = null;

function suppressTitlebarHover(target = null, pointerEvent = null) {
  const active = target instanceof HTMLElement ? target : document.activeElement;
  if (active instanceof HTMLElement && active.closest?.(".wb-titlebar-controls")) {
    active.blur();
  }
  titlebarHoverSuppressed.value = true;
  titlebarSuppressCoords = pointerEvent && Number.isFinite(pointerEvent.clientX)
    ? { x: pointerEvent.clientX, y: pointerEvent.clientY }
    : null;
}

function onWindowBlurTitlebarReset() {
  suppressTitlebarHover();
}

function onVisibilityTitlebarReset() {
  if (document.hidden) suppressTitlebarHover();
}

function onPointerMoveClearTitlebarSuppress(event) {
  if (!titlebarHoverSuppressed.value) return;
  if (
    titlebarSuppressCoords
    && Math.abs(event.clientX - titlebarSuppressCoords.x) <= 2
    && Math.abs(event.clientY - titlebarSuppressCoords.y) <= 2
  ) {
    return;
  }
  titlebarHoverSuppressed.value = false;
  titlebarSuppressCoords = null;
}

function minimizeWindow(event) {
  suppressTitlebarHover(event?.currentTarget, event);
  withCurrentWindow((window) => window.minimize());
}

function toggleMaximizeWindow() {
  withCurrentWindow(async (window) => {
    if (await window.isMaximized()) await window.unmaximize();
    else await window.maximize();
  });
}

function handleTitlebarDoubleClick() {
  if (!usesNativeMacWindowControls) {
    toggleMaximizeWindow();
    return;
  }
  macosTitlebar.runDoubleClickAction({ minimize: minimizeWindow, zoom: toggleMaximizeWindow });
}

function closeWindow(event) {
  suppressTitlebarHover(event?.currentTarget, event);
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

let agentWorkbenchActionProcessing = false;

function controlContextSnapshot(tab = activeDataTab.value, detailed = false) {
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
    tabId: tab?.id || activeTab.value?.id || "",
    filter: tab?.filter || "",
    filterMode: tab?.filterMode || "",
    relationFilter: tab?.relationFilter || null,
    sort: tab?.sort || null,
    loading: Boolean(tab?.loading),
    loadingMore: Boolean(tab?.loadingMore || tab?.loadingPrevious),
    searchComplete: tab?.searchResultMode ? tab.searchResultComplete === true : null,
    hasMore: Boolean(tab?.hasMore),
    totalRows: tab?.totalRows ?? null,
    totalRowsExact: tab?.totalRowsExact === true,
    rowWindowOffset: tab?.rowWindowOffset || 0,
    ...(detailed ? {
      capturedAt: new Date().toISOString(),
      selectedCell: focusedPaneState.selectedCell ? {
        tabId: focusedPaneState.selectedCell.tabId,
        rowKey: focusedPaneState.selectedCell.rowKey,
        columnName: focusedPaneState.selectedCell.column,
        rowIndex: focusedPaneState.selectedCell.rowIndex,
        columnIndex: focusedPaneState.selectedCell.columnIndex,
      } : null,
      selectedRange: focusedPaneState.selectedRange ? {
        tabId: focusedPaneState.selectedRange.tabId,
        anchor: focusedPaneState.selectedRange.anchor,
        focus: focusedPaneState.selectedRange.focus,
        toggledCellCount: focusedPaneState.selectedRange.toggledCells?.length || 0,
      } : null,
      viewport: tab?.id === focusedPaneState.activeDataTab?.id ? focusedPaneState.controlViewport?.() || null : null,
      tabs: workspace.tabs.map((item) => ({
        id: item.id, kind: item.kind || "data", connectionId: item.connectionId,
        database: item.database, tableName: item.tableName, filter: item.filter || "",
        filterMode: item.filterMode, sort: item.sort || null, relationFilter: item.relationFilter || null,
      })),
    } : {}),
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
    if (action.action !== "get_view_state" && focusedPaneState.isEditing?.()) {
      throw new Error("请先完成当前单元格编辑，再让 AI 操作界面");
    }
    if (action.demoStep) statusText.value = `MCP ${action.demoStep} · ${action.tableName || action.database || action.action}`;
    if (action.action === "get_view_state") {
      message = "已读取当前界面状态";
    } else if (action.action === "scroll_table") {
      await openAgentTableAction(action);
      await nextTick();
      if (!focusedPaneState.scrollAgentGrid) throw new Error("当前表格尚未就绪");
      await focusedPaneState.scrollAgentGrid(action);
      message = `已滚动表格：${action.tableName} · ${action.direction}`;
    } else if (action.action === "open_table") {
      await openAgentTableAction(action);
      message = `已打开表：${action.tableName}`;
    } else if (action.action === "focus_column" || action.action === "focus_row" || action.action === "focus_cell") {
      await focusAgentReferenceAction(action);
      message = statusText.value;
    } else if (action.action === "refresh_table") {
      await refreshAgentTableAction(action);
      message = `已刷新表：${action.tableName}`;
    } else if (action.action === "select_database") {
      const targetConnectionId = action.connectionId || selectedConnectionId.value;
      // Real database lists live in useConnection: `databases` holds the
      // selected connection's list, `databasesByConnection` caches other
      // connections' lists (both are arrays of plain strings).
      const cached = targetConnectionId === selectedConnectionId.value
        ? databases.value
        : databasesByConnection[targetConnectionId];
      const list = Array.isArray(cached) && cached.length
        ? cached
        : await fetchDatabasesForConnection(targetConnectionId);
      const exists = (Array.isArray(list) ? list : []).some(
        (name) => String(name) === String(action.database),
      );
      if (!exists) throw new Error(`连接中不存在数据库：${action.database}`);
      await selectDatabaseWithHome({ connectionId: targetConnectionId, database: action.database });
      message = `已切换数据库：${action.database}`;
    } else if (action.action === "open_sql") {
      const tab = openSqlQuery({
        values: {
          connectionId: action.connectionId || selectedConnectionId.value,
          database: action.database || selectedDatabase.value,
          sql: action.sql,
        },
      });
      if (!tab) throw new Error("打开 SQL 查询失败");
      if (action.run) {
        const outcome = await requestSqlRun(tab, {});
        if (outcome.status !== "ok") throw new Error(outcome.error || "SQL 执行失败");
        message = `已打开 SQL 查询并执行：${outcome.rowCount} 行`;
      } else {
        message = "已打开 SQL 查询";
      }
    } else if (action.action === "select_range") {
      await selectAgentRangeAction(action);
      message = `已选中区域：${action.tableName}`;
    }
    await nextTick();
    if (action.demoStep) statusText.value = `MCP ${action.demoStep} · ${message}`;
    try {
      await agent.completeControlWorkbenchAction(action, {
        ok: true,
        message,
        context: controlContextSnapshot(activeDataTab.value, true),
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
        context: controlContextSnapshot(activeDataTab.value, true),
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

async function selectAgentRangeAction(action) {
  const tab = await openAgentTableAction(action);
  await nextTick();
  const columnIndexOf = (name) => {
    const index = tab.columns.findIndex((column) => columnName(column) === name);
    if (index < 0) throw new Error(`未找到列：${name}`);
    return index;
  };
  const startColumnIndex = columnIndexOf(action.startColumn);
  const endColumnIndex = action.endColumn ? columnIndexOf(action.endColumn) : startColumnIndex;
  const startRowIndex = resolveAgentActionRowIndex(tab, {
    rowKey: action.startRowKey,
    rowIdentity: action.startRowIdentity,
  });
  if (startRowIndex < 0) throw new Error(`未找到起始行：${action.tableName}`);
  const endRowIndex = (action.endRowKey || action.endRowIdentity)
    ? resolveAgentActionRowIndex(tab, { rowKey: action.endRowKey, rowIdentity: action.endRowIdentity })
    : startRowIndex;
  if (endRowIndex < 0) throw new Error(`未找到结束行：${action.tableName}`);
  const startRow = tabRowAt(tab, startRowIndex);
  const endRow = tabRowAt(tab, endRowIndex);
  if (!startRow || !endRow) throw new Error(`未找到行：${action.tableName}`);
  const startColumn = columnName(tab.columns[startColumnIndex]);
  const endColumn = columnName(tab.columns[endColumnIndex]);
  // The visible grid binds to each pane's own useGridEditor instance; prefer the
  // focused pane's selectRangeAt so the highlight actually renders. The
  // orchestrator-level functions remain a fallback (they still feed the
  // inspector's selection state).
  if (typeof focusedPaneState.selectRangeAt === "function") {
    focusedPaneState.selectRangeAt(tab, {
      startRow,
      startColumn,
      startRowIndex,
      startColumnIndex,
      endRow,
      endColumn,
      endRowIndex,
      endColumnIndex,
    });
    return;
  }
  startRangeSelection(tab, startRow, startColumn, startRowIndex, startColumnIndex);
  if (endRowIndex !== startRowIndex || endColumnIndex !== startColumnIndex) {
    extendRangeSelection(tab, endRow, endColumn, endRowIndex, endColumnIndex);
  }
  finishRangeSelection();
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
  // filter/filterMode/sort are applied post-open through
  // applyAgentTableViewState (a single path for fresh and already-open tabs).
  // Passing them via openTable's initialState only sets display fields — the
  // backend never sees the filter because usesBackendFilter stays false.
  const viewState = {};
  if (typeof action.filter === "string") viewState.filter = action.filter;
  if (typeof action.filterMode === "string") viewState.filterMode = action.filterMode;
  if (action.sort && typeof action.sort === "object") viewState.sort = { ...action.sort };
  const current = focusedPaneState.activeDataTab;
  const matchesTarget = (candidate) => candidate?.tableName === name
    && candidate.connectionId === connectionId && candidate.database === database;
  const existing = action.action !== "open_table"
    ? (matchesTarget(current) ? current : workspace.tabs.find((candidate) => matchesTarget(candidate) && !candidate.hitResultMode))
    : null;
  let reusedTab = null;
  if (existing?.sessionId && !existing.loadError && !existing.loading) {
    if (existing.id !== current?.id) await activateTab(existing.id);
    await nextTick();
    if (focusedPaneState.activeDataTab?.id !== existing.id) throw new Error("切换表格已取消，未执行后续定位");
    reusedTab = existing;
  }
  const openedTab = reusedTab || await openTable({
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
  if (Object.keys(viewState).length) {
    await applyAgentTableViewState(tab, viewState, {
      loadSearchResultPage,
      loadNextSearchResultPage,
      applySort,
      fetchPage,
    });
  }
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
  let tab = await openAgentTableAction(action);
  if (action.columnName && !tab.columns.some((column) => columnName(column) === action.columnName)) {
    throw new Error(`未找到列：${action.columnName}`);
  }
  if (action.rowIdentity) primaryKeyFilter(tab, action.rowIdentity);
  if (action.action !== "focus_column" && resolveAgentActionRowIndex(tab, action) < 0) {
    const relationFilter = primaryKeyFilter(tab, action.rowIdentity);
    tab = await openTable({
      connectionId: tab.connectionId, database: tab.database, tableName: tab.tableName,
      tableComment: tab.tableComment, readOnly: tab.readOnly,
    }, { paneId: workspace.focusedPaneId, initialState: { hitResultMode: true, relationFilter } });
    if (!tab || tab.loadError) throw new Error(String(tab?.loadError || "主键定位失败"));
  }
  await nextTick();
  const targetTab = tab || activeDataTab.value;
  if (!targetTab) throw new Error(`打开表失败：${action.tableName}`);
  const columnIndex = action.columnName
    ? targetTab.columns.findIndex((column) => columnName(column) === action.columnName)
    : 0;
  if (action.columnName && columnIndex < 0) throw new Error(`未找到列：${action.columnName}`);
  const rowIndex = resolveAgentActionRowIndex(targetTab, action);
  if (action.action === "focus_column") {
    if (columnIndex >= 0) {
      if (targetTab.id === focusedPaneState.activeDataTab?.id) {
        focusedPaneState.scrollColumnIntoView?.(columnIndex, "td", { align: "center" });
      } else {
        scrollCellIntoView(Math.max(0, rowIndex), columnIndex, { alignColumn: "center" });
      }
      statusText.value = `已定位列：${action.tableName}.${action.columnName}`;
    } else {
      statusText.value = `未找到列：${action.columnName}`;
      throw new Error(statusText.value);
    }
    return;
  }
  if (rowIndex < 0) {
    statusText.value = `未找到行：${action.tableName}；主键记录可能已删除，原标签筛选保持不变`;
    throw new Error(statusText.value);
  }
  const targetColumnIndex = columnIndex >= 0 ? columnIndex : 0;
  if (targetTab.id === focusedPaneState.activeDataTab?.id && typeof focusedPaneState.selectCellAt === "function") {
    focusedPaneState.selectCellAt(targetTab, rowIndex, targetColumnIndex, { alignColumn: "center" });
  } else {
    selectCellAt(targetTab, rowIndex, targetColumnIndex, { alignColumn: "center" });
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
  const result = await fetchPage(tab, page, {
    refreshSchema: options.refreshSchema === true,
    // Rows changed in place: fetch the loaded rows again where they are.
    inPlace: options.inPlace === true,
    anchor: options.anchor ?? null,
    removedRows: options.removedRows ?? null,
  });
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

// Opens a database's home from outside the sidebar (rail tile, favorites,
// Quick Open, a sidebar database click). The same server switches database
// directly; another server switches connection first, which loads its
// database list and lands on the requested database. Resolves true when the
// home is open, false when the switch failed, and null when a newer switch
// replaced this one before it finished.
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

  let outcome = SOURCE_SELECTION.selected;
  if (targetConnectionId !== String(selectedConnectionId.value)) {
    outcome = await selectConnection(targetConnectionId, { preferredDatabase: targetDatabase });
  }
  // Only a database of the server that is selected now can be chosen directly:
  // the loaded database list belongs to that server.
  if (
    outcome === SOURCE_SELECTION.selected &&
    targetConnectionId === String(selectedConnectionId.value) &&
    targetDatabase !== String(selectedDatabase.value)
  ) {
    outcome = await selectDatabase({ connectionId: targetConnectionId, database: targetDatabase });
  }
  // A newer switch took over while this one waited (quick clicks across
  // servers, a tab activated meanwhile): the source and the tabs are its to
  // settle, and finishing this one would leave the sidebar on a server whose
  // database list was never loaded.
  if (outcome === SOURCE_SELECTION.superseded) return null;
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
  // Opening the database that is already selected changes no source, so the
  // sidebar would not bring its row back into view by itself.
  if (!sourceChanging) sidebarRef.value?.revealSelectedDatabase?.();
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
    return connection?.connected === true && (kind === "mysql" || kind === "clickhouse" || kind === "mongodb");
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
  if (isReservedTabShortcutCombo(shortcut)) {
    return "已用于切换打开的标签";
  }
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
  // null: a newer switch replaced this one, which is not a failure to report.
  if (opened === null) return { ok: false };
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
  if (columnIndex >= 0) focusedPaneState.scrollColumnIntoView?.(columnIndex, "th", { align: "center" });
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
  // The tab already holds its rows: show it first, then bring the sidebar's
  // connection/database in line in the background instead of making the
  // switch wait for the table-list reload.
  if (paneId) focusWorkspacePane(workspace, paneId);
  activateTableTab(workspace, tabId);
  const tab = workspace.tabs.find((t) => t.id === tabId);
  if (tab) void tabSourceSync.syncToTab(tab);
}

const tabSourceSync = createTabSourceSync({
  getSelected: () => ({ connectionId: selectedConnectionId.value, database: selectedDatabase.value }),
  selectConnection,
  selectDatabase,
});

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

const tabContextMenuRef = ref(null);
const tabContextTab = computed(() => {
  const pane = workspace.panes?.[tabContextMenu.paneId || workspace.focusedPaneId];
  const tabId = tabContextMenu.tabId || pane?.activeTabId || "";
  return workspace.tabs.find((tab) => tab.id === tabId) || null;
});
const tabContextMenuShortcuts = computed(() => ({
  refresh: formatShortcutForPlatform(shortcutHelper.get("refresh")),
  design: formatShortcutForPlatform(shortcutHelper.get("openDesign")),
  close: formatShortcutForPlatform(shortcutHelper.get("closeTab")),
}));

const tabContextIsDataTable = computed(() => {
  const tab = tabContextTab.value;
  return Boolean(tab && (tab.kind || "data") === "data" && tab.tableName);
});

const tabContextCanRename = computed(() => {
  const tab = tabContextTab.value;
  if (!tabContextIsDataTable.value || !tab) return false;
  return !tab.readOnly && !tab.read_only && connectionCapability(tab.connectionId, "renameDrop");
});

function openDesignFromTabMenu() {
  const paneId = tabContextMenu.paneId || workspace.focusedPaneId;
  const tab = tabContextTab.value;
  closeTabContextMenu();
  if (!tab || !tab.tableName) return;
  openTableDesign(tab, paneId);
}

function renameTableFromTabMenu() {
  const tab = tabContextTab.value;
  closeTabContextMenu();
  if (!tab || !tab.tableName) return;
  openTableRenameFromSource({
    connectionId: tab.connectionId,
    database: tab.database,
    tableName: tab.tableName,
  });
}

function handleTabContextMenuKeydown(event) {
  handleMenuKeydown(event, tabContextMenuRef.value, { close: closeTabContextMenu });
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

async function refreshDataTab(tab) {
  if (!tab || (tab.kind || "data") !== "data") return;
  const result = await refreshTabPage(tab, 1, { refreshSchema: true });
  if (result?.ok) await resumeSearchAfterTableRefresh(tab);
}

async function refreshTabsFromMenu() {
  const paneId = tabContextMenu.paneId || workspace.focusedPaneId;
  const pane = workspace.panes?.[paneId];
  const tab = workspace.tabs.find((item) => item.id === (tabContextMenu.tabId || pane?.activeTabId));
  closeTabContextMenu();
  if (!tab) return;
  if (tab.kind === "home" && tab.id === focusedPaneState.activeHomeTab?.id) {
    focusedPaneState.refreshHomeView?.();
    return;
  }
  await refreshDataTab(tab);
}

async function closeTabFromMenu() {
  const paneId = tabContextMenu.paneId || workspace.focusedPaneId;
  const tab = tabContextTab.value;
  closeTabContextMenu();
  if (!tab || tab.kind === "home" || tab.opening) return;
  await closeTab(paneId, tab.id);
}

async function closeOtherTabsFromMenu() {
  const paneId = tabContextMenu.paneId || workspace.focusedPaneId;
  const pane = workspace.panes?.[paneId];
  const tabId = tabContextTab.value?.id || "";
  const directions = ["left", "right"];
  const tabsToClose = directions.flatMap((direction) => (
    closableRelativeTabsInPane(workspace.tabs, pane?.tabIds, tabId, direction)
  ));
  closeTabContextMenu();
  if (!tabId || !tabsToClose.length || !(await guardTabDepartures(tabsToClose))) return;
  resetGridState();
  const closedTabs = directions.flatMap((direction) => closePaneTabsRelative(workspace, paneId, tabId, direction));
  closedTabs.forEach(clearTabCellErrors);
  pruneEmptyPanesInLayout(workspace);
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
  if (!sourceHasCapability("sync", target)) {
    blockUnsupportedEngine("覆盖同步");
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
  if (contextMenu.tableNames.length > 1) {
    const selection = contextMenuTableSource();
    closeContextMenu();
    closeTabContextMenu();
    sendHomeTables(selection);
    return;
  }
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
  if (!sourceHasCapability("tableCopy", source)) {
    blockUnsupportedEngine("发送表");
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
  if (!sourceHasCapability("import", resolved)) {
    blockUnsupportedEngine("导入");
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
  if (!sourceHasCapability("renameDrop", source)) {
    blockUnsupportedEngine("重命名表");
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
    tableFolders.renameTable(tableRename.connectionId, tableRename.database, tableRename.tableName, tableRename.newName);
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
  if (!connectionCapability(source.connectionId, "tableCopy")) {
    blockUnsupportedEngine("发送表");
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

// A multi-table open marks every table but the one the user acted on with
// `activate: false`, so they load in the background without taking focus.
async function openTableFromHome(table, paneId = workspace.focusedPaneId) {
  focusedPaneState.captureActiveTableViewState?.();
  await openTable(table, { paneId, activate: table?.activate !== false });
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
  if (!connectionCapability(targetConnectionId, "tableCopy")) {
    blockUnsupportedEngine("粘贴表");
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
  if (!connectionCapability(source.connectionId, "renameDrop")) {
    blockUnsupportedEngine("重命名表");
    source.onError?.(new Error("当前连接不支持重命名表"));
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
  tableFolders.renameTable(source.connectionId, source.database, source.tableName, source.newName);

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
  if (busy.value) return;
  const tableNames = [...new Set(Array.isArray(source.tableNames) ? source.tableNames.filter(Boolean) : [])];
  if (!tableNames.length) return;
  if (isReadOnlyConnection(source.connectionId)) {
    blockReadOnlyAction("删除表");
    return;
  }
  if (!connectionCapability(source.connectionId, "renameDrop")) {
    blockUnsupportedEngine("删除表");
    return;
  }
  busy.value = true;
  try {
    const count = tableNames.length;
    const confirmed = await confirmDialogConfirm({
      title: count === 1 ? t('m_d545721cef25') : t("home.deleteTables", { count }),
      message: t("home.deleteMessage", { database: source.database }),
      items: tableNames,
      note: t("home.deleteNote"),
      confirmText: count === 1 ? t('m_d545721cef25') : t("home.deleteSelectedTables"),
      cancelText: t('m_2cd0f3be8738'),
      danger: true,
    });
    if (!confirmed) return;
    statusText.value = `正在删除 ${tableNames.length} 张表，请稍候…`;
    const result = { dropped: [], failed: [] };
    for (let offset = 0; offset < tableNames.length; offset += 32) {
      const batch = tableNames.slice(offset, offset + 32);
      statusText.value = `正在删除表 ${offset}/${tableNames.length}，已确认删除 ${result.dropped.length} 张`;
      try {
        const response = await invokeWorkbench("drop_tables", {
          request: { connectionId: source.connectionId, database: source.database, tables: batch },
        });
        result.dropped.push(...(response?.dropped || []));
        result.failed.push(...(response?.failed || []));
      } catch (error) {
        // A lost response may follow applied DDL. Never retry it automatically.
        result.failed.push(...batch.map((tableName) => ({
          tableName, reason: `结果未确认：${String(error?.message || error)}，请刷新后检查`,
        })));
        result.failed.push(...tableNames.slice(offset + batch.length).map((tableName) => ({
          tableName, reason: "前一批中断，尚未执行",
        })));
        break;
      }
    }
    const droppedSet = new Set((result?.dropped || []).map((item) => item.tableName));
    const droppedNames = tableNames.filter((name) => droppedSet.has(name));
    const failureReasons = new Map((result?.failed || []).map((item) => [item.tableName, item.reason]));
    const failed = tableNames.filter((name) => !droppedSet.has(name)).map((name) => ({
      name,
      reason: failureReasons.get(name) || "删除结果未确认，请刷新后检查",
    }));
    const closedTabs = closeTableObjectTabs(workspace, {
      connectionId: source.connectionId,
      database: source.database,
      tableNames: droppedNames,
    });
    closedTabs.forEach(clearTabCellErrors);
    recentHomeTableNames.value = recentHomeTableNames.value.filter((name) => !droppedSet.has(name));
    const failureSummary = failed.slice(0, 3).map((item) => `${item.name}（${item.reason}）`).join("；");
    const summary = `已删除 ${droppedNames.length} 张表`
      + (failed.length ? `，${failed.length} 张未删除或未确认：${failureSummary}` : "")
      + (failed.length > 3 ? "；其余失败表保留选中" : "");
    let refreshError = "";
    try {
      await loadTables({ connectionId: source.connectionId, database: source.database });
    } catch (error) {
      refreshError = `；列表刷新失败：${String(error?.message || error)}，请重试刷新`;
    }
    // Deleting from the sidebar keeps the current tab; the home page only
    // takes over when the deletion started there.
    const home = openCurrentDatabaseHome({ activate: source.origin !== "sidebar" });
    if (home) home.selectedTableNames = failed.map((item) => item.name);
    statusText.value = summary + refreshError;
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

function openCreateTable(source, paneId = workspace.focusedPaneId) {
  if (!source?.connectionId || !source?.database || isReadOnlySource(source) || !sourceHasCapability("tableDesign", source)) return null;
  return openCreateTableTab(workspace, source, { paneId });
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
    if (!sourceHasCapability("tableDesign", targets[0])) {
      blockUnsupportedEngine("表设计");
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
  if (!sourceHasCapability("tableDesign", source, fallback)) {
    blockUnsupportedEngine("表设计");
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

async function handleTableDesignApplied(event = {}, options = {}) {
  const source = designAppliedSource(event);
  const { connectionId, database, tableName } = source;
  const savedStatus = options.statusLabel || (tableName ? `表设计已保存：${tableName}` : "表设计已保存");
  if (!tableName) {
    statusText.value = savedStatus;
    return false;
  }
  // Comment edits use this same path. Rebuild the relation index even if the
  // data-tab reload fails, without holding the saved comment open for analysis.
  if (configRelationsAvailable(connectionId)) {
    void configRelations.refresh(source).catch((error) => {
      setStatus(t("relations.error", { message: String(error?.message || error) }), { tone: "warning" });
    });
  }
  if (event.created) return true;
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
      return false;
    }
    statusText.value = savedStatus;
    return true;
  } catch (error) {
    statusText.value = `表设计已保存，刷新失败，请重新打开或刷新表：${String(error)}`;
    return false;
  }
}

const contextMenuRef = ref(null);
let contextMenuReturnFocus = null;
const contextMenuCanDeleteTables = computed(() => {
  const connectionId = String(contextMenu.connectionId || selectedConnectionId.value || "");
  return contextMenu.kind === "table"
    && !isReadOnlyConnection(connectionId)
    && connectionCapability(connectionId, "renameDrop");
});

function openSidebarContextMenu(event, table) {
  closeTabContextMenu();
  openContextMenu(event, table, { surface: "sidebar", tableNames: table?.selectedTableNames });
  configureHitResultContextMenu(focusedPaneState.activeDataTab);
  // Opened with Shift+F10 or the Menu key: move focus into the menu; it
  // returns to the row when the menu closes (see the watcher below).
  contextMenuReturnFocus = event?.keyboard ? document.activeElement : null;
  if (event?.keyboard) nextTick(() => contextMenuRef.value?.focusFirstItem?.());
}

// Runs before the menu leaves the DOM, while its focused item still exists, so
// Escape, an action or a dialog's focus return all land back on the row.
watch(() => contextMenu.open, (open) => {
  if (open) return;
  const returnFocus = contextMenuReturnFocus;
  contextMenuReturnFocus = null;
  if (returnFocus?.isConnected && document.activeElement?.closest?.(".wb-context-menu")) {
    returnFocus.focus({ preventScroll: true });
  }
});

function contextMenuTableSource() {
  return {
    connectionId: String(contextMenu.connectionId || selectedConnectionId.value || ""),
    database: String(contextMenu.database || selectedDatabase.value || ""),
    tableNames: contextMenu.tableNames.length ? [...contextMenu.tableNames] : [contextMenu.tableName].filter(Boolean),
  };
}

// Opens several sidebar tables: the one the user acted on becomes the active
// tab, the others load in the background in list order.
async function openTablesFromSidebar({ tables = [], activeName = "", skipConfirm = false } = {}) {
  if (!tables.length) return;
  if (!skipConfirm && !(await confirmOpeningTables(tables.length, { confirm: confirmDialogConfirm, t }))) return;
  focusedPaneState.captureActiveTableViewState?.();
  const paneId = workspace.focusedPaneId;
  await Promise.all(tables.map(async (table) => {
    const tableName = normalizeTableName(table);
    await openTable(table, { paneId, activate: tableName === activeName });
    rememberOpenedHomeTable(tableName);
  }));
}

function openTablesFromContextMenu() {
  const source = contextMenuTableSource();
  const activeName = contextMenu.tableName;
  closeContextMenu();
  const tables = source.tableNames.map((tableName) => ({
    ...(workspace.schema.find((entry) => normalizeTableName(entry) === tableName) || {}),
    connectionId: source.connectionId,
    database: source.database,
    tableName,
  }));
  void openTablesFromSidebar({ tables, activeName });
}

function deleteTablesFromContextMenu() {
  const source = contextMenuTableSource();
  closeContextMenu();
  void deleteHomeTables({ ...source, origin: "sidebar" });
}

async function removeConnectionFromContext() {
  const connectionId = contextMenu.connectionId;
  closeContextMenu();
  await confirmRemoveConnection({ connectionId });
}

async function confirmRemoveConnection({ connectionId = "" } = {}) {
  if (!connectionId) return;
  const connection = connections.value.find((item) => item.id === connectionId);
  const label = connectionLabel(connectionId, connection?.label || connectionId);
  const confirmed = await confirmDialogConfirm({
    title: t("sidebar.removeConnectionTitle"),
    message: t("sidebar.removeConnectionMessage", { name: label }),
    confirmText: t("sidebar.removeConnectionConfirm"),
    cancelText: t('m_2cd0f3be8738'),
    danger: true,
  });
  if (!confirmed) return;
  closeConnectionTabs(workspace, { connectionId });
  await removeConnection(connectionId);
  // 清理该连接的常驻库条目，避免幽灵条目残留在 Quick Open 浮层里。
  pinnedDatabases.value = removePinnedDatabasesForConnection(connectionId, pinnedDatabases.value);
}

function dismissInputContextMenu(event) {
  if (!contextMenu.open || contextMenu.surface !== "input") return;
  if (event.type === "keydown") {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
  } else if (event.target?.closest?.(".wb-input-context-menu")) return;
  closeContextMenu();
}

function openInputContextMenu(event) {
  if (usesNativeTextMenu(event.target)) {
    closeAllContextMenus();
    event.stopPropagation();
    return;
  }
  // The detail editor already supplies its own draft-aware clipboard actions.
  if (event.target?.closest?.(".wb-detail-input")) return;
  const clipboardActions = textInputClipboard(event.target, {
    copyText: copyTextToClipboard,
    readText: () => isTauriRuntime()
      ? invokeWorkbench("read_clipboard_text")
      : navigator.clipboard.readText(),
  });
  if (!clipboardActions) return;
  event.preventDefault();
  event.stopPropagation();
  closeTabContextMenu();
  openContextMenu(event, null, { surface: "input", menuHeight: 80, clipboardActions });
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
    menuHeight: 332,
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
  contextMenu.rowTab = targetTab || null;
  contextMenu.rowReadOnly = Boolean(targetTab?.readOnly || targetTab?.read_only);
  if (rowIndex >= 0) {
    contextMenu.anchorIndex = rowIndex;
    contextMenu.row = tabRowAt(targetTab, rowIndex) || null;
  }
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
  const tab = focusedInspectorTab.value;
  const commentTarget = tab?.tableName
    ? resolveInspectorCommentTarget(event, {
        columns: focusedActiveColumns.value,
        selectedColumn: focusedSelectedCell.value?.tabId === tab?.id ? focusedSelectedCell.value?.column : "",
        tableComment: tab.tableComment || "",
      })
    : null;
  openContextMenu(event, focusedInspectorTab.value, {
    surface: "inspector",
    menuHeight: 280,
    commentTarget,
    clipboardActions: hasSelectedText
      ? {
          canCopy: true,
          canPaste: false,
          copy: () => copyTextToClipboard(text),
        }
      : null,
  });
}

const commentEdit = reactive({
  open: false,
  saving: false,
  error: "",
  kind: "column",
  columnName: "",
  connectionId: "",
  database: "",
  tableName: "",
  value: "",
  sampleValue: "",
  readOnly: false,
});
const commentEditRemoteTables = ref([]);
let commentEditTablesToken = 0;

const commentEditTables = computed(() => {
  if (!commentEdit.open || commentEdit.kind !== "column") return [];
  const sameScope = String(commentEdit.connectionId || "") === String(selectedConnectionId.value || "")
    && String(commentEdit.database || "").toLowerCase() === String(selectedDatabase.value || "").toLowerCase();
  if (sameScope && workspace.schema.length) return workspace.schema;
  return commentEditRemoteTables.value;
});

async function preloadCommentEditTables(connectionId, database) {
  const token = ++commentEditTablesToken;
  commentEditRemoteTables.value = [];
  const sameScope = String(connectionId || "") === String(selectedConnectionId.value || "")
    && String(database || "").toLowerCase() === String(selectedDatabase.value || "").toLowerCase();
  if ((sameScope && workspace.schema.length) || !connectionId || !database) return;
  try {
    const tables = await invokeWorkbench("list_tables", { connectionId, database });
    if (token !== commentEditTablesToken || !Array.isArray(tables)) return;
    commentEditRemoteTables.value = tables;
  } catch {
    if (token === commentEditTablesToken) commentEditRemoteTables.value = [];
  }
}

async function loadCommentEditTableColumns(tableName) {
  if (!commentEdit.open || !tableName) return [];
  try {
    const schema = await ensureTableSchema(tableName, {
      connectionId: commentEdit.connectionId,
      database: commentEdit.database,
    });
    return Array.isArray(schema?.columns) ? schema.columns : [];
  } catch {
    return [];
  }
}

const canEditInspectorComment = computed(() => {
  if (contextMenu.surface !== "inspector" || !contextMenu.commentTarget || !contextMenu.tableName) return false;
  const source = {
    connectionId: contextMenu.connectionId,
    database: contextMenu.database,
    tableName: contextMenu.tableName,
    readOnly: focusedInspectorTab.value?.readOnly || focusedInspectorTab.value?.read_only,
  };
  return !isReadOnlySource(source) && sourceHasCapability("tableDesign", source);
});

function openCommentEdit(source, target) {
  if (!target || !source?.tableName) return;
  if (isReadOnlySource(source)) {
    blockReadOnlyAction("修改备注");
    return;
  }
  if (!sourceHasCapability("tableDesign", source)) {
    blockUnsupportedEngine("修改备注");
    return;
  }
  commentEdit.open = true;
  commentEdit.saving = false;
  commentEdit.error = "";
  commentEdit.kind = target.kind;
  commentEdit.columnName = target.columnName || "";
  commentEdit.connectionId = source.connectionId;
  commentEdit.database = source.database;
  commentEdit.tableName = source.tableName;
  commentEdit.value = target.comment || "";
  commentEdit.sampleValue = target.sampleValue || "";
  commentEdit.readOnly = false;
  if (target.kind === "column") {
    void preloadCommentEditTables(source.connectionId, source.database);
  }
}

function openColumnMeaningEdit(payload = {}) {
  if (!payload?.tableName || !payload?.columnName) return;
  const source = {
    connectionId: payload.connectionId,
    database: payload.database,
    tableName: payload.tableName,
    readOnly: Boolean(payload.readOnly),
  };
  const canWrite = !isReadOnlySource(source) && sourceHasCapability("tableDesign", source);
  commentEdit.open = true;
  commentEdit.saving = false;
  commentEdit.error = "";
  commentEdit.kind = "column";
  commentEdit.columnName = payload.columnName;
  commentEdit.connectionId = source.connectionId;
  commentEdit.database = source.database;
  commentEdit.tableName = source.tableName;
  commentEdit.value = payload.comment || "";
  commentEdit.sampleValue = payload.sampleValue ?? "";
  commentEdit.readOnly = !canWrite;
  void preloadCommentEditTables(source.connectionId, source.database);
}

function openCommentEditFromMenu() {
  const target = contextMenu.commentTarget;
  const source = {
    connectionId: contextMenu.connectionId,
    database: contextMenu.database,
    tableName: contextMenu.tableName,
    readOnly: focusedInspectorTab.value?.readOnly || focusedInspectorTab.value?.read_only,
  };
  closeContextMenu();
  openCommentEdit(source, target);
}

function openHomeTableCommentEdit(source = {}) {
  openCommentEdit(source, {
    kind: "table",
    comment: source.tableComment || source.table_comment || "",
  });
}

function closeCommentEdit() {
  if (commentEdit.saving) return;
  commentEdit.open = false;
  commentEdit.error = "";
}

async function saveCommentEdit(nextValue) {
  if (!commentEdit.open || commentEdit.saving || commentEdit.readOnly) return;
  const source = {
    connectionId: commentEdit.connectionId,
    database: commentEdit.database,
    tableName: commentEdit.tableName,
  };
  const target = { kind: commentEdit.kind, columnName: commentEdit.columnName };
  commentEdit.saving = true;
  commentEdit.error = "";
  try {
    const outcome = await applySchemaComment(invokeWorkbench, source, target, nextValue);
    if (outcome.status === "unchanged") {
      commentEdit.open = false;
      statusText.value = t("m_65f40f66a348");
      return;
    }
    if (outcome.status === "missing-column") {
      commentEdit.error = t("m_c89b88df082b", { name: outcome.columnName || commentEdit.columnName });
      return;
    }
    if (outcome.status === "invalid" || outcome.status === "conflict") {
      commentEdit.error = outcome.message || t("m_d5079872e308");
      return;
    }
    const statusLabel = commentEdit.kind === "table"
      ? t("m_d5c2d177c93e", { name: commentEdit.tableName })
      : t("m_ec5bb7c806fe", { name: commentEdit.columnName });
    await handleTableDesignApplied({
      source,
      schema: outcome.schema,
      result: outcome.result,
    }, { statusLabel });
    commentEdit.open = false;
  } catch (error) {
    commentEdit.error = String(error?.message || error);
  } finally {
    commentEdit.saving = false;
  }
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

function onClearSelectedCells() {
  const clear = typeof focusedPaneState.clearSelectedCells === "function"
    ? focusedPaneState.clearSelectedCells
    : clearSelectedCells;
  closeContextMenu();
  clear?.();
}

function onGridCellAppendRow() {
  const tab = contextMenu.rowTab || activeDataTab.value;
  const insert = typeof focusedPaneState.insertDraftBelow === "function"
    ? focusedPaneState.insertDraftBelow
    : insertDraftBelow;
  closeContextMenu();
  if (!tab || typeof insert !== "function") return;
  insert(tab);
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

function selectCellAt(tab, rowIndex, columnIndex, options = {}) {
  const row = tabRowAt(tab, rowIndex);
  const column = tab?.columns?.[columnIndex];
  if (!row || !column) return;
  clearRowSelection(tab);
  clearSelection();
  selectCell(tab, row, columnName(column), rowIndex, columnIndex, { focusGrid: false });
  scrollCellIntoView(rowIndex, columnIndex, options);
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

function handleOpenDesignShortcut(event) {
  if (!shortcutHelper.matchesBinding("openDesign", event)) return false;
  // A custom bare letter is still text in an editor, not a navigation command.
  if (event.isComposing || (isEditableShortcutTarget(event.target) && !isSafeInAppShortcut(shortcutHelper.get("openDesign")))) return false;
  if (!focusedDesignTarget.value || designShortcutBlocked(event.target)) return false;
  event.preventDefault();
  event.stopPropagation();
  openFocusedDesign();
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
  if (!sourceHasCapability("findReplace", activeDataTab.value)) {
    blockUnsupportedEngine("整表查找替换，请使用表格上方的搜索框");
    return;
  }
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
  await refreshTabPage(tab, tab.page || 1, { inPlace: true });
  focusedPaneState.refreshCurrentSearchMatches?.();
}


// F5 refreshes what the focused pane shows: the home table list or the
// current table. The SQL editor keeps F5 for running the query. Everywhere
// else the key must not fall through to the WebView, whose reload would
// discard unsaved work.
function handleRefreshKeydown(event) {
  if (!shortcutHelper.matchesBinding("refresh", event)) return false;
  if (event.target?.closest?.(".cm-editor")) return false;
  event.preventDefault();
  event.stopPropagation();
  if (focusedPaneState.isEditing?.()) return true;
  if (activeTab.value?.kind === "home") focusedPaneState.refreshHomeView?.();
  else if (activeDataTab.value) void refreshDataTab(activeDataTab.value);
  return true;
}

function isTabShortcutEditingTarget(target) {
  // Neither the auto-focused table search nor a selected cell's IME holder
  // is an active cell edit. Opening and restoring a tab can focus either.
  return isEditableShortcutTarget(target)
    && !target.matches?.("input.wb-cell-ime-hold")
    && !focusedPaneState.isTableSearchTarget?.(target);
}

function handleCloseTabKeydown(event) {
  if (!shortcutHelper.matchesBinding("closeTab", event)) return false;
  if (event.isComposing || !closeTabOrHideWindow(event.target)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

// Physical Ctrl+Tab / Ctrl+Shift+Tab always cycles tabs on macOS (Safari
// convention), independent of the configurable next/previous bindings.
function isMacosPhysicalTabCycle(event) {
  return Boolean(event?.ctrlKey) && !event?.metaKey && !event?.altKey
    && (event?.code === "Tab" || event?.key === "Tab");
}

function handleCycleTabKeydown(event) {
  const pane = getFocusedPane(workspace);
  if (!pane) return false;
  let isNext = shortcutHelper.matchesBinding("nextTab", event);
  let isPrev = shortcutHelper.matchesBinding("previousTab", event);
  if (!isNext && !isPrev && usesNativeMacWindowControls && isMacosPhysicalTabCycle(event)) {
    isNext = !event.shiftKey;
    isPrev = event.shiftKey;
  }
  if (!isNext && !isPrev) return false;
  if (isTabShortcutEditingTarget(event.target)) return false;
  const direction = isPrev ? "previous" : "next";
  const nextTabId = adjacentPublishedTabId(workspace.tabs, pane, direction);
  if (!nextTabId) return false;
  event.preventDefault();
  event.stopPropagation();
  void activateTab(pane.id, nextTabId);
  return true;
}

function handleTabShortcutKeydown(event) {
  if (!isTabShortcutEvent(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  const pane = getFocusedPane(workspace);
  if (pane) openCurrentDatabaseHome({ paneId: pane.id, activate: true });
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
  if (!matchedAction && !matchesFavorite && !isNativeFindKeydown(event) && !isTabShortcutEvent(event)) return;
  // Keep the browser's native undo/redo inside dialog text fields. Every
  // other configured app shortcut is inert while a dialog owns the keyboard.
  if (matchedAction === "undo" && isEditableShortcutTarget(event.target)) return;
  event.preventDefault();
}

const pageZoom = createPageZoom({
  applyZoom: async (scale) => {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(scale);
    syncMacosTrafficLights(scale);
  },
  onChange: (percent) => setStatus(t("pageZoom.changed", { percent })),
  onError: (error) => setStatus(t("pageZoom.failed", { error: String(error?.message || error) }), { tone: "error" }),
});
const syncMacosTrafficLights = useMacosTrafficLights({
  enabled: usesNativeMacWindowControls,
  getScale: () => pageZoom.scale,
  invoke: invokeWorkbench,
});

// macOS re-centres the traffic lights on the default titlebar frame whenever
// the window appearance flips (setTheme / vibrancy effects), undoing our
// alignment — re-align right away and again once AppKit settles.
async function applyNativeThemeKeepingTrafficLights(theme) {
  await applyNativeWindowTheme(theme);
  syncMacosTrafficLights();
  setTimeout(syncMacosTrafficLights, 150);
}
if (isTauriRuntime()) void pageZoom.restore();

const handlePageZoomWheel = createPageZoomWheelHandler({
  platform: isMacOSPlatform() ? "macos" : "windows",
  run: pageZoom.run,
  enabled: isTauriRuntime,
});

function handleGlobalShortcutKeydown(event) {
  if (event.target?.closest?.('[data-wb-shortcut-capture="true"]')) return;
  const zoomAction = pageZoomAction(event, isMacOSPlatform() ? "macos" : "windows");
  if (zoomAction && isTauriRuntime()) {
    event.preventDefault();
    event.stopPropagation();
    noteShortcutKeydownMatch(zoomAction);
    void pageZoom.run(zoomAction);
    return;
  }
  if (dialogLayerManager.hasActiveModalLayer()) {
    hideTabShortcutHints();
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
  if (handleRefreshKeydown(event)) return;
  if (handleCloseTabKeydown(event)) return;
  if (handleOpenDesignShortcut(event)) return;
  if (handleCycleTabKeydown(event)) return;
  if (handleTabShortcutKeydown(event)) return;
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
  if (handleUndoKeydown(event)) return;
  handleRedoKeydown(event);
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
    await refreshTabPage(tab, tab.page || 1, { inPlace: true });
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
    await refreshTabPage(tab, tab.page || 1, { inPlace: true });
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

// SQL text changes on every keystroke. Serializing every tab and rewriting
// the SQL document library + workspace snapshot per key made typing lag, so
// text edits are coalesced; structural changes (tabs, panes, layout, flags)
// still persist immediately and flush any pending text with them.
const workspacePersistence = createCoalescedTask(() => {
  syncSqlDocumentsFromTabs();
  persistWorkspace();
}, { delayMs: 400, maxWaitMs: 2000 });

function flushWorkspacePersistence() {
  workspacePersistence.flush();
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
    workspacePersistence.flush({ force: true });
  },
  { deep: false },
);

// Reads each SQL tab's text by reference only (no serialization per keystroke).
watch(
  () => workspace.tabs.map((tab) => (tab?.kind === "sql" ? tab.sql : null)),
  () => {
    workspacePersistence.schedule();
  },
);

// Coalesce live width changes like SQL text edits. Page hide flushes pending
// changes even if the user reloads immediately after a resize or reset.
watch(
  () => JSON.stringify(workspace.tabs.map(manualColumnWidthsOf)),
  () => workspacePersistence.schedule(),
);

watch(
  () => workspace.tabs.map((tab) => tab?.createMode ? tab.draft : null),
  () => workspacePersistence.schedule(),
);

function flushWorkspacePersistenceWhenHidden() {
  if (document.visibilityState === "hidden") flushWorkspacePersistence();
}

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
      if (!connectionCapability(savedTab.connectionId || currentConnectionId, "sqlConsole")) continue;
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
    if (savedTab.kind === "folders") {
      const restoredFolders = openTableFoldersTab(workspace, {
        connectionId: currentConnectionId,
        database: currentDatabase,
        folderId: savedTab.folderId,
      }, { activate: false, paneId });
      if (restoredFolders) savedToRestoredTabId.set(savedTab.id, restoredFolders.id);
      continue;
    }
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
    if (savedTab.kind === "design" && savedTab.createMode) {
      const source = { connectionId: currentConnectionId, database: currentDatabase };
      if (!isReadOnlySource(source) && sourceHasCapability("tableDesign", source)) {
        const restored = openCreateTableTab(workspace, { ...source, draft: savedTab.draft }, { activate: false, paneId });
        if (restored) savedToRestoredTabId.set(savedTab.id, restored.id);
      }
      continue;
    }
    if (!savedTableTabMatchesSource(savedTab, {
      connectionId: currentConnectionId,
      database: currentDatabase,
      availableTableNames,
    })) continue;

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
      // Restore a shell only: no database round trip here. Visible tabs load
      // right after the layout is restored, the rest are preloaded quietly or
      // load when first shown (useTableSession deferred loading).
      restoredTab = openTableTab(workspace, {
        connectionId: currentConnectionId,
        database: currentDatabase,
        tableName: savedTab.tableName,
        tableComment: normalizeTableComment(tableForOpen),
        readOnly,
        hitResultMode: Boolean(savedTab.relationFilter),
        relationFilter: savedTab.relationFilter,
        relationOrigin: savedTab.relationOrigin,
      }, { activate: false, paneId });
      if (restoredTab && !restoredTab.sessionId) {
        restoredTab.readOnly = readOnly;
        restoredTab.deferredLoad = true;
      }
    }
    if (restoredTab) {
      applySavedTableTabState(restoredTab, savedTab);
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
  void loadVisibleDeferredTabs();
}

// ── Native macOS app menu ────────────────────────────────────────────────
// The menu dispatches to the same orchestrator functions as the keydown
// handlers; enabled/checked state mirrors the gates those handlers use.
const nativeMenuTools = computed(() => {
  const source = moreSource.value || batchTransferSource(activeTab.value);
  const hasDatabase = Boolean(source.connectionId && source.database);
  const writable = hasDatabase && !isReadOnlySource(source);
  return [
    { id: "tableFolders", label: t("tableFolders.title"), action: "tableFolders" },
    { id: "backupCenter", label: t("m_965320c43727"), action: "backupCenter" },
    { id: "tableTransfer", label: t("m_a36603b169a6"), action: "tableTransfer", shortcutAction: "openTableTransfer" },
    { id: "releaseFlow", label: t("releaseFlow.title"), action: "releaseFlow" },
    { id: "configRelations", label: t("shell.configRelations"), action: "configRelations" },
    { id: "blackcatMcp", label: t("blackcatMcp.title"), action: "blackcatMcp" },
    { id: "moreSync", label: t("m_623281e9dfdb"), action: "moreSync", group: "more", enabled: writable && sourceHasCapability("sync", source) },
    { id: "moreSend", label: t("m_8f211e16faf2"), action: "moreSend", group: "more", enabled: writable && sourceHasCapability("tableCopy", source) },
    { id: "moreImport", label: t("m_fd7719273970"), action: "moreImport", group: "more", enabled: writable && sourceHasCapability("import", source) },
    { id: "moreExport", label: t("m_d2fcdde81f06"), action: "moreExport", group: "more", enabled: hasDatabase },
  ];
});

function runMoreMenuAction(id) {
  moreSource.value = batchTransferSource(activeTab.value);
  selectMoreAction(id);
}

function adjacentTabAvailable(direction) {
  const pane = getFocusedPane(workspace);
  if (!pane) return false;
  return Boolean(adjacentPublishedTabId(workspace.tabs, pane, direction));
}

function cycleFocusedTab(direction) {
  const pane = getFocusedPane(workspace);
  if (!pane) return;
  const nextTabId = adjacentPublishedTabId(workspace.tabs, pane, direction);
  if (nextTabId) void activateTab(pane.id, nextTabId);
}

const focusedDesignTarget = computed(() => {
  if (activeDataTab.value) return activeDataTab.value;
  const tab = activeTab.value;
  return tab?.kind === "home" && resolveHomeDesignTargets(tab).length ? tab : null;
});

function designShortcutBlocked(element) {
  return dialogLayerManager.hasActiveModalLayer()
    || Boolean(element?.closest?.('[role="dialog"], [data-wb-shortcut-capture="true"]'));
}

function openFocusedDesign() {
  const target = focusedDesignTarget.value;
  if (!target || designShortcutBlocked(document.activeElement)) return;
  if (target === activeDataTab.value && !isReadOnlySource(target) && sourceHasCapability("tableDesign", target)) {
    // Finish against the original table before the design tab replaces its editors.
    if (focusedPaneState.isEditing?.()) focusedPaneState.commitEditingWithoutRefocus?.();
    if (document.activeElement?.matches?.(".wb-detail-input")) document.activeElement.blur();
  }
  return openTableDesign(target, workspace.focusedPaneId);
}

// Mirrors the F3 handler's gate: a home tab with a focused/selected table on
// a writable, tableDesign-capable source.
function homeCommentTargetCanEdit() {
  const target = focusedHomeInspectorSchema.value;
  if (!target) return false;
  const source = {
    connectionId: target.home.connectionId,
    database: target.home.database,
    readOnly: target.home.readOnly || target.home.read_only,
  };
  return !isReadOnlySource(source) && sourceHasCapability("tableDesign", source);
}

function editTableCommentFromMenu() {
  const target = focusedHomeInspectorSchema.value;
  if (!target) return;
  openHomeTableCommentEdit({
    connectionId: target.home.connectionId,
    database: target.home.database,
    tableName: target.tableName,
    tableComment: normalizeTableComment(target.schema) || target.home.focusedTableComment || "",
  });
}

function refreshFromMenu() {
  if (focusedPaneState.isEditing?.()) return;
  if (activeTab.value?.kind === "home") focusedPaneState.refreshHomeView?.();
  else if (activeDataTab.value) void refreshDataTab(activeDataTab.value);
}

// ⌘W: close the active tab; hide the window when there is nothing to close
// (the default menu's Close Window behaviour).
function closeTabOrHideWindow(target = document.activeElement) {
  if (dialogLayerManager.hasActiveModalLayer() || target?.closest?.('[data-wb-shortcut-capture="true"]')) return false;
  if (isTabShortcutEditingTarget(target)) return false;
  const tab = activeTab.value;
  if (tab) void closeTab(tab.id);
  else if (usesNativeMacWindowControls) withCurrentWindow((win) => (isFolderWindow ? win.close() : win.hide()));
  else return false;
  return true;
}

useNativeAppMenu({
  secondaryWindow: isFolderWindow,
  bindings: shortcutHelper.bindings,
  appName: "黑猫",
  appVersion: APP_VERSION,
  state: () => ({
    hasDataTab: Boolean(activeDataTab.value),
    canOpenDesign: Boolean(focusedDesignTarget.value),
    canEditTableComment: homeCommentTargetCanEdit(),
    canRefresh: Boolean(activeTab.value),
    hasNextTab: adjacentTabAvailable("next"),
    hasPrevTab: adjacentTabAvailable("previous"),
    sidebarCollapsed: sidebarCollapsed.value,
    inspectorCollapsed: inspectorCollapsed.value,
    windowPinned: windowPin.pinned.value,
    themePreference: themePreference.value,
    tools: nativeMenuTools.value,
  }),
  actions: {
    checkUpdates: () => updater.checkForUpdates({ openOnError: true, openOnAvailable: true }),
    openSettings: () => sidebarRef.value?.openSettings?.(),
    openShortcutSettings: () => sidebarRef.value?.openShortcuts?.(),
    newConnection: () => openConnDialog(),
    openSqlQuery: () => openSqlQuery(),
    quickOpen: () => openQuickOpenFromAnywhere(),
    closeTabOrHide: closeTabOrHideWindow,
    findInTable: () => openFindReplaceDialog("find"),
    replaceInTable: () => openReplaceDialog(),
    openDesign: openFocusedDesign,
    editTableComment: editTableCommentFromMenu,
    refresh: refreshFromMenu,
    tableFolders: openTableFolderPage,
    backupCenter: openBackupCenter,
    tableTransfer: openTableTransfer,
    releaseFlow: openReleaseFlow,
    configRelations: () => openConfigRelationsReview(),
    blackcatMcp: openBlackcatMcp,
    moreSync: () => runMoreMenuAction("sync"),
    moreSend: () => runMoreMenuAction("send"),
    moreImport: () => runMoreMenuAction("import"),
    moreExport: () => runMoreMenuAction("export"),
    toggleSidebar: () => toggleSidebar(),
    toggleInspector: () => toggleInspector(),
    zoomIn: () => pageZoom.run("zoomIn"),
    zoomOut: () => pageZoom.run("zoomOut"),
    zoomReset: () => pageZoom.run("zoomReset"),
    nextTab: () => cycleFocusedTab("next"),
    previousTab: () => cycleFocusedTab("previous"),
    togglePinWindow: () => void toggleWindowPin(),
    appearanceLight: () => setThemePreference("light"),
    appearanceDark: () => setThemePreference("dark"),
    appearanceSystem: () => setThemePreference("system"),
  },
});

// ── Lifecycle ─────────────────────────────────────────────────────────────
// The startup update check runs `svn update` (network + disk). Defer it until
// the workspace is usable and the WebView is idle so it never competes with
// connection restoration or the first table page.
const DEFERRED_UPDATE_CHECK_IDLE_TIMEOUT_MS = 10_000;
const DEFERRED_UPDATE_CHECK_FALLBACK_DELAY_MS = 5_000;
// Restored background tabs are preloaded one at a time once the WebView is
// idle, so later tab switches stay instant without delaying the first screen.
const RESTORED_TAB_PRELOAD_IDLE_TIMEOUT_MS = 3_000;
function scheduleIdleStartupWork(run, idleTimeoutMs) {
  if (typeof globalThis.requestIdleCallback === "function") {
    globalThis.requestIdleCallback(run, { timeout: idleTimeoutMs });
  } else {
    globalThis.setTimeout(run, DEFERRED_UPDATE_CHECK_FALLBACK_DELAY_MS);
  }
}

let deferredUpdateCheckScheduled = false;
function scheduleDeferredUpdateCheck() {
  if (deferredUpdateCheckScheduled) return;
  deferredUpdateCheckScheduled = true;
  scheduleIdleStartupWork(() => { void updater.checkForUpdates({ silent: true }); }, DEFERRED_UPDATE_CHECK_IDLE_TIMEOUT_MS);
}

onMounted(async () => {
  markPerf("workbench.mounted");
  tableModifiedTimeAutoRefresh.start();
  if (!isFolderWindow) tableTransfer.startCleanup();
  if (!isFolderWindow) void updater.startBackgroundListener();
  void ensureSqlExecutionListener();
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("blur", onWindowBlurTitlebarReset);
  window.addEventListener("pointermove", onPointerMoveClearTitlebarSuppress, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityTitlebarReset);
  document.addEventListener("visibilitychange", flushWorkspacePersistenceWhenHidden);
  window.addEventListener("pagehide", flushWorkspacePersistence);
  window.addEventListener("beforeunload", flushWorkspacePersistence);
  // Capture-phase listener so native WebView shortcuts are intercepted before
  // Ctrl+F opens find-in-page or Ctrl+P opens the print dialog.
  document.addEventListener("keydown", handleGlobalShortcutKeydown, true);
  document.addEventListener("wheel", handlePageZoomWheel, { capture: true, passive: false });
  document.addEventListener("contextmenu", openInputContextMenu, true);
  document.addEventListener("pointerdown", dismissInputContextMenu, true);
  document.addEventListener("keydown", dismissInputContextMenu, true);
  void windowPin.sync();
  refreshMacosFullscreen();
  // Re-register the global "open window" shortcut from the persisted binding
  // so a user-rebound combo takes effect this session instead of the Rust
  // startup default (analysis point #2). Best-effort; failures don't block UI.
  if (!isFolderWindow) void syncGlobalShortcutBinding();
  try {
    await conn.loadConnections();
    // loadConnections() returns once the last-used connection is ready; other
    // saved connections keep restoring in order in the background. Only mark
    // the external MCP frontend ready after all of them, so a hidden cold
    // start cannot race its first DB/UI request against connection restoration.
    if (!isFolderWindow) void conn.whenConnectionsRestored().finally(() => agent.ensureControlListener());
    markPerf("workbench.connections-ready", { connections: connections.value.length, databases: databases.value.length });
    await restoreSavedTabs();
    await ensureCurrentDatabaseHome();
    tableFolderPage.afterFolderWindowRestored();
    void tableFolderPage.startFolderWindow();
    markPerf("workbench.tabs-restored", { tabs: workspace.tabs.length });
    sampleNextFrame("workbench.first-usable-frame", { tabs: workspace.tabs.length, tables: workspace.tables.length });
  } catch (e) {
    // Still release queued MCP calls so they receive the real connection error
    // instead of waiting until the control timeout.
    if (!isFolderWindow) await agent.ensureControlListener();
    conn.statusText.value = `初始化失败：${String(e)}`;
  }
  persistenceReady = true;
  persistWorkspace();
  if (!isFolderWindow) scheduleDeferredUpdateCheck();
  if (!isFolderWindow) void checkStartupAccountLogin();
  scheduleIdleStartupWork(() => { void preloadDeferredTabs(); }, RESTORED_TAB_PRELOAD_IDLE_TIMEOUT_MS);
});

onBeforeUnmount(() => {
  flushWorkspacePersistence();
  window.removeEventListener("blur", onWindowBlurTitlebarReset);
  window.removeEventListener("pointermove", onPointerMoveClearTitlebarSuppress);
  document.removeEventListener("visibilitychange", onVisibilityTitlebarReset);
  document.removeEventListener("visibilitychange", flushWorkspacePersistenceWhenHidden);
  window.removeEventListener("pagehide", flushWorkspacePersistence);
  window.removeEventListener("beforeunload", flushWorkspacePersistence);
  tableModifiedTimeAutoRefresh.stop();
  void agent.disposeControlListener();
  tableFolderPage.dispose();
  disposeConnection();
  void disposeGlobalTableSearch();
  void disposeTableSessions();
  window.removeEventListener("resize", onWindowResize);
  document.removeEventListener("keydown", handleGlobalShortcutKeydown, true);
  document.removeEventListener("wheel", handlePageZoomWheel, true);
  document.removeEventListener("contextmenu", openInputContextMenu, true);
  document.removeEventListener("pointerdown", dismissInputContextMenu, true);
  document.removeEventListener("keydown", dismissInputContextMenu, true);
  databaseSync.dispose();
  backupCenter.dispose();
  tableTransfer.dispose();
  updater.stopBackgroundListener();
  unlistenValueSearchProgress?.();
  unlistenValueSearchProgress = null;
  unlistenSqlExecution?.();
  unlistenSqlExecution = null;
  unlistenTableCreated?.();
  unlistenTableCreated = null;
  unlistenTableModifiedTimes?.();
  unlistenTableModifiedTimes = null;
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
      'is-fullscreen': macosFullscreen,
      'has-wallpaper': Boolean(wallpaperSource),
    }"
    :data-theme="effectiveTheme"
    :data-wallpaper-scope="wallpaperSource ? wallpaperSettings.scope : undefined"
    :style="[sidebarLayoutVars, wallpaperSource ? {
      '--wb-wallpaper-veil': `${wallpaperVeil * 100}%`,
      '--wb-wallpaper-tab-opacity': wallpaperTabOpacity,
    } : null]"
    @transitionend="onSidebarLayoutTransitionEnd"
    @click="closeAllContextMenus"
    @keydown="handleWorkbenchKeydown"
    @contextmenu.prevent="openGeneralContextMenu"
  >
    <WallpaperCanvas @strength-change="wallpaperStrength = $event" />
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
        :aria-label="t('m_ed9a41e59406')"
        data-tauri-drag-region
      >
        <button
          type="button"
          class="wb-header-btn wb-topbar-collapse-btn"
          :aria-label="sidebarCollapsed ? t('m_9cb43e8f453f') : t('m_5219e5b37457')"
          :title="sidebarCollapsed ? t('m_9cb43e8f453f') : t('m_5219e5b37457')"
          @click.stop="toggleSidebar()"
        >
          <PanelLeftOpen v-if="sidebarCollapsed" :size="15" :stroke-width="1.75" aria-hidden="true" />
          <PanelLeftClose v-else :size="15" :stroke-width="1.75" aria-hidden="true" />
        </button>
      </div>


      <div
        class="wb-titlebar-tabs"
        id="wb-topbar-tabs"
        :aria-label="t('m_79aaded7fe4f')"
        data-tauri-drag-region
      ></div>


      <div
        class="wb-titlebar-inspector-controls"
        :class="{ 'is-collapsed': inspectorCollapsed }"
        :style="inspectorTitlebarStyle"
        :aria-label="t('m_58766ed3abce')"
        data-tauri-drag-region
      >
        <button
          type="button"
          class="wb-header-btn wb-topbar-collapse-btn"
          :class="{ 'has-indicator': inspectorCollapsed && (inspectorRelationSummary?.total || 0) > 0 }"
          :aria-label="inspectorToggleLabel"
          :title="inspectorToggleLabel"
          @click.stop="toggleInspector()"
        >
          <PanelRightOpen v-if="inspectorCollapsed" :size="15" :stroke-width="1.75" aria-hidden="true" />
          <PanelRightClose v-else :size="15" :stroke-width="1.75" aria-hidden="true" />
          <span
            v-if="inspectorCollapsed && (inspectorRelationSummary?.total || 0) > 0"
            class="wb-topbar-collapse-dot"
            :class="{ 'is-pending': (inspectorRelationSummary?.pending || 0) > 0 }"
            aria-hidden="true"
          ></span>
        </button>
      </div>

      <div
        v-if="!usesNativeMacWindowControls"
        class="wb-titlebar-controls"
        :class="{ 'is-hover-suppressed': titlebarHoverSuppressed }"
        :aria-label="t('m_e7cfeddae1f5')"
      >
        <button
          type="button"
          class="wb-titlebar-button"
          :aria-label="t('m_6ae80538c2b2')"
          :title="t('m_ac29e57a46f4')"
          @click.stop="minimizeWindow"
        >
          <span class="wb-window-icon is-minimize" aria-hidden="true"></span>
        </button>
        <button
          type="button"
          class="wb-titlebar-button"
          :aria-label="t('m_cc0c2fbe3e92')"
          :title="t('m_82a6d9c3668c')"
          @click.stop="toggleMaximizeWindow"
        >
          <span class="wb-window-icon is-maximize" aria-hidden="true"></span>
        </button>
        <button
          type="button"
          class="wb-titlebar-button is-close"
          :aria-label="isFolderWindow ? t('m_1ae6b0a0f826') : t('titlebar.hideToTray')"
          :title="t('m_3fd47edce45b')"
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
      <WorkbenchActivityRail
        :lead-items="activityRailLeadItems"
        :items="activityRailItems"
        :bottom-items="activityRailBottomItems"
        :more-item="activityRailMoreItem"
        :theme="effectiveTheme"
        :more-actions="moreActions"
        @more-open="openMoreActions"
        @more-select="selectMoreAction"
        :label="t('shell.activityRail')"
        :database-items="railDatabaseItems"
        :database-label="t('railDatabase.groupLabel')"
        @select="selectActivityRailEntry"
        @reorder="reorderActivityRailEntry"
        @database-select="(item) => void openFavoriteDatabase({ connectionId: item.connectionId, database: item.database })"
        @database-reorder="reorderRailDatabases"
        @database-drop="pinRailDatabase"
        @database-unpin="unpinRailDatabase"
        @database-appearance="setRailDatabaseAppearance"
        @database-appearance-reset="resetRailDatabaseAppearance"
      />
      <HomeDatabaseFavorites ref="homeFavoritesRef" :pane-id="workspace.focusedPaneId" />
      <div v-if="showNarrowHint" class="wb-narrow-hint" role="status">
        <span class="wb-narrow-hint-text">{{ t('m_c59ab8b4a9b4') }}</span>
        <span class="wb-narrow-hint-actions">
          <button type="button" class="wb-narrow-hint-btn" @click="toggleSidebar()">{{ t('m_ce1d67c2703c') }}</button>
          <button type="button" class="wb-narrow-hint-btn" @click="focusCurrentTableOnly()">{{ t('m_74cdac97a8e4') }}</button>
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
        :theme-preference="themePreference"
        :vibrancy-on="macosVibrancy.vibrancy.value"
        :vibrancy-supported="macosVibrancy.supported"
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
        @open-tables="openTablesFromSidebar"
        @delete-tables="deleteHomeTables"
        @remove-connection="confirmRemoveConnection"
        @rename-table="openTableRenameFromSource"
        @rename-database="openDatabaseAliasDialog"
        @rename-connection="openConnectionAliasDialog"
        @contextmenu="openSidebarContextMenu"
        @set-theme="setThemePreference"
        @set-vibrancy="macosVibrancy.setPreference"
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
          :show-shortcut-hints="tabShortcutHintsVisible"
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
          :apply-search-filter="applySearchFilter"
          :apply-column-filter="applyColumnFilter"
          :clear-column-filters="clearColumnFilters"
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
          @create-table="openCreateTable"
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
          @open-table="openConfigRelationTable"
          @copy-home-tables="copyHomeTables"
          @paste-home-tables="pasteHomeTables"
          @rename-home-table="renameHomeTable"
          @edit-home-table-comment="openHomeTableCommentEdit"
          @edit-column-meaning="openColumnMeaningEdit"
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

      <InspectorPanel
        :class="{ 'is-collapsed': inspectorCollapsed }"
        :style="inspectorStyle"
        :active-tab="focusedInspectorTab"
        :active-columns="focusedActiveColumns"
        :selected-cell="focusedSelectedCell"
        :selected-range="focusedSelectedRange"
        :schema-search-query="focusedPaneState.activeDataTab?.schemaSearchQuery || ''"
        :schema-search-matches="focusedPaneState.activeDataTab?.schemaSearchMatches || []"
        :schema-search-index="focusedPaneState.activeDataTab?.schemaSearchIndex ?? -1"
        @contextmenu="openInspectorContextMenu"
        @select-column="focusedPaneState.selectCurrentRowColumn?.($event)"
        @schema-search="focusedPaneState.applyColumnSearch?.($event)"
        @schema-search-previous="focusedPaneState.goToPreviousSchemaSearchMatch?.()"
        @schema-search-next="focusedPaneState.goToNextSchemaSearchMatch?.()"
        :relations="configRelations"
        :relations-supported="relationsSupportedForTab(focusedInspectorTab)"
        :schema="workspace.schema"
        @open-relation="openRelationTab"
        @open-relations-review="openConfigRelationsReview"
        @open-table="openConfigRelationTable"
        @relation-summary="inspectorRelationSummary = $event"
      />
    </section>

    <OperationNoticeStack :notices="operationNotices" />

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
      ref="contextMenuRef"
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
      :can-clear-cells="canClearCells"
      :clear-cells-label="clearCellsLabel"
      :can-grid-cell-row-actions="canGridCellRowActions"
      :can-append-row="canAppendRow"
      :can-toggle-hit-result-pane="contextMenu.canToggleHitResultPane"
      :hit-result-pane-open="contextMenu.hitResultPaneOpen"
      :delete-label="contextMenuDeleteLabel"
      :can-freeze-row="canFreezeRow"
      :can-freeze-column="canFreezeColumn"
      :can-freeze-cell="canFreezeCell"
      :has-freeze="hasFreeze"
      :can-reset-column-order="canResetColumnOrder"
      :can-edit-comment="canEditInspectorComment"
      :freeze-row-label="freezeRowLabel"
      :freeze-column-label="freezeColumnLabel"
      :freeze-cell-label="freezeCellLabel"
      :table-count="contextMenu.tableNames.length || 1"
      :can-delete-tables="contextMenuCanDeleteTables"
      :database-on-rail="isRailDatabase(contextMenu.connectionId, contextMenu.database)"
      @close="closeContextMenu"
      @toggle-database-rail="toggleRailDatabaseFromContext"
      @open-tables="openTablesFromContextMenu"
      @delete-tables="deleteTablesFromContextMenu"
      @refresh="refreshFromContextMenu"
      @copy="copyFromContextMenu"
      @paste="pasteFromContextMenu"
      @clear-cells="onClearSelectedCells"
      @open-design="openDesignFromContextMenu"
      @sync-database="openDatabaseSync"
      @send-table="openTableCopyFromContext"
      @rename="openTableRenameFromContext"
      @rename-database="openDatabaseAliasFromContext"
      @rename-connection="openConnectionAliasFromContext"
      @remove-connection="removeConnectionFromContext"
      @grid-row-insert-above="onGridRowInsertAbove"
      @grid-row-insert-below="onGridRowInsertBelow"
      @grid-cell-append-row="onGridCellAppendRow"
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
      @edit-comment="openCommentEditFromMenu"
    />

    <CommentEditDialog
      :open="commentEdit.open"
      :kind="commentEdit.kind"
      :name="commentEdit.kind === 'table' ? commentEdit.tableName : commentEdit.columnName"
      :table-name="commentEdit.tableName"
      :database="commentEdit.database"
      :value="commentEdit.value"
      :sample-value="commentEdit.sampleValue"
      :read-only="commentEdit.readOnly"
      :tables="commentEditTables"
      :load-table-columns="loadCommentEditTableColumns"
      :saving="commentEdit.saving"
      :error="commentEdit.error"
      @close="closeCommentEdit"
      @save="saveCommentEdit"
    />

    <menu
      v-if="tabContextMenu.open"
      ref="tabContextMenuRef"
      class="wb-context-menu wb-tab-context-menu"
      :style="{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }"
      role="menu"
      tabindex="-1"
      :aria-label="t('tabs.menu')"
      @click.stop
      @contextmenu.prevent.stop
      @keydown="handleTabContextMenuKeydown"
    >
      <button type="button" role="menuitem" :disabled="!['home', 'data'].includes(tabContextTab?.kind || 'data')" @click="refreshTabsFromMenu"><RefreshCw :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_aee887434131') }}<kbd v-if="tabContextMenuShortcuts.refresh" class="wb-context-shortcut" aria-hidden="true">{{ tabContextMenuShortcuts.refresh }}</kbd></button>
      <template v-if="tabContextIsDataTable">
        <button type="button" role="menuitem" @click="openDesignFromTabMenu"><TableProperties :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_d9a122ddc940') }}<kbd v-if="tabContextMenuShortcuts.design" class="wb-context-shortcut" aria-hidden="true">{{ tabContextMenuShortcuts.design }}</kbd></button>
        <button type="button" role="menuitem" :disabled="!tabContextCanRename" @click="renameTableFromTabMenu"><Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('contextMenu.renameTable') }}</button>
      </template>
      <hr class="wb-context-separator" role="separator" />
      <button type="button" role="menuitem" :disabled="!tabContextTab || tabContextTab.kind === 'home' || tabContextTab.opening" @click="closeTabFromMenu"><X :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('tabs.close') }}<kbd v-if="tabContextMenuShortcuts.close" class="wb-context-shortcut" aria-hidden="true">{{ tabContextMenuShortcuts.close }}</kbd></button>
      <button type="button" role="menuitem" :disabled="!tabContextNeighborAvailability.left && !tabContextNeighborAvailability.right" @click="closeOtherTabsFromMenu"><CopyX :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('tabs.closeOthers') }}</button>
      <button type="button" role="menuitem" :disabled="!tabContextNeighborAvailability.left" @click="closeRelativeTabsFromMenu('left')"><ArrowLeftToLine :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_bc066eb3c8b6') }}</button>
      <button type="button" role="menuitem" :disabled="!tabContextNeighborAvailability.right" @click="closeRelativeTabsFromMenu('right')"><ArrowRightToLine :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_9594d7707c4b') }}</button>
      <button type="button" role="menuitem" @click="closeAllTabsFromMenu"><ListX :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_34f7336d3983') }}</button>
    </menu>

    <ReleaseFlowDialog
      v-if="releaseFlowOpen"
      :minimized="releaseFlowMinimized"
      :connections="connections"
      :databases-by-connection="databasesByConnection"
      :database-sync="databaseSync"
      :backup-center="backupCenter"
      :transfer="tableTransfer"
      :exclusion-templates="databaseSync.exclusionTemplates.value"
      @open-database-sync="openDatabaseSync"
      @open-backup-center="openBackupCenterFromRelease"
      @open-table-transfer="openTableTransfer"
      @minimize="minimizeReleaseFlow"
      @status-change="releaseFlowStatus = $event"
      @close="closeReleaseFlow"
    />

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
      :active-connection-id="selectedConnectionId"
      :active-database="selectedDatabase"
      :active-table-name="activeDataTab?.tableName || ''"
      @close="backupCenter.close"
    />

    <TableTransferDialog
      v-if="tableTransfer.dialog.open"
      :transfer="tableTransfer"
      @close="tableTransfer.close"
    />

    <ConfigRelationsDialog
      v-if="configRelationsDialogOpen"
      :relations="configRelations"
      :scope="configRelationsDialogScope"
      :scope-label="configRelationsScopeLabel"
      :supported="configRelationsDialogSupported"
      :schema="workspace.schema"
      @close="configRelationsDialogOpen = false"
      @open-table="openConfigRelationTable"
    />

    <BlackcatMcpDialog
      v-if="blackcatMcpOpen"
      :assistant="agent"
      :theme="effectiveTheme"
      @close="blackcatMcpOpen = false"
    />

    <AccountStartupLoginDialog
      v-if="startupAccountLoginOpen"
      :open="startupAccountLoginOpen"
      :account="account"
      @close="closeStartupAccountLogin"
      @authenticated="handleStartupAccountAuthenticated"
    />

    <AiActivityGlow :theme="effectiveTheme" />

    <!-- Table Rename Dialog -->
    <div v-if="tableRename.open" class="wb-dialog-overlay">
      <form ref="tableRenameDialogRef" class="wb-dialog" role="dialog" aria-modal="true" :aria-label="t('m_c1c0117d498e')" tabindex="-1" @submit.prevent="executeTableRename">
        <header class="wb-dialog-header">
          <strong>{{ t('m_c1c0117d498e') }}</strong>
          <button type="button" class="wb-dialog-close" @click="closeTableRename">×</button>
        </header>
        <p style="margin: 0 0 10px; font-size: var(--wb-fs-body); color: var(--wb-secondary-text);">
          {{ tableRename.database }} · {{ tableRename.tableName }}
        </p>
        <label class="wb-dialog-field">
          <span>{{ t('m_92ddb51db6c4') }}</span>
          <input v-model="tableRename.newName" :placeholder="t('m_279d7d4f861b')" />
        </label>
        <p v-if="tableRename.error" class="wb-dialog-error">{{ tableRename.error }}</p>
        <footer class="wb-dialog-actions">
          <button type="button" @click="closeTableRename">{{ t('m_2cd0f3be8738') }}</button>
          <button type="submit" :disabled="tableRename.busy || !tableRename.newName || tableRename.newName === tableRename.tableName">
            {{ tableRename.busy ? t('m_b49f6ac0fe4c') : t('m_c1c0117d498e') }}
          </button>
        </footer>
      </form>
    </div>

    <div v-if="aliasDialog.open && aliasDialog.type === 'connection'" class="wb-dialog-overlay">
      <form ref="connectionAliasDialogRef" class="wb-dialog" role="dialog" aria-modal="true" :aria-label="t('m_9dc6275e6672')" tabindex="-1" @submit.prevent="saveAlias">
        <header class="wb-dialog-header">
          <strong>{{ aliasDialog.type === "connection" ? t('m_c3a80a6a1e41') : t('m_287199464530') }}</strong>
          <button type="button" class="wb-dialog-close" @click="closeAliasDialog">×</button>
        </header>
        <p style="margin: 0 0 10px; font-size: var(--wb-fs-body); color: var(--wb-secondary-text);">
          {{ aliasDialog.type === "connection" ? t('m_970932d40f1a') : t('m_5c169ab6b865') }}：{{ aliasDialog.realName }}{{ t('m_0e08a67346ea') }}{{ aliasDialog.type === "connection" ? t('m_a5574109f020') : t('m_263200d7d529') }}）
        </p>
        <label class="wb-dialog-field">
          <span>{{ t('m_55c4cb3d7464') }}</span>
          <input v-model="aliasDialog.alias" :placeholder="t('m_65cb3e68ae95')" maxlength="60" autofocus />
        </label>
        <footer class="wb-dialog-actions">
          <button type="button" @click="closeAliasDialog">{{ t('m_2cd0f3be8738') }}</button>
          <button type="submit">{{ t('m_a3030bf8f16d') }}</button>
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
