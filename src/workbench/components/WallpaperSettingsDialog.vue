<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, ImagePlus, Minus, Trash2, Video, X } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useEscClose } from "../composables/useEscClose.js";
import {
  useWallpaper, wallpaperContentVeil, WALLPAPERS, WALLPAPER_APPEARANCES, WALLPAPER_SCOPES,
} from "../composables/useWallpaper.js";
import { measureWallpaperCeilings } from "../wallpaperTone.js";
import "../wallpaperSettings.css";

// A side panel rather than a centred dialog: the window beside it is the live
// preview of the appearance on screen; the miniature shows the edited one.
const props = defineProps({
  open: { type: Boolean, default: false },
  theme: { type: String, default: "light" },
});
const emit = defineEmits(["close", "set-theme"]);
const {
  settings, appearance, customWallpapers, busy, error,
  select, updateSettings, reset, importFile, removeCustom,
} = useWallpaper();
const GRID_COLUMNS = 4;
const dialogRef = ref(null);
const gridRef = ref(null);
const fileRef = ref(null);
// The edited appearance follows the window, including external theme changes.
const editing = ref(appearance.value);
const edited = computed(() => settings.value[editing.value]);
const focusedId = ref(edited.value.id);
const previewCeilings = ref(null);
const dragging = ref(false);
const importing = ref(false);
const fileBusy = computed(() => busy.value || importing.value);
// Slider drags save on every step; only a slow save is worth a status line.
const saving = ref(false);
let savingTimer;
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
  ...customWallpapers.value.map((item) => ({ ...item, custom: true, name: item.name || t("wallpaper.custom") })),
]);
const choiceIds = computed(() => choices.value.map(({ id }) => id));
const selectedName = computed(() => choices.value.find(({ id }) => id === edited.value.id)?.name || "");
const hasPicture = computed(() => edited.value.id !== "none");
// Measured, so it also speaks for custom pictures.
const dimmed = computed(() => hasPicture.value && Boolean(previewCeilings.value)
  && previewCeilings.value[editing.value] < 0.5);
const percent = (value) => Math.round(value * 100);
const visibility = computed(() => percent(edited.value.visibility));
const contentReveal = computed(() => percent(settings.value.contentReveal));
const editedCustom = computed(() => customWallpapers.value.find(({ id }) => id === edited.value.id));
const isVideo = computed(() => editedCustom.value?.kind === "video");
const previewSource = computed(() => editedCustom.value?.url
  || WALLPAPERS.find(({ id }) => id === edited.value.id)?.src || "");
