<script setup>
import { computed, nextTick, ref, watch } from "vue";
import SystemFontPicker from "./SystemFontPicker.vue";
import {
  DEFAULT_FONT_WEIGHT,
  DEFAULT_FONT_PREFERENCE,
  fontStackForPreference,
  normalizeFontPreference,
  normalizeFontWeight,
} from "../composables/useFontPreference.js";
import { createSystemFontsController } from "../composables/useSystemFonts.js";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  preference: { type: String, default: DEFAULT_FONT_PREFERENCE },
  weight: { type: Number, default: DEFAULT_FONT_WEIGHT },
  theme: { type: String, default: "light" },
  invokeWorkbench: { type: Function, required: true },
});

const emit = defineEmits(["apply", "close"]);

const fontPickerRef = ref(null);
const dialogRef = ref(null);
const draftPreference = ref(DEFAULT_FONT_PREFERENCE);
const draftWeight = ref(DEFAULT_FONT_WEIGHT);
const systemFonts = createSystemFontsController(props.invokeWorkbench);
const previewStyle = computed(() => ({
  fontFamily: fontStackForPreference(draftPreference.value) || "var(--wb-font-ui)",
  fontWeight: draftWeight.value,
}));

function resetDraft() {
  draftPreference.value = normalizeFontPreference(props.preference);
  draftWeight.value = normalizeFontWeight(props.weight);
}

function close() {
  resetDraft();
  emit("close");
}

useEscClose(() => props.open, close, null, { dialogRef });

function restoreDefault() {
  draftPreference.value = DEFAULT_FONT_PREFERENCE;
  draftWeight.value = DEFAULT_FONT_WEIGHT;
}

function apply() {
  emit("apply", { preference: draftPreference.value, weight: draftWeight.value });
  emit("close");
}

function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    resetDraft();
    void systemFonts.load().catch(() => {});
    await nextTick();
    fontPickerRef.value?.focus?.();
  },
  { immediate: true },
);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="wb-shortcut-dialog-overlay wb-font-dialog-overlay wb-floating-themed"
      :data-theme="theme"
    >
      <section
        ref="dialogRef"
        class="wb-shortcut-dialog wb-font-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-font-dialog-title"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="wb-shortcut-dialog-header">
          <strong id="wb-font-dialog-title">字体设置</strong>
          <button type="button" class="wb-shortcut-dialog-close" aria-label="关闭" @click="close">✕</button>
        </header>

        <div class="wb-font-dialog-body">
          <div class="wb-font-controls">
            <div class="wb-font-field">
              <span>选择界面字体</span>
              <SystemFontPicker
                ref="fontPickerRef"
                v-model="draftPreference"
                v-model:weight="draftWeight"
                :fonts="systemFonts.fonts.value"
                :loading="systemFonts.loading.value"
                :error="systemFonts.error.value"
                @retry="systemFonts.refresh().catch(() => {})"
              />
            </div>
          </div>

          <div class="wb-font-preview" :style="previewStyle" aria-label="字体预览">
            <span class="wb-font-preview-label">效果预览</span>
            <div class="wb-font-preview-sample">
              <strong>黑猫工作台</strong>
              <span>客户订单表 · 数据库连接</span>
              <span>Inventory 2026 · 0123456789</span>
            </div>
          </div>
        </div>

        <footer class="wb-shortcut-dialog-footer wb-font-dialog-footer">
          <button type="button" class="wb-font-reset" @click="restoreDefault">恢复默认</button>
          <span class="wb-font-dialog-footer-actions">
            <button type="button" @click="close">取消</button>
            <button type="button" class="wb-shortcut-dialog-primary" @click="apply">应用</button>
          </span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
