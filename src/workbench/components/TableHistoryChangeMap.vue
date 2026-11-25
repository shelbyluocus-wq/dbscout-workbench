<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "../i18n/index.js";
import { buildChangeMapSegments } from "../utils/tableHistoryLayout.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  indices: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: -1 },
});

const emit = defineEmits(["jump", "seek"]);

const HIT_SLOP = 4;
const MARK_MIN_HEIGHT = 4;
const ACTIVE_MIN_HEIGHT = 9;

const rootRef = ref(null);
const trackRef = ref(null);
const thumbRef = ref(null);
const trackHeight = ref(0);

let viewport = { start: 0, size: 0 };
let resizeObserver = null;
let scrubbing = false;

const segments = computed(() => buildChangeMapSegments({
  rows: props.rows,
  indices: props.indices,
  trackHeight: trackHeight.value,
  minHeight: MARK_MIN_HEIGHT,
}));

const activeMarkerStyle = computed(() => {
  const total = props.rows.length;
  if (props.activeIndex < 0 || !total || !(trackHeight.value > 0)) return null;
  const scale = trackHeight.value / total;
  const height = Math.max(ACTIVE_MIN_HEIGHT, scale + 4);
  const top = Math.min(trackHeight.value - height, props.activeIndex * scale + scale / 2 - height / 2);
  return { top: `${Math.max(0, top)}px`, height: `${height}px` };
});

function kindLabel(status) {
  return t(`tableHistory.changeKind.${status}`);
}

function segmentTitle(segment) {
  const kind = kindLabel(segment.status);
  const from = (segment.firstRow?.rowIndex ?? segment.firstIndex) + 1;
  if (segment.count <= 1) return t("tableHistory.changeMapRow", { row: from, kind });
  const to = (segment.lastRow?.rowIndex ?? segment.lastIndex) + 1;
  return t("tableHistory.changeMapRows", { from, to, kind, count: segment.count });
}

function paintThumb() {
  const thumb = thumbRef.value;
  const height = trackHeight.value;
  if (!thumb || !(height > 0)) return;
  const size = Math.min(height, Math.max(10, viewport.size * height));
  const top = Math.min(height - size, Math.max(0, viewport.start * height));
  thumb.style.top = `${Math.round(top)}px`;
  thumb.style.height = `${Math.round(size)}px`;
}

/** Ratios of the scrolled content: where the viewport starts and how much of it shows. */
function setViewport(start, size, bottomInset = 0) {
  viewport = {
    start: Number.isFinite(start) ? Math.max(0, start) : 0,
    size: Number.isFinite(size) ? Math.max(0, size) : 0,
  };
  rootRef.value?.style.setProperty("--wb-thv-map-inset", `${Math.max(0, Math.round(bottomInset))}px`);
  paintThumb();
}

function pointerRatio(event) {
  const rect = trackRef.value?.getBoundingClientRect();
  if (!rect || rect.height <= 0) return null;
  const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
  return { y, ratio: y / rect.height };
}

function nearestSegment(y) {
  let best = null;
  let bestDistance = HIT_SLOP + 1;
  for (const segment of segments.value) {
    const distance = y < segment.top
      ? segment.top - y
      : Math.max(0, y - (segment.top + segment.height));
    if (distance < bestDistance) {
      best = segment;
      bestDistance = distance;
    }
  }
  return best;
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const hit = pointerRatio(event);
  if (!hit) return;
  event.preventDefault();
  const segment = nearestSegment(hit.y);
  if (segment) {
    emit("jump", segment.firstIndex);
    return;
  }
  scrubbing = true;
  trackRef.value?.setPointerCapture?.(event.pointerId);
  emit("seek", hit.ratio);
}

function onPointerMove(event) {
  if (!scrubbing) return;
  const hit = pointerRatio(event);
  if (hit) emit("seek", hit.ratio);
}

function endScrub(event) {
  if (!scrubbing) return;
  scrubbing = false;
  trackRef.value?.releasePointerCapture?.(event.pointerId);
}

onMounted(() => {
  const track = trackRef.value;
  if (!track) return;
  trackHeight.value = track.clientHeight;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver((entries) => {
      const height = Math.round(entries[0]?.contentRect?.height || 0);
      if (height !== trackHeight.value) {
        trackHeight.value = height;
        paintThumb();
      }
    });
    resizeObserver.observe(track);
  }
  paintThumb();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

defineExpose({ setViewport });
</script>

<template>
  <div ref="rootRef" class="wb-thv-map" :title="t('tableHistory.changeMapTitle')">
    <div class="wb-thv-map-cap is-pane" aria-hidden="true"></div>
    <div class="wb-thv-map-cap is-grid" aria-hidden="true"></div>
    <div
      ref="trackRef"
      class="wb-thv-map-track"
      aria-hidden="true"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endScrub"
      @pointercancel="endScrub"
    >
      <span ref="thumbRef" class="wb-thv-map-thumb"></span>
      <span
        v-for="segment in segments"
        :key="`${segment.status}-${segment.firstIndex}`"
        class="wb-thv-map-mark"
        :data-status="segment.status"
        :style="{ top: `${segment.top}px`, height: `${segment.height}px` }"
        :title="segmentTitle(segment)"
      ></span>
      <span v-if="activeMarkerStyle" class="wb-thv-map-active" :style="activeMarkerStyle"></span>
    </div>
  </div>
</template>
