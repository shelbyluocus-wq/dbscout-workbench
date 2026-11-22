<script setup>
import { language, t } from "../i18n/index.js";
import { computed, ref, watch, nextTick } from "vue";
import { ArrowLeft, ChevronDown, History, RotateCcw, Search, Table2, TriangleAlert } from "lucide-vue-next";
import { useAliases } from "../composables/aliasStore.js";
import { auditChangeItems, auditChangeSql } from "../utils/auditDisplay.js";
import { auditTableKey } from "../composables/useAuditHistory.js";
const props = defineProps({
  history: { type: Object, required: true },
  connections: { type: Array, default: () => [] },
  preferredConnectionId: { type: String, default: "" },
  preferredDatabase: { type: String, default: "" },
  preferredTable: { type: String, default: "" },
});
const { connectionLabel: resolveConnectionAlias } = useAliases();
const readOnly = computed(() => Boolean(props.history.readOnly));
const actorLabel = (entry) => {
  const name = entry.displayName || entry.username;
  return entry.displayName && entry.username ? `${entry.displayName} (@${entry.username})` : name || t("backup.unknownUser");
};
const s = computed(() => props.history.state);
const SOURCES = new Set(["import", "grid", "rollback", "ddl", "agent", "sql_console"]);
const stamp = (value) => new Date(value).toLocaleString(language.intlLocale.value, { hour12: false });
const connectionLabel = (row) => {
  const raw = props.connections.find((c) => c.id === row.connectionId)?.label || row.connectionId;
  return resolveConnectionAlias(row.connectionId, raw);
};
let didAutoSelect = false;
watch(
  () => s.value.tables,
  (tables) => {
    if (didAutoSelect || s.value.selected || !Array.isArray(tables) || tables.length === 0) return;
    didAutoSelect = true;
    const preferred = props.preferredTable
      ? tables.find((row) => (
          row.tableName === props.preferredTable
          && (!props.preferredDatabase || row.database === props.preferredDatabase)
          && (!props.preferredConnectionId || row.connectionId === props.preferredConnectionId)
        ))
      : null;
    void props.history.selectTable(preferred || tables[0]);
  },
  { immediate: true },
);
const title = (operation) => t(`backup.history.source.${operation.legacy ? "legacy" : SOURCES.has(operation.source) ? operation.source : "other"}`);
const opLabel = (operation) => { const key = `backup.op.${operation}`; const label = t(key); return label === key ? operation : label; };
const isSelected = (table) => Boolean(s.value.selected && auditTableKey(table) === auditTableKey(s.value.selected));
const counts = (row) => [["insert", "INSERT", row.inserted], ["update", "UPDATE", row.updated], ["delete", "DELETE", row.deleted]];
// Operation cards only list the kinds of change that happened; the restore preview lists all three.
const nonZeroCounts = (row) => counts(row).filter(([, , value]) => value);
const previewElement = ref(null);
watch(() => s.value.preview, async (value) => {
  if (!value) return;
  await nextTick();
  previewElement.value?.focus({ preventScroll: true });
  previewElement.value?.scrollIntoView({ block: "nearest" });
});
const details = (id) => s.value.details[id]?.items || [];
</script>

