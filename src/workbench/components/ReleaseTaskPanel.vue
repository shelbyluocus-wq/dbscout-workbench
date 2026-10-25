<script setup>
// Live state of one release task: progress while it runs, then a one-line
// outcome (pages fill it through slots). The tool output stays visible while
// it runs or after a failure, and folds away once the task is done.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronDown, CircleCheck, CircleX, RotateCcw, TriangleAlert } from "lucide-vue-next";
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
const fraction = computed(() => (props.flow.progress.taskId === props.taskId ? props.flow.progress.fraction : 0));
const progressStyle = computed(() => ({ transform: `scaleX(${fraction.value})` }));
const panelRef = ref(null);
const logOpen = ref(false);
const logVisible = computed(() => props.showLog && task.value.logs.length > 0
  && (running.value || logOpen.value || ["failed", "attention"].includes(task.value.status)));

// The run starts from the footer; bring its progress, then its outcome, into
// view when the page is taller than the window.
watch(
  () => task.value.status,
  (status, previous) => {
    if (status === "running") logOpen.value = false;
    if (status !== "running" && previous !== "running") return;
    void nextTick(() => panelRef.value?.scrollIntoView?.({ block: "nearest", behavior: scrollBehavior() }));
  },
);

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
    <p v-if="task.stale && task.status === 'idle'" class="wb-rf-task-line is-warning" role="status">
      <RotateCcw :size="14" aria-hidden="true" />
      <span>{{ t('releaseFlow.task.stale') }}</span>
    </p>
    <div v-if="running" class="wb-rf-task-running" role="status" aria-live="polite">
      <div class="wb-rf-task-line">
        <strong>{{ t('releaseFlow.task.running') }}</strong>
        <span class="wb-rf-task-percent">{{ Math.round(fraction * 100) }}%</span>
        <span class="wb-rf-muted">{{ elapsed }}</span>
      </div>
      <div class="wb-rf-progress" role="progressbar" :aria-valuenow="Math.round(fraction * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="t('releaseFlow.task.running')">
        <span :style="progressStyle" />
      </div>
    </div>
    <div v-else-if="task.status === 'done'" class="wb-rf-task-line is-success" role="status">
      <CircleCheck :size="16" aria-hidden="true" />
      <div class="wb-rf-task-outcome">
        <slot name="done" :result="task.result || {}" />
      </div>
      <span v-if="task.startedAt && task.finishedAt" class="wb-rf-task-duration">{{ duration }}</span>
      <button
        v-if="showLog && task.logs.length"
        type="button"
        class="wb-rf-btn is-quiet is-small wb-rf-log-toggle"
        :aria-expanded="logOpen"
        @click="logOpen = !logOpen"
      >
        {{ t(logOpen ? 'releaseFlow.task.hideLog' : 'releaseFlow.task.showLog') }}
        <ChevronDown :size="13" aria-hidden="true" />
      </button>
    </div>
    <div v-else-if="task.status === 'skipped'" class="wb-rf-task-line" role="status">
      <span>{{ t('releaseFlow.task.skipped') }}</span>
    </div>
    <div v-else-if="task.status === 'failed'" class="wb-rf-notice is-danger" role="alert">
      <CircleX :size="15" aria-hidden="true" />
      <div class="wb-rf-task-outcome">
        <slot name="failed" :error="task.error" :result="task.result || {}">
          <span>{{ releaseErrorText(task.error) }}</span>
        </slot>
      </div>
    </div>
    <div v-else-if="task.status === 'attention'" class="wb-rf-notice is-warning" role="status">
      <TriangleAlert :size="15" aria-hidden="true" />
      <div class="wb-rf-task-outcome">
        <slot name="attention" :result="task.result || {}" />
      </div>
    </div>
    <ReleaseTaskLog v-if="logVisible" :lines="task.logs" />
  </div>
</template>

<style scoped>
.wb-rf-task-panel {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.wb-rf-task-panel:empty {
  display: none;
}

.wb-rf-task-running {
  display: grid;
  gap: 10px;
}

.wb-rf-task-line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 13px;
}

.wb-rf-task-line.is-success {
  color: var(--wb-success-text);
}

.wb-rf-task-line.is-warning {
  color: var(--wb-warning-text);
}

.wb-rf-task-line > strong {
  color: var(--wb-text);
  font-weight: 600;
}

.wb-rf-task-percent {
  font-variant-numeric: tabular-nums;
}

.wb-rf-task-outcome {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  min-width: 0;
}

.wb-rf-task-outcome :deep(strong) {
  font-weight: 650;
}

.wb-rf-task-duration {
  flex: none;
  color: var(--wb-quiet-text);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.wb-rf-log-toggle svg {
  transition: transform var(--wb-duration-fast) ease;
}

.wb-rf-log-toggle[aria-expanded="true"] svg {
  transform: rotate(180deg);
}
</style>
