<script setup>
import { inject, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import { isCellPending, getCellError } from "../editState.js";
import { columnName } from "../utils/normalize.js";
import { escapeHtml } from "../utils/cellDisplay.js";
import { GRID_ROW_HEIGHT } from "../constants.js";
import { useColumnResize } from "../composables/useColumnResize.js";
import { sampleNextFrame } from "../utils/performanceMarks.js";
import ColumnSortMenu from "./ColumnSortMenu.vue";

const suspendGridAutoFit = inject("suspendGridAutoFit", ref(false));
const gridWrapRef = ref(null);
const searchInputRef = ref(null);
const isRowDragging = ref(false);
defineExpose({ gridWrapRef });

const {
  getColumnWidth,
  onHandleMouseDown,
  autoFitColumns,
  autoFitDebounced,
} = useColumnResize();

const props = defineProps({
  tab: { type: Object, default: null },
  activeColumns: { type: Array, default: () => [] },
  visibleRows: { type: Array, default: () => [] },
  virtualRange: { type: Object, default: () => ({ start: 0, end: 0, padTop: 0, totalHeight: 0 }) },
  selectedCell: { type: Object, default: null },
  selectedRange: { type: Object, default: null },
  isSelectingRange: { type: Boolean, default: false },
  isCellInSelectedRange: { type: Function, default: () => false },
  getCellRangeClasses: { type: Function, default: () => ({}) },
  editingCell: { type: Object, default: null },
  editDraft: { type: String, default: "" },
  selectedInsertCell: { type: Object, default: null },
  selectedInsertRow: { type: Object, default: null },
  editState: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  splitMenuOpen: { type: Boolean, default: false },
  highlightCell: { type: Function, default: () => "" },
  hasSearchMatches: { type: Boolean, default: false },
  schemaSearchMatches: { type: Array, default: () => [] },
  schemaSearchIndex: { type: Number, default: -1 },
  schemaSearchSummary: { type: String, default: "" },
  getInsertRows: { type: Function, default: () => [] },
  getInsertDraft: { type: Function, default: () => ({}) },
  getInsertRowKey: { type: Function, default: () => "" },
  isInsertRowVisible: { type: Function, default: () => false },
  isColumnSelected: { type: Function, default: () => false },
});

const emit = defineEmits([
  'grid-ready',
  'scroll',
  'keydown',
  'cell-click',
  'cell-mousedown',
  'cell-enter',
  'range-pointer',
  'range-end',
  'cell-dblclick',
  'cell-blur',
  'edit-input',
  'finish-edit',
  'cancel-edit',
  'tab-edit',
  'toggle-sort',
  'apply-sort',
  'toggle-row-select',
  'row-select-start',
  'row-select-pointer',
  'row-select-end',
  'toggle-all-rows',
  'insert-input',
  'insert-paste',
  'insert-focus',
  'insert-keydown',
  'insert-row-select',
  'open-split-menu',
  'search-ready',
  'search-input',
  'search-previous',
  'search-next',
  'schema-search-previous',
  'schema-search-next',
  'contextmenu',
  'select-column',
]);

function colStyle(tabId, colName) {
  const w = getColumnWidth(tabId, colName);
  return w ? { width: w + 'px', minWidth: w + 'px', maxWidth: w + 'px' } : {};
}

function tabScopeKey(tab) {
  return tab?.tableKey || tab?.tableName || "";
}

let lastScrollPerfSampleAt = 0;

function onGridWrapScroll(event) {
  emit('scroll', event);
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  if (now - lastScrollPerfSampleAt > 250) {
    lastScrollPerfSampleAt = now;
    sampleNextFrame("grid.scroll.frame", {
      tableName: props.tab?.tableName || "",
      loadedRows: props.tab?.rows?.length || 0,
      visibleRows: props.visibleRows.length,
      columns: props.activeColumns.length,
    });
  }
}

function isPrimaryKeyColumn(column) {
  const name = columnName(column);
  return Boolean(
    column?.is_primary_key ||
    column?.isPrimaryKey ||
    (name && props.tab?.primaryKeys?.includes?.(name))
  );
}

function insertRowObject(insertRow) {
  return { ...(insertRow?.draft || {}), __insertRowId: insertRow?.id };
}

function insertRowKey(tab, insertRow) {
  return props.getInsertRowKey(tab, insertRow?.id);
}

function insertRowCellValue(tab, insertRow, column) {
  return props.getInsertDraft(tab, insertRow?.id)[columnName(column)] || "";
}

function highlightInsertCell(tab, insertRow, column) {
  return escapeHtml(insertRowCellValue(tab, insertRow, column));
}

function isSearchMatchCell(tab, row, column, rowKey) {
  return props.highlightCell(tab, row, column, rowKey).includes("<mark>");
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

function continueRangeSelection(event) {
  if (!props.isSelectingRange) return;
  emit('range-pointer', event);
}

function continueRowDragSelection(event) {
  if (!isRowDragging.value) return;
  emit('row-select-pointer', props.tab, event);
}

function endRangeSelection() {
  emit('range-end');
}

function endRowSelection() {
  if (!isRowDragging.value) return;
  isRowDragging.value = false;
  emit('row-select-end');
}

function onRowSelectStart(tab, row, originalIndex, event) {
  isRowDragging.value = true;
  emit('row-select-start', tab, row, originalIndex, event, gridWrapRef.value);
}

function onColumnHeaderMouseDown(tab, name, event) {
  if (event.target.closest('.wb-col-resize') || event.target.closest('.wb-sort-menu')) return;
  emit('select-column', tab, name, event);
}

function setFilterMode(mode) {
  const tab = props.tab;
  if (!tab || tab.filterMode === mode) return;
  tab.filterMode = mode;
  if (tab.filter) emit('search-input', tab.filter);
}

// ── Adaptive column width ──────────────────────────────────────────────────

let resizeObserver = null;

function performAutoFit() {
  const tab = props.tab;
  if (!tab || !gridWrapRef.value || !props.activeColumns.length) return;
  autoFitColumns(gridWrapRef.value, tab.id, props.activeColumns, tab.rows || []);
}

function setupResizeObserver() {
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  if (!gridWrapRef.value) return;
  resizeObserver = new ResizeObserver(() => {
    if (suspendGridAutoFit.value) return;
    const tab = props.tab;
    if (!tab || !gridWrapRef.value || !props.activeColumns.length) return;
    autoFitDebounced(gridWrapRef.value, tab.id, props.activeColumns, tab.rows || []);
  });
  resizeObserver.observe(gridWrapRef.value);
}

watch(suspendGridAutoFit, (suspended, wasSuspended) => {
  if (wasSuspended && !suspended) {
    nextTick(() => performAutoFit());
  }
});

// Re-fit when columns change (new table loaded or page refreshed)
watch(
  () => [props.tab?.id, props.activeColumns.length, props.tab?.loading],
  ([tabId, colCount, loading]) => {
    if (!tabId || !colCount || loading) return;
    nextTick(() => performAutoFit());
  },
);

// Re-fit when tab switches (active tab changed)
watch(
  () => props.tab?.id,
  () => {
    nextTick(() => {
      performAutoFit();
      setupResizeObserver();
    });
  },
);

onMounted(() => {
  emit('grid-ready', gridWrapRef.value);
  emit('search-ready', searchInputRef.value);
  window.addEventListener('mousemove', continueRangeSelection);
  window.addEventListener('mousemove', continueRowDragSelection);
  window.addEventListener('mouseup', endRangeSelection);
  window.addEventListener('mouseup', endRowSelection);

  // Initial auto-fit after mount
  nextTick(() => {
    performAutoFit();
    setupResizeObserver();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', continueRangeSelection);
  window.removeEventListener('mousemove', continueRowDragSelection);
  window.removeEventListener('mouseup', endRangeSelection);
  window.removeEventListener('mouseup', endRowSelection);
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

</script>

<template>
  <section v-if="tab" class="wb-table-panel" @contextmenu.prevent.stop="emit('contextmenu', $event)">
    <header class="wb-table-toolbar">
      <input
        ref="searchInputRef"
        v-model="tab.filter"
        :placeholder="'搜索当前表（' + (tab.filterMode === 'exact' ? '精确' : '模糊') + '）'"
        @input="emit('search-input', tab.filter)"
        @keydown.enter.prevent="emit('search-next')"
      />
      <div class="wb-filter-mode-segment" role="group" aria-label="搜索模式">
        <button
          type="button"
          class="wb-filter-mode-option"
          :class="{ 'is-active': tab.filterMode !== 'exact' }"
          :aria-pressed="tab.filterMode !== 'exact'"
          @click="setFilterMode('fuzzy')"
        >模糊</button>
        <button
          type="button"
          class="wb-filter-mode-option"
          :class="{ 'is-active': tab.filterMode === 'exact' }"
          :aria-pressed="tab.filterMode === 'exact'"
          @click="setFilterMode('exact')"
        >精确</button>
      </div>
      <button
        class="wb-search-nav-btn"
        type="button"
        :disabled="!hasSearchMatches"
        @click="emit('search-previous')"
      >上一个</button>
      <button
        class="wb-search-nav-btn"
        type="button"
        :disabled="!hasSearchMatches"
        @click="emit('search-next')"
      >下一个</button>
      <span v-if="schemaSearchMatches.length" class="wb-schema-search-nav" role="group" aria-label="结构命中导航">
        <span>{{ schemaSearchSummary }}</span>
        <button
          class="wb-search-nav-btn"
          type="button"
          @click="emit('schema-search-previous')"
        >上一个</button>
        <button
          class="wb-search-nav-btn"
          type="button"
          @click="emit('schema-search-next')"
        >下一个</button>
      </span>
      <button
        type="button"
        class="wb-split-more-btn"
        title="更多选项"
        aria-label="更多选项"
        :aria-expanded="splitMenuOpen ? 'true' : 'false'"
        @click.stop="emit('open-split-menu', $event)"
      >
        <span class="wb-split-more-dots" aria-hidden="true"></span>
      </button>
    </header>

    <div class="wb-grid-shell">
      <div
        ref="gridWrapRef"
        class="wb-grid-wrap"
        :class="{ 'is-selecting-range': isSelectingRange }"
        tabindex="0"
        @scroll="onGridWrapScroll"
        @keydown="emit('keydown', $event)"
      >
        <div v-if="tab.loading" class="wb-grid-loading">加载中…</div>
        <table class="wb-grid">
        <thead>
          <tr>
            <th
              class="wb-row-index wb-row-index-corner"
              :class="{ 'row-selected': tab.rows.length > 0 && tab.selectedRowKeys.size === tab.rows.length }"
              title="选择全部行"
              @click="emit('toggle-all-rows', tab)"
            ></th>
            <th
            v-for="(column, columnIndex) in activeColumns"
            :key="columnName(column)"
            :style="colStyle(tab.id, columnName(column))"
            :data-column-index="columnIndex"
            :class="{
              'schema-search-match': isSchemaSearchColumn(column),
              'schema-search-active': isActiveSchemaSearchColumn(column),
              'col-selected': isColumnSelected(tab, columnIndex),
            }"
            @mousedown.left="onColumnHeaderMouseDown(tab, columnName(column), $event)"
            >
              <span class="wb-th-text" :title="column.column_comment || ''">{{ columnName(column) }}</span>
              <ColumnSortMenu
                :column="columnName(column)"
                :sort="tab.sort"
                @apply-sort="emit('apply-sort', tab, columnName(column), $event)"
              />
              <span
                class="wb-col-resize"
                @mousedown.prevent.stop="onHandleMouseDown($event, tab.id, columnName(column))"
              ></span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="virtualRange.padTop > 0" aria-hidden="true" class="wb-virtual-spacer">
            <td :style="{ height: virtualRange.padTop + 'px' }" :colspan="1 + activeColumns.length"></td>
          </tr>
          <tr
            v-for="{ row, originalIndex, rowKey } in visibleRows"
            :key="rowKey"
            class="wb-grid-row"
            :class="{
              'row-even': originalIndex % 2 === 1,
              'row-selected': tab.selectedRowKeys.has(rowKey),
              'row-active': selectedCell?.tabId === tab.id && selectedCell?.rowKey === rowKey,
            }"
          >
            <td
              class="wb-row-index wb-row-header"
              :class="{ 'row-selected': tab.selectedRowKeys.has(rowKey) }"
              title="选择整行"
              @mousedown.left.stop.prevent="onRowSelectStart(tab, row, originalIndex, $event)"
              @click.stop="emit('toggle-row-select', tab, row, $event)"
            >{{ originalIndex + 1 }}</td>
            <td
              v-for="(column, columnIndex) in activeColumns"
              :key="columnName(column)"
              :style="colStyle(tab.id, columnName(column))"
              :data-column-index="columnIndex"
              :data-row-key="rowKey"
              :data-column-name="columnName(column)"
              :title="getCellError(editState, tabScopeKey(tab), rowKey, columnName(column)) || ''"
              :class="{
                pending: isCellPending(editState, tabScopeKey(tab), rowKey, columnName(column)),
                error: getCellError(editState, tabScopeKey(tab), rowKey, columnName(column)),
                selected: selectedCell?.rowKey === rowKey && selectedCell?.column === columnName(column) && selectedCell?.tabId === tab.id,
                editing: editingCell?.rowKey === rowKey && editingCell?.column === columnName(column),
                'search-match': isSearchMatchCell(tab, row, columnName(column), rowKey),
                'is-null': row[columnName(column)] == null,
                ...getCellRangeClasses(tab, rowKey, columnName(column), originalIndex, columnIndex),
              }"
              @mousedown.left="emit('cell-mousedown', tab, row, columnName(column), originalIndex, columnIndex, $event)"
              @mouseenter="emit('cell-enter', tab, row, columnName(column), originalIndex, columnIndex)"
              @mouseup="emit('range-end')"
              @click="emit('cell-click', tab, row, columnName(column), originalIndex, columnIndex)"
              @dblclick="emit('cell-dblclick', tab, row, columnName(column), originalIndex, columnIndex)"
            >
              <input
                v-if="editingCell?.rowKey === rowKey && editingCell?.column === columnName(column)"
                :value="editDraft"
                :data-row-index="originalIndex"
                :data-column-index="columnIndex"
                @input="emit('edit-input', $event.target.value)"
                @blur="emit('cell-blur')"
                @keydown.enter.prevent.stop="emit('finish-edit')"
                @keydown.escape.prevent.stop="emit('cancel-edit')"
                @keydown.tab.prevent.stop="emit('tab-edit', $event.shiftKey)"
              />
              <span v-else class="wb-cell-text" v-html="highlightCell(tab, row, columnName(column), rowKey)"></span>
            </td>
          </tr>
          <tr v-if="virtualRange.totalHeight - virtualRange.padTop - visibleRows.length * GRID_ROW_HEIGHT > 0" aria-hidden="true" class="wb-virtual-spacer">
            <td :style="{ height: (virtualRange.totalHeight - virtualRange.padTop - visibleRows.length * GRID_ROW_HEIGHT) + 'px' }" :colspan="1 + activeColumns.length"></td>
          </tr>
          <tr
            v-for="(insertRow, insertRowIndex) in isInsertRowVisible(tab) ? getInsertRows(tab) : []"
            :key="insertRow.id"
            class="wb-insert-row"
            :class="{ 'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id }"
          >
            <td
              class="wb-row-index wb-row-insert-marker wb-row-header"
              :class="{ 'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id }"
              title="选择新增行"
              @mousedown.stop.prevent
              @click.stop="emit('insert-row-select', tab, insertRow.id, $event)"
            >{{ tab.rows.length + insertRowIndex + 1 }}</td>
            <td
              v-for="(column, columnIndex) in activeColumns"
              :key="`insert-${insertRow.id}-${columnName(column)}`"
              :style="colStyle(tab.id, columnName(column))"
              :data-column-index="columnIndex"
              :data-row-key="insertRowKey(tab, insertRow)"
              :data-column-name="columnName(column)"
              :title="getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnName(column)) || ''"
              :class="{
                pending: isCellPending(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnName(column)),
                error: getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnName(column)),
                selected: selectedCell?.rowKey === insertRowKey(tab, insertRow) && selectedCell?.column === columnName(column) && selectedCell?.tabId === tab.id,
                editing: editingCell?.rowKey === insertRowKey(tab, insertRow) && editingCell?.column === columnName(column),
                'insert-selected': selectedInsertCell?.tabId === tab.id && selectedInsertCell?.rowId === insertRow.id && selectedInsertCell?.columnIndex === columnIndex,
                ...getCellRangeClasses(tab, insertRowKey(tab, insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex),
              }"
              @mousedown.left="emit('cell-mousedown', tab, insertRowObject(insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex, $event)"
              @mouseenter="emit('cell-enter', tab, insertRowObject(insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex)"
              @mouseup="emit('range-end')"
              @click="emit('cell-click', tab, insertRowObject(insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex)"
              @dblclick="emit('cell-dblclick', tab, insertRowObject(insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex)"
            >
              <input
                v-if="editingCell?.rowKey === insertRowKey(tab, insertRow) && editingCell?.column === columnName(column)"
                :value="editDraft"
                :data-insert-row-id="insertRow.id"
                :data-insert-column-index="columnIndex"
                :data-row-index="tab.rows.length + insertRowIndex"
                :data-column-index="columnIndex"
                :placeholder="isPrimaryKeyColumn(column) ? 'auto' : ''"
                @focus="emit('insert-focus', tab, insertRow.id, columnIndex)"
                @input="emit('edit-input', $event.target.value)"
                @paste.prevent.stop="emit('insert-paste', tab, insertRow.id, columnIndex, $event)"
                @keydown.arrow-up.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.arrow-down.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.arrow-left.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.arrow-right.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.tab.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.escape.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @blur="emit('cell-blur')"
                @keydown.enter.prevent.stop="emit('finish-edit')"
              />
              <span v-else class="wb-cell-text" v-html="highlightInsertCell(tab, insertRow, column)"></span>
            </td>
          </tr>
        </tbody>
        </table>
      </div>
    </div>

  </section>

  <section v-else class="wb-empty">
    从左侧打开一张表，或使用快捷搜索定位。
  </section>
</template>
