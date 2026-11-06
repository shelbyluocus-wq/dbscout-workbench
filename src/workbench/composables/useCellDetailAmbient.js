import { computed, onBeforeUnmount, ref } from "vue";
import { MINUTES_PER_DAY, ambientStyleVars, minutesOfDay, normalizeMinutes } from "../utils/cellDetailAmbient.js";

// One clock shared by every cell detail panel; it only runs while a panel is
// mounted and ticks once a minute, so it never competes with grid work.
const clockMinutes = ref(minutesOfDay());
const previewMinutes = ref(null);
const playing = ref(false);

const PLAY_TICK_MS = 50;
// A whole day plays in about 24 seconds.
const PLAY_MINUTES_PER_TICK = (MINUTES_PER_DAY / 24000) * PLAY_TICK_MS;

let consumers = 0;
let clockTimeout = null;
let clockInterval = null;
let playTimer = null;

function syncClock() {
  clockMinutes.value = minutesOfDay();
}

function startClock() {
  syncClock();
  const now = new Date();
  const untilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  clockTimeout = setTimeout(() => {
    syncClock();
    clockInterval = setInterval(syncClock, 60_000);
  }, untilNextMinute);
}

function stopClock() {
  clearTimeout(clockTimeout);
  clearInterval(clockInterval);
  clockTimeout = null;
  clockInterval = null;
}

const effectiveMinutes = computed(() => previewMinutes.value ?? clockMinutes.value);
const ambientStyle = computed(() => ambientStyleVars(effectiveMinutes.value));

function stopPlaying() {
  clearInterval(playTimer);
  playTimer = null;
  playing.value = false;
}

// Debug-only controls (design diagnostics); a preview is never persisted.
export const cellDetailAmbientPreview = {
  minutes: effectiveMinutes,
  previewing: computed(() => previewMinutes.value !== null),
  playing,
  setMinutes(value) {
    stopPlaying();
    previewMinutes.value = normalizeMinutes(value);
  },
  followSystem() {
    stopPlaying();
    previewMinutes.value = null;
    syncClock();
  },
  play() {
    if (playTimer) return;
    if (previewMinutes.value === null) previewMinutes.value = clockMinutes.value;
    playing.value = true;
    playTimer = setInterval(() => {
      previewMinutes.value = normalizeMinutes(previewMinutes.value + PLAY_MINUTES_PER_TICK);
    }, PLAY_TICK_MS);
  },
  pause: stopPlaying,
};

export function useCellDetailAmbient() {
  consumers += 1;
  if (consumers === 1) startClock();
  onBeforeUnmount(() => {
    consumers -= 1;
    if (consumers === 0) stopClock();
  });
  return { ambientStyle };
}
