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
const allSelected = computed({
  get() {
    return batch.value.tables.length > 0 && selectedCount.value === batch.value.tables.length;
  },
  set(value) {
    props.transfer.setAllExportTables(value);
  },
});

const filteredTables = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return batch.value.tables;
  return batch.value.tables.filter((table) =>
    String(table.table_name || "").toLowerCase().includes(needle) ||
    String(table.table_comment || "").toLowerCase().includes(needle)
  );
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

      <div class="wb-batch-transfer-toolbar">
        <label class="wb-batch-transfer-check">
          <input v-model="allSelected" type="checkbox" :disabled="isBusy || !batch.tables.length" />
          <span>全选</span>
        </label>
        <input v-model="query" type="text" placeholder="搜索表" :disabled="isBusy" />
        <span>已选 {{ selectedCount }} / {{ batch.tables.length }}</span>
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
          :disabled="!transfer.canExecuteBatchExport.value"
          @click="emit('execute')"
        >
          {{ isBusy ? "导出中…" : (batch.mode === "separate" ? "导出多个 Excel" : "导出 XLSX") }}
        </button>
      </footer>
    </section>
  </div>
</template>
