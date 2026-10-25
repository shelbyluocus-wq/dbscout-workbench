<script setup>
// Removable chips, such as kept tables or exclusion rules. Locked entries come
// first and cannot be removed.
import { X } from "lucide-vue-next";

defineProps({
  items: { type: Array, required: true },
  locked: { type: Array, default: () => [] },
  lockedTitle: { type: String, default: "" },
  label: { type: String, default: "" },
  removeLabel: { type: Function, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["remove"]);
</script>

<template>
  <ul class="wb-rf-chips" :aria-label="label || undefined">
    <li v-for="item in locked" :key="`locked:${item}`" class="wb-rf-chip is-quiet" :title="lockedTitle || undefined">
      <span class="wb-rf-code">{{ item }}</span>
    </li>
    <li v-for="item in items" :key="item" class="wb-rf-chip">
      <span class="wb-rf-code">{{ item }}</span>
      <button type="button" class="wb-rf-chip-remove" :disabled="disabled" :aria-label="removeLabel(item)" @click="emit('remove', item)">
        <X :size="11" aria-hidden="true" />
      </button>
    </li>
  </ul>
</template>
