<script setup>
// The inspector's relation page: which configs the current table/row points
// at, and which point back. Row lookups always read live data; relation
// statuses refresh when the backend republishes its index.
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { findRowByKey } from "../utils/rowIdentity.js";
import {
  coverageGapText,
  isEmptyReferenceValue,
  referenceValuesFromCell,
  relationRelevantColumns,
  relationTitle,
  rowCellValue,
  tableDisplayComment,
  tableDisplayName,
} from "../utils/configRelations.js";
import ConfigRelationCard from "./ConfigRelationCard.vue";

const props = defineProps({
  tab: { type: Object, default: null },
  selectedCell: { type: Object, default: null },
  relations: { type: Object, required: true },
});

const emit = defineEmits(["open-relation", "open-review"]);

const ROW_LOOKUP_DEBOUNCE_MS = 120;
const ROW_CHANNEL = "inspector";

const scope = computed(() => ({
  connectionId: String(props.tab?.connectionId || ""),
  database: String(props.tab?.database || ""),
}));
const scopeKey = computed(() => `${scope.value.connectionId}\u001f${scope.value.database.toLowerCase()}`);
const entry = computed(() => props.relations.entryFor(scope.value));
const overview = computed(() => entry.value?.overview || null);
const revision = computed(() => Number(entry.value?.revision) || 0);
const tableName = computed(() => String(props.tab?.tableName || ""));

// ── table-level relations ──────────────────────────────────────

const tableData = ref(null);
const tableError = ref("");
const tableLoading = ref(false);
let tableToken = 0;

async function loadTableRelations() {
  const token = ++tableToken;
  const name = tableName.value;
  if (!scopeKey.value || !name) {
    tableData.value = null;
    tableError.value = "";
    return;
  }
  tableLoading.value = true;
  try {
    const data = await props.relations.tableRelations(scope.value, name);
    if (token !== tableToken) return;
    tableData.value = data;
    tableError.value = "";
  } catch (error) {
    if (token !== tableToken) return;
    tableData.value = null;
    tableError.value = t("relations.error", { message: String(error?.message || error) });
  } finally {
    if (token === tableToken) tableLoading.value = false;
  }
}

watch([scopeKey, tableName], () => {
  void props.relations.loadOverview(scope.value);
  void loadTableRelations();
}, { immediate: true });

// A backend rebuild bumps the revision; both the table list and the row
// lookups follow it.
watch(revision, () => {
  void loadTableRelations();
});

const tables = computed(() => tableData.value?.tables || {});
const outgoingRelations = computed(() => tableData.value?.outgoing || []);
const incomingRelations = computed(() => tableData.value?.incoming || []);
const hasRelations = computed(() => outgoingRelations.value.length + incomingRelations.value.length > 0);

const coverageLines = computed(() => {
  const gaps = tableData.value?.coverage?.gaps || [];
  return gaps.map((gap) => coverageGapText(gap, t)).filter(Boolean);
});
const showBindPrompt = computed(() => ["noClient", "clientMissing", "failed"].includes(overview.value?.codeStatus));

// ── current row ────────────────────────────────────────────────

const selectedRow = computed(() => {
  const tab = props.tab;
  const cell = props.selectedCell;
  if (!tab || !cell || cell.tabId !== tab.id || !cell.rowKey) return null;
  // Row edits bump dataVersion; tracking it keeps the lookups live.
  void tab.dataVersion;
  return findRowByKey(tab, cell.rowKey);
});

const relevantColumns = computed(() =>
  relationRelevantColumns([...outgoingRelations.value, ...incomingRelations.value]));

const rowSignature = computed(() => {
  const row = selectedRow.value;
  if (!row) return "";
  return JSON.stringify(relevantColumns.value.map((column) => String(rowCellValue(row, column) ?? "")));
});

const rowTargets = ref([]);
const rowIncoming = ref([]);
const rowError = ref("");
const rowLoading = ref(false);
let rowToken = 0;
let rowTimer = null;

function scheduleRowLoad() {
  clearTimeout(rowTimer);
  rowTimer = setTimeout(() => void loadRowRelations(), ROW_LOOKUP_DEBOUNCE_MS);
}

