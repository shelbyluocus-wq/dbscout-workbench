<script setup>
import { computed, ref, watch } from "vue";
import {
  CirclePlus,
  PencilLine,
  Trash2,
  TriangleAlert,
} from "lucide-vue-next";

/**
 * Split-screen ("code diff" style) comparison for one target table of the
 * batch import comparison: the LEFT pane shows the Excel import data, the
 * RIGHT pane the current database rows, aligned per row by primary key.
 * Each pane owns its horizontal scrollbar so wide tables stay comparable on
 * one screen; vertical scrolling is synchronized across the meta column and
 * both panes. Changed cells are tinted green (new) / red (old); inserted
 * rows are green on the left, deleted rows red on the right.
 */
const props = defineProps({
  tableName: { type: String, default: "" },
  columns: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] },
});

const PAGE_SIZE = 200;
const ROW_HEIGHT = 29;
const BODY_MAX_HEIGHT = 520;
const visibleCount = ref(PAGE_SIZE);

watch(
  () => props.rows,
  () => {
    visibleCount.value = PAGE_SIZE;
    selectedCell.value = null;
  },
);

const visibleRows = computed(() => props.rows.slice(0, visibleCount.value));
const hiddenCount = computed(() => Math.max(0, props.rows.length - visibleCount.value));

// Body height follows the rendered rows (plus room for the horizontal
// scrollbars), capped so a long diff never swallows the dialog. When the
// cell detail bar is open, the body yields that much space so the detail
// stays inside the visible footprint instead of below the fold.
const DETAIL_RESERVE = 176;
const bodyStyle = computed(() => {
  const cap = selectedCell.value ? BODY_MAX_HEIGHT - DETAIL_RESERVE : BODY_MAX_HEIGHT;
  return { height: `${Math.max(160, Math.min(visibleRows.value.length * ROW_HEIGHT + 16, cap))}px` };
});
// The repeat() count travels as a CSS variable so both panes and their
// column headers share the exact same track widths.
const colsVar = computed(() => ({ "--wb-diff-cols": String(Math.max(1, props.columns.length)) }));

// Long text (JSON payloads, …) is capped so one giant value cannot blow up
// the layout; the title tooltip carries the same capped text.
const DISPLAY_LIMIT = 1000;

// Hovering a row highlights it in all three columns (meta / new / old) to
// make eye-tracking across the split easier.
const hoveredRowId = ref("");

// Clicking a data cell pins its full, untruncated value into the detail bar
// below the split so long values (JSON, long text) stay readable.
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

// ── Scroll synchronization ────────────────────────────────────────────────
// One visible vertical scrollbar lives in the right pane; the meta column
// and the left pane hide theirs but stay scrollable so wheel input works
// everywhere. Horizontal scrolling is per-pane (that is the whole point of
// the split) and only mirrored into the matching column-header strip.
const metaBodyRef = ref(null);
const afterHeadRef = ref(null);
const afterBodyRef = ref(null);
const beforeHeadRef = ref(null);
const beforeBodyRef = ref(null);
let syncingScroll = false;