<template>
  <section class="wb-audit-history" :class="{ 'has-selection': s.selected }" :aria-label="t('m_92122adecaa1')" :aria-busy="s.restoring">
    <aside class="wb-audit-tables" :aria-label="t('m_190fb5404595')">
      <form class="wb-audit-search" role="search" @submit.prevent="history.loadTables()">
        <label for="wb-audit-table-search" class="wb-visually-hidden">{{ t('m_d459170f4de3') }}</label>
        <div class="wb-audit-search-field">
          <Table2 :size="14" aria-hidden="true" />
          <input id="wb-audit-table-search" v-model="s.search" type="search" :placeholder="t('m_bccdf7213ff4')" :title="t('m_bccdf7213ff4')" :disabled="s.restoring" />
        </div>
        <button type="submit" :title="t('m_44ce7ae909bb')" :aria-label="t('m_44ce7ae909bb')" :disabled="s.loadingTables || s.restoring"><Search :size="14" aria-hidden="true" /></button>
      </form>
      <p v-if="s.error && !s.selected" class="wb-audit-error" role="alert">{{ s.error }}</p>
      <div class="wb-audit-table-scroll">
        <p v-if="s.loadingTables && !s.tables.length" class="wb-audit-hint wb-audit-list-hint" role="status">{{ t('m_133b5069fbfb') }}</p>
        <p v-else-if="!s.tables.length" class="wb-audit-hint wb-audit-list-hint">{{ t('m_7e40d7555c9d') }}</p>
        <button v-for="table in s.tables" :key="auditTableKey(table)" type="button" class="wb-audit-table" :class="{ active: isSelected(table) }" :aria-pressed="isSelected(table)" :disabled="s.restoring" @click="history.selectTable(table)">
          <Table2 :size="14" class="wb-audit-table-icon" aria-hidden="true" />
          <strong :title="table.tableName">{{ table.tableName }}</strong>
          <span :title="`${connectionLabel(table)} · ${table.database}`">{{ connectionLabel(table) }} · {{ table.database }}</span>
          <time :datetime="table.latestTs" :title="stamp(table.latestTs)">{{ stamp(table.latestTs) }}</time>
        </button>
        <button v-if="s.tablesMore" type="button" class="wb-audit-more" :disabled="s.loadingTables || s.restoring" @click="history.loadTables(undefined, true)">{{ s.loadingTables ? t('m_4927a53bcc88') : t('m_ab36d2486c97') }}</button>
      </div>
    </aside>
    <div class="wb-audit-timeline">
      <p v-if="s.error && s.selected" class="wb-audit-error" role="alert">{{ s.error }}</p>
      <p v-if="s.notice" class="wb-audit-notice" role="status">{{ s.notice }}</p>
      <template v-if="s.selected">
        <header class="wb-audit-heading">
          <button type="button" class="wb-audit-back" :disabled="s.restoring" @click="history.resetSelection()"><ArrowLeft :size="14" aria-hidden="true" />{{ t('m_d5e75e167780') }}</button>
          <strong>{{ s.selected.tableName }}</strong><span>{{ connectionLabel(s.selected) }} · {{ s.selected.database }}</span>
          <p class="wb-audit-hint">{{ readOnly ? t('backup.history.sharedReadOnly') : t('m_7643dd10ab6c') }}</p>
        </header>
        <p v-if="!readOnly && s.previewing" class="wb-audit-hint" role="status">{{ t('m_5e110fbd036a') }}</p>
        <section v-if="!readOnly && s.preview" ref="previewElement" class="wb-audit-preview" :aria-label="t('m_10328a6f1af8')" tabindex="-1">
          <h3><TriangleAlert :size="16" aria-hidden="true" />{{ t('backup.history.previewTitle', { table: s.selected.tableName }) }}</h3>
          <dl class="wb-audit-preview-facts">
            <dt>{{ t('backup.history.previewPoint') }}</dt>
            <dd><strong>{{ stamp(s.preview.targetTs) }}</strong> · {{ s.target.legacy ? t('backup.history.previewBeforeRecord') : t('backup.history.previewBeforeOperation') }}</dd>
            <dt>{{ t('backup.history.previewScope') }}</dt>
            <dd>{{ t('backup.history.previewScopeValue', { operations: s.preview.operations, entries: s.preview.entries }) }}</dd>
            <dt>{{ t('backup.history.previewEstimate') }}</dt>
            <dd class="wb-audit-counts">
              <span v-for="[kind, op, value] in counts(s.preview)" :key="kind" class="wb-audit-count" :data-kind="kind" :data-zero="!value">{{ opLabel(op) }} <b>{{ value }}</b></span>
            </dd>
          </dl>
          <p class="wb-audit-hint">{{ t('m_2d5c41b23d0a') }}</p>
          <p class="wb-audit-preview-warning"><strong>{{ t('m_c14bbbc3dc89') }}</strong> {{ t('m_2e889cb86fec') }}</p>
          <div class="wb-audit-actions">
            <button type="button" :disabled="s.restoring" @click="history.dismissPreview()">{{ t('m_2cd0f3be8738') }}</button>
            <button type="button" class="wb-dialog-primary danger" :disabled="s.restoring" @click="history.restore()">{{ s.restoring ? t('m_dfe29b3fe927') : t('m_2341331d9a51') }}</button>
          </div>
        </section>
        <div class="wb-audit-operations">
          <p v-if="s.loadingOperations && !s.operations.length" class="wb-audit-hint" role="status">{{ t('m_9b0566efad4d') }}</p>
          <p v-else-if="!s.operations.length" class="wb-audit-hint">{{ t('m_3586ed29907f') }}</p>
          <article v-for="operation in s.operations" :key="operation.id" class="wb-audit-operation" :class="{ targeted: s.target?.id === operation.id, expanded: s.expanded === operation.id }" :data-source="operation.legacy ? 'legacy' : operation.source">
            <header><strong>{{ title(operation) }}</strong><time :datetime="operation.ts">{{ stamp(operation.ts) }}</time></header>
            <div class="wb-audit-counts">
              <span v-for="[kind, op, value] in nonZeroCounts(operation)" :key="kind" class="wb-audit-count" :data-kind="kind">{{ opLabel(op) }} <b>{{ value }}</b></span>
              <span v-if="readOnly" class="wb-backup-chip wb-backup-audit-actor" :title="actorLabel(operation)">{{ actorLabel(operation) }}</span>
              <span v-if="!readOnly && operation.blocked" class="wb-audit-blocked"><TriangleAlert :size="12" aria-hidden="true" />{{ t('backup.history.blocked') }}</span>
            </div>
            <p v-if="operation.legacy" class="wb-audit-hint">{{ t('m_2964bd3c0438') }}</p>
            <div class="wb-audit-actions">
              <button type="button" class="wb-audit-details-toggle" :aria-expanded="s.expanded === operation.id" :disabled="s.restoring" @click="history.loadDetails(operation)"><ChevronDown :size="14" aria-hidden="true" />{{ s.expanded === operation.id ? t('m_0ae7312510f4') : t('backup.history.viewDetails', { count: operation.entryCount }) }}</button>
              <button v-if="!readOnly" type="button" class="wb-audit-restore" :disabled="operation.blocked || s.restoring || s.previewing" @click="history.prepareRestore(operation)"><RotateCcw :size="14" aria-hidden="true" />{{ operation.legacy ? t('backup.history.restoreBeforeLegacy') : t('backup.history.restoreBefore') }}</button>
            </div>
            <section v-if="s.expanded === operation.id" class="wb-audit-details" :aria-label="t('m_0f64b165836e')">
              <p v-if="s.loadingDetails && !details(operation.id).length" class="wb-audit-hint" role="status">{{ t('m_00d75928dfcd') }}</p>
              <article v-for="entry in details(operation.id)" :key="entry.id" class="wb-audit-detail">
                <header><span class="wb-backup-op" :data-op="entry.operation">{{ opLabel(entry.operation) }}</span><time :datetime="entry.ts">{{ stamp(entry.ts) }}</time><span>{{ entry.status === 'aborted' ? t('m_a37778f17c5f') : entry.status === 'pending' ? t('m_33df16b4afab') : entry.status === 'rolled_back' ? t('m_9d1ac300aa31') : t('m_f28461bb49c8') }}</span></header>
                <p v-if="entry.rowIdentity" class="wb-audit-identity">{{ t('m_a9e8c256cb93') }}{{ Object.entries(entry.rowIdentity).map(([key, value]) => `${key}=${value ?? 'NULL'}`).join(', ') }}</p>
                <ul v-if="auditChangeItems(entry).length"><li v-for="(item, index) in auditChangeItems(entry)" :key="index">{{ item }}</li></ul><p v-else class="wb-audit-hint">{{ t('m_c226c1702dc7') }}</p>
                <p v-if="readOnly && entry.isRollback" class="wb-audit-hint">{{ t('m_dd194f08e2f4') }}</p>
                <p v-if="readOnly && entry.notes" class="wb-backup-change-note"><b>{{ t('m_3e633a204a63') }}</b>{{ entry.notes }}</p>
                <details v-if="readOnly && auditChangeSql(entry)" class="wb-backup-change-sql">
                  <summary>{{ t('m_036ad51c02f9') }}</summary><pre><code>{{ auditChangeSql(entry) }}</code></pre>
                </details>
              </article>
              <button v-if="s.details[operation.id]?.hasMore" type="button" class="wb-audit-more" :disabled="s.loadingDetails || s.restoring" @click="history.loadDetails(operation, true)">{{ s.loadingDetails ? t('m_4927a53bcc88') : t('m_eb880dd3c3e1') }}</button>
            </section>
          </article>
          <button v-if="s.operationsMore" type="button" class="wb-audit-more" :disabled="s.loadingOperations || s.restoring" @click="history.loadOperations(true)">{{ s.loadingOperations ? t('m_4927a53bcc88') : t('m_db3f67fe422a') }}</button>
        </div>
      </template>
      <div v-else class="wb-audit-welcome">
        <History :size="36" class="wb-backup-empty-icon" aria-hidden="true" />
        <strong>{{ t('m_86860bdd48e6') }}</strong>
        <p>{{ readOnly ? t('backup.history.sharedReadOnly') : t('m_9072ba3cf6bf') }}</p>
      </div>
    </div>
  </section>
</template>
