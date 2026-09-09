<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  ClipboardPaste,
  Copy,
  FolderOpen,
  Pencil,
  RefreshCw,
  Send,
  TableProperties,
  Trash2,
} from "lucide-vue-next";

import {
  createDatabaseHomeController,
  databaseHomeRenameError,
  HOME_SORT_MODES,
} from "../composables/useDatabaseHome.js";
import { useAliases } from "../composables/aliasStore.js";
import { databaseTextColorCss, useDatabaseDecorations } from "../composables/databaseDecorationStore.js";
import { createHomepageTypeahead } from "../composables/useHomepageTypeahead.js";
import { useTableFavoriteStore } from "../composables/tableFavoriteStore.js";
import { createHomepageSelectionDismissal } from "../homepageSelectionDismissal.js";
import { highlightSearchRanges } from "../utils/searchMatch.js";
import { connectionHasCapability } from "../utils/connectionKinds.js";
import DatabaseTableList from "./DatabaseTableList.vue";
import { databaseDecorationIconComponent } from "./databaseDecorationIcons.js";
import ToolbarActionIcon from "./ToolbarActionIcon.vue";
import ToolbarSplitButton from "./ToolbarSplitButton.vue";

const props = defineProps({
  tab: { type: Object, required: true },
  tables: { type: Array, default: () => [] },
  recentTableNames: { type: Array, default: () => [] },
  clipboard: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  canClosePane: { type: Boolean, default: false },
  engineKind: { type: String, default: "" },
});

const emit = defineEmits([
  "open-table",
  "open-design",
  "copy-tables",
  "paste-tables",
  "rename-table",
  "delete-tables",
  "send-tables",
  "refresh",
  "batch-export",
  "batch-import",
  "visible-tables",
  "state-change",
  "focus-table",
  "split-pane",
  "close-pane",
  "open-sql-library",
]);

const clipboardRef = computed({
  get: () => props.clipboard,
  set: (value) => emit("copy-tables", value),
});
const homeLoading = computed(() => props.tab.loading === true);
const tableSource = computed(() => homeLoading.value ? [] : props.tables);
const recentSource = computed(() => props.recentTableNames);
const tableFavoriteStore = useTableFavoriteStore();
const favoriteTableNames = computed(() =>
  tableFavoriteStore.favoriteNames(props.tab.connectionId, props.tab.database),
);
const { databaseLabel, getDatabaseAlias } = useAliases();
const { getDatabaseDecoration } = useDatabaseDecorations();
const engineKind = computed(() => props.engineKind || props.tab.engineKind || "mysql");
const homeReadOnly = Boolean(props.tab.readOnly || props.tab.read_only);

const controller = createDatabaseHomeController({
  connectionId: props.tab.connectionId,
  database: props.tab.database,
  tables: tableSource,
  recentTableNames: recentSource,
  favoriteTableNames,
  readOnly: homeReadOnly,
  allowRenameDrop: !homeReadOnly && connectionHasCapability(engineKind.value, "renameDrop"),
  allowTableCopy: !homeReadOnly && connectionHasCapability(engineKind.value, "tableCopy"),
  clipboard: clipboardRef,
  initialQuery: props.tab.query || "",
  initialSortMode: props.tab.sortMode || HOME_SORT_MODES.nameAsc,
});

const menu = reactive({
  open: false,
  x: 0,
  y: 0,
  tableName: "",
  selectedNames: [],
  blank: false,
});
controller.setSelection(Array.isArray(props.tab.selectedTableNames) ? props.tab.selectedTableNames : []);
controller.focusedName.value = props.tab.focusedTableName || props.tab.selectedTableNames?.at?.(-1) || "";

