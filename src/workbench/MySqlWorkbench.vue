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
  columnName,
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
import { useDataSearch } from "./composables/useDataSearch.js";
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
  selectedDatabase,
  connDialog,
  busy,
  statusText,
  loadConnections,
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

const { dataSearchResults, dataSearchLoading, runDataSearch } =
  useDataSearch(invokeWorkbench, treeQuery, {
    statusText: conn.statusText,
  });

const activeTab = computed(() => getActiveTab(workspace));
const filteredTables = computed(() =>
  filterSchemaTree(
    workspace.schema.map((table) => ({
      tableName: normalizeTableName(table),
      tableComment: normalizeTableComment(table),
      columns: table.columns || [],
      raw: table,
    })),
    treeQuery.value,
  ),
);

const { gridWrapRef, virtualRange, onGridScroll, scrollRowIntoView, visibleRows } =
  useVirtualGrid(activeTab, editState);

const editor = useGridEditor(
  editState,
  invokeWorkbench,
  activeTab,
  gridWrapRef,
  { scrollRowIntoView },
  { busy: conn.busy, statusText: conn.statusText },
);
const {
  selectedCell,
  editingCell,
  editDraft,
  textDraft,
  insertDrafts,
  activeColumns,
  focusTextCell,
  selectCell,
  startEditing,
  finishEditing,
  cancelEditing,
  navigateCell,
  commitCellValue,
  saveTextPanel,
  commitInsertRow,
  setCellToNull,
  handleGridKeydown,
  getInsertDraft,
  updateInsertDraft,
  clearInsertDraft,
} = editor;

const { toggleRowSelect, toggleAllRows, deleteSelectedRows, deleteRow } =
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
    <header class="wb-toolbar">
      <span class="wb-status">{{ statusText }}</span>
    </header>

    <section class="wb-workspace" ref="paneWorkspaceRef" :class="{ 'is-dragging': paneIsDragging }">
      <WorkbenchSidebar
        :style="sidebarStyle"
        :selected-database="selectedDatabase"
        :connections="connections"
        :databases="databases"
        :filtered-tables="filteredTables"
        :data-search-results="dataSearchResults"
        :tree-query="treeQuery"
        @update:tree-query="treeQuery = $event"
        @select-database="selectDatabase($event)"
        @open-table="openTable($event)"
        @open-connection="openConnDialog"
        @contextmenu="openContextMenu($event, $arguments[1])"
        @data-search="runDataSearch"
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
          @activate-tab="workspace.activeTabId = $event; selectedCell = null; textDraft = ''"
          @close-tab="selectedCell = null; textDraft = ''; closeTableTab(workspace, $event)"
        />

        <DataGrid
          v-if="activeTab"
          ref="dataGridRef"
          :tab="activeTab"
          :active-columns="activeColumns"
          :visible-rows="visibleRows"
          :virtual-range="virtualRange"
          :selected-cell="selectedCell"
          :editing-cell="editingCell"
          :edit-draft="editDraft"
          :edit-state="editState"
          :busy="busy"
          :highlight-cell="highlightCell"
          :get-insert-draft="getInsertDraft"
          @scroll="onGridScroll"
          @keydown="handleGridKeydown"
          @cell-click="startEditing"
          @cell-blur="finishEditing"
          @edit-input="editDraft = $event; textDraft = $event"
          @finish-edit="finishEditing(); navigateCell(1, 0)"
          @cancel-edit="cancelEditing"
          @tab-edit="finishEditing(); navigateCell(0, $event ? -1 : 1)"
          @toggle-sort="(tab, col) => toggleSort(tab, col)"
          @toggle-row-select="toggleRowSelect"
          @toggle-all-rows="toggleAllRows"
          @insert-input="updateInsertDraft"
          @insert-commit="commitInsertRow"
          @insert-focus="selectedCell = null; editingCell = null"
          @delete-selected="deleteSelectedRows"
          @export="exportTable(activeTab)"
          @import="triggerImport"
          @filter-page="fetchPage"
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
