<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { isCellPending, getCellError } from "../editState.js";
import { tabRowCount, tabRows } from "../rowStore.js";
import { columnName } from "../utils/normalize.js";
import { displayCellValue, escapeHtml } from "../utils/cellDisplay.js";
import { buildRowKey } from "../utils/rowIdentity.js";
import { GRID_HEADER_HEIGHT } from "../constants.js";
import { useColumnResize } from "../composables/useColumnResize.js";
import { useFreezePanes } from "../composables/useFreezePanes.js";
import { useGridRowResize } from "../composables/useGridRowResize.js";
import { applyResolvedFreeze, resolveFreezeTarget } from "../utils/freezeSelection.js";
import { sampleNextFrame } from "../utils/performanceMarks.js";
import ColumnSortMenu from "./ColumnSortMenu.vue";
import ToolbarSplitButton from "./ToolbarSplitButton.vue";

const suspendGridAutoFit = inject("suspendGridAutoFit", ref(false));
const gridWrapRef = ref(null);
const searchInputRef = ref(null);
const isRowDragging = ref(false);
const openToolbarMenu = ref("");
defineExpose({ gridWrapRef });

const {
  getColumnWidth,
  onHandleMouseDown,
  autoFitColumnsRaf,
  autoFitDebounced,
} = useColumnResize();

// Freeze panes geometry helper. Shares getColumnWidth so frozen-column widths
// stay consistent with the rest of the grid.
const freezePanes = useFreezePanes({ getColumnWidth });

const props = defineProps({
  tab: { type: Object, default: null },
  activeColumns: { type: Array, default: () => [] },
  activeColumnMeta: { type: Array, default: () => [] },
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
  highlightCell: { type: Function, default: () => "" },
  hasSearchMatches: { type: Boolean, default: false },
  searchHitSummary: { type: Object, default: () => ({ current: 0, total: 0, label: "" }) },
  schemaSearchMatches: { type: Array, default: () => [] },
  schemaSearchIndex: { type: Number, default: -1 },
  schemaSearchSummary: { type: String, default: "" },
  getInsertRows: { type: Function, default: () => [] },
  getVisibleInsertRows: { type: Function, default: null },
  getInsertDraft: { type: Function, default: () => ({}) },
  getInsertRowKey: { type: Function, default: () => "" },
  isInsertRowVisible: { type: Function, default: () => false },
  insertAwareVisualRowIndex: { type: Function, default: null },
  isColumnSelected: { type: Function, default: () => false },
});

const activeTabRef = computed(() => props.tab);
const {
  rowHeight,
  fieldCommentHeight,
  startRowResize,
  resetRowHeight,
} = useGridRowResize(activeTabRef);
const gridHeightStyle = computed(() => ({
  "--wb-grid-row-height": `${rowHeight.value}px`,
  "--wb-grid-cell-height": `${Math.max(1, rowHeight.value - 1)}px`,
}));

const searchInputValue = ref("");
const activeTabReadOnly = computed(() => Boolean(props.tab?.readOnly || props.tab?.read_only));
const filterModeItems = computed(() => ([
  {
    id: "filter-fuzzy",
    label: "模糊",
    hint: "包含内容即可命中",
    checkable: true,
    checked: props.tab?.filterMode !== "exact",
  },
  {
    id: "filter-exact",
    label: "精确",
    hint: "内容需要完全相等",
    checkable: true,
    checked: props.tab?.filterMode === "exact",
  },
]));
const exportItems = computed(() => ([
  { id: "batch-export", label: "批量导出", hint: "导出多张表", icon: "export", disabled: props.busy },
]));
const importItems = computed(() => ([
  {
    id: "batch-import",
    label: "批量导入",
    hint: "导入多张表",
    icon: "import",
    disabled: props.busy || activeTabReadOnly.value,
  },
]));
const splitItems = [
  { id: "split-right", label: "左右分屏", hint: "在右侧打开", icon: "split-right" },
  { id: "split-down", label: "上下分屏", hint: "在下方打开", icon: "split-down" },
];
const hasActiveCellSearch = computed(() => Boolean(
  String(props.tab?.searchQuery ?? props.tab?.filter ?? "").trim(),
));

watch(
  () => [props.tab?.id, props.tab?.filter],
  ([, filter]) => {
    searchInputValue.value = String(filter ?? "");
  },
  { immediate: true },
);

const loadedRowCount = computed(() => tabRowCount(props.tab));

function dataRowKey(tab, row, rowIndex) {
  const precomputed = tab?.searchResultMode
    ? tab.searchResultRowKeys?.[rowIndex]
    : "";
  return precomputed || buildRowKey(tab, row);
}

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
  'export',
  'import',
  'batch-export',
  'batch-import',
  'split-pane',
  'search-ready',
  'search-input',
  'search-previous',
  'search-next',
  'schema-search-previous',
  'schema-search-next',
  'contextmenu',
  'row-contextmenu',
  'select-column',
  'select-field-comment',
  'retry-load',
]);

function colStyle(tabId, colName) {
  const w = getColumnWidth(tabId, colName);
  // Pin width/min/max together so the column honors an explicit width even
  // when it's narrower than its nowrap content's min-content (#13). Setting
  // maxWidth = w still allows widening past the auto-fit cap, since the cap
  // is enforced in autoFitColumns, not here — `w` itself is unbounded.
  return w ? { width: w + 'px', minWidth: w + 'px', maxWidth: w + 'px' } : {};
}

