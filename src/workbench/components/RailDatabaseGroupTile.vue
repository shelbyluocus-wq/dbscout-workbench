<script setup>
import { computed } from "vue";

// A rail folder: up to four of its databases' colors in a 2×2 mosaic.
const props = defineProps({
  items: { type: Array, default: () => [] },
});

const cells = computed(() => Array.from({ length: 4 }, (_, index) => props.items[index] || null));
</script>

<template>
  <span class="wb-rail-db-tile wb-rail-db-folder" aria-hidden="true">
    <span
      v-for="(cell, index) in cells"
      :key="index"
      class="wb-rail-db-folder-cell"
      :class="{ 'is-empty': !cell, 'is-disconnected': cell && (cell.disconnected || cell.missing) }"
      :style="cell ? { '--wb-rail-db-color': cell.color } : undefined"
    ></span>
  </span>
</template>
