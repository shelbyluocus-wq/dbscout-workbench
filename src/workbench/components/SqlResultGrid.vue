<script setup>
import { computed, reactive, ref, watch } from "vue";
import { ClipboardCopy, Download, Filter, Rows3, TableProperties } from "lucide-vue-next";

const props = defineProps({
  result: { type: Object, default: null },
  invokeWorkbench: { type: Function, required: true },
});
const filter = ref("");
const sort = reactive({ column: "", descending: false });
const scrollTop = ref(0);
const viewportHeight = ref(240);
const resultScrollRef = ref(null);
const widths = reactive({});
const selection = reactive({ startRow: -1, startColumn: -1, endRow: -1, endColumn: -1, dragging: false });
const ROW_HEIGHT = 28;
const BUFFER = 10;

const columns = computed(() => props.result?.columns || []);
function columnName(column) { return column?.name || column?.columnName || column?.column_name || ""; }
function rawValue(row, column) { return row?.[column?.key || columnName(column)]; }
function displayValue(value) {
  if (value == null) return "NULL";
  if (value && typeof value === "object" && value.kind === "binary") return `[二进制 ${value.length || 0} B]`;
  if (value && typeof value === "object" && Object.hasOwn(value, "value")) return String(value.value ?? "NULL");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
const filteredRows = computed(() => {
  let rows = Array.isArray(props.result?.rows) ? [...props.result.rows] : [];
  const query = filter.value.trim().toLocaleLowerCase();
  if (query) rows = rows.filter((row) => columns.value.some((column) => displayValue(rawValue(row, column)).toLocaleLowerCase().includes(query)));
  if (sort.column) rows.sort((left, right) => {
    const column = columns.value.find((item) => columnName(item) === sort.column) || { name: sort.column };
    const a = rawValue(left, column);
    const b = rawValue(right, column);
    const result = typeof a === "number" && typeof b === "number" ? a - b : displayValue(a).localeCompare(displayValue(b), "zh-CN", { numeric: true });
    return sort.descending ? -result : result;
  });
  return rows;
});
const range = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - BUFFER);
  const count = Math.ceil(viewportHeight.value / ROW_HEIGHT) + BUFFER * 2;
  return { start, end: Math.min(filteredRows.value.length, start + count) };
});
const visibleRows = computed(() => filteredRows.value.slice(range.value.start, range.value.end));
const selectionBounds = computed(() => {
  if (selection.startRow < 0 || selection.startColumn < 0) return null;
  return {
    top: Math.min(selection.startRow, selection.endRow),
    bottom: Math.max(selection.startRow, selection.endRow),
    left: Math.min(selection.startColumn, selection.endColumn),
    right: Math.max(selection.startColumn, selection.endColumn),
  };
});

