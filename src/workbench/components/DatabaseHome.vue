<script setup>
import { computed, onBeforeUnmount, reactive, watch } from "vue";

import { createDatabaseHomeController, HOME_SORT_MODES } from "../composables/useDatabaseHome.js";
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
  "state-change",
]);

const clipboardRef = computed({
  get: () => props.clipboard,
  set: (value) => emit("copy-tables", value),
});

const controller = createDatabaseHomeController({
  connectionId: props.tab.connectionId,
  database: props.tab.database,
  tables: props.tables,
  recentTableNames: props.recentTableNames,
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

const sortOptions = [
  { value: HOME_SORT_MODES.nameAsc, label: "名称升序" },
  { value: HOME_SORT_MODES.nameDesc, label: "名称降序" },
  { value: HOME_SORT_MODES.commentFirst, label: "备注优先" },
  { value: HOME_SORT_MODES.recent, label: "最近打开" },
  { value: HOME_SORT_MODES.original, label: "原始顺序" },
];

const databaseName = computed(() => props.tab.database || "当前数据库");
const selectedCount = computed(() => controller.selectedNames.value.length);
const tableCount = computed(() => controller.tables.value.length);
const visibleCount = computed(() => controller.filteredTables.value.length);
const readOnly = computed(() => Boolean(props.tab.readOnly || props.tab.read_only));
const statusText = computed(() => {
  if (props.tab.error) return props.tab.error;
  if (readOnly.value) return "只读连接：可浏览和打开表，管理操作已停用";
  if (props.tab.statusText) return props.tab.statusText;
  if (selectedCount.value > 0) return `已选 ${selectedCount.value} 张表`;
  if (controller.query.value.trim()) return `筛选出 ${visibleCount.value}/${tableCount.value} 张表`;
  return `共 ${tableCount.value} 张表`;
});

function syncTabState() {
  if (!props.tab) return;
  props.tab.query = controller.query.value;
  props.tab.sortMode = controller.sortMode.value;
  props.tab.selectedTableNames = [...controller.selectedNames.value];
  props.tab.statusText = statusText.value;
  emit("state-change", {
    tabId: props.tab.id,
    query: props.tab.query,
    sortMode: props.tab.sortMode,
    selectedTableNames: props.tab.selectedTableNames,
  });
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
  controller.cancelRename();
}

function openSelectedTables() {
  controller.selectedNames.value.forEach((name) => emit("open-table", tablePayload(name)));
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
  if (payload) emit("copy-tables", payload);
  closeMenu();
}

function pasteTables() {
  if (!controller.canPaste.value) return;
  emit("paste-tables", {
    target: {
      connectionId: props.tab.connectionId,
      database: props.tab.database,
    },
    payload: controller.clipboard.value,
  });
  closeMenu();
}

function startRename(name = "") {
  if (!name && selectedCount.value !== 1) return;
  if (name && !controller.selectedSet.value.has(name)) controller.selectTable(name, {});
  controller.startRename(name);
  closeMenu();
}

function submitRename(oldName, nextName) {
  const result = controller.validateRenameDraft(oldName, nextName);
  if (!result.ok) {
    props.tab.statusText = result.reason === "duplicate"
      ? "表名已存在"
      : result.reason === "invalid"
        ? "表名不能包含 /、\\ 或空字符"
        : "请输入新的表名";
    return;
  }
  emit("rename-table", {
    connectionId: props.tab.connectionId,
    database: props.tab.database,
    tableName: oldName,
    newName: result.value,
  });
  controller.cancelRename();
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

onBeforeUnmount(() => window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true }));
</script>

<template>
  <section class="wb-database-home" :class="{ 'is-readonly': readOnly }" @keydown.esc="closeMenu">
    <header class="wb-dbhome-header">
      <div class="wb-dbhome-title">
        <span class="wb-dbhome-title-icon" aria-hidden="true"></span>
        <div>
          <h2>{{ databaseName }}</h2>
          <p>{{ visibleCount }} / {{ tableCount }} 张表</p>
        </div>
      </div>
      <div class="wb-dbhome-summary" aria-label="首页状态">
        <span v-if="selectedCount">{{ selectedCount }} 已选</span>
        <span v-if="readOnly">只读</span>
      </div>
    </header>

    <div class="wb-dbhome-toolbar" aria-label="表对象工具栏">
      <label class="wb-dbhome-search">
        <span aria-hidden="true"></span>
        <input
          :value="controller.query.value"
          type="search"
          placeholder="搜索表名或备注"
          @input="controller.setQuery($event.target.value)"
        />
      </label>
      <label class="wb-dbhome-sort">
        <span>排序</span>
        <select :value="controller.sortMode.value" @change="controller.setSortMode($event.target.value)">
          <option v-for="option in sortOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <div class="wb-dbhome-actions" aria-label="表操作">
        <button type="button" title="刷新" aria-label="刷新" :disabled="busy" @click="emit('refresh', tab)">
          <span class="wb-dbhome-action-icon is-refresh" aria-hidden="true"></span>
        </button>
        <button type="button" title="复制" aria-label="复制" :disabled="busy || !controller.canCopy.value" @click="copySelection">
          <span class="wb-dbhome-action-icon is-copy" aria-hidden="true"></span>
        </button>
        <button type="button" title="粘贴" aria-label="粘贴" :disabled="busy || !controller.canPaste.value" @click="pasteTables">
          <span class="wb-dbhome-action-icon is-paste" aria-hidden="true"></span>
        </button>
        <button type="button" title="重命名" aria-label="重命名" :disabled="busy || !controller.canRename.value" @click="startRename()">
          <span class="wb-dbhome-action-icon is-rename" aria-hidden="true"></span>
        </button>
        <button type="button" title="删除" aria-label="删除" class="is-danger" :disabled="busy || !controller.canDelete.value" @click="deleteSelection()">
          <span class="wb-dbhome-action-icon is-delete" aria-hidden="true"></span>
        </button>
      </div>
    </div>

    <DatabaseTableList
      :tables="controller.filteredTables.value"
      :selected-names="controller.selectedNames.value"
      :renaming-name="controller.renamingName.value"
      :rename-draft="controller.renameDraft.value"
      :read-only="readOnly"
      :busy="busy"
      @select-table="selectTable"
      @open-table="openTable"
      @open-design="openDesign"
      @start-rename="startRename"
      @rename-draft="controller.renameDraft.value = $event"
      @submit-rename="submitRename"
      @cancel-rename="controller.cancelRename"
      @contextmenu="openContextMenu"
      @blank-contextmenu="openContextMenu($event, '')"
      @blank-click="clearSelection"
      @copy="copySelection"
      @paste="pasteTables"
      @delete="deleteSelection"
    />

    <footer class="wb-dbhome-status" :class="{ 'is-error': tab.error }" aria-live="polite">
      <span>{{ statusText }}</span>
      <button v-if="selectedCount" type="button" @click="openSelectedTables">打开选中</button>
    </footer>

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
        <button type="button" role="menuitem" @click="emit('refresh', tab); closeMenu()">刷新</button>
        <button v-if="!menu.blank" type="button" role="menuitem" class="danger" :disabled="!controller.canDelete.value" @click="deleteSelection(menu.tableName)">删除表</button>
      </menu>
    </Teleport>
  </section>
</template>
