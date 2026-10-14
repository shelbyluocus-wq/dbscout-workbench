<script setup>
// The relation graph in full screen: it covers the whole window, stretches
// its rings to use the room, names the fields of the active table's lines and
// shows comments under table names. It can widen from the table's
// neighbourhood to the whole database; a pinned table can become the new
// center to explore further without leaving, and the way back is one button.
// Esc or the exit button closes it; opening a table closes it too.
import { t } from "../i18n/index.js";
import { computed, ref, watch } from "vue";
import { ArrowLeft, Minimize2, Network } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import { useGraphDepthNotice } from "../composables/useGraphDepthNotice.js";
import { tableDisplayComment, tableDisplayName } from "../utils/configRelations.js";
import { GRAPH_MAX_DEPTH, databaseRelationGraph, graphStatuses, localRelationGraph } from "../utils/relationGraph.js";
import ConfigRelationGraphView from "./ConfigRelationGraphView.vue";
import ConfigRelationGraphSegment from "./ConfigRelationGraphSegment.vue";
import ConfigRelationGraphLegend from "./ConfigRelationGraphLegend.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  theme: { type: String, default: "light" },
  // The database's whole relation graph ({ edges, tables }).
  graphData: { type: Object, default: null },
  // The table open in the tab; the view starts centered on it.
  tableName: { type: String, default: "" },
  // Shared depth/direction options (persisted by the section).
  options: { type: Object, required: true },
  // Scope part of the layout memory key.
  scopeKey: { type: String, default: "" },
});

const emit = defineEmits(["close", "open-table", "set-depth", "toggle-direction"]);

const dialogRef = ref(null);
useEscClose(() => props.open, () => emit("close"), null, { dialogRef });

const home = computed(() => String(props.tableName || "").toLowerCase());
const centerId = ref(home.value);
// "local": the center's neighbourhood; "database": every table with relations.
const scope = ref("local");

// Every opening starts from the tab's table.
watch(() => [props.open, home.value], ([open]) => {
  if (!open) return;
  centerId.value = home.value;
  scope.value = "local";
}, { immediate: true });

const tables = computed(() => props.graphData?.tables || {});
const wholeDatabase = computed(() => scope.value === "database");
const local = computed(() => {
  if (!props.graphData) return null;
  if (wholeDatabase.value) return databaseRelationGraph(props.graphData, home.value);
  return centerId.value ? localRelationGraph(props.graphData, centerId.value, props.options) : null;
});
const notice = useGraphDepthNotice(local);
const statuses = computed(() => graphStatuses(local.value));
const centerName = computed(() => tableDisplayName(tables.value, centerId.value));
const centerComment = computed(() => tableDisplayComment(tables.value, centerId.value));
const explored = computed(() => !wholeDatabase.value && centerId.value !== home.value);
const layoutKey = computed(() => (wholeDatabase.value
  ? `${props.scopeKey}\u001f\u001fdatabase`
  : `${props.scopeKey}\u001f${centerId.value}`));
const scopeOptions = computed(() => [
  { value: "local", label: t("relations.graph.scopeLocal") },
  { value: "database", label: t("relations.graph.scopeDatabase") },
]);
const depthOptions = computed(() => Array.from({ length: GRAPH_MAX_DEPTH }, (_, index) => ({
  value: index + 1,
  label: t(`relations.graph.depth${index + 1}`),
})));

function openTable(target) {
  emit("open-table", target);
  emit("close");
}

// "Center on this table": its neighbourhood, from either scope.
function focusTable({ id }) {
  if (!id) return;
  centerId.value = id;
  scope.value = "local";
}

