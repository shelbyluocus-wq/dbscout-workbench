<script setup>
import { computed, ref, reactive, watch, nextTick, onBeforeUnmount } from "vue";
import SidebarSearchPanel from "./SidebarSearchPanel.vue";
import ShortcutSettingsDialog from "./ShortcutSettingsDialog.vue";
import { useCellHighlight } from "../composables/useCellHighlight.js";
import {
  createSidebarTreeState,
  isConnectionExpanded,
  isDatabaseExpanded,
  revealConnection,
  revealDatabase,
  toggleConnectionExpansion,
  toggleDatabaseExpansion,
  collapseAllConnections,
  expandAllConnections,
} from "../sidebarTreeState.js";
import { createSidebarSearchState } from "../sidebarSearchState.js";
import { previewDragOrder, resolvePreviewDropTarget, sameDragTarget } from "../sidebarDragPreview.js";
const props = defineProps({
  selectedConnectionId: { type: String, default: "" },
  selectedDatabase: { type: String, default: "" },
  connections: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
  filteredTables: { type: Array, default: () => [] },
  schemaSearchResults: { type: Array, default: () => [] },
  sidebarSearchState: { type: Object, default: null },
  treeQuery: { type: String, default: "" },
  activeTab: { type: Object, default: null },
  isDark: { type: Boolean, default: false },
  invokeWorkbench: { type: Function, default: null },
});

const emit = defineEmits([
  "update:treeQuery",
  "select-connection",
  "select-database",
  "open-table",
  "open-connection",
  "search-values",
  "cancel-search-values",
  "open-schema-result",
  "open-value-result",
  "reorder-connections",
  "reorder-databases",
  "rename-table",
  "contextmenu",
  "toggle-theme",
  "open-backup-center",
]);

const treeState = reactive(createSidebarTreeState());
const fallbackSearchState = reactive(createSidebarSearchState());
const dragState = reactive({ kind: "", sourceId: "", targetId: "", targetPosition: "before" });
const treeNavRef = ref(null);
const settingsOpen = ref(false);
const settingsDockRef = ref(null);
const searchPanelRef = ref(null);
const shortcutsOpen = ref(false);
const { color: cellHighlightColor, setColor: setCellHighlightColor, clear: clearCellHighlightColor } = useCellHighlight();

const areAllCollapsed = computed(() => {
  if (props.connections.length === 0) return false;
  return props.connections.every((c) => treeState.collapsedConnectionIds.has(c.id));
});

function toggleCollapseAll() {
  const ids = props.connections.map((c) => c.id);
  if (areAllCollapsed.value) {
    expandAllConnections(treeState, ids);
  } else {
    collapseAllConnections(treeState, ids);
  }
}

function toggleSettings() {
  settingsOpen.value = !settingsOpen.value;
}

function closeSettings() {
  settingsOpen.value = false;
}

function onDocumentPointerDown(event) {
  if (settingsDockRef.value?.contains?.(event.target)) return;
  closeSettings();
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeSettings();
}

