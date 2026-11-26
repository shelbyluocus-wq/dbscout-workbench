<script setup>
import { computed, onMounted, ref, watch } from "vue";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Camera,
  CheckSquare,
  ChevronDown,
  Clock,
  Eraser,
  FileInput,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Table2,
  Trash2,
  X,
} from "lucide-vue-next";

import { t } from "../i18n/index.js";
import { tPlatform } from "../utils/platformLabels.js";
import { useAliases } from "../composables/aliasStore.js";
import { useConfirm } from "../composables/useConfirm.js";
import { formatBackupSize, formatBackupTimestamp } from "../utils/backupDisplay.js";
import { connectionHasCapability } from "../utils/connectionKinds.js";

const props = defineProps({
  backup: { type: Object, required: true },
  connections: { type: Array, default: () => [] },
  account: { type: Object, default: null },
});

// Filter changes are shared with the history tab, so the dialog owns reloading.
const emit = defineEmits(["connection-change", "database-change", "open-settings"]);

const { confirm, alert } = useConfirm();

const filters = computed(() => props.backup.filters);
const busy = computed(() => props.backup.busy);
const progress = computed(() => props.backup.progress);
const config = computed(() => props.backup.config.value || {});
const snapshots = computed(() => props.backup.snapshots.value || []);
const filterDatabases = computed(() => props.backup.filterDatabases.value || []);
const snapshotSource = computed(() => props.backup.snapshotSource || { mode: "local" });
const isServerSource = computed(() => snapshotSource.value.mode === "server");
const gmBackups = computed(() => props.backup.gmBackups);
const isLoggedIn = computed(() => Boolean(props.account?.isLoggedIn?.value));

const scopeOpen = ref(false);
const userPickedBackupDb = ref(false);

const { connectionLabel: resolveConnectionAlias } = useAliases();

function connectionLabel(connectionId) {
  const raw = props.connections.find((item) => item.id === connectionId)?.label || connectionId;
  return resolveConnectionAlias(connectionId, raw);
}

function currentError(fallback) {
  return props.backup.lastError.value || fallback;
}

function isConnectionSnapshotable(connectionId) {
  const connection = props.connections.find((item) => item.id === connectionId);
  return Boolean(
    connection &&
      !connection.readOnly &&
      connectionHasCapability(connection.kind, "snapshots"),
  );
}

function onConnectionFilterChange() {
  userPickedBackupDb.value = false;
  emit("connection-change");
}

function onDatabaseFilterChange() {
  userPickedBackupDb.value = false;
  emit("database-change");
}

// ---- 243 Server hourly backups ----------------------------------------------

const gmTargetReady = computed(() => Boolean(
  filters.value.connectionId
    && filters.value.database
    && isConnectionSnapshotable(filters.value.connectionId),
));

const gmTargetMissingMessage = computed(() => {
  if (!filters.value.connectionId || !filters.value.database) {
    return t("backup.gm.needsTarget");
  }
  if (!isConnectionSnapshotable(filters.value.connectionId)) {
    return t("backup.gm.unsupportedTarget");
  }
  return "";
});

const gmTargetDatabaseMatched = computed(() => {
  const target = String(filters.value.database || "").trim().toLowerCase();
  if (!target) return null;
  const list = gmBackups.value?.databases || [];
  return list.find((db) => String(db).toLowerCase() === target) || null;
});

const gmTargetDatabaseMissingFromServer = computed(() => Boolean(
  gmBackups.value?.status === "ok"
    && filters.value.database
    && gmBackups.value.databases.length > 0
    && !gmTargetDatabaseMatched.value,
));

async function syncGmBackupDatabaseFilterAndLoad({ forceReload = false } = {}) {
  if (!isServerSource.value) return;
  if (!gmBackups.value.loadedOnce || forceReload) {
    await props.backup.loadGmBackups({
      database: userPickedBackupDb.value ? gmBackups.value.databaseFilter : "",
      date: gmBackups.value.dateFilter,
    });
  }
  if (
    !userPickedBackupDb.value
    && gmBackups.value.status === "ok"
    && gmTargetDatabaseMatched.value
    && gmBackups.value.databaseFilter !== gmTargetDatabaseMatched.value
  ) {
    props.backup.setGmBackupFilters({ databaseFilter: gmTargetDatabaseMatched.value });
    await props.backup.loadGmBackups({
      database: gmTargetDatabaseMatched.value,
      date: gmBackups.value.dateFilter,
    });
  }
}

onMounted(() => {
  if (isServerSource.value) {
    syncGmBackupDatabaseFilterAndLoad();
  }
});

