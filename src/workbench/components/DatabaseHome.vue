<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import {
  createDatabaseHomeController,
  databaseHomeRenameError,
  HOME_SORT_MODES,
} from "../composables/useDatabaseHome.js";
import { createHomepageSelectionDismissal } from "../homepageSelectionDismissal.js";
import DatabaseTableList from "./DatabaseTableList.vue";

const props = defineProps({
  tab: { type: Object, required: true },
  tables: { type: Array, default: () => [] },
  recentTableNames: { type: Array, default: () => [] },
  clipboard: { type: Object, default: null },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits([
  "open-table",
  "open-design",
  "copy-tables",
  "paste-tables",
  "rename-table",
  "delete-tables",
  "refresh",
  "batch-export",
  "batch-import",
  "visible-tables",
  "state-change",
]);

const clipboardRef = computed({
  get: () => props.clipboard,
  set: (value) => emit("copy-tables", value),
});
const tableSource = computed(() => props.tables);
const recentSource = computed(() => props.recentTableNames);

const controller = createDatabaseHomeController({
  connectionId: props.tab.connectionId,
  database: props.tab.database,
  tables: tableSource,
  recentTableNames: recentSource,
  readOnly: Boolean(props.tab.readOnly || props.tab.read_only),
  clipboard: clipboardRef,
  initialQuery: props.tab.query || "",
  initialSortMode: props.tab.sortMode || HOME_SORT_MODES.nameAsc,
});

const menu = reactive({
  open: false,
  x: 0,
  y: 0,
  tableName: "",
  blank: false,
});

const databaseName = computed(() => props.tab.database || "当前数据库");
const selectedCount = computed(() => controller.selectedNames.value.length);
const tableCount = computed(() => controller.tables.value.length);
const visibleCount = computed(() => controller.filteredTables.value.length);
const readOnly = computed(() => Boolean(props.tab.readOnly || props.tab.read_only));
const tableSourceContext = computed(() => ({
  connectionId: props.tab.connectionId,
  database: props.tab.database,
}));
const homeRootRef = ref(null);
const searchInputRef = ref(null);
const tableListRef = ref(null);
const selectionDismissal = createHomepageSelectionDismissal({
  getRoot: () => homeRootRef.value,
  clearSelection,
});

function syncTabState() {
  if (!props.tab) return;
  props.tab.query = controller.query.value;
  props.tab.sortMode = controller.sortMode.value;
  props.tab.selectedTableNames = [...controller.selectedNames.value];
  emit("state-change", {
    tabId: props.tab.id,
    query: props.tab.query,
    sortMode: props.tab.sortMode,
    selectedTableNames: props.tab.selectedTableNames,
  });
}

function setQuery(value) {
  controller.setQuery(value);
}

function focusSearch() {
  const input = searchInputRef.value;
  if (!input) return false;
  input.focus();
  input.select?.();
  return true;
}

function sortByColumn(column) {
  controller.sortByColumn(column);
}

function replaceSelection(names) {
  controller.setSelection(names);
}

watch(
  () => [controller.query.value, controller.sortMode.value, controller.selectedNames.value.join("\u001f"), props.tab.id, props.tab.error],
  syncTabState,
  { immediate: true },
);

watch(
  () => props.tab.id,
  () => {
    controller.setQuery(props.tab.query || "");
    controller.setSortMode(props.tab.sortMode || HOME_SORT_MODES.nameAsc);
    controller.selectedNames.value = Array.isArray(props.tab.selectedTableNames) ? [...props.tab.selectedTableNames] : [];
    controller.cancelRename();
  },
);

function closeMenu() {
  menu.open = false;
  menu.tableName = "";
  menu.blank = false;
}

function tableByName(name) {
  return controller.tables.value.find((table) => table.tableName === name) || null;
}

function tablePayload(name) {
  const table = tableByName(name);
  return {
    ...(table || {}),
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableName: name,
    tableComment: table?.tableComment || table?.table_comment || "",
    readOnly: readOnly.value,
  };
}

function selectTable(name, event) {
  controller.selectTable(name, event);
}

function clearSelection() {
  controller.clearSelection();
}

function openTable(name) {
  if (!name) return;
  emit("open-table", tablePayload(name));
}

function openDesign(name = controller.selectedNames.value[0]) {
  if (!controller.canWrite.value || !name) return;
  emit("open-design", tablePayload(name));
}

function copySelection() {
  const payload = controller.copySelection();
  closeMenu();
  return Boolean(payload);
}

function pasteTables() {
  if (!controller.canPaste.value) return false;
  emit("paste-tables", {
    target: {
      connectionId: props.tab.connectionId,
      database: props.tab.database,
    },
    payload: controller.clipboard.value,
  });
  closeMenu();
  return true;
}

function startRename(name = "") {
  if (!name && selectedCount.value !== 1) return;
  if (name && !controller.selectedSet.value.has(name)) controller.selectTable(name, {});
  controller.startRename(name);
  closeMenu();
}

function cancelRename() {
  controller.cancelRename();
}

function updateRenameDraft(value) {
  controller.updateRenameDraft(value);
}

function submitRename(oldName, nextName) {
  const result = controller.validateRenameDraft(oldName, nextName);
  if (!result.ok) {
    if (result.reason === "unchanged") {
      cancelRename();
      return;
    }
    const message = databaseHomeRenameError(result.reason, nextName);
    controller.failRename(message);
    return;
  }
  const renameAttempt = controller.beginRenameSubmit();
  emit("rename-table", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableName: oldName,
    newName: result.value,
    onSuccess: () => {
      controller.completeRename(renameAttempt);
    },
    onError: (error) => {
      const message = databaseHomeRenameError("request", result.value, error);
      controller.failRename(message, renameAttempt);
    },
  });
}

function refreshHome() {
  closeMenu();
  controller.resetForRefresh();
  tableListRef.value?.resetView?.();
  props.tab.error = "";
  props.tab.statusText = "";
  syncTabState();
  emit("refresh", props.tab);
}

function deleteSelection(name = "") {
  if (name && !controller.selectedSet.value.has(name)) controller.selectTable(name, {});
  if (!controller.canDelete.value) return;
  emit("delete-tables", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableNames: [...controller.selectedNames.value],
  });
  closeMenu();
}

