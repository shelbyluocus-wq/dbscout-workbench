<script setup>
// "Current row" on the relation page: the configs the selected row points at
// (each target a jump, read live from the target table) and the rows that
// point back (counted, expandable, openable as one filtered tab). Lookups are
// debounced per selection and dropped when the selection moves on.
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, MousePointerClick, Search, X } from "lucide-vue-next";
import { findRowByKey, rowIdentityLabel } from "../utils/rowIdentity.js";
import {
  isEmptyReferenceValue,
  referenceValuesFromCell,
  relationLabelColumn,
  relationRelevantColumns,
  relationRowName,
  rowCellValue,
  tableColumnComment,
  tableDisplayComment,
  tableDisplayName,
} from "../utils/configRelations.js";
import { incomingRelationFilter } from "../incomingRelationRows.js";
import { matchesRelationConstraints } from "../utils/relationConstraints.js";
import RelationSectionHead from "./RelationSectionHead.vue";
import TableMentionText from "./TableMentionText.vue";
import IncomingRelationRows from "./IncomingRelationRows.vue";
import CommentTip from "./CommentTip.vue";

const props = defineProps({
  tab: { type: Object, default: null },
  selectedCell: { type: Object, default: null },
  relations: { type: Object, required: true },
  scope: { type: Object, required: true },
  // Active and rejected relations of the table, as the backend lists them.
  outgoing: { type: Array, default: () => [] },
  incoming: { type: Array, default: () => [] },
  // Backend lowercase-name -> { name, comment } map.
  tables: { type: Object, default: () => ({}) },
  mentionTables: { type: Object, default: null },
  revision: { type: Number, default: 0 },
  open: { type: Boolean, default: true },
});

const emit = defineEmits(["toggle", "open-relation", "open-table"]);

const ROW_LOOKUP_DEBOUNCE_MS = 120;
const ROW_CHANNEL = "inspector";
const bodyId = `wb-relations-row-${Math.random().toString(36).slice(2, 10)}`;

const tableName = computed(() => String(props.tab?.tableName || ""));
const scopeKey = computed(() => `${props.scope.connectionId}\u001f${String(props.scope.database || "").toLowerCase()}`);
const activeOutgoing = computed(() => props.outgoing.filter((relation) => relation.status !== "rejected"));
const activeIncoming = computed(() => props.incoming.filter((relation) => relation.status !== "rejected"));

const selectedRow = computed(() => {
  const tab = props.tab;
  const cell = props.selectedCell;
  if (!tab || !cell || cell.tabId !== tab.id || !cell.rowKey) return null;
  // Row edits bump dataVersion; tracking it keeps the lookups live.
  void tab.dataVersion;
  return findRowByKey(tab, cell.rowKey);
});

// "id=1 · Potion": the key the grid uses plus the row's name when it has one.
const labelColumn = computed(() => relationLabelColumn(props.tab?.columns, props.tab?.primaryKeys));
const rowIdentity = computed(() => {
  const row = selectedRow.value;
  if (!row) return "";
  const key = rowIdentityLabel(props.tab, row) || "";
  const name = relationRowName(row, labelColumn.value);
  return [key, name].filter(Boolean).join(" · ");
});

const relevantColumns = computed(() => relationRelevantColumns([...activeOutgoing.value, ...activeIncoming.value]));

const rowSignature = computed(() => {
  const row = selectedRow.value;
  if (!row) return "";
  return JSON.stringify(relevantColumns.value.map((column) => String(rowCellValue(row, column) ?? "")));
});

// ── lookups ────────────────────────────────────────────────────

const rowTargets = ref([]);
const rowIncoming = ref([]);
const targetsLoaded = ref(false);
const referencesLoaded = ref(false);
const rowError = ref("");
let rowToken = 0;
let rowTimer = null;

function clearResults() {
  rowTargets.value = [];
  rowIncoming.value = [];
  targetsLoaded.value = false;
  referencesLoaded.value = false;
  rowError.value = "";
}

function scheduleRowLoad() {
  clearTimeout(rowTimer);
  rowToken += 1;
  clearResults();
  rowTimer = setTimeout(() => void loadRowRelations(), ROW_LOOKUP_DEBOUNCE_MS);
}

