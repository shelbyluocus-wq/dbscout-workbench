<script setup>
import { t } from "../i18n/index.js";
import { computed, ref, useId, watch } from "vue";
import { Check, CheckCircle2, Copy, LoaderCircle, RefreshCw, Search, ShieldAlert, X } from "lucide-vue-next";
import RelationSectionHead from "./RelationSectionHead.vue";
import { formatOrderedRowIdentity } from "../utils/rowIdentity.js";
import { useConfigRelationContext } from "../composables/configRelationContext.js";

const props = defineProps({
  tab: { type: Object, default: null },
  scope: { type: Object, required: true },
  tableName: { type: String, required: true },
  relations: { type: Object, required: true },
  outgoingCount: { type: Number, default: 0 },
});

const relationContext = useConfigRelationContext();
const bodyId = useId();
const open = ref(false);
const loading = ref(false);
const error = ref("");
const result = ref(null);
const filterQuery = ref("");
const copied = ref(false);
let auditToken = 0;
let copiedTimer = 0;

const scopeKey = computed(() => `${props.scope?.connectionId || ""}\u001f${props.scope?.database || ""}\u001f${props.tableName}`);

watch(scopeKey, () => {
  auditToken += 1;
  loading.value = false;
  error.value = "";
  result.value = null;
  filterQuery.value = "";
  open.value = false;
});

const issues = computed(() => (Array.isArray(result.value?.issues) ? result.value.issues : []));
const brokenCount = computed(() => Number(result.value?.brokenCount) || 0);
const showFilter = computed(() => issues.value.length >= 5);

function issueIdentityLabel(issue) {
  return formatOrderedRowIdentity(issue.rowIdentity, {
    primaryKeys: props.tab?.primaryKeys,
    columns: props.tab?.columns,
    emptyLabel: t("relations.audit.rowNumber", { row: (Number(issue.rowIndex) || 0) + 1 }),
  });
}

