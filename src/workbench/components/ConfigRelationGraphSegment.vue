<script setup>
// A small segmented switch for the relation graph: its depth (the tables
// next to this one, or also the ones next to those) or, in full screen, its
// scope (this table or the whole database).
defineProps({
  // [{ value, label }]
  options: { type: Array, required: true },
  value: { type: [Number, String], required: true },
  label: { type: String, required: true },
});

const emit = defineEmits(["select"]);
</script>

<template>
  <div class="wb-relation-graph-segment" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :aria-pressed="value === option.value"
      :class="{ 'is-active': value === option.value }"
      @click="emit('select', option.value)"
    >{{ option.label }}</button>
  </div>
</template>

<style scoped>
.wb-relation-graph-segment {
  display: inline-flex;
  flex: none;
  gap: 1px;
  padding: 2px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--wb-text) 7%, transparent);
}

.wb-relation-graph-segment button {
  height: 20px;
  min-height: 20px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--wb-secondary-text);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.wb-relation-graph-segment button:hover:not(:disabled):not(.is-active) {
  background: transparent;
  color: var(--wb-text);
}

.wb-relation-graph-segment button.is-active {
  background: var(--wb-control-hover);
  color: var(--wb-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.14), 0 0 0 1px var(--wb-border);
}

.wb-relation-graph-segment button:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 0;
}
</style>