async function loadRowRelations() {
  const token = ++rowToken;
  const row = selectedRow.value;
  const name = tableName.value;
  if (!row || !name || !(activeOutgoing.value.length + activeIncoming.value.length)) {
    clearResults();
    return;
  }
  try {
    const targets = await props.relations.rowTargets(props.scope, name, row, ROW_CHANNEL);
    if (token !== rowToken || targets?.superseded) return;
    rowTargets.value = targets?.outgoing || [];
    targetsLoaded.value = true;
    // Counts scan whole tables, so they arrive after the targets are shown.
    const references = await props.relations.rowReferences(props.scope, name, row, ROW_CHANNEL);
    if (token !== rowToken || references?.superseded) return;
    rowIncoming.value = references?.incoming || [];
    referencesLoaded.value = true;
  } catch (error) {
    if (token !== rowToken) return;
    rowError.value = String(error?.message || error);
    targetsLoaded.value = true;
    referencesLoaded.value = true;
  }
}

watch(
  [scopeKey, tableName, rowSignature, () => props.outgoing, () => props.incoming, () => props.tab?.id, () => props.selectedCell?.rowKey],
  scheduleRowLoad,
  { immediate: true, flush: "sync" },
);

onBeforeUnmount(() => {
  clearTimeout(rowTimer);
  rowToken += 1;
});

// ── what the row points at ─────────────────────────────────────

// Values straight from the cell, so jumps cover everything even when the
// display list is truncated.
function relationCellValues(relation) {
  const row = selectedRow.value;
  if (!row || !matchesRelationConstraints(row, relation.sourceConstraints)) return [];
  return referenceValuesFromCell(relation.kind, rowCellValue(row, relation.sourceColumn), relation.parser);
}

const outgoingRows = computed(() => {
  const results = new Map(rowTargets.value.map((item) => [item.relationId, item]));
  return activeOutgoing.value
    .map((relation) => ({ relation, result: results.get(relation.id) || null, values: relationCellValues(relation) }))
    .filter((entry) => (entry.result ? entry.result.targets.length > 0 || entry.result.unparsed : !targetsLoaded.value && entry.values.length > 0));
});

// ── what points at the row ─────────────────────────────────────

// The key other rows would point at, read from the selected row itself so a
// line can be expanded while its count is still on the way.
function referencedValue(relation) {
  return String(rowCellValue(selectedRow.value, relation.targetColumn) ?? "").trim();
}

const incomingEntries = computed(() => {
  const results = new Map(rowIncoming.value.map((item) => [item.relationId, item]));
  return activeIncoming.value
    .map((relation) => ({ relation, result: results.get(relation.id) || null, value: referencedValue(relation) }))
    // A relation whose key is empty in this row has nothing to count.
    .filter((entry) => !isEmptyReferenceValue(entry.value));
});
const incomingQuery = ref("");
watch([scopeKey, tableName], () => {
  incomingQuery.value = "";
});

const referencedRows = computed(() => incomingEntries.value.filter((entry) => entry.result?.count !== 0));
const showIncomingSearch = computed(() => referencedRows.value.length >= 6);
const filteredReferencedRows = computed(() => {
  const needle = incomingQuery.value.trim().toLowerCase();
  if (!needle) return referencedRows.value;
  return referencedRows.value.filter((entry) => {
    const srcTable = sourceTableName(entry.relation).toLowerCase();
    const srcCol = String(entry.relation.sourceColumn || "").toLowerCase();
    const tblComment = tableDisplayComment(props.tables, entry.relation.sourceTable).toLowerCase();
    const colComment = tableColumnComment(props.tables, entry.relation.sourceTable, entry.relation.sourceColumn).toLowerCase();
    return srcTable.includes(needle)
      || srcCol.includes(needle)
      || `${srcTable}.${srcCol}`.includes(needle)
      || tblComment.includes(needle)
      || colComment.includes(needle);
  });
});

