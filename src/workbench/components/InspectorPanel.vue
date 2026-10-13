<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  Binary,
  Braces,
  Brackets,
  Calendar,
  CalendarClock,
  Clock,
  Fingerprint,
  Hash,
  KeyRound,
  MapPin,
  Table2,
  ToggleLeft,
  Type,
  Variable,
} from "lucide-vue-next";
import { columnName } from "../utils/normalize.js";
import { columnTypeKind } from "../utils/columnTypes.js";
import { relationTableSummary } from "../utils/configRelations.js";
import { visibleTargetScrollDelta } from "../utils/inspectorScroll.js";
import { highlightSearchText } from "../utils/searchMatch.js";
import { createTableMentionIndex } from "../utils/tableMentions.js";
import { useAliases } from "../composables/aliasStore.js";
import ConfigRelationsPanel from "./ConfigRelationsPanel.vue";
import TableMentionText from "./TableMentionText.vue";

const props = defineProps({
  activeTab: { type: Object, default: null },
  activeColumns: { type: Array, default: () => [] },
  selectedCell: { type: Object, default: null },
  selectedRange: { type: Object, default: null },
  schemaSearchQuery: { type: String, default: "" },
  schemaSearchMatches: { type: Array, default: () => [] },
  schemaSearchIndex: { type: Number, default: -1 },
  relations: { type: Object, default: null },
  relationsSupported: { type: Boolean, default: false },
  schema: { type: Array, default: () => [] },
});

