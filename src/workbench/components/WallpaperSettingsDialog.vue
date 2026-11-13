<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { Check, ImagePlus, Minus, Video, X } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useEscClose } from "../composables/useEscClose.js";
import { useWallpaper, WALLPAPERS, WALLPAPER_APPEARANCES } from "../composables/useWallpaper.js";
import { measureWallpaperCeilings } from "../wallpaperTone.js";
import "../wallpaperSettings.css";

const props = defineProps({
  open: { type: Boolean, default: false },
  theme: { type: String, default: "light" },
});
const emit = defineEmits(["close"]);
const {
  settings, appearance, customUrl, customKind, busy, error,
  select, updateSettings, reset, importFile, removeCustom,
} = useWallpaper();
const dialogRef = ref(null);
const gridRef = ref(null);
const fileRef = ref(null);
// The appearance being edited; it starts on the one on screen and can be the
// other one, which only the preview can show.
const editing = ref(appearance.value);
const edited = computed(() => settings.value[editing.value]);
const focusedId = ref(edited.value.id);
const previewCeilings = ref(null);
// Pictures that suit the edited appearance come first and are marked.
const choices = computed(() => [
  { id: "none", name: t("wallpaper.none") },
  ...[
    ...WALLPAPERS.filter(({ suits }) => suits === editing.value),
    ...WALLPAPERS.filter(({ suits }) => suits !== editing.value),
  ].map((wallpaper) => {
    const recommended = wallpaper.suits === editing.value;
    const name = t(wallpaper.labelKey);
    return {
      ...wallpaper, recommended, name,
      label: recommended ? t("wallpaper.recommendedName", { name }) : name,
    };
  }),
  { id: "custom", name: t("wallpaper.custom") },
]);
const choiceIds = computed(() => choices.value.map(({ id }) => id));
// Measured, so it also speaks for custom pictures.
const dimmed = computed(() => Boolean(previewCeilings.value) && previewCeilings.value[editing.value] < 0.5);
const visibility = computed(() => Math.round(edited.value.visibility * 100));
const customIsVideo = computed(() => customKind.value === "video");
const isVideo = computed(() => edited.value.id === "custom" && customIsVideo.value);
const previewSource = computed(() => edited.value.id === "custom" ? customUrl.value
  : WALLPAPERS.find(({ id }) => id === edited.value.id)?.thumbnail || "");
const previewStyle = computed(() => ({
  "--wb-wallpaper-preview-strength": previewCeilings.value
    ? edited.value.visibility * previewCeilings.value[editing.value] : 0,
  "--wb-wallpaper-preview-blur": `${edited.value.blur}px`,
}));
// Offer the counterpart picture for the other appearance while it uses
// something else.
const pairOffer = computed(() => {
  const pair = WALLPAPERS.find(({ id }) => id === edited.value.id)?.pair;
  const other = editing.value === "light" ? "dark" : "light";
  if (!pair || settings.value[other].id === pair) return null;
  return {
    id: pair,
    appearance: other,
    label: t("wallpaper.pair.offer", {
      appearance: t(`wallpaper.appearance.${other}`),
      name: t(`wallpaper.builtin.${pair}`),
    }),
  };
});
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
  void select(id, editing.value);
}

function onChoiceKeydown(event, id) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const ids = choiceIds.value;
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
  if (target !== "custom" || customUrl.value) void select(target, editing.value);
}

async function onFileChange(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file && await importFile(file, editing.value)) {
    await nextTick();
    if (props.open) focusChoice("custom");
  }
}

async function remove() {
  if (await removeCustom()) {
    await nextTick();
    if (props.open) focusChoice(edited.value.id);
  }
}

function measurePreview(event) {
  previewCeilings.value = measureWallpaperCeilings(event.target);
}

