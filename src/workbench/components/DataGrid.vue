<script setup>
import { onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import { isCellPending, getCellError } from "../editState.js";
import { columnName } from "../utils/normalize.js";
import { GRID_ROW_HEIGHT } from "../constants.js";
import { useColumnResize } from "../composables/useColumnResize.js";

const gridWrapRef = ref(null);
defineExpose({ gridWrapRef });

const {
  getColumnWidth,
  onHandleMouseDown,
  wasDragJustEnded,
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
  editState: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  highlightCell: { type: Function, default: () => "" },
  getInsertDraft: { type: Function, default: () => ({}) },
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
  'toggle-row-select',
  'toggle-all-rows',
  'insert-input',
  'insert-commit',
  'insert-focus',
  'insert-keydown',
  'export',
  'import',
  'filter-page',
  'contextmenu',
]);

function colStyle(tabId, colName) {
  const w = getColumnWidth(tabId, colName);
  return w ? { width: w + 'px', minWidth: w + 'px', maxWidth: w + 'px' } : {};
}

function tabScopeKey(tab) {
  return tab?.tableKey || tab?.tableName || "";
}

function onGridWrapScroll(event) {
  emit('scroll', event);
}

function onHeaderClick(tab, colName) {
  if (wasDragJustEnded()) return;
  emit('toggle-sort', tab, colName);
}

function continueRangeSelection(event) {
  if (!props.isSelectingRange) return;
  emit('range-pointer', event);
}

function endRangeSelection() {
  emit('range-end');
}

// ── Adaptive column width ──────────────────────────────────────────────────

let resizeObserver = null;

function performAutoFit() {
  const tab = props.tab;
  if (!tab || !gridWrapRef.value || !props.activeColumns.length) return;
  autoFitColumns(gridWrapRef.value, tab.id, props.activeColumns);
}

function setupResizeObserver() {
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  if (!gridWrapRef.value) return;
  resizeObserver = new ResizeObserver(() => {
    const tab = props.tab;
    if (!tab || !gridWrapRef.value || !props.activeColumns.length) return;
    autoFitDebounced(gridWrapRef.value, tab.id, props.activeColumns);
  });
  resizeObserver.observe(gridWrapRef.value);
}

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
  window.addEventListener('mousemove', continueRangeSelection);
  window.addEventListener('mouseup', endRangeSelection);

  // Initial auto-fit after mount
  nextTick(() => {
    performAutoFit();
    setupResizeObserver();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', continueRangeSelection);
  window.removeEventListener('mouseup', endRangeSelection);
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

</script>

<template>
  <section v-if="tab" class="wb-table-panel" @contextmenu.prevent.stop="emit('contextmenu', $event)">
    <header class="wb-table-toolbar">
      <input v-model="tab.filter" :placeholder="'搜索当前表（' + (tab.filterMode === 'exact' ? '精确' : '模糊') + '）'" @keydown.enter.prevent="emit('filter-page', tab, 1)" />
      <button class="wb-filter-mode-btn" @click="tab.filterMode = tab.filterMode === 'exact' ? 'fuzzy' : 'exact'; if (tab.filter) emit('filter-page', tab, 1)">{{ tab.filterMode === 'exact' ? '精确' : '模糊' }}</button>
      <button @click="emit('export')" :disabled="busy">导出</button>
      <button @click="emit('import')" :disabled="busy || !tab?.sessionId">导入</button>
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
        <div v-if="tab.loading" class="wb-grid-loading">加载中...</div>
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
            @click="onHeaderClick(tab, columnName(column))"
            >
              <span class="wb-th-text" :title="column.column_comment || ''">{{ columnName(column) }}</span>
              <span v-if="tab.sort?.columnName === columnName(column)" class="wb-th-sort">
                {{ tab.sort.descending ? "↓" : "↑" }}
              </span>
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
              @mousedown.stop.prevent
              @click.stop="emit('toggle-row-select', tab, row, $event)"
            >{{ originalIndex + 1 }}</td>
            <td
              v-for="(column, columnIndex) in activeColumns"
              :key="columnName(column)"
              :style="colStyle(tab.id, columnName(column))"
              :data-column-index="columnIndex"
              :title="getCellError(editState, tabScopeKey(tab), rowKey, columnName(column)) || ''"
              :class="{
                pending: isCellPending(editState, tabScopeKey(tab), rowKey, columnName(column)),
                error: getCellError(editState, tabScopeKey(tab), rowKey, columnName(column)),
                selected: selectedCell?.rowKey === rowKey && selectedCell?.column === columnName(column) && selectedCell?.tabId === tab.id,
                editing: editingCell?.rowKey === rowKey && editingCell?.column === columnName(column),
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
          <tr class="wb-insert-row">
            <td class="wb-row-index wb-row-insert-marker">*</td>
            <td
              v-for="(column, columnIndex) in activeColumns"
              :key="`insert-${columnName(column)}`"
              :style="colStyle(tab.id, columnName(column))"
              :class="{ 'insert-selected': selectedInsertCell?.tabId === tab.id && selectedInsertCell?.columnIndex === columnIndex }"
            >
              <input
                :value="getInsertDraft(tab)[columnName(column)] || ''"
                :data-insert-column-index="columnIndex"
                :placeholder="column.is_primary_key ? 'auto' : ''"
                @focus="emit('insert-focus', tab, columnIndex)"
                @input="emit('insert-input', tab, columnName(column), $event.target.value)"
                @keydown.enter.prevent.stop="emit('insert-commit', tab)"
                @keydown.arrow-up.prevent.stop="emit('insert-keydown', tab, columnIndex, $event)"
                @keydown.arrow-down.prevent.stop="emit('insert-keydown', tab, columnIndex, $event)"
                @keydown.arrow-left.prevent.stop="emit('insert-keydown', tab, columnIndex, $event)"
                @keydown.arrow-right.prevent.stop="emit('insert-keydown', tab, columnIndex, $event)"
                @keydown.tab.prevent.stop="emit('insert-keydown', tab, columnIndex, $event)"
                @keydown.escape.prevent.stop="emit('insert-keydown', tab, columnIndex, $event)"
              />
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
