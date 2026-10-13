<script setup>
// The relation graph enlarged to most of the window, with the same depth and
// direction switches as the inspector. Esc, the close button or a click on
// the backdrop closes it; opening a table closes it too.
import { t } from "../i18n/index.js";
import { ref } from "vue";
import { X } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import ConfigRelationGraph from "./ConfigRelationGraph.vue";
import ConfigRelationGraphControls from "./ConfigRelationGraphControls.vue";
import ConfigRelationGraphLegend from "./ConfigRelationGraphLegend.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  theme: { type: String, default: "light" },
  title: { type: String, default: "" },
  graph: { type: Object, default: null },
  tables: { type: Object, default: () => ({}) },
  statuses: { type: Array, default: () => [] },
  options: { type: Object, required: true },
});

const emit = defineEmits(["close", "open-table", "set-depth", "toggle-direction"]);

const dialogRef = ref(null);
useEscClose(() => props.open, () => emit("close"), null, { dialogRef });

function openTable(target) {
  emit("open-table", target);
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && graph"
      class="wb-shortcut-dialog-overlay wb-relation-graph-dialog-overlay wb-floating-themed"
      :data-theme="theme"
      @pointerdown.self="emit('close')"
    >
      <section
        ref="dialogRef"
        class="wb-relation-graph-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-relation-graph-dialog-title"
        tabindex="-1"
      >
        <header class="wb-relation-graph-dialog-head">
          <strong id="wb-relation-graph-dialog-title">{{ title }}</strong>
          <ConfigRelationGraphControls
            :depth="options.depth"
            :outgoing="options.outgoing"
            :incoming="options.incoming"
            @set-depth="emit('set-depth', $event)"
            @toggle-direction="emit('toggle-direction', $event)"
          />
          <button
            type="button"
            class="wb-relation-graph-dialog-close"
            :title="t('relations.graph.closeExpanded')"
            :aria-label="t('relations.graph.closeExpanded')"
            @click="emit('close')"
          >
            <X :size="15" aria-hidden="true" />
          </button>
        </header>
        <div class="wb-relation-graph-dialog-body">
          <ConfigRelationGraph :graph="graph" :tables="tables" fill @open-table="openTable" />
        </div>
        <footer class="wb-relation-graph-dialog-foot">
          <ConfigRelationGraphLegend :statuses="statuses" :hidden="graph.hidden" />
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.wb-relation-graph-dialog {
  display: flex;
  flex-direction: column;
  width: min(1200px, calc(100vw - 64px));
  height: min(860px, calc(100vh - 64px));
  border: 1px solid var(--wb-line);
  border-radius: 12px;
  background: var(--wb-surface);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  overflow: hidden;
  outline: none;
}

.wb-relation-graph-dialog-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--wb-line);
  color: var(--wb-text);
}

.wb-relation-graph-dialog-head strong {
  margin-right: auto;
  font-size: 14px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.wb-relation-graph-dialog-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  min-height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--wb-secondary-text);
  cursor: pointer;
}

.wb-relation-graph-dialog-close:hover {
  background: var(--wb-control-hover);
  color: var(--wb-text);
}

.wb-relation-graph-dialog-close:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 1px;
}

.wb-relation-graph-dialog-body {
  flex: 1;
  min-height: 0;
  padding: 10px 12px 6px;
}

.wb-relation-graph-dialog-foot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 14px 10px;
}
</style>