watch(
  () => [filters.value.database, isLoggedIn.value],
  ([, loggedIn], [, prevLoggedIn]) => {
    if (!isServerSource.value) return;
    if (loggedIn && !prevLoggedIn) {
      syncGmBackupDatabaseFilterAndLoad({ forceReload: true });
      return;
    }
    if (!userPickedBackupDb.value && gmBackups.value.status === "ok") {
      const matched = gmTargetDatabaseMatched.value || "";
      if (gmBackups.value.databaseFilter !== matched) {
        props.backup.setGmBackupFilters({ databaseFilter: matched });
        props.backup.loadGmBackups({ database: matched, date: gmBackups.value.dateFilter });
      }
    }
  },
);

function onSwitchSnapshotSource(mode) {
  props.backup.setSnapshotSource(mode);
  if (mode === "server") {
    syncGmBackupDatabaseFilterAndLoad();
  }
}

async function onGmDatabaseFilterChange(event) {
  userPickedBackupDb.value = true;
  const database = event.target.value;
  props.backup.setGmBackupFilters({ databaseFilter: database });
  props.backup.closeGmBackupTables();
  await props.backup.loadGmBackups({ database, date: gmBackups.value.dateFilter });
}

async function onGmDateFilterChange(event) {
  const date = event.target.value;
  props.backup.setGmBackupFilters({ dateFilter: date });
  props.backup.closeGmBackupTables();
  await props.backup.loadGmBackups({ database: gmBackups.value.databaseFilter, date });
}

async function onRefreshGmBackups() {
  await props.backup.loadGmBackups({
    database: gmBackups.value.databaseFilter,
    date: gmBackups.value.dateFilter,
  });
}

async function onOpenGmTables(item) {
  await props.backup.openGmBackupTables(item);
}

const filteredGmTables = computed(() => {
  const tables = gmBackups.value?.tables || [];
  const keyword = String(gmBackups.value?.tableSearch || "").trim().toLowerCase();
  if (!keyword) return tables;
  return tables.filter((table) => String(table.name || "").toLowerCase().includes(keyword));
});

const selectedGmTableSet = computed(() => new Set(gmBackups.value?.selectedTables || []));

function onSelectAllMatchedGmTables() {
  const merged = new Set(gmBackups.value?.selectedTables || []);
  for (const table of filteredGmTables.value) {
    merged.add(table.name);
  }
  props.backup.setGmSelectedTables([...merged]);
}

function onClearSelectedGmTables() {
  props.backup.setGmSelectedTables([]);
}

function formatTablePreview(tables) {
  if (tables.length <= 12) return tables.join("、");
  return `${tables.slice(0, 12).join("、")} ${t("backup.gm.moreTables", { count: tables.length })}`;
}

async function onRestoreGmSelectedTables() {
  const item = gmBackups.value?.activeBackup;
  const selected = gmBackups.value?.selectedTables || [];
  if (!item || !selected.length || !gmTargetReady.value || busy.value.restoring) return;
  const targetDb = filters.value.database;
  const targetConn = connectionLabel(filters.value.connectionId);
  const crossDb = item.database.toLowerCase() !== targetDb.toLowerCase()
    ? `\n\n${t("backup.gm.crossDbWarning", { source: item.database, target: targetDb })}`
    : "";
  const approved = await confirm({
    title: t("backup.gm.confirmTablesTitle", { count: selected.length, database: targetDb }),
    message: `${t("backup.gm.confirmTablesBody", {
      source: item.database,
      time: item.ts,
      connection: targetConn,
      database: targetDb,
      tables: formatTablePreview(selected),
    })}${crossDb}`,
    confirmText: t("backup.gm.confirmAction"),
    danger: true,
  });
  if (!approved) return;
  try {
    const result = await props.backup.restoreGmBackup({
      connectionId: filters.value.connectionId,
      database: targetDb,
      item,
      tables: selected,
    });
    await alert({
      title: t("backup.alert.restoreDoneTitle"),
      message: t("backup.gm.restoreTablesDone", {
        count: result?.restoredTables?.length || selected.length,
        database: targetDb,
        time: item.ts,
      }),
    });
  } catch (error) {
    await alert({
      title: t("backup.alert.restoreFailedTitle"),
      message: String(error?.message || error || t("backup.alert.restoreFailedTitle")),
    });
  }
}

async function onRestoreGmFullDatabase(item) {
  if (!item || !gmTargetReady.value || busy.value.restoring) return;
  const targetDb = filters.value.database;
  const targetConn = connectionLabel(filters.value.connectionId);
  const crossDb = item.database.toLowerCase() !== targetDb.toLowerCase()
    ? `\n\n${t("backup.gm.crossDbWarning", { source: item.database, target: targetDb })}`
    : "";
  const approved = await confirm({
    title: t("backup.gm.confirmFullTitle", { database: targetDb }),
    message: `${t("backup.gm.confirmFullBody", {
      source: item.database,
      time: item.ts,
      size: formatBackupSize(item.sizeBytes),
      connection: targetConn,
      database: targetDb,
    })}${crossDb}`,
    confirmText: t("backup.gm.confirmFullAction"),
    danger: true,
  });
  if (!approved) return;
  try {
    const result = await props.backup.restoreGmBackup({
      connectionId: filters.value.connectionId,
      database: targetDb,
      item,
      tables: [],
    });
    await alert({
      title: t("backup.alert.restoreDoneTitle"),
      message: t("backup.gm.restoreFullDone", {
        database: targetDb,
        count: result?.restoredTables?.length || 0,
        time: item.ts,
      }),
    });
  } catch (error) {
    await alert({
      title: t("backup.alert.restoreFailedTitle"),
      message: String(error?.message || error || t("backup.alert.restoreFailedTitle")),
    });
  }
}

