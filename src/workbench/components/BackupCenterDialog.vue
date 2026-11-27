<script setup>
import { t } from "../i18n/index.js";
import { computed, ref } from "vue";
import { CloudUpload, History, RefreshCw, Server, Settings, ShieldCheck, X } from "lucide-vue-next";

import AuditTableHistory from "./AuditTableHistory.vue";
import BackupSettingsPanel from "./BackupSettingsPanel.vue";
import BackupSnapshotsPanel from "./BackupSnapshotsPanel.vue";
import { useAliases } from "../composables/aliasStore.js";
import { useConfirm } from "../composables/useConfirm.js";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  backup: { type: Object, required: true },
  connections: { type: Array, default: () => [] },
  account: { type: Object, default: null },
  activeConnectionId: { type: String, default: "" },
  activeDatabase: { type: String, default: "" },
  activeTableName: { type: String, default: "" },
});

const emit = defineEmits(["close"]);

const dialog = computed(() => props.backup.dialog);
const auditMode = computed(() => props.backup.auditMode?.mode || "local");
const isSharedMode = computed(() => auditMode.value === "shared");
const gmBackupCount = computed(() => (
  props.backup.gmBackupViewMode?.mode === "table-history"
    ? (props.backup.gmTableBackups?.items || []).length
    : (props.backup.gmBackups?.items || []).length
));
const account = computed(() => props.account || null);
const isLoggedIn = computed(() => Boolean(account.value?.isLoggedIn?.value));
const displayName = computed(() => account.value?.displayName?.value || "");
const username = computed(() => account.value?.username?.value || "");
const filterDatabases = computed(() => props.backup.filterDatabases.value || []);
const filterTables = computed(() => props.backup.filterTables.value || []);

const progress = computed(() => props.backup.progress);
const busy = computed(() => props.backup.busy);
const filters = computed(() => props.backup.filters);
const accountBusy = computed(() => account.value?.busy?.value || account.value?.busy || {});

const { alert } = useConfirm();
const { connectionLabel: resolveConnectionAlias } = useAliases();

const isBusy = computed(() => (
  Object.values(busy.value || {}).some(Boolean)
  || Boolean(progress.value?.active)
  || Object.values(accountBusy.value || {}).some(Boolean)
));
const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), () => isBusy.value, { dialogRef });

const tabs = computed(() => [
  { id: "audit", label: t("m_7bf9d4a5d756"), icon: History },
  { id: "snapshot", label: t("backup.tab.snapshots"), icon: Server, count: gmBackupCount.value },
  { id: "config", label: t("m_df3d58c7d84b"), icon: Settings },
]);

async function onSyncNow() {
  const result = await account.value?.syncNow();
  const accepted = Number(result?.accepted || 0);
  const skipped = Number(result?.skipped || 0);
  await props.backup.loadAuditLogs();
  const skippedNote = skipped ? ` ${t("backup.alert.syncSkipped", { count: skipped })}` : "";
  await alert({
    title: accepted > 0 ? t("backup.alert.syncDoneTitle") : t("backup.alert.syncNoneTitle"),
    message: accepted > 0 ? `${t("backup.alert.syncDone", { count: accepted })}${skippedNote}` : t("backup.alert.syncNone"),
  });
}

async function onSwitchAuditMode(mode) {
  if (mode === "shared" && !isLoggedIn.value) {
    await alert({ title: t("m_c1f658373079"), message: t("backup.alert.sharedNeedsLogin") });
    return;
  }
  await props.backup.setAuditMode(mode);
}

const autoSeededSnapshotScope = ref(false);

async function switchTab(tab) {
  dialog.value.tab = tab;
  if (
    tab === "snapshot"
    && !autoSeededSnapshotScope.value
    && !filters.value.connectionId
    && props.activeConnectionId
    && props.activeDatabase
  ) {
    autoSeededSnapshotScope.value = true;
    props.backup.setFilters({
      connectionId: props.activeConnectionId,
      database: props.activeDatabase,
      tableName: "",
    });
    await props.backup.loadFilterDatabases();
  }
}

