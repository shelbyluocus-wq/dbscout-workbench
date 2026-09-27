<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, ref, watch } from "vue";
import { columnName } from "../utils/normalize.js";
import { visibleTargetScrollDelta } from "../utils/inspectorScroll.js";
import { highlightSearchText } from "../utils/searchMatch.js";
import { useAliases } from "../composables/aliasStore.js";

const props = defineProps({
  activeTab: { type: Object, default: null },
  activeColumns: { type: Array, default: () => [] },
  selectedCell: { type: Object, default: null },
  selectedRange: { type: Object, default: null },
  schemaSearchQuery: { type: String, default: "" },
  schemaSearchMatches: { type: Array, default: () => [] },
  schemaSearchIndex: { type: Number, default: -1 },
});

const emit = defineEmits([
  "contextmenu",
  "select-column",
  "schema-search",
  "schema-search-previous",
  "schema-search-next",
]);

const { databaseLabel } = useAliases();

const inspectorRef = ref(null);
const schemaListRef = ref(null);
const selectedCellKey = computed(() => props.selectedCell ? [props.selectedCell.tabId, props.selectedCell.rowKey, props.selectedCell.column].join("\u0000") : "");
const hasCurrentCell = computed(() => props.activeTab?.id === props.selectedCell?.tabId);
const tableSource = computed(() => {
  if (!props.activeTab?.tableName) return "";
  const db = props.activeTab.database ? databaseLabel(props.activeTab.connectionId, props.activeTab.database) : "";
  return `${db ? `${db}.` : ""}${props.activeTab.tableName}`;
});
const tableComment = computed(() => props.activeTab?.tableComment || "");

function columnComment(column) {
  return column.column_comment || column.columnComment || "";
}

function columnType(column) {
  return column.column_type || column.columnType || "";
}

function columnLengthValue(column) {
  const type = columnType(column);
  const match = /^\w+\(([^)]+)\)/.exec(type);
  return match?.[1] || "";
}

function columnLength(column) {
  const length = columnLengthValue(column);
  return length ? `长度 ${length}` : "";
}

function columnRemark(column) {
  return columnComment(column);
}

function isPrimaryKey(column) {
  return Boolean(column.is_primary_key || column.isPrimaryKey);
}

function isSelectedColumn(column) {
  return (
    props.activeTab?.id === props.selectedCell?.tabId &&
    columnName(column) === props.selectedCell?.column
  );
}

const hasColumnSearchQuery = computed(() => Boolean(String(props.schemaSearchQuery || "").trim()));
const displayedColumns = computed(() => {
  if (!hasColumnSearchQuery.value) return props.activeColumns;
  const names = new Set(props.schemaSearchMatches.map((match) => schemaSearchColumnName(match)));
  return props.activeColumns.filter((column) => names.has(columnName(column)));
});
const columnSearchCountLabel = computed(() => {
  if (!hasColumnSearchQuery.value) return "";
  const total = props.schemaSearchMatches.length;
  if (!total) return "0";
  const current = Math.max(0, Math.min(total - 1, Number(props.schemaSearchIndex) || 0));
  return `${current + 1}/${total}`;
});

function schemaSearchColumnName(match) {
  return typeof match === "string" ? match : match?.columnName || "";
}

function emitColumnSearch(query) {
  emit("schema-search", query);
}

function onColumnSearchInput(event) {
  if (event.isComposing) return;
  emitColumnSearch(event.target.value);
}

function onColumnSearchKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  emit(event.shiftKey ? "schema-search-previous" : "schema-search-next");
}

function isSchemaSearchColumn(column) {
  const name = columnName(column);
  return props.schemaSearchMatches.some((match) => schemaSearchColumnName(match) === name);
}

function isActiveSchemaSearchColumn(column) {
  const match = props.schemaSearchMatches[props.schemaSearchIndex];
  return Boolean(match && schemaSearchColumnName(match) === columnName(column));
}

function highlightSchemaSearchText(value) {
  return highlightSearchText(value, props.schemaSearchQuery);
}

function scrollSelectedColumnIntoView() {
  if (!schemaListRef.value || !props.selectedCell || props.activeTab?.id !== props.selectedCell.tabId) return;
  const selectedColumn = schemaListRef.value.querySelector(`[data-schema-column="${CSS.escape(props.selectedCell.column)}"]`);
  scrollSchemaColumnElementIntoView(selectedColumn);
}

function scrollSchemaColumnElementIntoView(selectedColumn) {
  if (!schemaListRef.value || !selectedColumn) return;
  const listRect = schemaListRef.value.getBoundingClientRect();
  const columnRect = selectedColumn.getBoundingClientRect();
  const delta = visibleTargetScrollDelta({
    containerTop: listRect.top,
    containerBottom: listRect.bottom,
    targetTop: columnRect.top,
    targetBottom: columnRect.bottom,
    gap: 8,
  });
  if (delta) schemaListRef.value.scrollTop += delta;
}