const databaseRealName = computed(() => props.tab.database || "当前数据库");
const databaseName = computed(() => (
  databaseLabel(props.tab.connectionId, props.tab.database) || databaseRealName.value
));
const databaseTitle = computed(() => {
  const alias = getDatabaseAlias(props.tab.connectionId, props.tab.database);
  return alias ? `${alias}（${databaseRealName.value}）` : databaseRealName.value;
});
const databaseDecoration = computed(() => (
  getDatabaseDecoration(props.tab.connectionId, props.tab.database)
));
const databaseHomeIcon = computed(() => databaseDecorationIconComponent(databaseDecoration.value?.icon));
const databaseHomeDecorationStyle = computed(() => {
  const decoration = databaseDecoration.value;
  const textColor = databaseTextColorCss(decoration?.textColor);
  return {
    ...(decoration?.color ? { "--wb-dbhome-icon-color": decoration.color } : {}),
    ...(textColor ? { "--wb-dbhome-name-color": textColor } : {}),
  };
});
const selectedCount = computed(() => controller.selectedNames.value.length);
const deleteMenuLabel = computed(() => menu.selectedNames.length > 1 ? `删除 ${menu.selectedNames.length} 张表` : "删除表");
const tableCount = computed(() => controller.tables.value.length);
const visibleCount = computed(() => controller.filteredTables.value.length);
const readOnly = computed(() => Boolean(props.tab.readOnly || props.tab.read_only));
const canTableDesign = computed(() => !readOnly.value && connectionHasCapability(engineKind.value, "tableDesign"));
const canTableCopy = computed(() => !readOnly.value && connectionHasCapability(engineKind.value, "tableCopy"));
const canImport = computed(() => !readOnly.value && connectionHasCapability(engineKind.value, "import"));
const canRenameDrop = computed(() => !readOnly.value && connectionHasCapability(engineKind.value, "renameDrop"));
const canSqlConsole = computed(() => connectionHasCapability(engineKind.value, "sqlConsole"));
const tableSourceContext = computed(() => ({
  connectionId: props.tab.connectionId,
  database: props.tab.database,
}));
const homeRootRef = ref(null);
const searchInputRef = ref(null);
const searchNavigationName = ref("");
const tableListRef = ref(null);
const contextMenuRef = ref(null);
const splitMenuOpen = ref(false);
const compactActionMenuOpen = ref(false);
const splitItems = Object.freeze([
  { id: "right", label: "左右分屏", hint: "在右侧打开独立首页", icon: "split-right" },
  { id: "down", label: "上下分屏", hint: "在下方打开独立首页", icon: "split-down" },
]);
const compactActionItems = computed(() => ([
  {
    id: "batch-export",
    label: "批量导出",
    hint: "导出当前数据库中的多张表",
    icon: "export",
    disabled: props.busy,
  },
  {
    id: "batch-import",
    label: "批量导入",
    hint: "向当前数据库导入多张表",
    icon: "import",
    disabled: props.busy || !canImport.value,
  },
  ...splitItems.map((item, index) => ({
    ...item,
    separatorBefore: index === 0,
  })),
]));
const typeahead = createHomepageTypeahead({
  tables: computed(() => controller.filteredTables.value),
  onMatch: (table) => {
    const name = table?.tableName || "";
    if (!name) return;
    controller.selectTable(name, {});
    nextTick(() => tableListRef.value?.scrollTableIntoView?.(name));
  },
  onOpen: (table) => openTable(table?.tableName || ""),
});
const typeaheadResultLabel = computed(() => {
  const query = typeahead.query.value.trim().toLocaleLowerCase();
  const name = typeahead.matchedTableName.value;
  if (!name) return "未找到匹配表";
  return name.toLocaleLowerCase() === query ? "" : name;
});
const typeaheadResultHtml = computed(() =>
  highlightSearchRanges(typeaheadResultLabel.value, typeahead.matchRanges.value),
);
const selectionDismissal = createHomepageSelectionDismissal({
  getRoot: () => homeRootRef.value,
  getProtectedRoots: () => [contextMenuRef.value],
  clearSelection,
});

function syncTabState() {
  if (!props.tab) return;
  props.tab.query = controller.query.value;
  props.tab.sortMode = controller.sortMode.value;
  props.tab.selectedTableNames = [...controller.selectedNames.value];
  props.tab.focusedTableName = controller.focusedName.value || "";
  emit("state-change", {
    tabId: props.tab.id,
    query: props.tab.query,
    sortMode: props.tab.sortMode,
    selectedTableNames: props.tab.selectedTableNames,
    focusedTableName: props.tab.focusedTableName,
  });
}

function setQuery(value) {
  controller.setQuery(value);
  searchNavigationName.value = "";
}

