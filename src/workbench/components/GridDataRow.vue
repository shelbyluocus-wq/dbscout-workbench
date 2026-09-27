<script setup>
import { t } from "../i18n/index.js";
defineProps({
  tabId: String,
  row: Object,
  rowKey: String,
  rowVersion: Number,
  originalIndex: Number,
  visualIndex: Number,
  rowNumber: Number,
  columns: Array,
  frozenColumnCount: Number,
  frozenStyle: Object,
  lastFrozenRow: Boolean,
  isActiveRow: Boolean,
  selectedColumn: String,
  editingColumn: String,
  editDraft: String,
  rowSelected: Boolean,
  inRowRange: Boolean,
  rangeClasses: Object,
  cellState: Object,
  hasActiveCellSearch: Boolean,
  displayText: Function,
  highlightHtml: Function,
  isSearchMatch: Function,
  cellDomId: Function,
});
const emit = defineEmits(["row-select-start", "toggle-row-select", "row-contextmenu", "row-resize-start", "row-resize-reset", "edit-input", "cell-blur", "finish-edit", "cancel-edit", "tab-edit"]);
</script>

<template>
            <tr
              class="wb-grid-row"
              :data-frozen="Boolean(frozenStyle) || undefined"
              :data-row-selection-index="visualIndex"
              :class="{
                'row-even': visualIndex % 2 === 1,
                'wb-frozen-row': Boolean(frozenStyle),
                'frozen-row-edge': lastFrozenRow,
                'row-selected': rowSelected,
                'row-active': isActiveRow,
                'row-range-active': inRowRange,
              }"
            >
              <td
                class="wb-row-index wb-row-header"
                role="rowheader"
                :style="frozenStyle"
                :class="{ 'wb-frozen-row-index': Boolean(frozenStyle), 'row-selected': rowSelected }"
                :title="t('m_c95d805368bd')"
                @mousedown.left.stop.prevent="emit('row-select-start', row, visualIndex, $event)"
                @click.stop="emit('toggle-row-select', row, $event)"
                @contextmenu.prevent.stop="emit('row-contextmenu', $event, row, originalIndex)"
              >
                {{ rowNumber }}
                <span
                  class="wb-row-resize-handle"
                  role="separator"
                  aria-orientation="horizontal"
                  :aria-label="t('m_50393189c2e8')"
                  :title="t('m_aff65da3daa5')"
                  @pointerdown="emit('row-resize-start', $event)"
                  @dblclick.stop.prevent="emit('row-resize-reset')"
                ></span>
              </td>
<template v-for="columnMeta in columns" :key="columnMeta.name">
<td v-if="columnMeta.kind === 'spacer'" class="wb-col-spacer" aria-hidden="true" :style="columnMeta.cellStyle"></td>
              <td
                v-else
                :style="frozenStyle ? { ...columnMeta.cellStyle, ...frozenStyle } : columnMeta.cellStyle"
                :data-column-index="columnMeta.columnIndex"
                :aria-colindex="columnMeta.columnIndex + 2"
                :data-row-key="rowKey"
                :data-original-index="originalIndex"
                :data-visual-row-index="visualIndex"
                :data-column-name="columnMeta.name"
                :id="isActiveRow ? cellDomId(tabId, rowKey, columnMeta.name) : undefined"
                role="gridcell"
                :aria-selected="rangeClasses?.[columnMeta.name]?.['range-selected'] === true"
                :aria-invalid="Boolean(cellState?.errors.get(columnMeta.name))"
                :aria-busy="cellState?.pending.has(columnMeta.name) === true"
                :title="cellState?.errors.get(columnMeta.name) || ''"
                :class="{
                  pending: cellState?.pending.has(columnMeta.name) === true,
                  error: cellState?.errors.get(columnMeta.name),
                  selected: selectedColumn === columnMeta.name,

                  'is-numeric-col': columnMeta.isNumeric,
                  editing: editingColumn === columnMeta.name,
                  'row-selected': rowSelected,
                  'search-match': hasActiveCellSearch && isSearchMatch(row, columnMeta.name, rowKey),
                  'is-null': row[columnMeta.name] == null,
                  ...(rangeClasses?.[columnMeta.name] || {}),
                  'frozen-col': !frozenStyle && columnMeta.columnIndex < frozenColumnCount,
                  'frozen-row': Boolean(frozenStyle) && columnMeta.columnIndex >= frozenColumnCount,
                  'frozen-corner': Boolean(frozenStyle) && columnMeta.columnIndex < frozenColumnCount,
                  'frozen-col-edge': frozenColumnCount > 0 && columnMeta.columnIndex === frozenColumnCount - 1,
                }"
              >
                <input
                  v-if="editingColumn === columnMeta.name"
                  :value="editDraft"
                  :data-row-index="visualIndex"
                  :data-column-index="columnMeta.columnIndex"
                :aria-colindex="columnMeta.columnIndex + 2"
                  @input="emit('edit-input', $event.target.value)"
                  @blur="emit('cell-blur')"
                  @dblclick.stop
                  @keydown.enter.prevent.stop="emit('finish-edit')"
                  @keydown.escape.prevent.stop="emit('cancel-edit')"
                  @keydown.tab.prevent.stop="emit('tab-edit', $event.shiftKey)"
                />
                <span v-else-if="row[columnMeta.name] == null" class="wb-null-badge" :aria-label="t('m_122f6009c477')">NULL</span>
                <span v-else-if="hasActiveCellSearch" class="wb-cell-text" v-html="highlightHtml(row, columnMeta.name, rowKey)"></span>
                <span v-else class="wb-cell-text">{{ displayText(row, columnMeta.name, rowKey) }}</span>
              </td>
</template>
            </tr>
</template>
