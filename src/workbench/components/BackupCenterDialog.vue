<script setup>
import { computed } from "vue";

const props = defineProps({
  backup: { type: Object, required: true },
  connections: { type: Array, default: () => [] },
});

const emit = defineEmits(["close"]);

const dialog = computed(() => props.backup.dialog);
const auditLogs = computed(() => props.backup.auditLogs.value || []);
const snapshots = computed(() => props.backup.snapshots.value || []);
const config = computed(() => props.backup.config.value || {});
const progress = computed(() => props.backup.progress);
const busy = computed(() => props.backup.busy);
const filters = computed(() => props.backup.filters);

const isBusy = computed(
  () => busy.value.rollingBack || busy.value.snapshotting || busy.value.restoring || busy.value.savingConfig,
);

const progressPercent = computed(() => {
  if (!progress.value.total) return 0;
  return Math.min(100, Math.round((progress.value.done / progress.value.total) * 100));
});

const progressStyle = computed(() => ({ "--wb-backup-progress-width": `${progressPercent.value}%` }));

function operationLabel(operation) {
  return { UPDATE: "修改", INSERT: "新增", DELETE: "删除", DDL: "结构", ROLLBACK: "回滚", REPLACE: "替换" }[operation] || operation;
}
function strategyLabel(strategy) {
  return { auto: "可回滚", manual: "需手动", ddl: "结构变更" }[strategy] || strategy;
}
function statusLabel(status) {
  return { pending: "进行中", committed: "已提交", aborted: "已中止", rolled_back: "已回滚" }[status] || status;
}
function sourceLabel(source) {
  return { grid: "表格", agent: "Agent", ddl: "结构", rollback: "回滚" }[source] || source;
}
function formatTs(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}
function formatSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function canRollback(entry) {
  return (
    entry.status === "committed" &&
    !entry.isRollback &&
    entry.rollbackStrategy === "auto" &&
    entry.inverseSql
  );
}
function identityText(entry) {
  const identity = entry.rowIdentity;
  if (!identity || typeof identity !== "object") return "";
  return Object.entries(identity)
    .map(([key, value]) => `${key}=${value}`)
    .join(" & ");
}

function switchTab(tab) {
  dialog.value.tab = tab;
}

function applyFilters() {
  props.backup.loadAuditLogs();
  props.backup.loadSnapshots();
}

function clearFilters() {
  props.backup.setFilters({ connectionId: "", database: "", tableName: "" });
  props.backup.loadAuditLogs();
  props.backup.loadSnapshots();
}

async function onRollback(entry) {
  const detail = entry.columnName
    ? `将 ${entry.tableName}.${entry.columnName} 从 ${entry.newValue ?? ""} 恢复为 ${entry.oldValue ?? ""}？`
    : `撤销对 ${entry.tableName} 的${operationLabel(entry.operation)}操作？`;
  if (!window.confirm(`回滚该修改？\n\n${detail}\n\n回滚后可在变更日志中再次回滚（恢复原状）。`)) return;
  const result = await props.backup.rollback(entry.id);
  if (!result?.rolledBack) {
    window.alert(result?.message || "回滚失败");
  }
}

async function onCreateSnapshot() {
  try {
    await props.backup.createSnapshot({
      connectionId: filters.value.connectionId || undefined,
      database: filters.value.database || undefined,
    });
  } catch (error) {
    window.alert(String(error?.message || error || "快照失败"));
  }
}

async function onRestore(snapshot) {
  const msg = `从快照还原数据库 ${snapshot.database}？\n\n时间：${snapshot.ts}\n表数：${snapshot.tableCount}\n大小：${formatSize(snapshot.sizeBytes)}\n\n还原前会自动对当前状态再做一次快照，可据此再次还原回来。此操作不可直接撤销。`;
  if (!window.confirm(msg)) return;
  try {
    await props.backup.restoreSnapshot(snapshot.path, snapshot.connectionId);
  } catch (error) {
    window.alert(String(error?.message || error || "还原失败"));
  }
}

async function onSaveConfig() {
  await props.backup.saveConfig({ ...config.value });
}
</script>

