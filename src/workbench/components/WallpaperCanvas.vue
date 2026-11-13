<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import { useWallpaper } from "../composables/useWallpaper.js";
import "../wallpaperCanvas.css";

const { settings, source, customKind, reportError } = useWallpaper();
const video = ref(null);
const hidden = ref(false);
const reducedMotion = ref(false);
const failed = ref(false);
const isVideo = computed(() => settings.value.id === "custom" && customKind.value === "video");
const visible = computed(() => Boolean(source.value) && settings.value.visibility > 0);
const style = computed(() => ({
  "--wb-wallpaper-visibility": settings.value.visibility,
  "--wb-wallpaper-blur": `${settings.value.blur}px`,
  "--wb-wallpaper-overscan": `${settings.value.blur * 3}px`,
}));
let mediaQuery;
let playGeneration = 0;
const updateVisibility = () => { hidden.value = document.hidden; };
const updateMotion = () => { reducedMotion.value = mediaQuery.matches; };
function playbackFailed() {
  failed.value = true;
  reportError("wallpaper.error.playback");
}
const wantsPlayback = () => settings.value.motion && !reducedMotion.value && !hidden.value && visible.value;
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
      <video v-if="isVideo" :key="source" ref="video" class="wb-wallpaper-art" :src="source" muted loop playsinline preload="auto" @loadeddata="syncPlayback" @error="playbackFailed" />
      <img v-else :key="`image:${source}`" class="wb-wallpaper-art" :src="source" alt="" decoding="async" @error="failed = true; reportError('wallpaper.error.decode')" />
    </template>
  </div>
</template>
