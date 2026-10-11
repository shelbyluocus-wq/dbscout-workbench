<script setup>
// 关联复核 dialog: binds the game client folder for the current MySQL server
// and lists the relations still waiting for a person (stale, conflicting,
// unconfirmed). Everything is scoped to the currently selected config database.
import { t } from "../i18n/index.js";
import { computed, onMounted, ref, watch } from "vue";
import { LoaderCircle, RefreshCw, X } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import {
  clientDialectLabel,
  relationTitle,
  tableDisplayComment,
  tableDisplayName,
} from "../utils/configRelations.js";
import ConfigRelationCard from "./ConfigRelationCard.vue";

const props = defineProps({
  relations: { type: Object, required: true },
  scope: { type: Object, required: true },
  scopeLabel: { type: String, default: "" },
  supported: { type: Boolean, default: false },
});

const emit = defineEmits(["close", "open-table"]);

const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), null, { dialogRef });

const entry = computed(() => props.relations.entryFor(props.scope));
const overview = computed(() => entry.value?.overview || null);
const entryError = computed(() => entry.value?.error || "");

// ── review list ────────────────────────────────────────────────

const reviewItems = ref([]);
const reviewTables = ref({});
const reviewLoading = ref(false);
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
    if (token === reviewToken) reviewLoading.value = false;
  }
}

// Client analysis finishes in the background after binding or refreshing;
// a new index revision means the waiting list may have changed.
watch(() => entry.value?.revision, (next, previous) => {
  if (previous !== undefined && next !== previous) void loadReviewList();
});

