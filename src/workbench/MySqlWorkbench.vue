<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";

import {
  createWorkspaceState,
  filterSchemaTree,
  getActiveTab,
  closeTableTab,
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
} from "./utils/normalize.js";
import { highlightCell as _highlightCell } from "./utils/cellDisplay.js";

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
import { useVirtualGrid } from "./composables/useVirtualGrid.js";
import { useGridEditor } from "./composables/useGridEditor.js";
import { useRowSelection } from "./composables/useRowSelection.js";
import { useContextMenu } from "./composables/useContextMenu.js";
import { useImportWizard } from "./composables/useImportWizard.js";
import { useExport } from "./composables/useExport.js";
import { useUndo } from "./composables/useUndo.js";
import { usePaneResize } from "./composables/usePaneResize.js";

// ── Shared state ──────────────────────────────────────────────────────────
const workspace = reactive(createWorkspaceState());
const editState = reactive(createEditState());
const treeQuery = ref("");

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
  loadTables,
  ensureTableSchema,
  openConnDialog,
  cancelConnDialog,
  submitConnDialog,
} = conn;

const { openTable, fetchPage, toggleSort } = useTableSession(
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
  isSelectingRange,
  editingCell,
  editDraft,
  textDraft,
  insertDrafts,
  activeColumns,
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
  handleInsertKeydown,
  commitCellValue,
  saveTextPanel,
  commitInsertRow,
  handleGridKeydown,
  getInsertDraft,
  updateInsertDraft,
  clearInsertDraft,
} = editor;

const { clearRowSelection, toggleRowSelect, toggleAllRows, deleteSelectedRows, deleteRow } =
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

function openTableFromSidebar(table) {
  resetGridState();
  openTable(table);
}

function openSidebarContextMenu(event, table) {
  openContextMenu(event, table);
}

function openGeneralContextMenu(event) {
  openContextMenu(event);
}

function openActiveTableContextMenu(event) {
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
  clearSelection();
  toggleRowSelect(tab, row, event);
  gridWrapRef.value?.focus();
}

function toggleAllGridRows(tab) {
  clearSelection();
  toggleAllRows(tab);
  gridWrapRef.value?.focus();
}

function handleGridKeydownWithRows(event) {
  const tab = activeTab.value;
  if ((event.key === "Delete" || event.key === "Backspace") && tab?.selectedRowKeys?.size > 0) {
    event.preventDefault();
    deleteSelectedRows(tab);
    return;
  }
  handleGridKeydown(event);
}

async function commitInsertAndRefresh(tab) {
  const inserted = await commitInsertRow(tab);
  if (!inserted) return;
  await fetchPage(tab, tab.page || 1);
  const columnIndex = selectedInsertCell.value?.tabId === tab.id ? selectedInsertCell.value.columnIndex : 0;
  conn.statusText.value = "已插入 1 行";
  selectInsertCell(tab, columnIndex);
}

function filterPage(tab, page) {
  resetGridState();
  fetchPage(tab, page);
}

function sortPage(tab, col) {
  resetGridState();
  toggleSort(tab, col);
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
    @click="closeContextMenu"
    @keydown="handleUndoKeydown"
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
          :edit-state="editState"
          :busy="busy"
          :highlight-cell="highlightCell"
          :get-insert-draft="getInsertDraft"
          @grid-ready="setGridWrapElement"
          @scroll="onGridScroll"
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
          @toggle-all-rows="toggleAllGridRows"
          @insert-input="updateInsertDraft"
          @insert-commit="commitInsertAndRefresh"
          @insert-focus="selectInsertCell"
          @insert-keydown="handleInsertKeydown"
          @export="exportTable(activeTab)"
          @import="triggerImport"
          @filter-page="filterPage"
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
      <SelectedCellIdentity
        :tab="activeTab"
        :selected-cell="selectedCell"
        :selected-range="selectedRange"
      />
    </footer>

    <ContextMenu
      :open="contextMenu.open"
      :x="contextMenu.x"
      :y="contextMenu.y"
      @refresh="refreshFromContextMenu"
    />

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