function clearSearchQuery() {
  controller.setQuery("");
  searchNavigationName.value = "";
  nextTick(() => searchInputRef.value?.focus());
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

function toggleTableFavorite(name) {
  const favorite = tableFavoriteStore.toggleFavorite(props.tab.connectionId, props.tab.database, name);
  if (!favorite) return;
  nextTick(() => tableListRef.value?.scrollTableIntoView?.(name, { block: "nearest" }));
}

watch(
  () => [controller.query.value, controller.sortMode.value, controller.selectedNames.value.join("\u001f"), controller.focusedName.value, props.tab.id, props.tab.error],
  syncTabState,
  { immediate: true },
);

watch(
  () => props.tab.id,
  () => {
    controller.setQuery(props.tab.query || "");
    controller.setSortMode(props.tab.sortMode || HOME_SORT_MODES.nameAsc);
    controller.selectedNames.value = Array.isArray(props.tab.selectedTableNames) ? [...props.tab.selectedTableNames] : [];
    controller.focusedName.value = props.tab.focusedTableName || controller.selectedNames.value.at(-1) || "";
    searchNavigationName.value = "";
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
  if (name) emit("focus-table", tablePayload(name));
}

function clearSelection() {
  controller.clearSelection();
}

function isHomeTableNavigationTarget(target) {
  const root = homeRootRef.value;
  if (!root || !target) return false;
  if (target === searchInputRef.value) return true;
  if (target === root) return true;
  if (target.closest?.('.wb-tab[data-kind="home"].active')) return true;
  const surface = target.closest?.(".wb-dbhome-table-surface");
  return Boolean(surface && root.contains(surface) && !target.closest?.(".wb-dbhome-table-header"));
}

function handleHomeArrowKeydown(event) {
  const key = String(event.key || "");
  if (!isHomeTableNavigationTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (key !== "ArrowUp" && key !== "ArrowDown") return false;

  event.preventDefault();
  typeahead.dismiss();
  const delta = key === "ArrowDown" ? 1 : -1;
  const name = event.target === searchInputRef.value
    ? moveSearchSelection(delta, event)
    : controller.moveSelection(delta, event);
  if (!name) return;
  emit("focus-table", tablePayload(name));
  nextTick(() => tableListRef.value?.scrollTableIntoView?.(name, { block: "nearest" }));
  return true;
}

function moveSearchSelection(delta, event = {}) {
  const tables = controller.filteredTables.value;
  if (!tables.length) return "";
  const currentIndex = tables.findIndex((table) => table.tableName === searchNavigationName.value);
  const nextIndex = currentIndex < 0
    ? (delta > 0 ? 0 : tables.length - 1)
    : Math.max(0, Math.min(tables.length - 1, currentIndex + delta));
  const name = tables[nextIndex]?.tableName || "";
  if (!name) return "";
  controller.selectTable(name, { shiftKey: Boolean(event.shiftKey) });
  searchNavigationName.value = name;
  return name;
}

function openSearchResult() {
  const tables = controller.filteredTables.value;
  if (!tables.length) return false;
  const navigatedTable = tables.find((table) => table.tableName === searchNavigationName.value);
  const name = navigatedTable?.tableName || tables[0]?.tableName || "";
  if (!name) return false;
  controller.selectTable(name, {});
  searchNavigationName.value = name;
  emit("focus-table", tablePayload(name));
  openTable(name);
  return true;
}

function handleSearchKeydown(event) {
  if (handleHomeArrowKeydown(event)) {
    event.stopPropagation?.();
    return;
  }
  if (String(event.key || "") !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  event.stopPropagation?.();
  typeahead.dismiss();
  openSearchResult();
}

function handleHomeEnterKeydown(event) {
  const root = homeRootRef.value;
  const target = event.target;
  const isHomeEntryTarget = target === root || target?.closest?.('.wb-tab[data-kind="home"].active');
  if (!isHomeEntryTarget || String(event.key || "") !== "Enter") return false;
  if (event.ctrlKey || event.metaKey || event.altKey || !controller.selectedNames.value.length) return false;

  event.preventDefault();
  controller.selectedNames.value.forEach((name) => openTable(name));
  return true;
}

function handleHomeKeydown(event) {
  if (isEditableTypeaheadTarget(event.target)) return;
  const key = String(event.key || "");
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "a") {
    event.preventDefault();
    controller.selectAllFiltered();
    const focusedName = controller.focusedName.value || controller.selectedNames.value.at(-1) || "";
    if (focusedName) emit("focus-table", tablePayload(focusedName));
    return;
  }
  if (handleHomeArrowKeydown(event)) return;
  handleHomeEnterKeydown(event);
}

function splitHome(direction) {
  splitMenuOpen.value = false;
  compactActionMenuOpen.value = false;
  emit("split-pane", direction);
}

function toggleSplitMenu() {
  compactActionMenuOpen.value = false;
  splitMenuOpen.value = !splitMenuOpen.value;
}

function toggleCompactActionMenu() {
  splitMenuOpen.value = false;
  compactActionMenuOpen.value = !compactActionMenuOpen.value;
}

function handleCompactAction(actionId) {
  compactActionMenuOpen.value = false;
  if (actionId === "batch-export") openBatchExport();
  else if (actionId === "batch-import") openBatchImport();
  else if (actionId === "right" || actionId === "down") splitHome(actionId);
}

function openTable(name) {
  if (!name) return;
  emit("open-table", tablePayload(name));
}

function openDesign(name = controller.selectedNames.value[0]) {
  if (!canTableDesign.value || !name) return;
  const selected = controller.selectedNames.value;
  // When the right-clicked table is part of a multi-selection, open the
  // design for every selected table instead of just the clicked one.
  if (selected.length > 1 && selected.includes(name)) {
    emit("open-design", selected.map((tableName) => tablePayload(tableName)));
    return;
  }
  emit("open-design", tablePayload(name));
}

function copySelection() {
  const payload = controller.copySelection();
  closeMenu();
  return Boolean(payload);
}

function completeTablePaste(createdNames = []) {
  const pastedNames = Array.isArray(createdNames) ? createdNames.filter(Boolean) : [];
  typeahead.dismiss();
  controller.resetForMutationRefresh();
  controller.setSelection(pastedNames);
  searchNavigationName.value = controller.filteredTables.value.some((table) => table.tableName === pastedNames[0])
    ? pastedNames[0]
    : "";
  tableListRef.value?.resetView?.();
  props.tab.error = "";
  props.tab.statusText = "";
  syncTabState();
  if (pastedNames[0]) {
    nextTick(() => tableListRef.value?.scrollTableIntoView?.(pastedNames[0]));
  }
}

function pasteTables() {
  if (!controller.canPaste.value) return false;
  emit("paste-tables", {
    target: {
      connectionId: props.tab.connectionId,
      database: props.tab.database,
    },
    payload: controller.clipboard.value,
    onSuccess: completeTablePaste,
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
      tableFavoriteStore.renameFavorite(props.tab.connectionId, props.tab.database, oldName, result.value);
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
  typeahead.dismiss();
  controller.resetForRefresh();
  tableListRef.value?.resetView?.();
  props.tab.error = "";
  props.tab.statusText = "";
  syncTabState();
  emit("refresh", props.tab);
}

function sendSelection() {
  if (!canTableCopy.value || !menu.selectedNames.length) return;
  emit("send-tables", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableNames: [...menu.selectedNames],
  });
  closeMenu();
}

function deleteSelection(name = "", selectedNames = null) {
  if (!Array.isArray(selectedNames) && name && !controller.selectedSet.value.has(name)) controller.selectTable(name, {});
  const tableNames = Array.isArray(selectedNames)
    ? [...selectedNames]
    : [...controller.selectedNames.value];
  if (!controller.canDelete.value || !tableNames.length) return;
  emit("delete-tables", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableNames,
  });
  closeMenu();
}

function batchSource() {
  const selectedTableNames = [...controller.selectedNames.value];
  return {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    ...(selectedTableNames.length ? { selectedTableNames } : {}),
  };
}

function openBatchExport() {
  emit("batch-export", batchSource());
}

function openBatchImport() {
  if (!canImport.value) return;
  emit("batch-import", batchSource());
}

function openContextMenu(event, tableName) {
  if (tableName && !controller.selectedSet.value.has(tableName)) controller.selectTable(tableName, {});
  menu.open = true;
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.tableName = tableName || "";
  menu.selectedNames = [...controller.selectedNames.value];
  menu.blank = !tableName;
}

function onWindowPointerDown(event) {
  if (!event.target?.closest?.(".wb-dbhome-context-menu")) closeMenu();
}

function isEditableTypeaheadTarget(target) {
  return Boolean(target?.isContentEditable || target?.closest?.("input, textarea, select"));
}

function handleHomeSurfaceClick(event) {
  const target = event.target;
  if (!target || target.closest?.(".wb-dbhome-search, button, a, [role='menuitem']")) return;
  if (isEditableTypeaheadTarget(target)) return;
  homeRootRef.value?.focus?.({ preventScroll: true });
}

function handleDocumentPointerDown(event) {
  const input = searchInputRef.value;
  if (!input || document.activeElement !== input) return;
  if (event.target?.closest?.(".wb-dbhome-search")) return;
  const end = input.value.length;
  input.setSelectionRange?.(end, end);
  input.blur();
}

function isTypeaheadEventInCurrentPane(event) {
  const root = homeRootRef.value;
  const target = event.target;
  if (!root || !target) return false;
  if (root.contains(target)) return true;
  const pane = root.closest(".wb-workbench-pane");
  return Boolean(pane?.contains(target));
}

function handleTypeaheadKeydown(event) {
  if (!props.active || isEditableTypeaheadTarget(event.target)) return;
  if (!isTypeaheadEventInCurrentPane(event)) return;
  if (handleHomeArrowKeydown(event)) {
    event.stopPropagation?.();
    return;
  }
  if (typeahead.handleKeydown(event)) {
    event.stopPropagation?.();
    return;
  }
  if (handleHomeEnterKeydown(event)) event.stopPropagation?.();
}

watch(
  () => menu.open,
  (open) => {
    if (open) window.addEventListener("pointerdown", onWindowPointerDown, { capture: true });
    else window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true });
  },
);

watch(
  () => props.active,
  (active) => {
    if (!active) {
      typeahead.dismiss();
      splitMenuOpen.value = false;
      compactActionMenuOpen.value = false;
    }
  },
);

onMounted(() => {
  document.addEventListener("click", selectionDismissal.handleDocumentClick, { capture: true });
  document.addEventListener("pointerdown", handleDocumentPointerDown, { capture: true });
  document.addEventListener("keydown", handleTypeaheadKeydown, { capture: true });
});

onBeforeUnmount(() => {
  typeahead.dismiss();
  window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true });
  document.removeEventListener("click", selectionDismissal.handleDocumentClick, { capture: true });
  document.removeEventListener("pointerdown", handleDocumentPointerDown, { capture: true });
  document.removeEventListener("keydown", handleTypeaheadKeydown, { capture: true });
});

