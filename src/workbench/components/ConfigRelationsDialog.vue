<script setup>
// 关联复核 dialog: the client code the relations are checked against (the
// recommended folder is applied on its own and the user can still pick
// another) and the relations whose client code changed or disagrees with a
// comment, each with its evidence spelled out. Everything is scoped to the
// current config database.
import { t } from "../i18n/index.js";
import { computed, onMounted, ref, watch } from "vue";
import { CircleCheck, Folder, FolderSearch, LoaderCircle, RefreshCw, TriangleAlert, X } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import {
  clientDialectLabel,
  relationTitle,
} from "../utils/configRelations.js";
import { createTableMentionIndex } from "../utils/tableMentions.js";
import ConfigRelationCard from "./ConfigRelationCard.vue";

const props = defineProps({
  relations: { type: Object, required: true },
  scope: { type: Object, required: true },
  scopeLabel: { type: String, default: "" },
  supported: { type: Boolean, default: false },
  schema: { type: Array, default: () => [] },
});

const emit = defineEmits(["close", "open-table"]);

const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), null, { dialogRef });

const entry = computed(() => props.relations.entryFor(props.scope));
const overview = computed(() => entry.value?.overview || null);
const entryError = computed(() => entry.value?.error || "");
const totals = computed(() => overview.value?.totals || null);

// ── review list ────────────────────────────────────────────────

const reviewItems = ref([]);
const reviewTables = ref({});
const reviewLoading = ref(false);
const reviewLoaded = ref(false);
const reviewError = ref("");
const pendingIds = ref(new Set());
const confirmAllBusy = ref(false);
let reviewToken = 0;

async function loadReviewList() {
  if (!props.supported) return;
  const token = ++reviewToken;
  reviewLoading.value = true;
  try {
    const data = await props.relations.reviewList(props.scope);
    if (token !== reviewToken) return;
    reviewItems.value = data?.items || [];
    reviewTables.value = data?.tables || {};
    reviewError.value = "";
  } catch (error) {
    if (token === reviewToken) reviewError.value = String(error?.message || error);
  } finally {
    if (token === reviewToken) {
      reviewLoading.value = false;
      reviewLoaded.value = true;
    }
  }
}

// Client analysis finishes in the background after binding or refreshing;
// a new index revision means the waiting list may have changed.
watch(() => entry.value?.revision, (next, previous) => {
  if (previous !== undefined && next !== previous) void loadReviewList();
});

const reviewGroups = computed(() => {
  const groups = [
    { status: "conflict", label: t("relations.review.group.conflict") },
    { status: "stale", label: t("relations.review.group.stale") },
  ];
  return groups
    .map((group) => ({ ...group, items: reviewItems.value.filter((item) => item.status === group.status) }))
    .filter((group) => group.items.length);
});

async function submitReview(ids, verdict) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return;
  pendingIds.value = new Set([...pendingIds.value, ...list]);
  try {
    await props.relations.submitReview(props.scope, list, verdict);
    reviewItems.value = reviewItems.value.filter((item) => !list.includes(item.id));
  } catch (error) {
    reviewError.value = String(error?.message || error);
    await loadReviewList();
  } finally {
    const next = new Set(pendingIds.value);
    for (const id of list) next.delete(id);
    pendingIds.value = next;
  }
}

async function confirmAll() {
  if (confirmAllBusy.value || !reviewItems.value.length) return;
  confirmAllBusy.value = true;
  try {
    await submitReview(reviewItems.value.map((item) => item.id), "confirmed");
  } finally {
    confirmAllBusy.value = false;
  }
}

const mentionTables = computed(() => createTableMentionIndex(props.schema, props.scope));

function openNamedTable(table) {
  if (!table?.name) return;
  emit("open-table", {
    connectionId: props.scope.connectionId,
    database: props.scope.database,
    tableName: table.name,
    tableComment: table.comment || "",
  });
}

// ── client binding ─────────────────────────────────────────────

const client = computed(() => overview.value?.client || null);
const autoBinding = computed(() => Boolean(entry.value?.autoBinding));
const codeStatus = computed(() => overview.value?.codeStatus || "noClient");
const analyzing = computed(() => Boolean(overview.value?.refreshing || overview.value?.analyzing));
const candidates = ref([]);
const discovering = ref(false);
const discoverError = ref("");
const bindBusyPath = ref("");
const bindError = ref("");

