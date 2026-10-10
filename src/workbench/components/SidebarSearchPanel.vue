<script setup>
import { t } from "../i18n/index.js";
import { computed, ref } from "vue";
import {
  buildVisibleSidebarSearchItems,
  clampSidebarSearchSelection,
  moveSidebarSearchSelection,
  sidebarValueResultsAreFresh,
  valueSearchProgressPercent,
} from "../sidebarSearchState.js";
import { columnName } from "../utils/normalize.js";
import {
  highlightSearchExcerpt,
  highlightSearchRanges,
  highlightSearchText,
  matchSearchText,
} from "../utils/searchMatch.js";
import {
  buildSidebarSearchHistoryScope,
  readSidebarSearchHistory,
  recordSidebarSearchHistory,
  removeSidebarSearchHistoryEntry,
} from "../utils/sidebarSearchHistory.js";
import SearchHitBadge from "./SearchHitBadge.vue";
import { searchKindLabel } from "../utils/searchKindLabels.js";

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
const searchInputRef = ref(null);

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
  return searchKindLabel(kind);
}

function columnHitLabel(column, result) {
  return matchKindLabel(column?.searchMatchKind || result?.matchKind || "columnName");
}

function highlight(value) {
  return highlightSearchText(value, props.query);
}

function highlightMatch(value, match, semanticKind, { excerpt = false } = {}) {
  const matchedKind = match?.searchMatchKind || match?.matchKind || "";
  let ranges = [];
  if (matchedKind === semanticKind && Array.isArray(match?.searchMatchRanges)) {
    ranges = match.searchMatchRanges;
  } else {
    ranges = matchSearchText(value, props.query).ranges;
  }
  if (!ranges.length) return highlight(value);
  return excerpt
    ? highlightSearchExcerpt(value, ranges, 58)
    : highlightSearchRanges(value, ranges);
}

function highlightValue(value) {
  return highlightSearchText(value, props.query, { mode: "contains" });
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

// Exposed so the orchestrator can focus this input via the Ctrl+P shortcut (#8).
function focusSearch() {
  searchInputRef.value?.focus();
}

defineExpose({ focusSearch });
</script>

<template>
  <div class="wb-table-search-wrap">
    <label class="wb-table-search" :class="{ 'has-query': hasQuery, 'is-history-open': showHistory }">
      <span class="wb-visually-hidden">{{ t('m_5ea6a9cb8b5b') }}</span>
      <span class="wb-table-search-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false">
          <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M10.2 10.2 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </span>
      <input
        ref="searchInputRef"
        :value="query"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t('m_88f61178b6b5')"
        :title="t('m_e287730c90c3')"
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
        :aria-label="t('m_ee32f25f7050')"
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
      :aria-label="t('m_f244a2842f42')"
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
            :aria-label="t('m_c4d2dd77ffd9')"
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
    <p v-if="hasQuery && !hasFreshValues && !searchState.valueLoading" class="wb-search-hint">{{ t('m_250f4c4e4955') }}</p>
    <p v-if="searchState.valueLoading" class="wb-search-hint">{{ t('m_afd25dcb5cb5') }}</p>
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

    <section v-if="hasQuery && visibleSchemaResults.length" class="wb-search-result-group" :aria-label="t('m_f84e720c924c')">
      <header class="wb-search-group-title">{{ t('m_f84e720c924c') }}</header>
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
            <span class="wb-table-name" v-html="highlightMatch(tableName(result.table), result, 'tableName')"></span>
            <SearchHitBadge :kind="result.matchKind" />
          </span>
          <span v-if="tableComment(result.table)" class="wb-table-comment">
            <SearchHitBadge kind="tableComment" subtle />
            <span v-html="highlightMatch(tableComment(result.table), result, 'tableComment', { excerpt: true })"></span>
          </span>
          <span v-for="column in result.visibleColumns" :key="columnName(column)" class="wb-column-hit">
            <SearchHitBadge :kind="column.searchMatchKind || result.matchKind || 'columnName'" subtle />
            <span class="wb-column-hit-name" v-html="highlightMatch(columnName(column), column, 'columnName')"></span>
            <template v-if="columnComment(column)">
              <span class="wb-column-hit-comment" v-html="highlightMatch(columnComment(column), column, 'columnComment', { excerpt: true })"></span>
            </template>
          </span>
          <span v-if="result.hiddenColumnCount" class="wb-column-hit is-overflow">{{ t('m_83eec76b3911') }} {{ result.hiddenColumnCount }} {{ t('m_50065c68137d') }}</span>
        </span>
      </button>
    </section>
    <p v-if="hasQuery && !valueModeActive && !visibleSchemaResults.length" class="wb-tree-empty">{{ t('m_63d858907b2c') }}</p>

    <section v-if="hasFreshValues || searchState.valueLoading" class="wb-search-result-group" :aria-label="t('m_bbf22c04e503')">
      <header class="wb-search-group-title">{{ t('m_bbf22c04e503') }}</header>
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
            <SearchHitBadge kind="value" />
          </span>
          <span v-if="result.tableComment" class="wb-table-comment">
            <SearchHitBadge kind="tableComment" subtle />
            <span v-html="highlight(result.tableComment)"></span>
          </span>
          <span class="wb-value-hit">
            <SearchHitBadge kind="value" subtle :label="t('m_4bbdb2811da6')" /> {{ t('m_98bbf62daaf9') }} <span class="wb-column-hit-name" v-html="highlight(result.columnName)"></span>:
            <span v-html="highlightValue(result.previewValue)"></span>
          </span>
        </span>
      </button>
      <p v-if="hasFreshValues && !searchState.valueResults.length" class="wb-tree-empty">{{ t('m_a46b18ebb96f') }}</p>
    </section>
  </section>
</template>
