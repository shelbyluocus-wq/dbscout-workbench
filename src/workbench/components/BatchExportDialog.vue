<script setup>
import { computed, ref, watch } from "vue";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  transfer: { type: Object, required: true },
});

const emit = defineEmits(["close", "execute"]);

const query = ref("");
const batch = computed(() => props.transfer.batchExport);
const isBusy = computed(() => batch.value.exporting);
useEscClose(() => true, () => emit("close"), () => isBusy.value);
const selectedCount = computed(() => props.transfer.selectedExportCount.value);
const modeOptions = [
  { value: "workbook", label: "合并工作簿" },
  { value: "separate", label: "每表一个 Excel" },
];

const normalizedQuery = computed(() => query.value.trim().toLowerCase());
const isSearchActive = computed(() => Boolean(normalizedQuery.value));
const filteredTables = computed(() => {
  const needle = normalizedQuery.value;
  if (!needle) return batch.value.tables;
  return batch.value.tables.filter((table) =>
    String(table.table_name || "").toLowerCase().includes(needle) ||
    String(table.table_comment || "").toLowerCase().includes(needle)
  );
});
const selectionScope = computed(() => (
  isSearchActive.value ? filteredTables.value : batch.value.tables
).map((table) => table.table_name));
const allSelected = computed({
  get() {
    const scope = selectionScope.value;
    return scope.length > 0 &&
      selectedCount.value === scope.length &&
      scope.every((tableName) => batch.value.selectedTableNames.has(tableName));
  },
  set(value) {
    props.transfer.setExportTableSelection(value ? selectionScope.value : []);
  },
});
const allSelectionIndeterminate = computed(() => (
  selectionScope.value.length > 0 && selectedCount.value > 0 && !allSelected.value
));
const selectAllLabel = computed(() => (
  isSearchActive.value ? `仅选搜索结果（${filteredTables.value.length}）` : "全选"
));
const selectionSummary = computed(() => {
  if (!isSearchActive.value) return `已选 ${selectedCount.value} / ${batch.value.tables.length}`;
  return `已选 ${selectedCount.value} / 全部 ${batch.value.tables.length} · 匹配 ${filteredTables.value.length}`;
});

const progressPercent = computed(() => {
  const total = batch.value.progress.total || 0;
  if (!total) return 0;
  return Math.min(100, Math.round((batch.value.progress.done / total) * 100));
});

watch(
  () => batch.value.open,
  (open) => {
    if (open) query.value = "";
  },
);
</script>

<template>
  <div class="wb-dialog-overlay" @click.self="!isBusy && emit('close')">
    <section class="wb-dialog wb-batch-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-batch-export-title">
      <header class="wb-dialog-header">
        <div>
          <strong id="wb-batch-export-title">批量导出</strong>
          <small>{{ batch.database }}</small>
        </div>
        <button type="button" class="wb-dialog-close" :disabled="isBusy" aria-label="关闭批量导出" @click="emit('close')">×</button>
      </header>

      <div class="wb-batch-export-settings">
        <div class="wb-batch-mode-switch" role="radiogroup" aria-label="批量导出模式">
          <button
            v-for="option in modeOptions"
            :key="option.value"
            type="button"
            :class="{ 'is-active': batch.mode === option.value }"
            :disabled="isBusy"
            :aria-checked="batch.mode === option.value"
            role="radio"
            @click="transfer.setBatchExportMode(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
        <label class="wb-batch-transfer-check wb-batch-export-comments-option">
          <input
            type="checkbox"
            :checked="batch.includeColumnComments"
            :disabled="isBusy"
            @change="transfer.setBatchExportIncludeColumnComments($event.target.checked)"
          />
          <span>导出字段备注</span>
        </label>
        <small>每张表增加“表名字段备注”工作表</small>
      </div>

      <div class="wb-batch-transfer-toolbar">
        <label class="wb-batch-transfer-check">
          <input
            v-model="allSelected"
            type="checkbox"
            :indeterminate="allSelectionIndeterminate"
            :disabled="isBusy || !selectionScope.length"
          />
          <span>{{ selectAllLabel }}</span>
        </label>
        <input v-model="query" type="text" placeholder="搜索表" :disabled="isBusy" />
        <span>{{ selectionSummary }}</span>
      </div>

      <div v-if="filteredTables.length" class="wb-batch-transfer-list">
        <label v-for="table in filteredTables" :key="table.table_name" class="wb-batch-transfer-row">
          <input
            type="checkbox"
            :checked="batch.selectedTableNames.has(table.table_name)"
            :disabled="isBusy"
            @change="transfer.toggleExportTable(table.table_name)"
          />
          <span class="wb-batch-transfer-name">{{ table.table_name }}</span>
          <span class="wb-batch-transfer-comment">{{ table.table_comment }}</span>
        </label>
      </div>
      <div v-else class="wb-batch-transfer-empty">没有匹配的表</div>

      <section v-if="isBusy || batch.progress.total > 0" class="wb-batch-transfer-progress">
        <div class="wb-batch-transfer-progress-line">
          <span :style="{ width: progressPercent + '%' }"></span>
        </div>
        <p>
          <strong v-if="batch.progress.phase">{{ batch.progress.phase }}</strong>
          <span>{{ batch.progress.done }} / {{ batch.progress.total }}</span>
          <template v-if="batch.progress.current">· {{ batch.progress.current }}</template>
        </p>
      </section>

      <p v-if="batch.status === 'failed'" class="wb-dialog-error">{{ batch.errorMessage }}</p>
      <p v-if="batch.progress.errors.length" class="wb-batch-transfer-warning">
        {{ batch.progress.errors.length }} 张表失败
      </p>

      <footer class="wb-dialog-actions wb-batch-transfer-actions">
        <button type="button" :disabled="isBusy" @click="emit('close')">关闭</button>
        <button
          type="button"
          class="wb-dialog-primary"
          :class="{ 'is-busy': isBusy }"
          :disabled="!transfer.canExecuteBatchExport.value"
          :aria-busy="isBusy"
          @click="emit('execute')"
        >
          {{ isBusy ? "导出中…" : (batch.mode === "separate" ? `导出 ${selectedCount} 个 Excel` : `导出 ${selectedCount} 张表`) }}
        </button>
      </footer>
    </section>
  </div>
</template>
