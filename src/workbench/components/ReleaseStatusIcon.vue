<script setup>
// One glyph per task or page state, shared by the step rail, GM cards and the
// summary. Color is never the only signal: each state has its own shape.
import { CircleCheck, CircleX, LoaderCircle, Minus, SkipForward, TriangleAlert } from "lucide-vue-next";

defineProps({
  status: { type: String, default: "pending" },
  size: { type: Number, default: 15 },
});
</script>

<template>
  <span class="wb-rf-status" :class="`is-${status}`" aria-hidden="true">
    <CircleCheck v-if="status === 'done'" :size="size" />
    <LoaderCircle v-else-if="status === 'running'" :size="size" class="wb-rf-spin" />
    <TriangleAlert v-else-if="status === 'attention'" :size="size" />
    <CircleX v-else-if="status === 'failed'" :size="size" />
    <SkipForward v-else-if="status === 'skipped'" :size="size - 2" />
    <Minus v-else-if="status === 'notApplicable'" :size="size - 2" />
    <span v-else class="wb-rf-status-dot" />
  </span>
</template>
