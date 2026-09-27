<script setup>
import { t } from "../i18n/index.js";
import { computed, ref, watch } from "vue";

import AuditTableHistory from "./AuditTableHistory.vue";
import BackupNumberInput from "./BackupNumberInput.vue";
import { useConfirm } from "../composables/useConfirm.js";
import { useEscClose } from "../composables/useEscClose.js";
import {
  auditChangeItems,
  auditChangeSql,
  auditChangeSummary,
  auditHasDetails,
} from "../utils/auditDisplay.js";
import { connectionHasCapability } from "../utils/connectionKinds.js";

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
const localAuditByClientId = computed(() =>
  new Map(
    auditLogs.value
      .filter((entry) => entry.clientId)
      .map((entry) => [entry.clientId, entry]),
  ),
);
const expandedAuditKeys = ref(new Set());
const visibleAuditRows = computed(() =>
  visibleAuditLogs.value.map((entry) => {
    const localEntry = entry.clientId ? localAuditByClientId.value.get(entry.clientId) : null;
    const displayEntry = localEntry
      ? {
          ...localEntry,
          ...entry,
          id: localEntry.id,
          rowIdentity: entry.rowIdentity ?? localEntry.rowIdentity,
          forwardSql: entry.forwardSql ?? localEntry.forwardSql,
          inverseSql: entry.inverseSql ?? localEntry.inverseSql,
          rollbackStrategy: entry.rollbackStrategy ?? localEntry.rollbackStrategy,
          notes: entry.notes ?? localEntry.notes,
        }
      : entry;
    const key = entry.clientId || entry.id;
    return {
      key,
      entry: displayEntry,
      summary: auditChangeSummary(displayEntry),
      changeItems: auditChangeItems(displayEntry),
      sql: auditChangeSql(displayEntry),
      hasDetails: auditHasDetails(displayEntry),
    };
  }),
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
const accountBusy = computed(() => account.value?.busy?.value || account.value?.busy || {});

const { confirm, alert } = useConfirm();

const isBusy = computed(() => (
  Object.values(busy.value || {}).some(Boolean)
  || Boolean(progress.value?.active)
  || Object.values(accountBusy.value || {}).some(Boolean)
));
const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), () => isBusy.value, { dialogRef });

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
function isAuditExpanded(key) {
  return expandedAuditKeys.value.has(key);
}
function toggleAuditDetails(key) {
  const next = new Set(expandedAuditKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedAuditKeys.value = next;
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
    return;
  }
  // Clear the form fields on success — the user is now shown in the header.
  accountDraft.value.username = "";
  accountDraft.value.displayName = "";
}

