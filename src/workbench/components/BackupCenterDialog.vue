<script setup>
import { t } from "../i18n/index.js";
import { computed, ref } from "vue";
import { Archive, CloudUpload, History, RefreshCw, Settings, ShieldCheck, X } from "lucide-vue-next";

import AuditTableHistory from "./AuditTableHistory.vue";
import BackupSettingsPanel from "./BackupSettingsPanel.vue";
import BackupSnapshotsPanel from "./BackupSnapshotsPanel.vue";
import { useConfirm } from "../composables/useConfirm.js";
import { useEscClose } from "../composables/useEscClose.js";
import {
  auditChangeItems,
  auditChangeSql,
  auditChangeSummary,
  auditHasDetails,
} from "../utils/auditDisplay.js";
import { formatBackupTimestamp } from "../utils/backupDisplay.js";

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
const snapshotCount = computed(() => (props.backup.snapshots.value || []).length);
const localAuditByClientId = computed(() =>
  new Map(
    auditLogs.value
      .filter((entry) => entry.clientId)
      .map((entry) => [entry.clientId, entry]),
  ),
);
const expandedAuditKeys = ref(new Set());
// Shared rows are enriched with the local copy (same clientId) when this
// device recorded them, because only local rows carry SQL and notes.
const sharedAuditRows = computed(() =>
  sharedAuditLogs.value.map((entry) => {
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
const displayName = computed(() => account.value?.displayName?.value || "");
const username = computed(() => account.value?.username?.value || "");
const filterDatabases = computed(() => props.backup.filterDatabases.value || []);
const filterTables = computed(() => props.backup.filterTables.value || []);

const progress = computed(() => props.backup.progress);
const busy = computed(() => props.backup.busy);
const filters = computed(() => props.backup.filters);
const accountBusy = computed(() => account.value?.busy?.value || account.value?.busy || {});

const { alert } = useConfirm();

const isBusy = computed(() => (
  Object.values(busy.value || {}).some(Boolean)
  || Boolean(progress.value?.active)
  || Object.values(accountBusy.value || {}).some(Boolean)
));
const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), () => isBusy.value, { dialogRef });

const tabs = computed(() => [
  { id: "audit", label: t("m_7bf9d4a5d756"), icon: History },
  { id: "snapshot", label: t("backup.tab.snapshots"), icon: Archive, count: snapshotCount.value },
  { id: "config", label: t("m_df3d58c7d84b"), icon: Settings },
]);

function operationLabel(operation) {
  const key = `backup.op.${operation}`;
  const label = t(key);
  return label === key ? operation : label;
}
function statusLabel(status) {
  const key = `backup.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}
function sourceLabel(source) {
  const key = `backup.source.${source}`;
  const label = t(key);
  return label === key ? source : label;
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

// The actor label shown on each shared audit row: "displayName (@username)".
function actorLabel(entry) {
  const name = entry.displayName || entry.username;
  const handle = entry.username ? `@${entry.username}` : "";
  if (name && handle) return `${name} (${handle})`;
  return name || handle || t("backup.unknownUser");
}

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

function switchTab(tab) {
  dialog.value.tab = tab;
}

// Refreshing is silent when it works; only failures interrupt with a dialog.
async function applyFilters({ silent = false } = {}) {
  const [auditOk, snapshotOk] = await Promise.all([
    props.backup.loadAuditLogs(),
    props.backup.loadSnapshots(),
  ]);
  const ok = auditOk && snapshotOk;
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
            <select v-model="filters.connectionId" class="wb-backup-select" :aria-label="t('m_8bec5f76301e')" @change="onConnectionFilterChange">
              <option value="">{{ t('m_dbb2c7b44300') }}</option>
              <option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
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
            <select
              v-model="filters.tableName"
              class="wb-backup-select"
              :aria-label="t('m_1408973f34e3')"
              :disabled="!filters.connectionId || !filters.database || busy.filterOptions"
              @change="applyFilters()"
            >
              <option value="">{{ t('m_f974e44668ed') }}</option>
              <option v-for="tableName in filterTables" :key="tableName" :value="tableName">{{ tableName }}</option>
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

        <AuditTableHistory v-if="!isSharedMode" :history="backup.history" :connections="connections" />
        <div v-else class="wb-backup-list wb-backup-audit">
          <div v-if="!sharedAuditRows.length" class="wb-backup-empty">
            <History :size="32" class="wb-backup-empty-icon" aria-hidden="true" />
            <strong>{{ t('m_cb9612a9181a') }}</strong>
            <span>{{ t('m_0b856c6ee3f3') }}</span>
          </div>
          <article
            v-for="row in sharedAuditRows"
            :key="row.key"
            class="wb-backup-audit-row"
            :class="{ rolled: row.entry.isRollback, aborted: row.entry.status === 'aborted', expanded: isAuditExpanded(row.key) }"
          >
            <div class="wb-backup-audit-main">
              <span class="wb-backup-op" :data-op="row.entry.operation">{{ operationLabel(row.entry.operation) }}</span>
              <span class="wb-backup-loc">{{ row.entry.database }} · {{ row.entry.tableName }}</span>
              <span class="wb-backup-chip wb-backup-audit-actor" :title="actorLabel(row.entry)">{{ actorLabel(row.entry) }}</span>
              <span class="wb-backup-ts">{{ formatBackupTimestamp(row.entry.ts) }}</span>
            </div>
            <div class="wb-backup-audit-meta">
              <span
                class="wb-backup-diff wb-backup-change-summary"
                :class="{ empty: !row.summary }"
                :title="row.summary || t('m_ebfb90ae7a95')"
              ><b>{{ t('m_a26529f8c3a1') }}</b>{{ row.summary || t('m_12964a9ef161') }}</span>
              <span v-if="identityText(row.entry)" class="wb-backup-identity">{{ t('m_a9e8c256cb93') }}{{ identityText(row.entry) }}</span>
              <span v-if="row.entry.isRollback" class="wb-backup-rollback-tag">{{ t('m_dd194f08e2f4') }}</span>
              <span class="wb-backup-chip" data-kind="source">{{ sourceLabel(row.entry.source) }}</span>
              <span class="wb-backup-chip" data-kind="status" :data-status="row.entry.status">{{ statusLabel(row.entry.status) }}</span>
            </div>
            <div v-if="row.hasDetails" class="wb-backup-row-actions">
              <button
                type="button"
                class="wb-backup-action-btn wb-backup-details-btn"
                :aria-expanded="isAuditExpanded(row.key)"
                @click="toggleAuditDetails(row.key)"
              >{{ isAuditExpanded(row.key) ? t('m_0ae7312510f4') : t('m_1932da4d4dba') }}</button>
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

      <BackupSnapshotsPanel
        v-else-if="dialog.tab === 'snapshot'"
        id="wb-backup-panel-snapshot"
        class="wb-backup-panel"
        role="tabpanel"
        aria-labelledby="wb-backup-title"
        :backup="backup"
        :connections="connections"
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