function hasTextSelectionWithin(element) {
  const selection = globalThis.window?.getSelection?.();
  if (!element || !selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return selection.getRangeAt(0).intersectsNode(element);
}

function selectedTextWithin(element) {
  const selection = globalThis.window?.getSelection?.();
  if (!element || !selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  if (!selection.getRangeAt(0).intersectsNode(element)) return "";
  return selection.toString();
}

function selectColumn(column, event) {
  if (event?.detail > 0 && hasTextSelectionWithin(event.currentTarget)) return;
  emit("select-column", columnName(column));
}

function scrollActiveSchemaSearchColumnIntoView() {
  if (!schemaListRef.value || !props.schemaSearchMatches.length) return;
  const match = props.schemaSearchMatches[props.schemaSearchIndex];
  const name = schemaSearchColumnName(match);
  if (!name) return;
  const selectedColumn = schemaListRef.value.querySelector(`[data-schema-column="${CSS.escape(name)}"]`);
  scrollSchemaColumnElementIntoView(selectedColumn);
}

watch(
  () => [selectedCellKey.value, props.activeColumns.length],
  () => nextTick(scrollSelectedColumnIntoView),
  { immediate: true },
);

watch(
  () => [props.schemaSearchQuery, props.schemaSearchMatches.length, props.schemaSearchIndex],
  () => nextTick(scrollActiveSchemaSearchColumnIntoView),
  { immediate: true },
);
</script>

<template>
  <aside
    ref="inspectorRef"
    class="wb-inspector wb-info-pane"
    @contextmenu.prevent.stop="emit('contextmenu', $event, selectedTextWithin(inspectorRef))"
  >
    <header class="wb-inspector-table-status" :aria-label="t('m_788e6a933525')">
      <div class="wb-inspector-table-meta">
        <strong
          v-if="activeTab"
          class="wb-inspector-table-source"
          :title="tableSource"
        >{{ tableSource }}</strong>
        <strong v-else class="wb-inspector-table-source">{{ t('m_88ac482e6e23') }}</strong>
        <span
          v-if="tableComment"
          class="wb-inspector-table-comment"
          :title="tableComment"
        >{{ tableComment }}</span>
        <span v-else class="wb-inspector-table-comment is-empty">{{ t('m_dbc8f66df4fd') }}</span>
      </div>
    </header>
    <div class="wb-inspector-section-head">
      <div class="wb-inspector-section-label">{{ t('m_39230fff0eb1') }}</div>
      <span
        v-if="hasColumnSearchQuery"
        class="wb-inspector-search-nav"
        role="group"
        :aria-label="t('m_011770d2a98d')"
      >
        <button
          type="button"
          class="wb-search-nav-icon"
          :aria-label="t('m_bd64376553c6')"
          :title="t('m_bd64376553c6')"
          :disabled="!schemaSearchMatches.length"
          @click="emit('schema-search-previous')"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3,9 7,5 11,9" />
          </svg>
        </button>
        <span class="wb-inspector-search-count" aria-live="polite">{{ columnSearchCountLabel }}</span>
        <button
          type="button"
          class="wb-search-nav-icon"
          :aria-label="t('m_b339a2050e7f')"
          :title="t('m_b339a2050e7f')"
          :disabled="!schemaSearchMatches.length"
          @click="emit('schema-search-next')"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3,5 7,9 11,5" />
          </svg>
        </button>
      </span>
    </div>
    <div class="wb-inspector-search">
      <label class="wb-table-search" :class="{ 'has-query': hasColumnSearchQuery }">
        <span class="wb-visually-hidden">{{ t('m_145ea7868404') }}</span>
        <span class="wb-table-search-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" focusable="false">
            <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M10.2 10.2 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </span>
        <input
          :value="schemaSearchQuery"
          :disabled="!activeTab"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('m_145ea7868404')"
          :aria-label="t('m_145ea7868404')"
          @input="onColumnSearchInput"
          @compositionend="emitColumnSearch($event.target.value)"
          @keydown="onColumnSearchKeydown"
        />
        <button
          v-if="hasColumnSearchQuery"
          type="button"
          class="wb-table-search-clear"
          :aria-label="t('m_6c91e67d0eff')"
          tabindex="-1"
          @mousedown.prevent
          @click.stop="emitColumnSearch('')"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </label>
    </div>
    <section
      v-if="activeTab"
      ref="schemaListRef"
      class="wb-schema-list"
    >
      <!-- shell contract: :class="{ 'is-selected': isSelectedColumn(column) }" -->
      <article
        v-for="column in displayedColumns"
        :key="columnName(column)"
        class="wb-schema-column"
        role="button"
        tabindex="0"
        :data-schema-column="columnName(column)"
        :title="hasCurrentCell ? `定位到当前行的 ${columnName(column)} 字段` : `定位到首行的 ${columnName(column)} 字段`"
        :class="{
          'is-selected': isSelectedColumn(column),
          'schema-search-match': isSchemaSearchColumn(column),
          'schema-search-active': isActiveSchemaSearchColumn(column),
        }"
        @click="selectColumn(column, $event)"
        @keydown.enter.prevent="selectColumn(column)"
        @keydown.space.prevent="selectColumn(column)"
      >
        <span class="wb-object-icon" data-kind="column"></span>
        <span class="wb-schema-field-copy">
          <strong class="wb-schema-field-name" v-html="highlightSchemaSearchText(columnName(column))"></strong>
          <span class="wb-schema-type-line">
            <em class="wb-schema-field-type">{{ columnType(column) }}</em>
            <span v-if="columnLength(column)" class="wb-schema-field-length">{{ columnLength(column) }}</span>
            <span v-if="isPrimaryKey(column)" class="wb-schema-key-badge">{{ t('m_ecfc9d2e0157') }}</span>
          </span>
          <small
            v-if="columnRemark(column)"
            class="wb-schema-field-comment"
            v-html="highlightSchemaSearchText(columnRemark(column))"
          ></small>
        </span>
      </article>
      <p
        v-if="hasColumnSearchQuery && !displayedColumns.length"
        class="wb-inspector-search-empty"
      >{{ t('m_18e034572849') }}</p>
    </section>
  </aside>
</template>