// One word for where the client code stands, beside the section title.
const CLIENT_STATES = Object.freeze({
  ready: "is-ready",
  pending: "is-pending",
  noClient: "is-idle",
  clientMissing: "is-problem",
  failed: "is-problem",
});
const clientStateClass = computed(() => CLIENT_STATES[codeStatus.value] || "is-idle");

async function discover() {
  if (!props.supported) return;
  discovering.value = true;
  discoverError.value = "";
  try {
    candidates.value = await props.relations.discoverClients(props.scope) || [];
  } catch (error) {
    candidates.value = [];
    discoverError.value = String(error?.message || error);
  } finally {
    discovering.value = false;
  }
}

async function bind(path) {
  const value = String(path || "").trim();
  if (!value || bindBusyPath.value) return;
  bindBusyPath.value = value;
  bindError.value = "";
  try {
    await props.relations.bindClient(props.scope, value);
    await loadReviewList();
  } catch (error) {
    bindError.value = String(error?.message || error);
  } finally {
    bindBusyPath.value = "";
  }
}

async function pickAndBind() {
  bindError.value = "";
  try {
    const path = await props.relations.pickClientDir();
    if (!path) return;
    await bind(path);
  } catch (error) {
    bindError.value = String(error?.message || error);
  }
}

async function unbind() {
  if (bindBusyPath.value) return;
  bindBusyPath.value = client.value?.path || "-";
  bindError.value = "";
  try {
    await props.relations.unbindClient(props.scope);
    await loadReviewList();
    await discover();
  } catch (error) {
    bindError.value = String(error?.message || error);
  } finally {
    bindBusyPath.value = "";
  }
}

async function reanalyze() {
  try {
    await props.relations.refresh(props.scope);
  } catch (error) {
    reviewError.value = String(error?.message || error);
  }
}

function coverageRatio(candidate) {
  const total = Number(candidate?.totalTables) || 0;
  return total ? Math.min(1, Math.max(0, (Number(candidate.matchedTables) || 0) / total)) : 0;
}

// A recommendation that does not fit falls back to the manual list. A choice
// the user is already making must not be replaced by that list mid-click.
function showManualFolders() {
  if (client.value || autoBinding.value || entry.value?.loading || bindBusyPath.value || discovering.value) return;
  void discover();
}

watch(autoBinding, (binding, previous) => {
  if (previous && !binding) showManualFolders();
});

watch(() => entry.value?.loading, (loading, previous) => {
  if (previous && !loading) showManualFolders();
});

onMounted(async () => {
  if (!props.supported) return;
  const current = await props.relations.loadOverview(props.scope);
  if (!current?.client && !entry.value?.autoBinding && !entry.value?.loading) await discover();
  await loadReviewList();
});
</script>

