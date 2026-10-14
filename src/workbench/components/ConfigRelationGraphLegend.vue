<script setup>
// Below the relation graph: the two directions as switches that double as the
// colour key for the circles, the line styles of the statuses actually drawn,
// and a note when some tables did not fit. At least one direction stays on.
// The whole-database view has no directions to choose, so there the two
// colours are only a key.
import { t } from "../i18n/index.js";
import { computed } from "vue";
import { relationStatusLabel } from "../utils/configRelations.js";

const props = defineProps({
  statuses: { type: Array, default: () => [] },
  hidden: { type: Number, default: 0 },
  outgoing: { type: Boolean, default: true },
  incoming: { type: Boolean, default: true },
  // False: the directions are a colour key, not switches.
  switchable: { type: Boolean, default: true },
  hiddenKey: { type: String, default: "relations.graph.hidden" },
});

const emit = defineEmits(["toggle-direction"]);

const DIRECTIONS = Object.freeze(["outgoing", "incoming"]);

// Plain confirmed lines need no key unless something else is drawn beside them.
const statusItems = computed(() => (props.statuses.some((status) => status !== "confirmed") ? props.statuses : []));

function directionLocked(key) {
  const other = key === "outgoing" ? "incoming" : "outgoing";
  return props[key] && !props[other];
}

function toggle(key) {
  if (!directionLocked(key)) emit("toggle-direction", key);
}
</script>

<template>
  <div class="wb-relation-graph-legend">
    <div v-if="!switchable" class="wb-relation-graph-directions">
      <span v-for="key in DIRECTIONS" :key="key" class="wb-relation-graph-direction is-key is-on" :class="`is-${key}`">
        <span class="wb-relation-graph-direction-dot" aria-hidden="true" />
        {{ t(`relations.graph.${key}`) }}
      </span>
    </div>
    <div v-else class="wb-relation-graph-directions" role="group" :aria-label="t('relations.graph.direction')">
      <button
        v-for="key in DIRECTIONS"
        :key="key"
        type="button"
        class="wb-relation-graph-direction"
        :class="[`is-${key}`, { 'is-on': props[key], 'is-locked': directionLocked(key) }]"
        :aria-pressed="props[key]"
        :aria-disabled="directionLocked(key)"
        :title="t(`relations.graph.${key}Hint`)"
        @click="toggle(key)"
      >
        <span class="wb-relation-graph-direction-dot" aria-hidden="true" />
        {{ t(`relations.graph.${key}`) }}
      </button>
    </div>
    <span v-if="statusItems.length" class="wb-relation-graph-statuses">
      <span v-for="status in statusItems" :key="status" class="wb-relation-graph-status">
        <span class="wb-relation-graph-swatch" :class="`is-${status}`" aria-hidden="true" />
        {{ relationStatusLabel(status, t) }}
      </span>
    </span>
  </div>
  <p v-if="hidden" class="wb-relation-graph-hidden">{{ t(hiddenKey, { count: hidden }) }}</p>
</template>

<style scoped>
.wb-relation-graph-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  min-width: 0;
}

.wb-relation-graph-directions {
  display: inline-flex;
  gap: 4px;
}

.wb-relation-graph-direction {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  min-height: 22px;
  padding: 0 8px 0 7px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--wb-quiet-text);
  font-size: 11px;
  font-weight: 500;
}

.wb-relation-graph-direction:hover:not(:disabled) {
  border-color: var(--wb-border);
  background: var(--wb-list-hover);
  color: var(--wb-text);
}

.wb-relation-graph-direction.is-on {
  border-color: var(--wb-border);
  background: var(--wb-control);
  color: var(--wb-text);
}

.wb-relation-graph-direction.is-locked {
  cursor: default;
}

/* A colour key only: no border or fill of a switch. */
.wb-relation-graph-direction.is-key {
  border-color: transparent;
  background: transparent;
  color: var(--wb-secondary-text);
}

.wb-relation-graph-direction:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 0;
}

.wb-relation-graph-direction-dot {
  width: 9px;
  height: 9px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  background: transparent;
}

.wb-relation-graph-direction.is-outgoing .wb-relation-graph-direction-dot {
  border-color: var(--wb-relation-out);
}

.wb-relation-graph-direction.is-incoming .wb-relation-graph-direction-dot {
  border-color: var(--wb-relation-in);
}

.wb-relation-graph-direction.is-outgoing.is-on .wb-relation-graph-direction-dot {
  background: var(--wb-relation-out-soft);
}

.wb-relation-graph-direction.is-incoming.is-on .wb-relation-graph-direction-dot {
  background: var(--wb-relation-in-soft);
}

.wb-relation-graph-direction:not(.is-on) .wb-relation-graph-direction-dot {
  border-style: dashed;
  opacity: 0.7;
}

.wb-relation-graph-statuses {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  color: var(--wb-secondary-text);
  font-size: 11px;
}

.wb-relation-graph-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.wb-relation-graph-swatch {
  width: 14px;
  height: 0;
  border-top: 2px solid color-mix(in srgb, var(--wb-text) 32%, transparent);
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
  color: var(--wb-quiet-text);
  font-size: 11px;
  line-height: 1.5;
}
</style>