// Refreshing is silent when it works; only failures interrupt with a dialog.
async function applyFilters({ silent = false } = {}) {
  const ok = await props.backup.loadAuditLogs();
  if (!ok && !silent) {
    await alert({
      title: t("backup.refreshFailedTitle"),
      message: props.backup.lastError.value || t("backup.refreshFailed"),
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
</script>

<template>
  <div class="wb-dialog-overlay">
    <section ref="dialogRef" class="wb-dialog wb-backup-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-backup-title" tabindex="-1">
      <header class="wb-backup-header">
        <span class="wb-backup-header-icon"><ShieldCheck :size="18" aria-hidden="true" /></span>
        <div class="wb-backup-heading">
          <strong id="wb-backup-title">{{ t('m_965320c43727') }}</strong>
          <p class="wb-backup-subtitle">{{ t('m_1c161224847e') }}</p>
        </div>
        <button
          type="button"
          class="wb-backup-user"
          :data-logged-in="isLoggedIn"
          :title="t('backup.accountChipTitle')"
          :disabled="busy.restoring"
          @click="switchTab('config')"
        >
          <template v-if="isLoggedIn">
            <span class="wb-backup-user-avatar">{{ (displayName || username || '?').slice(0, 1).toUpperCase() }}</span>
            <span class="wb-backup-user-name">{{ displayName || username }}<em>@{{ username }}</em></span>
          </template>
          <template v-else>
            <span class="wb-backup-user-dot" aria-hidden="true"></span>
            <span class="wb-backup-user-name wb-backup-user-guest">{{ t('m_c1f658373079') }}</span>
          </template>
        </button>
        <button type="button" class="wb-dialog-close wb-backup-close" :disabled="isBusy" :aria-label="t('m_9859381ba96b')" @click="emit('close')"><X :size="18" aria-hidden="true" /></button>
      </header>

      <nav class="wb-backup-tabs" :inert="busy.restoring" role="tablist" :aria-label="t('m_2a5a3ca85415')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :class="{ active: dialog.tab === tab.id }"
          :aria-selected="dialog.tab === tab.id"
          :aria-controls="`wb-backup-panel-${tab.id}`"
          @click="switchTab(tab.id)"
        >
          <component :is="tab.icon" :size="14" aria-hidden="true" />
          <span>{{ tab.label }}</span>
          <span v-if="tab.count" class="wb-backup-tab-count">{{ tab.count }}</span>
        </button>
      </nav>

      <div v-if="dialog.tab === 'audit'" id="wb-backup-panel-audit" class="wb-backup-panel wb-backup-audit-panel" role="tabpanel" aria-labelledby="wb-backup-title">
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
            <select
              v-model="filters.connectionId"
              class="wb-backup-select"
              :aria-label="t('m_8bec5f76301e')"
              :title="connections.find((item) => item.id === filters.connectionId)?.label || ''"
              @change="onConnectionFilterChange"
            >
              <option value="">{{ t('m_dbb2c7b44300') }}</option>
              <option
                v-for="connection in connections"
                :key="connection.id"
                :value="connection.id"
                :title="connection.label"
              >{{ resolveConnectionAlias(connection.id, connection.label) }}</option>
            </select>
            <select
              v-model="filters.database"
              class="wb-backup-select"
              :aria-label="t('m_a6bb90d7e9ea')"
              :disabled="!filters.connectionId || busy.filterOptions"
              @change="onDatabaseFilterChange"
            >
              <option value="">{{ t('m_d3ea59fd4532') }}</option>
              <option v-for="database in filterDatabases" :key="database" :value="database">{{ database }}</option>
            </select>
          </div>
          <div class="wb-backup-toolbar-actions">
            <button
              v-if="isSharedMode"
              type="button"
              class="wb-backup-icon-text"
              :disabled="!isLoggedIn || accountBusy.syncing"
              :title="t('m_6a8aa8247031')"
              @click="onSyncNow"
            ><CloudUpload :size="14" aria-hidden="true" />{{ accountBusy.syncing ? t('m_4e2238b74ec7') : t('m_36e7a43a1c67') }}</button>
            <button
              type="button"
              class="wb-backup-icon-text wb-backup-refresh"
              :class="{ spinning: busy.listing }"
              :disabled="busy.listing || busy.deleting"
              @click="applyFilters()"
            ><RefreshCw :size="14" aria-hidden="true" />{{ busy.listing ? t('m_d302f90b0996') : t('m_aee887434131') }}</button>
          </div>
        </div>

        <AuditTableHistory
          :key="auditMode"
          :history="isSharedMode ? backup.sharedHistory : backup.history"
          :connections="connections"
          :preferred-connection-id="activeConnectionId"
          :preferred-database="activeDatabase"
          :preferred-table="activeTableName"
        />
      </div>

      <BackupSnapshotsPanel
        v-else-if="dialog.tab === 'snapshot'"
        id="wb-backup-panel-snapshot"
        class="wb-backup-panel"
        role="tabpanel"
        aria-labelledby="wb-backup-title"
        :backup="backup"
        :connections="connections"
        :account="account"
        @connection-change="onConnectionFilterChange"
        @database-change="onDatabaseFilterChange"
        @open-settings="switchTab('config')"
      />

      <BackupSettingsPanel
        v-else
        id="wb-backup-panel-config"
        class="wb-backup-panel wb-backup-config"
        role="tabpanel"
        aria-labelledby="wb-backup-title"
        :backup="backup"
        :account="account"
        @close="emit('close')"
      />
    </section>
  </div>
</template>
