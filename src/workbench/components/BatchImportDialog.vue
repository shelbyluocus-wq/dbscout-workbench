<script setup>
import { computed, ref, watch } from "vue";
import { GitCompareArrows, TriangleAlert, X } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import BatchImportComparison from "./BatchImportComparison.vue";

const props = defineProps({
  transfer: { type: Object, required: true },
});

const emit = defineEmits(["close", "file-selected", "execute"]);

const fileInput = ref(null);
const query = ref("");
const viewMode = ref("scope");
const batch = computed(() => props.transfer.batchImport);
const isBusy = computed(() =>
  batch.value.importing || batch.value.comparison.running || batch.value.status === "reading"
);
const selectedCount = computed(() => props.transfer.selectedImportCount.value);
const matchedSheets = computed(() => batch.value.sheets.filter((sheet) => sheet.targetTableName).length);
const targetTables = computed(() => batch.value.tables.map((table) => table.table_name));
const comparisonAvailable = computed(() =>
  ["succeeded", "partial", "cancelled"].includes(batch.value.comparison.status)
);
const comparisonComplete = computed(() =>
  ["succeeded", "partial"].includes(batch.value.comparison.status)
);
const comparisonChangeCount = computed(() =>
  Number(batch.value.comparison.summary.inserted || 0) +
  Number(batch.value.comparison.summary.updated || 0) +
  Number(batch.value.comparison.summary.deleted || 0)
);
const replacementComparisonReady = computed(() =>
  batch.value.comparison.status === "succeeded" && !batch.value.comparison.stale
);
const currentProgress = computed(() =>
  batch.value.comparison.running ? batch.value.comparison.progress : batch.value.progress
);
const importButtonLabel = computed(() => {
  if (batch.value.deleteMissingRows && !replacementComparisonReady.value) {
    return comparisonAvailable.value ? "请重新对比" : "请先对比";
  }
  if (batch.value.deleteMissingRows && comparisonChangeCount.value === 0) return "没有需要同步的变化";
  if (batch.value.result) return batch.value.deleteMissingRows ? "再次同步" : "再次导入";
  if (comparisonComplete.value && !batch.value.comparison.stale && comparisonChangeCount.value > 0) {
    return `${batch.value.deleteMissingRows ? "同步" : "导入"} ${comparisonChangeCount.value} 条变化`;
  }
  return "开始导入";
});

// 组件由父组件 v-if 渲染，挂载即打开；忙碌时 Esc 不关闭。
useEscClose(() => true, () => emit("close"), () => isBusy.value);
const modeOptions = [
  { value: "workbook", label: "合并工作簿" },
  { value: "separate", label: "每表一个 Excel" },
];
const filePrompt = computed(() => (batch.value.mode === "separate" ? "选择多个 Excel 文件" : "选择 XLSX 文件"));
const searchPlaceholder = computed(() => (batch.value.mode === "separate" ? "搜索文件或目标表" : "搜索工作表或目标表"));
const allSelected = computed({
  get() {
    const selectable = batch.value.sheets.filter((sheet) => sheet.targetTableName && sheet.rowCount > 0);
    return selectable.length > 0 && selectable.every((sheet) => batch.value.selectedSheetNames.has(sheet.sheetName));
  },
  set(value) {
    props.transfer.setAllImportSheets(value);
  },
});

const filteredSheets = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return batch.value.sheets;
  return batch.value.sheets.filter((sheet) =>
    String(sheet.sheetName || "").toLowerCase().includes(needle) ||
    String(sheet.targetTableName || "").toLowerCase().includes(needle)
  );
});

const progressPercent = computed(() => {
  const total = currentProgress.value.total || 0;
  if (!total) return 0;
  return Math.min(100, Math.round((currentProgress.value.done / total) * 100));
});

watch(
  () => batch.value.open,
  (open) => {
    if (open) {
      query.value = "";
      viewMode.value = "scope";
    }
  },
);

watch(
  () => batch.value.comparison.status,
  (status) => {
    if (status === "idle") viewMode.value = "scope";
    else if (["succeeded", "partial", "cancelled"].includes(status)) viewMode.value = "comparison";
  },
);
</script>

