<script setup>
// Live state of one release task: progress while it runs, the outcome when it
// ends (pages fill the outcome through slots), and its tool output.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { CircleCheck, CircleX, RotateCcw, TriangleAlert } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import ReleaseTaskLog from "./ReleaseTaskLog.vue";
import { formatReleaseDuration, releaseErrorText, scrollBehavior } from "../utils/releaseFlowFormat.js";

const props = defineProps({
  flow: { type: Object, required: true },
  taskId: { type: String, required: true },
  showLog: { type: Boolean, default: true },
});

const task = computed(() => props.flow.state.tasks[props.taskId]);
const running = computed(() => task.value.status === "running");
const panelRef = ref(null);

// The run starts from the footer; bring its progress, then its outcome, into
// view when the page is taller than the window.
watch(
  () => task.value.status,
  (status, previous) => {
    if (status !== "running" && previous !== "running") return;
    void nextTick(() => panelRef.value?.scrollIntoView?.({ block: "nearest", behavior: scrollBehavior() }));
  },
);
const fraction = computed(() => (props.flow.progress.taskId === props.taskId ? props.flow.progress.fraction : 0));
const progressStyle = computed(() => ({ transform: `scaleX(${fraction.value})` }));

const clock = ref(Date.now());
let timer = null;
watch(
  running,
  (value) => {
    clearInterval(timer);
    timer = null;
    if (value) {
      clock.value = Date.now();
      timer = setInterval(() => (clock.value = Date.now()), 1000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(timer));

const elapsed = computed(() => formatReleaseDuration(clock.value - task.value.startedAt));
const duration = computed(() => formatReleaseDuration(task.value.finishedAt - task.value.startedAt));
</script>

<template>
  <div ref="panelRef" class="wb-rf-task-panel">
    <p v-if="task.stale && task.status === 'idle'" class="wb-rf-notice is-warning" role="status">
      <RotateCcw :size="14" />
      <span>{{ t('releaseFlow.task.stale') }}</span>
    </p>
    <div v-if="running" class="wb-rf-task-running" role="status" aria-live="polite">
      <div class="wb-rf-task-running-line">
        <strong>{{ t('releaseFlow.task.running') }}</strong>
        <span>{{ Math.round(fraction * 100) }}%</span>
        <span class="wb-rf-muted">{{ t('releaseFlow.task.elapsed', { time: elapsed }) }}</span>
      </div>
      <div class="wb-rf-progress" role="progressbar" :aria-valuenow="Math.round(fraction * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="t('releaseFlow.task.running')">
        <span :style="progressStyle" />
      </div>
    </div>
    <div v-else-if="task.status === 'done'" class="wb-rf-notice is-success" role="status">
      <CircleCheck :size="15" />
      <div class="wb-rf-task-outcome">
        <slot name="done" :result="task.result || {}" />
        <span v-if="task.startedAt && task.finishedAt" class="wb-rf-task-duration">{{ t('releaseFlow.task.duration', { time: duration }) }}</span>
      </div>
    </div>
    <div v-else-if="task.status === 'skipped'" class="wb-rf-notice" role="status">
      <span>{{ t('releaseFlow.task.skipped') }}</span>
    </div>
    <div v-else-if="task.status === 'failed'" class="wb-rf-notice is-danger" role="alert">
      <CircleX :size="15" />
      <div class="wb-rf-task-outcome">
        <slot name="failed" :error="task.error" :result="task.result || {}">
          <span>{{ releaseErrorText(task.error, t) }}</span>
        </slot>
      </div>
    </div>
    <div v-else-if="task.status === 'attention'" class="wb-rf-notice is-warning" role="status">
      <TriangleAlert :size="15" />
      <div class="wb-rf-task-outcome">
        <slot name="attention" :result="task.result || {}" />
      </div>
    </div>
    <ReleaseTaskLog v-if="showLog" :lines="task.logs" />
  </div>
</template>

<style scoped>
.wb-rf-task-panel {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.wb-rf-task-running {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--wb-accent) 30%, var(--wb-border));
  border-radius: 8px;
  background: var(--wb-accent-soft);
}

.wb-rf-task-running-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.wb-rf-task-outcome {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  min-width: 0;
}

.wb-rf-task-duration {
  color: var(--wb-secondary-text);
  font-size: 12px;
}
</style>
