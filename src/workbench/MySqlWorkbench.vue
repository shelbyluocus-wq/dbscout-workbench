<script setup>
import { computed, onMounted, reactive, ref } from "vue";

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
  setCellToNull,
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

// ── Lifecycle ─────────────────────────────────────────────────────────────
onMounted(() => {
  conn.loadConnections().catch((e) => {
    conn.statusText.value = `初始化失败：${String(e)}`;
  });
});
</script>

<template>
  <main class="mysql-workbench" @click="closeContextMenu" @keydown="handleUndoKeydown">
    <section class="wb-workspace" ref="paneWorkspaceRef" :class="{ 'is-dragging': paneIsDragging }">
      <WorkbenchSidebar
        :style="sidebarStyle"
        :selected-connection-id="selectedConnectionId"
        :selected-database="selectedDatabase"
        :connections="connections"
        :databases="databases"
        :filtered-tables="filteredTables"
        :tree-query="treeQuery"
        @update:tree-query="treeQuery = $event"
        @select-connection="selectConnection($event)"
        @select-database="selectDatabase($event)"
        @open-table="openTableFromSidebar"
        @open-connection="openConnDialog"
        @contextmenu="openContextMenu($event, $arguments[1])"
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
      />
    </section>

    <ContextMenu
      :open="contextMenu.open"
      :x="contextMenu.x"
      :y="contextMenu.y"
      @refresh="refreshFromContextMenu"
      @set-null="setCellToNull(); closeContextMenu()"
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
