<script setup>
// Tool output of one release task, kept scrolled to the newest line while it
// runs unless the reader has scrolled up. Scroll updates coalesce per animation
// frame so log bursts never force synchronous layout Thrashing.
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { t } from "../i18n/index.js";

const props = defineProps({
  lines: { type: Array, default: () => [] },
  label: { type: String, default: "" },
});

const logRef = ref(null);
let pinned = true;
let frameId = 0;

function onScroll() {
  const element = logRef.value;
  if (!element) return;
  pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
}

function scheduleScroll() {
  if (!pinned || frameId) return;
  const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  frameId = schedule(() => {
    frameId = 0;
    const element = logRef.value;
    if (element && pinned) element.scrollTop = element.scrollHeight;
  });
}

watch(
  () => props.lines.length,
  async (length, previous) => {
    if (length === 0) {
      pinned = true;
      return;
    }
    if (!previous) await nextTick();
    scheduleScroll();
  },
);

onBeforeUnmount(() => {
  if (!frameId) return;
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
  else clearTimeout(frameId);
  frameId = 0;
});
</script>

<template>
  <pre
    v-if="lines.length"
    ref="logRef"
    class="wb-rf-log"
    tabindex="0"
    :aria-label="label || t('releaseFlow.log.label')"
    @scroll.passive="onScroll"
  ><span
    v-for="(line, index) in lines"
    :key="index"
    class="wb-rf-log-line"
    :class="line.tone ? `is-${line.tone}` : ''"
  >{{ line.text }}
</span></pre>
</template>