const referenceTotal = computed(() => referencedRows.value.reduce((sum, entry) => sum + (Number(entry.result?.count) || 0), 0));
const filteredReferenceTotal = computed(() => filteredReferencedRows.value.reduce((sum, entry) => sum + (Number(entry.result?.count) || 0), 0));
const loaded = computed(() => targetsLoaded.value && referencesLoaded.value);
const rowEmpty = computed(() => loaded.value && !rowError.value && !outgoingRows.value.length && !referencedRows.value.length);

// ── jumps ──────────────────────────────────────────────────────

function sourceTableName(relation) {
  return tableDisplayName(props.tables, relation.sourceTable);
}

function targetTableName(relation) {
  return tableDisplayName(props.tables, relation.targetTable);
}

function jumpToTargets(relation, values) {
  const keys = values.length ? values : relationCellValues(relation);
  if (!keys.length) return;
  emit("open-relation", {
    connectionId: props.scope.connectionId,
    database: props.scope.database,
    tableName: targetTableName(relation),
    tableComment: tableDisplayComment(props.tables, relation.targetTable),
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

function jumpToIncomingRow(relation, row) {
  const [column, value] = Object.entries(row.identity || {})[0] || [];
  if (!column || value == null) return;
  emit("open-relation", {
    ...props.scope,
    tableName: sourceTableName(relation),
    tableComment: tableDisplayComment(props.tables, relation.sourceTable),
    readOnly: Boolean(props.tab?.readOnly),
    relationFilter: { column, kind: "equals", values: [value] },
    rowIdentity: row.identity,
  });
}

// Every row that references the selected one, as one filtered tab.
function openAllIncoming(relation, value) {
  if (value == null || value === "") return;
  emit("open-relation", {
    ...props.scope,
    tableName: sourceTableName(relation),
    tableComment: tableDisplayComment(props.tables, relation.sourceTable),
    readOnly: Boolean(props.tab?.readOnly),
    relationFilter: incomingRelationFilter(relation, value),
    relationOrigin: {
      direction: "incoming",
      sourceTable: relation.sourceTable,
      sourceColumn: relation.sourceColumn,
      targetTable: relation.targetTable,
      targetColumn: relation.targetColumn,
    },
  });
}

function targetStateLabel(target) {
  if (target.state === "missing") return t("relations.target.missing");
  if (target.state === "unknown") return t("relations.target.unknown");
  return "";
}

function targetDisplayLabel(target) {
  if (target?.label) return target.label;
  const count = Number(target?.matchCount) || 0;
  return count > 1 ? t("relations.target.matchCount", { count }) : "";
}

function targetTitle(target, relation) {
  const state = targetStateLabel(target);
  if (state) return `${targetTableName(relation)}.${relation.targetColumn} = ${target.value} · ${state}`;
  const count = Number(target.matchCount) || 0;
  const countText = count > 1 ? t("relations.target.matchCount", { count }) : "";
  const valueText = [target.value, target.label || "", countText].filter(Boolean).join(" · ");
  return t("relations.target.open", { table: targetTableName(relation), value: valueText });
}
</script>

<template>
  <section class="wb-relations-block">
    <RelationSectionHead
      :label="t('relations.row.title')"
      :open="open"
      :controls="bodyId"
      @toggle="emit('toggle')"
    >
      <span v-if="rowIdentity" class="wb-relations-row-identity" :title="rowIdentity">{{ rowIdentity }}</span>
    </RelationSectionHead>

    <div v-show="open" :id="bodyId" class="wb-relations-block-body">
      <p v-if="!selectedRow" class="wb-relations-hint">
        <MousePointerClick :size="14" aria-hidden="true" />
        <span>{{ t('relations.row.selectPrompt') }}</span>
      </p>

      <template v-else>
        <div v-if="outgoingRows.length" class="wb-relations-group">
          <div class="wb-relations-group-label is-outgoing">
            <ArrowUpRight :size="12" :stroke-width="2.2" aria-hidden="true" />
            <span>{{ t('relations.row.outgoing') }}</span>
          </div>
          <div v-for="entry in outgoingRows" :key="entry.relation.id" class="wb-row-target">
            <div class="wb-row-target-head">
              <span class="wb-row-target-column" :title="entry.relation.sourceColumn"><CommentTip
                field
                :name="`${sourceTableName(entry.relation)}.${entry.relation.sourceColumn}`"
                :comment="tableColumnComment(tables, entry.relation.sourceTable, entry.relation.sourceColumn)"
              >{{ entry.relation.sourceColumn }}</CommentTip></span>
              <ArrowRight :size="11" :stroke-width="2.2" class="wb-row-target-arrow" aria-hidden="true" />
              <span class="wb-row-target-table" :title="`${targetTableName(entry.relation)}.${entry.relation.targetColumn}`">
                <TableMentionText :text="targetTableName(entry.relation)" :tables="mentionTables" @open="emit('open-table', $event)" /><span class="wb-row-target-key">.<CommentTip
                  field
                  :name="`${targetTableName(entry.relation)}.${entry.relation.targetColumn}`"
                  :comment="tableColumnComment(tables, entry.relation.targetTable, entry.relation.targetColumn)"
                >{{ entry.relation.targetColumn }}</CommentTip></span>
              </span>
              <button
                v-if="entry.values.length > 1"
                type="button"
                class="wb-row-target-all"
                :title="t('relations.row.openAllTargets', { count: entry.values.length })"
                @click="jumpToTargets(entry.relation, [])"
              >{{ t('relations.row.openAllShort', { count: entry.values.length }) }}</button>
            </div>
            <div class="wb-row-target-values">
              <template v-if="entry.result">
                <span v-if="entry.result.unparsed" class="wb-relations-note">{{ t('relations.target.unparsed') }}</span>
                <button
                  v-for="target in entry.result.targets"
                  :key="target.value"
                  type="button"
                  class="wb-relation-target"
                  :class="`is-${target.state}`"
                  :title="targetTitle(target, entry.relation)"
                  :disabled="target.state !== 'found'"
                  @click="jumpToTargets(entry.relation, [target.value])"
                >
                  <span class="wb-relation-target-value">{{ target.value }}</span>
                  <span v-if="targetDisplayLabel(target)" class="wb-relation-target-label">{{ targetDisplayLabel(target) }}</span>
                  <span v-if="targetStateLabel(target)" class="wb-relation-target-state">{{ targetStateLabel(target) }}</span>
                </button>
                <span v-if="entry.result.truncated" class="wb-relations-note">{{ t('relations.target.truncated', { count: entry.result.targets.length }) }}</span>
              </template>
              <span v-else class="wb-relation-target is-placeholder" aria-hidden="true" />
            </div>
          </div>
        </div>

        <div v-if="referencedRows.length" class="wb-relations-group">
          <div class="wb-relations-group-label is-incoming">
            <ArrowDownLeft :size="12" :stroke-width="2.2" aria-hidden="true" />
            <span>{{ t('relations.row.incoming') }}</span>
            <span v-if="incomingQuery.trim()" class="wb-relations-group-total">
              {{ t('relations.incoming.filteredCount', { shown: filteredReferencedRows.length, total: referencedRows.length, rows: filteredReferenceTotal }) }}
            </span>
            <span v-else-if="referencesLoaded && referenceTotal" class="wb-relations-group-total">{{ t('relations.incoming.rows', { count: referenceTotal }) }}</span>
          </div>
          <label v-if="showIncomingSearch" class="wb-incoming-filter">
            <Search :size="12" aria-hidden="true" />
            <input
              v-model="incomingQuery"
              type="text"
              :placeholder="t('relations.incoming.searchPlaceholder')"
              :aria-label="t('relations.incoming.searchPlaceholder')"
            />
            <button
              v-if="incomingQuery"
              type="button"
              class="wb-incoming-filter-clear"
              :aria-label="t('m_ee32f25f7050')"
              @click="incomingQuery = ''"
            ><X :size="11" aria-hidden="true" /></button>
          </label>
          <p v-if="incomingQuery.trim() && !filteredReferencedRows.length" class="wb-relations-hint is-quiet">
            {{ t('relations.incoming.noMatch') }}
          </p>
          <IncomingRelationRows
            v-for="entry in filteredReferencedRows"
            :key="entry.relation.id"
            :table="sourceTableName(entry.relation)"
            :table-comment="tableDisplayComment(tables, entry.relation.sourceTable)"
            :column-comment="tableColumnComment(tables, entry.relation.sourceTable, entry.relation.sourceColumn)"
            :column="entry.relation.sourceColumn"
            :count="entry.result ? entry.result.count : null"
            :counting="!entry.result && !referencesLoaded"
            :context="{
              scope,
              tableName: sourceTableName(entry.relation),
              relation: entry.relation,
              value: entry.value,
              rowKey: selectedCell?.rowKey,
              revision,
            }"
            @open-row="jumpToIncomingRow(entry.relation, $event)"
            @open-all="openAllIncoming(entry.relation, entry.value)"
          />
        </div>

        <p v-if="rowEmpty" class="wb-relations-hint is-quiet">{{ t('relations.row.empty') }}</p>

        <p v-if="rowError" class="wb-relations-error" role="alert">{{ rowError }}</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.wb-incoming-filter {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  margin: 2px 0 4px;
  padding: 0 6px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-field-surface);
  color: var(--wb-secondary-text);
}

.wb-incoming-filter:focus-within {
  border-color: var(--wb-accent);
}

.wb-incoming-filter input {
  flex: 1 1 auto;
  min-width: 0;
  height: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--wb-text);
  font-size: var(--wb-fs-caption);
  outline: none;
}

