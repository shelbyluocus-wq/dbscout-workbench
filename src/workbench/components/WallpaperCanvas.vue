<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import { useWallpaper } from "../composables/useWallpaper.js";
import { measureWallpaperCeilings, WALLPAPER_FALLBACK_CEILINGS } from "../wallpaperTone.js";
import "../wallpaperCanvas.css";

const emit = defineEmits(["strength-change"]);
const { settings, active, appearance, source, customKind, reportError } = useWallpaper();
const video = ref(null);
const hidden = ref(false);
const reducedMotion = ref(false);
const failed = ref(false);
// Measured from the picture on screen; null until it has loaded, which keeps
// the artwork invisible and lets it fade in at its readable strength.
const ceilings = ref(null);
const isVideo = computed(() => customKind.value === "video");
const visible = computed(() => Boolean(source.value) && active.value.visibility > 0);
const wantsPlayback = () => settings.value.motion && !reducedMotion.value && !hidden.value && visible.value;
const strength = computed(() => {
  if (!ceilings.value) return 0;
  // A playing video shows frames nobody measured.
  const limit = isVideo.value && settings.value.motion ? WALLPAPER_FALLBACK_CEILINGS : ceilings.value;
  return active.value.visibility * limit[appearance.value];
});
const style = computed(() => ({
  "--wb-wallpaper-strength": strength.value,
  "--wb-wallpaper-blur": `${active.value.blur}px`,
  "--wb-wallpaper-overscan": `${active.value.blur * 3}px`,
}));
let mediaQuery;
let playGeneration = 0;
const updateVisibility = () => { hidden.value = document.hidden; };
const updateMotion = () => { reducedMotion.value = mediaQuery.matches; };
function measure(event) {
  if (!ceilings.value) ceilings.value = measureWallpaperCeilings(event.target);
}
function playbackFailed() {
  failed.value = true;
  reportError("wallpaper.error.playback");
}
async function syncPlayback() {
  const generation = ++playGeneration;
  await nextTick();
  const element = video.value;
  if (!element || generation !== playGeneration) return;
  if (!wantsPlayback()) {
    element.pause();
    return;
  }
  try { await element.play(); } catch (cause) {
    if (generation !== playGeneration || video.value !== element || !wantsPlayback() || cause?.name === "AbortError") return;
    // A blocked play is not a corrupt file. Retain the paused frame and let
    // the motion switch retry, instead of permanently removing the decoder.
    element.pause();
    reportError("wallpaper.error.playback");
  }
}
watch(strength, (value) => emit("strength-change", value));
watch(source, () => { ceilings.value = null; });
watch([source, () => settings.value.motion], () => { failed.value = false; });
watch([video, () => settings.value.motion, visible, hidden, reducedMotion], syncPlayback);
onMounted(() => {
  mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  updateMotion();
  updateVisibility();
  mediaQuery.addEventListener("change", updateMotion);
  document.addEventListener("visibilitychange", updateVisibility);
});
onBeforeUnmount(() => {
  ++playGeneration;
  video.value?.pause();
  mediaQuery?.removeEventListener("change", updateMotion);
  document.removeEventListener("visibilitychange", updateVisibility);
});
</script>

<template>
  <div v-if="source" class="wb-wallpaper-canvas" :style="style" aria-hidden="true">
    <template v-if="visible && !failed">
      <video v-if="isVideo" :key="source" ref="video" class="wb-wallpaper-art" :class="{ 'is-measured': ceilings }" :src="source" muted loop playsinline preload="auto" @loadeddata="measure($event); syncPlayback()" @error="playbackFailed" />
      <img v-else :key="`image:${source}`" class="wb-wallpaper-art" :class="{ 'is-measured': ceilings }" :src="source" alt="" decoding="async" @load="measure" @error="failed = true; reportError('wallpaper.error.decode')" />
    </template>
  </div>
</template>
