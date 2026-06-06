<script setup>
import { computed } from "vue";
import {
  buildVisibleSidebarSearchItems,
  clampSidebarSearchSelection,
  moveSidebarSearchSelection,
  sidebarValueResultsAreFresh,
} from "../sidebarSearchState.js";
import { columnName } from "../utils/normalize.js";

const props = defineProps({
  query: { type: String, default: "" },
  schemaResults: { type: Array, default: () => [] },
  searchState: { type: Object, required: true },
});

const emit = defineEmits([
  "update:query",
  "search-values",
  "open-schema-result",
  "open-value-result",
]);

const visibleItems = computed(() => buildVisibleSidebarSearchItems(props.schemaResults, props.searchState.valueResults));
const hasQuery = computed(() => props.query.trim().length > 0);
const hasFreshValues = computed(() => sidebarValueResultsAreFresh(props.searchState));
const selectedIndex = computed(() => {
  clampSidebarSearchSelection(props.searchState, visibleItems.value);
  return props.searchState.selectedIndex;
});

function tableName(table) {
  return table?.tableName || table?.table_name || "";
}

function tableComment(table) {
  return table?.tableComment || table?.table_comment || "";
}

function columnComment(column) {
  return column?.column_comment || column?.columnComment || "";
}

function activateItem(item) {
  if (!item) return;
  if (item.kind === "value") emit("open-value-result", item.result);
  else emit("open-schema-result", item.result);
}

function handleKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveSidebarSearchSelection(props.searchState, visibleItems.value, 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveSidebarSearchSelection(props.searchState, visibleItems.value, -1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (!hasFreshValues.value) {
      emit("search-values");
      return;
    }
    activateItem(visibleItems.value[selectedIndex.value]);
  }
}
</script>

<template>
  <section class="wb-sidebar-search-panel">
    <label class="wb-table-search">
      <span class="wb-visually-hidden">搜索表、备注、字段和值</span>
      <input
        :value="query"
        placeholder="搜索表、备注、字段；回车搜索值"
        @input="emit('update:query', $event.target.value)"
        @keydown="handleKeydown"
      />
    </label>

    <p v-if="hasQuery && !hasFreshValues && !searchState.valueLoading" class="wb-search-hint">按 Enter 搜索具体值</p>
    <p v-if="searchState.valueLoading" class="wb-search-hint">搜索值...</p>
    <p v-if="searchState.valueError" class="wb-search-error">{{ searchState.valueError }}</p>

    <section v-if="hasQuery" class="wb-search-result-group" aria-label="结构结果">
      <header class="wb-search-group-title">结构结果</header>
      <button
        v-for="(result, index) in schemaResults"
        :key="result.key"
        type="button"
        class="wb-search-result wb-schema-result"
        :class="{ 'keyboard-selected': selectedIndex === index }"
        :aria-selected="selectedIndex === index ? 'true' : undefined"
        @click="emit('open-schema-result', result)"
      >
        <span class="wb-object-icon" data-kind="table"></span>
        <span class="wb-search-result-copy">
          <span class="wb-table-name">{{ tableName(result.table) }}</span>
          <span v-if="tableComment(result.table)" class="wb-table-comment">{{ tableComment(result.table) }}</span>
          <span v-for="column in result.visibleColumns" :key="columnName(column)" class="wb-column-hit">
            字段: {{ columnName(column) }}<template v-if="columnComment(column)"> · {{ columnComment(column) }}</template>
          </span>
          <span v-if="result.hiddenColumnCount" class="wb-column-hit is-overflow">还有 {{ result.hiddenColumnCount }} 个字段命中</span>
        </span>
      </button>
      <p v-if="!schemaResults.length" class="wb-tree-empty">没有匹配的表或字段</p>
    </section>

    <section v-if="hasFreshValues || searchState.valueLoading" class="wb-search-result-group" aria-label="值结果">
      <header class="wb-search-group-title">值结果</header>
      <button
        v-for="(result, index) in searchState.valueResults"
        :key="`${result.tableName}:${result.columnName}`"
        type="button"
        class="wb-search-result wb-value-result"
        :class="{ 'keyboard-selected': selectedIndex === schemaResults.length + index }"
        :aria-selected="selectedIndex === schemaResults.length + index ? 'true' : undefined"
        @click="emit('open-value-result', result)"
      >
        <span class="wb-object-icon" data-kind="table"></span>
        <span class="wb-search-result-copy">
          <span class="wb-table-name">{{ result.tableName }}</span>
          <span v-if="result.tableComment" class="wb-table-comment">{{ result.tableComment }}</span>
          <span class="wb-value-hit">至少 1 处 · {{ result.columnName }}: {{ result.previewValue }}</span>
        </span>
      </button>
      <p v-if="hasFreshValues && !searchState.valueResults.length" class="wb-tree-empty">当前数据库没有匹配的值</p>
    </section>
  </section>
</template>
