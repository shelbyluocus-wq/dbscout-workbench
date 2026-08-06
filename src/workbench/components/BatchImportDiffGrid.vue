<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  CirclePlus,
  PencilLine,
  Trash2,
  TriangleAlert,
} from "lucide-vue-next";
import { firstRealChange } from "../utils/changeSemantics.js";

/**
 * Split-screen ("code diff" style) comparison for one target table of the
 * batch import comparison: the LEFT pane shows the Excel import data, the
 * RIGHT pane the current database rows, aligned per row by primary key.
 *
 * Each pane is split into a FROZEN block (primary-key columns, pinned at the
 * left edge, carrying the row status icon) and a SCROLLING block (all other
 * columns). All four regions scroll vertically in lockstep; the two
 * scrolling blocks also share their horizontal offset, so the two panes
 * always show the exact same region.
 *
 * On first render / table switch / filter change the view jumps to the
 * topmost changed row's leftmost changed field and selects that cell, so
 * the first thing on screen is the actual change — pinned into the
 * permanent detail bar below.
 */
const props = defineProps({
  tableName: { type: String, default: "" },
  // [{ name, primaryKey }] — plain string entries are tolerated and treated
  // as non-PK columns.
  columns: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] },
});

const PAGE_SIZE = 200;
const COL_WIDTH = 130;
const ROW_HEIGHT = 29;
const visibleCount = ref(PAGE_SIZE);

const normalizedColumns = computed(() =>
  (props.columns || [])
    .map((column) =>
      typeof column === "string"
        ? { name: column, primaryKey: false }
        : { name: String(column?.name || ""), primaryKey: Boolean(column?.primaryKey) },
    )
    .filter((column) => column.name),
);
// PK columns are pinned to the left edge of every pane (multiple PK columns
// are frozen together), the rest scroll horizontally in schema order.
const frozenColumns = computed(() => normalizedColumns.value.filter((column) => column.primaryKey));
const scrollColumns = computed(() => normalizedColumns.value.filter((column) => !column.primaryKey));

// Track counts travel as CSS variables so every strip shares track widths.
const colsVar = computed(() => ({
  "--wb-diff-cols": String(Math.max(1, scrollColumns.value.length)),
  "--wb-diff-frozen": String(Math.max(1, frozenColumns.value.length)),
}));

const visibleRows = computed(() => props.rows.slice(0, visibleCount.value));
const hiddenCount = computed(() => Math.max(0, props.rows.length - visibleCount.value));

// Long text (JSON payloads, …) is capped so one giant value cannot blow up
// the layout; the detail bar below always shows the complete value.
const DISPLAY_LIMIT = 1000;

// Hovering a row highlights it in both panes to make eye-tracking easier.
const hoveredRowId = ref("");

// Clicking a data cell selects that column in both panes at once and pins
// the full values into the detail bar.
const selectedCell = ref(null);

function selectCell(row, column, side) {
  if (row.status === "error" || !hasSide(row, side)) return;
  const current = selectedCell.value;
  if (current && current.row.id === row.id && current.column === column) {
    selectedCell.value = null;
    return;
  }
  selectedCell.value = { row, column };
}

// ── Scroll synchronization ────────────────────────────────────────────────
// Four scroll regions (frozen + scrolling per pane) share one vertical
// offset; the two scrolling blocks additionally share the horizontal offset
// with their column-header strips. Only the right pane shows scrollbars.
const afterFrozenRef = ref(null);
const afterMainRef = ref(null);
const afterHeadRef = ref(null);
const beforeFrozenRef = ref(null);
const beforeMainRef = ref(null);
const beforeHeadRef = ref(null);
let syncingScroll = false;

function verticalRegions() {
  return [afterFrozenRef.value, afterMainRef.value, beforeFrozenRef.value, beforeMainRef.value]
    .filter(Boolean);
}

