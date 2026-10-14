<script setup>
// The relation graph in full screen: it covers the whole window, stretches
// its rings to use the room, names the fields of the active table's lines and
// shows comments under table names. A pinned table can become the new center
// to explore further without leaving; the way back is one button. Esc or the
// exit button closes it; opening a table closes it too.
import { t } from "../i18n/index.js";
import { computed, ref, watch } from "vue";
import { ArrowLeft, Minimize2, Network } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import { tableDisplayComment, tableDisplayName } from "../utils/configRelations.js";
import { graphStatuses, localRelationGraph } from "../utils/relationGraph.js";
import ConfigRelationGraph from "./ConfigRelationGraph.vue";
import ConfigRelationGraphControls from "./ConfigRelationGraphControls.vue";
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

// Every opening starts from the tab's table.
watch(() => [props.open, home.value], ([open]) => {
  if (open) centerId.value = home.value;
}, { immediate: true });

const tables = computed(() => props.graphData?.tables || {});
const local = computed(() => (props.graphData && centerId.value ? localRelationGraph(props.graphData, centerId.value, props.options) : null));
const statuses = computed(() => graphStatuses(local.value));
const centerName = computed(() => tableDisplayName(tables.value, centerId.value));
const centerComment = computed(() => tableDisplayComment(tables.value, centerId.value));
const explored = computed(() => centerId.value !== home.value);

function openTable(target) {
  emit("open-table", target);
  emit("close");
}

function focusTable({ id }) {
  if (id) centerId.value = id;
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
            <strong id="wb-relation-graph-fullscreen-title">{{ t('relations.graph.expandedTitle', { name: centerName }) }}</strong>
            <span v-if="centerComment" class="wb-relation-graph-fullscreen-comment">{{ centerComment }}</span>
            <button
              v-if="explored"
              type="button"
              class="wb-relation-graph-fullscreen-back"
              @click="centerId = home"
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
              @toggle-direction="emit('toggle-direction', $event)"
            />
            <ConfigRelationGraphControls :depth="options.depth" @set-depth="emit('set-depth', $event)" />
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
          <ConfigRelationGraph
            v-else
            :graph="local"
            :tables="tables"
            fill
            explore
            :layout-key="`${scopeKey}\u001f${centerId}`"
            :current-table="home"
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
