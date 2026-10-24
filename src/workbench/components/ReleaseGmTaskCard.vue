<script setup>
// One GM operation: what it does, what it will send, and what the GM
// reported. Operations that depend on another one say which.
import { computed, nextTick, ref, watch } from "vue";
import { t } from "../i18n/index.js";
import { missingDependencies } from "../releaseFlowState.js";
import { gmResultText, releaseErrorText, scrollBehavior, taskTitle } from "../utils/releaseFlowFormat.js";
import ReleaseStatusIcon from "./ReleaseStatusIcon.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  taskId: { type: String, required: true },
  detail: { type: String, default: "" },
  // The operation the page's main button runs next; only it is emphasized.
  next: { type: Boolean, default: false },
});

const emit = defineEmits(["run", "rerun"]);

const task = computed(() => props.flow.state.tasks[props.taskId]);
const blocker = computed(() => props.flow.blockerOf(props.taskId));
const running = computed(() => task.value.status === "running");
const fraction = computed(() => (props.flow.progress.taskId === props.taskId ? props.flow.progress.fraction : 0));
const status = computed(() => (task.value.status === "idle" ? "pending" : task.value.status));
const cardRef = ref(null);

// Runs started from the footer may concern a card below the fold.
watch(running, (value) => {
  if (value) void nextTick(() => cardRef.value?.scrollIntoView?.({ block: "nearest", behavior: scrollBehavior() }));
});

const blockerText = computed(() => {
  if (blocker.value !== "dependency") return "";
  const [missing] = missingDependencies(props.taskId, props.flow.state.tasks, props.flow.state.brief);
  return t("releaseFlow.blocker.dependency", { step: taskTitle(missing) });
});

const buttonLabel = computed(() => {
  if (task.value.status === "done") return t("releaseFlow.gm.again");
  if (task.value.status === "failed") return t("releaseFlow.footer.retry");
  return t(`releaseFlow.task.${props.taskId}.run`);
});

function act() {
  emit(task.value.status === "done" ? "rerun" : "run", props.taskId);
}
</script>

<template>
  <li ref="cardRef" class="wb-rf-gm-task" :class="`is-${status}`" :data-release-task="taskId">
    <ReleaseStatusIcon :status="status" :size="16" />
    <div class="wb-rf-gm-body">
      <strong>{{ taskTitle(taskId) }}</strong>
      <p class="wb-rf-hint">{{ t(`releaseFlow.task.${taskId}.hint`) }}</p>
      <span v-if="detail && task.status !== 'done'" class="wb-rf-chip wb-rf-code">{{ detail }}</span>
      <div v-if="running" class="wb-rf-progress" role="progressbar" :aria-valuenow="Math.round(fraction * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="taskTitle(taskId)">
        <span :style="{ transform: `scaleX(${fraction})` }" />
      </div>
      <p v-if="task.status === 'done'" class="wb-rf-gm-result">{{ gmResultText(taskId, task.result || {}) }}</p>
      <p v-else-if="task.status === 'failed'" class="wb-rf-gm-error" role="alert">{{ releaseErrorText(task.error) }}</p>
      <p v-else-if="task.stale" class="wb-rf-gm-stale">{{ t('releaseFlow.task.stale') }}</p>
      <p v-else-if="blockerText" class="wb-rf-muted wb-rf-gm-blocked">{{ blockerText }}</p>
    </div>
    <button
      type="button"
      class="wb-rf-gm-action"
      :class="{ 'wb-dialog-primary': next && !blocker && task.status !== 'done' }"
      :disabled="Boolean(blocker)"
      @click="act"
    >
      {{ running ? t('releaseFlow.footer.runningButton') : buttonLabel }}
    </button>
  </li>
</template>

<style scoped>
.wb-rf-gm-task {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  padding: 13px 14px;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-table-surface);
}

.wb-rf-gm-task > .wb-rf-status {
  margin-top: 1px;
}

.wb-rf-gm-task.is-running {
  border-color: color-mix(in srgb, var(--wb-accent) 50%, transparent);
}

.wb-rf-gm-task.is-failed {
  border-color: var(--wb-danger-border);
}

.wb-rf-gm-body {
  display: grid;
  justify-items: start;
  gap: 5px;
  min-width: 0;
}

.wb-rf-gm-body > strong {
  font-size: 13px;
  font-weight: 600;
}

.wb-rf-gm-body .wb-rf-progress {
  justify-self: stretch;
  margin-top: 4px;
}

.wb-rf-gm-result,
.wb-rf-gm-error,
.wb-rf-gm-stale,
.wb-rf-gm-blocked {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
}

.wb-rf-gm-result {
  color: var(--wb-success-text);
}

.wb-rf-gm-error {
  color: var(--wb-danger);
}

.wb-rf-gm-stale {
  color: var(--wb-warning-text);
}

.wb-rf-gm-action {
  min-width: 112px;
  min-height: 30px;
  white-space: nowrap;
}
</style>