.wb-incoming-filter-clear {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--wb-quiet-text);
  cursor: pointer;
}

.wb-incoming-filter-clear:hover {
  background: var(--wb-list-hover);
  color: var(--wb-text);
}

.wb-relations-row-identity {
  min-width: 0;
  overflow: hidden;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-caption);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-row-target {
  display: grid;
  gap: 4px;
  padding: 4px 6px 6px;
  border-radius: 6px;
}

.wb-row-target-head {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: var(--wb-fs-body);
  line-height: 18px;
}

.wb-row-target-column {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-identifier-text);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-row-target-arrow {
  flex: none;
  color: var(--wb-quiet-text);
}

.wb-row-target-table {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-row-target-key {
  color: var(--wb-secondary-text);
}

.wb-row-target-all {
  flex: none;
  min-height: 20px;
  height: 20px;
  margin-left: auto;
  padding: 0 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--wb-accent-strong);
  font-size: var(--wb-fs-caption);
}

.wb-row-target-all:hover:not(:disabled) {
  background: var(--wb-list-hover);
}

.wb-row-target-values {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.wb-relation-target {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  min-height: 24px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--wb-relation-out-line);
  border-radius: 6px;
  background: var(--wb-relation-out-soft);
  color: var(--wb-text);
  font-size: var(--wb-fs-caption);
  overflow: hidden;
}

