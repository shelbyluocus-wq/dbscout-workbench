<script setup>
import { t } from "../i18n/index.js";
import { nextTick, reactive, ref, watch } from "vue";
import {
  BORDER_ALPHA_RANGE,
  DEBUG_COLOR_FIELDS,
  FILL_HANDLE_OFFSET_RANGE,
  FILL_HANDLE_SIZE_RANGE,
  RADIUS_RANGE,
  SHADOW_RANGE,
  applyBorderAlpha,
  applyColorField,
  applyFillHandle,
  applyFrameShadow,
  applyRadius,
  buildExportCss,
  clearAllOverrides,
  fillHandleDeltaFromKey,
  nudgeFillHandle,
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
const fillLeft = ref(-5);
const fillTop = ref(-6);
const fillSize = ref(6);

function modeTarget() {
  return resolveModeTarget(props.theme);
}

function hydrate() {
  const values = readCurrentValues(props.theme);
  for (const field of DEBUG_COLOR_FIELDS) colors[field.key] = values[field.key];
  radius.value = values.radius;
  borderAlpha.value = values.borderAlpha;
  shadowStrength.value = values.shadowStrength;
  fillLeft.value = values.fillLeft;
  fillTop.value = values.fillTop;
  fillSize.value = values.fillSize;
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

function commitFillHandle(next) {
  const applied = applyFillHandle(globalThis.document, next);
  fillLeft.value = applied.left;
  fillTop.value = applied.top;
  fillSize.value = applied.size;
}

function onFillSizeInput() {
  commitFillHandle({ left: fillLeft.value, top: fillTop.value, size: fillSize.value });
}

function nudgeFill(axis, delta) {
  commitFillHandle(nudgeFillHandle({
    left: fillLeft.value,
    top: fillTop.value,
    size: fillSize.value,
  }, axis, delta));
}

function canNudgeFillFromEvent(event) {
  const target = event.target;
  if (!(target instanceof Element)) return true;
  if (target.closest(".wb-design-debug-fill-pad")) return true;
  return !target.closest("input, textarea, select");
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
    fillLeft: fillLeft.value,
    fillTop: fillTop.value,
    fillSize: fillSize.value,
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
    return;
  }
  const nudge = fillHandleDeltaFromKey(event.key);
  if (!nudge || !canNudgeFillFromEvent(event)) return;
  event.preventDefault();
  nudgeFill(nudge.axis, nudge.delta);
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
      :aria-label="t('m_0fe0c819b123')"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="wb-design-debug-header">
        <strong>{{ t('m_0fe0c819b123') }}</strong>
        <span class="wb-design-debug-mode">{{ theme === "dark" ? t('m_a6b75d068032') : t('m_aa0819dfc4d8') }}{{ t('m_47a270081ab2') }}</span>
        <button type="button" class="wb-design-debug-close" :aria-label="t('m_3fd47edce45b')" @click="emit('close')">✕</button>
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
          <span class="wb-design-debug-label">{{ t('m_9315c04282f8') }}</span>
          <input
            v-model.number="radius"
            type="range"
            :min="RADIUS_RANGE.min"
            :max="RADIUS_RANGE.max"
            :step="RADIUS_RANGE.step"
            :aria-label="t('m_0948593eb54f')"
            @input="onRadiusInput"
          />
          <code class="wb-design-debug-value">{{ radius }}px</code>
        </label>

        <label class="wb-design-debug-row">
          <span class="wb-design-debug-label">{{ t('m_3d1630c80dd4') }}</span>
          <input
            v-model.number="borderAlpha"
            type="range"
            :min="BORDER_ALPHA_RANGE.min"
            :max="BORDER_ALPHA_RANGE.max"
            :step="BORDER_ALPHA_RANGE.step"
            :aria-label="t('m_3d1630c80dd4')"
            @input="onBorderInput"
          />
          <code class="wb-design-debug-value">{{ borderAlpha.toFixed(2) }}</code>
        </label>

        <label class="wb-design-debug-row">
          <span class="wb-design-debug-label">{{ t('m_0be82c47974e') }}</span>
          <input
            v-model.number="shadowStrength"
            type="range"
            :min="SHADOW_RANGE.min"
            :max="SHADOW_RANGE.max"
            :step="SHADOW_RANGE.step"
            :aria-label="t('m_b5584ff20d2a')"
            @input="onShadowInput"
          />
          <code class="wb-design-debug-value">{{ shadowStrength.toFixed(2) }}</code>
        </label>

        <label class="wb-design-debug-row">
          <span class="wb-design-debug-label">{{ t('m_c8e75bb10658') }}</span>
          <input
            v-model.number="fillSize"
            type="range"
            :min="FILL_HANDLE_SIZE_RANGE.min"
            :max="FILL_HANDLE_SIZE_RANGE.max"
            :step="FILL_HANDLE_SIZE_RANGE.step"
            :aria-label="t('m_c8e75bb10658')"
            @input="onFillSizeInput"
          />
          <code class="wb-design-debug-value">{{ fillSize }}px</code>
        </label>

        <div class="wb-design-debug-fill">
          <div class="wb-design-debug-fill-copy">
            <span class="wb-design-debug-label">{{ t('m_baa3de1b0d69') }}</span>
            <code class="wb-design-debug-value">left {{ fillLeft }}px · top {{ fillTop }}px</code>
          </div>
          <div class="wb-design-debug-fill-pad" role="group" :aria-label="t('m_aca777cc23b8')">
            <button type="button" class="is-up" :aria-label="t('m_5c4e94f926cb')" @click="nudgeFill('y', -1)">↑</button>
            <button type="button" class="is-left" :aria-label="t('m_7ee4742a6090')" @click="nudgeFill('x', -1)">←</button>
            <button type="button" class="is-down" :aria-label="t('m_d83a75edea0d')" @click="nudgeFill('y', 1)">↓</button>
            <button type="button" class="is-right" :aria-label="t('m_a0d36517ab7a')" @click="nudgeFill('x', 1)">→</button>
          </div>
          <p class="wb-design-debug-fill-hint">{{ t('m_e9a3aa5cc13d') }} {{ FILL_HANDLE_OFFSET_RANGE.min }}～{{ FILL_HANDLE_OFFSET_RANGE.max }}</p>
        </div>
      </div>

      <footer class="wb-design-debug-footer">
        <button type="button" class="wb-design-debug-primary" @click="copyValues">
          {{ copied ? t('m_22240d44ce46') : t('m_86ecb1b34f50') }}
        </button>
        <button type="button" @click="resetAll">{{ t('m_cb5d682bac3d') }}</button>
      </footer>
      <p class="wb-design-debug-hint">{{ t('m_13e172af0241') }}</p>
    </section>
  </Teleport>
</template>
