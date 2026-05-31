<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";

import {
  closeAllTableTabs,
  closeTableTab,
  createWorkspaceState,
  filterSchemaTree,
  getActiveTab,
} from "./workspaceState.js";
import { createEditState, isCellPending, getCellError } from "./editState.js";
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

import WorkbenchSidebar from "./components/WorkbenchSidebar.vue";
import WorkbenchTabs from "./components/WorkbenchTabs.vue";
import DataGrid from "./components/DataGrid.vue";
import InspectorPanel from "./components/InspectorPanel.vue";
import PaneDivider from "./components/PaneDivider.vue";
import ContextMenu from "./components/ContextMenu.vue";
import ImportWizardDialog from "./components/ImportWizardDialog.vue";
import ConnectionDialog from "./components/ConnectionDialog.vue";
import SelectedCellIdentity from "./components/SelectedCellIdentity.vue";

import { useConnection } from "./composables/useConnection.js";
import { useTableSession } from "./composables/useTableSession.js";
import { useTableSearch } from "./composables/useTableSearch.js";
import { useVirtualGrid } from "./composables/useVirtualGrid.js";
import { useGridEditor } from "./composables/useGridEditor.js";
import { useRowSelection } from "./composables/useRowSelection.js";
import { useContextMenu } from "./composables/useContextMenu.js";
import { useImportWizard } from "./composables/useImportWizard.js";
import { useExport } from "./composables/useExport.js";
import { useUndo } from "./composables/useUndo.js";
import { usePaneResize } from "./composables/usePaneResize.js";
import { useTheme } from "./composables/useTheme.js";

// ── Shared state ──────────────────────────────────────────────────────────
const workspace = reactive(createWorkspaceState());
const editState = reactive(createEditState());
const treeQuery = ref("");
const tabContextMenu = reactive({ open: false, x: 0, y: 0 });

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

const { openTable, fetchPage, loadNextPage, toggleSort } = useTableSession(
  workspace,
  invokeWorkbench,
  { busy: conn.busy, statusText: conn.statusText },
);

const activeTab = computed(() => getActiveTab(workspace));
const filteredTables = computed(() =>
  filterSchemaTree(
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
    treeQuery.value,
  ),
);

const { gridWrapRef, virtualRange, onGridScroll, scrollRowIntoView, scrollCellIntoView, scrollInsertCellIntoView, visibleRows } =
  useVirtualGrid(activeTab, editState);

const editor = useGridEditor(
  editState,
  invokeWorkbench,
  activeTab,
  gridWrapRef,
  { scrollRowIntoView, scrollCellIntoView, scrollInsertCellIntoView },
  { busy: conn.busy, statusText: conn.statusText },
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
  useRowSelection(invokeWorkbench, { statusText: conn.statusText }, { fetchPage });

const { contextMenu, contextMenuStyle, openContextMenu, closeContextMenu, refreshFromContextMenu } =
  useContextMenu(
    { statusText: conn.statusText },
    { loadTables: conn.loadTables, ensureTableSchema: conn.ensureTableSchema, fetchPage },
    activeTab,
  );

const {
  importWizard,
  importInput,
  triggerImport,
  onImportFileSelected,
  parseImportSheet,
  goToImportStep,
  executeImport,
  closeImportWizard,
} = useImportWizard(invokeWorkbench, activeTab, { fetchPage }, { statusText: conn.statusText });

const { exportTable } = useExport(invokeWorkbench, { statusText: conn.statusText });

const { handleUndoKeydown } = useUndo(editState, invokeWorkbench, activeTab, {
  statusText: conn.statusText,
});

const {
  workspaceRef: paneWorkspaceRef,
  isDragging: paneIsDragging,
  sidebarCollapsed,
  inspectorCollapsed,
  sidebarStyle,
  inspectorStyle,
  onDividerMouseDown,
  toggleSidebar,
  toggleInspector,
} = usePaneResize();

const { effectiveTheme, isDark, toggleTheme } = useTheme();
const isStatusError = computed(() => /失败|错误|不能|冲突|重复/.test(statusText.value || ""));

// ── Local helpers ─────────────────────────────────────────────────────────
const totalPages = computed(() => {
  const tab = activeTab.value;
  if (!tab) return 1;
  return Math.max(1, Math.ceil(tab.totalRows / tab.pageSize));
});

function rowCountLabel(totalRows) {
  const count = Number(totalRows);
  return `${Number.isFinite(count) ? count.toLocaleString("zh-CN") : "0"} 行`;
}

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

function activateTab(tabId) {
  workspace.activeTabId = tabId;
  resetGridState();
}

function closeTab(tabId) {
  resetGridState();
  closeTableTab(workspace, tabId);
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
  closeAllTableTabs(workspace);
}

function closeAllContextMenus() {
  closeContextMenu();
  closeTabContextMenu();
}

function openTableFromSidebar(table) {
  resetGridState();
  openTable(table);
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
  openContextMenu(event, activeTab.value);
}

function selectGridCell(...args) {
  clearRowSelection(activeTab.value);
  selectCell(...args);
}

function startGridRangeSelection(...args) {
  clearRowSelection(activeTab.value);
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
} = useTableSearch(activeTab, {
  editState,
  loadNextPage,
  selectCellAt,
  statusText: conn.statusText,
});

function setSearchInputElement(element) {
  searchInputRef.value = element;
}

function handleWorkbenchKeydown(event) {
  if (handleTableFindKeydown(event)) return;
  handleUndoKeydown(event);
}

async function handleGridKeydownWithRows(event) {
  const tab = activeTab.value;
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
    await fetchPage(tab, tab.page || 1);
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
    await fetchPage(tab, tab.page || 1);
  }
  if (result?.failedRowId) return;
  const lastDraft = drafts[Math.max(0, result.insertedRows - 1)]?.draft;
  if (lastDraft && selectVisibleInsertedRow(tab, lastDraft)) return;
  gridWrapRef.value?.focus();
}