<template>
  <div class="wb-dialog-overlay" @click.self="!isBusy && emit('close')">
    <section class="wb-dialog wb-backup-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-backup-title">
      <header class="wb-backup-header">
        <div class="wb-backup-heading">
          <strong id="wb-backup-title">备份中心</strong>
          <p class="wb-backup-subtitle">变更日志与快照还原，数据保存在本机，与目标数据库隔离。</p>
        </div>
        <button type="button" class="wb-dialog-close" :disabled="isBusy" aria-label="关闭备份中心" @click="emit('close')">×</button>
      </header>

      <nav class="wb-backup-tabs" role="tablist" aria-label="备份中心视图">
        <button
          type="button"
          role="tab"
          :class="{ active: dialog.tab === 'audit' }"
          :aria-selected="dialog.tab === 'audit'"
          aria-controls="wb-backup-panel-audit"
          @click="switchTab('audit')"
        >变更日志</button>
        <button
          type="button"
          role="tab"
          :class="{ active: dialog.tab === 'snapshot' }"
          :aria-selected="dialog.tab === 'snapshot'"
          aria-controls="wb-backup-panel-snapshot"
          @click="switchTab('snapshot')"
        >快照还原</button>
        <button
          type="button"
          role="tab"
          :class="{ active: dialog.tab === 'config' }"
          :aria-selected="dialog.tab === 'config'"
          aria-controls="wb-backup-panel-config"
          @click="switchTab('config')"
        >设置</button>
      </nav>

      <div v-if="dialog.tab === 'audit'" id="wb-backup-panel-audit" class="wb-backup-panel" role="tabpanel" aria-labelledby="wb-backup-title">
        <div class="wb-backup-toolbar">
          <div class="wb-backup-filter-fields">
            <label class="wb-backup-filter">
              <span>连接</span>
              <select v-model="filters.connectionId" aria-label="按连接筛选" @change="applyFilters">
                <option value="">全部连接</option>
                <option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
              </select>
            </label>
            <label class="wb-backup-filter">
              <span>数据库</span>
              <input v-model="filters.database" type="text" placeholder="筛选数据库" @change="applyFilters" />
            </label>
            <label class="wb-backup-filter">
              <span>表名</span>
              <input v-model="filters.tableName" type="text" placeholder="筛选表名" @change="applyFilters" />
            </label>
          </div>
          <div class="wb-backup-toolbar-actions">
            <button type="button" :disabled="busy.listing" @click="clearFilters">清除</button>
            <button type="button" class="wb-dialog-primary" :disabled="busy.listing" @click="applyFilters">
              {{ busy.listing ? "查询中…" : "刷新" }}
            </button>
          </div>
        </div>

        <div class="wb-backup-list wb-backup-audit">
          <div v-if="!auditLogs.length" class="wb-backup-empty">
            <svg class="wb-backup-empty-icon" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
              <rect x="8" y="6" width="24" height="28" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <line x1="13" y1="14" x2="27" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="13" y1="20" x2="27" y2="20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="13" y1="26" x2="22" y2="26" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <strong>暂无变更记录</strong>
            <span>通过本应用修改数据后会自动记录到这里，可一键回滚。</span>
          </div>
          <article
            v-for="entry in auditLogs"
            :key="entry.id"
            class="wb-backup-audit-row"
            :class="{ rolled: entry.isRollback, aborted: entry.status === 'aborted' }"
          >
            <div class="wb-backup-audit-main">
              <span class="wb-backup-ts">{{ formatTs(entry.ts) }}</span>
              <span class="wb-backup-op" :data-op="entry.operation">{{ operationLabel(entry.operation) }}</span>
              <span class="wb-backup-loc">{{ entry.database }} · {{ entry.tableName }}</span>
              <span v-if="entry.columnName" class="wb-backup-col">{{ entry.columnName }}</span>
              <span v-if="entry.columnName && entry.oldValue != null" class="wb-backup-diff">{{ entry.oldValue }} → {{ entry.newValue }}</span>
              <span class="wb-backup-chip" data-kind="source">{{ sourceLabel(entry.source) }}</span>
              <span class="wb-backup-chip" data-kind="status" :data-status="entry.status">{{ statusLabel(entry.status) }}</span>
              <span class="wb-backup-chip" data-kind="strategy" :data-strategy="entry.rollbackStrategy">{{ strategyLabel(entry.rollbackStrategy) }}</span>
            </div>
            <div class="wb-backup-audit-meta">
              <span v-if="identityText(entry)" class="wb-backup-identity">行：{{ identityText(entry) }}</span>
              <span v-if="entry.isRollback" class="wb-backup-rollback-tag">回滚操作</span>
            </div>
            <div class="wb-backup-row-actions">
              <button
                type="button"
                class="wb-backup-action-btn"
                :disabled="!canRollback(entry) || busy.rollingBack"
                :title="canRollback(entry) ? '回滚该修改' : '该记录不可自动回滚'"
                @click="onRollback(entry)"
              >{{ busy.rollingBack ? "回滚中…" : "回滚" }}</button>
            </div>
          </article>
        </div>
      </div>

      <div v-else-if="dialog.tab === 'snapshot'" id="wb-backup-panel-snapshot" class="wb-backup-panel" role="tabpanel" aria-labelledby="wb-backup-title">
        <div class="wb-backup-toolbar">
          <div class="wb-backup-toolbar-actions">
            <button type="button" class="wb-dialog-primary" :disabled="busy.snapshotting" @click="onCreateSnapshot">
              {{ busy.snapshotting ? "快照中…" : "立即创建快照" }}
            </button>
            <button type="button" :disabled="busy.snapshotting || busy.restoring" @click="backup.pruneSnapshots()">清理旧快照</button>
          </div>
          <p v-if="progress.active" class="wb-backup-progress-text">{{ progress.message || `已处理 ${progress.done} / ${progress.total}` }}</p>
        </div>

        <div
          v-if="progress.active"
          class="wb-backup-progress"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="progressPercent"
          :style="progressStyle"
        >
          <span class="wb-backup-progress-fill"></span>
        </div>

        <div class="wb-backup-list wb-backup-snapshots">
          <div v-if="!snapshots.length" class="wb-backup-empty">
            <svg class="wb-backup-empty-icon" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
              <path d="M10 14 L20 8 L30 14 V30 H10 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M10 14 H30" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <rect x="16" y="20" width="8" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>
            </svg>
            <strong>暂无快照</strong>
            <span>可手动创建，或等待定时自动快照。</span>
          </div>
          <article v-for="snapshot in snapshots" :key="snapshot.path" class="wb-backup-snapshot-row">
            <div class="wb-backup-snapshot-main">
              <span class="wb-backup-ts">{{ snapshot.ts }}</span>
              <span class="wb-backup-loc">{{ snapshot.connectionId }} · {{ snapshot.database }}</span>
              <span class="wb-backup-meta">{{ snapshot.tableCount }} 表 · {{ formatSize(snapshot.sizeBytes) }}</span>
            </div>
            <div class="wb-backup-row-actions">
              <button
                type="button"
                class="wb-backup-action-btn"
                :disabled="busy.restoring"
                @click="onRestore(snapshot)"
              >{{ busy.restoring ? "还原中…" : "还原" }}</button>
            </div>
          </article>
        </div>
      </div>

      <div v-else id="wb-backup-panel-config" class="wb-backup-panel wb-backup-config" role="tabpanel" aria-labelledby="wb-backup-title">
        <div class="wb-backup-config-fields">
          <label class="wb-dialog-field wb-backup-config-field">
            <span>启用定时快照</span>
            <input v-model="config.enabled" type="checkbox" />
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>快照间隔</span>
            <span class="wb-backup-config-input">
              <input v-model.number="config.intervalMinutes" type="number" min="1" aria-label="快照间隔（分钟）" />
              <em>分钟</em>
            </span>
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>大表阈值</span>
            <span class="wb-backup-config-input">
              <input v-model.number="config.largeTableThreshold" type="number" min="0" aria-label="大表阈值（行数）" />
              <em>行，超过则跳过</em>
            </span>
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>保留数量</span>
            <span class="wb-backup-config-input">
              <input v-model.number="config.maxPerDb" type="number" min="1" aria-label="每库最多保留快照数" />
              <em>个 / 库</em>
            </span>
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>日志保留</span>
            <span class="wb-backup-config-input">
              <input v-model.number="config.auditRetentionDays" type="number" min="1" aria-label="审计日志保留天数" />
              <em>天</em>
            </span>
          </label>
        </div>

        <aside class="wb-backup-hint">
          设置保存在本地。审计日志与快照均存于本机应用数据目录，与目标数据库隔离——即使目标库被误删也不会丢失。
        </aside>

        <footer class="wb-dialog-actions wb-backup-config-actions">
          <button type="button" class="wb-dialog-primary" :disabled="busy.savingConfig" @click="onSaveConfig">
            {{ busy.savingConfig ? "保存中…" : "保存设置" }}
          </button>
        </footer>
      </div>
    </section>
  </div>
</template>