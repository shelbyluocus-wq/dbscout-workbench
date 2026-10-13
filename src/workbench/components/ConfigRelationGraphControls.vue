<script setup>
// Depth and direction switches for the relation graph. At least one
// direction always stays on.
import { t } from "../i18n/index.js";

const props = defineProps({
  depth: { type: Number, required: true },
  outgoing: { type: Boolean, required: true },
  incoming: { type: Boolean, required: true },
});

const emit = defineEmits(["set-depth", "toggle-direction"]);

const DEPTHS = Object.freeze([1, 2]);
const DIRECTIONS = Object.freeze(["outgoing", "incoming"]);

function directionLocked(key) {
  const other = key === "outgoing" ? "incoming" : "outgoing";
  return props[key] && !props[other];
}

function toggle(key) {
  if (!directionLocked(key)) emit("toggle-direction", key);
}
</script>

<template>
  <div class="wb-relation-graph-controls">
    <div class="wb-relation-graph-segment" role="group" :aria-label="t('relations.graph.depth')">
      <button
        v-for="value in DEPTHS"
        :key="value"
        type="button"
        :aria-pressed="depth === value"
        :class="{ 'is-active': depth === value }"
        @click="emit('set-depth', value)"
      >{{ t(`relations.graph.depth${value}`) }}</button>
    </div>
    <div class="wb-relation-graph-segment" role="group">
      <button
        v-for="key in DIRECTIONS"
        :key="key"
        type="button"
        :aria-pressed="props[key]"
        :aria-disabled="directionLocked(key)"
        :class="{ 'is-active': props[key], 'is-locked': directionLocked(key) }"
        @click="toggle(key)"
      >{{ t(`relations.graph.${key}`) }}</button>
    </div>
  </div>
</template>

<style scoped>
.wb-relation-graph-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.wb-relation-graph-segment {
  display: inline-flex;
  gap: 1px;
  padding: 1px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--wb-text) 8%, transparent);
}

.wb-relation-graph-segment button {
  height: 20px;
  min-height: 20px;
  padding: 0 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--wb-secondary-text);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.wb-relation-graph-segment button.is-active {
  background: var(--wb-surface);
  color: var(--wb-text);
  font-weight: 620;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
}

.wb-relation-graph-segment button.is-locked {
  cursor: default;
}

.wb-relation-graph-segment button:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 1px;
}
</style>