<template>
  <div class="wb-dialog-overlay" @click.self="!isBusy && emit('close')">
    <section class="wb-dialog wb-batch-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-batch-import-title">
      <header class="wb-dialog-header">
        <div>
          <strong id="wb-batch-import-title">批量导入</strong>
          <small>{{ batch.database }}</small>
        </div>
        <button type="button" class="wb-dialog-close" :disabled="isBusy" aria-label="关闭批量导入" @click="emit('close')">
          <X :size="16" aria-hidden="true" />
        </button>
      </header>

      <div class="wb-batch-mode-switch" role="radiogroup" aria-label="批量导入模式">
        <button
          v-for="option in modeOptions"
          :key="option.value"
          type="button"
          :class="{ 'is-active': batch.mode === option.value }"
          :disabled="isBusy"
          :aria-checked="batch.mode === option.value"
          role="radio"
          @click="transfer.setBatchImportMode(option.value)"
        >
          {{ option.label }}
        </button>
      </div>

      <button type="button" class="wb-batch-file-drop" :disabled="isBusy" @click="fileInput?.click()">
        <span v-if="!batch.fileName">{{ filePrompt }}</span>
        <span v-else>{{ batch.fileName }}</span>
      </button>
      <p v-if="batch.ignoredSheetCount" class="wb-import-info" role="status">
        已自动忽略 {{ batch.ignoredSheetCount }} 个字段备注工作表
      </p>
      <input
        ref="fileInput"
        type="file"
        accept=".xlsx,.xls"
        :multiple="batch.mode === 'separate'"
        style="display: none"
        :disabled="isBusy"
        @change="emit('file-selected', $event)"
      />

      <div v-if="comparisonAvailable" class="wb-batch-import-view-switch" role="tablist" aria-label="批量导入视图">
        <button
          type="button"
          role="tab"
          :class="{ 'is-active': viewMode === 'scope' }"
          :aria-selected="viewMode === 'scope'"
          @click="viewMode = 'scope'"
        >
          导入范围
        </button>
        <button
          type="button"
          role="tab"
          :class="{ 'is-active': viewMode === 'comparison' }"
          :aria-selected="viewMode === 'comparison'"
          @click="viewMode = 'comparison'"
        >
          变化对比
          <span>{{ comparisonChangeCount }}</span>
        </button>
      </div>

      <label class="wb-batch-sync-option" :class="{ 'is-enabled': batch.deleteMissingRows }">
        <input
          type="checkbox"
          :checked="batch.deleteMissingRows"
          :disabled="isBusy"
          @change="transfer.setBatchImportDeleteMissingRows($event.target.checked)"
        />
        <span>
          <strong>同步为 Excel 完整内容</strong>
          <small>目标表中 Excel 未包含的行会被删除，执行前必须先对比</small>
        </span>
        <TriangleAlert v-if="batch.deleteMissingRows" :size="16" aria-hidden="true" />
      </label>

      <div v-if="viewMode === 'scope'" class="wb-batch-transfer-toolbar">
        <label class="wb-batch-transfer-check">
          <input v-model="allSelected" type="checkbox" :disabled="isBusy || !batch.sheets.length" />
          <span>全选匹配项</span>
        </label>
        <input v-model="query" type="text" :placeholder="searchPlaceholder" :disabled="isBusy || !batch.sheets.length" />
        <span>已选 {{ selectedCount }} / 匹配 {{ matchedSheets }}</span>
      </div>

      <div v-if="viewMode === 'scope' && filteredSheets.length" class="wb-batch-transfer-list">
        <label v-for="sheet in filteredSheets" :key="sheet.sheetName" class="wb-batch-transfer-row is-import-row">
          <input
            type="checkbox"
            :checked="batch.selectedSheetNames.has(sheet.sheetName)"
            :disabled="isBusy || !sheet.targetTableName || sheet.rowCount === 0"
            @change="transfer.toggleImportSheet(sheet.sheetName)"
          />
          <span class="wb-batch-transfer-name">
            {{ sheet.sheetName }}
            <small v-if="batch.mode === 'separate' && sheet.workbookSheetName">{{ sheet.workbookSheetName }}</small>
          </span>
          <select
            :value="sheet.targetTableName"
            :disabled="isBusy"
            @change="transfer.setImportSheetTarget(sheet.sheetName, $event.target.value)"
          >
            <option value="">跳过</option>
            <option v-for="tableName in targetTables" :key="tableName" :value="tableName">{{ tableName }}</option>
          </select>
          <span class="wb-batch-transfer-comment">{{ sheet.rowCount }} 行</span>
          <span class="wb-batch-transfer-state" :class="`is-${sheet.status}`" :title="sheet.message || sheet.status">{{ sheet.message || sheet.status }}</span>
        </label>
      </div>
      <div v-else-if="viewMode === 'scope' && !batch.fileName" class="wb-batch-transfer-empty">
        {{ batch.mode === "separate" ? "请选择要导入的 Excel 文件" : "请选择要导入的 XLSX 文件" }}
      </div>
      <div v-else-if="viewMode === 'scope'" class="wb-batch-transfer-empty">
        {{ batch.mode === "separate" ? "没有匹配的 Excel 文件" : "没有匹配的工作表" }}
      </div>

      <BatchImportComparison
        v-else
        :comparison="batch.comparison"
      />

      <section v-if="isBusy || currentProgress.total > 0" class="wb-batch-transfer-progress">
        <div class="wb-batch-transfer-progress-line">
          <span :style="{ width: progressPercent + '%' }"></span>
        </div>
        <p>
          <strong v-if="currentProgress.phase">{{ currentProgress.phase }}</strong>
          <span>{{ currentProgress.done }} / {{ currentProgress.total }}</span>
          <template v-if="currentProgress.current">· {{ currentProgress.current }}</template>
        </p>
      </section>

      <section v-if="batch.result" class="wb-batch-result-summary wb-batch-import-summary" :class="`is-${batch.status}`" role="status" aria-live="polite">
        <div><strong>{{ batch.result.inserted }}</strong><span>新增</span></div>
        <div><strong>{{ batch.result.updated }}</strong><span>更新</span></div>
        <div><strong>{{ batch.result.deleted }}</strong><span>删除</span></div>
        <div><strong>{{ batch.result.unchanged }}</strong><span>未变化</span></div>
        <div><strong>{{ batch.result.skipped }}</strong><span>跳过</span></div>
        <div><strong>{{ batch.result.errors.length }}</strong><span>失败</span></div>
      </section>

      <p v-if="batch.status === 'failed'" class="wb-dialog-error">{{ batch.errorMessage }}</p>
      <p v-if="batch.progress.errors.length" class="wb-batch-transfer-warning">
        {{ batch.progress.errors.length }} 个错误，未成功的行保持原样。
      </p>

      <footer class="wb-dialog-actions wb-batch-transfer-actions">
        <button
          v-if="batch.progress.errors.length"
          type="button"
          :disabled="isBusy"
          @click="transfer.exportBatchImportErrors()"
        >
          导出错误日志
        </button>
        <button type="button" :disabled="isBusy" @click="emit('close')">关闭</button>
        <button
          v-if="batch.comparison.running"
          type="button"
          :disabled="batch.comparison.cancelRequested"
          @click="transfer.cancelBatchImportComparison()"
        >
          {{ batch.comparison.cancelRequested ? "正在取消…" : "取消对比" }}
        </button>
        <button
          v-if="batch.importing"
          type="button"
          :disabled="batch.cancelRequested"
          @click="transfer.cancelBatchImport()"
        >
          {{ batch.cancelRequested ? "正在取消…" : "取消导入" }}
        </button>
        <button
          v-else-if="!batch.comparison.running"
          type="button"
          class="wb-batch-compare-action"
          :disabled="!transfer.canCompareBatchImport.value"
          @click="transfer.compareBatchImportChanges()"
        >
          <GitCompareArrows :size="15" aria-hidden="true" />
          {{ comparisonAvailable ? "重新对比" : "对比变化" }}
        </button>
        <button
          v-if="!batch.importing && !batch.comparison.running"
          type="button"
          class="wb-dialog-primary"
          :class="{ danger: batch.deleteMissingRows }"
          :disabled="!transfer.canExecuteBatchImport.value"
          @click="emit('execute')"
        >
          {{ importButtonLabel }}
        </button>
      </footer>
    </section>
  </div>
</template>
