<script setup>
import { computed, ref } from "vue";
import {
  buildVisibleSidebarSearchItems,
  clampSidebarSearchSelection,
  moveSidebarSearchSelection,
  sidebarValueResultsAreFresh,
  valueSearchProgressPercent,
} from "../sidebarSearchState.js";
import { columnName } from "../utils/normalize.js";
import { highlightSearchText } from "../utils/searchMatch.js";
import {
  buildSidebarSearchHistoryScope,
  readSidebarSearchHistory,
  recordSidebarSearchHistory,
  removeSidebarSearchHistoryEntry,
} from "../utils/sidebarSearchHistory.js";

const props = defineProps({
  query: { type: String, default: "" },
  connectionId: { type: String, default: "" },
  database: { type: String, default: "" },
  schemaResults: { type: Array, default: () => [] },
  searchState: { type: Object, required: true },
});

const emit = defineEmits([
  "update:query",
  "search-values",
  "cancel-search-values",
  "open-schema-result",
  "open-value-result",
]);

const historyOpen = ref(false);
const historyItems = ref([]);
let historyCloseTimer = 0;

const historyScope = computed(() => buildSidebarSearchHistoryScope(props.connectionId, props.database));
const hasQuery = computed(() => props.query.trim().length > 0);
const showHistory = computed(() => historyOpen.value && !hasQuery.value && historyItems.value.length > 0);
const hasFreshValues = computed(() => sidebarValueResultsAreFresh(props.searchState));
const valueModeActive = computed(() => hasFreshValues.value || props.searchState.valueLoading);
const visibleSchemaResults = computed(() => (valueModeActive.value ? [] : props.schemaResults));
const visibleValueResults = computed(() => (hasFreshValues.value ? props.searchState.valueResults : []));
const visibleItems = computed(() => buildVisibleSidebarSearchItems(visibleSchemaResults.value, visibleValueResults.value));
const progressPercent = computed(() => valueSearchProgressPercent(props.searchState));
const progressStyle = computed(() => ({ "--wb-value-search-progress-width": `${progressPercent.value}%` }));
const progressLabel = computed(() => {
  const progress = props.searchState.valueProgress || {};
  const done = Number(progress.done) || 0;
  const total = Number(progress.total) || 0;
  const matches = Number(progress.matches) || 0;
  if (!total) return `搜索值… 命中 ${matches}`;
  return `搜索值 ${done}/${total}，命中 ${matches}`;
});
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

function matchKindLabel(kind) {
  return {
    tableName: "表名",
    tableComment: "表备注",
    columnName: "字段",
    columnComment: "字段备注",
    value: "值",
  }[kind] || "结构";
}

function columnHitLabel(column, result) {
  return matchKindLabel(column?.searchMatchKind || result?.matchKind || "columnName");
}

function highlight(value) {
  return highlightSearchText(value, props.query);
}

function storage() {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function refreshHistory() {
  historyItems.value = readSidebarSearchHistory(storage(), historyScope.value);
}

function rememberQuery(query) {
  historyItems.value = recordSidebarSearchHistory(storage(), historyScope.value, query);
}

function openHistory() {
  if (historyCloseTimer) {
    clearTimeout(historyCloseTimer);
    historyCloseTimer = 0;
  }
  refreshHistory();
  historyOpen.value = historyItems.value.length > 0;
}

function closeHistory() {
  if (historyCloseTimer) {
    clearTimeout(historyCloseTimer);
    historyCloseTimer = 0;
  }
  historyOpen.value = false;
}

function scheduleCloseHistory() {
  if (historyCloseTimer) clearTimeout(historyCloseTimer);
  historyCloseTimer = setTimeout(() => {
    historyCloseTimer = 0;
    historyOpen.value = false;
  }, 120);
}

function applyHistoryItem(entry) {
  if (!entry?.query) return;
  closeHistory();
  emit("update:query", entry.query);
}

function removeHistoryItem(entry) {
  historyItems.value = removeSidebarSearchHistoryEntry(storage(), historyScope.value, entry.query);
  if (!historyItems.value.length) closeHistory();
}

function activateItem(item) {
  if (!item) return;
  if (props.query.trim()) rememberQuery(props.query);
  if (item.kind === "value") emit("open-value-result", item.result);
  else emit("open-schema-result", item.result);
}

function clearQuery() {
  if (!hasQuery.value) return;
  emit("update:query", "");
}

function handleKeydown(event) {
  if (event.key === "Escape" && showHistory.value) {
    event.preventDefault();
    closeHistory();
    return;
  }
  if (event.key === "Escape" && props.searchState.valueLoading) {
    event.preventDefault();
    emit("cancel-search-values");
    return;
  }
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
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (props.query.trim()) rememberQuery(props.query);
    closeHistory();
    emit("search-values");
    return;
  }
  if (event.key === "Enter") {
    const item = visibleItems.value[selectedIndex.value];
    if (!item) {
      if (props.query.trim()) rememberQuery(props.query);
      closeHistory();
      return;
    }
    event.preventDefault();
    activateItem(item);
  }
}
</script>

