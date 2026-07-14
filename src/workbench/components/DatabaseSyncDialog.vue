<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  sync: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["close", "preview", "execute", "source-change", "target-change", "add-exclusions", "remove-exclusion"]);

const RESTORED_STATUSES = new Set(["failed-restored", "failedRestored"]);
const RESTORE_FAILED_STATUSES = new Set(["restore-failed", "failedRestoreFailed", "failed-restore-failed"]);
const STAGE_LABELS = {
  preflight: "检查同步计划",
  backup: "创建本地安全快照",
  dropTarget: "清理目标库旧表",
  createTarget: "创建目标表结构",
  copyData: "复制表数据",
  restore: "从本地快照恢复",
  finalize: "完成同步",
  completed: "同步完成",
  failed: "同步失败",
};

const previewTables = computed(() => {
  const tables = props.sync.result.value?.tables || props.sync.result.value?.tablePlans || [];
  return Array.isArray(tables) ? tables : [];
});

const warnings = computed(() => {
  const list = props.sync.result.value?.warnings || [];
  return Array.isArray(list) ? list : [];
});

const syncSnapshotPath = computed(() => {
  const value = props.sync.result.value || {};
  return String(value.backupSnapshotPath || value.backup_snapshot_path || "");
});

const restoreResult = computed(() => {
  const value = props.sync.result.value || {};
  const status = String(value.status || "");
  if (!RESTORED_STATUSES.has(status) && !RESTORE_FAILED_STATUSES.has(status)) return null;
  return {
    status,
    snapshotPath: syncSnapshotPath.value,
    restored: RESTORED_STATUSES.has(status),
  };
});

const isBusy = computed(() => ["previewing", "running", "restoring"].includes(props.sync.dialog.status));
useEscClose(() => true, () => emit("close"), () => isBusy.value);
const progressStyle = computed(() => ({ "--wb-database-sync-progress-scale": props.sync.progressPercent.value / 100 }));
const stageLabel = computed(() => {
  if (props.sync.dialog.status === "restoring") return STAGE_LABELS.restore;
  return STAGE_LABELS[props.sync.dialog.progress.stage] || "准备同步";
});
const isIndeterminate = computed(() => !props.sync.dialog.progress.total || !props.sync.dialog.progress.done);
const hasRowProgress = computed(() => props.sync.dialog.progress.totalRows > 0 || props.sync.dialog.progress.completedRows > 0);
const clock = ref(Date.now());
const startedAt = ref(0);
const lastProgressAt = ref(0);
let clockTimer = null;

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

const elapsed = computed(() => formatDuration(startedAt.value ? (clock.value - startedAt.value) / 1000 : 0));
const lastUpdate = computed(() => {
  const seconds = lastProgressAt.value ? Math.floor((clock.value - lastProgressAt.value) / 1000) : 0;
  return seconds <= 1 ? "最近更新：刚刚" : `最近更新：${seconds} 秒前`;
});

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

watch(
  isBusy,
  (busy) => {
    if (!busy) {
      stopClock();
      startedAt.value = 0;
      lastProgressAt.value = 0;
      return;
    }
    const now = Date.now();
    if (!startedAt.value) startedAt.value = now;
    if (!lastProgressAt.value) lastProgressAt.value = now;
    clock.value = now;
    if (!clockTimer) clockTimer = setInterval(() => (clock.value = Date.now()), 1000);
  },
  { immediate: true },
);

watch(
  () => [
    props.sync.dialog.progress.stage,
    props.sync.dialog.progress.currentTable,
    props.sync.dialog.progress.done,
    props.sync.dialog.progress.completedRows,
    props.sync.dialog.progress.message,
  ],
  () => {
    if (isBusy.value) lastProgressAt.value = Date.now();
  },
);

onBeforeUnmount(stopClock);
const executeButtonLabel = computed(() => "开始覆盖同步");
const executeButtonTitle = computed(() =>
  props.sync.canExecute.value ? "使用当前配置开始覆盖同步" : "请先选择不同的源库与目标库"
);

function sourceChanged(event) {
  emit("source-change", event.target.value);
}

function targetChanged(event) {
  emit("target-change", event.target.value);
}
</script>