defineExpose({ copySelection, pasteTables, focusSearch });
</script>

<template>
  <section
    ref="homeRootRef"
    class="wb-database-home"
    :class="{ 'is-readonly': readOnly }"
    :style="databaseHomeDecorationStyle"
    tabindex="-1"
    @click.capture="handleHomeSurfaceClick"
    @keydown.esc="closeMenu"
    @keydown="handleHomeKeydown"
  >
    <header class="wb-dbhome-header">
      <div class="wb-dbhome-title">
        <component :is="databaseHomeIcon" :size="18" class="wb-dbhome-title-icon" aria-hidden="true" />
        <div>
          <h2 :title="databaseTitle">{{ databaseName }}</h2>
          <p v-if="homeLoading">正在读取表列表…</p>
          <p v-else>{{ visibleCount }} / {{ tableCount }} 张表</p>
        </div>
      </div>
      <div v-if="readOnly" class="wb-dbhome-summary" aria-label="首页状态">
        <span>只读</span>
      </div>
    </header>

    <div class="wb-dbhome-toolbar" aria-label="表对象工具栏">
      <div class="wb-dbhome-search">
        <span aria-hidden="true"></span>
        <input
          ref="searchInputRef"
          :value="controller.query.value"
          type="search"
          aria-label="搜索表名或备注"
          placeholder="搜索表名或备注"
          @input="setQuery($event.target.value)"
          @keydown="handleSearchKeydown"
        />
        <button
          v-if="controller.query.value"
          type="button"
          class="wb-dbhome-search-clear"
          aria-label="清除搜索"
          @mousedown.prevent
          @click.stop="clearSearchQuery"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div class="wb-dbhome-actions" aria-label="表操作">
        <div class="wb-toolbar-action-group wb-dbhome-action-group" aria-label="SQL、批量与分屏操作">
          <button
            type="button"
            class="wb-toolbar-action-button wb-dbhome-action-button wb-dbhome-sql-entry"
            aria-label="SQL"
            :disabled="!canSqlConsole"
            @click="emit('open-sql-library')"
          >
            <ToolbarActionIcon name="sql" />
            <span class="wb-toolbar-action-label">SQL</span>
          </button>
          <button
            type="button"
            class="wb-toolbar-action-button wb-dbhome-action-button"
            aria-label="批量导出"
            :disabled="busy"
            @click="openBatchExport"
          >
            <ToolbarActionIcon name="export" />
            <span class="wb-toolbar-action-label">批量导出</span>
          </button>
          <button
            type="button"
            class="wb-toolbar-action-button wb-dbhome-action-button"
            aria-label="批量导入"
            :disabled="busy || !canImport"
            @click="openBatchImport"
          >
            <ToolbarActionIcon name="import" />
            <span class="wb-toolbar-action-label">批量导入</span>
          </button>
          <ToolbarSplitButton
            label="分屏"
            icon="split-right"
            menu-label="首页分屏方式"
            :open="splitMenuOpen"
            :items="splitItems"
            @primary="splitHome('right')"
            @toggle="toggleSplitMenu"
            @close="splitMenuOpen = false"
            @select="splitHome"
          />
        </div>
        <ToolbarSplitButton
          class="wb-toolbar-compact-overflow wb-dbhome-overflow"
          label="更多"
          icon="more"
          menu-label="首页操作"
          primary-opens-menu
          single-trigger
          :open="compactActionMenuOpen"
          :items="compactActionItems"
          @toggle="toggleCompactActionMenu"
          @close="compactActionMenuOpen = false"
          @select="handleCompactAction"
        />
        <button
          v-if="canClosePane"
          type="button"
          class="wb-dbhome-close-pane"
          title="关闭当前分屏，保留其它分屏"
          @click="emit('close-pane')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
            <path d="M8 3v10M9.8 5.2l2.2 2.2m0-2.2L9.8 7.4" />
          </svg>
          <span>关闭分屏</span>
        </button>
      </div>
    </div>

    <DatabaseTableList
      ref="tableListRef"
      :tables="controller.filteredTables.value"
      :loading="homeLoading"
      :search-query="controller.query.value"
      :typeahead-query="typeahead.query.value"
      :selected-names="controller.selectedNames.value"
      :favorite-names="favoriteTableNames"
      :database-decoration="databaseDecoration"
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
      @toggle-favorite="toggleTableFavorite"
      @box-selection-complete="selectionDismissal.markBoxSelectionComplete"
      @visible-tables="emit('visible-tables', { ...tableSourceContext, tableNames: $event })"
    />

    <div
      v-if="typeahead.active.value"
      class="wb-dbhome-typeahead"
      :class="{ 'is-empty': !typeahead.match.value }"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span class="wb-dbhome-typeahead-query">{{ typeahead.query.value }}</span>
      <span
        v-if="typeaheadResultLabel"
        class="wb-dbhome-typeahead-result"
        v-html="typeaheadResultHtml"
      ></span>
    </div>

    <Teleport defer to=".mysql-workbench">
      <menu
        v-if="menu.open"
        ref="contextMenuRef"
        class="wb-context-menu wb-dbhome-context-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        role="menu"
        aria-label="表首页菜单"
        @click.stop
      >
        <button v-if="!menu.blank" type="button" role="menuitem" @click="openTable(menu.tableName); closeMenu()"><FolderOpen :size="14" class="wb-context-icon" aria-hidden="true" />打开表</button>
        <button v-if="!menu.blank" type="button" role="menuitem" :disabled="!canTableDesign" @click="openDesign(menu.tableName); closeMenu()"><TableProperties :size="14" class="wb-context-icon" aria-hidden="true" />表设计</button>
        <button v-if="!menu.blank" type="button" role="menuitem" :disabled="!controller.canRename.value" @click="startRename(menu.tableName)"><Pencil :size="14" class="wb-context-icon" aria-hidden="true" />重命名</button>
        <button v-if="!menu.blank" type="button" role="menuitem" :disabled="!canTableCopy || !menu.selectedNames.length" @click="sendSelection"><Send :size="14" class="wb-context-icon" aria-hidden="true" />发送到…</button>
        <button type="button" role="menuitem" :disabled="!controller.canCopy.value" @click="copySelection"><Copy :size="14" class="wb-context-icon" aria-hidden="true" />复制</button>
        <button type="button" role="menuitem" :disabled="!controller.canPaste.value" @click="pasteTables"><ClipboardPaste :size="14" class="wb-context-icon" aria-hidden="true" />粘贴</button>
        <hr class="wb-context-separator" role="separator" />
        <button type="button" role="menuitem" @click="refreshHome"><RefreshCw :size="14" class="wb-context-icon" aria-hidden="true" />刷新</button>
        <button v-if="!menu.blank" type="button" role="menuitem" class="danger" :disabled="busy || !canRenameDrop || !menu.selectedNames.length" @click="deleteSelection(menu.tableName, menu.selectedNames)"><Trash2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ deleteMenuLabel }}</button>
      </menu>
    </Teleport>
  </section>
</template>
