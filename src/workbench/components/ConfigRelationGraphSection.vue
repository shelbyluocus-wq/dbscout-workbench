<script setup>
// The relation page's map of tables around the current one. It loads the
// database's relation list only while expanded, keeps the last picture while
// a newer index loads, and remembers depth, directions, height and collapse
// state. The enlarged view shares the same options.
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ChevronDown, ChevronRight } from "lucide-vue-next";
import { tableDisplayName } from "../utils/configRelations.js";
import {
  graphStatuses,
  loadGraphOptions,
  localRelationGraph,
  saveGraphOptions,
} from "../utils/relationGraph.js";
import ConfigRelationGraph from "./ConfigRelationGraph.vue";
import ConfigRelationGraphControls from "./ConfigRelationGraphControls.vue";
import ConfigRelationGraphDialog from "./ConfigRelationGraphDialog.vue";
import ConfigRelationGraphLegend from "./ConfigRelationGraphLegend.vue";

const props = defineProps({
  scope: { type: Object, required: true },
  tableName: { type: String, required: true },
  relations: { type: Object, required: true },
  revision: { type: Number, default: 0 },
});

const emit = defineEmits(["open-table"]);

const options = reactive(loadGraphOptions());
watch(options, () => saveGraphOptions(options), { deep: true });

const sectionEl = ref(null);
const graphData = ref(null);
const error = ref("");
const loading = ref(false);
const expanded = ref(false);
const theme = ref("light");
let token = 0;

const scopeKey = computed(() => `${props.scope.connectionId}\u001f${String(props.scope.database || "").toLowerCase()}`);

watch(scopeKey, () => {
  token += 1;
  graphData.value = null;
  error.value = "";
  expanded.value = false;
});

async function load() {
  if (options.collapsed || !props.scope.connectionId || !props.scope.database) return;
  const current = ++token;
  loading.value = true;
  try {
    const data = await props.relations.relationGraph(props.scope);
    if (current !== token) return;
    graphData.value = data;
    error.value = "";
  } catch (failure) {
    if (current !== token) return;
    error.value = t("relations.error", { message: String(failure?.message || failure) });
  } finally {
    if (current === token) loading.value = false;
  }
}

watch([scopeKey, () => props.revision, () => options.collapsed], () => void load(), { immediate: true });

onBeforeUnmount(() => {
  token += 1;
});

const local = computed(() => (graphData.value ? localRelationGraph(graphData.value, props.tableName, options) : null));
const hasNeighbors = computed(() => (local.value?.nodes.length || 0) > 1);
const statuses = computed(() => graphStatuses(local.value));
const tables = computed(() => graphData.value?.tables || {});
const dialogTitle = computed(() => t("relations.graph.expandedTitle", { name: tableDisplayName(tables.value, props.tableName) }));

function setDepth(depth) {
  options.depth = depth;
}

function toggleDirection(key) {
  options[key] = !options[key];
}

function openExpanded() {
  // The dialog is teleported out of the workbench root, so it carries the theme itself.
  theme.value = sectionEl.value?.closest?.("[data-theme]")?.getAttribute("data-theme") || "light";
  expanded.value = true;
}
</script>

<template>
  <section ref="sectionEl" class="wb-relation-graph-section">
    <div class="wb-relation-graph-head">
      <button
        type="button"
        class="wb-relation-graph-collapse"
        :aria-expanded="!options.collapsed"
        :aria-label="options.collapsed ? t('relations.graph.show') : t('relations.graph.hide')"
        @click="options.collapsed = !options.collapsed"
      >
        <component :is="options.collapsed ? ChevronRight : ChevronDown" :size="12" aria-hidden="true" />
        <span>{{ t('relations.graph.title') }}</span>
      </button>
      <ConfigRelationGraphControls
        v-if="!options.collapsed"
        :depth="options.depth"
        :outgoing="options.outgoing"
        :incoming="options.incoming"
        @set-depth="setDepth"
        @toggle-direction="toggleDirection"
      />
    </div>

    <template v-if="!options.collapsed">
      <p v-if="error" class="wb-relation-graph-note is-error" role="alert">{{ error }}</p>
      <div
        v-else-if="!local"
        class="wb-relation-graph-placeholder"
        :style="{ height: `${options.height}px` }"
      >{{ loading ? t('relations.loading') : '' }}</div>
      <p v-else-if="!hasNeighbors" class="wb-relation-graph-note">{{ t('relations.graph.empty') }}</p>
      <template v-else>
        <ConfigRelationGraph
          :graph="local"
          :tables="tables"
          :height="options.height"
          @update:height="options.height = $event"
          @expand="openExpanded"
          @open-table="emit('open-table', $event)"
        />
        <ConfigRelationGraphLegend :statuses="statuses" :hidden="local.hidden" />
      </template>
    </template>

    <ConfigRelationGraphDialog
      :open="expanded && hasNeighbors"
      :theme="theme"
      :title="dialogTitle"
      :graph="local"
      :tables="tables"
      :statuses="statuses"
      :options="options"
      @close="expanded = false"
      @set-depth="setDepth"
      @toggle-direction="toggleDirection"
      @open-table="emit('open-table', $event)"
    />
  </section>
</template>

<style scoped>
.wb-relation-graph-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-relation-graph-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
  padding-top: 4px;
}

.wb-relation-graph-collapse {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-height: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--wb-secondary-text);
  font-size: 11px;
  font-weight: 620;
  cursor: pointer;
}

.wb-relation-graph-collapse:hover,
.wb-relation-graph-collapse:active {
  background: none;
  color: var(--wb-text);
}

.wb-relation-graph-collapse:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 1px;
  border-radius: 3px;
}

.wb-relation-graph-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--wb-border);
  border-radius: 6px;
  color: var(--wb-secondary-text);
  font-size: 11.5px;
}

.wb-relation-graph-note {
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 11.5px;
}

.wb-relation-graph-note.is-error {
  color: var(--wb-danger);
  overflow-wrap: anywhere;
}
</style>