watch(() => props.open, async (open) => {
  if (!open) return;
  editing.value = appearance.value;
  focusedId.value = edited.value.id;
  await nextTick();
  focusChoice(edited.value.id);
}, { immediate: true });
watch(() => edited.value.id, (id) => { focusedId.value = id; });
watch(previewSource, () => { previewCeilings.value = null; });
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
          <div class="wb-wallpaper-stage">
            <div
              class="wb-wallpaper-preview wb-floating-themed" :data-theme="editing" :style="previewStyle" role="img"
              :aria-label="t('wallpaper.preview', { appearance: t(`wallpaper.appearance.${editing}`) })"
            >
              <template v-if="previewSource">
                <video v-if="isVideo" :key="previewSource" class="wb-wallpaper-preview-art" :src="previewSource" muted playsinline preload="auto" @loadeddata="measurePreview" />
                <img v-else :key="`image:${previewSource}`" class="wb-wallpaper-preview-art" :src="previewSource" alt="" @load="measurePreview" />
              </template>
              <span class="wb-wallpaper-preview-sheet"><span class="wb-wallpaper-preview-tab"></span></span>
            </div>
            <div class="wb-wallpaper-controls">
              <p id="wb-wallpaper-hint" class="wb-wallpaper-hint">{{ t('wallpaper.hint') }}</p>
              <div class="wb-wallpaper-segment" role="group" :aria-label="t('wallpaper.appearance')">
                <button
                  v-for="option in WALLPAPER_APPEARANCES" :key="option" type="button"
                  :class="{ active: editing === option }" :aria-pressed="editing === option" :data-wallpaper-appearance="option"
                  @click="editing = option"
                >{{ t(`wallpaper.appearance.${option}`) }}<small v-if="appearance === option">{{ t('wallpaper.appearance.inUse') }}</small></button>
              </div>
              <div class="wb-wallpaper-slider-row">
                <label for="wb-wallpaper-visibility">{{ t('wallpaper.visibility') }}</label>
                <input id="wb-wallpaper-visibility" type="range" min="0" max="100" step="1" :disabled="edited.id === 'none'" :value="visibility" :aria-valuetext="`${visibility}%`" @input="updateSettings({ visibility: Number($event.target.value) / 100 }, editing)" />
                <output for="wb-wallpaper-visibility">{{ visibility }}%</output>
              </div>
              <div class="wb-wallpaper-slider-row">
                <label for="wb-wallpaper-blur">{{ t('wallpaper.blur') }}</label>
                <input id="wb-wallpaper-blur" type="range" min="0" max="24" step="1" :disabled="edited.id === 'none' || edited.visibility === 0" :value="edited.blur" :aria-valuetext="t('wallpaper.pixels', { value: edited.blur })" @input="updateSettings({ blur: Number($event.target.value) }, editing)" />
                <output for="wb-wallpaper-blur">{{ t('wallpaper.pixels', { value: edited.blur }) }}</output>
              </div>
              <label v-if="isVideo" class="wb-wallpaper-motion">
                <input type="checkbox" role="switch" :checked="settings.motion" :aria-checked="settings.motion" @change="updateSettings({ motion: $event.target.checked }, editing)" />
                <span>{{ t('wallpaper.motion') }}<small>{{ t('wallpaper.motionHint') }}</small></span>
              </label>
              <button v-if="pairOffer" type="button" class="wb-wallpaper-pair" :disabled="busy" @click="select(pairOffer.id, pairOffer.appearance)">{{ pairOffer.label }}</button>
            </div>
          </div>
          <div ref="gridRef" class="wb-wallpaper-grid" role="radiogroup" :aria-label="t('wallpaper.choose')">
            <button
              v-for="choice in choices" :key="choice.id" type="button" role="radio"
              class="wb-wallpaper-tile" :class="{ 'is-selected': edited.id === choice.id, 'wb-wallpaper-upload-tile': choice.id === 'custom' && !customUrl }"
              :data-wallpaper-id="choice.id" :aria-checked="edited.id === choice.id"
              :aria-label="choice.label || choice.name" :tabindex="focusedId === choice.id ? 0 : -1"
              @focus="focusedId = choice.id" @click="activateChoice(choice.id)" @keydown="onChoiceKeydown($event, choice.id)"
            >
              <span class="wb-wallpaper-thumbnail" aria-hidden="true">
                <Minus v-if="choice.id === 'none'" :size="22" />
                <template v-else-if="choice.id === 'custom'">
                  <ImagePlus v-if="!customUrl" :size="22" />
                  <Video v-else-if="customIsVideo" :size="22" />
                  <img v-else :src="customUrl" alt="" />
                </template>
                <img v-else :src="choice.thumbnail" alt="" decoding="async" />
                <span v-if="choice.recommended" class="wb-wallpaper-recommended">{{ t('wallpaper.recommended') }}</span>
                <span v-if="edited.id === choice.id" class="wb-wallpaper-selected"><Check :size="13" /></span>
              </span>
              <span class="wb-wallpaper-tile-label">{{ choice.name }}</span>
            </button>
          </div>
          <p v-if="dimmed" class="wb-wallpaper-hint" role="status">{{ t('wallpaper.dimmed', { appearance: t(`wallpaper.appearance.${editing}`) }) }}</p>
          <div class="wb-wallpaper-upload-row">
            <div class="wb-wallpaper-upload-actions">
              <button type="button" class="wb-wallpaper-action" :disabled="busy" @click="fileRef?.click()">{{ t(customUrl ? 'wallpaper.replace' : 'wallpaper.upload') }}</button>
              <button v-if="customUrl" type="button" class="wb-wallpaper-action" :disabled="busy" @click="remove">{{ t('wallpaper.remove') }}</button>
            </div>
            <p id="wb-wallpaper-file-hint" class="wb-wallpaper-hint">{{ t('wallpaper.fileHint') }}</p>
            <input ref="fileRef" type="file" hidden accept="image/png,image/jpeg,image/webp,video/mp4" :aria-label="t('wallpaper.upload')" aria-describedby="wb-wallpaper-file-hint" @change="onFileChange" />
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
