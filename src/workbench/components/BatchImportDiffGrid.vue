<script setup>
import { computed, ref, watch } from "vue";
import {
  CirclePlus,
  PencilLine,
  Trash2,
  TriangleAlert,
} from "lucide-vue-next";

/**
 * Side-by-side ("code diff" style) grid for one target table of the batch
 * import comparison: the left column group shows the Excel import data, the
 * right group the current database row, aligned per row by primary key.
 * Changed cells are tinted green (new) / red (old); inserted rows are all
 * green on the left, deleted rows all red on the right.
 */
const props = defineProps({
  tableName: { type: String, default: "" },
  columns: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] },
});

const PAGE_SIZE = 200;
const visibleCount = ref(PAGE_SIZE);

watch(
  () => props.rows,
  () => {
    visibleCount.value = PAGE_SIZE;
  },
);

const visibleRows = computed(() => props.rows.slice(0, visibleCount.value));
const hiddenCount = computed(() => Math.max(0, props.rows.length - visibleCount.value));

// Long text (JSON payloads, …) is capped so one giant value cannot blow up
// the layout; the title tooltip carries the same capped text.
const DISPLAY_LIMIT = 1000;

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
 * Resolve one cell. `side` is "after" (Excel 导入数据) or "before" (数据库
 * 当前数据). Returns { blank, placeholder, changed, text }:
 * - placeholder: the whole side does not exist for this row (deleted rows
 *   have no Excel side, inserted rows have no database side) → shows "—".
 * - blank: the column is not part of that row's data → shows "".
 */
function cell(row, column, side) {
  if (side === "after" && row.status === "deleted") {
    return { placeholder: true, changed: false, text: "—" };
  }
  if (side === "before" && row.status === "inserted") {
    return { placeholder: true, changed: false, text: "—" };
  }
  const source = side === "after" ? row.after : row.before;
  if (!source || !Object.hasOwn(source, column)) {
    return { placeholder: false, changed: false, text: "" };
  }
  const wholeRow = row.status === "inserted" || row.status === "deleted";
  return {
    placeholder: false,
    changed: wholeRow || changedColumns(row).has(column),
    text: formatValue(source[column]),
  };
}

const columnSpan = computed(() => Math.max(1, props.columns.length));
</script>

<template>
  <div class="wb-batch-diff">
    <table v-if="columns.length" class="wb-batch-diff-grid">
      <thead>
        <tr>
          <th class="wb-batch-diff-meta is-status" rowspan="2">状态</th>
          <th class="wb-batch-diff-meta is-identity" rowspan="2">主键 / 来源</th>
          <th class="wb-batch-diff-group is-after" :colspan="columnSpan">Excel 导入数据（新）</th>
          <th class="wb-batch-diff-group is-before" :colspan="columnSpan">数据库当前数据（旧）</th>
        </tr>
        <tr>
          <th v-for="column in columns" :key="`after:${column}`" class="is-after" :title="column">{{ column }}</th>
          <th
            v-for="(column, index) in columns"
            :key="`before:${column}`"
            class="is-before"
            :class="{ 'is-group-start': index === 0 }"
            :title="column"
          >{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visibleRows" :key="row.id" :class="`is-${row.status}`">
          <template v-if="row.status === 'error'">
            <td class="wb-batch-diff-meta is-status">
              <TriangleAlert :size="13" aria-hidden="true" />
              <span>异常</span>
            </td>
            <td class="wb-batch-diff-error" :colspan="1 + columnSpan * 2">{{ row.error }}</td>
          </template>
          <template v-else>
            <td class="wb-batch-diff-meta is-status">
              <CirclePlus v-if="row.status === 'inserted'" :size="13" aria-hidden="true" />
              <PencilLine v-else-if="row.status === 'updated'" :size="13" aria-hidden="true" />
              <Trash2 v-else :size="13" aria-hidden="true" />
              <span>{{ statusLabel(row.status) }}</span>
            </td>
            <td class="wb-batch-diff-meta is-identity" :title="`${identityText(row)} ${locationText(row)}`">
              <strong>{{ identityText(row) }}</strong>
              <small>{{ locationText(row) }}</small>
            </td>
            <td
              v-for="column in columns"
              :key="`after:${column}`"
              class="is-after"
              :class="{
                'is-changed': cell(row, column, 'after').changed,
                'is-placeholder': cell(row, column, 'after').placeholder,
              }"
              :title="cell(row, column, 'after').text"
            >
              {{ cell(row, column, "after").text }}
            </td>
            <td
              v-for="(column, index) in columns"
              :key="`before:${column}`"
              class="is-before"
              :class="{
                'is-changed': cell(row, column, 'before').changed,
                'is-placeholder': cell(row, column, 'before').placeholder,
                'is-group-start': index === 0,
              }"
              :title="cell(row, column, 'before').text"
            >
              {{ cell(row, column, "before").text }}
            </td>
          </template>
        </tr>
      </tbody>
    </table>

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
