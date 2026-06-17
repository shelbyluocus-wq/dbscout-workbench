<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { useInspectorResize } from "../composables/useInspectorResize.js";
import { formatDetailValue, highlightDetailValue } from "../utils/cellDisplay.js";
import { columnName } from "../utils/normalize.js";
import { highlightSearchText } from "../utils/searchMatch.js";
import SelectedCellIdentity from "./SelectedCellIdentity.vue";

const props = defineProps({
  activeTab: { type: Object, default: null },
  activeColumns: { type: Array, default: () => [] },
  selectedCell: { type: Object, default: null },
  selectedRange: { type: Object, default: null },
  textDraft: { type: String, default: "" },
  activeStatusLabel: { type: String, default: "" },
  schemaSearchQuery: { type: String, default: "" },
  schemaSearchMatches: { type: Array, default: () => [] },
  schemaSearchIndex: { type: Number, default: -1 },
});

const emit = defineEmits(["update:textDraft", "save-text-panel", "contextmenu"]);

const detailInputRef = ref(null);
const detailHighlightsRef = ref(null);
const schemaListRef = ref(null);
const editorDraft = ref("");
const loadedCellKey = ref("");
const selectedCellKey = computed(() => props.selectedCell ? [props.selectedCell.tabId, props.selectedCell.rowKey, props.selectedCell.column].join("\u0000") : "");
const detailFormatting = computed(() => highlightDetailValue(editorDraft.value));
const hasInlineFormatting = computed(() => props.selectedCell && detailFormatting.value.kind !== "text");
const tableSource = computed(() => {
  if (!props.activeTab?.tableName) return "";
  return `${props.activeTab.database ? `${props.activeTab.database}.` : ""}${props.activeTab.tableName}`;
});
const tableComment = computed(() => props.activeTab?.tableComment || "");
const {
  inspectorRef,
  detailPanelStyle,
  isDetailResizing,
  onDetailDividerMouseDown,
  onDetailDividerKeydown,
  resetDetailHeight,
} = useInspectorResize();

watch(
  () => [selectedCellKey.value, props.textDraft],
  () => {
    const inputFocused = globalThis.document?.activeElement === detailInputRef.value;
    if (selectedCellKey.value !== loadedCellKey.value || (!inputFocused && props.textDraft !== editorDraft.value)) {
      loadedCellKey.value = selectedCellKey.value;
      editorDraft.value = formatDetailValue(props.textDraft).text;
      nextTick(syncDetailScroll);
    }
  },
  { immediate: true },
);

function updateDetailDraft(event) {
  editorDraft.value = event.target.value;
  emit("update:textDraft", event.target.value);
  syncDetailScroll();
}

function syncDetailScroll() {
  if (!detailInputRef.value || !detailHighlightsRef.value) return;
  detailHighlightsRef.value.scrollTop = detailInputRef.value.scrollTop;
  detailHighlightsRef.value.scrollLeft = detailInputRef.value.scrollLeft;
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
  return length ? `长度 ${length}` : "";
}

function columnRemark(column) {
  return [columnComment(column), columnLength(column)].filter(Boolean).join(" · ");
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

function schemaSearchColumnName(match) {
  return typeof match === "string" ? match : match?.columnName || "";
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
  if (!selectedColumn) return;
  const listRect = schemaListRef.value.getBoundingClientRect();
  const columnRect = selectedColumn.getBoundingClientRect();
  if (columnRect.top < listRect.top) schemaListRef.value.scrollTop += columnRect.top - listRect.top;
  else if (columnRect.bottom > listRect.bottom) schemaListRef.value.scrollTop += columnRect.bottom - listRect.bottom;
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
    :class="{ 'is-detail-resizing': isDetailResizing }"
    @contextmenu.prevent.stop="emit('contextmenu', $event)"
  >
    <header class="wb-inspector-table-status" aria-label="当前表信息">
      <div class="wb-inspector-table-meta">
        <strong
          v-if="activeTab"
          class="wb-inspector-table-source"
          :title="tableSource"
        >{{ tableSource }}</strong>
        <strong v-else class="wb-inspector-table-source">未选择表</strong>
        <span
          v-if="tableComment"
          class="wb-inspector-table-comment"
          :title="tableComment"
        >{{ tableComment }}</span>
        <span v-else class="wb-inspector-table-comment is-empty">无表备注</span>
      </div>
      <strong v-if="activeStatusLabel" class="wb-inspector-table-count">{{ activeStatusLabel }}</strong>
    </header>
    <div class="wb-inspector-section-label">字段备注</div>
    <section
      v-if="activeTab"
      ref="schemaListRef"
      class="wb-schema-list"
    >
      <!-- shell contract: :class="{ 'is-selected': isSelectedColumn(column) }" -->
      <article
        v-for="column in activeColumns"
        :key="columnName(column)"
        :data-schema-column="columnName(column)"
        :class="{
          'is-selected': isSelectedColumn(column),
          'schema-search-match': isSchemaSearchColumn(column),
          'schema-search-active': isActiveSchemaSearchColumn(column),
        }"
      >
        <span class="wb-object-icon" data-kind="column"></span>
        <span class="wb-schema-field-copy">
          <strong class="wb-schema-field-name" v-html="highlightSchemaSearchText(columnName(column))"></strong>
          <span class="wb-schema-type-line">
            <em class="wb-schema-field-type">{{ columnType(column) }}</em>
            <span v-if="columnLength(column)" class="wb-schema-field-length">{{ columnLength(column) }}</span>
            <span v-if="isPrimaryKey(column)" class="wb-schema-key-badge">主键</span>
          </span>
          <small
            v-if="columnRemark(column)"
            class="wb-schema-field-comment"
            v-html="highlightSchemaSearchText(columnRemark(column))"
          ></small>
        </span>
      </article>
    </section>
    <div
      class="wb-inspector-divider"
      role="separator"
      aria-label="调整备注与内容区域高度"
      aria-orientation="horizontal"
      tabindex="0"
      @mousedown="onDetailDividerMouseDown"
      @dblclick="resetDetailHeight"
      @keydown="onDetailDividerKeydown"
    >
      <span aria-hidden="true"></span>
    </div>
    <section class="wb-text-panel" :style="detailPanelStyle">
      <div>
        <strong>{{ selectedCell?.column }}</strong>
        <span v-if="hasInlineFormatting">{{ detailFormatting.kind === 'json' ? 'JSON' : 'TS' }}</span>
      </div>
      <div class="wb-detail-editor" :class="[`is-${detailFormatting.kind}`, { 'has-highlight': hasInlineFormatting }]">
        <pre
          v-if="hasInlineFormatting"
          ref="detailHighlightsRef"
          class="wb-detail-highlights"
          aria-hidden="true"
          v-html="detailFormatting.html"
        ></pre>
        <textarea
          ref="detailInputRef"
          class="wb-detail-input"
          :value="editorDraft"
          :disabled="!selectedCell"
          placeholder="选中单元格后在这里查看或编辑长文本"
          @input="updateDetailDraft"
          @scroll="syncDetailScroll"
          @change="emit('save-text-panel')"
        ></textarea>
      </div>
      <section class="wb-inspector-cell-panel" aria-label="当前单元格信息">
        <SelectedCellIdentity
          class="wb-inspector-cell-identity"
          :tab="activeTab"
          :selected-cell="selectedCell"
          :selected-range="selectedRange"
          panel
        />
      </section>
    </section>
  </aside>
</template>
