<script setup>
import { computed } from "vue";
import { DATABASE_DECORATION_COLORS } from "../composables/databaseDecorationStore.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  label: { type: String, required: true },
  hint: { type: String, default: "" },
  autoLabel: { type: String, default: "" },
  presets: {
    type: Array,
    default: () => DATABASE_DECORATION_COLORS.map((color) => ({ value: color, cssColor: color, label: color })),
  },
  customWarning: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);

const normalizedValue = computed(() => String(props.modelValue || "").toLowerCase());
const normalizedPresets = computed(() => props.presets.map((preset) => ({
  value: String(preset?.value || "").toLowerCase(),
  cssColor: String(preset?.cssColor || preset?.value || ""),
  label: String(preset?.label || preset?.value || ""),
})).filter((preset) => preset.value));
const isCustomColor = computed(() => (
  /^#[0-9a-f]{6}$/i.test(normalizedValue.value) &&
  !normalizedPresets.value.some((preset) => preset.value === normalizedValue.value)
));
const customInputValue = computed(() => (
  /^#[0-9a-f]{6}$/i.test(normalizedValue.value) ? normalizedValue.value : "#64748b"
));

function setColor(value) {
  emit("update:modelValue", String(value || "").toLowerCase());
}
</script>

<template>
  <div class="wb-database-color-setting" role="group" :aria-label="label">
    <span class="wb-database-color-label">
      <strong>{{ label }}</strong>
      <small v-if="hint">{{ hint }}</small>
    </span>
    <div class="wb-database-color-options">
      <button
        type="button"
        class="wb-database-color-swatch wb-database-color-theme"
        :class="{ 'is-active': !normalizedValue }"
        :aria-label="autoLabel || `${label}跟随主题`"
        :aria-pressed="!normalizedValue"
        :title="autoLabel || `${label}跟随主题`"
        @click="setColor('')"
      ></button>
      <button
        v-for="preset in normalizedPresets"
        :key="preset.value"
        type="button"
        class="wb-database-color-swatch"
        :class="{ 'is-active': normalizedValue === preset.value }"
        :style="{ '--wb-marker-swatch': preset.cssColor }"
        :aria-label="`${label}使用${preset.label}`"
        :aria-pressed="normalizedValue === preset.value"
        :title="preset.label"
        @click="setColor(preset.value)"
      ></button>
      <label
        class="wb-database-color-swatch wb-database-custom-color"
        :class="{ 'is-active': isCustomColor }"
        :title="`${label}自定义颜色`"
      >
        <input
          type="color"
          :value="customInputValue"
          :aria-label="`${label}自定义颜色`"
          @input="setColor($event.target.value)"
        />
      </label>
    </div>
    <small v-if="isCustomColor && customWarning" class="wb-database-color-warning" role="status">
      {{ customWarning }}
    </small>
  </div>
</template>