const emit = defineEmits([
  "contextmenu",
  "select-column",
  "schema-search",
  "schema-search-previous",
  "schema-search-next",
  "open-relation",
  "open-relations-review",
  "open-table",
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
// Home, SQL and empty panes have no table to describe; show guidance instead
// of an empty header, a dead search box and a blank list.
const hasTableContext = computed(() => Boolean(props.activeTab?.tableName));

// 字段 / 关联 toggle: only real data tabs of a supported connection offer the
// relation page; everything else stays on the field list.
const showRelationsToggle = computed(() =>
  Boolean(props.relationsSupported && props.relations && props.activeTab?.tableName && (props.activeTab?.kind || "data") === "data"));
const inspectorView = ref("fields");
const effectiveView = computed(() => (showRelationsToggle.value ? inspectorView.value : "fields"));
const mentionTables = computed(() => createTableMentionIndex(props.schema, {
  connectionId: props.activeTab?.connectionId,
  database: props.activeTab?.database,
}));

// Badge on the relation switch: how many relations this table takes part in,
// and a mark when some wait for review. Read after a short pause so flipping
// through tabs does not ask for every table on the way; cached per revision.
const RELATION_SUMMARY_DELAY_MS = 150;
const relationScope = computed(() => ({
  connectionId: String(props.activeTab?.connectionId || ""),
  database: String(props.activeTab?.database || ""),
}));
const relationRevision = computed(() => (showRelationsToggle.value
  ? Number(props.relations?.entryFor?.(relationScope.value)?.revision) || 0
  : 0));
const relationSummary = ref(null);
let relationSummaryToken = 0;
let relationSummaryTimer = null;

watch(
  [showRelationsToggle, () => relationScope.value.connectionId, () => relationScope.value.database, () => props.activeTab?.tableName],
  () => {
    relationSummary.value = null;
  },
);

watch(
  [showRelationsToggle, () => relationScope.value.connectionId, () => relationScope.value.database, () => props.activeTab?.tableName, relationRevision],
  () => {
    clearTimeout(relationSummaryTimer);
    const token = ++relationSummaryToken;
    if (!showRelationsToggle.value) return;
    const scope = relationScope.value;
    const tableName = String(props.activeTab?.tableName || "");
    relationSummaryTimer = setTimeout(async () => {
      try {
        const data = await props.relations.tableRelations(scope, tableName);
        if (token === relationSummaryToken) relationSummary.value = relationTableSummary(data);
      } catch {
        if (token === relationSummaryToken) relationSummary.value = null;
      }
    }, RELATION_SUMMARY_DELAY_MS);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  clearTimeout(relationSummaryTimer);
  relationSummaryToken += 1;
});

function openMentionedTable(table) {
  if (!table?.name) return;
  emit("open-table", {
    connectionId: props.activeTab?.connectionId || "",
    database: props.activeTab?.database || "",
    tableName: table.name,
    tableComment: table.comment || "",
  });
}

const COLUMN_KIND_ICONS = Object.freeze({
  key: KeyRound,
  number: Hash,
  boolean: ToggleLeft,
  text: Type,
  date: Calendar,
  datetime: CalendarClock,
  time: Clock,
  json: Braces,
  array: Brackets,
  identifier: Fingerprint,
  binary: Binary,
  spatial: MapPin,
  other: Variable,
});

function columnKind(column) {
  return columnTypeKind(columnType(column), { primaryKey: isPrimaryKey(column) });
}

function columnIcon(column) {
  return COLUMN_KIND_ICONS[columnKind(column)] || Variable;
}

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
  return length ? t("inspector.length", { length }) : "";
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
    <div v-if="!hasTableContext" class="wb-inspector-empty">
      <Table2 class="wb-inspector-empty-icon" :size="22" :stroke-width="1.6" aria-hidden="true" />
      <strong>{{ t('m_88ac482e6e23') }}</strong>
      <span>{{ t('inspector.emptyHint') }}</span>
    </div>
    <template v-else>
    <header class="wb-inspector-table-status" :aria-label="t('m_788e6a933525')">
      <div class="wb-inspector-table-meta">
        <strong
          v-if="activeTab"
          class="wb-inspector-table-source"
          :title="tableSource"
        >{{ tableSource }}</strong>
        <strong v-else class="wb-inspector-table-source">{{ t('m_88ac482e6e23') }}</strong>
        <TableMentionText
          v-if="tableComment"
          class="wb-inspector-table-comment"
          :title="tableComment"
          :text="tableComment"
          :tables="mentionTables"
          @open="openMentionedTable"
        />
        <span v-else class="wb-inspector-table-comment is-empty">{{ t('m_dbc8f66df4fd') }}</span>
      </div>
    </header>
    <div
      v-if="showRelationsToggle"
      class="wb-inspector-view-toggle"
      role="tablist"
      :aria-label="t('relations.toggle.relations')"
    >
      <button
        type="button"
        role="tab"
        :aria-selected="effectiveView === 'fields'"
        :class="{ 'is-active': effectiveView === 'fields' }"
        @click="inspectorView = 'fields'"
      >{{ t('relations.toggle.fields') }}</button>
      <button
        type="button"
        role="tab"
        :aria-selected="effectiveView === 'relations'"
        :class="{ 'is-active': effectiveView === 'relations' }"
        @click="inspectorView = 'relations'"
      >
        {{ t('relations.toggle.relations') }}
        <span
          v-if="relationSummary?.total"
          class="wb-inspector-view-count"
          :class="{ 'needs-review': relationSummary.review }"
          :title="relationSummary.review ? t('relations.toggle.review', { count: relationSummary.review }) : undefined"
        >{{ relationSummary.total }}</span>
      </button>
    </div>
    <ConfigRelationsPanel
      v-if="showRelationsToggle && effectiveView === 'relations'"
      :tab="activeTab"
      :selected-cell="selectedCell"
      :relations="relations"
      :mention-tables="mentionTables"
      @open-relation="emit('open-relation', $event)"
      @open-review="emit('open-relations-review', relationScope)"
      @open-table="emit('open-table', $event)"
    />
    <template v-if="effectiveView === 'fields'">
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
        :title="t(hasCurrentCell ? 'inspector.locateCurrentRow' : 'inspector.locateFirstRow', { column: columnName(column) })"
        :class="{
          'is-selected': isSelectedColumn(column),
          'schema-search-match': isSchemaSearchColumn(column),
          'schema-search-active': isActiveSchemaSearchColumn(column),
        }"
        @click="selectColumn(column, $event)"
        @keydown.enter.prevent="selectColumn(column)"
        @keydown.space.prevent="selectColumn(column)"
      >
        <component
          :is="columnIcon(column)"
          class="wb-schema-type-icon"
          :class="`is-${columnKind(column)}`"
          :size="14"
          :stroke-width="1.9"
          aria-hidden="true"
        />
        <span class="wb-schema-field-copy">
          <strong class="wb-schema-field-name" v-html="highlightSchemaSearchText(columnName(column))"></strong>
          <span class="wb-schema-type-line">
            <em class="wb-schema-field-type">{{ columnType(column) }}</em>
            <span v-if="columnLength(column)" class="wb-schema-field-length">{{ columnLength(column) }}</span>
            <span v-if="isPrimaryKey(column)" class="wb-schema-key-badge">{{ t('m_ecfc9d2e0157') }}</span>
          </span>
          <template v-if="columnRemark(column)">
            <small
              v-if="hasColumnSearchQuery"
              class="wb-schema-field-comment"
              v-html="highlightSchemaSearchText(columnRemark(column))"
            ></small>
            <TableMentionText
              v-else
              class="wb-schema-field-comment"
              :text="columnRemark(column)"
              :tables="mentionTables"
              @open="openMentionedTable"
            />
          </template>
        </span>
      </article>
      <p
        v-if="hasColumnSearchQuery && !displayedColumns.length"
        class="wb-inspector-search-empty"
      >{{ t('m_18e034572849') }}</p>
    </section>
    </template>
    </template>
  </aside>
</template>