let autoSaveInsertPromise = null;

function maybeAutoSaveInsertDrafts(event) {
  const tab = activeTab.value;
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
  const tab = activeTab.value;
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

  // Find the saved active tab by tableName/database to match after IDs change.
  let activeTableName = null;
  if (snapshot.activeTabId) {
    const activeSaved = snapshot.tabs.find((t) => t.id === snapshot.activeTabId);
    if (activeSaved) activeTableName = activeSaved.tableName;
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
    await openTable(tableForOpen);
    // openTable sets the active tab to the newly opened one; apply saved filter/sort to it.
    const currentActiveTab = getActiveTab(workspace);
    if (currentActiveTab) {
      if (savedTab.filter) currentActiveTab.filter = savedTab.filter;
      if (savedTab.filterMode) currentActiveTab.filterMode = savedTab.filterMode;
      if (savedTab.sort) currentActiveTab.sort = savedTab.sort;
    }
  }

  // Restore the originally active tab by table name (tab IDs are regenerated on each session).
  if (activeTableName) {
    const targetTab = workspace.tabs.find((t) => t.tableName === activeTableName);
    if (targetTab) workspace.activeTabId = targetTab.id;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
onMounted(async () => {
  try {
    await conn.loadConnections();
    await restoreSavedTabs();
  } catch (e) {
    conn.statusText.value = `初始化失败：${String(e)}`;
  }
  persistenceReady = true;
  persistWorkspace();
});
</script>

<template>
  <main
    class="mysql-workbench"
    :data-theme="effectiveTheme"
    @pointerdown.capture="maybeAutoSaveInsertDrafts"
    @click="closeAllContextMenus"
    @keydown="handleWorkbenchKeydown"
    @contextmenu.prevent="openGeneralContextMenu"
  >
    <section class="wb-workspace" ref="paneWorkspaceRef" :class="{ 'is-dragging': paneIsDragging }">
      <WorkbenchSidebar
        :style="sidebarStyle"
        :selected-connection-id="selectedConnectionId"
        :selected-database="selectedDatabase"
        :connections="connections"
        :databases="databases"
        :filtered-tables="filteredTables"
        :tree-query="treeQuery"
        :active-tab="activeTab"
        @update:tree-query="treeQuery = $event"
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
          @tab-contextmenu="openTabContextMenu"
        />

        <DataGrid
          v-if="activeTab"
          ref="dataGridRef"
          :tab="activeTab"
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
          @export="exportTable(activeTab)"
          @import="triggerImport"
          @contextmenu="openActiveTableContextMenu"
        />

        <section v-else class="wb-empty">
          从左侧打开一张表，或使用快捷搜索定位。
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
        :active-tab="activeTab"
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
        <strong class="wb-sidebar-status-count">{{ rowCountLabel(activeTab.totalRows) }}</strong>
      </section>
      <section
        class="wb-operation-status"
        :class="{ 'is-error': isStatusError }"
        role="status"
        aria-live="polite"
        :title="statusText"
      >
        {{ statusText }}
      </section>
      <SelectedCellIdentity
        :tab="activeTab"
        :selected-cell="selectedCell"
        :selected-range="selectedRange"
      />
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
      @refresh="refreshFromContextMenu"
    />

    <menu
      v-if="tabContextMenu.open"
      class="wb-context-menu wb-tab-context-menu"
      :style="{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }"
      @click.stop
    >
      <button type="button" @click="closeAllTabsFromMenu">全部关闭</button>
    </menu>

    <ImportWizardDialog
      v-if="importWizard.open"
      :wizard="importWizard"
      :active-tab="activeTab"
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
