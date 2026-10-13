<script setup>
// The relation page's map of tables around the current one. It loads the
// database's relation list only while expanded, keeps the last picture while
// a newer index loads, and remembers depth, directions, height and collapse
// state. The enlarged view shares the same options.
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { tableDisplayName } from "../utils/configRelations.js";
import {
  graphStatuses,
  loadGraphOptions,
  localRelationGraph,
  saveGraphOptions,
} from "../utils/relationGraph.js";
import RelationSectionHead from "./RelationSectionHead.vue";
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

const bodyId = `wb-relation-graph-${Math.random().toString(36).slice(2, 10)}`;
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
const tableCount = computed(() => (hasNeighbors.value ? local.value.nodes.length - 1 : null));
const dialogTitle = computed(() => t("relations.graph.expandedTitle", { name: tableDisplayName(tables.value, props.tableName) }));
const emptyText = computed(() => (options.outgoing && options.incoming
  ? t("relations.graph.empty")
  : t("relations.graph.emptyDirection")));

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
  <section ref="sectionEl" class="wb-relations-block wb-relation-graph-section">
    <RelationSectionHead
      :label="t('relations.graph.title')"
      :count="tableCount"
      :open="!options.collapsed"
      :controls="bodyId"
      @toggle="options.collapsed = !options.collapsed"
    >
      <ConfigRelationGraphControls v-if="!options.collapsed" :depth="options.depth" @set-depth="setDepth" />
    </RelationSectionHead>

    <div v-if="!options.collapsed" :id="bodyId" class="wb-relation-graph-body">
      <p v-if="error" class="wb-relations-error" role="alert">{{ error }}</p>
      <div
        v-else-if="!local"
        class="wb-relation-graph-placeholder"
        :style="{ height: `${options.height}px` }"
      >{{ loading ? t('relations.loading') : '' }}</div>
      <template v-else>
        <ConfigRelationGraph
          v-if="hasNeighbors"
          :graph="local"
          :tables="tables"
          :height="options.height"
          @update:height="options.height = $event"
          @expand="openExpanded"
          @open-table="emit('open-table', $event)"
        />
        <div v-else class="wb-relation-graph-placeholder is-empty">{{ emptyText }}</div>
        <!-- The switches stay even when one direction leaves nothing to draw. -->
        <ConfigRelationGraphLegend
          :statuses="statuses"
          :hidden="local.hidden"
          :outgoing="options.outgoing"
          :incoming="options.incoming"
          @toggle-direction="toggleDirection"
        />
      </template>
    </div>

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
.wb-relation-graph-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-relation-graph-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--wb-field-surface);
  box-shadow: inset 0 0 0 1px var(--wb-line);
  color: var(--wb-secondary-text);
  font-size: 11px;
}

.wb-relation-graph-placeholder.is-empty {
  min-height: 72px;
  padding: 12px 16px;
  text-align: center;
}
</style>
