<script setup>
import { computed } from "vue";

const props = defineProps({
  sync: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["close", "preview", "execute", "source-change", "target-change", "add-exclusions", "remove-exclusion"]);

const RESTORED_STATUSES = new Set(["failed-restored", "failedRestored"]);
const RESTORE_FAILED_STATUSES = new Set(["restore-failed", "failedRestoreFailed", "failed-restore-failed"]);

const previewTables = computed(() => {
  const tables = props.sync.result.value?.tables || props.sync.result.value?.tablePlans || [];
  return Array.isArray(tables) ? tables : [];
});

const warnings = computed(() => {
  const list = props.sync.result.value?.warnings || [];
  return Array.isArray(list) ? list : [];
});

const restoreResult = computed(() => {
  const value = props.sync.result.value || {};
  const status = String(value.status || "");
  if (!RESTORED_STATUSES.has(status) && !RESTORE_FAILED_STATUSES.has(status)) return null;
  const backupDatabase = String(value.backupDatabase || value.backup_database || "");
  return {
    status,
    backupDatabase,
    restored: RESTORED_STATUSES.has(status),
  };
});

const isBusy = computed(() => ["previewing", "running", "restoring"].includes(props.sync.dialog.status));
const progressStyle = computed(() => ({ "--wb-database-sync-progress-width": `${props.sync.progressPercent.value}%` }));
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
          <button type="button" :disabled="isBusy || !sync.dialog.selectedExclusionTable" @click="emit('add-exclusions')">添加排除</button>
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
          <p>{{ sync.dialog.status === 'restoring' ? '正在恢复目标库...' : '正在同步...' }} {{ sync.dialog.progress.done }} / {{ sync.dialog.progress.total }}</p>
          <div
            class="wb-database-sync-progress"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="sync.progressPercent.value"
            :style="progressStyle"
          >
            <span class="wb-database-sync-progress-fill"></span>
          </div>
          <p v-if="sync.dialog.progress.message" class="wb-database-sync-muted">{{ sync.dialog.progress.message }}</p>
        </section>

        <section v-if="restoreResult" class="wb-database-sync-restore-result" :class="{ 'is-restored': restoreResult.restored }">
          <strong v-if="restoreResult.restored">同步失败，已从备份恢复目标库。</strong>
          <strong v-else>同步失败且自动恢复失败，需要手动恢复。</strong>
          <p v-if="restoreResult.backupDatabase">备份数据库：{{ restoreResult.backupDatabase }}</p>
          <p v-if="restoreResult.restored">目标库已从备份恢复，请检查错误信息后再重试。</p>
          <p v-else>请保留备份数据库并进行人工恢复，确认目标库状态后再继续操作。</p>
        </section>

        <p v-if="sync.dialog.status === 'succeeded' && !restoreResult" class="wb-database-sync-success">覆盖同步完成。</p>
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