const filteredIssues = computed(() => {
  const q = filterQuery.value.trim().toLowerCase();
  if (!q) return issues.value;
  return issues.value.filter((issue) => {
    const haystack = [
      issueIdentityLabel(issue),
      issue.rowLabel || "",
      issue.sourceColumn || "",
      issue.missingValue || "",
      issue.targetTable || "",
      issue.targetTableComment || "",
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
});

async function runAudit() {
  if (!props.tableName || !props.outgoingCount) return;
  open.value = true;
  const token = ++auditToken;
  loading.value = true;
  error.value = "";
  try {
    const data = await props.relations.auditTable(props.scope, props.tableName);
    if (token !== auditToken) return;
    result.value = data;
  } catch (err) {
    if (token !== auditToken) return;
    error.value = String(err?.message || err);
  } finally {
    if (token === auditToken) loading.value = false;
  }
}

function handleToggle() {
  if (!open.value && !result.value && !loading.value) {
    void runAudit();
    return;
  }
  open.value = !open.value;
}

function locateIssue(issue) {
  if (!issue?.sourceColumn) return;
  void relationContext?.locateAuditCell?.({
    tableName: props.tableName,
    rowIdentity: issue.rowIdentity,
    columnName: issue.sourceColumn,
  });
}

async function copyReport() {
  if (!issues.value.length) return;
  const header = ["Row", "Name", "Column", "MissingValue", "TargetTable", "TargetColumn"].join("\t");
  const lines = issues.value.map((issue) => [
    issueIdentityLabel(issue),
    issue.rowLabel || "",
    issue.sourceColumn || "",
    issue.missingValue || "",
    issue.targetTable || "",
    issue.targetColumn || "",
  ].join("\t"));
  const text = [header, ...lines].join("\n");
  try {
    await globalThis.navigator?.clipboard?.writeText?.(text);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1400);
  } catch {
    // Ignore clipboard rejection in restricted contexts.
  }
}
</script>

<template>
  <section v-if="outgoingCount > 0" class="wb-relations-block wb-audit-block">
    <RelationSectionHead
      :label="t('relations.audit.title')"
      :count="result ? brokenCount : null"
      :open="open"
      :controls="bodyId"
      @toggle="handleToggle"
    >
      <button
        type="button"
        class="wb-audit-run-btn"
        :disabled="loading"
        :title="result ? t('relations.audit.rerun') : t('relations.audit.run')"
        @click.stop="runAudit"
      >
        <LoaderCircle v-if="loading" :size="12" class="wb-relations-spin" aria-hidden="true" />
        <RefreshCw v-else-if="result" :size="12" aria-hidden="true" />
        <ShieldAlert v-else :size="12" aria-hidden="true" />
        <span>{{ loading ? t('relations.audit.scanning') : (result ? t('relations.audit.rerun') : t('relations.audit.run')) }}</span>
      </button>
    </RelationSectionHead>

    <div v-show="open" :id="bodyId" class="wb-relations-block-body wb-audit-body">
      <p v-if="error" class="wb-relations-error" role="alert">{{ error }}</p>

      <div v-else-if="loading && !result" class="wb-audit-status is-loading" role="status">
        <LoaderCircle :size="13" class="wb-relations-spin" aria-hidden="true" />
        <span>{{ t('relations.audit.scanning') }}</span>
      </div>

      <template v-else-if="result">
        <div
          v-if="brokenCount === 0"
          class="wb-audit-status is-healthy"
          role="status"
        >
          <CheckCircle2 :size="14" aria-hidden="true" />
          <span>{{ t('relations.audit.healthy', { refs: result.checkedReferences, rows: result.scannedRows }) }}</span>
        </div>

        <template v-else>
          <div class="wb-audit-summary-row">
            <span class="wb-audit-broken-summary">
              <ShieldAlert :size="13" aria-hidden="true" />
              <span>{{ t('relations.audit.brokenSummary', { broken: brokenCount, refs: result.checkedReferences }) }}</span>
            </span>
            <button
              type="button"
              class="wb-audit-copy-btn"
              :class="{ 'is-copied': copied }"
              @click="copyReport"
            >
              <Check v-if="copied" :size="11" aria-hidden="true" />
              <Copy v-else :size="11" aria-hidden="true" />
              <span>{{ copied ? t('cellDetail.copied') : t('relations.audit.copyList') }}</span>
            </button>
          </div>

          <label v-if="showFilter" class="wb-audit-filter">
            <Search :size="12" aria-hidden="true" />
            <input
              v-model="filterQuery"
              type="text"
              :placeholder="t('relations.audit.filterPlaceholder')"
              :aria-label="t('relations.audit.filterPlaceholder')"
            />
            <button
              v-if="filterQuery"
              type="button"
              class="wb-audit-filter-clear"
              :aria-label="t('m_ee32f25f7050')"
              @click="filterQuery = ''"
            ><X :size="11" aria-hidden="true" /></button>
          </label>

          <p v-if="filterQuery.trim() && !filteredIssues.length" class="wb-audit-empty">
            {{ t('relations.audit.noFilterMatch') }}
          </p>

          <div v-else class="wb-audit-issue-list">
            <button
              v-for="(issue, index) in filteredIssues"
              :key="`${issue.relationId}:${issue.rowIndex}:${issue.missingValue}:${index}`"
              type="button"
              class="wb-audit-issue-item"
              :title="t('relations.audit.jumpHint')"
              @click="locateIssue(issue)"
            >
              <div class="wb-audit-issue-top">
                <span class="wb-audit-issue-pk">{{ issueIdentityLabel(issue) }}</span>
                <span v-if="issue.rowLabel" class="wb-audit-issue-label">{{ issue.rowLabel }}</span>
              </div>
              <div class="wb-audit-issue-detail">
                <span class="wb-audit-issue-col">{{ issue.sourceColumn }}</span>
                <span class="wb-audit-issue-missing">{{ issue.missingValue }}</span>
                <span class="wb-audit-issue-arrow" aria-hidden="true">→</span>
                <span class="wb-audit-issue-target">
                  {{ issue.targetTable }}.{{ issue.targetColumn }}<template v-if="issue.targetTableComment">（{{ issue.targetTableComment }}）</template>
                </span>
              </div>
            </button>
          </div>

          <p v-if="result.issuesTruncated || result.rowsTruncated" class="wb-audit-truncated">
            {{ t('relations.audit.truncated', { shown: issues.length, total: brokenCount, rows: result.scannedRows }) }}
          </p>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped>
.wb-audit-run-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  min-height: 22px;
  padding: 0 8px;
  border: 1px solid var(--wb-border);
  border-radius: 5px;
  background: var(--wb-surface);
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-caption);
  cursor: pointer;
}

