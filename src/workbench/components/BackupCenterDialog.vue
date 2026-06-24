<script setup>
import { computed, ref, watch } from "vue";

import BackupNumberInput from "./BackupNumberInput.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { useConfirm } from "../composables/useConfirm.js";

const props = defineProps({
  backup: { type: Object, required: true },
  connections: { type: Array, default: () => [] },
  account: { type: Object, default: null },
});

const emit = defineEmits(["close"]);

const dialog = computed(() => props.backup.dialog);
const auditLogs = computed(() => props.backup.auditLogs.value || []);
const sharedAuditLogs = computed(() => props.backup.sharedAuditLogs.value || []);
const auditMode = computed(() => props.backup.auditMode?.mode || "local");
const isSharedMode = computed(() => auditMode.value === "shared");
// The list rendered in the audit tab, depending on the selected mode.
const visibleAuditLogs = computed(() =>
  isSharedMode.value ? sharedAuditLogs.value : auditLogs.value,
);
const account = computed(() => props.account || null);
const isLoggedIn = computed(() => Boolean(account.value?.isLoggedIn?.value));
const currentUser = computed(() => account.value?.currentUser?.value || null);
const displayName = computed(() => account.value?.displayName?.value || "");
const username = computed(() => account.value?.username?.value || "");
const serverUrl = computed(() => account.value?.serverUrl?.value || "");
const accountError = computed(() => account.value?.lastError?.value || "");
const snapshots = computed(() => props.backup.snapshots.value || []);
const filterDatabases = computed(() => props.backup.filterDatabases.value || []);
const filterTables = computed(() => props.backup.filterTables.value || []);
const config = computed(() => props.backup.config.value || {});

// Local mutable copy of the backup config used by the settings form.
// We keep a draft so v-model on individual fields triggers Vue reactivity
// correctly (the backend config is held in a shallowRef, so mutating its
// properties directly would not cause the UI to update).
const draftConfig = ref({});
watch(
  () => props.backup.config.value,
  (value) => {
    draftConfig.value = { ...(value || {}) };
  },
  { immediate: true },
);

const progress = computed(() => props.backup.progress);
const busy = computed(() => props.backup.busy);
const filters = computed(() => props.backup.filters);

const { confirmDialog, confirm, alert, close: closeConfirm } = useConfirm();

const isBusy = computed(
  () => busy.value.rollingBack || busy.value.snapshotting || busy.value.restoring || busy.value.savingConfig,
);

const progressPercent = computed(() => {
  if (!progress.value.total) return 0;
  return Math.min(100, Math.round((progress.value.done / progress.value.total) * 100));
});