// ---- Manual snapshot ---------------------------------------------------------
const snapshotTarget = computed(() => (
  filters.value.connectionId && filters.value.database ? filters.value.database : ""
));
const canCreateSnapshot = computed(() => Boolean(
  snapshotTarget.value
    && isConnectionSnapshotable(filters.value.connectionId)
    && !busy.value.snapshotting,
));

async function onCreateSnapshot() {
  if (!canCreateSnapshot.value) return;
  const database = snapshotTarget.value;
  try {
    await props.backup.createSnapshotFromFilters();
    await alert({ title: t("backup.alert.snapshotDoneTitle"), message: t("backup.alert.snapshotDone", { database }) });
  } catch (error) {
    await alert({ title: t("backup.alert.snapshotFailedTitle"), message: String(error?.message || error || t("backup.alert.snapshotFailedTitle")) });
  }
}

async function onPruneSnapshots() {
  const result = await props.backup.pruneSnapshots();
  const deletedCount = Number(result?.deletedCount || result?.deleted_count || 0);
  await alert({
    title: t("backup.alert.pruneTitle"),
    message: deletedCount > 0 ? t("backup.alert.pruneDone", { count: deletedCount }) : t("backup.alert.pruneNone"),
  });
}

const progressPercent = computed(() => {
  if (!progress.value.total) return 0;
  return Math.min(100, Math.round((progress.value.done / progress.value.total) * 100));
});

const progressStyle = computed(() => ({
  "--wb-backup-progress-scale": Math.max(0, Math.min(1, progressPercent.value / 100)),
}));

// ---- Local snapshot rows -----------------------------------------------------
function snapshotDetails(snapshot) {
  return {
    time: formatBackupTimestamp(snapshot.ts),
    database: snapshot.database,
    tables: snapshot.tableCount,
    size: formatBackupSize(snapshot.sizeBytes),
  };
}

async function onRestore(snapshot) {
  const approved = await confirm({
    title: t("backup.alert.restoreConfirmTitle", { database: snapshot.database }),
    message: t("backup.alert.restoreConfirm", snapshotDetails(snapshot)),
    confirmText: t("m_ddde08946298"),
    danger: true,
  });
  if (!approved) return;
  try {
    await props.backup.restoreSnapshot(snapshot.path, snapshot.connectionId);
    await alert({ title: t("backup.alert.restoreDoneTitle"), message: t("backup.alert.restoreDone", { database: snapshot.database }) });
  } catch (error) {
    await alert({ title: t("backup.alert.restoreFailedTitle"), message: String(error?.message || error || t("backup.alert.restoreFailedTitle")) });
  }
}

async function onDelete(snapshot) {
  const approved = await confirm({
    title: t("backup.alert.deleteConfirmTitle"),
    message: t("backup.alert.deleteConfirm", snapshotDetails(snapshot)),
    confirmText: t("m_2f9daa828907"),
    danger: true,
  });
  if (!approved) return;
  try {
    await props.backup.deleteSnapshot(snapshot.path);
    await alert({ title: t("backup.alert.deletedTitle"), message: t("backup.alert.deleted") });
  } catch (error) {
    await alert({ title: t("backup.alert.deleteFailedTitle"), message: String(error?.message || error || t("backup.alert.deleteFailedTitle")) });
  }
}

async function onOpenSnapshotFolder(snapshot) {
  const ok = await props.backup.openBackupPath(snapshot?.path);
  if (!ok) {
    await alert({ title: t("backup.alert.openFailedTitle"), message: currentError(t("backup.alert.openFailed")) });
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
    await alert({
      title: t("backup.alert.importDoneTitle"),
      message: t("backup.alert.importDone", { connection: connectionLabel(info.connectionId), database: info.database }),
    });
  } else if (props.backup.lastError.value) {
    await alert({ title: t("backup.alert.importFailedTitle"), message: props.backup.lastError.value });
  }
}
function onCancelImport() {
  props.backup.cancelImport();
}

// ---- Automatic snapshot scope ------------------------------------------------
const enableConnectionId = computed(() => filters.value.connectionId);

const selectedBackupDatabases = computed(() =>
  (config.value?.snapshotEnabledDatabases || [])
    .filter((item) => item.connectionId && item.database)
    .map(({ connectionId, database }) => ({
      connectionId,
      database,
      connectionLabel: connectionLabel(connectionId),
    })),
);
const selectedBackupCount = computed(() => selectedBackupDatabases.value.length);

