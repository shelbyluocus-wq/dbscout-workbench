<script setup>
// The inspector's relation page: the selected row's references, a map of the
// tables around this one, and the table's field relations. Problems that need
// the user (no client code bound, analysis running) show as one slim notice
// on top; softer coverage notes sit at the bottom with the way into review.
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ChevronRight, Info, LoaderCircle, Network, TriangleAlert } from "lucide-vue-next";
import { coverageGapText } from "../utils/configRelations.js";
import { loadRelationPanelSections, saveRelationPanelSections } from "../utils/relationPanelPrefs.js";
import { provideCommentTips } from "../composables/commentTips.js";
import ConfigRelationRowSection from "./ConfigRelationRowSection.vue";
import ConfigRelationAuditSection from "./ConfigRelationAuditSection.vue";
import ConfigRelationTableSection from "./ConfigRelationTableSection.vue";
import ConfigRelationGraphSection from "./ConfigRelationGraphSection.vue";

const props = defineProps({
  tab: { type: Object, default: null },
  selectedCell: { type: Object, default: null },
  relations: { type: Object, required: true },
  // Tables that exist in this tab's database. Mentioned names link only here.
  mentionTables: { type: Object, default: null },
});

const emit = defineEmits(["open-relation", "open-review", "open-table"]);
provideCommentTips();

const scope = computed(() => ({
  connectionId: String(props.tab?.connectionId || ""),
  database: String(props.tab?.database || ""),
}));
const scopeKey = computed(() => `${scope.value.connectionId}\u001f${scope.value.database.toLowerCase()}`);
const entry = computed(() => props.relations.entryFor(scope.value));
const overview = computed(() => entry.value?.overview || null);
const revision = computed(() => Number(entry.value?.revision) || 0);
const tableName = computed(() => String(props.tab?.tableName || ""));

const sections = reactive(loadRelationPanelSections());
watch(sections, () => saveRelationPanelSections(sections), { deep: true });

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
  tableData.value = null;
  void props.relations.loadOverview(scope.value);
  void loadTableRelations();
}, { immediate: true });

// A backend rebuild bumps the revision; the lists follow it while the last
// picture stays on screen.
watch(revision, () => {
  void loadTableRelations();
});

onBeforeUnmount(() => {
  tableToken += 1;
});

const tables = computed(() => tableData.value?.tables || {});
const outgoingRelations = computed(() => tableData.value?.outgoing || []);
const incomingRelations = computed(() => tableData.value?.incoming || []);
const hasRelations = computed(() => outgoingRelations.value.length + incomingRelations.value.length > 0);

// ── notices ────────────────────────────────────────────────────

const ACTION_GAPS = new Set(["noClient", "clientMissing", "scanFailed"]);
const CODE_STATUS_GAPS = Object.freeze({ noClient: "noClient", clientMissing: "clientMissing", failed: "scanFailed" });
const gaps = computed(() => tableData.value?.coverage?.gaps || []);
// Something the user can fix: bind (or re-bind) the client folder.
const actionGap = computed(() => {
  const gap = gaps.value.find((item) => ACTION_GAPS.has(item?.code));
  if (gap) return gap;
  const code = CODE_STATUS_GAPS[overview.value?.codeStatus];
  return code ? { code, message: overview.value?.codeMessage || "" } : null;
});
const actionNotice = computed(() => (actionGap.value ? coverageGapText(actionGap.value, t) : ""));
const actionLabel = computed(() => (actionGap.value?.code === "scanFailed" ? t("relations.notice.details") : t("relations.notice.bind")));
const analyzing = computed(() => Boolean(overview.value?.analyzing) || gaps.value.some((gap) => gap?.code === "analyzing"));
// Informational limits of what the list can know.
const footnotes = computed(() => gaps.value
  .filter((gap) => !ACTION_GAPS.has(gap?.code) && gap?.code !== "analyzing")
  .map((gap) => coverageGapText(gap, t))
  .filter(Boolean));
const reviewCount = computed(() => Number(overview.value?.reviewCount) || 0);

// ── review actions ─────────────────────────────────────────────

const pendingReview = ref(new Set());
const reviewError = ref("");

