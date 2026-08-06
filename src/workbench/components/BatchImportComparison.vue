<script setup>
import { computed, ref, watch } from "vue";
import { Search } from "lucide-vue-next";
import BatchImportDiffGrid from "./BatchImportDiffGrid.vue";

const props = defineProps({
  comparison: { type: Object, required: true },
});

const activeFilter = ref("all");
const activeTable = ref("");
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

// One diff section per target table. Tables without any visible row (after
// filtering) are hidden so the view stays focused on actual changes.
const tableBySheet = computed(() =>
  new Map((props.comparison.tables || []).map((table) => [table.sheetName, table])),
);

const visibleSections = computed(() => {
  const sections = [];
  for (const table of props.comparison.tables || []) {
    if (activeTable.value && table.sheetName !== activeTable.value) continue;
    const rows = filteredRows.value.filter((row) => row.sheetName === table.sheetName);
    if (!rows.length) continue;
    sections.push({
      sheetName: table.sheetName,
      tableName: table.tableName || table.sheetName,
      columns: Array.isArray(table.columns) ? table.columns : [],
      rows,
    });
  }
  return sections;
});

function sectionSummaryText(table) {
  const parts = [];
  if (Number(table.inserted || 0)) parts.push(`新增 ${table.inserted}`);
  if (Number(table.updated || 0)) parts.push(`修改 ${table.updated}`);
  if (Number(table.deleted || 0)) parts.push(`删除 ${table.deleted}`);
  if (Number(table.errors || 0)) parts.push(`异常 ${table.errors}`);
  return parts.join(" · ");
}

watch(
  () => props.comparison.runId,
  () => {
    activeFilter.value = "all";
    activeTable.value = "";
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
        <template v-if="visibleSections.length">
          <section
            v-for="section in visibleSections"
            :key="section.sheetName"
            class="wb-batch-diff-section"
          >
            <header class="wb-batch-diff-section-header">
              <strong>{{ section.tableName }}</strong>
              <span>{{ sectionSummaryText(tableBySheet.get(section.sheetName) || {}) }}</span>
            </header>
            <BatchImportDiffGrid
              :table-name="section.tableName"
              :columns="section.columns"
              :rows="section.rows"
            />
          </section>
        </template>
        <div v-else class="wb-batch-comparison-empty">
          {{ changeCount || comparison.summary.errors ? "没有匹配的变化" : "没有需要写入的变化" }}
        </div>
      </div>
    </div>
  </section>
</template>