async function loadRowRelations() {
  const token = ++rowToken;
  const row = selectedRow.value;
  const name = tableName.value;
  if (!row || !name || !tableData.value) {
    rowTargets.value = [];
    rowIncoming.value = [];
    rowError.value = "";
    return;
  }
  rowLoading.value = true;
  rowError.value = "";
  try {
    const targets = await props.relations.rowTargets(scope.value, name, row, ROW_CHANNEL);
    if (token !== rowToken || targets?.superseded) return;
    rowTargets.value = targets?.outgoing || [];
    // Counts scan whole tables, so they arrive after the targets are shown.
    const references = await props.relations.rowReferences(scope.value, name, row, ROW_CHANNEL);
    if (token !== rowToken || references?.superseded) return;
    rowIncoming.value = references?.incoming || [];
  } catch (error) {
    if (token !== rowToken) return;
    rowError.value = String(error?.message || error);
  } finally {
    if (token === rowToken) rowLoading.value = false;
  }
}

watch([rowSignature, tableData, () => props.tab?.id], scheduleRowLoad, { immediate: true });

onBeforeUnmount(() => {
  clearTimeout(rowTimer);
  rowToken += 1;
  tableToken += 1;
});

const outgoingRows = computed(() => {
  const results = new Map(rowTargets.value.map((item) => [item.relationId, item]));
  return outgoingRelations.value
    .filter((relation) => relation.status !== "rejected")
    .map((relation) => ({ relation, result: results.get(relation.id) || null }))
    .filter((entry) => entry.result ? entry.result.targets.length > 0 : relationCellHasValues(entry.relation));
});

const incomingRows = computed(() => {
  const results = new Map(rowIncoming.value.map((item) => [item.relationId, item]));
  return incomingRelations.value
    .filter((relation) => relation.status !== "rejected")
    .map((relation) => ({ relation, result: results.get(relation.id) || null }))
    .filter((entry) => entry.result ? entry.result.count !== 0 || entry.result.value : true);
});

// Values straight from the cell, so jumps cover everything even when the
// display list is truncated.
function relationCellValues(relation) {
  const row = selectedRow.value;
  if (!row) return [];
  return referenceValuesFromCell(relation.kind, rowCellValue(row, relation.sourceColumn));
}

function relationCellHasValues(relation) {
  return relationCellValues(relation).length > 0;
}

function referencedKeyValue(relation) {
  const row = selectedRow.value;
  if (!row) return "";
  const value = String(rowCellValue(row, relation.targetColumn) ?? "").trim();
  return isEmptyReferenceValue(value) ? "" : value;
}

// ── jumps ──────────────────────────────────────────────────────

function jumpToTargets(relation, values) {
  const keys = values.length ? values : relationCellValues(relation);
  if (!keys.length) return;
  emit("open-relation", {
    connectionId: scope.value.connectionId,
    database: scope.value.database,
    tableName: tableDisplayName(tables.value, relation.targetTable),
    tableComment: tableDisplayComment(tables.value, relation.targetTable),
    readOnly: Boolean(props.tab?.readOnly),
    relationFilter: { column: relation.targetColumn, kind: "equals", values: keys },
    relationOrigin: {
      direction: "outgoing",
      sourceTable: relation.sourceTable,
      sourceColumn: relation.sourceColumn,
      targetTable: relation.targetTable,
      targetColumn: relation.targetColumn,
    },
  });
}

function jumpToIncoming(relation, value) {
  const key = String(value || referencedKeyValue(relation) || "");
  if (!key) return;
  emit("open-relation", {
    connectionId: scope.value.connectionId,
    database: scope.value.database,
    tableName: tableDisplayName(tables.value, relation.sourceTable),
    tableComment: tableDisplayComment(tables.value, relation.sourceTable),
    readOnly: Boolean(props.tab?.readOnly),
    relationFilter: {
      column: relation.sourceColumn,
      kind: relation.kind === "list" ? "listContains" : "equals",
      values: [key],
    },
    relationOrigin: {
      direction: "incoming",
      sourceTable: relation.sourceTable,
      sourceColumn: relation.sourceColumn,
      targetTable: relation.targetTable,
      targetColumn: relation.targetColumn,
    },
  });
}

// ── review actions ─────────────────────────────────────────────

const pendingReview = ref(new Set());

async function submitReview(relation, verdict) {
  if (pendingReview.value.has(relation.id)) return;
  const next = new Set(pendingReview.value);
  next.add(relation.id);
  pendingReview.value = next;
  try {
    await props.relations.submitReview(scope.value, [relation.id], verdict);
    await loadTableRelations();
  } catch (error) {
    rowError.value = String(error?.message || error);
  } finally {
    const done = new Set(pendingReview.value);
    done.delete(relation.id);
    pendingReview.value = done;
  }
}

