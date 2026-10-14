<script setup>
// Picks how a relation graph is drawn: rings with routed lines and placed
// names while it is small, a force layout on a canvas past that (and for the
// whole database). Everything else passes straight through.
import { computed } from "vue";
import { RING_GRAPH_MAX_NODES } from "../utils/relationGraph.js";
import ConfigRelationGraph from "./ConfigRelationGraph.vue";
import ConfigRelationGraphCanvas from "./ConfigRelationGraphCanvas.vue";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  graph: { type: Object, required: true },
});

const large = computed(() => props.graph.scope === "database" || props.graph.nodes.length > RING_GRAPH_MAX_NODES);
</script>

<template>
  <ConfigRelationGraphCanvas v-if="large" :graph="graph" v-bind="$attrs" />
  <ConfigRelationGraph v-else :graph="graph" v-bind="$attrs" />
</template>