function handlePaneScroll(event) {
  if (syncingScroll) return;
  syncingScroll = true;
  const source = event.target;
  const top = source.scrollTop;
  for (const el of [metaBodyRef.value, afterBodyRef.value, beforeBodyRef.value]) {
    if (el && el !== source) el.scrollTop = top;
  }
  if (source === afterBodyRef.value && afterHeadRef.value) {
    afterHeadRef.value.scrollLeft = source.scrollLeft;
  }
  if (source === beforeBodyRef.value && beforeHeadRef.value) {
    beforeHeadRef.value.scrollLeft = source.scrollLeft;
  }
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

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
 * no Excel side, inserted → no database side) render a full-width
 * placeholder instead of per-column cells; this returns null for them.
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
    <template v-if="columns.length">
      <!-- Header zone: meta + one caption/column strip per pane. The column
           strips mirror their pane's horizontal scroll, never scroll
           vertically, and therefore always stay visible. -->
      <div class="wb-batch-diff-heads">
        <div class="wb-batch-diff-meta-head">状态 / 主键 · 来源</div>
        <div class="wb-batch-diff-pane-head">
          <div class="wb-batch-diff-caption is-after">Excel 导入数据（新）</div>
          <div ref="afterHeadRef" class="wb-batch-diff-cols">
            <div class="wb-batch-diff-col-row">
              <span
                v-for="column in columns"
                :key="`after:${column}`"
                class="wb-batch-diff-col"
                :title="column"
              >{{ column }}</span>
            </div>
          </div>
        </div>
        <div class="wb-batch-diff-pane-head is-before">
          <div class="wb-batch-diff-caption is-before">数据库当前数据（旧）</div>
          <div ref="beforeHeadRef" class="wb-batch-diff-cols">
            <div class="wb-batch-diff-col-row">
              <span
                v-for="column in columns"
                :key="`before:${column}`"
                class="wb-batch-diff-col"
                :title="column"
              >{{ column }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="wb-batch-diff-body" :style="bodyStyle">
        <div
          ref="metaBodyRef"
          class="wb-batch-diff-meta-col"
          @scroll="handlePaneScroll"
          @mouseleave="hoveredRowId = ''"
        >
          <div
            v-for="row in visibleRows"
            :key="row.id"
            class="wb-batch-diff-meta-row"
            :class="[`is-${row.status}`, { 'is-hover': hoveredRowId === row.id }]"
            :title="`${identityText(row)} ${locationText(row)}`"
            @mouseenter="hoveredRowId = row.id"
          >
            <span class="wb-batch-diff-status">
              <CirclePlus v-if="row.status === 'inserted'" :size="13" aria-hidden="true" />
              <PencilLine v-else-if="row.status === 'updated'" :size="13" aria-hidden="true" />
              <Trash2 v-else-if="row.status === 'deleted'" :size="13" aria-hidden="true" />
              <TriangleAlert v-else :size="13" aria-hidden="true" />
              {{ statusLabel(row.status) }}
            </span>
            <span class="wb-batch-diff-identity">{{ identityText(row) }}</span>
          </div>
        </div>

        <div
          ref="afterBodyRef"
          class="wb-batch-diff-pane is-after"
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
                v-for="column in columns"
                v-else
                :key="`after:${column}`"
                class="wb-batch-diff-cell is-after"
                :class="{
                  'is-changed': cell(row, column, 'after').changed,
                  'is-selected': selectedCell?.row.id === row.id && selectedCell?.column === column,
                }"
                :title="cell(row, column, 'after').text"
                @click="selectCell(row, column, 'after')"
              >{{ cell(row, column, "after").text }}</span>
            </div>
          </div>
        </div>

        <div
          ref="beforeBodyRef"
          class="wb-batch-diff-pane is-before"
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
                v-for="column in columns"
                v-else
                :key="`before:${column}`"
                class="wb-batch-diff-cell is-before"
                :class="{
                  'is-changed': cell(row, column, 'before').changed,
                  'is-selected': selectedCell?.row.id === row.id && selectedCell?.column === column,
                }"
                :title="cell(row, column, 'before').text"
                @click="selectCell(row, column, 'before')"
              >{{ cell(row, column, "before").text }}</span>
            </div>
          </div>
        </div>
      </div>
      <!-- 单元格详情栏：点击任意数据单元格后展开，新旧两侧全文对照 -->
      <div v-if="selectedCell" class="wb-batch-diff-detail">
        <header class="wb-batch-diff-detail-header">
          <strong>{{ selectedCell.column }}</strong>
          <span>{{ identityText(selectedCell.row) }} · {{ locationText(selectedCell.row) }}</span>
          <button type="button" aria-label="关闭单元格详情" @click="selectedCell = null">×</button>
        </header>
        <div class="wb-batch-diff-detail-panes">
          <section v-if="hasSide(selectedCell.row, 'after')">
            <label>Excel 导入数据（新）</label>
            <pre>{{ fullCellText(selectedCell.row, selectedCell.column, "after") }}</pre>
          </section>
          <section v-if="hasSide(selectedCell.row, 'before')">
            <label>数据库当前数据（旧）</label>
            <pre>{{ fullCellText(selectedCell.row, selectedCell.column, "before") }}</pre>
          </section>
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