const progressStyle = computed(() => ({
  "--wb-backup-progress-scale": Math.max(0, Math.min(1, progressPercent.value / 100)),
}));

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
  const raw = String(ts).trim();
  const compact = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(raw);
  const date = compact
    ? new Date(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
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

// ---- Account / shared audit mode -------------------------------------------
// Local form state for the settings-tab account section. Kept separate from
// the account composable so v-model reactivity works on plain inputs.
const accountDraft = ref({ serverUrl: "", username: "", displayName: "" });
watch(
  () => [serverUrl.value],
  () => {
    accountDraft.value.serverUrl = serverUrl.value;
  },
  { immediate: true },
);

const accountBusy = computed(() => account.value?.busy?.value || {});

async function onSaveServerUrl() {
  const ok = await account.value?.setServer(accountDraft.value.serverUrl);
  if (!ok) {
    await alert({ title: "保存失败", message: accountError.value || "无法保存服务地址。" });
  }
}

async function onRegister() {
  if (!accountDraft.value.username.trim()) {
    await alert({ title: "请输入用户名", message: "注册前请填写用户名。" });
    return;
  }
  const ok = await account.value?.register(
    accountDraft.value.username,
    accountDraft.value.displayName,
  );
  if (!ok) {
    await alert({ title: "注册失败", message: accountError.value || "注册失败。" });
  }
}

async function onLogin() {
  if (!accountDraft.value.username.trim()) {
    await alert({ title: "请输入用户名", message: "登录前请填写用户名。" });
    return;
  }
  const ok = await account.value?.login(accountDraft.value.username);
  if (!ok) {
    await alert({ title: "登录失败", message: accountError.value || "登录失败。" });
  }
}

async function onLogout() {
  const approved = await confirm({
    title: "退出登录？",
    message: "退出后本机改动仍会记录，但不会同步到全员可见的变更日志，直到再次登录。",
    confirmText: "退出",
    danger: true,
  });
  if (!approved) return;
  await account.value?.logout();
}

async function onSyncNow() {
  const result = await account.value?.syncNow();
  const accepted = Number(result?.accepted || 0);
  const skipped = Number(result?.skipped || 0);
  await alert({
    title: accepted > 0 ? "同步完成" : "无可同步记录",
    message:
      accepted > 0
        ? `已同步 ${accepted} 条变更日志${skipped ? `（跳过 ${skipped} 条重复）` : ""}。`
        : "当前没有待同步的变更记录。",
  });
}

async function onSwitchAuditMode(mode) {
  if (mode === "shared" && !isLoggedIn.value) {
    await alert({
      title: "未登录",
      message: "查看全员变更日志需要先在「设置」中登录。已显示本机记录。",
    });
    return;
  }
  await props.backup.setAuditMode(mode);
}

// The actor label shown on each shared audit row: "displayName (@username)".
function actorLabel(entry) {
  const name = entry.displayName || entry.username;
  const handle = entry.username ? `@${entry.username}` : "";
  if (name && handle) return `${name} (${handle})`;
  return name || handle || "未知用户";
}

// Whether a shared audit row can be rolled back on this machine: only rows
// originating here (we hold their inverse SQL locally). Shared rows from other
// users have no local inverse, so their rollback button is disabled.
function isLocalRow(entry) {
  // Shared rows carry a clientId; local rows carry a numeric id. We can only
  // roll back rows that also exist in the local audit store. For the shared
  // list we conservatively disable rollback unless the row is also present
  // locally (matched by clientId).
  if (!isSharedMode.value) return true;
  const localIds = new Set(
    (auditLogs.value || []).map((row) => row.clientId).filter(Boolean),
  );
  return Boolean(entry.clientId && localIds.has(entry.clientId));
}

function switchTab(tab) {
  dialog.value.tab = tab;
}

function currentError(fallback) {
  return props.backup.lastError.value || fallback;
}

async function applyFilters({ silent = false } = {}) {
  const [auditOk, snapshotOk] = await Promise.all([
    props.backup.loadAuditLogs(),
    props.backup.loadSnapshots(),
  ]);
  const ok = auditOk && snapshotOk;
  if (!silent) {
    await alert({
      title: ok ? "刷新完成" : "刷新失败",
      message: ok ? "备份中心列表已刷新。" : currentError("备份中心刷新失败。"),
    });
  }
  return ok;
}

async function onConnectionFilterChange() {
  props.backup.setFilters({ database: "", tableName: "" });
  await props.backup.loadFilterOptions();
  await applyFilters({ silent: true });
}

async function onDatabaseFilterChange() {
  props.backup.setFilters({ tableName: "" });
  await props.backup.loadFilterTables();
  await applyFilters({ silent: true });
}

async function onClearAuditLogs() {
  const approved = await confirm({
    title: "清空所有变更日志？",
    message: "此操作会永久删除本机记录的所有变更日志，且不可恢复。目标数据库数据不受影响。",
    confirmText: "清空",
    danger: true,
  });
  if (!approved) return;
  const result = await props.backup.clearAuditLogs();
  const deletedCount = Number(result?.deletedCount || 0);
  await alert({
    title: deletedCount > 0 ? "已清空" : "无记录可清空",
    message: deletedCount > 0 ? `已删除 ${deletedCount} 条变更日志。` : "当前没有变更日志记录。",
  });
}

async function onRollback(entry) {
  const detail = entry.columnName
    ? `将 ${entry.tableName}.${entry.columnName} 从 ${entry.newValue ?? ""} 恢复为 ${entry.oldValue ?? ""}？`
    : `撤销对 ${entry.tableName} 的${operationLabel(entry.operation)}操作？`;
  const approved = await confirm({
    title: "回滚该修改？",
    message: `${detail}\n\n回滚后可在变更日志中再次回滚（恢复原状）。`,
    confirmText: "回滚",
    danger: true,
  });
  if (!approved) return;
  const result = await props.backup.rollback(entry.id);
  if (!result?.rolledBack) {
    await alert({ title: "回滚失败", message: result?.message || "回滚失败" });
    return;
  }
  await alert({ title: "回滚完成", message: result?.message || "已回滚该记录。" });
}

async function onCreateSnapshot() {
  try {
    await props.backup.createSnapshotFromFilters();
    await alert({ title: "快照完成", message: "已创建新的数据库快照。" });
  } catch (error) {
    await alert({ title: "快照失败", message: String(error?.message || error || "快照失败") });
  }
}

async function onRestore(snapshot) {
  const approved = await confirm({
    title: `还原数据库 ${snapshot.database}？`,
    message: `时间：${formatTs(snapshot.ts)}\n表数：${snapshot.tableCount}\n大小：${formatSize(snapshot.sizeBytes)}\n\n还原前会自动对当前状态再做一次快照，可据此再次还原回来。此操作不可直接撤销。`,
    confirmText: "还原",
    danger: true,
  });
  if (!approved) return;
  try {
    await props.backup.restoreSnapshot(snapshot.path, snapshot.connectionId);
    await alert({ title: "还原完成", message: `数据库 ${snapshot.database} 已从快照还原。` });
  } catch (error) {
    await alert({ title: "还原失败", message: String(error?.message || error || "还原失败") });
  }
}

async function onDelete(snapshot) {
  const approved = await confirm({
    title: "删除该快照？",
    message: `时间：${formatTs(snapshot.ts)}\n数据库：${snapshot.database}\n表数：${snapshot.tableCount}\n大小：${formatSize(snapshot.sizeBytes)}\n\n删除后不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!approved) return;
  try {
    await props.backup.deleteSnapshot(snapshot.path);
    await alert({ title: "已删除", message: "该快照已删除。" });
  } catch (error) {
    await alert({ title: "删除失败", message: String(error?.message || error || "删除失败") });
  }
}

const storageDirDisplay = computed(() => {
  const dir = draftConfig.value?.storageDir || draftConfig.value?.resolvedStorageDir;
  return dir && String(dir).trim() ? dir : "默认（应用数据目录）";
});

async function openBackupPath(path) {
  const ok = await props.backup.openBackupPath(path);
  if (!ok) {
    await alert({ title: "打开失败", message: currentError("无法打开备份文件夹。") });
  }
  return ok;
}

async function onOpenSnapshotFolder(snapshot) {
  await openBackupPath(snapshot?.path);
}

async function onOpenStorageDir() {
  const dir = draftConfig.value?.storageDir;
  const savedDir = config.value?.storageDir;
  if (dir && dir !== savedDir) {
    const ok = await props.backup.saveConfig({ ...draftConfig.value });
    if (!ok) {
      await alert({ title: "打开失败", message: currentError("保存备份设置失败，无法打开文件夹。") });
      return;
    }
  }
  await openBackupPath(draftConfig.value?.resolvedStorageDir || draftConfig.value?.storageDir);
}

async function onPickStorageDir() {
  const dir = await props.backup.pickStorageDir();
  if (dir) {
    draftConfig.value = { ...draftConfig.value, storageDir: dir, resolvedStorageDir: dir };
  }
}

// ---- Snapshot per-database enable panel -------------------------------------
// Only MySQL (non-read-only) connections can be snapshotted; the enable list
// mirrors the snapshot filter dropdowns so the candidate set is always live.
const enableConnectionId = computed(() => filters.value.connectionId);

const enableDatabases = computed(() => props.backup.filterDatabases.value || []);

function isConnectionSnapshotable(connectionId) {
  const connection = (props.connections || []).find((item) => item.id === connectionId);
  return Boolean(connection && !connection.readOnly);
}

function snapshotDbState(connectionId, database) {
  if (!isConnectionSnapshotable(connectionId)) return "unsupported";
  return props.backup.isSnapshotEnabled(connectionId, database) ? "enabled" : "disabled";
}
function snapshotDbStateLabel(state) {
  return { enabled: "已开启", disabled: "未开启", unsupported: "不支持" }[state] || state;
}

// ---- Selected backup databases summary --------------------------------------
// Aggregates every (connection, database) that has been opted in across all
// connections, so users can see and manage the active backup scope at a glance.
const selectedBackupDatabases = computed(() => {
  const list = config.value?.snapshotEnabledDatabases || [];
  return list
    .map(({ connectionId, database }) => {
      const connection = (props.connections || []).find((item) => item.id === connectionId);
      return {
        connectionId,
        database,
        connectionLabel: connection?.label || connectionId,
      };
    })
    .filter((item) => item.connectionId && item.database);
});

const selectedBackupCount = computed(() => selectedBackupDatabases.value.length);

async function onJumpToConnection(connectionId) {
  props.backup.setFilters({ connectionId, database: "" });
  await onEnableConnectionChange();
}

async function onToggleSnapshotEnabled(connectionId, database, enabled) {
  const ok = await props.backup.setSnapshotEnabled(connectionId, database, enabled);
  if (!ok) {
    await alert({ title: "设置失败", message: currentError("更新快照开关失败。") });
  }
}

async function onEnableConnectionChange() {
  await props.backup.loadFilterDatabases();
}

async function onSaveConfig() {
  const ok = await props.backup.saveConfig({ ...draftConfig.value });
  if (!ok) {
    await alert({ title: "保存失败", message: currentError("备份设置保存失败。") });
    return;
  }
  await alert({
    title: "保存成功",
    message: "备份设置已保存。",
  });
  emit("close");
}

async function onPruneSnapshots() {
  const result = await props.backup.pruneSnapshots();
  const deletedCount = Number(result?.deletedCount || result?.deleted_count || 0);
  await alert({
    title: "清理完成",
    message: deletedCount > 0 ? `已清理 ${deletedCount} 个旧快照。` : "没有需要清理的旧快照。",
  });
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
        <div class="wb-backup-user" :data-logged-in="isLoggedIn">
          <template v-if="isLoggedIn">
            <span class="wb-backup-user-avatar" :title="`${displayName} (@${username})`">{{ (displayName || username || '?').slice(0, 1).toUpperCase() }}</span>
            <span class="wb-backup-user-name">{{ displayName }}<em>@{{ username }}</em></span>
          </template>
          <template v-else>
            <span class="wb-backup-user-name wb-backup-user-guest">未登录</span>
          </template>
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
          <div class="wb-backup-audit-mode" role="group" aria-label="变更日志视图范围">
            <button
              type="button"
              :class="{ active: !isSharedMode }"
              :aria-pressed="!isSharedMode"
              @click="onSwitchAuditMode('local')"
            >仅本机</button>
            <button
              type="button"
              :class="{ active: isSharedMode }"
              :aria-pressed="isSharedMode"
              :disabled="!isLoggedIn"
              :title="isLoggedIn ? '查看所有用户的改动' : '请先在设置中登录'"
              @click="onSwitchAuditMode('shared')"
            >全员可见</button>
          </div>
          <div class="wb-backup-filter-fields">
            <label class="wb-backup-filter">
              <span>连接</span>
              <select v-model="filters.connectionId" aria-label="按连接筛选" @change="onConnectionFilterChange">
                <option value="">全部连接</option>
                <option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
              </select>
            </label>
            <label class="wb-backup-filter">
              <span>数据库</span>
              <select
                v-model="filters.database"
                aria-label="按数据库筛选"
                :disabled="!filters.connectionId || busy.filterOptions"
                @change="onDatabaseFilterChange"
              >
                <option value="">全部数据库</option>
                <option v-for="database in filterDatabases" :key="database" :value="database">{{ database }}</option>
              </select>
            </label>
            <label class="wb-backup-filter">
              <span>表名</span>
              <select
                v-model="filters.tableName"
                aria-label="按表名筛选"
                :disabled="!filters.connectionId || !filters.database || busy.filterOptions"
                @change="applyFilters"
              >
                <option value="">全部表</option>
                <option v-for="tableName in filterTables" :key="tableName" :value="tableName">{{ tableName }}</option>
              </select>
            </label>
          </div>
          <div class="wb-backup-toolbar-actions">
            <button
              v-if="!isSharedMode"
              type="button"
              class="wb-backup-action-danger"
              :disabled="busy.listing || busy.deleting"
              title="清空本机记录的所有变更日志"
              @click="onClearAuditLogs"
            >
              {{ busy.deleting ? "清空中…" : "清除" }}
            </button>
            <button
              v-if="isSharedMode"
              type="button"
              :disabled="!isLoggedIn || accountBusy.syncing"
              title="立即把本机待同步记录推送到中心服务"
              @click="onSyncNow"
            >{{ accountBusy.syncing ? "同步中…" : "立即同步" }}</button>
            <button type="button" class="wb-dialog-primary" :disabled="busy.listing || busy.deleting" @click="applyFilters()">
              {{ busy.listing ? "查询中…" : "刷新" }}
            </button>
          </div>
        </div>

        <div class="wb-backup-list wb-backup-audit">
          <div v-if="!visibleAuditLogs.length" class="wb-backup-empty">
            <svg class="wb-backup-empty-icon" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
              <rect x="8" y="6" width="24" height="28" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <line x1="13" y1="14" x2="27" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="13" y1="20" x2="27" y2="20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="13" y1="26" x2="22" y2="26" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <strong>{{ isSharedMode ? "暂无共享变更记录" : "暂无变更记录" }}</strong>
            <span>{{ isSharedMode ? "其他用户通过本应用修改数据后，记录会出现在这里。" : "通过本应用修改数据后会自动记录到这里，可一键回滚。" }}</span>
          </div>
          <article
            v-for="entry in visibleAuditLogs"
            :key="entry.clientId || entry.id"
            class="wb-backup-audit-row"
            :class="{ rolled: entry.isRollback, aborted: entry.status === 'aborted', shared: isSharedMode }"
          >
            <div class="wb-backup-audit-main">
              <span class="wb-backup-ts">{{ formatTs(entry.ts) }}</span>
              <span class="wb-backup-op" :data-op="entry.operation">{{ operationLabel(entry.operation) }}</span>
              <span class="wb-backup-loc">{{ entry.database }} · {{ entry.tableName }}</span>
              <span v-if="entry.columnName" class="wb-backup-col">{{ entry.columnName }}</span>
              <span v-if="entry.columnName && entry.oldValue != null" class="wb-backup-diff">{{ entry.oldValue }} → {{ entry.newValue }}</span>
              <span v-if="isSharedMode" class="wb-backup-chip wb-backup-audit-actor" :title="actorLabel(entry)">{{ actorLabel(entry) }}</span>
              <span class="wb-backup-chip" data-kind="source">{{ sourceLabel(entry.source) }}</span>
              <span class="wb-backup-chip" data-kind="status" :data-status="entry.status">{{ statusLabel(entry.status) }}</span>
              <span v-if="!isSharedMode" class="wb-backup-chip" data-kind="strategy" :data-strategy="entry.rollbackStrategy">{{ strategyLabel(entry.rollbackStrategy) }}</span>
            </div>
            <div class="wb-backup-audit-meta">
              <span v-if="identityText(entry)" class="wb-backup-identity">行：{{ identityText(entry) }}</span>
              <span v-if="entry.isRollback" class="wb-backup-rollback-tag">回滚操作</span>
            </div>
            <div v-if="!isSharedMode || isLocalRow(entry)" class="wb-backup-row-actions">
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
        <div class="wb-backup-toolbar wb-backup-snapshot-toolbar">
          <div class="wb-backup-filter-fields">
            <label class="wb-backup-filter">
              <span>连接</span>
              <select v-model="filters.connectionId" aria-label="快照按连接筛选" @change="onConnectionFilterChange">
                <option value="">全部连接</option>
                <option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
              </select>
            </label>
            <label class="wb-backup-filter">
              <span>数据库</span>
              <select
                v-model="filters.database"
                aria-label="快照按数据库筛选"
                :disabled="!filters.connectionId || busy.filterOptions"
                @change="onDatabaseFilterChange"
              >
                <option value="">全部数据库</option>
                <option v-for="database in filterDatabases" :key="database" :value="database">{{ database }}</option>
              </select>
            </label>
          </div>
          <div class="wb-backup-toolbar-actions">
            <button type="button" class="wb-dialog-primary" :disabled="busy.snapshotting" @click="onCreateSnapshot">
              {{ busy.snapshotting ? "快照中…" : "立即创建快照" }}
            </button>
            <button type="button" :disabled="busy.snapshotting || busy.restoring" @click="onPruneSnapshots">清理旧快照</button>
          </div>
          <p v-if="progress.active" class="wb-backup-progress-text" aria-live="polite">
            {{ progress.message || `已处理 ${progress.done} / ${progress.total}` }}
          </p>
        </div>

        <div class="wb-backup-snapshot-layout">
          <section class="wb-backup-enable-panel" aria-label="快照范围设置">
            <div class="wb-backup-enable-head">
              <div class="wb-backup-enable-head-text">
                <strong>定时快照范围</strong>
                <p>定时快照仅对下方勾选的数据库执行；未勾选的库不会自动快照，但仍可手动创建快照。</p>
              </div>
            </div>

            <div class="wb-backup-enable-list">
              <div v-if="!enableConnectionId" class="wb-backup-enable-empty">
                <svg class="wb-backup-empty-icon" width="32" height="32" viewBox="0 0 40 40" aria-hidden="true">
                  <circle cx="20" cy="16" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
                  <path d="M10 34 C10 26 14 22 20 22 C26 22 30 26 30 34" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                <strong>选择连接</strong>
                <span>先选择一个连接，再勾选需要自动快照的数据库。</span>
              </div>
              <div v-else-if="busy.filterOptions" class="wb-backup-enable-empty">
                正在加载数据库列表…
              </div>
              <div v-else-if="!enableDatabases.length" class="wb-backup-enable-empty">
                该连接暂无可快照的数据库。
              </div>
              <label
                v-for="database in enableDatabases"
                :key="database"
                class="wb-backup-enable-row"
                :class="{ disabled: !isConnectionSnapshotable(enableConnectionId) }"
              >
                <input
                  type="checkbox"
                  :checked="props.backup.isSnapshotEnabled(enableConnectionId, database)"
                  :disabled="busy.togglingDb || !isConnectionSnapshotable(enableConnectionId)"
                  @change="onToggleSnapshotEnabled(enableConnectionId, database, $event.target.checked)"
                />
                <span class="wb-backup-enable-name">{{ database }}</span>
                <span
                  class="wb-backup-enable-tag"
                  :data-state="snapshotDbState(enableConnectionId, database)"
                >{{ snapshotDbStateLabel(snapshotDbState(enableConnectionId, database)) }}</span>
              </label>
            </div>
          </section>

          <section class="wb-backup-selected-panel" aria-label="已选择自动快照的数据库">
            <div class="wb-backup-selected-head">
              <div class="wb-backup-selected-head-text">
                <strong>已选择自动快照的数据库</strong>
                <p>勾选的数据库会按设置中的间隔自动创建快照。</p>
              </div>
              <span
                class="wb-backup-selected-count"
                :data-count="selectedBackupCount"
                :data-empty="selectedBackupCount === 0"
              >{{ selectedBackupCount }}</span>
            </div>

            <div class="wb-backup-selected-list">
              <div v-if="!selectedBackupCount" class="wb-backup-selected-empty" role="status">
                <svg class="wb-backup-empty-icon" width="32" height="32" viewBox="0 0 40 40" aria-hidden="true">
                  <rect x="8" y="10" width="24" height="3" rx="1.5" fill="currentColor" opacity="0.4"/>
                  <rect x="8" y="18" width="16" height="3" rx="1.5" fill="currentColor" opacity="0.4"/>
                  <rect x="8" y="26" width="20" height="3" rx="1.5" fill="currentColor" opacity="0.4"/>
                </svg>
                <strong>尚未选择数据库</strong>
                <span>在左侧勾选数据库后，它们会出现在这里。</span>
              </div>
              <div
                v-for="item in selectedBackupDatabases"
                :key="`${item.connectionId}/${item.database}`"
                class="wb-backup-selected-row"
                :title="`点击跳转到 ${item.connectionLabel}`"
                @click="onJumpToConnection(item.connectionId)"
              >
                <div class="wb-backup-selected-info">
                  <span class="wb-backup-selected-conn">{{ item.connectionLabel }}</span>
                  <span class="wb-backup-selected-db">{{ item.database }}</span>
                </div>
                <button
                  type="button"
                  class="wb-backup-selected-remove"
                  :disabled="busy.togglingDb"
                  title="取消该数据库的自动快照"
                  aria-label="取消该数据库的自动快照"
                  @click.stop="onToggleSnapshotEnabled(item.connectionId, item.database, false)"
                >×</button>
              </div>
            </div>
          </section>
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

        <div class="wb-backup-list-header">
          <strong>快照列表</strong>
          <span class="wb-backup-list-count" :data-empty="!snapshots.length">{{ snapshots.length }}</span>
        </div>

        <div class="wb-backup-list wb-backup-snapshots">
          <div v-if="!snapshots.length" class="wb-backup-empty" role="status">
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
              <span class="wb-backup-ts">{{ formatTs(snapshot.ts) }}</span>
              <span class="wb-backup-loc">{{ snapshot.connectionId }} · {{ snapshot.database }}</span>
              <span v-if="snapshot.location === 'legacy'" class="wb-backup-loc-tag">旧位置</span>
              <span class="wb-backup-meta">{{ snapshot.tableCount }} 表 · {{ formatSize(snapshot.sizeBytes) }}</span>
            </div>
            <div class="wb-backup-row-actions">
              <button
                type="button"
                class="wb-backup-action-btn"
                :disabled="busy.openingPath"
                @click="onOpenSnapshotFolder(snapshot)"
              >打开资源管理器</button>
              <button
                type="button"
                class="wb-backup-action-btn"
                :disabled="busy.restoring || busy.deleting"
                @click="onRestore(snapshot)"
              >{{ busy.restoring ? "还原中…" : "还原" }}</button>
              <button
                type="button"
                class="wb-backup-action-btn wb-backup-action-danger"
                :disabled="busy.restoring || busy.deleting"
                @click="onDelete(snapshot)"
              >{{ busy.deleting ? "删除中…" : "删除" }}</button>
            </div>
          </article>
        </div>
      </div>

      <div v-else id="wb-backup-panel-config" class="wb-backup-panel wb-backup-config" role="tabpanel" aria-labelledby="wb-backup-title">
        <section class="wb-account-section" aria-label="用户账号">
          <div class="wb-account-head">
            <strong>用户账号</strong>
            <p>登录后，你的改动会同步到全员可见的变更日志，其他同事也能看到是谁改了什么。</p>
          </div>

          <label class="wb-dialog-field wb-account-field">
            <span>中心服务地址</span>
            <span class="wb-account-server-control">
              <input
                v-model="accountDraft.serverUrl"
                type="text"
                placeholder="http://192.168.1.193:8765"
                aria-label="中心服务地址"
              />
              <button type="button" :disabled="accountBusy.savingServer" @click="onSaveServerUrl">
                {{ accountBusy.savingServer ? "保存中…" : "保存" }}
              </button>
            </span>
          </label>

          <div v-if="isLoggedIn" class="wb-account-logged-in">
            <div class="wb-account-session">
              <span class="wb-account-avatar">{{ (displayName || username || '?').slice(0, 1).toUpperCase() }}</span>
              <span class="wb-account-session-text">
                <strong>{{ displayName }}</strong>
                <em>@{{ username }}</em>
              </span>
            </div>
            <button
              type="button"
              class="wb-backup-action-danger"
              :disabled="accountBusy.loggingOut"
              @click="onLogout"
            >{{ accountBusy.loggingOut ? "退出中…" : "退出登录" }}</button>
          </div>

          <div v-else class="wb-account-login-form">
            <label class="wb-dialog-field wb-account-field">
              <span>用户名</span>
              <input
                v-model="accountDraft.username"
                type="text"
                placeholder="用于登录的用户名"
                aria-label="用户名"
              />
            </label>
            <label class="wb-dialog-field wb-account-field">
              <span>昵称（可选）</span>
              <input
                v-model="accountDraft.displayName"
                type="text"
                placeholder="变更日志中显示的名称"
                aria-label="昵称"
              />
            </label>
            <p v-if="accountError" class="wb-dialog-error">{{ accountError }}</p>
            <div class="wb-account-actions">
              <button type="button" :disabled="accountBusy.registering" @click="onRegister">
                {{ accountBusy.registering ? "注册中…" : "注册" }}
              </button>
              <button type="button" class="wb-dialog-primary" :disabled="accountBusy.loggingIn" @click="onLogin">
                {{ accountBusy.loggingIn ? "登录中…" : "登录" }}
              </button>
            </div>
            <p class="wb-account-hint">仅用户名即可登录（无需密码）。新用户请先「注册」，已注册用户直接「登录」。</p>
          </div>
        </section>

        <div class="wb-backup-config-fields">
          <div class="wb-backup-config-field wb-backup-storage-field">
            <span>存储位置</span>
            <div class="wb-backup-storage-control">
              <code class="wb-backup-storage-path" :title="storageDirDisplay">{{ storageDirDisplay }}</code>
              <button type="button" :disabled="busy.openingPath || isBusy" @click="onOpenStorageDir">打开</button>
              <button type="button" :disabled="busy.pickingDir || isBusy" @click="onPickStorageDir">
                {{ busy.pickingDir ? "选择中…" : "更改…" }}
              </button>
            </div>
          </div>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>启用定时快照</span>
            <input v-model="draftConfig.enabled" type="checkbox" />
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>快照间隔</span>
            <span class="wb-backup-config-input">
              <BackupNumberInput v-model="draftConfig.intervalMinutes" :min="1" aria-label="快照间隔（分钟）" />
              <em>分钟</em>
            </span>
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>大表阈值</span>
            <span class="wb-backup-config-input">
              <BackupNumberInput v-model="draftConfig.largeTableThreshold" :min="0" aria-label="大表阈值（行数）" />
              <em>行，超过则跳过</em>
            </span>
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>保留数量</span>
            <span class="wb-backup-config-input">
              <BackupNumberInput v-model="draftConfig.maxPerDb" :min="1" aria-label="每库最多保留快照数" />
              <em>个 / 库</em>
            </span>
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>日志保留</span>
            <span class="wb-backup-config-input">
              <BackupNumberInput v-model="draftConfig.auditRetentionDays" :min="1" aria-label="审计日志保留天数" />
              <em>天</em>
            </span>
          </label>
        </div>

        <aside class="wb-backup-hint">
          设置保存在本地。更改存储位置后，旧位置快照仍可在列表中查看和删除，但新快照只写入新位置。审计日志与快照与目标数据库隔离——即使目标库被误删也不会丢失。
        </aside>

        <footer class="wb-dialog-actions wb-backup-config-actions">
          <button type="button" class="wb-dialog-primary" :disabled="busy.savingConfig" @click="onSaveConfig">
            {{ busy.savingConfig ? "保存中…" : "保存设置" }}
          </button>
        </footer>
      </div>
      <ConfirmDialog
        v-bind="confirmDialog"
        @confirm="closeConfirm(true)"
        @cancel="closeConfirm(false)"
      />
    </section>
  </div>
</template>
