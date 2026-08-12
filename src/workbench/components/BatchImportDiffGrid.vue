<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  CirclePlus,
  Equal,
  PencilLine,
  Trash2,
  TriangleAlert,
} from "lucide-vue-next";
import { firstRealChange } from "../utils/changeSemantics.js";
import { highlightSearchText, matchSearchText } from "../utils/searchMatch.js";
import { normalizeTableFilterMode } from "../utils/tableFilterMode.js";
import { comparisonCellSearchText } from "../composables/useBatchComparisonSearch.js";

const props = defineProps({
  tableName: { type: String, default: "" },
  columnWidthKey: { type: String, default: "" },
  columns: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] },
  showPrimaryKeys: { type: Boolean, default: true },
  widthResetToken: { type: Number, default: 0 },
  searchQuery: { type: String, default: "" },
  searchMode: { type: String, default: "continuous" },
  activeSearchMatch: { type: Object, default: null },
});

const PAGE_SIZE = 200;
const DEFAULT_COL_WIDTH = 130;
const MIN_COL_WIDTH = 80;
const MAX_COL_WIDTH = 600;
const ROW_HEIGHT = 29;
const DISPLAY_LIMIT = 1000;
const visibleCount = ref(PAGE_SIZE);
const columnWidths = ref({});

const normalizedColumns = computed(() =>
  (props.columns || [])
    .map((column) =>
      typeof column === "string"
        ? { name: column, primaryKey: false }
        : { name: String(column?.name || ""), primaryKey: Boolean(column?.primaryKey) },
    )
    .filter((column) => column.name),
);
const frozenColumns = computed(() => (
  props.showPrimaryKeys ? normalizedColumns.value.filter((column) => column.primaryKey) : []
));
const scrollColumns = computed(() => normalizedColumns.value.filter((column) => !column.primaryKey));

function clampWidth(width) {
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(Number(width) || DEFAULT_COL_WIDTH)));
}

function widthFor(column) {
  return clampWidth(columnWidths.value[column] || DEFAULT_COL_WIDTH);
}

function gridStyle(columns) {
  const tracks = columns.map((column) => `${widthFor(column.name)}px`).join(" ");
  return { gridTemplateColumns: tracks || "minmax(180px, 1fr)" };
}

const frozenGridStyle = computed(() => gridStyle(frozenColumns.value));
const scrollGridStyle = computed(() => gridStyle(scrollColumns.value));

function widthStorageKey() {
  const identity = props.columnWidthKey || props.tableName;
  return `dbscout_batch_compare_widths_v1:${encodeURIComponent(identity)}`;
}

function loadStoredWidths() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(widthStorageKey()) || "{}");
    columnWidths.value = Object.fromEntries(
      Object.entries(parsed || {}).map(([column, width]) => [column, clampWidth(width)]),
    );
  } catch {
    columnWidths.value = {};
  }
}

function saveStoredWidths() {
  try {
    globalThis.localStorage?.setItem(widthStorageKey(), JSON.stringify(columnWidths.value));
  } catch {
    // Width persistence is optional; resizing still works for this view.
  }
}

function resetStoredWidths() {
  columnWidths.value = {};
  try {
    globalThis.localStorage?.removeItem(widthStorageKey());
  } catch {
    // Keep the in-memory reset when storage is unavailable.
  }
}

let resizeState = null;

function onColumnResizeMove(event) {
  if (!resizeState) return;
  const width = clampWidth(resizeState.startWidth + event.clientX - resizeState.startX);
  columnWidths.value = { ...columnWidths.value, [resizeState.column]: width };
}

function finishColumnResize() {
  if (!resizeState) return;
  resizeState = null;
  window.removeEventListener("pointermove", onColumnResizeMove);
  window.removeEventListener("pointerup", finishColumnResize);
  document.body.classList.remove("wb-is-column-resizing");
  saveStoredWidths();
}

function beginColumnResize(column, event) {
  finishColumnResize();
  event.currentTarget?.focus?.();
  resizeState = {
    column,
    startX: event.clientX,
    startWidth: widthFor(column),
  };
  document.body.classList.add("wb-is-column-resizing");
  window.addEventListener("pointermove", onColumnResizeMove);
  window.addEventListener("pointerup", finishColumnResize, { once: true });
}