function handlePaneScroll(event) {
  if (syncingScroll) return;
  syncingScroll = true;
  const source = event.target;
  for (const el of verticalRegions()) {
    if (el !== source) el.scrollTop = source.scrollTop;
  }
  const left = source.scrollLeft;
  const otherMain = source === afterMainRef.value ? beforeMainRef.value : afterMainRef.value;
  if ((source === afterMainRef.value || source === beforeMainRef.value) && otherMain) {
    otherMain.scrollLeft = left;
  }
  if (afterHeadRef.value) afterHeadRef.value.scrollLeft = afterMainRef.value?.scrollLeft ?? 0;
  if (beforeHeadRef.value) beforeHeadRef.value.scrollLeft = beforeMainRef.value?.scrollLeft ?? 0;
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

// Jump to the topmost row's leftmost REAL change and select that cell.
// Format-only differences (same JSON content, different whitespace) are
// skipped so the landing cell always shows a visible difference. Scans ALL
// rows (not just the rendered page) and expands the render window when the
// target lives beyond PAGE_SIZE.
function scrollToFirstChange() {
  const rows = props.rows || [];
  const target = firstRealChange(rows);
  if (!target) {
    selectedCell.value = null;
    return;
  }
  const { row, rowIndex, columnName } = target;
  if (rowIndex + 1 > visibleCount.value) {
    visibleCount.value = Math.min(rows.length, rowIndex + 21);
  }
  selectedCell.value = { row, column: columnName };
  nextTick(() => {
    const scrollIndex = scrollColumns.value.findIndex((column) => column.name === columnName);
    const left = Math.max(0, scrollIndex) * COL_WIDTH;
    const top = rowIndex * ROW_HEIGHT;
    for (const el of verticalRegions()) {
      el.scrollTop = top;
    }
    for (const el of [afterMainRef.value, beforeMainRef.value]) {
      if (el) el.scrollLeft = left;
    }
    if (afterHeadRef.value) afterHeadRef.value.scrollLeft = left;
    if (beforeHeadRef.value) beforeHeadRef.value.scrollLeft = left;
  });
}

onMounted(scrollToFirstChange);

watch(
  () => props.rows,
  () => {
    visibleCount.value = PAGE_SIZE;
    selectedCell.value = null;
    scrollToFirstChange();
  },
);

function statusLabel(status) {
  if (status === "inserted") return "新增";
  if (status === "updated") return "修改";
  if (status === "deleted") return "删除";
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

/**
 * Resolve one data cell. `side` is "after" (Excel 导入数据) or "before"
 * (数据库当前数据). Rows whose counterpart does not exist at all (deleted →
 * no Excel side, inserted → no database side) show placeholder cells on
 * that side instead.
 */
function cell(row, column, side) {
  const source = side === "after" ? row.after : row.before;
  if (!source || !Object.hasOwn(source, column)) {
    return { changed: false, text: "" };
  }
  const wholeRow = row.status === "inserted" || row.status === "deleted";
  return {
    changed: wholeRow || changedColumns(row).has(column),
    text: formatValue(source[column]),
  };
}

/**
 * The complete value for the detail bar — no display cap, unlike the cell
 * text which is truncated for layout safety.
 */
function fullCellText(row, column, side) {
  const source = side === "after" ? row.after : row.before;
  if (!source || !Object.hasOwn(source, column)) return "";
  const value = source[column];
  if (value === null || value === undefined) return "NULL";
  return String(value);
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
  <div class="wb-batch-diff" :style="colsVar">
    <template v-if="normalizedColumns.length">
      <!-- Header zone: per pane a caption plus a frozen/static PK header and
           a scrolling column strip that mirrors the pane's horizontal
           offset. Headers never scroll vertically. -->
      <div class="wb-batch-diff-heads">
        <div class="wb-batch-diff-pane-head">
          <div class="wb-batch-diff-caption is-after">Excel 导入数据（新）</div>
          <div class="wb-batch-diff-headrow">
            <div v-if="frozenColumns.length" class="wb-batch-diff-frozen-cols">
              <span
                v-for="column in frozenColumns"
                :key="`after:${column.name}`"
                class="wb-batch-diff-col"
                :title="column.name"
              >{{ column.name }}</span>
            </div>
            <div ref="afterHeadRef" class="wb-batch-diff-cols">
              <div class="wb-batch-diff-col-row">
                <span
                  v-for="column in scrollColumns"
                  :key="`after:${column.name}`"
                  class="wb-batch-diff-col"
                  :title="column.name"
                >{{ column.name }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="wb-batch-diff-pane-head is-before">
          <div class="wb-batch-diff-caption is-before">数据库当前数据（旧）</div>
          <div class="wb-batch-diff-headrow">
            <div v-if="frozenColumns.length" class="wb-batch-diff-frozen-cols">
              <span
                v-for="column in frozenColumns"
                :key="`before:${column.name}`"
                class="wb-batch-diff-col"
                :title="column.name"
              >{{ column.name }}</span>
            </div>
            <div ref="beforeHeadRef" class="wb-batch-diff-cols">
              <div class="wb-batch-diff-col-row">
                <span
                  v-for="column in scrollColumns"
                  :key="`before:${column.name}`"
                  class="wb-batch-diff-col"
                  :title="column.name"
                >{{ column.name }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="wb-batch-diff-body">
        <div class="wb-batch-diff-pane is-after">
          <div
            v-if="frozenColumns.length"
            ref="afterFrozenRef"
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
                @mouseenter="hoveredRowId = row.id"
              >
                <span
                  v-if="row.status === 'error'"
                  class="wb-batch-diff-cell is-error-frozen"
                ><TriangleAlert :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" /></span>
                <span
                  v-else-if="!hasSide(row, 'after')"
                  class="wb-batch-diff-cell is-placeholder-frozen"
                >—</span>
                <span
                  v-for="column in frozenColumns"
                  v-else
                  :key="`after:${column.name}`"
                  class="wb-batch-diff-cell is-after"
                  :class="{
                    'is-changed': cell(row, column.name, 'after').changed,
                    'is-selected': selectedCell?.row.id === row.id && selectedCell?.column === column.name,
                  }"
                  :title="`${statusLabel(row.status)} · ${identityText(row)} · ${locationText(row)}`"
                  @click="selectCell(row, column.name, 'after')"
                ><CirclePlus v-if="row.status === 'inserted'" :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" /><PencilLine v-else-if="row.status === 'updated'" :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" /><Trash2 v-else-if="row.status === 'deleted'" :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" /><TriangleAlert v-else :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" />{{ cell(row, column.name, "after").text }}</span>
              </div>
            </div>
          </div>
          <div
            ref="afterMainRef"
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
                @mouseenter="hoveredRowId = row.id"
              >
                <span
                  v-if="row.status === 'error'"
                  class="wb-batch-diff-cell is-error-text"
                >{{ row.error }}</span>
                <span
                  v-else-if="!hasSide(row, 'after')"
                  class="wb-batch-diff-cell is-placeholder-row"
                >— {{ placeholderText("after") }} —</span>
                <span
                  v-for="column in scrollColumns"
                  v-else
                  :key="`after:${column.name}`"
                  class="wb-batch-diff-cell is-after"
                  :class="{
                    'is-changed': cell(row, column.name, 'after').changed,
                    'is-selected': selectedCell?.row.id === row.id && selectedCell?.column === column.name,
                  }"
                  :title="cell(row, column.name, 'after').text"
                  @click="selectCell(row, column.name, 'after')"
                >{{ cell(row, column.name, "after").text }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="wb-batch-diff-pane is-before">
          <div
            v-if="frozenColumns.length"
            ref="beforeFrozenRef"
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
                @mouseenter="hoveredRowId = row.id"
              >
                <span
                  v-if="row.status === 'error'"
                  class="wb-batch-diff-cell is-error-frozen"
                ><TriangleAlert :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" /></span>
                <span
                  v-else-if="!hasSide(row, 'before')"
                  class="wb-batch-diff-cell is-placeholder-frozen"
                >—</span>
                <span
                  v-for="column in frozenColumns"
                  v-else
                  :key="`before:${column.name}`"
                  class="wb-batch-diff-cell is-before"
                  :class="{
                    'is-changed': cell(row, column.name, 'before').changed,
                    'is-selected': selectedCell?.row.id === row.id && selectedCell?.column === column.name,
                  }"
                  :title="`${statusLabel(row.status)} · ${identityText(row)} · ${locationText(row)}`"
                  @click="selectCell(row, column.name, 'before')"
                ><CirclePlus v-if="row.status === 'inserted'" :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" /><PencilLine v-else-if="row.status === 'updated'" :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" /><Trash2 v-else-if="row.status === 'deleted'" :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" /><TriangleAlert v-else :size="12" class="wb-batch-diff-status-icon" aria-hidden="true" />{{ cell(row, column.name, "before").text }}</span>
              </div>
            </div>
          </div>
          <div
            ref="beforeMainRef"
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
                @mouseenter="hoveredRowId = row.id"
              >
                <span v-if="row.status === 'error'" class="wb-batch-diff-cell is-error-gap"></span>
                <span
                  v-else-if="!hasSide(row, 'before')"
                  class="wb-batch-diff-cell is-placeholder-row"
                >— {{ placeholderText("before") }} —</span>
                <span
                  v-for="column in scrollColumns"
                  v-else
                  :key="`before:${column.name}`"
                  class="wb-batch-diff-cell is-before"
                  :class="{
                    'is-changed': cell(row, column.name, 'before').changed,
                    'is-selected': selectedCell?.row.id === row.id && selectedCell?.column === column.name,
                  }"
                  :title="cell(row, column.name, 'before').text"
                  @click="selectCell(row, column.name, 'before')"
                >{{ cell(row, column.name, "before").text }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 常驻单元格详情栏：点击任意数据单元格更新内容，尺寸固定不变 -->
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
            <pre>{{ fullCellText(selectedCell.row, selectedCell.column, "after") }}</pre>
          </section>
          <section v-if="hasSide(selectedCell.row, 'before')">
            <label>数据库当前数据（旧）</label>
            <pre>{{ fullCellText(selectedCell.row, selectedCell.column, "before") }}</pre>
          </section>
        </div>
        <div v-else class="wb-batch-diff-detail-panes is-empty">
          <p>新旧两侧的完整值会在这里对照显示</p>
        </div>
      </div>
    </template>

    <!-- Without schema columns (e.g. the table-level compare failed) fall back
         to a plain status list so errors are still readable. -->
    <div v-else class="wb-batch-diff-plain">
      <p v-for="row in visibleRows" :key="row.id" :class="`is-${row.status}`">
        <TriangleAlert v-if="row.status === 'error'" :size="13" aria-hidden="true" />
        <strong>{{ statusLabel(row.status) }}</strong>
        <span>{{ row.status === "error" ? row.error : identityText(row) }}</span>
      </p>
    </div>

    <button
      v-if="hiddenCount"
      type="button"
      class="wb-batch-diff-more"
      @click="visibleCount += PAGE_SIZE"
    >
      显示更多（剩余 {{ hiddenCount }} 条）
    </button>
  </div>
</template>