// ── display helpers ────────────────────────────────────────────

function targetLabel(target) {
  return target.label ? `${target.value} · ${target.label}` : target.value;
}

function targetStateLabel(target) {
  if (target.state === "missing") return t("relations.target.missing");
  if (target.state === "unknown") return t("relations.target.unknown");
  return "";
}

function relationGroups(relations) {
  const active = relations.filter((relation) => relation.status !== "rejected");
  const rejected = relations.filter((relation) => relation.status === "rejected");
  return { active, rejected };
}

const outgoingGroups = computed(() => relationGroups(outgoingRelations.value));
const incomingGroups = computed(() => relationGroups(incomingRelations.value));
const rejectedRelations = computed(() => [...outgoingGroups.value.rejected, ...incomingGroups.value.rejected]);
</script>

<template>
  <div class="wb-relations-panel">
    <section v-if="coverageLines.length || showBindPrompt" class="wb-relations-coverage">
      <div class="wb-relations-coverage-head">
        <span class="wb-relations-section-label">{{ t('relations.coverage.title') }}</span>
        <button
          v-if="showBindPrompt"
          type="button"
          class="wb-relations-link-btn"
          @click="emit('open-review')"
        >{{ t('relations.client.pick') }}</button>
      </div>
      <ul v-if="coverageLines.length" class="wb-relations-coverage-list">
        <li v-for="line in coverageLines" :key="line">{{ line }}</li>
      </ul>
    </section>

    <p v-if="tableError" class="wb-relations-error" role="alert">{{ tableError }}</p>
    <p v-else-if="tableLoading && !tableData" class="wb-relations-muted">{{ t('relations.loading') }}</p>

    <template v-else-if="tableData">
      <section v-if="selectedRow && hasRelations" class="wb-relations-section">
        <div class="wb-relations-section-label">{{ t('relations.row.title') }}</div>

        <div v-if="outgoingRows.length" class="wb-relations-group">
          <div class="wb-relations-group-label">{{ t('relations.row.outgoing') }}</div>
          <article v-for="entry in outgoingRows" :key="entry.relation.id" class="wb-relation-line">
            <button
              type="button"
              class="wb-relation-line-title wb-relations-link-btn"
              :title="tableDisplayComment(tables, entry.relation.targetTable)"
              @click="jumpToTargets(entry.relation, [])"
            >{{ entry.relation.sourceColumn }} → {{ tableDisplayName(tables, entry.relation.targetTable) }}</button>
            <span class="wb-relation-targets">
              <button
                v-for="target in entry.result?.targets || []"
                :key="target.value"
                type="button"
                class="wb-relation-target"
                :class="`is-${target.state}`"
                :title="targetStateLabel(target) || targetLabel(target)"
                :disabled="target.state !== 'found'"
                @click="jumpToTargets(entry.relation, [target.value])"
              >{{ targetLabel(target) }}<template v-if="targetStateLabel(target)"> · {{ targetStateLabel(target) }}</template></button>
              <span v-if="entry.result?.truncated" class="wb-relations-muted">{{ t('relations.target.truncated', { count: entry.result.targets.length }) }}</span>
              <span v-else-if="!entry.result" class="wb-relations-muted">…</span>
            </span>
          </article>
        </div>

        <div v-if="incomingRows.length" class="wb-relations-group">
          <div class="wb-relations-group-label">{{ t('relations.row.incoming') }}</div>
          <article v-for="entry in incomingRows" :key="entry.relation.id" class="wb-relation-line">
            <button
              type="button"
              class="wb-relation-line-title wb-relations-link-btn"
              :title="tableDisplayComment(tables, entry.relation.sourceTable)"
              :disabled="!referencedKeyValue(entry.relation)"
              @click="jumpToIncoming(entry.relation)"
            >{{ tableDisplayName(tables, entry.relation.sourceTable) }}.{{ entry.relation.sourceColumn }}</button>
            <span class="wb-relation-targets">
              <span v-if="entry.result" class="wb-relation-incoming-count">
                <template v-if="entry.result.count === null">{{ t('relations.incoming.countFailed') }}</template>
                <template v-else>{{ t('relations.incoming.rows', { count: entry.result.count }) }}</template>
              </span>
              <span v-else class="wb-relations-muted">…</span>
            </span>
          </article>
        </div>

        <p v-if="!outgoingRows.length && !incomingRows.length && !rowLoading" class="wb-relations-muted">
          {{ t('relations.row.empty') }}
        </p>
        <p v-if="rowError" class="wb-relations-error" role="alert">{{ rowError }}</p>
      </section>
      <p v-else-if="hasRelations" class="wb-relations-muted wb-relations-select-prompt">{{ t('relations.row.selectPrompt') }}</p>

      <section v-if="hasRelations" class="wb-relations-section">
        <div class="wb-relations-section-label">{{ t('relations.table.outgoing') }}</div>
        <ConfigRelationCard
          v-for="relation in outgoingGroups.active"
          :key="relation.id"
          :relation="relation"
          :title="`${relation.sourceColumn} → ${tableDisplayName(tables, relation.targetTable)}.${relation.targetColumn}`"
          :busy="pendingReview.has(relation.id)"
          @review="submitReview(relation, $event)"
        />
        <p v-if="!outgoingRelations.length" class="wb-relations-muted">—</p>

        <div class="wb-relations-section-label">{{ t('relations.table.incoming') }}</div>
        <ConfigRelationCard
          v-for="relation in incomingGroups.active"
          :key="relation.id"
          :relation="relation"
          :title="`${tableDisplayName(tables, relation.sourceTable)}.${relation.sourceColumn} → ${relation.targetColumn}`"
          :busy="pendingReview.has(relation.id)"
          @review="submitReview(relation, $event)"
        />
        <p v-if="!incomingRelations.length" class="wb-relations-muted">—</p>

        <template v-if="rejectedRelations.length">
          <div class="wb-relations-section-label">{{ t('relations.status.rejected') }}</div>
          <ConfigRelationCard
            v-for="relation in rejectedRelations"
            :key="relation.id"
            :relation="relation"
            :title="relationTitle(relation, tables)"
            :busy="pendingReview.has(relation.id)"
            @review="submitReview(relation, $event)"
          />
        </template>
      </section>
      <p v-else-if="!tableLoading" class="wb-relations-muted">{{ t('relations.table.empty') }}</p>
    </template>
  </div>