async function submitReview(relation, verdict) {
  if (pendingReview.value.has(relation.id)) return;
  pendingReview.value = new Set([...pendingReview.value, relation.id]);
  reviewError.value = "";
  try {
    await props.relations.submitReview(scope.value, [relation.id], verdict);
    await loadTableRelations();
  } catch (error) {
    reviewError.value = String(error?.message || error);
  } finally {
    const done = new Set(pendingReview.value);
    done.delete(relation.id);
    pendingReview.value = done;
  }
}

function openNamedTable(table) {
  if (!table?.name) return;
  emit("open-table", {
    connectionId: scope.value.connectionId,
    database: scope.value.database,
    tableName: table.name,
    tableComment: table.comment || "",
  });
}
</script>

<template>
  <div class="wb-relations-panel">
    <div v-if="actionNotice" class="wb-relations-notice is-warning" role="status">
      <TriangleAlert :size="14" class="wb-relations-notice-icon" aria-hidden="true" />
      <span class="wb-relations-notice-text">{{ actionNotice }}</span>
      <button type="button" class="wb-relations-notice-action" @click="emit('open-review')">{{ actionLabel }}</button>
    </div>
    <div v-else-if="analyzing" class="wb-relations-notice is-info" role="status">
      <LoaderCircle :size="13" class="wb-relations-notice-icon wb-relations-spin" aria-hidden="true" />
      <span class="wb-relations-notice-text">{{ t('relations.gap.analyzing') }}</span>
    </div>

    <p v-if="tableError" class="wb-relations-error" role="alert">{{ tableError }}</p>

    <div v-else-if="!tableData && tableLoading" class="wb-relations-skeleton" role="status" :aria-label="t('relations.loading')">
      <span v-for="index in 4" :key="index" class="wb-relations-skeleton-line" />
    </div>

    <template v-else-if="tableData">
      <template v-if="hasRelations">
        <ConfigRelationRowSection
          :tab="tab"
          :selected-cell="selectedCell"
          :relations="relations"
          :scope="scope"
          :outgoing="outgoingRelations"
          :incoming="incomingRelations"
          :tables="tables"
          :mention-tables="mentionTables"
          :revision="revision"
          :open="sections.row"
          @toggle="sections.row = !sections.row"
          @open-relation="emit('open-relation', $event)"
          @open-table="openNamedTable"
        />

        <ConfigRelationAuditSection
          :tab="tab"
          :scope="scope"
          :table-name="tableName"
          :relations="relations"
          :outgoing-count="outgoingRelations.filter((rel) => rel.status !== 'rejected').length"
        />

        <ConfigRelationGraphSection
          :scope="scope"
          :table-name="tableName"
          :relations="relations"
          :revision="revision"
          @open-table="openNamedTable"
        />

        <ConfigRelationTableSection
          :outgoing="outgoingRelations"
          :incoming="incomingRelations"
          :tables="tables"
          :mention-tables="mentionTables"
          :pending-review="pendingReview"
          :open="sections.table"
          :rejected-open="sections.rejected"
          @toggle="sections.table = !sections.table"
          @toggle-rejected="sections.rejected = !sections.rejected"
          @open-table="openNamedTable"
          @review="submitReview"
        />
        <p v-if="reviewError" class="wb-relations-error" role="alert">{{ reviewError }}</p>
      </template>

      <div v-else class="wb-relations-empty">
        <Network :size="22" :stroke-width="1.6" class="wb-relations-empty-icon" aria-hidden="true" />
        <strong>{{ t('relations.table.empty') }}</strong>
        <span>{{ t('relations.table.emptyHint') }}</span>
      </div>

      <footer class="wb-relations-footer">
        <p v-for="line in footnotes" :key="line" class="wb-relations-footnote">
          <Info :size="12" aria-hidden="true" />
          <span>{{ line }}</span>
        </p>
        <button type="button" class="wb-relations-manage" @click="emit('open-review')">
          <span>{{ t('relations.footer.manage') }}</span>
          <span v-if="reviewCount" class="wb-relations-manage-badge">{{ t('relations.footer.pending', { count: reviewCount }) }}</span>
          <ChevronRight :size="12" :stroke-width="2.2" aria-hidden="true" />
        </button>
      </footer>
    </template>
  </div>
</template>
