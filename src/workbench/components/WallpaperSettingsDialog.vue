<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { Check, ImagePlus, Minus, Video, X } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useEscClose } from "../composables/useEscClose.js";
import { useWallpaper, WALLPAPERS } from "../composables/useWallpaper.js";
import "../wallpaperSettings.css";

const props = defineProps({
  open: { type: Boolean, default: false },
  theme: { type: String, default: "light" },
});
const emit = defineEmits(["close"]);
const { settings, customUrl, customKind, busy, error, select, updateSettings, reset, importFile, removeCustom } = useWallpaper();
const dialogRef = ref(null);
const gridRef = ref(null);
const fileRef = ref(null);
const focusedId = ref("none");
const choices = computed(() => [
  { id: "none", labelKey: "wallpaper.none" },
  ...WALLPAPERS,
  { id: "custom", labelKey: "wallpaper.custom" },
]);
const visibility = computed(() => Math.round(settings.value.visibility * 100));
const isVideo = computed(() => settings.value.id === "custom" && customKind.value === "video");
const close = () => emit("close");
// The settings row disappears on opening; the sidebar restores the gear instead.
useEscClose(() => props.open, close, null, { dialogRef, restoreFocus: false });

function focusChoice(id) {
  focusedId.value = id;
  gridRef.value?.querySelector(`[data-wallpaper-id="${id}"]`)?.focus();
}

function activateChoice(id) {
  if (id === "custom" && !customUrl.value) {
    if (!busy.value) fileRef.value?.click();
    return;
  }
  void select(id);
}

function onChoiceKeydown(event, id) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const ids = choices.value.map((choice) => choice.id);
  const index = ids.indexOf(id);
  let target;
  if (event.key === "Home") target = ids[0];
  else if (event.key === "End") target = ids.at(-1);
  else if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
    const delta = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
    target = ids[(index + delta + ids.length) % ids.length];
  } else return;
  event.preventDefault();
  event.stopPropagation();
  focusChoice(target);
  if (target !== "custom" || customUrl.value) void select(target);
}

async function onFileChange(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file && await importFile(file)) {
    await nextTick();
    if (props.open) focusChoice("custom");
  }
}

async function remove() {
  if (await removeCustom()) {
    await nextTick();
    if (props.open) focusChoice(settings.value.id);
  }
}