function goHome() {
  centerId.value = home.value;
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && local"
      class="wb-relation-graph-fullscreen wb-floating-themed"
      :data-theme="theme"
      @contextmenu.prevent
    >
      <section
        ref="dialogRef"
        class="wb-relation-graph-fullscreen-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-relation-graph-fullscreen-title"
        tabindex="-1"
      >
        <header class="wb-relation-graph-fullscreen-head">
          <div class="wb-relation-graph-fullscreen-title">
            <Network :size="16" :stroke-width="1.8" aria-hidden="true" />
            <strong id="wb-relation-graph-fullscreen-title">{{
              wholeDatabase ? t('relations.graph.databaseTitle') : t('relations.graph.expandedTitle', { name: centerName })
            }}</strong>
            <span v-if="wholeDatabase" class="wb-relation-graph-fullscreen-comment">{{
              t('relations.graph.databaseSummary', { tables: local.nodes.length, links: local.links.length })
            }}</span>
            <span v-else-if="centerComment" class="wb-relation-graph-fullscreen-comment">{{ centerComment }}</span>
            <button
              v-if="explored"
              type="button"
              class="wb-relation-graph-fullscreen-back"
              @click="goHome"
            >
              <ArrowLeft :size="13" aria-hidden="true" />{{ t('relations.graph.backTo', { name: tableDisplayName(tables, home) }) }}
            </button>
          </div>
          <div class="wb-relation-graph-fullscreen-tools">
            <ConfigRelationGraphLegend
              :statuses="statuses"
              :hidden="local.hidden"
              :outgoing="options.outgoing"
              :incoming="options.incoming"
              :switchable="!wholeDatabase"
              :hidden-key="wholeDatabase ? 'relations.graph.hiddenDatabase' : 'relations.graph.hidden'"
              @toggle-direction="emit('toggle-direction', $event)"
            />
            <ConfigRelationGraphSegment
              v-if="!wholeDatabase"
              :options="depthOptions"
              :value="options.depth"
              :label="t('relations.graph.depth')"
              @select="emit('set-depth', $event)"
            />
            <ConfigRelationGraphSegment
              :options="scopeOptions"
              :value="scope"
              :label="t('relations.graph.scope')"
              @select="scope = $event"
            />
            <button
              type="button"
              class="wb-relation-graph-fullscreen-exit"
              :title="t('relations.graph.closeExpanded')"
              @click="emit('close')"
            >
              <Minimize2 :size="14" aria-hidden="true" />{{ t('relations.graph.closeExpanded') }}
            </button>
          </div>
        </header>
        <div class="wb-relation-graph-fullscreen-body">
          <p v-if="local.nodes.length < 2" class="wb-relation-graph-fullscreen-empty">{{ t('relations.graph.emptyDirection') }}</p>
          <ConfigRelationGraphView
            v-else
            :graph="local"
            :tables="tables"
            fill
            explore
            :layout-key="layoutKey"
            :current-table="home"
            :notice="notice"
            @open-table="openTable"
            @focus-table="focusTable"
          />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.wb-relation-graph-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  background: var(--wb-dialog-surface);
  color: var(--wb-text);
  animation: wb-relation-graph-fullscreen-in var(--wb-duration-base, 180ms) var(--wb-ease-out, ease);
}

@keyframes wb-relation-graph-fullscreen-in {
  from {
    opacity: 0;
    transform: scale(0.985);
  }
}

.wb-relation-graph-fullscreen-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  outline: none;
}

.wb-relation-graph-fullscreen-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--wb-line);
  background: var(--wb-chrome-surface);
}

.wb-relation-graph-fullscreen-title {
  display: flex;
  flex: 1 1 320px;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--wb-secondary-text);
}

.wb-relation-graph-fullscreen-title strong {
  flex: none;
  color: var(--wb-text);
  font-size: 13px;
  font-weight: 650;
}

.wb-relation-graph-fullscreen-comment {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relation-graph-fullscreen-back {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 11px;
}

.wb-relation-graph-fullscreen-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px 12px;
}

.wb-relation-graph-fullscreen-tools :deep(.wb-relation-graph-hidden) {
  flex-basis: 100%;
  text-align: right;
}

.wb-relation-graph-fullscreen-exit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}

.wb-relation-graph-fullscreen-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

/* The graph is the screen's canvas, edge to edge. */
.wb-relation-graph-fullscreen-body :deep(.wb-relation-graph) {
  border-radius: 0;
  box-shadow: none;
}

.wb-relation-graph-fullscreen-empty {
  display: grid;
  place-items: center;
  height: 100%;
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .wb-relation-graph-fullscreen {
    animation: none;
  }
}
</style>
