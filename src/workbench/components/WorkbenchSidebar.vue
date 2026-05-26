<script setup>
import { computed, ref } from "vue";
import { columnName } from "../utils/normalize.js";

const props = defineProps({
  selectedConnectionId: { type: String, default: "" },
  selectedDatabase: { type: String, default: "" },
  connections: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
  filteredTables: { type: Array, default: () => [] },
  dataSearchResults: { type: Array, default: () => [] },
  treeQuery: { type: String, default: "" },
});

const emit = defineEmits([
  "update:treeQuery",
  "select-connection",
  "select-database",
  "open-table",
  "open-connection",
  "contextmenu",
  "data-search",
]);

const connectionsOpen = ref(false);
const currentConnection = computed(
  () => props.connections.find((connection) => connection.id === props.selectedConnectionId) || props.connections[0] || null,
);
const drawerConnections = computed(() => props.connections.filter((connection) => connection.id !== currentConnection.value?.id));

function toggleConnections() {
  if (props.connections.length <= 1) {
    if (currentConnection.value) emit("select-connection", currentConnection.value.id);
    return;
  }
  connectionsOpen.value = !connectionsOpen.value;
}

function selectDrawerConnection(connectionId) {
  connectionsOpen.value = false;
  emit("select-connection", connectionId);
}
</script>

<template>
  <aside class="wb-sidebar wb-navigation-pane" @contextmenu.prevent="emit('contextmenu', $event)">
    <section class="wb-connection-list wb-connection-list--compact">
      <div class="wb-connection-row">
        <button
          v-if="currentConnection"
          class="wb-connection-card wb-connection-current"
          :class="{ connected: currentConnection.connected, active: currentConnection.id === selectedConnectionId, open: connectionsOpen }"
          @click="toggleConnections"
        >
          <span class="wb-object-icon" data-kind="connection"></span>
          <span>
            <strong>{{ currentConnection.label }}</strong>
            <em>{{ currentConnection.username || "root" }}@{{ currentConnection.host || "demo" }}:{{ currentConnection.port || 3306 }}</em>
          </span>
          <span v-if="connections.length > 1" class="wb-connection-chevron">{{ connectionsOpen ? "收起" : `切换(${connections.length})` }}</span>
        </button>
        <button class="wb-header-btn wb-connection-add" title="连接 MySQL 服务器" @click="emit('open-connection')">+</button>
      </div>
      <div v-if="connectionsOpen && drawerConnections.length" class="wb-connection-drawer">
        <button
          class="wb-connection-card"
          v-for="connection in drawerConnections"
          :key="connection.id"
          :class="{ connected: connection.connected }"
          @click="selectDrawerConnection(connection.id)"
        >
          <span class="wb-object-icon" data-kind="connection"></span>
          <span>
            <strong>{{ connection.label }}</strong>
            <em>{{ connection.username || "root" }}@{{ connection.host || "demo" }}:{{ connection.port || 3306 }}</em>
          </span>
        </button>
      </div>
    </section>

    <label class="wb-field" v-if="databases.length">
      <span>数据库</span>
      <select :value="selectedDatabase" @change="emit('select-database', { connectionId: selectedConnectionId, database: $event.target.value })">
        <option value="">选择数据库</option>
        <option v-for="database in databases" :key="database" :value="database">{{ database }}</option>
      </select>
    </label>

    <label class="wb-field">
      <span>搜索</span>
      <input :value="treeQuery" placeholder="表名 / 字段 / 备注（回车搜数据值）" @input="emit('update:treeQuery', $event.target.value)" @keydown.enter.prevent="emit('data-search')" />
    </label>

    <section v-if="dataSearchResults.length" class="wb-data-search-results">
      <button
        v-for="result in dataSearchResults"
        :key="result.tableName"
        class="wb-tree-item"
        @click="emit('open-table', { table_name: result.tableName })"
      >
        <span class="wb-object-icon" data-kind="table"></span>
        <span class="wb-tree-item__body">
          <span class="wb-tree-item__name">{{ result.tableName }} <em class="wb-data-search-count">{{ result.matchCount }} 条匹配</em></span>
          <span v-for="match in result.matches" :key="match.columnName" class="wb-data-search-match">
            {{ match.columnName }}: {{ match.value }}
          </span>
        </span>
      </button>
    </section>

    <nav class="wb-tree">
      <button
        v-for="table in filteredTables"
        :key="table.tableName"
        class="wb-tree-item"
        @click="emit('open-table', table.raw || table)"
        @contextmenu.prevent.stop="emit('contextmenu', $event, table.raw || table)"
      >
        <span class="wb-object-icon" data-kind="table"></span>
        <span class="wb-tree-item__body">
          <span class="wb-tree-item__name">{{ table.tableName }}</span>
          <span class="wb-tree-item__comment">{{ table.tableComment }}</span>
          <span v-if="table.columns.length" class="wb-tree-item__columns">
            {{ table.columns.map(columnName).join(", ") }}
          </span>
        </span>
      </button>
    </nav>
  </aside>
</template>