function batchSource() {
  return {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
  };
}

function openBatchExport() {
  emit("batch-export", batchSource());
}

function openBatchImport() {
  if (readOnly.value) return;
  emit("batch-import", batchSource());
}

function openContextMenu(event, tableName) {
  if (tableName && !controller.selectedSet.value.has(tableName)) controller.selectTable(tableName, {});
  menu.open = true;
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.tableName = tableName || "";
  menu.blank = !tableName;
}

function onWindowPointerDown(event) {
  if (!event.target?.closest?.(".wb-dbhome-context-menu")) closeMenu();
}

watch(
  () => menu.open,
  (open) => {
    if (open) window.addEventListener("pointerdown", onWindowPointerDown, { capture: true });
    else window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true });
  },
);

onMounted(() => {
  document.addEventListener("click", selectionDismissal.handleDocumentClick, { capture: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true });
  document.removeEventListener("click", selectionDismissal.handleDocumentClick, { capture: true });
});

defineExpose({ copySelection, pasteTables, focusSearch });
</script>

<template>
  <section ref="homeRootRef" class="wb-database-home" :class="{ 'is-readonly': readOnly }" @keydown.esc="closeMenu">
    <header class="wb-dbhome-header">
      <div class="wb-dbhome-title">
        <span class="wb-dbhome-title-icon" aria-hidden="true"></span>
        <div>
          <h2>{{ databaseName }}</h2>
          <p>{{ visibleCount }} / {{ tableCount }} 张表</p>
        </div>
      </div>
      <div v-if="readOnly" class="wb-dbhome-summary" aria-label="首页状态">
        <span>只读</span>
      </div>
    </header>

    <div class="wb-dbhome-toolbar" aria-label="表对象工具栏">
      <label class="wb-dbhome-search">
        <span aria-hidden="true"></span>
        <input
          ref="searchInputRef"
          :value="controller.query.value"
          type="search"
          placeholder="搜索表名或备注"
          @input="setQuery($event.target.value)"
        />
      </label>
      <div class="wb-dbhome-actions" aria-label="表操作">
        <button type="button" :disabled="busy" @click="openBatchExport">批量导出</button>
        <button type="button" :disabled="busy || readOnly" @click="openBatchImport">批量导入</button>
      </div>
    </div>

    <DatabaseTableList
      ref="tableListRef"
      :tables="controller.filteredTables.value"
      :selected-names="controller.selectedNames.value"
      :renaming-name="controller.renamingName.value"
      :rename-draft="controller.renameDraft.value"
      :rename-error="controller.renameError.value"
      :rename-pending="controller.renamePending.value"
      :sort-state="controller.sortState.value"
      :read-only="readOnly"
      :busy="busy"
      @select-table="selectTable"
      @open-table="openTable"
      @open-design="openDesign"
      @start-rename="startRename"
      @rename-draft="updateRenameDraft"
      @submit-rename="submitRename"
      @cancel-rename="cancelRename"
      @contextmenu="openContextMenu"
      @blank-contextmenu="openContextMenu($event, '')"
      @blank-click="clearSelection"
      @copy="copySelection"
      @paste="pasteTables"
      @delete="deleteSelection"
      @sort-column="sortByColumn"
      @replace-selection="replaceSelection"
      @box-selection-complete="selectionDismissal.markBoxSelectionComplete"
      @visible-tables="emit('visible-tables', { ...tableSourceContext, tableNames: $event })"
    />

    <Teleport defer to=".mysql-workbench">
      <menu
        v-if="menu.open"
        class="wb-context-menu wb-dbhome-context-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        role="menu"
        aria-label="表首页菜单"
        @click.stop
      >
        <button v-if="!menu.blank" type="button" role="menuitem" @click="openTable(menu.tableName); closeMenu()">打开表</button>
        <button v-if="!menu.blank" type="button" role="menuitem" :disabled="readOnly" @click="openDesign(menu.tableName); closeMenu()">表设计</button>
        <button v-if="!menu.blank" type="button" role="menuitem" :disabled="!controller.canRename.value" @click="startRename(menu.tableName)">重命名</button>
        <button type="button" role="menuitem" :disabled="!controller.canCopy.value" @click="copySelection">复制</button>
        <button type="button" role="menuitem" :disabled="!controller.canPaste.value" @click="pasteTables">粘贴</button>
        <hr class="wb-context-separator" role="separator" />
        <button type="button" role="menuitem" @click="refreshHome">刷新</button>
        <button v-if="!menu.blank" type="button" role="menuitem" class="danger" :disabled="!controller.canDelete.value" @click="deleteSelection(menu.tableName)">删除表</button>
      </menu>
    </Teleport>
  </section>
</template>