const autoSummary = computed(() => {
  if (config.value.enabled === false) return t("backup.snapshot.autoOff");
  if (!selectedBackupCount.value) return t("m_1e8f5b7485b7");
  return t("backup.snapshot.autoSummary", {
    minutes: config.value.intervalMinutes ?? 30,
    count: selectedBackupCount.value,
  });
});
const autoState = computed(() => {
  if (config.value.enabled === false) return "off";
  return selectedBackupCount.value ? "on" : "empty";
});

async function onJumpToConnection(connectionId) {
  props.backup.setFilters({ connectionId, database: "" });
  emit("connection-change");
}

async function onToggleSnapshotEnabled(connectionId, database, enabled) {
  const ok = await props.backup.setSnapshotEnabled(connectionId, database, enabled);
  if (!ok) {
    await alert({ title: t("backup.alert.toggleFailedTitle"), message: currentError(t("backup.alert.toggleFailed")) });
  }
}
</script>

<template>
  <div class="wb-backup-snapshots-panel">
    <div class="wb-backup-source-bar">
      <div class="wb-backup-audit-mode" role="group" :aria-label="t('backup.gm.sourceSwitch')">
        <button
          type="button"
          :class="{ active: isServerSource }"
          :aria-pressed="isServerSource"
          :disabled="busy.restoring"
          @click="onSwitchSnapshotSource('server')"
        >{{ t('backup.gm.sourceServer') }}</button>
        <button
          type="button"
          :class="{ active: !isServerSource }"
          :aria-pressed="!isServerSource"
          :disabled="busy.restoring"
          @click="onSwitchSnapshotSource('local')"
        >{{ t('backup.gm.sourceLocal') }}</button>
      </div>
      <p v-if="isServerSource" class="wb-backup-source-hint">{{ t('backup.gm.sourceServerHint') }}</p>
      <div v-if="isServerSource" class="wb-backup-toolbar-actions">
        <button
          type="button"
          class="wb-backup-icon-text wb-backup-refresh"
          :class="{ spinning: gmBackups.loading }"
          :disabled="gmBackups.loading || busy.restoring"
          @click="onRefreshGmBackups"
        ><RefreshCw :size="14" aria-hidden="true" />{{ gmBackups.loading ? t('m_d302f90b0996') : t('m_aee887434131') }}</button>
      </div>
    </div>

    <div v-if="progress.active" class="wb-backup-progress-card" aria-live="polite">
      <p class="wb-backup-progress-text">
        {{ progress.message || t('backup.snapshot.progress', { done: progress.done, total: progress.total }) }}
      </p>
      <div
        class="wb-backup-progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="progressPercent"
        :style="progressStyle"
      >
        <span class="wb-backup-progress-fill"></span>
      </div>
    </div>

    <!-- ==================== 243 Server Hourly Backups ==================== -->
    <template v-if="isServerSource">
      <div class="wb-backup-toolbar wb-backup-gm-toolbar">
        <div class="wb-backup-filter-fields">
          <label class="wb-backup-filter">
            <span>{{ t('backup.gm.targetConnection') }}</span>
            <select v-model="filters.connectionId" :aria-label="t('backup.gm.targetConnection')" :disabled="busy.restoring" @change="onConnectionFilterChange">
              <option value="">{{ t('m_f85168b69fc0') }}</option>
              <option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
            </select>
          </label>
          <label class="wb-backup-filter">
            <span>{{ t('backup.gm.targetDatabase') }}</span>
            <select
              v-model="filters.database"
              :aria-label="t('backup.gm.targetDatabase')"
              :disabled="!filters.connectionId || busy.filterOptions || busy.restoring"
              @change="onDatabaseFilterChange"
            >
              <option value="">{{ t('m_916097b963aa') }}</option>
              <option v-for="database in filterDatabases" :key="database" :value="database">{{ database }}</option>
            </select>
          </label>
          <label v-if="gmBackups.status === 'ok'" class="wb-backup-filter">
            <span>{{ t('backup.gm.backupDbFilter') }}</span>
            <select
              :value="gmBackups.databaseFilter"
              :aria-label="t('backup.gm.backupDbFilter')"
              :disabled="gmBackups.loading || busy.restoring"
              @change="onGmDatabaseFilterChange"
            >
              <option value="">{{ t('backup.gm.allBackupDbs') }}</option>
              <option v-for="db in gmBackups.databases" :key="db" :value="db">{{ db }}</option>
            </select>
          </label>
          <label v-if="gmBackups.status === 'ok'" class="wb-backup-filter">
            <span>{{ t('backup.gm.dateFilter') }}</span>
            <select
              :value="gmBackups.dateFilter"
              :aria-label="t('backup.gm.dateFilter')"
              :disabled="gmBackups.loading || busy.restoring"
              @change="onGmDateFilterChange"
            >
              <option value="">{{ t('backup.gm.allDates') }}</option>
              <option v-for="d in gmBackups.dates" :key="d" :value="d">{{ d }}</option>
            </select>
          </label>
        </div>
      </div>

      <div v-if="gmTargetMissingMessage && gmBackups.status === 'ok'" class="wb-backup-gm-notice" role="status">
        <AlertTriangle :size="15" aria-hidden="true" />
        <span>{{ gmTargetMissingMessage }}</span>
      </div>

      <div v-if="gmTargetDatabaseMissingFromServer && !gmBackups.activeBackup" class="wb-backup-gm-notice" role="status">
        <AlertTriangle :size="15" aria-hidden="true" />
        <span>{{ t('backup.gm.dbNotBackedUpNotice', { database: filters.database, available: gmBackups.databases.join('、') }) }}</span>
      </div>

      <!-- Status / empty gates -->
      <div
        v-if="gmBackups.status === 'logged_out' || gmBackups.status === 'unauthorized' || gmBackups.status === 'not_configured'"
        class="wb-backup-empty"
        role="status"
      >
        <Server :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
        <strong>{{ t('backup.gm.needsLoginTitle') }}</strong>
        <span>{{ gmBackups.error || t('backup.gm.needsLoginDesc') }}</span>
        <button type="button" class="wb-dialog-primary" @click="emit('open-settings')">{{ t('backup.gm.goSettings') }}</button>
      </div>

      <div v-else-if="gmBackups.status === 'unsupported_server'" class="wb-backup-empty" role="status">
        <Server :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
        <strong>{{ t('backup.gm.unsupportedServerTitle') }}</strong>
        <span>{{ t('backup.gm.unsupportedServerDesc') }}</span>
        <button type="button" @click="onRefreshGmBackups">{{ t('backup.gm.retry') }}</button>
      </div>

      <div v-else-if="gmBackups.status === 'disabled'" class="wb-backup-empty" role="status">
        <Server :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
        <strong>{{ t('backup.gm.disabledTitle') }}</strong>
        <span>{{ t('backup.gm.disabledDesc') }}</span>
      </div>

      <div v-else-if="gmBackups.status === 'unreachable'" class="wb-backup-empty" role="status">
        <Server :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
        <strong>{{ t('backup.gm.unreachableTitle') }}</strong>
        <span>{{ gmBackups.error || t('backup.gm.unreachableDesc') }}</span>
        <button type="button" @click="onRefreshGmBackups">{{ t('backup.gm.retry') }}</button>
      </div>

      <!-- Table picker drill-down view for one selected backup -->
      <section v-else-if="gmBackups.activeBackup" class="wb-backup-gm-picker" :aria-label="t('backup.gm.pickTablesTitle')">
        <div class="wb-backup-gm-picker-head">
          <button
            type="button"
            class="wb-backup-action-btn wb-backup-icon-text"
            :disabled="busy.restoring"
            @click="backup.closeGmBackupTables()"
          ><ArrowLeft :size="14" aria-hidden="true" />{{ t('backup.gm.backToList') }}</button>
          <div class="wb-backup-gm-picker-title">
            <strong>{{ gmBackups.activeBackup.database }} · {{ gmBackups.activeBackup.ts }}</strong>
            <span>{{ t('backup.gm.pickerSummary', { total: gmBackups.tables.length, size: formatBackupSize(gmBackups.activeBackup.sizeBytes) }) }}</span>
          </div>
        </div>

        <div class="wb-backup-gm-picker-controls">
          <label class="wb-backup-gm-search">
            <Search :size="14" aria-hidden="true" />
            <input
              v-model="gmBackups.tableSearch"
              type="search"
              :placeholder="t('backup.gm.searchTablePlaceholder')"
              :aria-label="t('backup.gm.searchTablePlaceholder')"
              :disabled="gmBackups.tablesLoading || busy.restoring"
            />
          </label>
          <div class="wb-backup-gm-picker-bulk">
            <button
              type="button"
              class="wb-backup-action-btn"
              :disabled="gmBackups.tablesLoading || !filteredGmTables.length || busy.restoring"
              @click="onSelectAllMatchedGmTables"
            >{{ t('backup.gm.selectMatched', { count: filteredGmTables.length }) }}</button>
            <button
              type="button"
              class="wb-backup-action-btn"
              :disabled="!gmBackups.selectedTables.length || busy.restoring"
              @click="onClearSelectedGmTables"
            >{{ t('backup.gm.clearSelection') }}</button>
          </div>
        </div>

        <div v-if="gmBackups.tablesLoading" class="wb-backup-empty" role="status">
          <strong>{{ t('backup.gm.loadingTables') }}</strong>
          <span>{{ t('backup.gm.loadingTablesDesc') }}</span>
        </div>
        <div v-else-if="gmBackups.tablesError" class="wb-backup-empty" role="status">
          <strong>{{ t('backup.gm.tablesFailedTitle') }}</strong>
          <span>{{ gmBackups.tablesError }}</span>
          <button type="button" @click="onOpenGmTables(gmBackups.activeBackup)">{{ t('backup.gm.retry') }}</button>
        </div>
        <div v-else-if="!filteredGmTables.length" class="wb-backup-empty" role="status">
          <strong>{{ t('backup.gm.noMatchingTables') }}</strong>
        </div>
        <div v-else class="wb-backup-gm-table-grid">
          <label
            v-for="table in filteredGmTables"
            :key="table.name"
            class="wb-backup-gm-table-item"
            :class="{ selected: selectedGmTableSet.has(table.name) }"
          >
            <input
              type="checkbox"
              :checked="selectedGmTableSet.has(table.name)"
              :disabled="busy.restoring"
              @change="backup.toggleGmBackupTable(table.name)"
            />
            <span class="wb-backup-gm-table-name" :title="table.name">{{ table.name }}</span>
            <span v-if="!table.hasData" class="wb-backup-gm-table-tag">{{ t('backup.gm.emptyTableTag') }}</span>
            <span v-else class="wb-backup-gm-table-size">{{ formatBackupSize(table.approxBytes) }}</span>
          </label>
        </div>

        <footer class="wb-backup-gm-picker-footer">
          <div class="wb-backup-gm-picker-target">
            <span>{{ t('backup.gm.selectedCount', { count: gmBackups.selectedTables.length }) }}</span>
            <span v-if="gmTargetReady" class="wb-backup-meta">
              → {{ connectionLabel(filters.connectionId) }} / {{ filters.database }}
            </span>
          </div>
          <button
            type="button"
            class="wb-dialog-primary wb-backup-icon-text"
            :disabled="!gmTargetReady || !gmBackups.selectedTables.length || busy.restoring"
            :title="gmTargetMissingMessage"
            @click="onRestoreGmSelectedTables"
          >
            <CheckSquare :size="14" aria-hidden="true" />
            {{ busy.restoring ? t('m_7398723bff4f') : t('backup.gm.restoreSelectedBtn', { count: gmBackups.selectedTables.length }) }}
          </button>
        </footer>
      </section>

      <!-- Backup file list -->
      <section v-else class="wb-backup-snapshot-section" :aria-label="t('backup.gm.listLabel')">
        <div class="wb-backup-list-header">
          <strong>{{ t('backup.gm.listLabel') }}</strong>
          <span class="wb-backup-count" :data-empty="gmBackups.items.length === 0">{{ gmBackups.items.length }}</span>
        </div>

        <div class="wb-backup-list wb-backup-snapshots">
          <div v-if="gmBackups.loading && !gmBackups.items.length" class="wb-backup-empty" role="status">
            <strong>{{ t('backup.gm.loadingList') }}</strong>
          </div>
          <div v-else-if="!gmBackups.items.length" class="wb-backup-empty" role="status">
            <Server :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
            <strong>{{ t('backup.gm.emptyTitle') }}</strong>
            <span>{{ t('backup.gm.emptyDesc') }}</span>
          </div>
          <article
            v-for="item in gmBackups.items"
            :key="`${item.date}/${item.hour}/${item.fileName}`"
            class="wb-backup-snapshot-row"
          >
            <span class="wb-backup-snapshot-icon"><Server :size="16" aria-hidden="true" /></span>
            <div class="wb-backup-snapshot-main">
              <div class="wb-backup-snapshot-title">
                <strong class="wb-backup-snapshot-db">{{ item.database }}</strong>
                <span class="wb-backup-chip">{{ item.host }}</span>
              </div>
              <span class="wb-backup-meta">
                {{ formatBackupSize(item.sizeBytes) }} · {{ item.fileName }}
              </span>
            </div>
            <time class="wb-backup-ts" :datetime="item.ts">{{ item.ts }}</time>
            <div class="wb-backup-row-actions">
              <button
                type="button"
                class="wb-dialog-primary wb-backup-action-btn wb-backup-icon-text"
                :disabled="busy.restoring"
                @click="onOpenGmTables(item)"
              ><Table2 :size="14" aria-hidden="true" />{{ t('backup.gm.pickTablesBtn') }}</button>
              <button
                type="button"
                class="wb-backup-action-btn wb-backup-action-danger wb-backup-icon-text"
                :disabled="!gmTargetReady || busy.restoring"
                :title="gmTargetMissingMessage"
                @click="onRestoreGmFullDatabase(item)"
              ><RotateCcw :size="14" aria-hidden="true" />{{ t('backup.gm.restoreFullBtn') }}</button>
            </div>
          </article>
        </div>
      </section>
    </template>

    <!-- ==================== Local Snapshots ==================== -->
    <template v-else>
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
          <button type="button" class="wb-backup-icon-text" :disabled="busy.inspecting || busy.importing" @click="onImportSnapshot">
            <FileInput :size="14" aria-hidden="true" />{{ busy.inspecting ? t('m_29d75b8eb886') : t('m_b11bb27929db') }}
          </button>
          <button type="button" class="wb-backup-icon-text" :disabled="busy.snapshotting || busy.restoring || busy.pruning" @click="onPruneSnapshots">
            <Eraser :size="14" aria-hidden="true" />{{ busy.pruning ? t('m_248e8cfc2116') : t('m_855f69b1a700') }}
          </button>
          <button
            type="button"
            class="wb-dialog-primary wb-backup-icon-text"
            :disabled="!canCreateSnapshot"
            :title="snapshotTarget ? '' : t('backup.snapshot.createNeedsTarget')"
            @click="onCreateSnapshot"
          >
            <Camera :size="14" aria-hidden="true" />
            <template v-if="busy.snapshotting">{{ t('m_59f718698ac4') }}</template>
            <template v-else-if="snapshotTarget">{{ t('backup.snapshot.createFor', { database: snapshotTarget }) }}</template>
            <template v-else>{{ t('m_57d83fa495ec') }}</template>
          </button>
        </div>
      </div>

      <section v-if="importHasDraft" class="wb-backup-import" :aria-label="t('m_b7641d80b645')">
        <div class="wb-backup-import-head">
          <FileInput :size="16" aria-hidden="true" />
          <strong>{{ t('m_b7641d80b645') }}</strong>
          <span class="wb-backup-import-file" :title="importDraft.sourcePath">
            {{ importDraft.fileName }} · {{ formatBackupSize(importDraft.sizeBytes) }}
          </span>
        </div>
        <p v-if="importDraft.originConnectionId" class="wb-backup-import-origin">
          {{ t('m_7b032a06750e') }}{{ importDraft.originConnectionId }} / {{ importDraft.originDatabase }}<template v-if="importDraft.originTs"> · {{ formatBackupTimestamp(importDraft.originTs) }}</template>
        </p>
        <p v-else class="wb-backup-import-origin">{{ t('m_4c3966f740be') }}</p>
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
            <button type="button" :disabled="busy.importing" @click="onCancelImport">{{ t('m_2cd0f3be8738') }}</button>
            <button type="button" class="wb-dialog-primary" :disabled="!importCanConfirm" @click="onConfirmImport">
              {{ busy.importing ? t('m_2f58b6eddc08') : t('m_576d81bb0631') }}
            </button>
          </div>
        </div>
      </section>

      <section class="wb-backup-auto" :class="{ open: scopeOpen }" :data-state="autoState" :aria-label="t('m_17f4ce2edaf4')">
        <div class="wb-backup-auto-bar">
          <span class="wb-backup-auto-icon"><Clock :size="16" aria-hidden="true" /></span>
          <div class="wb-backup-auto-text">
            <strong>{{ t('backup.snapshot.autoTitle') }}</strong>
            <button v-if="autoState === 'off'" type="button" class="wb-backup-link" @click="emit('open-settings')">{{ autoSummary }}</button>
            <span v-else>{{ autoSummary }}</span>
          </div>
          <button
            type="button"
            class="wb-backup-auto-toggle"
            :aria-expanded="scopeOpen"
            aria-controls="wb-backup-snapshot-scope"
            @click="scopeOpen = !scopeOpen"
          >
            {{ scopeOpen ? t('backup.snapshot.hideScope') : t('backup.snapshot.manage') }}
            <ChevronDown :size="14" aria-hidden="true" class="wb-backup-chevron" />
          </button>
        </div>

        <div v-if="scopeOpen" id="wb-backup-snapshot-scope" class="wb-backup-snapshot-layout">
          <section class="wb-backup-enable-panel" :aria-label="t('m_f1d1e541f7ad')">
            <div class="wb-backup-enable-head">
              <div class="wb-backup-enable-head-text">
                <strong>{{ t('m_f1d1e541f7ad') }}</strong>
                <p>{{ t('m_a7b230525d19') }}</p>
              </div>
            </div>

            <div class="wb-backup-enable-list">
              <div v-if="!enableConnectionId" class="wb-backup-enable-empty">
                <strong>{{ t('m_1020f3cc2c1b') }}</strong>
                <span>{{ t('m_db845ade9920') }}</span>
              </div>
              <div v-else-if="busy.filterOptions" class="wb-backup-enable-empty">{{ t('m_ce0c5d040535') }}</div>
              <div v-else-if="!filterDatabases.length" class="wb-backup-enable-empty">{{ t('m_03e09d05c0fa') }}</div>
              <label
                v-for="database in filterDatabases"
                :key="database"
                class="wb-backup-enable-row"
                :class="{ disabled: !isConnectionSnapshotable(enableConnectionId) }"
              >
                <input
                  type="checkbox"
                  class="wb-backup-switch"
                  role="switch"
                  :checked="backup.isSnapshotEnabled(enableConnectionId, database)"
                  :disabled="busy.togglingDb || !isConnectionSnapshotable(enableConnectionId)"
                  @change="onToggleSnapshotEnabled(enableConnectionId, database, $event.target.checked)"
                />
                <span class="wb-backup-enable-name">{{ database }}</span>
                <span
                  v-if="!isConnectionSnapshotable(enableConnectionId)"
                  class="wb-backup-enable-tag"
                  data-state="unsupported"
                >{{ t('backup.snapshot.state.unsupported') }}</span>
              </label>
            </div>
          </section>

          <section class="wb-backup-selected-panel" :aria-label="t('m_132899150376')">
            <div class="wb-backup-selected-head">
              <div class="wb-backup-selected-head-text">
                <strong>{{ t('m_132899150376') }}</strong>
                <p>{{ t('m_e6c122e54ca9') }}</p>
              </div>
              <span class="wb-backup-count" :data-empty="selectedBackupCount === 0">{{ selectedBackupCount }}</span>
            </div>

            <div class="wb-backup-selected-list">
              <div v-if="!selectedBackupCount" class="wb-backup-selected-empty" role="status">
                <strong>{{ t('m_1e8f5b7485b7') }}</strong>
                <span>{{ t('m_2df96d2c5450') }}</span>
              </div>
              <div
                v-for="item in selectedBackupDatabases"
                :key="`${item.connectionId}/${item.database}`"
                class="wb-backup-selected-row"
              >
                <button
                  type="button"
                  class="wb-backup-selected-info"
                  :title="t('backup.snapshot.jumpTo', { connection: item.connectionLabel })"
                  @click="onJumpToConnection(item.connectionId)"
                >
                  <span class="wb-backup-selected-conn">{{ item.connectionLabel }}</span>
                  <span class="wb-backup-selected-db">{{ item.database }}</span>
                </button>
                <button
                  type="button"
                  class="wb-backup-selected-remove"
                  :disabled="busy.togglingDb"
                  :title="t('m_93d5cb2bb76e')"
                  :aria-label="t('m_93d5cb2bb76e')"
                  @click="onToggleSnapshotEnabled(item.connectionId, item.database, false)"
                ><X :size="14" aria-hidden="true" /></button>
              </div>
            </div>
          </section>
        </div>
      </section>

      <section class="wb-backup-snapshot-section" :aria-label="t('m_6c534bd7e43f')">
        <div class="wb-backup-list-header">
          <strong>{{ t('m_6c534bd7e43f') }}</strong>
        </div>

        <div class="wb-backup-list wb-backup-snapshots">
          <div v-if="!snapshots.length" class="wb-backup-empty" role="status">
            <Archive :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
            <strong>{{ t('m_cf028e868970') }}</strong>
            <span>{{ t('m_e990ba921088') }}</span>
          </div>
          <article v-for="snapshot in snapshots" :key="snapshot.path" class="wb-backup-snapshot-row">
            <span class="wb-backup-snapshot-icon"><Archive :size="16" aria-hidden="true" /></span>
            <div class="wb-backup-snapshot-main">
              <div class="wb-backup-snapshot-title">
                <strong class="wb-backup-snapshot-db">{{ snapshot.database }}</strong>
                <span v-if="snapshot.location === 'legacy'" class="wb-backup-loc-tag">{{ t('m_81472bc14c2b') }}</span>
              </div>
              <span class="wb-backup-meta">
                {{ connectionLabel(snapshot.connectionId) }} · {{ t('backup.snapshot.tables', { count: snapshot.tableCount }) }} · {{ formatBackupSize(snapshot.sizeBytes) }}
              </span>
            </div>
            <time class="wb-backup-ts" :datetime="snapshot.ts">{{ formatBackupTimestamp(snapshot.ts) }}</time>
            <div class="wb-backup-row-actions">
              <button
                type="button"
                class="wb-backup-action-btn wb-backup-icon-text"
                :disabled="busy.openingPath"
                @click="onOpenSnapshotFolder(snapshot)"
              ><FolderOpen :size="14" aria-hidden="true" />{{ tPlatform('m_4b4d6c35f5f7') }}</button>
              <button
                type="button"
                class="wb-backup-action-btn wb-backup-icon-text"
                :disabled="busy.restoring || busy.deleting"
                @click="onRestore(snapshot)"
              ><RotateCcw :size="14" aria-hidden="true" />{{ busy.restoring ? t('m_7398723bff4f') : t('m_ddde08946298') }}</button>
              <button
                type="button"
                class="wb-backup-action-btn wb-backup-action-danger wb-backup-icon-only"
                :disabled="busy.restoring || busy.deleting"
                :title="t('m_2f9daa828907')"
                :aria-label="t('m_2f9daa828907')"
                @click="onDelete(snapshot)"
              ><Trash2 :size="14" aria-hidden="true" /></button>
            </div>
          </article>
        </div>
      </section>
    </template>
  </div>
</template>