.wb-relation-target:hover:not(:disabled) {
  border-color: var(--wb-relation-out);
  background: color-mix(in srgb, var(--wb-relation-out-soft) 70%, var(--wb-control-hover));
}

.wb-relation-target-value {
  flex: none;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--wb-relation-out);
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.wb-relation-target-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relation-target-state {
  flex: none;
  font-weight: 600;
}

/* A broken reference must stay readable, not fade like a disabled button. */
.wb-relation-target.is-missing {
  border-color: var(--wb-danger-border);
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
  opacity: 1;
}

.wb-relation-target.is-missing .wb-relation-target-value {
  color: var(--wb-danger-text);
}

.wb-relation-target.is-unknown {
  border-style: dashed;
  border-color: var(--wb-border-strong);
  background: transparent;
  color: var(--wb-secondary-text);
  opacity: 1;
}

.wb-relation-target.is-unknown .wb-relation-target-value {
  color: var(--wb-secondary-text);
}

.wb-relation-target.is-placeholder {
  width: 88px;
  border-color: transparent;
  background: linear-gradient(90deg, var(--wb-list-hover), var(--wb-list-selected), var(--wb-list-hover)) 0 0 / 200% 100%;
  animation: wb-relation-shimmer 1.2s ease-in-out infinite;
}

@keyframes wb-relation-shimmer {
  to {
    background-position: -200% 0;
  }
}

.wb-relations-group-total {
  margin-left: auto;
  color: var(--wb-quiet-text);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .wb-relation-target.is-placeholder {
    animation: none;
  }
}
</style>