async function onLogin() {
  if (!accountDraft.value.username.trim()) {
    await alert({ title: "请输入用户名", message: "登录前请填写用户名。" });
    return;
  }
  const ok = await account.value?.login(accountDraft.value.username);
  if (!ok) {
    await alert({ title: "登录失败", message: accountError.value || "登录失败。" });
    return;
  }
  accountDraft.value.username = "";
  accountDraft.value.displayName = "";
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
  await props.backup.loadAuditLogs();
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

// ---- Snapshot import ---------------------------------------------------------
const importDraft = computed(() => props.backup.importDraft);
const importHasDraft = computed(() => Boolean(importDraft.value?.sourcePath));
const importConnectionValid = computed(() =>
  props.connections.some((connection) => connection.id === importDraft.value?.connectionId),
);
const importCanConfirm = computed(
  () =>
    importHasDraft.value &&
    importConnectionValid.value &&
    Boolean(importDraft.value.database) &&
    !busy.value.importing,
);

async function onImportSnapshot() {
  await props.backup.startImport();
}
function onImportConnectionChange(event) {
  props.backup.setImportTarget({ connectionId: event.target.value });
}
function onImportDatabaseChange(event) {
  props.backup.setImportTarget({ database: event.target.value });
}
async function onConfirmImport() {
  const info = await props.backup.confirmImport();
  if (info) {
    await alert({ title: "导入完成", message: `快照已导入到 ${info.connectionId} / ${info.database}。` });
  } else if (props.backup.lastError.value) {
    await alert({ title: "导入失败", message: props.backup.lastError.value });
  }
}
function onCancelImport() {
  props.backup.cancelImport();
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
  return Boolean(
    connection &&
      !connection.readOnly &&
      connectionHasCapability(connection.kind, "snapshots"),
  );
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
  <div class="wb-dialog-overlay">
    <section ref="dialogRef" class="wb-dialog wb-backup-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-backup-title" tabindex="-1">
      <header class="wb-backup-header">
        <div class="wb-backup-heading">
          <strong id="wb-backup-title">{{ t('m_965320c43727') }}</strong>
          <p class="wb-backup-subtitle">{{ t('m_1c161224847e') }}</p>
        </div>
        <div class="wb-backup-user" :data-logged-in="isLoggedIn">
          <template v-if="isLoggedIn">
            <span class="wb-backup-user-avatar" :title="`${displayName} (@${username})`">{{ (displayName || username || '?').slice(0, 1).toUpperCase() }}</span>
            <span class="wb-backup-user-name">{{ displayName }}<em>@{{ username }}</em></span>
          </template>
          <template v-else>
            <span class="wb-backup-user-name wb-backup-user-guest">{{ t('m_c1f658373079') }}</span>
          </template>
        </div>
        <button type="button" class="wb-dialog-close wb-backup-close" :disabled="isBusy" :aria-label="t('m_9859381ba96b')" @click="emit('close')">×</button>
      </header>

      <nav class="wb-backup-tabs" :inert="busy.restoring" role="tablist" :aria-label="t('m_2a5a3ca85415')">
        <button
          type="button"
          role="tab"
          :class="{ active: dialog.tab === 'audit' }"
          :aria-selected="dialog.tab === 'audit'"
          aria-controls="wb-backup-panel-audit"
          @click="switchTab('audit')"
        >{{ t('m_7bf9d4a5d756') }}</button>
        <button
          type="button"
          role="tab"
          :class="{ active: dialog.tab === 'snapshot' }"
          :aria-selected="dialog.tab === 'snapshot'"
          aria-controls="wb-backup-panel-snapshot"
          @click="switchTab('snapshot')"
        >{{ t('m_df6017193d6d') }}</button>
        <button
          type="button"
          role="tab"
          :class="{ active: dialog.tab === 'config' }"
          :aria-selected="dialog.tab === 'config'"
          aria-controls="wb-backup-panel-config"
          @click="switchTab('config')"
        >{{ t('m_df3d58c7d84b') }}</button>
      </nav>

      <div v-if="dialog.tab === 'audit'" id="wb-backup-panel-audit" class="wb-backup-panel" role="tabpanel" aria-labelledby="wb-backup-title">
        <div class="wb-backup-toolbar wb-backup-audit-toolbar" :inert="busy.restoring">
          <div class="wb-backup-audit-mode" role="group" :aria-label="t('m_abfcfbe5dac3')">
            <button
              type="button"
              :class="{ active: !isSharedMode }"
              :aria-pressed="!isSharedMode"
              @click="onSwitchAuditMode('local')"
            >{{ t('m_5a51f9817528') }}</button>
            <button
              type="button"
              :class="{ active: isSharedMode }"
              :aria-pressed="isSharedMode"
              :disabled="!isLoggedIn"
              :title="isLoggedIn ? t('m_a24d3bbb258d') : t('m_9150140d1161')"
              @click="onSwitchAuditMode('shared')"
            >{{ t('m_62f97aa58516') }}</button>
          </div>
          <div class="wb-backup-filter-fields">
            <label class="wb-backup-filter">
              <span>{{ t('m_a5574109f020') }}</span>
              <select v-model="filters.connectionId" :aria-label="t('m_8bec5f76301e')" @change="onConnectionFilterChange">
                <option value="">{{ t('m_dbb2c7b44300') }}</option>
                <option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
              </select>
            </label>
            <label class="wb-backup-filter">
              <span>{{ t('m_263200d7d529') }}</span>
              <select
                v-model="filters.database"
                :aria-label="t('m_a6bb90d7e9ea')"
                :disabled="!filters.connectionId || busy.filterOptions"
                @change="onDatabaseFilterChange"
              >
                <option value="">{{ t('m_d3ea59fd4532') }}</option>
                <option v-for="database in filterDatabases" :key="database" :value="database">{{ database }}</option>
              </select>
            </label>
            <label class="wb-backup-filter">
              <span>{{ t('m_699c6d62a836') }}</span>
              <select
                v-model="filters.tableName"
                :aria-label="t('m_1408973f34e3')"
                :disabled="!filters.connectionId || !filters.database || busy.filterOptions"
                @change="applyFilters"
              >
                <option value="">{{ t('m_f974e44668ed') }}</option>
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
              :title="t('m_492827885e5c')"
              @click="onClearAuditLogs"
            >
              {{ busy.deleting ? t('m_191f6e5642c2') : t('m_bce2377283c2') }}
            </button>
            <button
              v-if="isSharedMode"
              type="button"
              :disabled="!isLoggedIn || accountBusy.syncing"
              :title="t('m_6a8aa8247031')"
              @click="onSyncNow"
            >{{ accountBusy.syncing ? t('m_4e2238b74ec7') : t('m_36e7a43a1c67') }}</button>
            <button type="button" class="wb-dialog-primary" :disabled="busy.listing || busy.deleting" @click="applyFilters()">
              {{ busy.listing ? t('m_d302f90b0996') : t('m_aee887434131') }}
            </button>
          </div>
        </div>

        <AuditTableHistory v-if="!isSharedMode" :history="backup.history" :connections="connections" />
        <div v-else class="wb-backup-list wb-backup-audit">
          <div v-if="!visibleAuditLogs.length" class="wb-backup-empty">
            <svg class="wb-backup-empty-icon" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
              <rect x="8" y="6" width="24" height="28" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <line x1="13" y1="14" x2="27" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="13" y1="20" x2="27" y2="20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="13" y1="26" x2="22" y2="26" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <strong>{{ isSharedMode ? t('m_cb9612a9181a') : t('m_8fc1fbd37765') }}</strong>
            <span>{{ isSharedMode ? t('m_0b856c6ee3f3') : t('m_d30bcd545898') }}</span>
          </div>
          <article
            v-for="row in visibleAuditRows"
            :key="row.key"
            class="wb-backup-audit-row"
            :class="{ rolled: row.entry.isRollback, aborted: row.entry.status === 'aborted', shared: isSharedMode, expanded: isAuditExpanded(row.key) }"
          >
            <div class="wb-backup-audit-main">
              <span class="wb-backup-ts">{{ formatTs(row.entry.ts) }}</span>
              <span class="wb-backup-op" :data-op="row.entry.operation">{{ operationLabel(row.entry.operation) }}</span>
              <span class="wb-backup-loc">{{ row.entry.database }} · {{ row.entry.tableName }}</span>
              <span
                class="wb-backup-diff wb-backup-change-summary"
                :class="{ empty: !row.summary }"
                :title="row.summary || t('m_ebfb90ae7a95')"
              >
                <b>{{ t('m_a26529f8c3a1') }}</b>{{ row.summary || t('m_12964a9ef161') }}
              </span>
              <span v-if="isSharedMode" class="wb-backup-chip wb-backup-audit-actor" :title="actorLabel(row.entry)">{{ actorLabel(row.entry) }}</span>
              <span class="wb-backup-chip" data-kind="source">{{ sourceLabel(row.entry.source) }}</span>
              <span class="wb-backup-chip" data-kind="status" :data-status="row.entry.status">{{ statusLabel(row.entry.status) }}</span>
              <span v-if="!isSharedMode" class="wb-backup-chip" data-kind="strategy" :data-strategy="row.entry.rollbackStrategy">{{ strategyLabel(row.entry.rollbackStrategy) }}</span>
            </div>
            <div class="wb-backup-audit-meta">
              <span v-if="identityText(row.entry)" class="wb-backup-identity">{{ t('m_a9e8c256cb93') }}{{ identityText(row.entry) }}</span>
              <span v-if="row.entry.isRollback" class="wb-backup-rollback-tag">{{ t('m_dd194f08e2f4') }}</span>
            </div>
            <div v-if="row.hasDetails || !isSharedMode || isLocalRow(row.entry)" class="wb-backup-row-actions">
              <button
                v-if="row.hasDetails"
                type="button"
                class="wb-backup-action-btn wb-backup-details-btn"
                :aria-expanded="isAuditExpanded(row.key)"
                @click="toggleAuditDetails(row.key)"
              >{{ isAuditExpanded(row.key) ? t('m_0ae7312510f4') : t('m_1932da4d4dba') }}</button>
              <button
                v-if="!isSharedMode"
                type="button"
                class="wb-backup-action-btn"
                :disabled="!canRollback(row.entry) || busy.rollingBack"
                :title="canRollback(row.entry) ? t('m_db40aa237dd5') : t('m_356545d1c7cf')"
                @click="onRollback(row.entry)"
              >{{ busy.rollingBack ? t('m_43172ac13531') : t('m_6518e21a8e5f') }}</button>
            </div>
            <section
              v-if="row.hasDetails && isAuditExpanded(row.key)"
              class="wb-backup-change-details"
              :aria-label="t('m_62a0d24eab2e')"
            >
              <div class="wb-backup-change-details-head">
                <strong>{{ t('m_c7cec0185b47') }}</strong>
                <span v-if="row.changeItems.length">{{ row.changeItems.length }} {{ t('m_49ccde43a154') }}</span>
              </div>
              <ul v-if="row.changeItems.length">
                <li v-for="(item, index) in row.changeItems" :key="`${row.key}-change-${index}`">{{ item }}</li>
              </ul>
              <p v-if="row.entry.notes" class="wb-backup-change-note"><b>{{ t('m_3e633a204a63') }}</b>{{ row.entry.notes }}</p>
              <details v-if="row.sql" class="wb-backup-change-sql">
                <summary>{{ t('m_036ad51c02f9') }}</summary>
                <pre><code>{{ row.sql }}</code></pre>
              </details>
            </section>
          </article>
        </div>
      </div>

      <div v-else-if="dialog.tab === 'snapshot'" id="wb-backup-panel-snapshot" class="wb-backup-panel" role="tabpanel" aria-labelledby="wb-backup-title">
        <div class="wb-backup-toolbar wb-backup-snapshot-toolbar">
          <div class="wb-backup-filter-fields">
            <label class="wb-backup-filter">
              <span>{{ t('m_a5574109f020') }}</span>
              <select v-model="filters.connectionId" :aria-label="t('m_2463a8cac346')" @change="onConnectionFilterChange">
                <option value="">{{ t('m_dbb2c7b44300') }}</option>
                <option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
              </select>
            </label>
            <label class="wb-backup-filter">
              <span>{{ t('m_263200d7d529') }}</span>
              <select
                v-model="filters.database"
                :aria-label="t('m_d2b71553b714')"
                :disabled="!filters.connectionId || busy.filterOptions"
                @change="onDatabaseFilterChange"
              >
                <option value="">{{ t('m_d3ea59fd4532') }}</option>
                <option v-for="database in filterDatabases" :key="database" :value="database">{{ database }}</option>
              </select>
            </label>
          </div>
          <div class="wb-backup-toolbar-actions">
            <button type="button" class="wb-dialog-primary" :disabled="busy.snapshotting" @click="onCreateSnapshot">
              {{ busy.snapshotting ? t('m_59f718698ac4') : t('m_57d83fa495ec') }}
            </button>
            <button type="button" :disabled="busy.snapshotting || busy.restoring || busy.pruning" @click="onPruneSnapshots">
              {{ busy.pruning ? t('m_248e8cfc2116') : t('m_855f69b1a700') }}
            </button>
            <button type="button" :disabled="busy.inspecting || busy.importing" @click="onImportSnapshot">
              {{ busy.inspecting ? t('m_29d75b8eb886') : t('m_b11bb27929db') }}
            </button>
          </div>
          <p v-if="progress.active" class="wb-backup-progress-text" aria-live="polite">
            {{ progress.message || `已处理 ${progress.done} / ${progress.total}` }}
          </p>
        </div>

        <section v-if="importHasDraft" class="wb-backup-import" :aria-label="t('m_b7641d80b645')">
          <div class="wb-backup-import-head">
            <strong>{{ t('m_b7641d80b645') }}</strong>
            <span class="wb-backup-import-file" :title="importDraft.sourcePath">
              {{ importDraft.fileName }} · {{ formatSize(importDraft.sizeBytes) }}
            </span>
          </div>
          <p v-if="importDraft.originConnectionId" class="wb-backup-import-origin"> {{ t('m_7b032a06750e') }}{{ importDraft.originConnectionId }} / {{ importDraft.originDatabase }}<template v-if="importDraft.originTs">（{{ formatTs(importDraft.originTs) }}）</template>
          </p>
          <p v-else class="wb-backup-import-origin"> {{ t('m_4c3966f740be') }} </p>
          <div class="wb-backup-import-fields">
            <label class="wb-backup-filter">
              <span>{{ t('m_37b9835a7d78') }}</span>
              <select :value="importDraft.connectionId" :aria-label="t('m_2a2161d84a2b')" @change="onImportConnectionChange">
                <option value="">{{ t('m_f85168b69fc0') }}</option>
                <option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
              </select>
            </label>
            <label class="wb-backup-filter">
              <span>{{ t('m_6c7424a6b8a4') }}</span>
              <select
                :value="importDraft.database"
                :aria-label="t('m_08018dd88b90')"
                :disabled="!importDraft.connectionId"
                @change="onImportDatabaseChange"
              >
                <option value="">{{ t('m_916097b963aa') }}</option>
                <option v-for="database in importDraft.databases" :key="database" :value="database">{{ database }}</option>
              </select>
            </label>
            <div class="wb-backup-import-actions">
              <button type="button" class="wb-dialog-primary" :disabled="!importCanConfirm" @click="onConfirmImport">
                {{ busy.importing ? t('m_2f58b6eddc08') : t('m_576d81bb0631') }}
              </button>
              <button type="button" :disabled="busy.importing" @click="onCancelImport">{{ t('m_2cd0f3be8738') }}</button>
            </div>
          </div>
        </section>

        <div class="wb-backup-snapshot-layout">
          <section class="wb-backup-enable-panel" :aria-label="t('m_17f4ce2edaf4')">
            <div class="wb-backup-enable-head">
              <div class="wb-backup-enable-head-text">
                <strong>{{ t('m_f1d1e541f7ad') }}</strong>
                <p>{{ t('m_a7b230525d19') }}</p>
              </div>
            </div>

            <div class="wb-backup-enable-list">
              <div v-if="!enableConnectionId" class="wb-backup-enable-empty">
                <svg class="wb-backup-empty-icon" width="32" height="32" viewBox="0 0 40 40" aria-hidden="true">
                  <circle cx="20" cy="16" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
                  <path d="M10 34 C10 26 14 22 20 22 C26 22 30 26 30 34" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                <strong>{{ t('m_1020f3cc2c1b') }}</strong>
                <span>{{ t('m_db845ade9920') }}</span>
              </div>
              <div v-else-if="busy.filterOptions" class="wb-backup-enable-empty"> {{ t('m_ce0c5d040535') }} </div>
              <div v-else-if="!enableDatabases.length" class="wb-backup-enable-empty"> {{ t('m_03e09d05c0fa') }} </div>
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

          <section class="wb-backup-selected-panel" :aria-label="t('m_132899150376')">
            <div class="wb-backup-selected-head">
              <div class="wb-backup-selected-head-text">
                <strong>{{ t('m_132899150376') }}</strong>
                <p>{{ t('m_e6c122e54ca9') }}</p>
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
                <strong>{{ t('m_1e8f5b7485b7') }}</strong>
                <span>{{ t('m_2df96d2c5450') }}</span>
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
                  :title="t('m_93d5cb2bb76e')"
                  :aria-label="t('m_93d5cb2bb76e')"
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
          <strong>{{ t('m_6c534bd7e43f') }}</strong>
          <span class="wb-backup-list-count" :data-empty="!snapshots.length">{{ snapshots.length }}</span>
        </div>

        <div class="wb-backup-list wb-backup-snapshots">
          <div v-if="!snapshots.length" class="wb-backup-empty" role="status">
            <svg class="wb-backup-empty-icon" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
              <path d="M10 14 L20 8 L30 14 V30 H10 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M10 14 H30" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <rect x="16" y="20" width="8" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>
            </svg>
            <strong>{{ t('m_cf028e868970') }}</strong>
            <span>{{ t('m_e990ba921088') }}</span>
          </div>
          <article v-for="snapshot in snapshots" :key="snapshot.path" class="wb-backup-snapshot-row">
            <div class="wb-backup-snapshot-main">
              <span class="wb-backup-ts">{{ formatTs(snapshot.ts) }}</span>
              <span class="wb-backup-loc">{{ snapshot.connectionId }} · {{ snapshot.database }}</span>
              <span v-if="snapshot.location === 'legacy'" class="wb-backup-loc-tag">{{ t('m_81472bc14c2b') }}</span>
              <span class="wb-backup-meta">{{ snapshot.tableCount }} {{ t('m_09c5e5e83c29') }} {{ formatSize(snapshot.sizeBytes) }}</span>
            </div>
            <div class="wb-backup-row-actions">
              <button
                type="button"
                class="wb-backup-action-btn"
                :disabled="busy.openingPath"
                @click="onOpenSnapshotFolder(snapshot)"
              >{{ t('m_4b4d6c35f5f7') }}</button>
              <button
                type="button"
                class="wb-backup-action-btn"
                :disabled="busy.restoring || busy.deleting"
                @click="onRestore(snapshot)"
              >{{ busy.restoring ? t('m_7398723bff4f') : t('m_ddde08946298') }}</button>
              <button
                type="button"
                class="wb-backup-action-btn wb-backup-action-danger"
                :disabled="busy.restoring || busy.deleting"
                @click="onDelete(snapshot)"
              >{{ busy.deleting ? t('m_5e8e7af57abb') : t('m_2f9daa828907') }}</button>
            </div>
          </article>
        </div>
      </div>

      <div v-else id="wb-backup-panel-config" class="wb-backup-panel wb-backup-config" role="tabpanel" aria-labelledby="wb-backup-title">
        <section class="wb-account-section" :aria-label="t('m_082edb693d65')">
          <div class="wb-account-head">
            <strong>{{ t('m_082edb693d65') }}</strong>
            <p>{{ t('m_a7ef24167da2') }}</p>
          </div>

          <label class="wb-dialog-field wb-account-field">
            <span>{{ t('m_937c4d303733') }}</span>
            <span class="wb-account-server-control">
              <input
                v-model="accountDraft.serverUrl"
                type="text"
                placeholder="https://audit.example.com"
                :aria-label="t('m_937c4d303733')"
              />
              <button type="button" :disabled="accountBusy.savingServer" @click="onSaveServerUrl">
                {{ accountBusy.savingServer ? t('m_ff509c9ba052') : t('m_a3030bf8f16d') }}
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
            >{{ accountBusy.loggingOut ? t('m_4803e2da0873') : t('m_3ab8cc15939f') }}</button>
          </div>

          <div v-else class="wb-account-login-form">
            <label class="wb-dialog-field wb-account-field">
              <span>{{ t('m_1a3f0617d6de') }}</span>
              <input
                v-model="accountDraft.username"
                type="text"
                :placeholder="t('m_243b4d9f1f88')"
                :aria-label="t('m_1a3f0617d6de')"
              />
            </label>
            <label class="wb-dialog-field wb-account-field">
              <span>{{ t('m_72e6ce1c561e') }}</span>
              <input
                v-model="accountDraft.displayName"
                type="text"
                :placeholder="t('m_2ee067611e30')"
                :aria-label="t('m_7a1e2b964b67')"
              />
            </label>
            <p v-if="accountError" class="wb-dialog-error">{{ accountError }}</p>
            <div class="wb-account-actions">
              <button type="button" :disabled="accountBusy.registering" @click="onRegister">
                {{ accountBusy.registering ? t('m_0debc065262a') : t('m_c4fb62202bad') }}
              </button>
              <button type="button" class="wb-dialog-primary" :disabled="accountBusy.loggingIn" @click="onLogin">
                {{ accountBusy.loggingIn ? t('m_3f06ed8f8c38') : t('m_1e2df9c3075a') }}
              </button>
            </div>
            <p class="wb-account-hint">{{ t('m_e7c4c138ba05') }}</p>
          </div>
        </section>

        <div class="wb-backup-config-fields">
          <div class="wb-backup-config-field wb-backup-storage-field">
            <span>{{ t('m_6d8627b2f68e') }}</span>
            <div class="wb-backup-storage-control">
              <code class="wb-backup-storage-path" :title="storageDirDisplay">{{ storageDirDisplay }}</code>
              <button type="button" :disabled="busy.openingPath || isBusy" @click="onOpenStorageDir">{{ t('m_c771248e511f') }}</button>
              <button type="button" :disabled="busy.pickingDir || isBusy" @click="onPickStorageDir">
                {{ busy.pickingDir ? t('m_71732f06ad09') : t('m_d7392d66de94') }}
              </button>
            </div>
          </div>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>{{ t('m_f5079b1a5842') }}</span>
            <input v-model="draftConfig.enabled" type="checkbox" />
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>{{ t('m_d736ef109829') }}</span>
            <span class="wb-backup-config-input">
              <BackupNumberInput v-model="draftConfig.intervalMinutes" :min="1" :aria-label="t('m_0b6164b73611')" />
              <em>{{ t('m_bd957bc497aa') }}</em>
            </span>
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>{{ t('m_4675c6ffb1cd') }}</span>
            <span class="wb-backup-config-input">
              <BackupNumberInput v-model="draftConfig.largeTableThreshold" :min="0" :aria-label="t('m_071ad1e6027c')" />
              <em>{{ t('m_b34873f22860') }}</em>
            </span>
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>{{ t('m_1a8ecd08a549') }}</span>
            <span class="wb-backup-config-input">
              <BackupNumberInput v-model="draftConfig.maxPerDb" :min="1" :aria-label="t('m_a2c28526a4fd')" />
              <em>{{ t('m_80d496aa8259') }}</em>
            </span>
          </label>
          <label class="wb-dialog-field wb-backup-config-field">
            <span>{{ t('m_73ee420285b4') }}</span>
            <span class="wb-backup-config-input">
              <BackupNumberInput v-model="draftConfig.auditRetentionDays" :min="1" :aria-label="t('m_a3ce04787765')" />
              <em>{{ t('m_49da61ceeea2') }}</em>
            </span>
          </label>
        </div>

        <aside class="wb-backup-hint"> {{ t('m_0d76d263a7c9') }} </aside>

        <footer class="wb-dialog-actions wb-backup-config-actions">
          <button type="button" class="wb-dialog-primary" :disabled="busy.savingConfig" @click="onSaveConfig">
            {{ busy.savingConfig ? t('m_ff509c9ba052') : t('m_c8550237ba70') }}
          </button>
        </footer>
      </div>
    </section>
  </div>
</template>
