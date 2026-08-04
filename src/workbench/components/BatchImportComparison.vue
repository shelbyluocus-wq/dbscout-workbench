<script setup>
import { computed, ref, watch } from "vue";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  PencilLine,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-vue-next";

const props = defineProps({
  comparison: { type: Object, required: true },
});

const activeFilter = ref("all");
const activeTable = ref("");
const expandedRowId = ref("");
const query = ref("");

const filterOptions = [
  { value: "all", label: "全部" },
  { value: "inserted", label: "新增" },
  { value: "updated", label: "修改" },
  { value: "deleted", label: "删除" },
  { value: "error", label: "异常" },
];

const changeCount = computed(() =>
  Number(props.comparison.summary.inserted || 0) +
  Number(props.comparison.summary.updated || 0) +
  Number(props.comparison.summary.deleted || 0)
);
const statusNote = computed(() => {
  if (props.comparison.stale && props.comparison.status === "cancelled") {
    return "这是导入前未完成的对比结果";
  }
  if (props.comparison.stale) return "这是导入前的对比结果";
  if (props.comparison.status === "cancelled") return "对比已取消，仅显示已完成部分";
  return "";
});

const filteredRows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return props.comparison.rows.filter((row) => {
    if (activeFilter.value !== "all" && row.status !== activeFilter.value) return false;
    if (activeTable.value && row.sheetName !== activeTable.value) return false;
    if (!needle) return true;
    const identity = Object.entries(row.identity || {}).map(([key, value]) => `${key}=${value}`).join(" ");
    return [row.tableName, row.sheetName, row.row, identity, row.error]
      .some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
});

function tableDetailCount(table) {
  return Number(table.inserted || 0) + Number(table.updated || 0) + Number(table.deleted || 0) + Number(table.errors || 0);
}

function filterCount(status) {
  if (status === "all") return props.comparison.detailTotal;
  if (status === "error") return Number(props.comparison.summary.errors || 0);
  return Number(props.comparison.summary[status] || 0);
}

function identityText(row) {
  const entries = Object.entries(row.identity || {});
  if (!entries.length) return row.row ? `Excel 第 ${row.row} 行` : row.sheetName;
  return entries.map(([key, value]) => `${key}=${value}`).join(" · ");
}

function statusLabel(status) {
  if (status === "inserted") return "新增";
  if (status === "updated") return "修改";
  if (status === "deleted") return "删除";
  return "异常";
}

function formatValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (value === "") return '""';
  return String(value);
}

function oldValueText(row, change) {
  return row.status === "inserted" ? "无" : formatValue(change.oldValue);
}

function toggleRow(row) {
  expandedRowId.value = expandedRowId.value === row.id ? "" : row.id;
}

watch(
  () => props.comparison.runId,
  () => {
    activeFilter.value = "all";
    activeTable.value = "";
    expandedRowId.value = "";
    query.value = "";
  },
);
</script>