watch(settingsOpen, (isOpen) => {
  if (isOpen) {
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeydown);
  } else {
    document.removeEventListener("pointerdown", onDocumentPointerDown);
    document.removeEventListener("keydown", onDocumentKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});

function setTheme(nextTheme) {
  if ((nextTheme === "dark") !== props.isDark) {
    emit("toggle-theme");
  }
}

const previewConnections = computed(() => {
  if (dragState.kind === "connection" && dragState.sourceId && dragState.targetId) {
    return previewDragOrder(props.connections, dragState.sourceId, dragState.targetId, {
      position: dragState.targetPosition,
      getKey: (connection) => connection.id,
    });
  }
  return props.connections;
});

const previewDatabases = computed(() => {
  if (dragState.kind === "database" && dragState.sourceId && dragState.targetId) {
    return previewDragOrder(props.databases, dragState.sourceId, dragState.targetId, {
      position: dragState.targetPosition,
    });
  }
  return props.databases;
});

const dragSourceLabel = computed(() => {
  if (dragState.kind === "connection") {
    const conn = props.connections.find((c) => c.id === dragState.sourceId);
    return conn?.label ?? "";
  }
  return dragState.sourceId;
});

const effectiveSchemaSearchResults = computed(() => {
  if (props.schemaSearchResults.length > 0) return props.schemaSearchResults;
  return props.filteredTables.map((table, index) => {
    const name = table.tableName || table.table_name || index;
    return {
      key: `table:${props.selectedConnectionId}:${props.selectedDatabase}:${name}:${index}`,
      table,
      visibleColumns: [],
      matchedColumns: [],
      hiddenColumnCount: 0,
      matchKind: "none",
    };
  });
});

const effectiveSearchState = computed(() => props.sidebarSearchState || fallbackSearchState);
const filteredTables = computed(() => effectiveSchemaSearchResults.value.map((result) => result.table));

watch(
  () => props.activeTab?.id,
  async () => {
    const tab = props.activeTab;
    if (!tab || !treeNavRef.value) return;
    if (tab.connectionId !== props.selectedConnectionId || tab.database !== props.selectedDatabase) return;
    await nextTick();
    const selector = `.wb-table-item[data-table-name="${CSS.escape(tab.tableName)}"]`;
    const el = treeNavRef.value.querySelector(selector);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  },
);

function onConnectionClick(connectionId) {
  if (toggleConnectionExpansion(treeState, connectionId, props.selectedConnectionId)) return;
  revealConnection(treeState, connectionId);
  emit("select-connection", connectionId);
}

function onDatabaseClick(connectionId, database) {
  if (toggleDatabaseExpansion(treeState, connectionId, database, props.selectedConnectionId, props.selectedDatabase)) return;
  revealConnection(treeState, connectionId);
  revealDatabase(treeState, connectionId, database);
  emit("select-database", { connectionId, database });
}

function openSelectedTable(table) {
  emit("open-table", {
    ...(table.raw || table),
    connectionId: props.selectedConnectionId,
    database: props.selectedDatabase,
  });
}

function renameSelectedTable(event, table) {
  if (event.key === "F2") {
    event.preventDefault();
    event.stopPropagation();
    emit("rename-table", {
      ...(table.raw || table),
      connectionId: props.selectedConnectionId,
      database: props.selectedDatabase,
    });
  }
}

function openSchemaSearchResult(result) {
  emit("open-schema-result", result);
}

function tableTitle(table) {
  return table.tableComment ? `${table.tableName}\n${table.tableComment}` : table.tableName;
}

function isTableActive(table) {
  return (
    props.activeTab?.connectionId === props.selectedConnectionId &&
    props.activeTab?.database === props.selectedDatabase &&
    props.activeTab?.tableName === table.tableName
  );
}

function setDragImage(event) {
  if (!event?.dataTransfer || typeof document === "undefined") return;
  const source = event.currentTarget;
  const rect = source?.getBoundingClientRect?.();
  if (!source || !rect) return;
  const image = source.cloneNode(true);
  image.classList.add("wb-sidebar-drag-image");
  image.style.width = `${rect.width}px`;
  image.style.height = `${rect.height}px`;
  document.body.appendChild(image);
  event.dataTransfer.setDragImage(image, Math.min(18, rect.width / 2), Math.min(18, rect.height / 2));
  requestAnimationFrame(() => image.remove());
}

function setDragPayload(event, kind, id) {
  if (!event?.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-dbscout-sidebar", JSON.stringify({ kind, id }));
  event.dataTransfer.setData("text/plain", String(id));
  setDragImage(event);
}

function startSidebarDrag(kind, id, event) {
  dragState.kind = kind;
  dragState.sourceId = id;
  dragState.targetId = "";
  dragState.targetPosition = "before";
  setDragPayload(event, kind, id);
}

function clearSidebarDrag() {
  dragState.kind = "";
  dragState.sourceId = "";
  dragState.targetId = "";
  dragState.targetPosition = "before";
}

function isDragSource(kind, id) {
  return dragState.kind === kind && dragState.sourceId === id;
}

function isDragTarget(kind, id) {
  return dragState.kind === kind && dragState.targetId === id && dragState.sourceId !== id;
}

function dragNodeClass(kind, id) {
  const source = isDragSource(kind, id);
  const targetBefore = isDragTarget(kind, id) && dragState.targetPosition === "before";
  const targetAfter = isDragTarget(kind, id) && dragState.targetPosition === "after";
  return {
    "is-drag-ghost": source,
    "is-drop-before": targetBefore,
    "is-drop-after": targetAfter,
  };
}

function dragRowClass(kind, id) {
  const source = isDragSource(kind, id);
  const target = isDragTarget(kind, id);
  return {
    "is-dragging-source": source,
    "is-drag-over": target,
    "is-drag-preview-target": target,
  };
}

function markDragTarget(kind, id, event) {
  if (dragState.kind !== kind || dragState.sourceId === id) return;
  const position = dropPosition(event);
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "move";
  if (sameDragTarget({ kind: dragState.kind, id: dragState.targetId, position: dragState.targetPosition }, kind, id, position)) return;
  dragState.targetId = id;
  dragState.targetPosition = position;
}

function dropPosition(event) {
  const rect = event?.currentTarget?.getBoundingClientRect?.();
  if (!rect) return "before";
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

function dropConnection(connectionId, event) {
  if (dragState.kind === "connection" && dragState.sourceId) {
    const fallbackPosition = dragState.targetId === connectionId ? dragState.targetPosition : dropPosition(event);
    const target = resolvePreviewDropTarget(dragState, connectionId, fallbackPosition);
    if (dragState.sourceId !== target.targetId) {
      emit("reorder-connections", dragState.sourceId, target.targetId, { position: target.position });
    }
  }
  clearSidebarDrag();
}

function dropDatabase(connectionId, database, event) {
  if (dragState.kind === "database" && dragState.sourceId) {
    const fallbackPosition = dragState.targetId === database ? dragState.targetPosition : dropPosition(event);
    const target = resolvePreviewDropTarget(dragState, database, fallbackPosition);
    if (dragState.sourceId !== target.targetId) {
      emit("reorder-databases", dragState.sourceId, target.targetId, { connectionId, position: target.position });
    }
  }
  clearSidebarDrag();
}

// Exposed so the orchestrator can focus the sidebar search via Ctrl+P (#8).
function focusSearch() {
  searchPanelRef.value?.focusSearch?.();
}

defineExpose({ focusSearch });
</script>

<template>
  <aside class="wb-sidebar wb-navigation-pane" @contextmenu.prevent.stop="emit('contextmenu', $event)">
    <Teleport defer to="#wb-topbar-sidebar-actions">
      <div class="wb-sidebar-actions">
        <button
          type="button"
          class="wb-header-btn"
          :aria-label="areAllCollapsed ? '展开全部连接' : '折叠全部连接'"
          :title="areAllCollapsed ? '展开全部' : '折叠全部'"
          @click="toggleCollapseAll"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <template v-if="areAllCollapsed">
              <polyline points="2,5 7,10 12,5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </template>
            <template v-else>
              <polyline points="2,9 7,4 12,9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </template>
          </svg>
        </button>
        <button
          type="button"
          class="wb-header-btn wb-connection-add"
          aria-label="连接 MySQL 服务器"
          title="连接 MySQL 服务器"
          @click="emit('open-connection')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <button
          type="button"
          class="wb-header-btn"
          aria-label="备份中心"
          title="备份中心：变更日志与快照还原"
          @click="emit('open-backup-center')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3 h6 l2 2 v6 h-8 z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
            <path d="M5 7 h4 M5 9 h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </Teleport>

    <nav ref="treeNavRef" class="wb-source-tree" aria-label="连接、数据库与表">
      <TransitionGroup name="wb-tree-reorder" tag="div" class="wb-source-connection-list">
        <section
          v-for="connection in previewConnections"
          :key="connection.id"
          class="wb-source-connection"
          :class="dragNodeClass('connection', connection.id)"
        >
          <button
            class="wb-tree-row wb-connection-node"
            :class="[{ active: connection.id === selectedConnectionId }, dragRowClass('connection', connection.id)]"
            :title="connection.label"
            :aria-expanded="isConnectionExpanded(treeState, connection.id, selectedConnectionId)"
            draggable="true"
            @dragstart.stop="startSidebarDrag('connection', connection.id, $event)"
            @dragover.prevent.stop="markDragTarget('connection', connection.id, $event)"
            @drop.prevent.stop="dropConnection(connection.id, $event)"
            @dragend="clearSidebarDrag"
            @click="onConnectionClick(connection.id)"
            @contextmenu.prevent.stop="emit('contextmenu', $event, { kind: 'connection', connectionId: connection.id })"
          >
            <span class="wb-tree-chevron" :class="{ 'is-open': isConnectionExpanded(treeState, connection.id, selectedConnectionId) }" aria-hidden="true"></span>
            <span class="wb-object-icon" data-kind="connection"></span>
            <span class="wb-tree-label">{{ connection.label }}</span>
          </button>

          <section v-if="dragState.kind !== 'connection' && isConnectionExpanded(treeState, connection.id, selectedConnectionId)" class="wb-database-branch">
            <TransitionGroup name="wb-tree-reorder" tag="div" class="wb-source-database-list">
              <section
                v-for="database in previewDatabases"
                :key="database"
                class="wb-source-database"
                :class="dragNodeClass('database', database)"
              >
                <button
                  class="wb-tree-row wb-database-item"
                  :class="[{ active: database === selectedDatabase }, dragRowClass('database', database)]"
                  :title="database"
                  :aria-expanded="isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase)"
                  draggable="true"
                  @dragstart.stop="startSidebarDrag('database', database, $event)"
                  @dragover.prevent.stop="markDragTarget('database', database, $event)"
                  @drop.prevent.stop="dropDatabase(connection.id, database, $event)"
                  @dragend="clearSidebarDrag"
                  @click="onDatabaseClick(connection.id, database)"
                  @contextmenu.prevent.stop="emit('contextmenu', $event, { kind: 'database', connectionId: connection.id, database })"
                >
                  <span class="wb-tree-chevron" :class="{ 'is-open': isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase) }" aria-hidden="true"></span>
                  <span class="wb-object-icon" data-kind="database"></span>
                  <span class="wb-tree-label">{{ database }}</span>
                </button>

                <section v-if="dragState.kind !== 'database' && isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase)" class="wb-table-branch">
                  <SidebarSearchPanel
                    ref="searchPanelRef"
                    :query="treeQuery"
                    :connection-id="selectedConnectionId"
                    :database="database"
                    :schema-results="effectiveSchemaSearchResults"
                    :search-state="effectiveSearchState"
                    @update:query="emit('update:treeQuery', $event)"
                    @search-values="emit('search-values')"
                    @cancel-search-values="emit('cancel-search-values')"
                    @open-schema-result="openSchemaSearchResult"
                    @open-value-result="emit('open-value-result', $event)"
                  />

                  <template v-if="!treeQuery.trim()">
                    <button
                      v-for="table in filteredTables"
                      :key="table.tableName"
                      class="wb-tree-row wb-table-item"
                      :data-table-name="table.tableName"
                      :class="{ active: isTableActive(table) }"
                      :aria-current="isTableActive(table) ? 'page' : undefined"
                      :title="tableTitle(table)"
                      @click="openSelectedTable(table)"
                      @keydown="renameSelectedTable($event, table)"
                      @contextmenu.prevent.stop="emit('contextmenu', $event, table.raw || table)"
                    >
                      <span class="wb-table-copy" :class="{ 'has-comment': table.tableComment }">
                        <span class="wb-table-name">{{ table.tableName }}</span>
                        <span v-if="table.tableComment" class="wb-table-comment">{{ table.tableComment }}</span>
                      </span>
                    </button>

                    <p v-if="!filteredTables.length" class="wb-tree-empty">没有匹配的表</p>
                  </template>
                </section>
              </section>
            </TransitionGroup>
          </section>
        </section>
      </TransitionGroup>
    </nav>

    <div ref="settingsDockRef" class="wb-sidebar-settings-dock" :class="{ 'is-open': settingsOpen }">
      <button
        type="button"
        class="wb-sidebar-settings-trigger"
        :aria-expanded="settingsOpen"
        aria-controls="wb-sidebar-settings-sheet"
        title="设置"
        aria-label="设置"
        @click.stop="toggleSettings"
      >
        <img
          class="wb-sidebar-settings-icon"
          :src="isDark ? '/settings-white.png' : '/settings.png'"
          alt=""
          aria-hidden="true"
          draggable="false"
        />
      </button>

      <section id="wb-sidebar-settings-sheet" class="wb-sidebar-settings-sheet" aria-label="设置">
        <div class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3.6" />
              <path d="M12 2.7v2.4M12 18.9v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.7 12h2.4M18.9 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7" />
            </svg>
            外观
          </span>
          <div class="wb-sidebar-theme-segment" role="group" aria-label="外观主题">
            <button type="button" :class="{ active: !isDark }" @click.stop="setTheme('light')">浅色</button>
            <button type="button" :class="{ active: isDark }" @click.stop="setTheme('dark')">深色</button>
          </div>
        </div>
        <div class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="7" width="18" height="11" rx="2.5" />
              <path d="M7 11h2M7 14h1M11 11h2M11 14h3M16 11h1M16 14h2" />
            </svg>
            快捷键
          </span>
          <button type="button" class="wb-sidebar-settings-action" @click.stop="shortcutsOpen = true">修改…</button>
        </div>
        <div class="wb-sidebar-settings-row">
          <span class="wb-sidebar-settings-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4" width="7" height="7" rx="1.5" />
              <rect x="13" y="4" width="7" height="7" rx="1.5" />
              <rect x="4" y="13" width="7" height="7" rx="1.5" />
              <rect x="13" y="13" width="7" height="7" rx="1.5" />
            </svg>
            行列高亮
          </span>
          <span class="wb-sidebar-highlight-picker">
            <input
              type="color"
              :value="cellHighlightColor || '#3b82f6'"
              aria-label="行列高亮颜色"
              @input="setCellHighlightColor($event.target.value)"
            />
            <button
              v-if="cellHighlightColor"
              type="button"
              class="wb-sidebar-settings-action"
              title="恢复默认"
              @click.stop="clearCellHighlightColor"
            >默认</button>
          </span>
        </div>
      </section>
    </div>

    <ShortcutSettingsDialog
      :open="shortcutsOpen"
      :invoke-workbench="invokeWorkbench"
      @close="shortcutsOpen = false"
    />
  </aside>
</template>