<template>
  <div class="wb-dialog-overlay" @click.self="!isBusy && emit('close')">
    <section class="wb-dialog wb-database-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-database-sync-title">
      <header class="wb-dialog-header">
        <strong id="wb-database-sync-title">覆盖同步数据库</strong>
        <button type="button" class="wb-dialog-close" aria-label="关闭覆盖同步窗口" :disabled="isBusy" @click="emit('close')">×</button>
      </header>

      <div class="wb-database-sync-body">
        <p class="wb-database-sync-warning">
          将使用同一连接内的源库覆盖目标库。请选择不同的源库与目标库。
        </p>

        <label class="wb-dialog-field wb-database-sync-field">
          <span>源库</span>
          <select :value="sync.dialog.sourceDatabase" :disabled="isBusy" aria-label="源数据库" @change="sourceChanged">
            <option value="" disabled>请选择源数据库</option>
            <option v-for="database in sync.sourceDatabaseOptions.value" :key="database" :value="database">{{ database }}</option>
          </select>
        </label>

        <label class="wb-dialog-field wb-database-sync-field">
          <span>目标库</span>
          <select :value="sync.dialog.targetDatabase" :disabled="isBusy" aria-label="目标数据库" @change="targetChanged">
            <option value="" disabled>请选择目标数据库</option>
            <option v-for="database in sync.availableTargetDatabases.value" :key="database" :value="database">{{ database }}</option>
          </select>
        </label>

        <label class="wb-dialog-field wb-database-sync-field">
          <span>排除表</span>
          <select
            v-model="sync.dialog.selectedExclusionTable"
            :disabled="isBusy"
            aria-label="排除表"
            @change="emit('add-exclusions')"
          >
            <option value="">请选择要排除的源库表</option>
            <option v-for="tableName in sync.availableExclusionTables.value" :key="tableName" :value="tableName">{{ tableName }}</option>
          </select>
        </label>

        <div class="wb-database-sync-exclusion-actions">
          <span>历史会按连接保存</span>
        </div>

        <div v-if="sync.dialog.excludedTables.length" class="wb-database-sync-tags" aria-label="排除表列表">
          <button
            v-for="tableName in sync.dialog.excludedTables"
            :key="tableName"
            type="button"
            class="wb-database-sync-tag"
            :disabled="isBusy"
            @click="emit('remove-exclusion', tableName)"
          >
            {{ tableName }} ×
          </button>
        </div>
        <p v-else class="wb-database-sync-muted">未排除任何表。</p>

        <section v-if="sync.dialog.status === 'running' || sync.dialog.status === 'restoring'" class="wb-database-sync-progress-section">
          <div class="wb-database-sync-progress-heading">
            <strong><span class="wb-database-sync-activity" aria-hidden="true"></span>{{ stageLabel }}</strong>
            <span v-if="sync.dialog.progress.total">{{ sync.dialog.progress.done }} / {{ sync.dialog.progress.total }} 张表</span>
          </div>
          <div
            class="wb-database-sync-progress"
            :class="{ 'is-indeterminate': isIndeterminate }"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="isIndeterminate ? undefined : sync.progressPercent.value"
            :aria-valuetext="sync.dialog.progress.message || stageLabel"
            :style="progressStyle"
          >
            <span class="wb-database-sync-progress-fill"></span>
          </div>
          <p v-if="sync.dialog.progress.currentTable" class="wb-database-sync-current-table" :title="sync.dialog.progress.currentTable">
            当前表：<strong>{{ sync.dialog.progress.currentTable }}</strong>
          </p>
          <p v-if="hasRowProgress">数据行：{{ sync.dialog.progress.completedRows }} / {{ sync.dialog.progress.totalRows }}</p>
          <p v-if="sync.dialog.progress.message" class="wb-database-sync-muted">{{ sync.dialog.progress.message }}</p>
          <p class="wb-database-sync-progress-meta">已运行 {{ elapsed }} · {{ lastUpdate }}</p>
        </section>

        <section v-if="restoreResult" class="wb-database-sync-restore-result" :class="{ 'is-restored': restoreResult.restored }">
          <strong v-if="restoreResult.restored">同步失败，已从本地安全快照恢复目标库。</strong>
          <strong v-else>同步失败且自动恢复失败，需要手动恢复。</strong>
          <p v-if="restoreResult.snapshotPath">本地安全快照：{{ restoreResult.snapshotPath }}</p>
          <p v-if="restoreResult.restored">目标库已从本地安全快照恢复，请检查错误信息后再重试。</p>
          <p v-else>请保留本地安全快照并进行人工恢复，确认目标库状态后再继续操作。</p>
        </section>

        <p v-if="sync.dialog.status === 'succeeded' && !restoreResult" class="wb-database-sync-success">
          覆盖同步完成，本地安全快照已保存。
        </p>
        <p v-if="sync.dialog.status === 'succeeded' && syncSnapshotPath" class="wb-database-sync-muted" :title="syncSnapshotPath">
          快照路径：{{ syncSnapshotPath }}
        </p>
        <p v-if="sync.dialog.status === 'failed'" class="wb-dialog-error">{{ sync.dialog.errorMessage }}</p>
      </div>

      <footer class="wb-dialog-actions">
        <button type="button" :disabled="isBusy" @click="emit('close')">关闭</button>
        <button
          type="button"
          class="wb-database-sync-danger"
          :disabled="!sync.canExecute.value || isBusy"
          :title="executeButtonTitle"
          @click="emit('execute')"
        >
          {{ executeButtonLabel }}
        </button>
      </footer>
    </section>
  </div>
</template>