const previewStyle = computed(() => ({
  "--wb-wallpaper-preview-strength": previewCeilings.value
    ? edited.value.visibility * previewCeilings.value[editing.value] : 0,
  "--wb-wallpaper-preview-blur": `${edited.value.blur}px`,
  "--wb-wallpaper-preview-veil": `${hasPicture.value ? wallpaperContentVeil(settings.value) * 100 : 100}%`,
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

function chooseFile() {
  if (!fileBusy.value) fileRef.value?.click();
}

function activateChoice(id) {
  if (!importing.value) void select(id, editing.value);
}

// Arrows move through the grid as laid out: left/right by one, up/down by a row.
function onChoiceKeydown(event, id) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const ids = choiceIds.value;
  const index = ids.indexOf(id);
  const steps = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: GRID_COLUMNS, ArrowUp: -GRID_COLUMNS };
  let target;
  if (event.key === "Home") target = ids[0];
  else if (event.key === "End") target = ids.at(-1);
  else if (event.key in steps) {
    const next = index + steps[event.key];
    target = Math.abs(steps[event.key]) === 1
      ? ids[(next + ids.length) % ids.length]
      : ids[Math.max(0, Math.min(ids.length - 1, next))];
  } else return;
  event.preventDefault();
  event.stopPropagation();
  if (target === id) return;
  focusChoice(target);
  activateChoice(target);
}

async function useFiles(files) {
  if (fileBusy.value || !files.length) return;
  const targetAppearance = editing.value;
  importing.value = true;
  try {
    for (const file of files) {
      if (!await importFile(file, targetAppearance)) break;
    }
    await nextTick();
    if (props.open) focusChoice(edited.value.id);
  } finally {
    importing.value = false;
  }
}

function onFileChange(event) {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  void useFiles(files);
}

const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
function onDragOver(event) {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = fileBusy.value ? "none" : "copy";
  dragging.value = true;
}
function onDragLeave(event) {
  if (!dialogRef.value?.contains(event.relatedTarget)) dragging.value = false;
}
function onDrop(event) {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragging.value = false;
  void useFiles([...(event.dataTransfer.files || [])]);
}

async function remove(id) {
  if (await removeCustom(id)) {
    await nextTick();
    if (props.open) focusChoice(edited.value.id);
  }
}

function measurePreview(event) {
  previewCeilings.value = measureWallpaperCeilings(event.target);
}

function switchAppearance(value) {
  editing.value = value;
  emit("set-theme", value);
}
watch(appearance, (value) => { editing.value = value; });

const setVisibility = (event) => updateSettings({ visibility: Number(event.target.value) / 100 }, editing.value);
const setBlur = (event) => updateSettings({ blur: Number(event.target.value) }, editing.value);
const setContentReveal = (event) => updateSettings({ contentReveal: Number(event.target.value) / 100 });
const setScope = (scope) => { if (scope !== settings.value.scope) void updateSettings({ scope }); };

watch(() => props.open, async (open) => {
  if (!open) return;
  editing.value = appearance.value;
  focusedId.value = edited.value.id;
  await nextTick();
  focusChoice(edited.value.id);
}, { immediate: true });
watch(() => edited.value.id, (id) => { focusedId.value = id; });
watch(previewSource, () => { previewCeilings.value = null; });
watch(busy, (value) => {
  clearTimeout(savingTimer);
  if (!value) saving.value = false;
  else savingTimer = setTimeout(() => { saving.value = true; }, 500);
});
onBeforeUnmount(() => clearTimeout(savingTimer));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="wb-wallpaper-overlay wb-floating-themed" :data-theme="theme" @pointerdown.self="close">
      <section
        ref="dialogRef" class="wb-wallpaper-panel" :class="{ 'is-drop-target': dragging }"
        role="dialog" aria-modal="true" aria-labelledby="wb-wallpaper-title" tabindex="-1"
        @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop"
      >
        <header class="wb-wallpaper-header">
          <strong id="wb-wallpaper-title">{{ t('wallpaper.title') }}</strong>
          <button type="button" class="wb-wallpaper-close" :aria-label="t('wallpaper.close')" @click="close"><X :size="16" aria-hidden="true" /></button>
        </header>
        <div class="wb-wallpaper-body">
          <div class="wb-wallpaper-segment" role="group" :aria-label="t('wallpaper.appearance')">
            <button
              v-for="option in WALLPAPER_APPEARANCES" :key="option" type="button"
              :class="{ active: editing === option }" :aria-pressed="editing === option" :data-wallpaper-appearance="option"
              @click="switchAppearance(option)"
            >{{ t(`wallpaper.appearance.${option}`) }}<small v-if="appearance === option">{{ t('wallpaper.appearance.inUse') }}</small></button>
          </div>

          <figure class="wb-wallpaper-stage">
            <div
              class="wb-wallpaper-preview wb-floating-themed" :class="{ 'is-window': settings.scope === 'window' }"
              :data-theme="editing" :style="previewStyle" role="img"
              :aria-label="t('wallpaper.preview', { appearance: t(`wallpaper.appearance.${editing}`) })"
            >
              <template v-if="previewSource">
                <video v-if="isVideo" :key="previewSource" class="wb-wallpaper-preview-art" :src="previewSource" muted playsinline preload="auto" @loadeddata="measurePreview" />
                <img v-else :key="`image:${previewSource}`" class="wb-wallpaper-preview-art" :src="previewSource" alt="" @load="measurePreview" />
              </template>
              <span class="wb-wallpaper-mini-rail"><i></i><i></i><i></i></span>
              <span class="wb-wallpaper-mini-sidebar"><i></i><i></i><i></i><i></i><i></i></span>
              <span class="wb-wallpaper-mini-sheet">
                <span class="wb-wallpaper-mini-tab"></span>
                <span class="wb-wallpaper-mini-toolbar"></span>
                <span class="wb-wallpaper-mini-header"></span>
                <span class="wb-wallpaper-mini-rows"><i></i><i></i><i></i><i></i><i></i><i></i></span>
              </span>
            </div>
            <figcaption>
              <span class="wb-wallpaper-current">{{ selectedName }}</span>
              <button v-if="pairOffer" type="button" class="wb-wallpaper-link" :disabled="fileBusy" @click="select(pairOffer.id, pairOffer.appearance)">{{ pairOffer.label }}</button>
            </figcaption>
          </figure>
          <p v-if="dimmed" class="wb-wallpaper-note" role="status">{{ t('wallpaper.dimmed', { appearance: t(`wallpaper.appearance.${editing}`) }) }}</p>

          <section class="wb-wallpaper-section" aria-labelledby="wb-wallpaper-display">
            <h3 id="wb-wallpaper-display" class="wb-wallpaper-section-title">{{ t('wallpaper.display') }}</h3>
            <div class="wb-wallpaper-row">
              <span id="wb-wallpaper-scope-label">{{ t('wallpaper.scope') }}</span>
              <div class="wb-wallpaper-segment is-compact" role="radiogroup" aria-labelledby="wb-wallpaper-scope-label">
                <button
                  v-for="scope in WALLPAPER_SCOPES" :key="scope" type="button" role="radio" :disabled="importing"
                  :class="{ active: settings.scope === scope }" :aria-checked="settings.scope === scope" :data-wallpaper-scope="scope"
                  @click="setScope(scope)"
                >{{ t(`wallpaper.scope.${scope}`) }}</button>
              </div>
            </div>
            <div class="wb-wallpaper-row">
              <label for="wb-wallpaper-visibility">{{ t('wallpaper.visibility') }}</label>
              <input id="wb-wallpaper-visibility" type="range" min="0" max="100" step="1" :disabled="!hasPicture || importing" :value="visibility" :aria-valuetext="`${visibility}%`" @input="setVisibility" />
              <output for="wb-wallpaper-visibility">{{ visibility }}%</output>
            </div>
            <div v-if="settings.scope === 'window'" class="wb-wallpaper-row">
              <label for="wb-wallpaper-content" :title="t('wallpaper.contentRevealHint')">{{ t('wallpaper.contentReveal') }}</label>
              <input id="wb-wallpaper-content" type="range" min="0" max="100" step="1" :disabled="!hasPicture || importing" :value="contentReveal" :aria-valuetext="`${contentReveal}%`" :aria-description="t('wallpaper.contentRevealHint')" @input="setContentReveal" />
              <output for="wb-wallpaper-content">{{ contentReveal }}%</output>
            </div>
            <div class="wb-wallpaper-row">
              <label for="wb-wallpaper-blur">{{ t('wallpaper.blur') }}</label>
              <input id="wb-wallpaper-blur" type="range" min="0" max="24" step="1" :disabled="!hasPicture || edited.visibility === 0 || importing" :value="edited.blur" :aria-valuetext="t('wallpaper.pixels', { value: edited.blur })" @input="setBlur" />
              <output for="wb-wallpaper-blur">{{ t('wallpaper.pixels', { value: edited.blur }) }}</output>
            </div>
            <label v-if="isVideo" class="wb-wallpaper-motion">
              <input type="checkbox" role="switch" :disabled="importing" :checked="settings.motion" :aria-checked="settings.motion" @change="updateSettings({ motion: $event.target.checked }, editing)" />
              <span>{{ t('wallpaper.motion') }}<small>{{ t('wallpaper.motionHint') }}</small></span>
            </label>
          </section>
          <section class="wb-wallpaper-section" aria-labelledby="wb-wallpaper-pictures">
            <div class="wb-wallpaper-pictures-heading">
              <h3 id="wb-wallpaper-pictures" class="wb-wallpaper-section-title">{{ t('wallpaper.pictures') }}</h3>
              <button type="button" class="wb-wallpaper-link wb-wallpaper-add" :disabled="fileBusy" @click="chooseFile"><ImagePlus :size="14" aria-hidden="true" />{{ t('wallpaper.add') }}</button>
            </div>
            <div ref="gridRef" class="wb-wallpaper-grid" role="radiogroup" :aria-label="t('wallpaper.choose')">
              <div v-for="choice in choices" :key="choice.id" class="wb-wallpaper-choice" :class="{ 'is-custom': choice.custom }">
              <button
                type="button" role="radio" :disabled="importing"
                class="wb-wallpaper-tile" :class="{ 'is-selected': edited.id === choice.id, 'is-word': choice.id === 'none' || choice.kind === 'video' }"
                :data-wallpaper-id="choice.id" :aria-checked="edited.id === choice.id"
                :aria-label="choice.label || choice.name" :title="choice.name" :tabindex="focusedId === choice.id ? 0 : -1"
                @focus="focusedId = choice.id" @click="activateChoice(choice.id)" @keydown="onChoiceKeydown($event, choice.id)"
              >
                <template v-if="choice.id === 'none'"><Minus :size="16" aria-hidden="true" /><span>{{ choice.name }}</span></template>
                <template v-else-if="choice.kind === 'video'"><Video :size="16" aria-hidden="true" /><span class="wb-wallpaper-video-name">{{ choice.name }}</span></template>
                <img v-else :src="choice.url || choice.thumbnail" alt="" decoding="async" loading="lazy" />
                <span v-if="choice.recommended" class="wb-wallpaper-recommended" aria-hidden="true">{{ t('wallpaper.recommended') }}</span>
                <span v-if="edited.id === choice.id" class="wb-wallpaper-selected" aria-hidden="true"><Check :size="11" :stroke-width="3" /></span>
              </button>
              <button v-if="choice.custom" type="button" class="wb-wallpaper-delete" :disabled="fileBusy" :data-wallpaper-delete="choice.id" :aria-label="t('wallpaper.removeNamed', { name: choice.name })" :title="t('wallpaper.removeNamed', { name: choice.name })" @click="remove(choice.id)"><Trash2 :size="12" aria-hidden="true" /></button>
              </div>
            </div>
            <div class="wb-wallpaper-file">
              <p id="wb-wallpaper-file-hint" class="wb-wallpaper-note">{{ t('wallpaper.fileHint') }}</p>
            </div>
            <input ref="fileRef" type="file" hidden multiple accept="image/png,image/jpeg,image/webp,video/mp4" :aria-label="t('wallpaper.upload')" aria-describedby="wb-wallpaper-file-hint" @change="onFileChange" />
          </section>

          <p v-if="error" class="wb-wallpaper-error" role="alert">{{ t(error) }}</p>
        </div>
        <footer class="wb-wallpaper-footer">
          <button type="button" class="wb-wallpaper-link" :disabled="fileBusy" @click="reset">{{ t('wallpaper.reset') }}</button>
          <span v-if="saving" class="wb-wallpaper-note" role="status">{{ t('wallpaper.saving') }}</span>
        </footer>
        <div v-if="dragging" class="wb-wallpaper-dropzone" aria-hidden="true"><ImagePlus :size="22" /><span>{{ t('wallpaper.drop') }}</span></div>
      </section>
    </div>
  </Teleport>
</template>