function setColumnWidth(column, width) {
  columnWidths.value = { ...columnWidths.value, [column]: clampWidth(width) };
  saveStoredWidths();
}

function resizeColumnWithKeyboard(column, event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  setColumnWidth(column, widthFor(column) + (event.key === "ArrowRight" ? 10 : -10));
}

function autoFitColumn(column) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context) context.font = getComputedStyle(document.body).font || "12px sans-serif";
  let width = context?.measureText(column).width || column.length * 7;
  for (const row of (props.rows || []).slice(0, 500)) {
    for (const side of ["before", "after"]) {
      const text = formatValue(row?.[side]?.[column]);
      width = Math.max(width, context?.measureText(text).width || text.length * 7);
    }
  }
  setColumnWidth(column, width + 30);
}

const visibleRows = computed(() => props.rows.slice(0, visibleCount.value));
const hiddenCount = computed(() => Math.max(0, props.rows.length - visibleCount.value));
const hoveredRowId = ref("");
const selectedCell = ref(null);
const hasSearchQuery = computed(() => Boolean(props.searchQuery.trim()));
let searchOrigin = null;

function selectCell(row, column, side) {
  if (row.status === "error" || !hasSide(row, side)) return;
  const current = selectedCell.value;
  if (current && current.row.id === row.id && current.column === column) {
    selectedCell.value = null;
    return;
  }
  selectedCell.value = { row, column };
}

const afterStatusRef = ref(null);
const afterFrozenRef = ref(null);
const afterMainRef = ref(null);
const afterHeadRef = ref(null);
const beforeStatusRef = ref(null);
const beforeFrozenRef = ref(null);
const beforeMainRef = ref(null);
const beforeHeadRef = ref(null);
const paneRegionRefs = {
  after: {
    status: afterStatusRef,
    frozen: afterFrozenRef,
    main: afterMainRef,
    head: afterHeadRef,
  },
  before: {
    status: beforeStatusRef,
    frozen: beforeFrozenRef,
    main: beforeMainRef,
    head: beforeHeadRef,
  },
};
let syncingScroll = false;

function setPaneRef(side, region, element) {
  const target = paneRegionRefs[side]?.[region];
  if (target) target.value = element;
}

function verticalRegions() {
  return [
    afterStatusRef.value,
    afterFrozenRef.value,
    afterMainRef.value,
    beforeStatusRef.value,
    beforeFrozenRef.value,
    beforeMainRef.value,
  ].filter(Boolean);
}

