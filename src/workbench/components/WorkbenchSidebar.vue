<script setup>
const props = defineProps({
  selectedConnectionId: { type: String, default: "" },
  selectedDatabase: { type: String, default: "" },
  connections: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
  filteredTables: { type: Array, default: () => [] },
  treeQuery: { type: String, default: "" },
});

const emit = defineEmits([
  "update:treeQuery",
  "select-connection",
  "select-database",
  "open-table",
  "open-connection",
  "contextmenu",
]);

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
          @click="emit('select-connection', connection.id)"
        >
          <span class="wb-tree-chevron" :class="{ 'is-open': connection.id === selectedConnectionId }" aria-hidden="true"></span>
          <span class="wb-object-icon" data-kind="connection"></span>
          <span class="wb-tree-label">{{ connection.label }}</span>
        </button>

        <section v-if="connection.id === selectedConnectionId" class="wb-database-branch">
          <section v-for="database in databases" :key="database" class="wb-source-database">
            <button
              class="wb-tree-row wb-database-item"
              :class="{ active: database === selectedDatabase }"
              :title="database"
              @click="emit('select-database', { connectionId: selectedConnectionId, database })"
            >
              <span class="wb-tree-chevron" :class="{ 'is-open': database === selectedDatabase }" aria-hidden="true"></span>
              <span class="wb-object-icon" data-kind="database"></span>
              <span class="wb-tree-label">{{ database }}</span>
            </button>

            <section v-if="database === selectedDatabase" class="wb-table-branch">
              <label class="wb-table-search">
                <span class="wb-visually-hidden">搜索表</span>
                <input
                  :value="treeQuery"
                  placeholder="搜索表"
                  @input="emit('update:treeQuery', $event.target.value)"
                />
              </label>

              <button
                v-for="table in filteredTables"
                :key="table.tableName"
                class="wb-tree-row wb-table-item"
                :title="tableTitle(table)"
                @click="openSelectedTable(table)"
                @contextmenu.prevent.stop="emit('contextmenu', $event, table.raw || table)"
              >
                <span class="wb-tree-spacer" aria-hidden="true"></span>
                <span class="wb-object-icon" data-kind="table"></span>
                <span class="wb-tree-label">{{ table.tableName }}</span>
              </button>

              <p v-if="!filteredTables.length" class="wb-tree-empty">没有匹配的表</p>
            </section>
          </section>
        </section>
      </section>
    </nav>
  </aside>
</template>