.wb-audit-run-btn:hover:not(:disabled) {
  border-color: var(--wb-accent);
  color: var(--wb-accent-strong);
  background: var(--wb-accent-soft);
}

.wb-audit-run-btn:disabled {
  color: var(--wb-disabled);
  cursor: default;
}

.wb-audit-body {
  display: grid;
  gap: 6px;
}

.wb-audit-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 6px;
  font-size: var(--wb-fs-caption);
}

.wb-audit-status.is-loading {
  background: var(--wb-surface-subtle, var(--wb-control-hover));
  color: var(--wb-secondary-text);
}

.wb-audit-status.is-healthy {
  background: color-mix(in srgb, var(--wb-success, #16a34a) 12%, transparent);
  color: var(--wb-success-text, var(--wb-text));
}

.wb-audit-summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.wb-audit-broken-summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--wb-danger-text, var(--wb-danger));
  font-size: var(--wb-fs-caption);
  font-weight: 500;
}

.wb-audit-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  min-height: 22px;
  padding: 0 7px;
  border: 1px solid var(--wb-border);
  border-radius: 5px;
  background: transparent;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-caption);
  cursor: pointer;
}

.wb-audit-copy-btn:hover,
.wb-audit-copy-btn.is-copied {
  border-color: var(--wb-accent);
  color: var(--wb-accent-strong);
  background: var(--wb-accent-soft);
}

.wb-audit-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-field-surface);
  color: var(--wb-quiet-text);
}

.wb-audit-filter:focus-within {
  border-color: var(--wb-accent);
}

.wb-audit-filter input {
  flex: 1 1 auto;
  min-width: 0;
  height: 22px;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--wb-text);
  font-size: var(--wb-fs-caption);
}

.wb-audit-filter-clear {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  min-height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--wb-quiet-text);
  cursor: pointer;
}

.wb-audit-filter-clear:hover {
  background: var(--wb-list-hover);
  color: var(--wb-text);
}

.wb-audit-issue-list {
  display: grid;
  gap: 4px;
  max-height: 240px;
  overflow-y: auto;
}

.wb-audit-issue-item {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--wb-danger, #dc2626) 24%, var(--wb-border));
  border-radius: 6px;
  background: color-mix(in srgb, var(--wb-danger, #dc2626) 5%, var(--wb-surface));
  color: var(--wb-text);
  text-align: left;
  cursor: pointer;
}

.wb-audit-issue-item:hover {
  border-color: var(--wb-accent);
  background: var(--wb-list-hover);
}

.wb-audit-issue-top {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.wb-audit-issue-pk {
  flex: 0 0 auto;
  font-family: var(--wb-font-mono);
  font-size: var(--wb-fs-caption);
  font-weight: 600;
  color: var(--wb-text);
}

.wb-audit-issue-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--wb-fs-caption);
  color: var(--wb-secondary-text);
}

.wb-audit-issue-detail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: var(--wb-fs-caption);
  color: var(--wb-secondary-text);
}

.wb-audit-issue-col {
  font-family: var(--wb-font-mono);
  color: var(--wb-text);
}

.wb-audit-issue-missing {
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--wb-danger, #dc2626) 14%, transparent);
  color: var(--wb-danger-text, var(--wb-danger));
  font-family: var(--wb-font-mono);
  font-weight: 600;
}

.wb-audit-issue-arrow {
  color: var(--wb-quiet-text);
}

.wb-audit-issue-target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--wb-quiet-text);
}

.wb-audit-empty,
.wb-audit-truncated {
  margin: 0;
  font-size: var(--wb-fs-caption);
  color: var(--wb-quiet-text);
}
</style>
