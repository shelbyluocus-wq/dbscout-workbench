<script setup>
import { FolderOpen } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  transfer: { type: Object, required: true },
});

const emit = defineEmits(["close", "execute"]);

const query = ref("");
const dialogRef = ref(null);
const batch = computed(() => props.transfer.batchExport);
const isBusy = computed(() => batch.value.exporting);
useEscClose(() => true, () => emit("close"), () => isBusy.value, { dialogRef });
const selectedCount = computed(() => props.transfer.selectedExportCount.value);
const modeOptions = [
  { value: "workbook", label: "合并工作簿" },
  { value: "separate", label: "每表一个 Excel" },
];

const normalizedQuery = computed(() => query.value.trim().toLowerCase());
const isSearchActive = computed(() => Boolean(normalizedQuery.value));
const availableTables = computed(() => props.transfer.visibleExportTables.value);
const filteredTables = computed(() => {
  const needle = normalizedQuery.value;
  if (!needle) return availableTables.value;
  return availableTables.value.filter((table) =>
    String(table.table_name || "").toLowerCase().includes(needle) ||
    String(table.table_comment || "").toLowerCase().includes(needle)
  );
});
const selectionScope = computed(() => (
  isSearchActive.value ? filteredTables.value : availableTables.value
).map((table) => table.table_name));
const selectedInScopeCount = computed(() => (
  selectionScope.value.filter((tableName) => batch.value.selectedTableNames.has(tableName)).length
));
const allSelected = computed({
  get() {
    const scope = selectionScope.value;
    return scope.length > 0 &&
      scope.every((tableName) => batch.value.selectedTableNames.has(tableName));
  },
  set(value) {
    props.transfer.setExportTableSelection(value ? selectionScope.value : []);
  },
});
const allSelectionIndeterminate = computed(() => (
  selectionScope.value.length > 0 && selectedInScopeCount.value > 0 && !allSelected.value
));
const selectAllLabel = computed(() => (
  isSearchActive.value ? `仅选搜索结果（${filteredTables.value.length}）` : "全选"
));
const selectionSummary = computed(() => {
  if (batch.value.homepageSelectionActive && !isSearchActive.value) {
    return `首页预选 ${selectedCount.value} / 全部 ${batch.value.tables.length}`;
  }
  if (!isSearchActive.value) return `已选 ${selectedCount.value} / ${batch.value.tables.length}`;
  return `已选 ${selectedCount.value} / 全部 ${batch.value.tables.length} · 匹配 ${filteredTables.value.length}`;
});
const searchPlaceholder = computed(() => (
  batch.value.homepageSelectionActive ? "在首页预选表中搜索" : "搜索表"
));

function cancelHomepageSelection() {
  query.value = "";
  props.transfer.cancelHomepageExportSelection();
}

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
  <div class="wb-dialog-overlay">
    <section ref="dialogRef" class="wb-dialog wb-batch-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-batch-export-title" tabindex="-1">
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

      <div v-if="batch.homepageSelectionActive" class="wb-batch-selection-focus" role="status">
        <span>
          <strong>仅显示首页预选的 {{ selectedCount }} 张表</strong>
          <small>列表和导出范围已同步收窄</small>
        </span>
        <button type="button" :disabled="isBusy" @click="cancelHomepageSelection">
          取消预选，选择其他表
        </button>
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
        <input v-model="query" type="text" :placeholder="searchPlaceholder" :disabled="isBusy" />
        <span>{{ selectionSummary }}</span>
      </div>
      <p v-if="batch.selectionNotice" class="wb-batch-transfer-warning" role="status">{{ batch.selectionNotice }}</p>

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

      <section v-if="batch.result" class="wb-batch-result-summary" :class="`is-${batch.status}`" role="status" aria-live="polite">
        <div><strong>{{ batch.result.tableCount }}</strong><span>{{ batch.status === "cancelled" ? "已读取表" : "成功表" }}</span></div>
        <div><strong>{{ batch.result.fileCount }}</strong><span>文件</span></div>
        <div><strong>{{ batch.result.rowCount }}</strong><span>{{ batch.status === "cancelled" ? "已读取行" : "数据行" }}</span></div>
        <div v-if="batch.result.savedPath" class="wb-batch-result-path">
          <span :title="batch.result.savedPath">保存到 {{ batch.result.savedPath }}</span>
          <button
            type="button"
            :disabled="batch.openingSavedPath"
            :aria-busy="batch.openingSavedPath"
            title="在资源管理器中显示导出结果"
            @click="transfer.openBatchExportSavedPath"
          >
            <FolderOpen :size="14" aria-hidden="true" />
            {{ batch.openingSavedPath ? "打开中…" : "打开位置" }}
          </button>
        </div>
      </section>

      <p v-if="batch.openSavedPathError" class="wb-dialog-error" role="alert">{{ batch.openSavedPathError }}</p>

      <p v-if="batch.status === 'failed'" class="wb-dialog-error">{{ batch.errorMessage }}</p>
      <p v-if="batch.progress.errors.length" class="wb-batch-transfer-warning">
        {{ batch.progress.errors.length }} 张表失败
      </p>

      <footer class="wb-dialog-actions wb-batch-transfer-actions">
        <button type="button" :disabled="isBusy" @click="emit('close')">关闭</button>
        <button
          v-if="batch.exporting"
          type="button"
          class="wb-dialog-primary"
          :class="{ 'is-busy': batch.cancelRequested }"
          :disabled="batch.cancelRequested"
          :aria-busy="batch.cancelRequested"
          @click="transfer.cancelBatchExport()"
        >
          {{ batch.cancelRequested ? "正在取消…" : "取消导出" }}
        </button>
        <button
          v-else
          type="button"
          class="wb-dialog-primary"
          :disabled="!transfer.canExecuteBatchExport.value"
          @click="emit('execute')"
        >
          {{ batch.result ? "再次导出" : (batch.mode === "separate" ? `导出 ${selectedCount} 个 Excel` : `导出 ${selectedCount} 张表`) }}
        </button>
      </footer>
    </section>
  </div>
</template>
