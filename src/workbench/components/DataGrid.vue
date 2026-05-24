<script setup>
import { ref } from "vue";
import { isCellPending, getCellError } from "../editState.js";
import { columnName } from "../utils/normalize.js";
import { GRID_ROW_HEIGHT } from "../constants.js";
import { useColumnResize } from "../composables/useColumnResize.js";

const gridWrapRef = ref(null);
defineExpose({ gridWrapRef });

const { getColumnWidth, onHandleMouseDown, wasDragJustEnded } = useColumnResize();

const props = defineProps({
  tab: { type: Object, default: null },
  activeColumns: { type: Array, default: () => [] },
  visibleRows: { type: Array, default: () => [] },
  virtualRange: { type: Object, default: () => ({ start: 0, end: 0, padTop: 0, totalHeight: 0 }) },
  selectedCell: { type: Object, default: null },
  editingCell: { type: Object, default: null },
  editDraft: { type: String, default: "" },
  editState: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  highlightCell: { type: Function, default: () => "" },
  getInsertDraft: { type: Function, default: () => ({}) },
});

const emit = defineEmits([
  'scroll',
  'keydown',
  'cell-click',
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
  'delete-selected',
  'export',
  'import',
  'filter-page',
]);

function colStyle(tabId, colName) {
  const w = getColumnWidth(tabId, colName);
  return w ? { width: w + 'px', minWidth: w + 'px', maxWidth: w + 'px' } : {};
}

function onHeaderClick(tab, colName) {
  if (wasDragJustEnded()) return;
  emit('toggle-sort', tab, colName);
}
</script>

<template>
  <section v-if="tab" class="wb-table-panel">
    <header class="wb-table-toolbar">
      <div class="wb-object-heading">
        <strong>{{ tab.tableName }}</strong>
        <span>{{ tab.totalRows }} 行</span>
      </div>
      <input v-model="tab.filter" :placeholder="'搜索当前表（' + (tab.filterMode === 'exact' ? '精确' : '模糊') + '）'" @keydown.enter.prevent="emit('filter-page', tab, 1)" />
      <button class="wb-filter-mode-btn" @click="tab.filterMode = tab.filterMode === 'exact' ? 'fuzzy' : 'exact'; if (tab.filter) emit('filter-page', tab, 1)">{{ tab.filterMode === 'exact' ? '精确' : '模糊' }}</button>
      <button @click="emit('export')" :disabled="busy">导出</button>
      <button @click="emit('import')" :disabled="busy || !tab?.sessionId">导入</button>
    </header>

    <div
      ref="gridWrapRef"
      class="wb-grid-wrap"
      tabindex="0"
      @scroll="emit('scroll', $event)"
      @keydown="emit('keydown', $event)"
    >
      <div v-if="tab.loading" class="wb-grid-loading">加载中...</div>
      <table class="wb-grid">
        <thead>
          <tr>
            <th class="wb-row-index"><input type="checkbox" class="wb-select-all" :checked="tab.rows.length > 0 && tab.selectedRowKeys.size === tab.rows.length" @change="emit('toggle-all-rows', tab)" /></th>
            <th
            v-for="(column, columnIndex) in activeColumns"
            :key="columnName(column)"
            :style="colStyle(tab.id, columnName(column))"
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
            :class="{ 'row-even': originalIndex % 2 === 1 }"
          >
            <td class="wb-row-index"><input type="checkbox" :checked="tab.selectedRowKeys.has(rowKey)" @click="emit('toggle-row-select', tab, row, $event)" /></td>
            <td
              v-for="(column, columnIndex) in activeColumns"
              :key="columnName(column)"
              :style="colStyle(tab.id, columnName(column))"
              :class="{
                pending: isCellPending(editState, tab.tableName, rowKey, columnName(column)),
                error: getCellError(editState, tab.tableName, rowKey, columnName(column)),
                selected: selectedCell?.rowKey === rowKey && selectedCell?.column === columnName(column) && selectedCell?.tabId === tab.id,
                editing: editingCell?.rowKey === rowKey && editingCell?.column === columnName(column),
                'is-null': row[columnName(column)] == null,
              }"
              @click="emit('cell-click', tab, row, columnName(column), originalIndex, columnIndex)"
            >
              <input
                v-if="editingCell?.rowKey === rowKey && editingCell?.column === columnName(column)"
                :value="editDraft"
                :data-row-index="originalIndex"
                :data-column-index="columnIndex"
                @input="emit('edit-input', $event.target.value)"
                @blur="emit('cell-blur')"
                @keydown.enter.prevent="emit('finish-edit')"
                @keydown.escape.prevent="emit('cancel-edit')"
                @keydown.tab.prevent="emit('tab-edit', $event.shiftKey)"
              />
              <span v-else class="wb-cell-text" v-html="highlightCell(tab, row, columnName(column), rowKey)"></span>
            </td>
          </tr>
          <tr v-if="virtualRange.totalHeight - virtualRange.padTop - visibleRows.length * GRID_ROW_HEIGHT > 0" aria-hidden="true" class="wb-virtual-spacer">
            <td :style="{ height: (virtualRange.totalHeight - virtualRange.padTop - visibleRows.length * GRID_ROW_HEIGHT) + 'px' }" :colspan="1 + activeColumns.length"></td>
          </tr>
          <tr class="wb-insert-row">
            <td class="wb-row-index">*</td>
            <td v-for="(column, columnIndex) in activeColumns" :key="`insert-${columnName(column)}`" :style="colStyle(tab.id, columnName(column))">
              <input
                :value="getInsertDraft(tab)[columnName(column)] || ''"
                :data-column-index="columnIndex"
                :placeholder="column.is_primary_key ? 'auto' : ''"
                @focus="emit('insert-focus')"
                @input="emit('insert-input', tab, columnName(column), $event.target.value)"
                @keydown.enter.prevent="emit('insert-commit', tab)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="tab.selectedRowKeys.size > 0" class="wb-batch-bar">
      <button class="wb-batch-delete" @click="emit('delete-selected', tab)">删除 {{ tab.selectedRowKeys.size }} 行</button>
    </div>

  </section>

  <section v-else class="wb-empty">
    从左侧打开一张表，或使用快捷搜索定位。
  </section>
</template>