<template>
  <div class="wb-dialog-overlay">
    <section
      ref="dialogRef"
      class="wb-dialog wb-relations-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wb-relations-dialog-title"
      tabindex="-1"
    >
      <header class="wb-relations-dialog-header">
        <div class="wb-relations-dialog-heading">
          <h2 id="wb-relations-dialog-title">{{ t('relations.dialog.title') }}</h2>
          <p>{{ scopeLabel }}</p>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          :aria-label="t('m_3da29c4a3338')"
          @click="emit('close')"
        >
          <X :size="16" aria-hidden="true" />
        </button>
      </header>

      <div v-if="supported && totals" class="wb-relations-dialog-stats">
        <span class="wb-relations-stat"><strong>{{ totals.total }}</strong>{{ t('relations.stats.total') }}</span>
        <span class="wb-relations-stat is-confirmed"><strong>{{ totals.confirmed }}</strong>{{ t('relations.stats.confirmed') }}</span>
        <span v-if="totals.unconfirmed" class="wb-relations-stat"><strong>{{ totals.unconfirmed }}</strong>{{ t('relations.stats.unconfirmed') }}</span>
        <span class="wb-relations-stat" :class="{ 'is-review': reviewItems.length }"><strong>{{ reviewItems.length }}</strong>{{ t('relations.stats.review') }}</span>
        <span v-if="totals.rejected" class="wb-relations-stat is-muted"><strong>{{ totals.rejected }}</strong>{{ t('relations.stats.rejected') }}</span>
      </div>

      <div class="wb-relations-dialog-body">
        <div v-if="!supported" class="wb-relations-dialog-empty">
          <TriangleAlert :size="22" :stroke-width="1.6" aria-hidden="true" />
          <span>{{ t('relations.unsupported') }}</span>
        </div>

        <template v-else>
          <section class="wb-relations-dialog-section">
            <div class="wb-relations-dialog-section-head">
              <h3>{{ t('relations.client.title') }}</h3>
              <span class="wb-relations-client-state" :class="clientStateClass">
                <LoaderCircle v-if="analyzing" :size="11" class="wb-relations-spin" aria-hidden="true" />
                {{ analyzing ? t('relations.refreshing') : t(`relations.client.state.${codeStatus}`) }}
              </span>
            </div>

            <div v-if="client" class="wb-relations-client-card">
              <Folder :size="18" :stroke-width="1.7" class="wb-relations-client-icon" aria-hidden="true" />
              <div class="wb-relations-client-info">
                <div class="wb-relations-client-path">
                  <code :title="client.path">{{ client.path }}</code>
                  <span class="wb-relations-client-tag">{{ clientDialectLabel(client.dialect, t) }}</span>
                  <span v-if="!client.exists" class="wb-relations-client-tag is-missing">{{ t('relations.client.missing') }}</span>
                </div>
                <div class="wb-relations-client-meta">
                  <span>{{ t('relations.client.boundAt', { time: client.confirmedAt }) }}</span>
                  <span v-if="overview?.codeFiles">{{ t('relations.client.files', { count: overview.codeFiles, time: overview.codeScannedAt || '' }) }}</span>
                </div>
                <p v-if="overview?.codeMessage" class="wb-relations-error" role="alert">{{ overview.codeMessage }}</p>
              </div>
              <div class="wb-relations-client-actions">
                <button type="button" class="wb-relations-quiet-btn" :disabled="Boolean(bindBusyPath)" @click="pickAndBind">
                  {{ t('relations.client.change') }}
                </button>
                <button type="button" class="wb-relations-quiet-btn" :disabled="Boolean(bindBusyPath)" @click="unbind">
                  {{ t('relations.client.unbind') }}
                </button>
              </div>
            </div>

            <div v-else class="wb-relations-client-unbound">
              <p class="wb-relations-dialog-lead">{{ t('relations.client.unbound') }}</p>
              <p v-if="autoBinding || discovering" class="wb-relations-dialog-progress" role="status">
                <LoaderCircle :size="13" class="wb-relations-spin" aria-hidden="true" />
                {{ autoBinding ? t('relations.client.applying') : t('relations.client.discovering') }}
              </p>
              <template v-else>
                <article
                  v-for="candidate in candidates"
                  :key="candidate.path"
                  class="wb-relations-candidate"
                  :class="{ 'is-recommended': candidate.recommended }"
                >
                  <FolderSearch :size="17" :stroke-width="1.7" class="wb-relations-client-icon" aria-hidden="true" />
                  <div class="wb-relations-candidate-info">
                    <div class="wb-relations-client-path">
                      <code :title="candidate.path">{{ candidate.path }}</code>
                      <span class="wb-relations-client-tag">{{ clientDialectLabel(candidate.dialect, t) }}</span>
                      <span v-if="candidate.recommended" class="wb-relations-client-tag is-recommended">{{ t('relations.client.recommended') }}</span>
                    </div>
                    <div class="wb-relations-candidate-coverage">
                      <span class="wb-relations-coverage-bar" aria-hidden="true">
                        <span :style="{ width: `${Math.round(coverageRatio(candidate) * 100)}%` }" />
                      </span>
                      <span>{{ t('relations.client.matched', { matched: candidate.matchedTables, total: candidate.totalTables }) }}</span>
                      <span v-if="candidate.updatedAt" class="wb-relations-candidate-time">{{ t('relations.client.updatedAt', { time: candidate.updatedAt }) }}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    class="wb-relations-quiet-btn"
                    :class="{ 'is-primary': candidate.recommended }"
                    :disabled="Boolean(bindBusyPath)"
                    @click="bind(candidate.path)"
                  >{{ bindBusyPath === candidate.path ? t('relations.client.checking') : t('relations.client.useThis') }}</button>
                </article>
                <p v-if="!candidates.length && !discoverError" class="wb-relations-dialog-note">{{ t('relations.client.none') }}</p>
              </template>
              <p v-if="discoverError" class="wb-relations-error" role="alert">{{ discoverError }}</p>
              <div class="wb-relations-client-actions is-start">
                <button type="button" class="wb-relations-quiet-btn" :disabled="Boolean(bindBusyPath) || discovering" @click="pickAndBind">
                  {{ t('relations.client.pick') }}
                </button>
              </div>
            </div>
            <p v-if="bindError" class="wb-relations-error" role="alert">{{ bindError }}</p>
          </section>

          <section class="wb-relations-dialog-section">
            <div class="wb-relations-dialog-section-head">
              <h3>{{ t('relations.review.title') }}</h3>
            </div>
            <p v-if="reviewError" class="wb-relations-error" role="alert">{{ reviewError }}</p>
            <p v-else-if="entryError && !overview" class="wb-relations-error" role="alert">{{ entryError }}</p>
            <div v-if="!reviewLoaded && reviewLoading" class="wb-relations-skeleton" role="status" :aria-label="t('relations.loading')">
              <span v-for="index in 3" :key="index" class="wb-relations-skeleton-line" />
            </div>
            <div v-else-if="!reviewItems.length && !reviewError" class="wb-relations-dialog-empty is-done">
              <CircleCheck :size="24" :stroke-width="1.6" aria-hidden="true" />
              <strong>{{ t('relations.review.empty') }}</strong>
              <span>{{ client ? t('relations.review.emptyHint') : t('relations.review.emptyHintUnbound') }}</span>
            </div>

            <div v-for="group in reviewGroups" :key="group.status" class="wb-relations-review-group">
              <div class="wb-relations-review-group-label" :class="`is-${group.status}`">
                <span class="wb-relations-review-dot" aria-hidden="true" />
                {{ group.label }}
                <span class="wb-relations-dialog-count">{{ group.items.length }}</span>
              </div>
              <ConfigRelationCard
                v-for="item in group.items"
                :key="item.id"
                :relation="item"
                detailed
                :tables="mentionTables"
                :title="relationTitle(item, reviewTables)"
                :title-hint="t('relations.action.openTable')"
                :busy="pendingIds.has(item.id)"
                @open="openNamedTable"
                @review="submitReview(item.id, $event)"
              />
            </div>
          </section>
        </template>
      </div>

      <footer class="wb-relations-dialog-footer">
        <button
          v-if="supported"
          type="button"
          class="wb-relations-footer-btn"
          :disabled="Boolean(overview?.refreshing)"
          @click="reanalyze"
        >
          <RefreshCw :size="13" :class="{ 'wb-relations-spin': overview?.refreshing }" aria-hidden="true" />
          {{ overview?.refreshing ? t('relations.refreshing') : t('relations.refresh') }}
        </button>
        <span class="wb-relations-dialog-footer-spacer" />
        <button type="button" @click="emit('close')">{{ t('m_3fd47edce45b') }}</button>
        <button
          v-if="supported"
          type="button"
          class="wb-dialog-primary"
          :disabled="!reviewItems.length || confirmAllBusy"
          @click="confirmAll"
        >{{ reviewItems.length ? t('relations.action.confirmAllCount', { count: reviewItems.length }) : t('relations.action.confirmAll') }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.wb-relations-dialog {
  display: flex;
  flex-direction: column;
  width: 760px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  padding: 0;
  overflow: hidden;
}

.wb-relations-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 14px 0 20px;
}

