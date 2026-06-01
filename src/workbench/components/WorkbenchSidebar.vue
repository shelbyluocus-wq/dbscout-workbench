<script setup>
import { computed, ref, reactive, watch } from "vue";
import {
  createSidebarTreeState,
  isConnectionExpanded,
  isDatabaseExpanded,
  revealConnection,
  revealDatabase,
  toggleConnectionExpansion,
  toggleDatabaseExpansion,
} from "../sidebarTreeState.js";
import { previewDragOrder, resolvePreviewDropTarget, sameDragTarget } from "../sidebarDragPreview.js";
const props = defineProps({
  selectedConnectionId: { type: String, default: "" },
  selectedDatabase: { type: String, default: "" },
  connections: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
  filteredTables: { type: Array, default: () => [] },
  treeQuery: { type: String, default: "" },
  activeTab: { type: Object, default: null },
});

const emit = defineEmits([
  "update:treeQuery",
  "select-connection",
  "select-database",
  "open-table",
  "open-connection",
  "reorder-connections",
  "reorder-databases",
  "contextmenu",
]);

const treeState = reactive(createSidebarTreeState());
const selectedSearchIndex = ref(-1);
const dragState = reactive({ kind: "", sourceId: "", targetId: "", targetPosition: "before" });

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

function clampSearchIndex(index) {
  if (props.filteredTables.length === 0) return -1;
  return Math.min(Math.max(index, 0), props.filteredTables.length - 1);
}

function resetSearchSelection() {
  selectedSearchIndex.value = props.treeQuery.trim() && props.filteredTables.length > 0 ? 0 : -1;
}

function moveSearchSelection(delta) {
  selectedSearchIndex.value = clampSearchIndex(selectedSearchIndex.value + delta);
}

function openKeyboardSelectedTable() {
  const table = props.filteredTables[clampSearchIndex(selectedSearchIndex.value)];
  if (table) openSelectedTable(table);
}

function handleTableSearchKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveSearchSelection(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveSearchSelection(-1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    openKeyboardSelectedTable();
  }
}

function isSearchResultSelected(index) {
  return selectedSearchIndex.value === index;
}

watch(
  () => [props.treeQuery, props.filteredTables.map((table) => table.tableName).join("")],
  resetSearchSelection,
  { immediate: true },
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

function setDragPayload(event, kind, id) {
  if (!event?.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-dbscout-sidebar", JSON.stringify({ kind, id }));
  event.dataTransfer.setData("text/plain", String(id));
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
</script>

<template>
  <aside class="wb-sidebar wb-navigation-pane" @contextmenu.prevent.stop="emit('contextmenu', $event)">
    <header class="wb-sidebar-header">
      <div>
        <strong>数据库</strong>
        <small>连接与表</small>
      </div>
      <button class="wb-header-btn wb-connection-add" title="连接 MySQL 服务器" @click="emit('open-connection')">+</button>
    </header>

    <nav class="wb-source-tree" aria-label="连接、数据库与表">
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
                >
                  <span class="wb-tree-chevron" :class="{ 'is-open': isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase) }" aria-hidden="true"></span>
                  <span class="wb-object-icon" data-kind="database"></span>
                  <span class="wb-tree-label">{{ database }}</span>
                </button>

                <section v-if="dragState.kind !== 'database' && isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase)" class="wb-table-branch">
                  <label class="wb-table-search">
                    <span class="wb-visually-hidden">搜索表</span>
                    <input
                      :value="treeQuery"
                      placeholder="搜索表"
                      @input="emit('update:treeQuery', $event.target.value)"
                      @keydown="handleTableSearchKeydown"
                    />
                  </label>

                  <button
                    v-for="(table, index) in filteredTables"
                    :key="table.tableName"
                    class="wb-tree-row wb-table-item"
                    :class="{ active: isTableActive(table), 'keyboard-selected': isSearchResultSelected(index) }"
                    :aria-current="isTableActive(table) ? 'page' : undefined"
                    :aria-selected="isSearchResultSelected(index) ? 'true' : undefined"
                    :title="tableTitle(table)"
                    @click="openSelectedTable(table)"
                    @contextmenu.prevent.stop="emit('contextmenu', $event, table.raw || table)"
                  >
                    <span class="wb-tree-spacer" aria-hidden="true"></span>
                    <span class="wb-object-icon" data-kind="table"></span>
                    <span class="wb-table-copy" :class="{ 'has-comment': table.tableComment }">
                      <span class="wb-table-name">{{ table.tableName }}</span>
                      <span v-if="table.tableComment" class="wb-table-comment">{{ table.tableComment }}</span>
                    </span>
                  </button>

                  <p v-if="!filteredTables.length" class="wb-tree-empty">没有匹配的表</p>
                </section>
              </section>
            </TransitionGroup>
          </section>
        </section>
      </TransitionGroup>
    </nav>
  </aside>
</template>