<template>
  <div class="wb-table-search-wrap">
    <label class="wb-table-search" :class="{ 'has-query': hasQuery, 'is-history-open': showHistory }">
      <span class="wb-visually-hidden">搜索表、备注、字段和值</span>
      <input
        :value="query"
        autocomplete="off"
        spellcheck="false"
        placeholder="搜索表、备注、字段；Ctrl+Enter 搜索值"
        aria-controls="wb-sidebar-search-history"
        :aria-expanded="showHistory ? 'true' : 'false'"
        @input="emit('update:query', $event.target.value)"
        @focus="openHistory"
        @blur="scheduleCloseHistory"
        @keydown="handleKeydown"
      />
      <button
        v-if="hasQuery"
        type="button"
        class="wb-table-search-clear"
        aria-label="清除搜索"
        tabindex="-1"
        @mousedown.prevent
        @click.stop="clearQuery"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </label>

    <section
      v-if="showHistory"
      id="wb-sidebar-search-history"
      class="wb-sidebar-search-history"
      aria-label="搜索历史"
      @mousedown.prevent
    >
      <div class="wb-sidebar-search-history-list" role="list">
        <div
          v-for="entry in historyItems"
          :key="entry.query"
          class="wb-sidebar-search-history-item"
          role="listitem"
        >
          <button
            type="button"
            class="wb-sidebar-search-history-query"
            @click="applyHistoryItem(entry)"
          >
            {{ entry.query }}
          </button>
          <button
            type="button"
            class="wb-sidebar-search-history-delete"
            aria-label="删除该搜索历史"
            tabindex="-1"
            @mousedown.stop.prevent
            @click.stop="removeHistoryItem(entry)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </section>
  </div>

  <section class="wb-sidebar-search-panel">
    <p v-if="hasQuery && !hasFreshValues && !searchState.valueLoading" class="wb-search-hint">按 Ctrl+Enter 搜索具体值</p>
    <p v-if="searchState.valueLoading" class="wb-search-hint">搜索值… 按 Esc 取消</p>
    <div v-if="searchState.valueLoading" class="wb-value-search-progress-wrap">
      <div
        class="wb-value-search-progress"
        role="progressbar"
        :aria-valuenow="progressPercent"
        aria-valuemin="0"
        aria-valuemax="100"
        :style="progressStyle"
      >
        <span class="wb-value-search-progress-fill"></span>
      </div>
      <p class="wb-value-search-progress-text">{{ progressLabel }}</p>
    </div>
    <p v-if="searchState.valueError" class="wb-search-error">{{ searchState.valueError }}</p>

    <section v-if="hasQuery && visibleSchemaResults.length" class="wb-search-result-group" aria-label="结构结果">
      <header class="wb-search-group-title">结构结果</header>
      <button
        v-for="(result, index) in visibleSchemaResults"
        :key="result.key"
        type="button"
        class="wb-search-result wb-schema-result"
        :class="{ 'keyboard-selected': selectedIndex === index }"
        :aria-selected="selectedIndex === index ? 'true' : undefined"
        @click="emit('open-schema-result', result)"
      >
        <span class="wb-search-result-copy">
          <span class="wb-search-result-title">
            <span class="wb-table-name" v-html="highlight(tableName(result.table))"></span>
            <span class="wb-search-hit-badge">{{ matchKindLabel(result.matchKind) }}</span>
          </span>
          <span v-if="tableComment(result.table)" class="wb-table-comment">
            <span class="wb-search-hit-label">表备注</span>
            <span v-html="highlight(tableComment(result.table))"></span>
          </span>
          <span v-for="column in result.visibleColumns" :key="columnName(column)" class="wb-column-hit">
            <span class="wb-search-hit-label">{{ columnHitLabel(column, result) }}</span>
            <span class="wb-column-hit-name" v-html="highlight(columnName(column))"></span>
            <template v-if="columnComment(column)">
              <span class="wb-column-hit-comment" v-html="highlight(columnComment(column))"></span>
            </template>
          </span>
          <span v-if="result.hiddenColumnCount" class="wb-column-hit is-overflow">还有 {{ result.hiddenColumnCount }} 个字段命中</span>
        </span>
      </button>
    </section>
    <p v-if="hasQuery && !valueModeActive && !visibleSchemaResults.length" class="wb-tree-empty">没有匹配的表或字段</p>

    <section v-if="hasFreshValues || searchState.valueLoading" class="wb-search-result-group" aria-label="值结果">
      <header class="wb-search-group-title">值结果</header>
      <button
        v-for="(result, index) in visibleValueResults"
        :key="`${result.tableName}:${result.columnName}`"
        type="button"
        class="wb-search-result wb-value-result"
        :class="{ 'keyboard-selected': selectedIndex === index }"
        :aria-selected="selectedIndex === index ? 'true' : undefined"
        @click="emit('open-value-result', result)"
      >
        <span class="wb-search-result-copy">
          <span class="wb-search-result-title">
            <span class="wb-table-name" v-html="highlight(result.tableName)"></span>
            <span class="wb-search-hit-badge">{{ matchKindLabel('value') }}</span>
          </span>
          <span v-if="result.tableComment" class="wb-table-comment">
            <span class="wb-search-hit-label">表备注</span>
            <span v-html="highlight(result.tableComment)"></span>
          </span>
          <span class="wb-value-hit">
            <span class="wb-search-hit-label">值预览</span>
            至少 1 处 · <span class="wb-column-hit-name" v-html="highlight(result.columnName)"></span>:
            <span v-html="highlight(result.previewValue)"></span>
          </span>
        </span>
      </button>
      <p v-if="hasFreshValues && !searchState.valueResults.length" class="wb-tree-empty">当前数据库没有匹配的值</p>
    </section>
  </section>
</template>
