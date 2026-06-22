<script setup>
import { computed } from "vue";

import { parseBackupNumberInput, stepBackupNumberValue } from "../utils/backupNumberInput.js";

const props = defineProps({
  modelValue: { type: Number, default: null },
  min: { type: Number, default: null },
  max: { type: Number, default: null },
  step: { type: Number, default: 1 },
  ariaLabel: { type: String, required: true },
});

const emit = defineEmits(["update:modelValue"]);

const displayValue = computed(() => (props.modelValue == null ? "" : String(props.modelValue)));

const bounds = computed(() => ({ min: props.min, max: props.max, step: props.step }));

function emitInputValue(value) {
  emit("update:modelValue", parseBackupNumberInput(value, props.modelValue, bounds.value));
}

function stepValue(direction) {
  emit("update:modelValue", stepBackupNumberValue(props.modelValue, direction, bounds.value));
}
</script>

<template>
  <span class="wb-backup-number-control">
    <input
      :value="displayValue"
      type="number"
      :min="min ?? undefined"
      :max="max ?? undefined"
      :step="step"
      :aria-label="ariaLabel"
      @input="emitInputValue($event.target.value)"
    />
    <span class="wb-backup-number-stepper" aria-hidden="true">
      <button
        type="button"
        class="wb-backup-number-step"
        tabindex="-1"
        @mousedown.prevent
        @click="stepValue(1)"
      ><span aria-hidden="true"></span></button>
      <button
        type="button"
        class="wb-backup-number-step"
        tabindex="-1"
        @mousedown.prevent
        @click="stepValue(-1)"
      ><span aria-hidden="true"></span></button>
    </span>
  </span>
</template>