watch(() => props.open, async (open) => {
  if (!open) return;
  focusedId.value = settings.value.id;
  await nextTick();
  focusChoice(settings.value.id);
}, { immediate: true });
watch(() => settings.value.id, (id) => { focusedId.value = id; });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="wb-shortcut-dialog-overlay wb-floating-themed wb-wallpaper-overlay" :data-theme="theme">
      <section ref="dialogRef" class="wb-shortcut-dialog wb-wallpaper-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-wallpaper-title" aria-describedby="wb-wallpaper-hint" tabindex="-1">
        <header class="wb-shortcut-dialog-header">
          <strong id="wb-wallpaper-title">{{ t('wallpaper.title') }}</strong>
          <button type="button" class="wb-shortcut-dialog-close" :aria-label="t('wallpaper.close')" @click="close"><X :size="18" aria-hidden="true" /></button>
        </header>
        <div class="wb-wallpaper-body">
          <p id="wb-wallpaper-hint" class="wb-wallpaper-hint">{{ t('wallpaper.hint') }}</p>
          <div ref="gridRef" class="wb-wallpaper-grid" role="radiogroup" :aria-label="t('wallpaper.choose')">
            <button
              v-for="choice in choices" :key="choice.id" type="button" role="radio"
              class="wb-wallpaper-tile" :class="{ 'is-selected': settings.id === choice.id, 'wb-wallpaper-upload-tile': choice.id === 'custom' && !customUrl }"
              :data-wallpaper-id="choice.id" :aria-checked="settings.id === choice.id"
              :aria-label="t(choice.labelKey)" :tabindex="focusedId === choice.id ? 0 : -1"
              @focus="focusedId = choice.id" @click="activateChoice(choice.id)" @keydown="onChoiceKeydown($event, choice.id)"
            >
              <span class="wb-wallpaper-thumbnail" aria-hidden="true">
                <Minus v-if="choice.id === 'none'" :size="26" />
                <template v-else-if="choice.id === 'custom'">
                  <ImagePlus v-if="!customUrl" :size="26" />
                  <Video v-else-if="customKind === 'video'" :size="26" />
                  <img v-else :src="customUrl" alt="" />
                </template>
                <img v-else :src="choice.thumbnail" alt="" decoding="async" />
                <span v-if="settings.id === choice.id" class="wb-wallpaper-selected"><Check :size="13" /></span>
              </span>
              <span class="wb-wallpaper-tile-label">{{ t(choice.labelKey) }}</span>
            </button>
          </div>
          <div class="wb-wallpaper-upload-row">
            <div class="wb-wallpaper-upload-actions">
              <button type="button" class="wb-wallpaper-action" :disabled="busy" @click="fileRef?.click()">{{ t(customUrl ? 'wallpaper.replace' : 'wallpaper.upload') }}</button>
              <button v-if="customUrl" type="button" class="wb-wallpaper-action" :disabled="busy" @click="remove">{{ t('wallpaper.remove') }}</button>
            </div>
            <p id="wb-wallpaper-file-hint" class="wb-wallpaper-hint">{{ t('wallpaper.fileHint') }}</p>
            <input ref="fileRef" type="file" hidden accept="image/png,image/jpeg,image/webp,video/mp4" :aria-label="t('wallpaper.upload')" aria-describedby="wb-wallpaper-file-hint" @change="onFileChange" />
          </div>
          <div class="wb-wallpaper-controls">
            <div class="wb-wallpaper-slider-row">
              <label for="wb-wallpaper-visibility">{{ t('wallpaper.visibility') }}</label>
              <input id="wb-wallpaper-visibility" type="range" min="0" max="100" step="1" :value="visibility" :aria-valuetext="`${visibility}%`" @input="updateSettings({ visibility: Number($event.target.value) / 100 })" />
              <output for="wb-wallpaper-visibility">{{ visibility }}%</output>
            </div>
            <div class="wb-wallpaper-slider-row">
              <label for="wb-wallpaper-blur">{{ t('wallpaper.blur') }}</label>
              <input id="wb-wallpaper-blur" type="range" min="0" max="24" step="1" :disabled="settings.id === 'none' || settings.visibility === 0" :value="settings.blur" :aria-valuetext="t('wallpaper.pixels', { value: settings.blur })" @input="updateSettings({ blur: Number($event.target.value) })" />
              <output for="wb-wallpaper-blur">{{ t('wallpaper.pixels', { value: settings.blur }) }}</output>
            </div>
            <label v-if="isVideo" class="wb-wallpaper-motion">
              <input type="checkbox" role="switch" :checked="settings.motion" :aria-checked="settings.motion" @change="updateSettings({ motion: $event.target.checked })" />
              <span>{{ t('wallpaper.motion') }}<small>{{ t('wallpaper.motionHint') }}</small></span>
            </label>
          </div>
          <p v-if="busy" class="wb-wallpaper-hint" role="status">{{ t('wallpaper.saving') }}</p>
          <p v-if="error" class="wb-wallpaper-error" role="alert">{{ t(error) }}</p>
        </div>
        <footer class="wb-wallpaper-footer">
          <button type="button" class="wb-wallpaper-action" :disabled="busy" @click="reset">{{ t('wallpaper.reset') }}</button>
          <span class="wb-wallpaper-hint">{{ t('wallpaper.localOnly') }}</span>
          <button type="button" class="wb-wallpaper-action" @click="close">{{ t('wallpaper.done') }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
