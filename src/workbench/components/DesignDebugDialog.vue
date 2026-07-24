<script setup>
import { nextTick, reactive, ref, watch } from "vue";
import {
  BORDER_ALPHA_RANGE,
  DEBUG_COLOR_FIELDS,
  RADIUS_RANGE,
  SHADOW_RANGE,
  applyBorderAlpha,
  applyColorField,
  applyFrameShadow,
  applyRadius,
  buildExportCss,
  clearAllOverrides,
  readCurrentValues,
  resolveModeTarget,
} from "../composables/designDebug.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  theme: { type: String, default: "light" },
});

const emit = defineEmits(["close"]);

const panelRef = ref(null);
const copied = ref(false);
const colors = reactive({});
const radius = ref(0);
const borderAlpha = ref(BORDER_ALPHA_RANGE.min);
const shadowStrength = ref(0);

function modeTarget() {
  return resolveModeTarget(props.theme);
}

function hydrate() {
  const values = readCurrentValues(props.theme);
  for (const field of DEBUG_COLOR_FIELDS) colors[field.key] = values[field.key];
  radius.value = values.radius;
  borderAlpha.value = values.borderAlpha;
  shadowStrength.value = values.shadowStrength;
}

watch(
  () => [props.open, props.theme],
  async ([open]) => {
    if (!open) return;
    hydrate();
    await nextTick();
    panelRef.value?.focus?.();
  },
  { immediate: true },
);

function onColorInput(field) {
  applyColorField(modeTarget(), field, colors[field.key]);
}

function onRadiusInput() {
  radius.value = applyRadius(globalThis.document, radius.value);
}

function onBorderInput() {
  borderAlpha.value = applyBorderAlpha(modeTarget(), props.theme, borderAlpha.value);
}

function onShadowInput() {
  shadowStrength.value = applyFrameShadow(modeTarget(), shadowStrength.value);
}

function resetAll() {
  clearAllOverrides(props.theme);
  hydrate();
}

async function copyValues() {
  const css = buildExportCss(props.theme, {
    ...colors,
    radius: radius.value,
    borderAlpha: borderAlpha.value,
    shadowStrength: shadowStrength.value,
  });
  try {
    await navigator.clipboard.writeText(css);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1600);
  } catch {
    // 剪贴板被阻止时保持原状，用户可手动对照面板数值
  }
}

function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}
</script>

<template>
  <Teleport to="body">
    <section
      v-if="open"
      ref="panelRef"
      class="wb-design-debug wb-floating-themed"
      :data-theme="theme"
      role="dialog"
      aria-modal="false"
      aria-label="设计调试"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="wb-design-debug-header">
        <strong>设计调试</strong>
        <span class="wb-design-debug-mode">{{ theme === "dark" ? "深色" : "浅色" }}模式</span>
        <button type="button" class="wb-design-debug-close" aria-label="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="wb-design-debug-body">
        <label v-for="field in DEBUG_COLOR_FIELDS" :key="field.key" class="wb-design-debug-row">
          <span class="wb-design-debug-label">{{ field.label }}</span>
          <input
            type="color"
            :value="colors[field.key]"
            :aria-label="field.label"
            @input="colors[field.key] = $event.target.value; onColorInput(field)"
          />
          <code class="wb-design-debug-value">{{ colors[field.key] }}</code>
        </label>

        <label class="wb-design-debug-row">
          <span class="wb-design-debug-label">画布圆角（仅左上角）</span>
          <input
            v-model.number="radius"
            type="range"
            :min="RADIUS_RANGE.min"
            :max="RADIUS_RANGE.max"
            :step="RADIUS_RANGE.step"
            aria-label="画布圆角"
            @input="onRadiusInput"
          />
          <code class="wb-design-debug-value">{{ radius }}px</code>
        </label>

        <label class="wb-design-debug-row">
          <span class="wb-design-debug-label">发丝线浓度</span>
          <input
            v-model.number="borderAlpha"
            type="range"
            :min="BORDER_ALPHA_RANGE.min"
            :max="BORDER_ALPHA_RANGE.max"
            :step="BORDER_ALPHA_RANGE.step"
            aria-label="发丝线浓度"
            @input="onBorderInput"
          />
          <code class="wb-design-debug-value">{{ borderAlpha.toFixed(2) }}</code>
        </label>

        <label class="wb-design-debug-row">
          <span class="wb-design-debug-label">虚影强度（外框投影）</span>
          <input
            v-model.number="shadowStrength"
            type="range"
            :min="SHADOW_RANGE.min"
            :max="SHADOW_RANGE.max"
            :step="SHADOW_RANGE.step"
            aria-label="虚影强度"
            @input="onShadowInput"
          />
          <code class="wb-design-debug-value">{{ shadowStrength.toFixed(2) }}</code>
        </label>
      </div>

      <footer class="wb-design-debug-footer">
        <button type="button" class="wb-design-debug-primary" @click="copyValues">
          {{ copied ? "已复制 ✓" : "复制当前值" }}
        </button>
        <button type="button" @click="resetAll">重置</button>
      </footer>
      <p class="wb-design-debug-hint">仅调试模式显示，改动不保存；调好后点「复制当前值」发给我回填。</p>
    </section>
  </Teleport>
</template>