// ── Freeze panes geometry (reactive over tab.frozenRowCount/ColumnCount) ──
// Frozen rows render in their own band above the virtualized window; frozen
// columns get sticky left offsets. These computeds feed both the render logic
// below and the auto-fit budget so non-frozen columns don't overflow on
// account of pinned columns.
const frozenRowCount = computed(() => freezePanes.frozenRowCountOf(props.tab));
const frozenColumnCount = computed(() => freezePanes.frozenColumnCountOf(props.tab));
const frozenRowsHeight = computed(() => freezePanes.frozenRowsHeight(props.tab));
const fieldCommentsExpanded = computed(() => props.tab?.fieldCommentsExpanded !== false);
const fieldCommentBandHeight = computed(() => (
  fieldCommentsExpanded.value ? fieldCommentHeight.value : freezePanes.fieldCommentBandHeight(props.tab)
));
const fieldCommentLineCount = computed(() => Math.max(1, Math.floor((fieldCommentBandHeight.value - 2) / 16.2)));
const frozenColumnsWidth = computed(() => freezePanes.frozenColumnsWidth(props.tab, renderColumns.value));
const hasFreeze = computed(() => frozenRowCount.value > 0 || frozenColumnCount.value > 0);
const freezeTarget = computed(() => resolveFreezeTarget({
  tabId: props.tab?.id,
  rowCount: tabRowCount(props.tab),
  selectedRange: props.selectedRange,
}));
const freezeItems = computed(() => ([
  {
    id: "freeze-cell",
    label: "冻结到当前单元格",
    icon: "freeze-cell",
    disabled: freezeTarget.value?.kind !== "cell",
  },
  {
    id: "freeze-row",
    label: "冻结到当前行",
    icon: "freeze-row",
    disabled: freezeTarget.value?.kind !== "cell",
  },
  {
    id: "freeze-column",
    label: "冻结到当前列",
    icon: "freeze-column",
    disabled: !freezeTarget.value,
  },
  { id: "freeze-top-row", label: "冻结首行", icon: "freeze-row" },
  { id: "freeze-first-column", label: "冻结首列", icon: "freeze-column" },
  { id: "unfreeze", label: "取消冻结", icon: "unfreeze", disabled: !hasFreeze.value },
]));

// Rows rendered in the frozen band (always visible, outside the virtual window).
const frozenRows = computed(() => {
  const tab = props.tab;
  const count = frozenRowCount.value;
  if (count <= 0 || tabRowCount(tab) === 0) return [];
  return tabRows(tab).slice(0, count).map((row, i) => ({
    row,
    originalIndex: i,
    rowKey: dataRowKey(tab, row, i),
  }));
});

/**
 * Sticky style for a frozen column cell (th/td). Returns the `left` offset +
 * positioning; caller adds the z-index tier via class. Non-frozen columns get
 * an empty object (no sticky).
 */
function frozenColumnStyle(columnIndex) {
  if (columnIndex >= frozenColumnCount.value) return null;
  const left = freezePanes.frozenColumnLeftOffset(props.tab, renderColumns.value, columnIndex);
  return { position: 'sticky', left: left + 'px' };
}

/**
 * Sticky style for a frozen-row cell (td). `dataRowIndex` is the 0-based data
 * row index (not visual). Non-frozen rows get null.
 */
function frozenRowStyle(dataRowIndex) {
  if (dataRowIndex >= frozenRowCount.value) return null;
  const top = freezePanes.frozenRowTopOffset(props.tab, dataRowIndex);
  return { position: 'sticky', top: top + 'px' };
}

/**
 * Merge multiple style objects (later ones win on conflict). Used to combine
 * column width + frozen-column sticky + frozen-row sticky into one :style.
 */
function mergeStyles(...objs) {
  const out = {};
  for (const o of objs) {
    if (!o) continue;
    for (const k in o) out[k] = o[k];
  }
  return out;
}

// z-index tier class for a frozen cell, applied alongside frozenColumnStyle /
// frozenRowStyle. Tiers (see workbench.css):
//   frozen-col / frozen-row / frozen-corner (corner = both, highest)
function frozenCellClass(dataRowIndex, columnIndex) {
  const isFrozenRow = dataRowIndex < frozenRowCount.value;
  const isFrozenCol = columnIndex < frozenColumnCount.value;
  if (isFrozenRow && isFrozenCol) return 'frozen-corner';
  if (isFrozenCol) return 'frozen-col';
  if (isFrozenRow) return 'frozen-row';
  return '';
}

// Whether the last frozen column / last frozen row — used to draw the divider.
function isLastFrozenColumn(columnIndex) {
  return frozenColumnCount.value > 0 && columnIndex === frozenColumnCount.value - 1;
}
function isLastFrozenRow(dataRowIndex) {
  return frozenRowCount.value > 0 && dataRowIndex === frozenRowCount.value - 1;
}

// Highlight helper for #12: a column is "active" when the selected cell lives
// in the same column of the same tab. Used to tint the whole column (header +
// every visible td) so the user can trace the selected cell's column.
function isActiveColumn(colName) {
  return props.selectedCell?.tabId === props.tab.id && props.selectedCell?.column === colName;
}

const renderColumns = computed(() => {
  if (Array.isArray(props.activeColumnMeta) && props.activeColumnMeta.length) return props.activeColumnMeta;
  return (props.activeColumns || []).map((column, columnIndex) => ({
    column,
    columnIndex,
    name: columnName(column),
    comment: column?.column_comment || column?.columnComment || "",
  }));
});

const renderCellColumns = computed(() => renderColumns.value.map((columnMeta) => ({
  ...columnMeta,
  cellStyle: mergeStyles(
    colStyle(props.tab?.id, columnMeta.name),
    frozenColumnStyle(columnMeta.columnIndex),
  ),
})));

function tabScopeKey(tab) {
  return tab?.tableKey || tab?.tableName || "";
}

const EMPTY_CELL_RANGE_CLASSES = Object.freeze({});

function cellRangeClasses(tab, rowKey, column, rowIndex, columnIndex) {
  if (!props.selectedRange || props.selectedRange.tabId !== tab?.id) return EMPTY_CELL_RANGE_CLASSES;
  return props.getCellRangeClasses(tab, rowKey, column, rowIndex, columnIndex);
}

function toggleFieldComments() {
  if (!props.tab) return;
  props.tab.fieldCommentsExpanded = !fieldCommentsExpanded.value;
}

function isFieldCommentSelected(columnNameValue) {
  return props.selectedCell?.tabId === props.tab?.id
    && props.selectedCell?.kind === "fieldComment"
    && props.selectedCell?.column === columnNameValue;
}

function selectFieldComment(columnMeta) {
  if (!fieldCommentsExpanded.value) return;
  emit("select-field-comment", props.tab, columnMeta);
}

function isRowInSelectedRange(tab, rowIndex) {
  const range = props.selectedRange;
  const anchorRow = range?.anchor?.rowIndex;
  const focusRow = range?.focus?.rowIndex;
  if (
    !range ||
    range.tabId !== tab?.id ||
    !Number.isInteger(rowIndex) ||
    !Number.isInteger(anchorRow) ||
    !Number.isInteger(focusRow)
  ) return false;
  return rowIndex >= Math.min(anchorRow, focusRow) && rowIndex <= Math.max(anchorRow, focusRow);
}

