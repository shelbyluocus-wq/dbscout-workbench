<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  AlertTriangle,
  ArrowLeft,
  CheckSquare,
  Clock,
  History,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Table2,
} from "lucide-vue-next";

import { t } from "../i18n/index.js";
import { useAliases } from "../composables/aliasStore.js";
import { useConfirm } from "../composables/useConfirm.js";
import { formatBackupSize } from "../utils/backupDisplay.js";
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
const filterDatabases = computed(() => props.backup.filterDatabases.value || []);
const gmBackups = computed(() => props.backup.gmBackups);
const gmTableBackups = computed(() => props.backup.gmTableBackups);
const viewMode = computed(() => props.backup.gmBackupViewMode?.mode || "hourly");
const isTableHistoryMode = computed(() => viewMode.value === "table-history");
const isLoggedIn = computed(() => Boolean(props.account?.isLoggedIn?.value));

const userPickedBackupDb = ref(false);
const userPickedTableBackupDb = ref(false);
let tableSearchTimer = null;

onBeforeUnmount(() => {
  if (tableSearchTimer) clearTimeout(tableSearchTimer);
});

const { connectionLabel: resolveConnectionAlias } = useAliases();

function connectionLabel(connectionId) {
  const raw = props.connections.find((item) => item.id === connectionId)?.label || connectionId;
  return resolveConnectionAlias(connectionId, raw);
}

function isConnectionRestorable(connectionId) {
  const connection = props.connections.find((item) => item.id === connectionId);
  return Boolean(
    connection &&
      !connection.readOnly &&
      connectionHasCapability(connection.kind, "snapshots"),
  );
}

function onConnectionFilterChange() {
  userPickedBackupDb.value = false;
  userPickedTableBackupDb.value = false;
  emit("connection-change");
}

function onDatabaseFilterChange() {
  userPickedBackupDb.value = false;
  userPickedTableBackupDb.value = false;
  emit("database-change");
}

function switchViewMode(mode) {
  if (viewMode.value === mode) return;
  props.backup.setGmBackupViewMode(mode);
  if (mode === "table-history") {
    void syncGmTableBackupFilterAndLoad();
  } else {
    void syncGmBackupDatabaseFilterAndLoad();
  }
}

// ---- Shared status gates & target readiness ---------------------------------

const activeStatus = computed(() => (
  isTableHistoryMode.value ? gmTableBackups.value?.status : gmBackups.value?.status
));

const activeError = computed(() => (
  isTableHistoryMode.value ? gmTableBackups.value?.error : gmBackups.value?.error
));

const activeLoading = computed(() => (
  isTableHistoryMode.value ? Boolean(gmTableBackups.value?.loading) : Boolean(gmBackups.value?.loading)
));

const gmTargetReady = computed(() => Boolean(
  filters.value.connectionId
    && filters.value.database
    && isConnectionRestorable(filters.value.connectionId),
));