</template>

<style scoped>
.wb-relations-panel {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 4px 10px 12px;
  overflow: auto;
}

.wb-relations-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-relations-section-label {
  padding-top: 4px;
  color: var(--wb-secondary-text);
  font-size: 11px;
  font-weight: 620;
}

.wb-relations-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wb-relations-group-label {
  color: var(--wb-quiet-text);
  font-size: 11px;
}

.wb-relation-line {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 8px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-field-surface);
}

.wb-relation-line-title {
  align-self: flex-start;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}

.wb-relations-link-btn {
  min-height: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--wb-accent-strong);
  font-size: 11.5px;
  cursor: pointer;
  text-align: left;
}

.wb-relations-link-btn:hover,
.wb-relations-link-btn:active {
  background: none;
}

.wb-relations-link-btn:hover:not(:disabled) {
  text-decoration: underline;
}

.wb-relations-link-btn:disabled {
  color: var(--wb-secondary-text);
  cursor: default;
}

.wb-relation-targets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.wb-relation-target {
  max-width: 100%;
  min-height: 0;
  padding: 1px 8px;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-control);
  color: var(--wb-text);
  font-size: 11.5px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relation-target:hover:not(:disabled) {
  border-color: var(--wb-accent);
}

/* A broken reference must stay readable, not fade like a disabled button. */
.wb-relation-target.is-missing {
  border-color: var(--wb-danger-border);
  color: var(--wb-danger-text);
  opacity: 1;
  cursor: default;
}

.wb-relation-target.is-unknown {
  color: var(--wb-secondary-text);
  cursor: default;
}

.wb-relation-incoming-count {
  color: var(--wb-accent-strong);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.wb-relations-coverage {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--wb-warning-border);
  border-radius: 6px;
  background: var(--wb-warning-surface);
}

.wb-relations-coverage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wb-relations-coverage-list {
  margin: 0;
  padding-left: 16px;
  color: var(--wb-warning-text);
  font-size: 11.5px;
  line-height: 1.5;
}

.wb-relations-muted {
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 11.5px;
}

.wb-relations-select-prompt {
  padding: 2px 0;
}

.wb-relations-error {
  margin: 0;
  color: var(--wb-danger);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
</style>
