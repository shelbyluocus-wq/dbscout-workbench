<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { useInspectorResize } from "../composables/useInspectorResize.js";
import { formatDetailValue, highlightDetailValue } from "../utils/cellDisplay.js";
import { columnName } from "../utils/normalize.js";

const props = defineProps({
  activeTab: { type: Object, default: null },
  activeColumns: { type: Array, default: () => [] },
  selectedCell: { type: Object, default: null },
  textDraft: { type: String, default: "" },
});

const emit = defineEmits(["update:textDraft", "save-text-panel", "contextmenu"]);

const detailInputRef = ref(null);
const detailHighlightsRef = ref(null);
const editorDraft = ref("");
const loadedCellKey = ref("");
const selectedCellKey = computed(() => props.selectedCell ? [props.selectedCell.tabId, props.selectedCell.rowKey, props.selectedCell.column].join("\u0000") : "");
const detailFormatting = computed(() => highlightDetailValue(editorDraft.value));
const hasInlineFormatting = computed(() => props.selectedCell && detailFormatting.value.kind !== "text");
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

function isPrimaryKey(column) {
  return Boolean(column.is_primary_key || column.isPrimaryKey);
}

function isSelectedColumn(column) {
  return (
    props.activeTab?.id === props.selectedCell?.tabId &&
    columnName(column) === props.selectedCell?.column
  );
}
</script>

<template>
  <aside
    ref="inspectorRef"
    class="wb-inspector wb-info-pane"
    :class="{ 'is-detail-resizing': isDetailResizing }"
    @contextmenu.prevent.stop="emit('contextmenu', $event)"
  >
    <header class="wb-pane-header">
      <div>
        <strong>备注</strong>
        <span v-if="activeTab">{{ activeTab.database ? `${activeTab.database}.${activeTab.tableName}` : activeTab.tableName }}</span>
      </div>
    </header>
    <section v-if="activeTab" class="wb-schema-list">
      <article
        v-for="column in activeColumns"
        :key="columnName(column)"
        :class="{ 'is-selected': isSelectedColumn(column) }"
      >
        <span class="wb-object-icon" data-kind="column"></span>
        <span class="wb-schema-field-copy">
          <strong class="wb-schema-field-name">{{ columnName(column) }}</strong>
          <span class="wb-schema-type-line">
            <em class="wb-schema-field-type">{{ columnType(column) }}</em>
            <span v-if="isPrimaryKey(column)" class="wb-schema-key-badge">主键</span>
          </span>
          <small v-if="columnComment(column)" class="wb-schema-field-comment">{{ columnComment(column) }}</small>
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
    </section>
  </aside>
</template>
