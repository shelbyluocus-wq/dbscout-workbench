<script setup>
import { columnName } from "../utils/normalize.js";

const props = defineProps({
  selectedDatabase: { type: String, default: "" },
  connections: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
  filteredTables: { type: Array, default: () => [] },
  dataSearchResults: { type: Array, default: () => [] },
  treeQuery: { type: String, default: "" },
});

const emit = defineEmits([
  "update:treeQuery",
  "select-database",
  "open-table",
  "open-connection",
  "contextmenu",
  "data-search",
]);
</script>

<template>
  <aside class="wb-sidebar wb-navigation-pane" @contextmenu.prevent="emit('contextmenu', $event)">
    <header class="wb-pane-header">
      <div>
        <strong>导航</strong>
        <span>{{ selectedDatabase }}</span>
      </div>
      <button class="wb-header-btn" title="连接 MySQL 服务器" @click="emit('open-connection')">+</button>
    </header>

    <section class="wb-connection-list">
      <button class="wb-connection-card" v-for="connection in connections" :key="connection.id" :class="{ connected: connection.connected }">
        <span class="wb-object-icon" data-kind="connection"></span>
        <span>
          <strong>{{ connection.label }}</strong>
          <em>{{ connection.username || "root" }}@{{ connection.host || "demo" }}:{{ connection.port || 3306 }}</em>
        </span>
      </button>
    </section>

    <label class="wb-field" v-if="databases.length">
      <span>数据库</span>
      <select :value="selectedDatabase" @change="emit('select-database', $event.target.value)">
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