.wb-relations-dialog-heading {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.wb-relations-dialog-heading h2 {
  margin: 0;
  color: var(--wb-text);
  font-size: 15px;
  font-weight: 650;
}

.wb-relations-dialog-heading p {
  margin: 0;
  overflow: hidden;
  color: var(--wb-secondary-text);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relations-dialog-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 20px 2px;
}

.wb-relations-stat {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-text) 5%, transparent);
  color: var(--wb-secondary-text);
  font-size: 11px;
}

.wb-relations-stat strong {
  color: var(--wb-text);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.wb-relations-stat.is-confirmed strong {
  color: var(--wb-success-text);
}

.wb-relations-stat.is-review {
  background: var(--wb-warning-surface);
  color: var(--wb-warning-text);
}

.wb-relations-stat.is-review strong {
  color: var(--wb-warning-text);
}

.wb-relations-stat.is-muted strong {
  color: var(--wb-secondary-text);
}

.wb-relations-dialog-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
  padding: 14px 20px 18px;
  overflow: auto;
}

.wb-relations-dialog-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wb-relations-dialog-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wb-relations-dialog-section-head h3 {
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.wb-relations-dialog-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-text) 7%, transparent);
  color: var(--wb-secondary-text);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}

.wb-relations-client-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 18px;
}