let lastScrollPerfSampleAt = 0;

function onGridWrapScroll(event) {
  emit('scroll', event);
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  if (now - lastScrollPerfSampleAt > 250) {
    lastScrollPerfSampleAt = now;
    sampleNextFrame("grid.scroll.frame", {
      tableName: props.tab?.tableName || "",
      loadedRows: tabRowCount(props.tab),
      visibleRows: props.visibleRows.length,
      columns: props.activeColumns.length,
    });
  }
}

function isPrimaryKeyColumn(column, name = columnName(column)) {
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

function insertRowCellValueByName(tab, insertRow, name) {
  return props.getInsertDraft(tab, insertRow?.id)[name] || "";
}

function highlightInsertCellByName(tab, insertRow, name) {
  return escapeHtml(insertRowCellValueByName(tab, insertRow, name));
}

function isSearchMatchCell(tab, row, column, rowKey) {
  return highlightCellResult(tab, row, column, rowKey).matched;
}

function highlightCellResult(tab, row, column, rowKey) {
  const result = props.highlightCell(tab, row, column, rowKey);
  if (result && typeof result === "object") return result;
  const html = String(result ?? "");
  return { html, matched: html.includes("<mark>") };
}

function highlightCellHtml(tab, row, column, rowKey) {
  const { html } = highlightCellResult(tab, row, column, rowKey);
  // 真实 NULL 单元格在网格里渲染为空白，而非字面 "NULL"（保留 .is-null 淡色标记）。
  // 仅当底层值为 null 且显示为 NULL 哨兵时清空：字面文本 "NULL" 或乐观编辑值不受影响。
  if (row?.[column] == null && html === "NULL") return "";
  return html;
}

function plainCellText(tab, row, column, rowKey) {
  const text = displayCellValue(props.editState, tab, row, column, rowKey);
  return row?.[column] == null && text === "NULL" ? "" : text;
}

// 按 anchorIndex 分组的草稿行：Map<anchorIndex, insertRow[]>，末尾追加草稿归入 key=null
// anchorIndex 超过已加载行数（例如删除/刷新后行数变少）也归入末尾，
// 避免未提交的 anchored 草稿因无对应数据行而消失、静默丢数据。
const insertRowsByAnchor = computed(() => {
  const map = new Map();
  const rows = typeof props.getVisibleInsertRows === "function"
    ? props.getVisibleInsertRows(props.tab)
    : (props.isInsertRowVisible(props.tab) ? props.getInsertRows(props.tab) : []);
  const rowCount = tabRowCount(props.tab);
  for (const row of rows) {
    let key = row.anchorIndex == null ? null : row.anchorIndex;
    if (key != null && key >= rowCount) key = null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
});

// 末尾追加草稿（anchorIndex==null），按存储顺序
const trailingInsertRows = computed(() => insertRowsByAnchor.value.get(null) || []);

// 是否存在任何插入草稿行（含锚定与末尾），用于判断 0 行空状态是否该显示。
const hasInsertRows = computed(() => {
  for (const rows of insertRowsByAnchor.value.values()) {
    if (rows.length > 0) return true;
  }
  return false;
});

// 给定 originalIndex 处需在其前渲染的 anchored 草稿（anchorIndex===originalIndex）
function anchoredInsertRowsAt(originalIndex) {
  return insertRowsByAnchor.value.get(originalIndex) || [];
}

function anchoredInsertCountBefore(originalIndex) {
  let count = 0;
  for (const [anchorIndex, rows] of insertRowsByAnchor.value.entries()) {
    if (anchorIndex != null && anchorIndex < originalIndex) count += rows.length;
  }
  return count;
}

function anchoredInsertVisualIndex(originalIndex, insertRowIndex) {
  return originalIndex + anchoredInsertCountBefore(originalIndex) + insertRowIndex;
}

function dataRowVisualIndex(originalIndex) {
  // Local O(K) computation (K = number of insert drafts, typically tiny).
  // `insertRowsByAnchor` is a cached computed; `anchoredInsertCountBefore`
  // only walks that small map. This deliberately does NOT call
  // `props.insertAwareVisualRowIndex`, whose backing `visualRowEntries`
  // rebuilds an array over every data row on each call — calling that per
  // cell here made the grid O(visibleRows × columns × totalRows) and froze
  // large tables. The two formulas yield identical results.
  const currentAnchoredCount = anchoredInsertRowsAt(originalIndex).length;
  return originalIndex + anchoredInsertCountBefore(originalIndex) + currentAnchoredCount;
}

const visibleRowsWithVisualIndex = computed(() => props.visibleRows.map((entry) => ({
  ...entry,
  visualIndex: dataRowVisualIndex(entry.originalIndex),
})));

function trailingInsertVisualIndex(insertRowIndex) {
  return tabRowCount(props.tab) + anchoredInsertCountBefore(Number.POSITIVE_INFINITY) + insertRowIndex;
}

function schemaSearchColumnName(match) {
  return typeof match === "string" ? match : match?.columnName || "";
}

function isSchemaSearchColumn(column, name = columnName(column)) {
  return props.schemaSearchMatches.some((match) => schemaSearchColumnName(match) === name);
}

function isActiveSchemaSearchColumn(column, name = columnName(column)) {
  const match = props.schemaSearchMatches[props.schemaSearchIndex];
  return Boolean(match && schemaSearchColumnName(match) === name);
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
  if (searchInputValue.value) emit('search-input', searchInputValue.value);
}

function toggleToolbarMenu(menuId) {
  openToolbarMenu.value = openToolbarMenu.value === menuId ? "" : menuId;
}

function closeToolbarMenu() {
  openToolbarMenu.value = "";
}

function applyFreezeCounts(freezeRows, freezeColumns) {
  return applyResolvedFreeze({
    freezePanes,
    tab: props.tab,
    target: { freezeRows, freezeColumns },
  });
}

function applyDefaultFreeze() {
  applyResolvedFreeze({
    freezePanes,
    tab: props.tab,
    target: freezeTarget.value,
  });
}

function handleFreezeAction(actionId) {
  const target = freezeTarget.value;
  if (actionId === "freeze-cell" && target?.kind === "cell") {
    applyFreezeCounts(target.freezeRows, target.freezeColumns);
  } else if (actionId === "freeze-row" && target?.kind === "cell") {
    applyFreezeCounts(target.freezeRows, 0);
  } else if (actionId === "freeze-column" && target) {
    applyFreezeCounts(0, target.freezeColumns);
  } else if (actionId === "freeze-top-row") {
    applyFreezeCounts(1, 0);
  } else if (actionId === "freeze-first-column") {
    applyFreezeCounts(0, 1);
  } else if (actionId === "unfreeze" && hasFreeze.value) {
    freezePanes.clearFreeze(props.tab);
  }
}

function handleToolbarAction(actionId) {
  if (actionId === "filter-fuzzy") setFilterMode("fuzzy");
  else if (actionId === "filter-exact") setFilterMode("exact");
  else if (actionId.startsWith("freeze-") || actionId === "unfreeze") handleFreezeAction(actionId);
  else if (actionId === "batch-export") emit("batch-export");
  else if (actionId === "batch-import") emit("batch-import");
  else if (actionId === "split-right") emit("split-pane", "right");
  else if (actionId === "split-down") emit("split-pane", "down");
  closeToolbarMenu();
}

function onTableSearchInput(event) {
  searchInputValue.value = String(event?.target?.value ?? "");
  emit('search-input', searchInputValue.value);
}

// ── Adaptive column width ──────────────────────────────────────────────────

let resizeObserver = null;

function performAutoFit() {
  const tab = props.tab;
  if (!tab || !gridWrapRef.value || !props.activeColumns.length) return;
  autoFitColumnsRaf(gridWrapRef.value, tab.id, props.activeColumns, tabRows(tab), {
    frozenColumnsWidth: freezePanes.frozenColumnsWidth(tab, renderColumns.value),
  });
}

function setupResizeObserver() {
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  if (!gridWrapRef.value) return;
  resizeObserver = new ResizeObserver(() => {
    if (suspendGridAutoFit.value) return;
    const tab = props.tab;
    if (!tab || !gridWrapRef.value || !props.activeColumns.length) return;
    autoFitDebounced(gridWrapRef.value, tab.id, props.activeColumns, tabRows(tab), {
      frozenColumnsWidth: freezePanes.frozenColumnsWidth(tab, renderColumns.value),
    });
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
    closeToolbarMenu();
    nextTick(() => {
      performAutoFit();
      setupResizeObserver();
    });
  },
);

// Re-fit when freeze column count changes: the auto-fit budget excludes the
// frozen-column band, so adding/removing frozen columns redistributes space
// among the remaining (non-frozen) columns.
watch(frozenColumnCount, () => {
  nextTick(() => performAutoFit());
});

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
  <section v-if="tab" class="wb-table-panel" :style="gridHeightStyle" @contextmenu.prevent.stop="emit('contextmenu', $event)">
    <header class="wb-table-toolbar">
      <div class="wb-table-search-field" :class="{ 'has-matches': hasSearchMatches }">
        <input
          ref="searchInputRef"
          :value="searchInputValue"
          class="wb-table-search-field-input"
          :placeholder="'搜索当前表（' + (tab.filterMode === 'exact' ? '精确' : '模糊') + '）'"
          @input="onTableSearchInput"
          @keydown.enter.prevent="emit('search-next')"
        />
        <div class="wb-search-aux">
          <span v-if="hasSearchMatches" class="wb-search-nav-inline" role="group" aria-label="命中导航">
            <button
              class="wb-search-nav-icon"
              type="button"
              aria-label="上一个匹配"
              title="上一个匹配"
              @click="emit('search-previous')"
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="3,9 7,5 11,9" />
              </svg>
            </button>
            <button
              class="wb-search-nav-icon"
              type="button"
              aria-label="下一个匹配"
              title="下一个匹配"
              @click="emit('search-next')"
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="3,5 7,9 11,5" />
              </svg>
            </button>
          </span>
          <span
            v-if="searchHitSummary.label"
            class="wb-search-hit-count"
            aria-live="polite"
            :title="'当前命中 / 命中总数：' + searchHitSummary.label"
          >{{ searchHitSummary.label }}</span>
        </div>
      </div>
      <span v-if="tab.sort" class="wb-sort-chip" :title="`按 ${tab.sort.columnName} ${tab.sort.descending ? '降序' : '升序'}，点击清除`">
        <span class="wb-sort-chip-icon" aria-hidden="true">{{ tab.sort.descending ? '↓' : '↑' }}</span>
        <span class="wb-sort-chip-label">{{ tab.sort.columnName }}</span>
        <button type="button" class="wb-sort-chip-clear" aria-label="清除排序" @click="emit('apply-sort', tab, tab.sort.columnName, 'none')">×</button>
      </span>
      <span v-if="schemaSearchMatches.length" class="wb-schema-search-nav" role="group" aria-label="结构命中导航">
        <span>{{ schemaSearchSummary }}</span>
        <button
          class="wb-search-nav-icon"
          type="button"
          aria-label="上一个结构命中"
          title="上一个结构命中"
          @click="emit('schema-search-previous')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3,9 7,5 11,9" />
          </svg>
        </button>
        <button
          class="wb-search-nav-icon"
          type="button"
          aria-label="下一个结构命中"
          title="下一个结构命中"
          @click="emit('schema-search-next')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3,5 7,9 11,5" />
          </svg>
        </button>
      </span>
      <div class="wb-table-toolbar-actions" role="group" aria-label="表操作">
        <ToolbarSplitButton
          :label="tab.filterMode === 'exact' ? '精确' : '模糊'"
          menu-label="匹配方式"
          primary-opens-menu
          :active="tab.filterMode === 'exact'"
          :open="openToolbarMenu === 'filter'"
          :items="filterModeItems"
          @toggle="toggleToolbarMenu('filter')"
          @close="closeToolbarMenu"
          @select="handleToolbarAction"
        />
        <ToolbarSplitButton
          label="冻结"
          menu-label="冻结选项"
          :active="hasFreeze"
          :open="openToolbarMenu === 'freeze'"
          :items="freezeItems"
          @primary="applyDefaultFreeze"
          @toggle="toggleToolbarMenu('freeze')"
          @close="closeToolbarMenu"
          @select="handleToolbarAction"
        />
        <ToolbarSplitButton
          label="导出"
          menu-label="导出选项"
          :open="openToolbarMenu === 'export'"
          :items="exportItems"
          :primary-disabled="busy"
          :menu-disabled="busy"
          @primary="emit('export')"
          @toggle="toggleToolbarMenu('export')"
          @close="closeToolbarMenu"
          @select="handleToolbarAction"
        />
        <ToolbarSplitButton
          label="导入"
          menu-label="导入选项"
          :open="openToolbarMenu === 'import'"
          :items="importItems"
          :primary-disabled="busy || !tab.sessionId || activeTabReadOnly"
          :menu-disabled="busy || activeTabReadOnly"
          @primary="emit('import')"
          @toggle="toggleToolbarMenu('import')"
          @close="closeToolbarMenu"
          @select="handleToolbarAction"
        />
        <ToolbarSplitButton
          label="分屏"
          menu-label="分屏选项"
          :open="openToolbarMenu === 'split'"
          :items="splitItems"
          @primary="emit('split-pane', 'right')"
          @toggle="toggleToolbarMenu('split')"
          @close="closeToolbarMenu"
          @select="handleToolbarAction"
        />
      </div>
    </header>

    <div class="wb-grid-shell">
      <div
        ref="gridWrapRef"
        class="wb-grid-wrap"
        :class="{ 'is-selecting-range': isSelectingRange }"
        tabindex="0"
        @scroll.passive="onGridWrapScroll"
        @keydown="emit('keydown', $event)"
      >
        <div v-if="tab.loading" class="wb-grid-loading">
          <span class="wb-grid-loading-spinner" aria-hidden="true"></span>
          <span class="wb-grid-loading-text">加载中…</span>
        </div>
        <div v-else-if="tab.loadError" class="wb-grid-error">
          <svg class="wb-grid-error-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p class="wb-grid-error-title">加载失败</p>
          <p class="wb-grid-error-detail">{{ tab.loadError }}</p>
          <button type="button" class="wb-grid-error-retry" @click="emit('retry-load', tab)">重试</button>
        </div>
        <table class="wb-grid">
        <thead>
          <tr class="wb-grid-column-header-row">
            <th
              class="wb-row-index wb-row-index-corner"
              :class="{ 'row-selected': loadedRowCount > 0 && tab.selectedRowKeys.size === loadedRowCount }"
              title="选择全部行"
              @click="emit('toggle-all-rows', tab)"
            ></th>
            <th
            v-for="columnMeta in renderColumns"
            :key="columnMeta.name"
            :style="mergeStyles(colStyle(tab.id, columnMeta.name), frozenColumnStyle(columnMeta.columnIndex))"
            :data-column-index="columnMeta.columnIndex"
            :class="{
              'schema-search-match': isSchemaSearchColumn(columnMeta.column, columnMeta.name),
              'schema-search-active': isActiveSchemaSearchColumn(columnMeta.column, columnMeta.name),
              'col-selected': isColumnSelected(tab, columnMeta.columnIndex),
              'col-active': isActiveColumn(columnMeta.name),
              'frozen-col': columnMeta.columnIndex < frozenColumnCount,
              'frozen-col-edge': isLastFrozenColumn(columnMeta.columnIndex),
            }"
            @mousedown.left="onColumnHeaderMouseDown(tab, columnMeta.name, $event)"
            @contextmenu.prevent.stop="emit('contextmenu', $event)"
            >
              <span class="wb-th-text" :title="columnMeta.comment">{{ columnMeta.name }}</span>
              <ColumnSortMenu
                :column="columnMeta.name"
                :sort="tab.sort"
                @apply-sort="emit('apply-sort', tab, columnMeta.name, $event)"
              />
              <span
                class="wb-col-resize"
                @mousedown.prevent.stop="onHandleMouseDown($event, tab.id, columnMeta.name)"
              ></span>
            </th>
          </tr>
          <tr
            class="wb-field-comments-row"
            :class="{ 'is-collapsed': !fieldCommentsExpanded }"
            :style="{ '--wb-field-comment-row-height': `${fieldCommentBandHeight}px` }"
          >
            <th class="wb-row-index wb-field-comments-toggle-cell">
              <button
                type="button"
                class="wb-field-comments-toggle"
                :title="fieldCommentsExpanded ? '收起字段备注' : '展开字段备注'"
                :aria-label="fieldCommentsExpanded ? '收起字段备注' : '展开字段备注'"
                :aria-expanded="fieldCommentsExpanded ? 'true' : 'false'"
                @click.stop="toggleFieldComments"
              >
                <span>注</span>
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline :points="fieldCommentsExpanded ? '2,5.5 4.5,3 7,5.5' : '2,3.5 4.5,6 7,3.5'" />
                </svg>
              </button>
              <span
                class="wb-row-resize-handle wb-field-comments-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label="拖动调整字段备注行高度，双击恢复默认"
                title="拖动调整字段备注行高度 · 双击恢复默认"
                @pointerdown="startRowResize($event, 'fieldComment')"
                @dblclick.stop.prevent="resetRowHeight('fieldComment')"
              ></span>
            </th>
            <th
              v-for="columnMeta in renderColumns"
              :key="`comment-${columnMeta.name}`"
              class="wb-field-comment-cell"
              :class="{
                'is-empty': !columnMeta.comment,
                'is-selected': isFieldCommentSelected(columnMeta.name),
                'frozen-col': columnMeta.columnIndex < frozenColumnCount,
                'frozen-col-edge': isLastFrozenColumn(columnMeta.columnIndex),
              }"
              :style="mergeStyles(colStyle(tab.id, columnMeta.name), frozenColumnStyle(columnMeta.columnIndex))"
              :title="columnMeta.comment || '暂无字段备注'"
              @click.stop="selectFieldComment(columnMeta)"
            >
              <span
                v-if="fieldCommentsExpanded"
                class="wb-field-comment-text"
                :style="{ '--wb-field-comment-lines': fieldCommentLineCount }"
              >{{ columnMeta.comment || '—' }}</span>
              <span v-else class="wb-field-comment-collapsed-mark" aria-hidden="true"></span>
            </th>
          </tr>
        </thead>
        <tbody>
          <!-- 冻结行段：始终渲染在可视窗口最上方，独立于虚拟滚动。
               不计入 visibleRows，避免重复渲染；其高度已从 padTop/totalHeight 扣除。 -->
          <template v-if="frozenRowCount > 0">
            <tr
              v-for="{ row, originalIndex, rowKey } in frozenRows"
              :key="`frozen-${rowKey}`"
              class="wb-grid-row wb-frozen-row"
              :class="{
                'row-even': originalIndex % 2 === 1,
                'row-selected': tab.selectedRowKeys.has(rowKey),
                'row-active': selectedCell?.tabId === tab.id && selectedCell?.rowKey === rowKey,
                'row-range-active': isRowInSelectedRange(tab, originalIndex),
                'frozen-row-edge': isLastFrozenRow(originalIndex),
              }"
            >
              <td
                class="wb-row-index wb-row-header wb-frozen-row-index"
                :class="{ 'row-selected': tab.selectedRowKeys.has(rowKey) }"
                title="选择整行"
                @mousedown.left.stop.prevent="onRowSelectStart(tab, row, originalIndex, $event)"
                @click.stop="emit('toggle-row-select', tab, row, $event)"
                @contextmenu.prevent.stop="emit('row-contextmenu', $event, tab, row, originalIndex)"
              >
                {{ dataRowVisualIndex(originalIndex) + 1 }}
                <span
                  class="wb-row-resize-handle"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="拖动调整全部数据行高度，双击恢复默认"
                  title="拖动调整全部数据行高度 · 双击恢复默认"
                  @pointerdown="startRowResize($event, 'data')"
                  @dblclick.stop.prevent="resetRowHeight('data')"
                ></span>
              </td>
              <td
                v-for="columnMeta in renderColumns"
                :key="`frozen-${rowKey}-${columnMeta.name}`"
                :style="mergeStyles(colStyle(tab.id, columnMeta.name), frozenColumnStyle(columnMeta.columnIndex), frozenRowStyle(originalIndex))"
                :data-column-index="columnMeta.columnIndex"
                :data-row-key="rowKey"
                :data-column-name="columnMeta.name"
                :title="getCellError(editState, tabScopeKey(tab), rowKey, columnMeta.name) || ''"
                :class="{
                  pending: isCellPending(editState, tabScopeKey(tab), rowKey, columnMeta.name),
                  error: getCellError(editState, tabScopeKey(tab), rowKey, columnMeta.name),
                  selected: selectedCell?.rowKey === rowKey && selectedCell?.column === columnMeta.name && selectedCell?.tabId === tab.id,
                  'col-active': isActiveColumn(columnMeta.name),
                  editing: editingCell?.rowKey === rowKey && editingCell?.column === columnMeta.name,
                  'row-selected': tab.selectedRowKeys.has(rowKey),
                  'search-match': hasActiveCellSearch && isSearchMatchCell(tab, row, columnMeta.name, rowKey),
                  'is-null': row[columnMeta.name] == null,
                  ...cellRangeClasses(tab, rowKey, columnMeta.name, originalIndex, columnMeta.columnIndex),
                  [frozenCellClass(originalIndex, columnMeta.columnIndex)]: true,
                }"
                @mousedown.left="emit('cell-mousedown', tab, row, columnMeta.name, originalIndex, columnMeta.columnIndex, $event)"
                @mouseenter="emit('cell-enter', tab, row, columnMeta.name, originalIndex, columnMeta.columnIndex)"
                @mouseup="emit('range-end')"
                @click="emit('cell-click', tab, row, columnMeta.name, originalIndex, columnMeta.columnIndex)"
                @dblclick="emit('cell-dblclick', tab, row, columnMeta.name, originalIndex, columnMeta.columnIndex)"
              >
                <input
                  v-if="editingCell?.rowKey === rowKey && editingCell?.column === columnMeta.name"
                  :value="editDraft"
                  :data-row-index="originalIndex"
                  :data-column-index="columnMeta.columnIndex"
                  @input="emit('edit-input', $event.target.value)"
                  @blur="emit('cell-blur')"
                  @keydown.enter.prevent.stop="emit('finish-edit')"
                  @keydown.escape.prevent.stop="emit('cancel-edit')"
                  @keydown.tab.prevent.stop="emit('tab-edit', $event.shiftKey)"
                />
                <span v-else-if="hasActiveCellSearch" class="wb-cell-text" v-html="highlightCellHtml(tab, row, columnMeta.name, rowKey)"></span>
                <span v-else class="wb-cell-text">{{ plainCellText(tab, row, columnMeta.name, rowKey) }}</span>
              </td>
            </tr>
          </template>
          <tr v-if="virtualRange.padTop > 0" aria-hidden="true" class="wb-virtual-spacer">
            <td :style="{ height: virtualRange.padTop + 'px' }" :colspan="1 + activeColumns.length"></td>
          </tr>
          <template v-for="{ row, originalIndex, rowKey, visualIndex } in visibleRowsWithVisualIndex" :key="rowKey">
            <tr
              v-for="(insertRow, insertRowIndex) in anchoredInsertRowsAt(originalIndex)"
              :key="insertRow.id"
              class="wb-insert-row"
              :class="{
                'is-unsaved': true,
                'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id,
                'row-range-active': isRowInSelectedRange(tab, anchoredInsertVisualIndex(originalIndex, insertRowIndex)),
              }"
            >
              <td
                class="wb-row-index wb-row-insert-marker wb-row-header"
                :class="{ 'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id }"
                title="新增未保存"
                aria-label="新增未保存行"
                @mousedown.stop.prevent
                @click.stop="emit('insert-row-select', tab, insertRow.id, $event)"
                @contextmenu.prevent.stop="emit('row-contextmenu', $event, tab, insertRowObject(insertRow), anchoredInsertVisualIndex(originalIndex, insertRowIndex))"
              >
                {{ anchoredInsertVisualIndex(originalIndex, insertRowIndex) + 1 }}
                <span
                  class="wb-row-resize-handle"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="拖动调整全部数据行高度，双击恢复默认"
                  title="拖动调整全部数据行高度 · 双击恢复默认"
                  @pointerdown="startRowResize($event, 'data')"
                  @dblclick.stop.prevent="resetRowHeight('data')"
                ></span>
              </td>
              <td
                v-for="columnMeta in renderColumns"
                :key="`insert-${insertRow.id}-${columnMeta.name}`"
                :style="mergeStyles(colStyle(tab.id, columnMeta.name), frozenColumnStyle(columnMeta.columnIndex))"
                :data-column-index="columnMeta.columnIndex"
                :data-row-key="insertRowKey(tab, insertRow)"
                :data-column-name="columnMeta.name"
                :title="getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name) || ''"
                :class="{
                  pending: isCellPending(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name),
                  error: getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name),
                  selected: selectedCell?.rowKey === insertRowKey(tab, insertRow) && selectedCell?.column === columnMeta.name && selectedCell?.tabId === tab.id,
                  'col-active': isActiveColumn(columnMeta.name),
                  editing: editingCell?.rowKey === insertRowKey(tab, insertRow) && editingCell?.column === columnMeta.name,
                  'insert-selected': selectedInsertCell?.tabId === tab.id && selectedInsertCell?.rowId === insertRow.id && selectedInsertCell?.columnIndex === columnMeta.columnIndex,
                  ...cellRangeClasses(tab, insertRowKey(tab, insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex),
                  'frozen-col': columnMeta.columnIndex < frozenColumnCount,
                  'frozen-col-edge': isLastFrozenColumn(columnMeta.columnIndex),
                }"
                @mousedown.left="emit('cell-mousedown', tab, insertRowObject(insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex, $event)"
                @mouseenter="emit('cell-enter', tab, insertRowObject(insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex)"
                @mouseup="emit('range-end')"
                @click="emit('cell-click', tab, insertRowObject(insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex)"
                @dblclick="emit('cell-dblclick', tab, insertRowObject(insertRow), columnMeta.name, anchoredInsertVisualIndex(originalIndex, insertRowIndex), columnMeta.columnIndex)"
              >
                <input
                  v-if="editingCell?.rowKey === insertRowKey(tab, insertRow) && editingCell?.column === columnMeta.name"
                  :value="editDraft"
                  :data-insert-row-id="insertRow.id"
                  :data-insert-column-index="columnMeta.columnIndex"
                  :data-row-index="anchoredInsertVisualIndex(originalIndex, insertRowIndex)"
                  :data-column-index="columnMeta.columnIndex"
                  :placeholder="isPrimaryKeyColumn(columnMeta.column, columnMeta.name) ? 'auto' : ''"
                  @focus="emit('insert-focus', tab, insertRow.id, columnMeta.columnIndex)"
                  @input="emit('edit-input', $event.target.value)"
                  @paste.prevent.stop="emit('insert-paste', tab, insertRow.id, columnMeta.columnIndex, $event)"
                  @keydown.arrow-up.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                  @keydown.arrow-down.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                  @keydown.arrow-left.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                  @keydown.arrow-right.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                  @keydown.tab.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                  @keydown.escape.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                  @blur="emit('cell-blur')"
                  @keydown.enter.prevent.stop="emit('finish-edit')"
                />
                <span v-else class="wb-cell-text" v-html="highlightInsertCellByName(tab, insertRow, columnMeta.name)"></span>
              </td>
            </tr>
            <tr
              class="wb-grid-row"
              :class="{
                'row-even': visualIndex % 2 === 1,
                'row-selected': tab.selectedRowKeys.has(rowKey),
                'row-active': selectedCell?.tabId === tab.id && selectedCell?.rowKey === rowKey,
                'row-range-active': isRowInSelectedRange(tab, visualIndex),
              }"
            >
              <td
                class="wb-row-index wb-row-header"
                :class="{ 'row-selected': tab.selectedRowKeys.has(rowKey) }"
                title="选择整行"
                @mousedown.left.stop.prevent="onRowSelectStart(tab, row, originalIndex, $event)"
                @click.stop="emit('toggle-row-select', tab, row, $event)"
                @contextmenu.prevent.stop="emit('row-contextmenu', $event, tab, row, originalIndex)"
              >
                {{ visualIndex + 1 }}
                <span
                  class="wb-row-resize-handle"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="拖动调整全部数据行高度，双击恢复默认"
                  title="拖动调整全部数据行高度 · 双击恢复默认"
                  @pointerdown="startRowResize($event, 'data')"
                  @dblclick.stop.prevent="resetRowHeight('data')"
                ></span>
              </td>
              <td
                v-for="columnMeta in renderCellColumns"
                :key="columnMeta.name"
                :style="columnMeta.cellStyle"
                :data-column-index="columnMeta.columnIndex"
                :data-row-key="rowKey"
                :data-column-name="columnMeta.name"
                :title="getCellError(editState, tabScopeKey(tab), rowKey, columnMeta.name) || ''"
                :class="{
                  pending: isCellPending(editState, tabScopeKey(tab), rowKey, columnMeta.name),
                  error: getCellError(editState, tabScopeKey(tab), rowKey, columnMeta.name),
                  selected: selectedCell?.rowKey === rowKey && selectedCell?.column === columnMeta.name && selectedCell?.tabId === tab.id,
                  'col-active': isActiveColumn(columnMeta.name),
                  editing: editingCell?.rowKey === rowKey && editingCell?.column === columnMeta.name,
                  'row-selected': tab.selectedRowKeys.has(rowKey),
                  'search-match': hasActiveCellSearch && isSearchMatchCell(tab, row, columnMeta.name, rowKey),
                  'is-null': row[columnMeta.name] == null,
                  ...cellRangeClasses(tab, rowKey, columnMeta.name, visualIndex, columnMeta.columnIndex),
                  'frozen-col': columnMeta.columnIndex < frozenColumnCount,
                  'frozen-col-edge': isLastFrozenColumn(columnMeta.columnIndex),
                }"
                @mousedown.left="emit('cell-mousedown', tab, row, columnMeta.name, visualIndex, columnMeta.columnIndex, $event)"
                @mouseenter="emit('cell-enter', tab, row, columnMeta.name, visualIndex, columnMeta.columnIndex)"
                @mouseup="emit('range-end')"
                @click="emit('cell-click', tab, row, columnMeta.name, visualIndex, columnMeta.columnIndex)"
                @dblclick="emit('cell-dblclick', tab, row, columnMeta.name, visualIndex, columnMeta.columnIndex)"
              >
                <input
                  v-if="editingCell?.rowKey === rowKey && editingCell?.column === columnMeta.name"
                  :value="editDraft"
                  :data-row-index="visualIndex"
                  :data-column-index="columnMeta.columnIndex"
                  @input="emit('edit-input', $event.target.value)"
                  @blur="emit('cell-blur')"
                  @keydown.enter.prevent.stop="emit('finish-edit')"
                  @keydown.escape.prevent.stop="emit('cancel-edit')"
                  @keydown.tab.prevent.stop="emit('tab-edit', $event.shiftKey)"
                />
                <span v-else-if="hasActiveCellSearch" class="wb-cell-text" v-html="highlightCellHtml(tab, row, columnMeta.name, rowKey)"></span>
                <span v-else class="wb-cell-text">{{ plainCellText(tab, row, columnMeta.name, rowKey) }}</span>
              </td>
            </tr>
          </template>
          <tr v-if="virtualRange.totalHeight - virtualRange.padTop - visibleRows.length * rowHeight > 0" aria-hidden="true" class="wb-virtual-spacer">
            <td :style="{ height: (virtualRange.totalHeight - virtualRange.padTop - visibleRows.length * rowHeight) + 'px' }" :colspan="1 + activeColumns.length"></td>
          </tr>
          <!-- 0 行空状态：表加载成功但无数据 -->
          <tr v-if="!tab.loading && !tab.loadError && loadedRowCount === 0 && !hasInsertRows" class="wb-grid-empty-row">
            <td :colspan="1 + activeColumns.length" class="wb-grid-empty-cell">
              {{ tab.filter || tab.sort ? '没有匹配的数据' : '暂无数据' }}
            </td>
          </tr>
          <!-- 加载更多进度 sentinel -->
          <tr v-if="tab.loadingMore" class="wb-grid-loadmore-row">
            <td :colspan="1 + activeColumns.length" class="wb-grid-loadmore-cell">
              <span class="wb-grid-loadmore-spinner" aria-hidden="true"></span>
              <span>加载更多…</span>
            </td>
          </tr>
          <tr v-else-if="tab.fullyLoaded && loadedRowCount > 0" class="wb-grid-loadmore-row">
            <td :colspan="1 + activeColumns.length" class="wb-grid-loadmore-cell is-done">
              已加载全部 {{ loadedRowCount }} 行
            </td>
          </tr>
          <tr
            v-for="(insertRow, insertRowIndex) in trailingInsertRows"
            :key="insertRow.id"
            class="wb-insert-row"
            :class="{
              'is-unsaved': true,
              'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id,
              'row-range-active': isRowInSelectedRange(tab, trailingInsertVisualIndex(insertRowIndex)),
            }"
          >
            <td
              class="wb-row-index wb-row-insert-marker wb-row-header"
              :class="{ 'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id }"
              title="新增未保存"
              aria-label="新增未保存行"
              @mousedown.stop.prevent
              @click.stop="emit('insert-row-select', tab, insertRow.id, $event)"
              @contextmenu.prevent.stop="emit('row-contextmenu', $event, tab, insertRowObject(insertRow), trailingInsertVisualIndex(insertRowIndex))"
            >
              {{ trailingInsertVisualIndex(insertRowIndex) + 1 }}
              <span
                class="wb-row-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label="拖动调整全部数据行高度，双击恢复默认"
                title="拖动调整全部数据行高度 · 双击恢复默认"
                @pointerdown="startRowResize($event, 'data')"
                @dblclick.stop.prevent="resetRowHeight('data')"
              ></span>
            </td>
            <td
              v-for="columnMeta in renderColumns"
              :key="`insert-${insertRow.id}-${columnMeta.name}`"
              :style="mergeStyles(colStyle(tab.id, columnMeta.name), frozenColumnStyle(columnMeta.columnIndex))"
              :data-column-index="columnMeta.columnIndex"
              :data-row-key="insertRowKey(tab, insertRow)"
              :data-column-name="columnMeta.name"
              :title="getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name) || ''"
              :class="{
                pending: isCellPending(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name),
                error: getCellError(editState, tabScopeKey(tab), insertRowKey(tab, insertRow), columnMeta.name),
                selected: selectedCell?.rowKey === insertRowKey(tab, insertRow) && selectedCell?.column === columnMeta.name && selectedCell?.tabId === tab.id,
                'col-active': isActiveColumn(columnMeta.name),
                editing: editingCell?.rowKey === insertRowKey(tab, insertRow) && editingCell?.column === columnMeta.name,
                'insert-selected': selectedInsertCell?.tabId === tab.id && selectedInsertCell?.rowId === insertRow.id && selectedInsertCell?.columnIndex === columnMeta.columnIndex,
                ...cellRangeClasses(tab, insertRowKey(tab, insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex),
                'frozen-col': columnMeta.columnIndex < frozenColumnCount,
                'frozen-col-edge': isLastFrozenColumn(columnMeta.columnIndex),
              }"
              @mousedown.left="emit('cell-mousedown', tab, insertRowObject(insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex, $event)"
              @mouseenter="emit('cell-enter', tab, insertRowObject(insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex)"
              @mouseup="emit('range-end')"
              @click="emit('cell-click', tab, insertRowObject(insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex)"
              @dblclick="emit('cell-dblclick', tab, insertRowObject(insertRow), columnMeta.name, trailingInsertVisualIndex(insertRowIndex), columnMeta.columnIndex)"
            >
              <input
                v-if="editingCell?.rowKey === insertRowKey(tab, insertRow) && editingCell?.column === columnMeta.name"
                :value="editDraft"
                :data-insert-row-id="insertRow.id"
                :data-insert-column-index="columnMeta.columnIndex"
                :data-row-index="trailingInsertVisualIndex(insertRowIndex)"
                :data-column-index="columnMeta.columnIndex"
                :placeholder="isPrimaryKeyColumn(columnMeta.column, columnMeta.name) ? 'auto' : ''"
                @focus="emit('insert-focus', tab, insertRow.id, columnMeta.columnIndex)"
                @input="emit('edit-input', $event.target.value)"
                @paste.prevent.stop="emit('insert-paste', tab, insertRow.id, columnMeta.columnIndex, $event)"
                @keydown.arrow-up.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                @keydown.arrow-down.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                @keydown.arrow-left.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                @keydown.arrow-right.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                @keydown.tab.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                @keydown.escape.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnMeta.columnIndex, $event)"
                @blur="emit('cell-blur')"
                @keydown.enter.prevent.stop="emit('finish-edit')"
              />
              <span v-else class="wb-cell-text" v-html="highlightInsertCellByName(tab, insertRow, columnMeta.name)"></span>
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