const reviewGroups = computed(() => {
  const groups = [
    { status: "stale", label: t("relations.review.group.stale") },
    { status: "conflict", label: t("relations.review.group.conflict") },
    { status: "unconfirmed", label: t("relations.review.group.unconfirmed") },
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

function openSourceTable(item) {
  emit("open-table", {
    connectionId: props.scope.connectionId,
    database: props.scope.database,
    tableName: tableDisplayName(reviewTables.value, item.sourceTable),
    tableComment: tableDisplayComment(reviewTables.value, item.sourceTable),
  });
}

// ── client binding ─────────────────────────────────────────────

const client = computed(() => overview.value?.client || null);
const codeStatus = computed(() => overview.value?.codeStatus || "noClient");
const candidates = ref([]);
const discovering = ref(false);
const discoverError = ref("");
const bindBusyPath = ref("");
const bindError = ref("");

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

onMounted(async () => {
  if (!props.supported) return;
  const current = await props.relations.loadOverview(props.scope);
  if (!current?.client) await discover();
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
      <header class="wb-dialog-header wb-relations-dialog-header">
        <div>
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

      <div class="wb-relations-dialog-body">
        <p v-if="!supported" class="wb-relations-muted">{{ t('relations.unsupported') }}</p>

        <template v-else>
          <section class="wb-relations-client">
            <div class="wb-relations-client-head">
              <span class="wb-relations-section-label">{{ t('relations.client.title') }}</span>
              <span v-if="overview?.refreshing || overview?.analyzing" class="wb-relations-muted">
                <LoaderCircle :size="12" class="wb-relations-spin" aria-hidden="true" />
                {{ t('relations.refreshing') }}
              </span>
            </div>

            <div v-if="client" class="wb-relations-client-bound">
              <div class="wb-relations-client-path" :title="client.path">
                <strong>{{ client.path }}</strong>
                <span class="wb-relations-client-dialect">{{ clientDialectLabel(client.dialect, t) }}</span>
                <span v-if="!client.exists" class="wb-relations-client-missing">{{ t('relations.client.missing') }}</span>
              </div>
              <div class="wb-relations-client-meta wb-relations-muted">
                <span>{{ t('relations.client.boundAt', { time: client.confirmedAt }) }}</span>
                <span v-if="overview?.codeFiles">{{ t('relations.client.files', { count: overview.codeFiles, time: overview.codeScannedAt || '' }) }}</span>
              </div>
              <p v-if="overview?.codeMessage" class="wb-relations-error" role="alert">{{ overview.codeMessage }}</p>
              <div class="wb-relations-client-actions">
                <button type="button" class="wb-relations-action" :disabled="Boolean(bindBusyPath)" @click="pickAndBind">
                  {{ t('relations.client.pick') }}
                </button>
                <button type="button" class="wb-relations-action" :disabled="Boolean(bindBusyPath)" @click="unbind">
                  {{ t('relations.client.unbind') }}
                </button>
              </div>
            </div>

            <div v-else class="wb-relations-client-unbound">
              <p class="wb-relations-muted">{{ t('relations.client.unbound') }}</p>
              <p v-if="discovering" class="wb-relations-muted">
                <LoaderCircle :size="12" class="wb-relations-spin" aria-hidden="true" />
                {{ t('relations.client.discovering') }}
              </p>
              <template v-else>
                <article
                  v-for="candidate in candidates"
                  :key="candidate.path"
                  class="wb-relations-candidate"
                >
                  <div class="wb-relations-candidate-info">
                    <strong class="wb-relations-candidate-path" :title="candidate.path">{{ candidate.path }}</strong>
                    <span class="wb-relations-muted">
                      {{ clientDialectLabel(candidate.dialect, t) }}
                      · {{ t('relations.client.matched', { matched: candidate.matchedTables, total: candidate.totalTables }) }}
                      <template v-if="candidate.updatedAt"> · {{ t('relations.client.updatedAt', { time: candidate.updatedAt }) }}</template>
                    </span>
                  </div>
                  <span v-if="candidate.recommended" class="wb-relations-recommended">{{ t('relations.client.recommended') }}</span>
                  <button
                    type="button"
                    class="wb-relations-action is-confirm"
                    :disabled="Boolean(bindBusyPath)"
                    @click="bind(candidate.path)"
                  >{{ bindBusyPath === candidate.path ? t('relations.client.checking') : t('relations.client.useThis') }}</button>
                </article>
                <p v-if="!candidates.length && !discoverError" class="wb-relations-muted">{{ t('relations.client.none') }}</p>
              </template>
              <p v-if="discoverError" class="wb-relations-error" role="alert">{{ discoverError }}</p>
              <div class="wb-relations-client-actions">
                <button type="button" class="wb-relations-action" :disabled="Boolean(bindBusyPath) || discovering" @click="pickAndBind">
                  {{ t('relations.client.pick') }}
                </button>
              </div>
            </div>
            <p v-if="bindError" class="wb-relations-error" role="alert">{{ bindError }}</p>
          </section>

          <section class="wb-relations-review">
            <p v-if="reviewError" class="wb-relations-error" role="alert">{{ reviewError }}</p>
            <p v-else-if="entryError && !overview" class="wb-relations-error" role="alert">{{ entryError }}</p>
            <p v-else-if="reviewLoading && !reviewItems.length" class="wb-relations-muted">{{ t('relations.loading') }}</p>
            <p v-else-if="!reviewItems.length" class="wb-relations-muted">{{ t('relations.review.empty') }}</p>

            <div v-for="group in reviewGroups" :key="group.status" class="wb-relations-review-group">
              <div class="wb-relations-section-label">{{ group.label }} · {{ group.items.length }}</div>
              <ConfigRelationCard
                v-for="item in group.items"
                :key="item.id"
                :relation="item"
                :title="relationTitle(item, reviewTables)"
                :title-hint="t('relations.action.openTable')"
                openable
                :busy="pendingIds.has(item.id)"
                @open="openSourceTable(item)"
                @review="submitReview(item.id, $event)"
              />
            </div>
          </section>
        </template>
      </div>

      <footer class="wb-dialog-actions wb-relations-dialog-footer">
        <button type="button" @click="emit('close')">{{ t('m_3fd47edce45b') }}</button>
        <span v-if="supported">
          <button
            type="button"
            class="wb-relations-footer-btn"
            :disabled="!supported || Boolean(overview?.refreshing)"
            @click="reanalyze"
          >
            <RefreshCw :size="12" aria-hidden="true" />
            {{ overview?.refreshing ? t('relations.refreshing') : t('relations.refresh') }}
          </button>
          <button
            type="button"
            class="wb-dialog-primary"
            :disabled="!reviewItems.length || confirmAllBusy"
            @click="confirmAll"
          >{{ t('relations.action.confirmAll') }}</button>
        </span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.wb-relations-dialog {
  display: flex;
  flex-direction: column;
  width: 720px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  overflow: hidden;
  padding-top: 10px;
}

.wb-relations-dialog-header {
  align-items: flex-start;
  margin-bottom: 8px;
}

.wb-relations-dialog-header h2 {
  font-size: 16px;
}

.wb-relations-dialog-header p {
  font-size: 13px;
}

.wb-relations-dialog-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 4px 16px 12px;
  overflow: auto;
}

.wb-relations-section-label {
  color: var(--wb-secondary-text);
  font-size: 11px;
  font-weight: 620;
}

.wb-relations-client {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-field-surface);
}

.wb-relations-client-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wb-relations-client-bound,
.wb-relations-client-unbound {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-relations-client-path {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
}

.wb-relations-client-path strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relations-client-dialect {
  flex: 0 0 auto;
  color: var(--wb-secondary-text);
  font-size: 11.5px;
}

.wb-relations-client-missing {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
  font-size: 10.5px;
  font-weight: 650;
  line-height: 16px;
}

.wb-relations-client-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.wb-relations-client-actions {
  display: flex;
  gap: 6px;
}

.wb-relations-candidate {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-control);
}

.wb-relations-candidate-info {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wb-relations-candidate-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

.wb-relations-recommended {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  font-size: 10.5px;
  font-weight: 650;
  line-height: 16px;
}

.wb-relations-review {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wb-relations-review-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-relations-muted {
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 12px;
}

.wb-relations-error {
  margin: 0;
  color: var(--wb-danger);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.wb-relations-spin {
  vertical-align: -2px;
  animation: wb-relations-rotate 1s linear infinite;
}

@keyframes wb-relations-rotate {
  to {
    transform: rotate(360deg);
  }
}

.wb-relations-dialog-footer {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.wb-relations-dialog-footer > span {
  display: inline-flex;
  gap: 8px;
}

.wb-relations-footer-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
