<script setup>
defineProps({
  glyph: { type: Object, required: true },
  color: { type: String, default: "" },
  ink: { type: String, default: "" },
});
</script>

<template>
  <span
    class="wb-rail-db-tile"
    :class="{ 'is-compact': glyph.kind === 'text' && glyph.compact }"
    :style="{ '--wb-rail-db-color': color, '--wb-rail-db-ink': ink }"
    aria-hidden="true"
  >
    <component
      :is="glyph.icon"
      v-if="glyph.kind === 'icon' && glyph.icon"
      :size="15"
      :stroke-width="2"
    />
    <span v-else class="wb-rail-db-tile-text">{{ glyph.text }}</span>
  </span>
</template>