.wb-relations-client-state.is-ready {
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}

.wb-relations-client-state.is-pending,
.wb-relations-client-state.is-idle {
  background: color-mix(in srgb, var(--wb-text) 6%, transparent);
  color: var(--wb-secondary-text);
}

.wb-relations-client-state.is-problem {
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
}

.wb-relations-client-card,
.wb-relations-candidate {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--wb-field-surface);
  box-shadow: inset 0 0 0 1px var(--wb-border);
}

.wb-relations-candidate.is-recommended {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wb-accent) 45%, var(--wb-border));
}

.wb-relations-client-icon {
  margin-top: 1px;
  color: var(--wb-secondary-text);
}

.wb-relations-client-info,
.wb-relations-candidate-info {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.wb-relations-client-path {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}

.wb-relations-client-path code {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  color: var(--wb-text);
  font-family: var(--wb-font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relations-client-tag {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-text) 7%, transparent);
  color: var(--wb-secondary-text);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
}

.wb-relations-client-tag.is-recommended {
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
}

.wb-relations-client-tag.is-missing {
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
}

.wb-relations-client-meta,
.wb-relations-candidate-coverage {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 12px;
  color: var(--wb-secondary-text);
  font-size: 11px;
}

.wb-relations-coverage-bar {
  position: relative;
  width: 72px;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-text) 10%, transparent);
}

.wb-relations-coverage-bar > span {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: var(--wb-accent);
}

.wb-relations-candidate-time {
  color: var(--wb-quiet-text);
}

.wb-relations-client-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.wb-relations-client-actions.is-start {
  justify-content: flex-start;
}

.wb-relations-client-unbound {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wb-relations-dialog-lead,
.wb-relations-dialog-note,
.wb-relations-dialog-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 12px;
  line-height: 1.55;
}

.wb-relations-dialog-note {
  color: var(--wb-quiet-text);
  font-size: 11px;
}

.wb-relations-quiet-btn {
  min-height: 26px;
  height: 26px;
  padding: 0 10px;
  font-size: 11px;
  white-space: nowrap;
}

.wb-relations-quiet-btn.is-primary {
  border-color: var(--wb-accent-control);
  background: var(--wb-accent-control);
  color: var(--wb-accent-control-text);
}

.wb-relations-quiet-btn.is-primary:hover:not(:disabled) {
  border-color: var(--wb-accent-control-hover);
  background: var(--wb-accent-control-hover);
}

.wb-relations-review-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wb-relations-review-group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--wb-text);
  font-size: 12px;
  font-weight: 600;
}

.wb-relations-review-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--wb-warning-border);
}

.wb-relations-review-group-label.is-conflict .wb-relations-review-dot {
  background: var(--wb-danger);
}

.wb-relations-dialog-empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 22px 16px;
  border-radius: 8px;
  background: var(--wb-field-surface);
  box-shadow: inset 0 0 0 1px var(--wb-line);
  color: var(--wb-secondary-text);
  font-size: 12px;
  text-align: center;
}

.wb-relations-dialog-empty strong {
  color: var(--wb-text);
  font-size: 13px;
  font-weight: 600;
}

.wb-relations-dialog-empty.is-done svg {
  color: var(--wb-success-text);
}

.wb-relations-dialog-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--wb-line);
}

.wb-relations-dialog-footer-spacer {
  flex: 1 1 auto;
}

.wb-relations-footer-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