<template>
  <section class="wb-batch-comparison" aria-label="批量导入变化对比">
    <div class="wb-batch-comparison-summary" :class="`is-${comparison.status}`">
      <div><strong>{{ comparison.summary.inserted }}</strong><span>预计新增</span></div>
      <div><strong>{{ comparison.summary.updated }}</strong><span>预计修改</span></div>
      <div><strong>{{ comparison.summary.deleted }}</strong><span>预计删除</span></div>
      <div><strong>{{ comparison.summary.unchanged }}</strong><span>未变化</span></div>
      <div><strong>{{ comparison.summary.errors }}</strong><span>异常</span></div>
    </div>

    <div class="wb-batch-comparison-toolbar">
      <div class="wb-batch-comparison-filters" role="tablist" aria-label="变化类型">
        <button
          v-for="option in filterOptions"
          :key="option.value"
          type="button"
          role="tab"
          :class="{ 'is-active': activeFilter === option.value }"
          :aria-selected="activeFilter === option.value"
          @click="activeFilter = option.value"
        >
          {{ option.label }}
          <span>{{ filterCount(option.value) }}</span>
        </button>
      </div>
      <label class="wb-batch-comparison-search">
        <Search :size="14" aria-hidden="true" />
        <input v-model="query" type="search" placeholder="搜索主键或目标表" aria-label="搜索变化明细" />
      </label>
    </div>

    <div class="wb-batch-comparison-body">
      <nav class="wb-batch-comparison-tables" aria-label="按目标表筛选">
        <button
          type="button"
          :class="{ 'is-active': activeTable === '' }"
          @click="activeTable = ''"
        >
          <span>全部目标表</span>
          <strong>{{ comparison.detailTotal }}</strong>
        </button>
        <button
          v-for="table in comparison.tables"
          :key="table.sheetName"
          type="button"
          :class="{ 'is-active': activeTable === table.sheetName }"
          :title="table.tableName"
          @click="activeTable = table.sheetName"
        >
          <span>{{ table.tableName }}</span>
          <strong>{{ tableDetailCount(table) }}</strong>
        </button>
      </nav>

      <div class="wb-batch-comparison-details">
        <p v-if="statusNote" class="wb-batch-comparison-note" role="status">
          {{ statusNote }}
        </p>
        <p v-if="comparison.truncated" class="wb-batch-comparison-note" role="status">
          明细显示前 {{ comparison.rows.length }} 条，共 {{ comparison.detailTotal }} 条变化或异常
        </p>
        <div v-if="filteredRows.length" class="wb-batch-comparison-row-list">
          <article
            v-for="row in filteredRows"
            :key="row.id"
            class="wb-batch-comparison-row"
            :class="`is-${row.status}`"
          >
            <button
              type="button"
              class="wb-batch-comparison-row-trigger"
              :aria-expanded="expandedRowId === row.id"
              @click="toggleRow(row)"
            >
              <CirclePlus v-if="row.status === 'inserted'" :size="15" aria-hidden="true" />
              <PencilLine v-else-if="row.status === 'updated'" :size="15" aria-hidden="true" />
              <Trash2 v-else-if="row.status === 'deleted'" :size="15" aria-hidden="true" />
              <TriangleAlert v-else :size="15" aria-hidden="true" />
              <span class="wb-batch-comparison-kind">{{ statusLabel(row.status) }}</span>
              <strong :title="identityText(row)">{{ identityText(row) }}</strong>
              <span class="wb-batch-comparison-location">
                {{ row.status === "deleted" ? `${row.tableName} · 数据库现有行` : `${row.tableName} · 第 ${row.row || "-"} 行` }}
              </span>
              <span>{{ row.status === "error" || row.status === "deleted" ? row.columnName || "整行" : `${row.changes.length} 个字段` }}</span>
              <ChevronDown v-if="expandedRowId === row.id" :size="15" aria-hidden="true" />
              <ChevronRight v-else :size="15" aria-hidden="true" />
            </button>

            <div v-if="expandedRowId === row.id" class="wb-batch-comparison-change-list">
              <p v-if="row.status === 'error'" class="wb-batch-comparison-error">{{ row.error }}</p>
              <p v-else-if="row.status === 'deleted'" class="wb-batch-comparison-delete">
                数据库中存在该主键，Excel 中没有，执行整表同步时会删除整行。
              </p>
              <template v-else>
                <div v-for="change in row.changes" :key="change.columnName" class="wb-batch-comparison-change">
                  <strong>{{ change.columnName }}</strong>
                  <span :title="change.oldValueTruncated ? '值过长，已截断' : undefined">
                    {{ oldValueText(row, change) }}<small v-if="change.oldValueTruncated">…</small>
                  </span>
                  <ArrowRight :size="14" aria-hidden="true" />
                  <span :title="change.newValueTruncated ? '值过长，已截断' : undefined">
                    {{ formatValue(change.newValue) }}<small v-if="change.newValueTruncated">…</small>
                  </span>
                </div>
              </template>
            </div>
          </article>
        </div>
        <div v-else class="wb-batch-comparison-empty">
          {{ changeCount || comparison.summary.errors ? "没有匹配的变化" : "没有需要写入的变化" }}
        </div>
      </div>
    </div>
  </section>
</template>
