<script setup>
// Header of one relation-page section: a disclosure button with the section
// name and an optional count, plus a slot on the right for context (the
// selected row, view switches). Shared so every section reads the same way.
import { ChevronRight } from "lucide-vue-next";

defineProps({
  label: { type: String, required: true },
  count: { type: [Number, String], default: null },
  open: { type: Boolean, default: true },
  collapsible: { type: Boolean, default: true },
  // Id of the element the header shows and hides.
  controls: { type: String, default: "" },
});

const emit = defineEmits(["toggle"]);
</script>

<template>
  <div class="wb-relation-section-head">
    <button
      v-if="collapsible"
      type="button"
      class="wb-relation-section-toggle"
      :aria-expanded="open"
      :aria-controls="controls || undefined"
      @click="emit('toggle')"
    >
      <ChevronRight :size="12" :stroke-width="2.2" class="wb-relation-section-chevron" :class="{ 'is-open': open }" aria-hidden="true" />
      <span class="wb-relation-section-label">{{ label }}</span>
      <span v-if="count !== null" class="wb-relation-section-count">{{ count }}</span>
    </button>
    <span v-else class="wb-relation-section-toggle is-static">
      <span class="wb-relation-section-label">{{ label }}</span>
      <span v-if="count !== null" class="wb-relation-section-count">{{ count }}</span>
    </span>
    <div v-if="$slots.default" class="wb-relation-section-aside">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.wb-relation-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  min-width: 0;
}

.wb-relation-section-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  max-width: 100%;
  margin-left: -4px;
  padding: 0 6px 0 4px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--wb-secondary-text);
  cursor: pointer;
}

.wb-relation-section-toggle:hover:not(.is-static) {
  background: var(--wb-list-hover);
  color: var(--wb-text);
}

.wb-relation-section-toggle:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 0;
}

.wb-relation-section-toggle.is-static {
  cursor: default;
}

.wb-relation-section-chevron {
  flex: none;
  color: var(--wb-quiet-text);
  transition: transform var(--wb-duration-fast) var(--wb-ease-out);
}

.wb-relation-section-chevron.is-open {
  transform: rotate(90deg);
}

.wb-relation-section-label {
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relation-section-count {
  flex: none;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-text) 7%, transparent);
  color: var(--wb-secondary-text);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}

.wb-relation-section-aside {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
}

@media (prefers-reduced-motion: reduce) {
  .wb-relation-section-chevron {
    transition: none;
  }
}
</style>
