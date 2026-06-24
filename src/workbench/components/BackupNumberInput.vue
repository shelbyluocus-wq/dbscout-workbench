<script setup>
import { computed, onUnmounted, ref } from "vue";

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

// ---- Long-press stepping with acceleration ----------------------------
// Holding a stepper button acts like rapid clicks; the repeat rate speeds
// up the longer the button is held.

const LONG_PRESS_DELAY = 400;
const INITIAL_INTERVAL = 180;
const MIN_INTERVAL = 30;
const ACCELERATION = 0.9;

let longPressTimer = null;
let repeatTimer = null;
let currentInterval = INITIAL_INTERVAL;
const activeDirection = ref(0);

function clearLongPressTimers() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  if (repeatTimer) {
    clearTimeout(repeatTimer);
    repeatTimer = null;
  }
  currentInterval = INITIAL_INTERVAL;
  activeDirection.value = 0;
}

function scheduleNextRepeat(direction) {
  repeatTimer = setTimeout(() => {
    if (!activeDirection.value) return;
    stepValue(direction);
    currentInterval = Math.max(MIN_INTERVAL, currentInterval * ACCELERATION);
    scheduleNextRepeat(direction);
  }, currentInterval);
}

function onStepPress(direction, event) {
  if (event) event.preventDefault();
  clearLongPressTimers();
  stepValue(direction);
  activeDirection.value = direction;
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    scheduleNextRepeat(direction);
  }, LONG_PRESS_DELAY);
}

function onStepRelease() {
  clearLongPressTimers();
}

onUnmounted(clearLongPressTimers);
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
        aria-label="增加"
        @mousedown.prevent="onStepPress(1, $event)"
        @mouseup="onStepRelease"
        @mouseleave="onStepRelease"
        @touchstart.prevent="onStepPress(1, $event)"
        @touchend="onStepRelease"
        @touchcancel="onStepRelease"
      ><span aria-hidden="true"></span></button>
      <button
        type="button"
        class="wb-backup-number-step"
        tabindex="-1"
        aria-label="减少"
        @mousedown.prevent="onStepPress(-1, $event)"
        @mouseup="onStepRelease"
        @mouseleave="onStepRelease"
        @touchstart.prevent="onStepPress(-1, $event)"
        @touchend="onStepRelease"
        @touchcancel="onStepRelease"
      ><span aria-hidden="true"></span></button>
    </span>
  </span>
</template>
