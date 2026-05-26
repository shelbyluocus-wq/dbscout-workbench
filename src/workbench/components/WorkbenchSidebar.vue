<script setup>
import { reactive } from "vue";
import {
  createSidebarTreeState,
  isConnectionExpanded,
  isDatabaseExpanded,
  revealConnection,
  revealDatabase,
  toggleConnectionExpansion,
  toggleDatabaseExpansion,
} from "../sidebarTreeState.js";

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
  "contextmenu",
]);

const treeState = reactive(createSidebarTreeState());

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
</script>

<template>
  <aside class="wb-sidebar wb-navigation-pane" @contextmenu.prevent="emit('contextmenu', $event)">
    <header class="wb-sidebar-header">
      <div>
        <strong>数据库</strong>
        <small>连接与表</small>
      </div>
      <button class="wb-header-btn wb-connection-add" title="连接 MySQL 服务器" @click="emit('open-connection')">+</button>
    </header>

    <nav class="wb-source-tree" aria-label="连接、数据库与表">
      <section v-for="connection in connections" :key="connection.id" class="wb-source-connection">
        <button
          class="wb-tree-row wb-connection-node"
          :class="{ active: connection.id === selectedConnectionId }"
          :title="connection.label"
          :aria-expanded="isConnectionExpanded(treeState, connection.id, selectedConnectionId)"
          @click="onConnectionClick(connection.id)"
        >
          <span class="wb-tree-chevron" :class="{ 'is-open': isConnectionExpanded(treeState, connection.id, selectedConnectionId) }" aria-hidden="true"></span>
          <span class="wb-object-icon" data-kind="connection"></span>
          <span class="wb-tree-label">{{ connection.label }}</span>
        </button>

        <section v-if="isConnectionExpanded(treeState, connection.id, selectedConnectionId)" class="wb-database-branch">
          <section v-for="database in databases" :key="database" class="wb-source-database">
            <button
              class="wb-tree-row wb-database-item"
              :class="{ active: database === selectedDatabase }"
              :title="database"
              :aria-expanded="isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase)"
              @click="onDatabaseClick(connection.id, database)"
            >
              <span class="wb-tree-chevron" :class="{ 'is-open': isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase) }" aria-hidden="true"></span>
              <span class="wb-object-icon" data-kind="database"></span>
              <span class="wb-tree-label">{{ database }}</span>
            </button>

            <section v-if="isDatabaseExpanded(treeState, connection.id, database, selectedConnectionId, selectedDatabase)" class="wb-table-branch">
              <label class="wb-table-search">
                <span class="wb-visually-hidden">搜索表</span>
                <input
                  :value="treeQuery"
                  placeholder="搜索表"
                  @input="emit('update:treeQuery', $event.target.value)"
                  @contextmenu.stop
                />
              </label>

              <button
                v-for="table in filteredTables"
                :key="table.tableName"
                class="wb-tree-row wb-table-item"
                :class="{ active: isTableActive(table) }"
                :aria-current="isTableActive(table) ? 'page' : undefined"
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
        </section>
      </section>
    </nav>
  </aside>
</template>
