<script setup>
// Tool output of one release task, kept scrolled to the newest line while it
// runs unless the reader has scrolled up.
import { nextTick, ref, watch } from "vue";
import { t } from "../i18n/index.js";

const props = defineProps({
  lines: { type: Array, default: () => [] },
  label: { type: String, default: "" },
});

const logRef = ref(null);

watch(
  () => props.lines.length,
  async () => {
    const element = logRef.value;
    if (!element) return;
    const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    await nextTick();
    if (pinned) element.scrollTop = element.scrollHeight;
  },
);
</script>

<template>
  <pre
    v-if="lines.length"
    ref="logRef"
    class="wb-rf-log"
    tabindex="0"
    :aria-label="label || t('releaseFlow.log.label')"
  ><span
    v-for="(line, index) in lines"
    :key="index"
    class="wb-rf-log-line"
    :class="line.tone ? `is-${line.tone}` : ''"
  >{{ line.text }}
</span></pre>
</template>