const gmTargetMissingMessage = computed(() => {
  if (!filters.value.connectionId || !filters.value.database) {
    return t("backup.gm.needsTarget");
  }
  if (!isConnectionRestorable(filters.value.connectionId)) {
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

const gmTableTargetDatabaseMatched = computed(() => {
  const target = String(filters.value.database || "").trim().toLowerCase();
  if (!target) return null;
  const list = gmTableBackups.value?.databases || [];
  return list.find((db) => String(db).toLowerCase() === target) || null;
});

const gmTargetDatabaseMissingFromServer = computed(() => Boolean(
  !isTableHistoryMode.value
    && gmBackups.value?.status === "ok"
    && filters.value.database
    && gmBackups.value.databases.length > 0
    && !gmTargetDatabaseMatched.value,
));

async function syncGmBackupDatabaseFilterAndLoad({ forceReload = false } = {}) {
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

async function syncGmTableBackupFilterAndLoad({ forceReload = false } = {}) {
  if (!gmTableBackups.value) return;
  if (!gmTableBackups.value.loadedOnce || forceReload) {
    await props.backup.loadGmTableBackups({
      database: userPickedTableBackupDb.value ? gmTableBackups.value.databaseFilter : gmTableBackups.value.databaseFilter,
      search: gmTableBackups.value.search,
      includeDeleted: gmTableBackups.value.includeDeleted,
    });
  }
  if (
    !userPickedTableBackupDb.value
    && !gmTableBackups.value.activeTable
    && !gmTableBackups.value.search
    && gmTableBackups.value.status === "ok"
    && gmTableTargetDatabaseMatched.value
    && gmTableBackups.value.databaseFilter !== gmTableTargetDatabaseMatched.value
  ) {
    props.backup.setGmTableBackupFilters({ databaseFilter: gmTableTargetDatabaseMatched.value });
    await props.backup.loadGmTableBackups({
      database: gmTableTargetDatabaseMatched.value,
      search: gmTableBackups.value.search,
      includeDeleted: gmTableBackups.value.includeDeleted,
    });
  }
}

onMounted(() => {
  const status = activeStatus.value;
  const needsAuthReload = isLoggedIn.value
    && (status === "logged_out" || status === "unauthorized" || status === "not_configured");
  if (isTableHistoryMode.value) {
    void syncGmTableBackupFilterAndLoad({ forceReload: needsAuthReload });
  } else {
    void syncGmBackupDatabaseFilterAndLoad({ forceReload: needsAuthReload });
  }
});

watch(
  () => [filters.value.database, isLoggedIn.value],
  ([, loggedIn], [, prevLoggedIn]) => {
    if (loggedIn && !prevLoggedIn) {
      if (isTableHistoryMode.value) {
        void syncGmTableBackupFilterAndLoad({ forceReload: true });
      } else {
        void syncGmBackupDatabaseFilterAndLoad({ forceReload: true });
      }
      return;
    }
    if (isTableHistoryMode.value) {
      if (!userPickedTableBackupDb.value && !gmTableBackups.value?.activeTable && gmTableBackups.value?.status === "ok") {
        const matched = gmTableTargetDatabaseMatched.value || "";
        if (gmTableBackups.value.databaseFilter !== matched) {
          props.backup.setGmTableBackupFilters({ databaseFilter: matched });
          void props.backup.loadGmTableBackups({
            database: matched,
            search: gmTableBackups.value.search,
            includeDeleted: gmTableBackups.value.includeDeleted,
          });
        }
      }
      return;
    }
    if (!userPickedBackupDb.value && gmBackups.value.status === "ok") {
      const matched = gmTargetDatabaseMatched.value || "";
      if (gmBackups.value.databaseFilter !== matched) {
        props.backup.setGmBackupFilters({ databaseFilter: matched });
        void props.backup.loadGmBackups({ database: matched, date: gmBackups.value.dateFilter });
      }
    }
  },
);

// ---- Hourly backup actions --------------------------------------------------

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

async function onRefreshActiveView() {
  if (isTableHistoryMode.value) {
    await props.backup.loadGmTableBackups({
      database: gmTableBackups.value.databaseFilter,
      search: gmTableBackups.value.search,
      includeDeleted: gmTableBackups.value.includeDeleted,
    });
    if (gmTableBackups.value.activeTable) {
      await props.backup.openGmTableBackupVersions(gmTableBackups.value.activeTable);
    }
    return;
  }
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

// ---- Per-table 60-change backup actions -------------------------------------

async function onTableBackupDbChange(event) {
  userPickedTableBackupDb.value = true;
  const database = event.target.value;
  props.backup.setGmTableBackupFilters({ databaseFilter: database });
  props.backup.closeGmTableBackupVersions();
  await props.backup.loadGmTableBackups({
    database,
    search: gmTableBackups.value.search,
    includeDeleted: gmTableBackups.value.includeDeleted,
  });
}

function onTableBackupSearchInput(event) {
  const search = event.target.value;
  props.backup.setGmTableBackupFilters({ search });
  if (tableSearchTimer) clearTimeout(tableSearchTimer);
  tableSearchTimer = setTimeout(() => {
    void props.backup.loadGmTableBackups({
      database: gmTableBackups.value.databaseFilter,
      search,
      includeDeleted: gmTableBackups.value.includeDeleted,
    });
  }, 180);
}

async function onTableBackupIncludeDeletedChange(event) {
  const includeDeleted = Boolean(event.target.checked);
  props.backup.setGmTableBackupFilters({ includeDeleted });
  await props.backup.loadGmTableBackups({
    database: gmTableBackups.value.databaseFilter,
    search: gmTableBackups.value.search,
    includeDeleted,
  });
}

async function onRunTableBackupScan() {
  if (gmTableBackups.value.runningScan || busy.value.restoring) return;
  try {
    const res = await props.backup.runGmTableBackupsNow();
    if (!res) return;
    await alert({
      title: t("backup.gm.tableHistory.scanDoneTitle"),
      message: t("backup.gm.tableHistory.scanDoneBody", {
        databases: res.databasesScanned ?? 0,
        tables: res.tablesScanned ?? 0,
        changed: res.tablesChanged ?? 0,
      }),
    });
  } catch (error) {
    await alert({
      title: t("backup.gm.tableHistory.scanFailedTitle"),
      message: String(error?.message || error || t("backup.gm.tableHistory.scanFailedTitle")),
    });
  }
}

async function onRestoreGmTableVersion(version) {
  const active = gmTableBackups.value?.activeTable;
  if (!active || !version || !gmTargetReady.value || busy.value.restoring) return;
  const targetDb = filters.value.database;
  const targetConn = connectionLabel(filters.value.connectionId);
  const crossDb = active.database.toLowerCase() !== targetDb.toLowerCase()
    ? `\n\n${t("backup.gm.crossDbWarning", { source: active.database, target: targetDb })}`
    : "";
  const approved = await confirm({
    title: t("backup.gm.tableHistory.confirmRestoreTitle", { table: active.tableName, database: targetDb }),
    message: `${t("backup.gm.tableHistory.confirmRestoreBody", {
      source: active.database,
      table: active.tableName,
      time: version.backupTs,
      connection: targetConn,
      database: targetDb,
    })}${crossDb}`,
    confirmText: t("backup.gm.confirmAction"),
    danger: true,
  });
  if (!approved) return;
  try {
    await props.backup.restoreGmTableBackup({
      connectionId: filters.value.connectionId,
      database: targetDb,
      sourceDatabase: active.database,
      tableName: active.tableName,
      versionId: version.versionId,
    });
    await alert({
      title: t("backup.alert.restoreDoneTitle"),
      message: t("backup.gm.tableHistory.restoreDone", {
        table: active.tableName,
        database: targetDb,
        time: version.backupTs,
      }),
    });
  } catch (error) {
    await alert({
      title: t("backup.alert.restoreFailedTitle"),
      message: String(error?.message || error || t("backup.alert.restoreFailedTitle")),
    });
  }
}

const progressPercent = computed(() => {
  if (!progress.value.total) return 0;
  return Math.min(100, Math.round((progress.value.done / progress.value.total) * 100));
});

const progressStyle = computed(() => ({
  "--wb-backup-progress-scale": Math.max(0, Math.min(1, progressPercent.value / 100)),
}));
</script>

<template>
  <div class="wb-backup-snapshots-panel">
    <div class="wb-backup-source-bar">
      <div class="wb-backup-gm-mode-switch" role="tablist" :aria-label="t('backup.gm.modeSwitchAria')">
        <button
          type="button"
          role="tab"
          :class="{ active: !isTableHistoryMode }"
          :aria-selected="!isTableHistoryMode"
          :disabled="busy.restoring"
          @click="switchViewMode('hourly')"
        ><Clock :size="13" aria-hidden="true" />{{ t('backup.gm.modeHourly') }}</button>
        <button
          type="button"
          role="tab"
          :class="{ active: isTableHistoryMode }"
          :aria-selected="isTableHistoryMode"
          :disabled="busy.restoring"
          @click="switchViewMode('table-history')"
        ><History :size="13" aria-hidden="true" />{{ t('backup.gm.modeTableHistory', { max: gmTableBackups.maxVersions || 60 }) }}</button>
      </div>
      <p class="wb-backup-source-hint">
        {{ isTableHistoryMode ? t('backup.gm.tableHistory.sourceHint', { max: gmTableBackups.maxVersions || 60 }) : t('backup.gm.sourceServerHint') }}
      </p>
      <div class="wb-backup-toolbar-actions">
        <button
          v-if="isTableHistoryMode && gmTableBackups.status === 'ok'"
          type="button"
          class="wb-backup-icon-text"
          :disabled="gmTableBackups.runningScan || gmTableBackups.loading || busy.restoring"
          :title="t('backup.gm.tableHistory.scanNowTitle')"
          @click="onRunTableBackupScan"
        ><Play :size="13" aria-hidden="true" />{{ gmTableBackups.runningScan ? t('backup.gm.tableHistory.scanning') : t('backup.gm.tableHistory.scanNow') }}</button>
        <button
          type="button"
          class="wb-backup-icon-text wb-backup-refresh"
          :class="{ spinning: activeLoading }"
          :disabled="activeLoading || busy.restoring"
          @click="onRefreshActiveView"
        ><RefreshCw :size="14" aria-hidden="true" />{{ activeLoading ? t('m_d302f90b0996') : t('m_aee887434131') }}</button>
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

    <div class="wb-backup-toolbar wb-backup-snapshot-toolbar wb-backup-gm-toolbar">
      <div class="wb-backup-filter-fields">
        <label class="wb-backup-filter">
          <span>{{ t('backup.gm.targetConnection') }}</span>
          <select
            v-model="filters.connectionId"
            :aria-label="t('backup.gm.targetConnection')"
            :title="connections.find((item) => item.id === filters.connectionId)?.label || ''"
            :disabled="busy.restoring"
            @change="onConnectionFilterChange"
          >
            <option value="">{{ t('m_f85168b69fc0') }}</option>
            <option
              v-for="connection in connections"
              :key="connection.id"
              :value="connection.id"
              :title="connection.label"
            >{{ resolveConnectionAlias(connection.id, connection.label) }}</option>
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

        <template v-if="!isTableHistoryMode && gmBackups.status === 'ok'">
          <label class="wb-backup-filter">
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
          <label class="wb-backup-filter">
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
        </template>

        <template v-else-if="isTableHistoryMode && gmTableBackups.status === 'ok'">
          <label class="wb-backup-filter">
            <span>{{ t('backup.gm.backupDbFilter') }}</span>
            <select
              :value="gmTableBackups.databaseFilter"
              :aria-label="t('backup.gm.backupDbFilter')"
              :disabled="gmTableBackups.loading || busy.restoring"
              @change="onTableBackupDbChange"
            >
              <option value="">{{ t('backup.gm.allBackupDbs') }}</option>
              <option v-for="db in gmTableBackups.databases" :key="db" :value="db">{{ db }}</option>
            </select>
          </label>
          <label class="wb-backup-gm-search wb-backup-gm-table-search">
            <Search :size="14" aria-hidden="true" />
            <input
              :value="gmTableBackups.search"
              type="search"
              :placeholder="t('backup.gm.searchTablePlaceholder')"
              :aria-label="t('backup.gm.searchTablePlaceholder')"
              :disabled="busy.restoring"
              @input="onTableBackupSearchInput"
            />
          </label>
          <label class="wb-backup-gm-include-deleted">
            <input
              type="checkbox"
              :checked="gmTableBackups.includeDeleted"
              :disabled="gmTableBackups.loading || busy.restoring"
              @change="onTableBackupIncludeDeletedChange"
            />
            <span>{{ t('backup.gm.tableHistory.includeDeleted') }}</span>
          </label>
        </template>
      </div>
    </div>

    <div v-if="gmTargetMissingMessage && activeStatus === 'ok'" class="wb-backup-gm-notice" role="status">
      <AlertTriangle :size="15" aria-hidden="true" />
      <span>{{ gmTargetMissingMessage }}</span>
    </div>

    <div v-if="gmTargetDatabaseMissingFromServer && !gmBackups.activeBackup" class="wb-backup-gm-notice" role="status">
      <AlertTriangle :size="15" aria-hidden="true" />
      <span>{{ t('backup.gm.dbNotBackedUpNotice', { database: filters.database, available: gmBackups.databases.join('、') }) }}</span>
    </div>

    <!-- Shared status / empty gates -->
    <div
      v-if="activeStatus === 'logged_out' || activeStatus === 'unauthorized' || activeStatus === 'not_configured'"
      class="wb-backup-empty"
      role="status"
    >
      <Server :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
      <strong>{{ t('backup.gm.needsLoginTitle') }}</strong>
      <span>{{ activeError || t('backup.gm.needsLoginDesc') }}</span>
      <button type="button" class="wb-dialog-primary" @click="emit('open-settings')">{{ t('backup.gm.goSettings') }}</button>
    </div>

    <div v-else-if="activeStatus === 'unsupported_server'" class="wb-backup-empty" role="status">
      <Server :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
      <strong>{{ t('backup.gm.unsupportedServerTitle') }}</strong>
      <span>{{ t('backup.gm.unsupportedServerDesc') }}</span>
      <button type="button" @click="onRefreshActiveView">{{ t('backup.gm.retry') }}</button>
    </div>

    <div v-else-if="activeStatus === 'disabled'" class="wb-backup-empty" role="status">
      <Server :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
      <strong>{{ t('backup.gm.disabledTitle') }}</strong>
      <span>{{ t('backup.gm.disabledDesc') }}</span>
    </div>

    <div v-else-if="activeStatus === 'unreachable'" class="wb-backup-empty" role="status">
      <Server :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
      <strong>{{ t('backup.gm.unreachableTitle') }}</strong>
      <span>{{ activeError || t('backup.gm.unreachableDesc') }}</span>
      <button type="button" @click="onRefreshActiveView">{{ t('backup.gm.retry') }}</button>
    </div>

    <!-- ===== MODE 2: Per-table 60-change version drill-down ===== -->
    <section
      v-else-if="isTableHistoryMode && gmTableBackups.activeTable"
      class="wb-backup-gm-picker"
      :aria-label="t('backup.gm.tableHistory.versionsAria')"
    >
      <div class="wb-backup-gm-picker-head">
        <button
          type="button"
          class="wb-backup-action-btn wb-backup-icon-text"
          :disabled="busy.restoring"
          @click="backup.closeGmTableBackupVersions()"
        ><ArrowLeft :size="14" aria-hidden="true" />{{ t('backup.gm.tableHistory.backToTables') }}</button>
        <div class="wb-backup-gm-picker-title">
          <strong>
            {{ gmTableBackups.activeTable.database }} · {{ gmTableBackups.activeTable.tableName }}
            <span v-if="!gmTableBackups.activeTable.presentInLatest" class="wb-backup-gm-deleted-badge">
              {{ t('backup.gm.tableHistory.deletedTag') }}
            </span>
          </strong>
          <span>{{ t('backup.gm.tableHistory.versionsSummary', {
            count: gmTableBackups.versions.length,
            max: gmTableBackups.maxVersions || 60,
          }) }}</span>
        </div>
      </div>

      <div v-if="!gmTableBackups.activeTable.presentInLatest" class="wb-backup-gm-notice" role="status">
        <AlertTriangle :size="15" aria-hidden="true" />
        <span>{{ t('backup.gm.tableHistory.deletedNotice', { time: gmTableBackups.activeTable.lastSeenTs || '-' }) }}</span>
      </div>

      <div v-if="gmTableBackups.versionsLoading" class="wb-backup-empty" role="status">
        <strong>{{ t('backup.gm.tableHistory.loadingVersions') }}</strong>
      </div>
      <div v-else-if="gmTableBackups.versionsError" class="wb-backup-empty" role="status">
        <strong>{{ t('backup.gm.tableHistory.versionsFailedTitle') }}</strong>
        <span>{{ gmTableBackups.versionsError }}</span>
        <button type="button" @click="backup.openGmTableBackupVersions(gmTableBackups.activeTable)">{{ t('backup.gm.retry') }}</button>
      </div>
      <div v-else-if="!gmTableBackups.versions.length" class="wb-backup-empty" role="status">
        <strong>{{ t('backup.gm.tableHistory.noVersions') }}</strong>
      </div>
      <div v-else class="wb-backup-list wb-backup-gm-version-list">
        <article
          v-for="(version, idx) in gmTableBackups.versions"
          :key="version.versionId"
          class="wb-backup-snapshot-row wb-backup-gm-version-row"
        >
          <span class="wb-backup-snapshot-icon"><History :size="15" aria-hidden="true" /></span>
          <div class="wb-backup-snapshot-main">
            <div class="wb-backup-snapshot-title">
              <strong class="wb-backup-snapshot-db">{{ version.backupTs }}</strong>
              <span v-if="idx === 0" class="wb-backup-gm-version-badge">{{ t('backup.gm.tableHistory.latestBadge') }}</span>
              <span v-if="version.schemaChanged" class="wb-backup-gm-schema-badge">{{ t('backup.gm.tableHistory.schemaChangedBadge') }}</span>
              <span v-if="!version.hasData" class="wb-backup-gm-table-tag">{{ t('backup.gm.emptyTableTag') }}</span>
            </div>
            <span class="wb-backup-meta">
              {{ formatBackupSize(version.rawBytes) }}
              · {{ t('backup.gm.tableHistory.compressedSize', { size: formatBackupSize(version.compressedBytes) }) }}
              · {{ version.sourceFileName }}
            </span>
          </div>
          <div class="wb-backup-row-actions">
            <button
              type="button"
              class="wb-dialog-primary wb-backup-action-btn wb-backup-icon-text"
              :disabled="!gmTargetReady || busy.restoring"
              :title="gmTargetMissingMessage"
              @click="onRestoreGmTableVersion(version)"
            ><RotateCcw :size="14" aria-hidden="true" />{{ busy.restoring ? t('m_7398723bff4f') : t('backup.gm.tableHistory.restoreVersionBtn') }}</button>
          </div>
        </article>
      </div>
    </section>

    <!-- ===== MODE 2: Per-table 60-change table list ===== -->
    <section
      v-else-if="isTableHistoryMode"
      class="wb-backup-snapshot-section"
      :aria-label="t('backup.gm.tableHistory.listLabel')"
    >
      <div class="wb-backup-list-header">
        <strong>{{ t('backup.gm.tableHistory.listLabel') }}</strong>
        <span class="wb-backup-count" :data-empty="gmTableBackups.items.length === 0">{{ gmTableBackups.items.length }}</span>
        <span v-if="gmTableBackups.lastRunTs" class="wb-backup-meta wb-backup-gm-last-run">
          {{ t('backup.gm.tableHistory.lastScan', { time: gmTableBackups.lastRunTs }) }}
        </span>
      </div>

      <div class="wb-backup-list wb-backup-snapshots">
        <div v-if="gmTableBackups.loading && !gmTableBackups.items.length" class="wb-backup-empty" role="status">
          <strong>{{ t('backup.gm.loadingList') }}</strong>
        </div>
        <div v-else-if="!gmTableBackups.items.length" class="wb-backup-empty" role="status">
          <Table2 :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
          <strong>{{ t('backup.gm.tableHistory.emptyTitle') }}</strong>
          <span>{{ t('backup.gm.tableHistory.emptyDesc') }}</span>
        </div>
        <article
          v-for="item in gmTableBackups.items"
          :key="`${item.database}/${item.tableName}`"
          class="wb-backup-snapshot-row"
        >
          <span class="wb-backup-snapshot-icon"><Table2 :size="16" aria-hidden="true" /></span>
          <div class="wb-backup-snapshot-main">
            <div class="wb-backup-snapshot-title">
              <strong class="wb-backup-snapshot-db">{{ item.tableName }}</strong>
              <span class="wb-backup-chip">{{ item.database }}</span>
              <span class="wb-backup-gm-version-badge">
                {{ t('backup.gm.tableHistory.versionRatio', { count: item.versionCount, max: gmTableBackups.maxVersions || 60 }) }}
              </span>
              <span v-if="item.latestSchemaChanged" class="wb-backup-gm-schema-badge">
                {{ t('backup.gm.tableHistory.schemaChangedBadge') }}
              </span>
              <span v-if="!item.presentInLatest" class="wb-backup-gm-deleted-badge">
                {{ t('backup.gm.tableHistory.deletedTag') }}
              </span>
            </div>
            <span class="wb-backup-meta">
              {{ t('backup.gm.tableHistory.latestChange', { time: item.latestVersionTs }) }} · {{ formatBackupSize(item.latestSizeBytes) }}
            </span>
          </div>
          <div class="wb-backup-row-actions">
            <button
              type="button"
              class="wb-dialog-primary wb-backup-action-btn wb-backup-icon-text"
              :disabled="busy.restoring"
              @click="backup.openGmTableBackupVersions(item)"
            ><History :size="14" aria-hidden="true" />{{ t('backup.gm.tableHistory.viewVersionsBtn') }}</button>
          </div>
        </article>
      </div>
    </section>

    <!-- ===== MODE 1: Hourly table picker drill-down ===== -->
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

    <!-- ===== MODE 1: Hourly backup file list ===== -->
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
  </div>
</template>
