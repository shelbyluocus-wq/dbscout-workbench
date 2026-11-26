<script setup>
import { computed, onMounted, ref, watch } from "vue";
import {
  AlertTriangle,
  ArrowLeft,
  CheckSquare,
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
const isLoggedIn = computed(() => Boolean(props.account?.isLoggedIn?.value));

const userPickedBackupDb = ref(false);

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

const gmTargetDatabaseMissingFromServer = computed(() => Boolean(
  gmBackups.value?.status === "ok"
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

onMounted(() => {
  const needsAuthReload = isLoggedIn.value
    && (gmBackups.value.status === "logged_out"
      || gmBackups.value.status === "unauthorized"
      || gmBackups.value.status === "not_configured");
  syncGmBackupDatabaseFilterAndLoad({ forceReload: needsAuthReload });
});

watch(
  () => [filters.value.database, isLoggedIn.value],
  ([, loggedIn], [, prevLoggedIn]) => {
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
      <p class="wb-backup-source-hint">{{ t('backup.gm.sourceServerHint') }}</p>
      <div class="wb-backup-toolbar-actions">
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
  </div>
</template>
