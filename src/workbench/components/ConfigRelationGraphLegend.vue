<script setup>
// What the line styles and circle sizes in the relation graph mean, plus a
// note when some tables did not fit.
import { t } from "../i18n/index.js";
import { relationStatusLabel } from "../utils/configRelations.js";

defineProps({
  statuses: { type: Array, default: () => [] },
  hidden: { type: Number, default: 0 },
});
</script>

<template>
  <div class="wb-relation-graph-legend">
    <span v-for="status in statuses" :key="status" class="wb-relation-graph-legend-item">
      <span class="wb-relation-graph-swatch" :class="`is-${status}`" aria-hidden="true" />
      {{ relationStatusLabel(status, t) }}
    </span>
    <span class="wb-relation-graph-legend-item is-hint">{{ t('relations.graph.sizeHint') }}</span>
    <span class="wb-relation-graph-legend-item is-hint">{{ t('relations.graph.dragHint') }}</span>
  </div>
  <p v-if="hidden" class="wb-relation-graph-hidden">{{ t('relations.graph.hidden', { count: hidden }) }}</p>
</template>

<style scoped>
.wb-relation-graph-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  color: var(--wb-secondary-text);
  font-size: 10.5px;
}

.wb-relation-graph-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.wb-relation-graph-legend-item.is-hint {
  color: var(--wb-quiet-text);
}

.wb-relation-graph-swatch {
  width: 14px;
  height: 0;
  border-top: 2px solid color-mix(in srgb, var(--wb-text) 30%, transparent);
}

.wb-relation-graph-swatch.is-unconfirmed {
  border-top-style: dashed;
}

.wb-relation-graph-swatch.is-stale {
  border-top-color: var(--wb-warning-border);
}

.wb-relation-graph-swatch.is-conflict {
  border-top-color: var(--wb-danger);
}

.wb-relation-graph-hidden {
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 11.5px;
}
</style>