function onScroll(event) {
  scrollTop.value = event.currentTarget.scrollTop;
  viewportHeight.value = event.currentTarget.clientHeight;
}
function toggleSort(column) {
  const name = columnName(column);
  if (sort.column === name) sort.descending = !sort.descending;
  else Object.assign(sort, { column: name, descending: false });
  clearSelection();
}
async function copyText(text) { await navigator.clipboard?.writeText?.(text); }
function copyRows(withHeader = false) {
  const bounds = selectionBounds.value;
  const selectedColumns = bounds ? columns.value.slice(bounds.left, bounds.right + 1) : columns.value;
  const selectedRows = bounds ? filteredRows.value.slice(bounds.top, bounds.bottom + 1) : filteredRows.value;
  const lines = selectedRows.map((row) => selectedColumns.map((column) => displayValue(rawValue(row, column))).join("\t"));
  if (withHeader) lines.unshift(selectedColumns.map(columnName).join("\t"));
  return copyText(lines.join("\n"));
}
async function exportResult(format) {
  const names = columns.value.map(columnName);
  let data;
  let fileName = `query-result.${format}`;
  if (format === "csv") {
    const escape = (value) => `"${String(value).replaceAll('"', '""')}"`;
    data = new TextEncoder().encode([names, ...filteredRows.value.map((row) => columns.value.map((column) => displayValue(rawValue(row, column))))].map((row) => row.map(escape).join(",")).join("\r\n"));
  } else {
    const XLSX = await import("xlsx");
    const sheet = XLSX.utils.aoa_to_sheet([names, ...filteredRows.value.map((row) => columns.value.map((column) => rawValue(row, column)))]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Result");
    data = new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "array" }));
  }
  await props.invokeWorkbench("save_sql_result_file", { fileName, data: Array.from(data) });
}
function beginResize(column, event) {
  const name = columnName(column);
  const startX = event.clientX;
  const startWidth = widths[name] || 160;
  const move = (moveEvent) => { widths[name] = Math.max(80, Math.min(520, startWidth + moveEvent.clientX - startX)); };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
function clearSelection() {
  Object.assign(selection, { startRow: -1, startColumn: -1, endRow: -1, endColumn: -1, dragging: false });
}
function beginSelection(row, column, event) {
  if (event.button !== 0) return;
  resultScrollRef.value?.focus({ preventScroll: true });
  Object.assign(selection, { startRow: row, startColumn: column, endRow: row, endColumn: column, dragging: true });
  const up = () => {
    selection.dragging = false;
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointerup", up);
}
function extendSelection(row, column) {
  if (!selection.dragging) return;
  selection.endRow = row;
  selection.endColumn = column;
}
function selectRow(row, event) {
  beginSelection(row, 0, event);
  selection.endColumn = Math.max(0, columns.value.length - 1);
}
function isSelected(row, column) {
  const bounds = selectionBounds.value;
  return Boolean(bounds && row >= bounds.top && row <= bounds.bottom && column >= bounds.left && column <= bounds.right);
}
function handleGridKeydown(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "c" || !selectionBounds.value) return;
  event.preventDefault();
  void copyRows(event.shiftKey);
}
function sortAria(column) {
  if (sort.column !== columnName(column)) return "none";
  return sort.descending ? "descending" : "ascending";
}
watch(filter, clearSelection);
</script>

<template>
  <section class="wb-sql-result-grid">
    <header class="wb-sql-result-tools">
      <label><Filter :size="14" /><input v-model="filter" type="search" placeholder="筛选当前结果" /></label>
      <span><Rows3 :size="14" />{{ filteredRows.length }} 行</span>
      <button type="button" title="复制所选数据；无选择时复制全部" @click="copyRows(false)"><ClipboardCopy :size="15" /></button>
      <button type="button" title="复制所选数据并带表头；无选择时复制全部" @click="copyRows(true)"><TableProperties :size="15" /></button>
      <button type="button" title="导出 CSV" @click="exportResult('csv')"><Download :size="15" /><small>CSV</small></button>
      <button type="button" title="导出 Excel" @click="exportResult('xlsx')"><Download :size="15" /><small>XLSX</small></button>
    </header>
    <div ref="resultScrollRef" class="wb-sql-result-scroll" tabindex="0" aria-label="SQL 查询结果" @scroll="onScroll" @keydown="handleGridKeydown">
      <table :aria-rowcount="filteredRows.length" :aria-colcount="columns.length + 1" :style="{ minWidth: `${Math.max(1, columns.length) * 120}px` }">
        <thead><tr>
          <th class="wb-sql-row-number">#</th>
          <th v-for="column in columns" :key="columnName(column)" tabindex="0" :aria-sort="sortAria(column)" :style="{ width: `${widths[columnName(column)] || 160}px` }" @click="toggleSort(column)" @keydown.enter.prevent="toggleSort(column)" @keydown.space.prevent="toggleSort(column)">
            <span>{{ columnName(column) }}</span><small>{{ column.typeName || column.type || '' }}</small>
            <i aria-hidden="true" @pointerdown.stop.prevent="beginResize(column, $event)"></i>
          </th>
        </tr></thead>
        <tbody>
          <tr v-if="range.start" class="wb-sql-result-spacer" aria-hidden="true"><td :colspan="columns.length + 1" :style="{ height: `${range.start * ROW_HEIGHT}px` }"></td></tr>
          <tr v-for="(row, localIndex) in visibleRows" :key="range.start + localIndex">
            <th scope="row" class="wb-sql-row-number" :class="{ 'is-selected': isSelected(range.start + localIndex, 0) && selectionBounds?.right === columns.length - 1 }" @pointerdown.prevent="selectRow(range.start + localIndex, $event)">{{ range.start + localIndex + 1 }}</th>
            <td v-for="(column, columnIndex) in columns" :key="columnName(column)" :class="{ 'is-null': rawValue(row, column) == null, 'is-selected': isSelected(range.start + localIndex, columnIndex) }" @pointerdown.prevent="beginSelection(range.start + localIndex, columnIndex, $event)" @pointerenter="extendSelection(range.start + localIndex, columnIndex)" @dblclick="copyText(displayValue(rawValue(row, column)))">
              {{ displayValue(rawValue(row, column)) }}
            </td>
          </tr>
          <tr v-if="filteredRows.length > range.end" class="wb-sql-result-spacer" aria-hidden="true"><td :colspan="columns.length + 1" :style="{ height: `${(filteredRows.length - range.end) * ROW_HEIGHT}px` }"></td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