function handlePaneScroll(event) {
  if (syncingScroll) return;
  syncingScroll = true;
  const source = event.target;
  for (const element of verticalRegions()) {
    if (element !== source) element.scrollTop = source.scrollTop;
  }
  if (source === afterMainRef.value || source === beforeMainRef.value) {
    const otherMain = source === afterMainRef.value ? beforeMainRef.value : afterMainRef.value;
    if (otherMain) otherMain.scrollLeft = source.scrollLeft;
  }
  if (afterHeadRef.value) afterHeadRef.value.scrollLeft = afterMainRef.value?.scrollLeft ?? 0;
  if (beforeHeadRef.value) beforeHeadRef.value.scrollLeft = beforeMainRef.value?.scrollLeft ?? 0;
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

function horizontalOffset(columnName) {
  let offset = 0;
  for (const column of scrollColumns.value) {
    if (column.name === columnName) break;
    offset += widthFor(column.name);
  }
  return offset;
}

function scrollToCell(row, rowIndex, columnName) {
  if (!row || rowIndex < 0 || !columnName) return false;
  if (rowIndex + 1 > visibleCount.value) {
    visibleCount.value = Math.min(props.rows.length, rowIndex + 21);
  }
  selectedCell.value = { row, column: columnName };
  nextTick(() => {
    const top = rowIndex * ROW_HEIGHT;
    for (const element of verticalRegions()) element.scrollTop = top;
    if (scrollColumns.value.some((column) => column.name === columnName)) {
      const left = horizontalOffset(columnName);
      for (const element of [afterMainRef.value, beforeMainRef.value]) {
        if (element) element.scrollLeft = left;
      }
      if (afterHeadRef.value) afterHeadRef.value.scrollLeft = left;
      if (beforeHeadRef.value) beforeHeadRef.value.scrollLeft = left;
    }
  });
  return true;
}

function scrollToFirstChange() {
  const rows = props.rows || [];
  const target = firstRealChange(rows);
  if (!target) {
    selectedCell.value = null;
    return;
  }
  const { row, rowIndex, columnName } = target;
  scrollToCell(row, rowIndex, columnName);
}

function searchMatchRowIndex(match) {
  if (!match) return -1;
  const byReference = props.rows.indexOf(match.row);
  if (byReference >= 0) return byReference;
  return props.rows.findIndex((row) => row.id === match.rowId);
}

function scrollToSearchMatch(match = props.activeSearchMatch) {
  const rowIndex = searchMatchRowIndex(match);
  if (rowIndex < 0) return false;
  return scrollToCell(props.rows[rowIndex], rowIndex, match.columnName);
}

function captureSearchOrigin() {
  if (searchOrigin) return;
  searchOrigin = {
    selectedRowId: selectedCell.value?.row?.id,
    selectedColumn: selectedCell.value?.column || "",
    scrollTop: afterMainRef.value?.scrollTop ?? beforeMainRef.value?.scrollTop ?? 0,
    scrollLeft: afterMainRef.value?.scrollLeft ?? beforeMainRef.value?.scrollLeft ?? 0,
  };
}

function restoreSearchOrigin() {
  const origin = searchOrigin;
  searchOrigin = null;
  if (!origin) return;
  const rowIndex = props.rows.findIndex((row) => row.id === origin.selectedRowId);
  if (rowIndex >= 0 && origin.selectedColumn) {
    if (rowIndex + 1 > visibleCount.value) {
      visibleCount.value = Math.min(props.rows.length, rowIndex + 21);
    }
    selectedCell.value = { row: props.rows[rowIndex], column: origin.selectedColumn };
  } else {
    selectedCell.value = null;
  }
  nextTick(() => {
    for (const element of verticalRegions()) element.scrollTop = origin.scrollTop;
    for (const element of [afterMainRef.value, beforeMainRef.value]) {
      if (element) element.scrollLeft = origin.scrollLeft;
    }
    if (afterHeadRef.value) afterHeadRef.value.scrollLeft = origin.scrollLeft;
    if (beforeHeadRef.value) beforeHeadRef.value.scrollLeft = origin.scrollLeft;
  });
}

onMounted(() => {
  loadStoredWidths();
  scrollToFirstChange();
  nextTick(() => {
    if (!hasSearchQuery.value) return;
    captureSearchOrigin();
    scrollToSearchMatch();
  });
});

watch(
  () => props.rows,
  () => {
    visibleCount.value = PAGE_SIZE;
    if (hasSearchQuery.value) {
      const selectedRowId = selectedCell.value?.row?.id;
      const nextSelectedRow = props.rows.find((row) => row.id === selectedRowId);
      selectedCell.value = nextSelectedRow && selectedCell.value
        ? { row: nextSelectedRow, column: selectedCell.value.column }
        : null;
      scrollToSearchMatch();
    } else {
      selectedCell.value = null;
      scrollToFirstChange();
    }
  },
);
watch(() => props.columnWidthKey || props.tableName, loadStoredWidths);
watch(() => props.widthResetToken, resetStoredWidths);
watch(
  () => props.searchQuery.trim(),
  (nextQuery, previousQuery) => {
    if (nextQuery && !previousQuery) captureSearchOrigin();
    else if (!nextQuery && previousQuery) restoreSearchOrigin();
  },
);
watch(
  () => props.activeSearchMatch,
  (match) => {
    if (hasSearchQuery.value && match) scrollToSearchMatch(match);
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  finishColumnResize();
});

function statusLabel(status) {
  if (status === "inserted") return "新增";
  if (status === "updated") return "修改";
  if (status === "deleted") return "删除";
  if (status === "unchanged") return "未变化";
  return "异常";
}

function identityText(row) {
  const entries = Object.entries(row.identity || {});
  if (!entries.length) return row.row ? `Excel 第 ${row.row} 行` : "—";
  return entries.map(([key, value]) => `${key}=${value}`).join(" · ");
}

function locationText(row) {
  if (row.status === "deleted") return "数据库现有行";
  return row.row ? `Excel 第 ${row.row} 行` : "";
}

function rowTitle(row) {
  return [statusLabel(row.status), identityText(row), locationText(row)].filter(Boolean).join(" · ");
}

const changedColumnCache = new WeakMap();
function changedColumns(row) {
  let set = changedColumnCache.get(row);
  if (!set) {
    set = new Set((row.changes || []).map((change) => change.columnName));
    changedColumnCache.set(row, set);
  }
  return set;
}

function formatValue(value) {
  if (value === null || value === undefined) return "NULL";
  const text = String(value);
  return text.length > DISPLAY_LIMIT ? `${text.slice(0, DISPLAY_LIMIT)}…` : text;
}

function cell(row, column, side) {
  const source = side === "after" ? row.after : row.before;
  if (!source || !Object.hasOwn(source, column)) return { changed: false, text: "" };
  return {
    changed: row.status === "inserted" || row.status === "deleted" || changedColumns(row).has(column),
    text: formatValue(source[column]),
  };
}

let searchCellCache = new WeakMap();
let searchCellCacheSignature = "";

function cellSearchResult(row, column, side) {
  const query = props.searchQuery.trim();
  const mode = normalizeTableFilterMode(props.searchMode);
  const signature = `${query}\x1f${mode}`;
  if (signature !== searchCellCacheSignature) {
    searchCellCacheSignature = signature;
    searchCellCache = new WeakMap();
  }
  let rowCache = searchCellCache.get(row);
  if (!rowCache) {
    rowCache = new Map();
    searchCellCache.set(row, rowCache);
  }
  const key = `${side}\x1f${column}`;
  if (rowCache.has(key)) return rowCache.get(key);

  const source = row?.[side];
  const hasValue = Boolean(source && Object.hasOwn(source, column));
  const fullText = hasValue ? comparisonCellSearchText(source[column]) : "";
  const displayText = hasValue ? cell(row, column, side).text : "";
  const match = query && hasValue
    ? matchSearchText(fullText, query, { mode })
    : { matched: false, ranges: [] };
  const result = {
    matched: match.matched,
    html: query ? highlightSearchText(displayText, query, { mode }) : highlightSearchText(displayText, ""),
    fullHtml: query ? highlightSearchText(fullText, query, { mode }) : highlightSearchText(fullText, ""),
  };
  rowCache.set(key, result);
  return result;
}

function isActiveSearchCell(row, column) {
  const match = props.activeSearchMatch;
  if (!match || match.columnName !== column) return false;
  return match.row === row || match.rowId === row.id;
}

function hasSide(row, side) {
  if (side === "after") return row.status !== "deleted";
  return row.status !== "inserted";
}

function placeholderText(side) {
  return side === "after" ? "Excel 中不存在该行（同步后删除）" : "数据库中不存在该行（同步后新增）";
}
</script>

<template>
  <div class="wb-batch-diff">
    <template v-if="normalizedColumns.length">
      <div class="wb-batch-diff-heads">
        <div v-for="side in ['after', 'before']" :key="side" class="wb-batch-diff-pane-head" :class="{ 'is-before': side === 'before' }">
          <div class="wb-batch-diff-caption" :class="`is-${side}`">
            {{ side === "after" ? "Excel 导入数据（新）" : "数据库当前数据（旧）" }}
          </div>
          <div class="wb-batch-diff-headrow">
            <span class="wb-batch-diff-status-head" aria-hidden="true"></span>
            <div v-if="frozenColumns.length" class="wb-batch-diff-frozen-cols" :style="frozenGridStyle">
              <span v-for="column in frozenColumns" :key="`${side}:${column.name}`" class="wb-batch-diff-col" :title="column.name">
                {{ column.name }}
                <i
                  role="separator"
                  tabindex="0"
                  aria-orientation="vertical"
                  :aria-label="`调整 ${column.name} 列宽`"
                  :aria-valuemin="MIN_COL_WIDTH"
                  :aria-valuemax="MAX_COL_WIDTH"
                  :aria-valuenow="widthFor(column.name)"
                  title="拖动调整列宽，双击自动适配"
                  @pointerdown.stop.prevent="beginColumnResize(column.name, $event)"
                  @dblclick.stop.prevent="autoFitColumn(column.name)"
                  @keydown="resizeColumnWithKeyboard(column.name, $event)"
                ></i>
              </span>
            </div>
            <div :ref="(element) => setPaneRef(side, 'head', element)" class="wb-batch-diff-cols">
              <div class="wb-batch-diff-col-row" :style="scrollGridStyle">
                <span v-for="column in scrollColumns" :key="`${side}:${column.name}`" class="wb-batch-diff-col" :title="column.name">
                  {{ column.name }}
                  <i
                    role="separator"
                    tabindex="0"
                    aria-orientation="vertical"
                    :aria-label="`调整 ${column.name} 列宽`"
                    :aria-valuemin="MIN_COL_WIDTH"
                    :aria-valuemax="MAX_COL_WIDTH"
                    :aria-valuenow="widthFor(column.name)"
                    title="拖动调整列宽，双击自动适配"
                    @pointerdown.stop.prevent="beginColumnResize(column.name, $event)"
                    @dblclick.stop.prevent="autoFitColumn(column.name)"
                    @keydown="resizeColumnWithKeyboard(column.name, $event)"
                  ></i>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="wb-batch-diff-body">
        <div v-for="side in ['after', 'before']" :key="side" class="wb-batch-diff-pane" :class="`is-${side}`">
          <div
            :ref="(element) => setPaneRef(side, 'status', element)"
            class="wb-batch-diff-status"
            @scroll="handlePaneScroll"
            @mouseleave="hoveredRowId = ''"
          >
            <div class="wb-batch-diff-strip is-status-strip">
              <div
                v-for="row in visibleRows"
                :key="row.id"
                class="wb-batch-diff-row"
                :class="[`is-${row.status}`, { 'is-hover': hoveredRowId === row.id }]"
                :title="rowTitle(row)"
                @mouseenter="hoveredRowId = row.id"
              >
                <span class="wb-batch-diff-status-cell">
                  <CirclePlus v-if="row.status === 'inserted'" :size="13" aria-hidden="true" />
                  <PencilLine v-else-if="row.status === 'updated'" :size="13" aria-hidden="true" />
                  <Trash2 v-else-if="row.status === 'deleted'" :size="13" aria-hidden="true" />
                  <Equal v-else-if="row.status === 'unchanged'" :size="13" aria-hidden="true" />
                  <TriangleAlert v-else :size="13" aria-hidden="true" />
                  <span class="wb-visually-hidden">{{ statusLabel(row.status) }}</span>
                </span>
              </div>
            </div>
          </div>

          <div
            v-if="frozenColumns.length"
            :ref="(element) => setPaneRef(side, 'frozen', element)"
            class="wb-batch-diff-frozen"
            @scroll="handlePaneScroll"
            @mouseleave="hoveredRowId = ''"
          >
            <div class="wb-batch-diff-strip is-frozen-strip">
              <div
                v-for="row in visibleRows"
                :key="row.id"
                class="wb-batch-diff-row"
                :class="[`is-${row.status}`, { 'is-hover': hoveredRowId === row.id }]"
                :style="frozenGridStyle"
                @mouseenter="hoveredRowId = row.id"
              >
                <span v-if="row.status === 'error'" class="wb-batch-diff-cell is-error-frozen"></span>
                <span v-else-if="!hasSide(row, side)" class="wb-batch-diff-cell is-placeholder-frozen">—</span>
                <span
                  v-for="column in frozenColumns"
                  v-else
                  :key="`${side}:${column.name}`"
                  class="wb-batch-diff-cell"
                  :class="[
                    `is-${side}`,
                    {
                      'is-changed': cell(row, column.name, side).changed,
                      'is-selected': selectedCell?.row.id === row.id && selectedCell?.column === column.name,
                      'is-search-match': cellSearchResult(row, column.name, side).matched,
                      'is-search-current': isActiveSearchCell(row, column.name)
                        && cellSearchResult(row, column.name, side).matched,
                    },
                  ]"
                  :title="cell(row, column.name, side).text"
                  @click="selectCell(row, column.name, side)"
                  v-html="cellSearchResult(row, column.name, side).html"
                ></span>
              </div>
            </div>
          </div>

          <div
            :ref="(element) => setPaneRef(side, 'main', element)"
            class="wb-batch-diff-main"
            @scroll="handlePaneScroll"
            @mouseleave="hoveredRowId = ''"
          >
            <div class="wb-batch-diff-strip">
              <div
                v-for="row in visibleRows"
                :key="row.id"
                class="wb-batch-diff-row"
                :class="[`is-${row.status}`, { 'is-hover': hoveredRowId === row.id }]"
                :style="scrollGridStyle"
                @mouseenter="hoveredRowId = row.id"
              >
                <span v-if="row.status === 'error'" class="wb-batch-diff-cell is-error-text">{{ side === "after" ? row.error : "" }}</span>
                <span v-else-if="!hasSide(row, side)" class="wb-batch-diff-cell is-placeholder-row">— {{ placeholderText(side) }} —</span>
                <span v-else-if="!scrollColumns.length" class="wb-batch-diff-cell is-placeholder-row">没有可显示的普通字段</span>
                <span
                  v-for="column in scrollColumns"
                  v-else
                  :key="`${side}:${column.name}`"
                  class="wb-batch-diff-cell"
                  :class="[
                    `is-${side}`,
                    {
                      'is-changed': cell(row, column.name, side).changed,
                      'is-selected': selectedCell?.row.id === row.id && selectedCell?.column === column.name,
                      'is-search-match': cellSearchResult(row, column.name, side).matched,
                      'is-search-current': isActiveSearchCell(row, column.name)
                        && cellSearchResult(row, column.name, side).matched,
                    },
                  ]"
                  :title="cell(row, column.name, side).text"
                  @click="selectCell(row, column.name, side)"
                  v-html="cellSearchResult(row, column.name, side).html"
                ></span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="wb-batch-diff-detail">
        <header class="wb-batch-diff-detail-header">
          <template v-if="selectedCell">
            <strong>{{ selectedCell.column }}</strong>
            <span>{{ identityText(selectedCell.row) }} · {{ locationText(selectedCell.row) }}</span>
            <button type="button" aria-label="清除单元格选择" @click="selectedCell = null">×</button>
          </template>
          <span v-else class="wb-batch-diff-detail-hint">点击任意单元格，在这里查看完整内容</span>
        </header>
        <div v-if="selectedCell" class="wb-batch-diff-detail-panes">
          <section v-if="hasSide(selectedCell.row, 'after')">
            <label>Excel 导入数据（新）</label>
            <pre v-html="cellSearchResult(selectedCell.row, selectedCell.column, 'after').fullHtml"></pre>
          </section>
          <section v-if="hasSide(selectedCell.row, 'before')">
            <label>数据库当前数据（旧）</label>
            <pre v-html="cellSearchResult(selectedCell.row, selectedCell.column, 'before').fullHtml"></pre>
          </section>
        </div>
        <div v-else class="wb-batch-diff-detail-panes is-empty">
          <p>新旧两侧的完整值会在这里对照显示</p>
        </div>
      </div>
    </template>

    <div v-else class="wb-batch-diff-plain">
      <p v-for="row in visibleRows" :key="row.id" :class="`is-${row.status}`">
        <TriangleAlert v-if="row.status === 'error'" :size="13" aria-hidden="true" />
        <strong>{{ statusLabel(row.status) }}</strong>
        <span>{{ row.status === "error" ? row.error : identityText(row) }}</span>
      </p>
    </div>

    <button v-if="hiddenCount" type="button" class="wb-batch-diff-more" @click="visibleCount += PAGE_SIZE">
      显示更多（剩余 {{ hiddenCount }} 条）
    </button>
  </div>
</template>
