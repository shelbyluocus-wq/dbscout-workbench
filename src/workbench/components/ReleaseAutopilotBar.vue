<script setup>
// One-click mode of the update on screen: what it is doing now (a step, a
// retry countdown), why it paused and how to go
// on, and a short log of what it decided by itself.
import { computed, ref } from "vue";
import { CircleCheck, LoaderCircle, Pause, Play, TriangleAlert, Zap } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { autopilotReasonText, formatClockTime, releaseErrorText, taskTitle } from "../utils/releaseFlowFormat.js";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, required: true },
});

const autopilot = props.flow.autopilot;
const auto = autopilot.state;
const status = autopilot.status;
const logOpen = ref(false);
const now = computed(() => props.workspace.clock.value);

const detail = computed(() => {
  const flow = props.flow;
  if (status.value === "done") return t("releaseFlow.autopilot.detail.done", { count: flow.progressSummary.value.total });
  if (status.value === "paused") {
    const { reason, taskId } = auto.value;
    const text = autopilotReasonText(reason, taskId);
    const error = reason === "failed" && taskId ? flow.state.tasks[taskId]?.error : "";
    return error ? `${text} · ${releaseErrorText(error)}` : text;
  }
  if (flow.runningTask.value) return t("releaseFlow.autopilot.detail.running", { step: taskTitle(flow.runningTask.value) });
  const next = autopilot.next.value;
  if (auto.value.retryAt) {
    const seconds = Math.max(0, Math.ceil((auto.value.retryAt - now.value) / 1000));
    return t("releaseFlow.autopilot.detail.retry", { step: taskTitle(next.taskId || ""), seconds, attempt: auto.value.retries[next.taskId] || 1 });
  }
  return t("releaseFlow.autopilot.detail.next");
});

function logText(entry) {
  const step = entry.taskId ? taskTitle(entry.taskId) : "";
  if (entry.kind === "paused") return t("releaseFlow.autopilot.log.paused", { reason: autopilotReasonText(entry.detail, entry.taskId) });
  if (entry.kind === "resolved") {
    const [choice, count] = entry.detail.split(":");
    return t("releaseFlow.autopilot.log.resolved", { count: Number(count) || 0, choice: t(`releaseFlow.svn.choice.${choice}`) });
  }
  return t(`releaseFlow.autopilot.log.${entry.kind}`, { step, attempt: entry.detail });
}

const entries = computed(() => [...auto.value.log].reverse());
</script>

<template>
  <section class="wb-rf-auto-bar" :class="`is-${status}`" data-release-autopilot :data-status="status" aria-live="polite">
    <span class="wb-rf-auto-icon" aria-hidden="true">
      <LoaderCircle v-if="status === 'running' && flow.runningTask.value" :size="17" class="wb-rf-spin" />
      <TriangleAlert v-else-if="status === 'paused'" :size="17" />
      <CircleCheck v-else-if="status === 'done'" :size="17" />
      <Zap v-else :size="17" />
    </span>
    <div class="wb-rf-auto-text">
      <strong>{{ t(`releaseFlow.autopilot.status.${status}`) }}</strong>
      <span data-release-autopilot-detail>{{ detail }}</span>
      <span v-if="status === 'paused'" class="wb-rf-muted">{{ t('releaseFlow.autopilot.pausedHint') }}</span>
    </div>
    <div class="wb-rf-auto-tools">
      <template v-if="status === 'paused'">
        <button type="button" class="wb-rf-btn is-small is-quiet" @click="autopilot.stop()">{{ t('releaseFlow.autopilot.manual') }}</button>
        <button type="button" class="wb-rf-btn is-small is-primary" data-release-auto-resume :disabled="flow.busy.value" @click="autopilot.resume()">
          <Play :size="13" aria-hidden="true" />{{ t('releaseFlow.autopilot.resume') }}
        </button>
      </template>
      <button v-else-if="status === 'running'" type="button" class="wb-rf-btn is-small is-quiet" @click="autopilot.pause()">
        <Pause :size="13" aria-hidden="true" />{{ t('releaseFlow.autopilot.pause') }}
      </button>
      <button v-if="entries.length" type="button" class="wb-rf-link" :aria-expanded="logOpen" @click="logOpen = !logOpen">
        {{ t('releaseFlow.autopilot.logToggle', { count: entries.length }) }}
      </button>
    </div>
    <ol v-if="logOpen" class="wb-rf-list wb-rf-auto-log">
      <li v-for="(entry, index) in entries" :key="index">
        <time>{{ formatClockTime(entry.at) }}</time>
        <span>{{ logText(entry) }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.wb-rf-auto-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 14px;
  margin-bottom: 20px;
  padding: 12px 16px;
  border: 1px solid color-mix(in srgb, var(--wb-accent) 45%, var(--wb-border));
  border-radius: 12px;
  background: var(--wb-accent-soft);
  --wb-rf-auto-tone: var(--wb-accent-strong);
}

.wb-rf-auto-bar.is-paused {
  border-color: var(--wb-warning-border);
  background: var(--wb-warning-surface);
  --wb-rf-auto-tone: var(--wb-warning-text);
}

.wb-rf-auto-bar.is-done {
  border-color: var(--wb-success-border);
  background: var(--wb-success-surface);
  --wb-rf-auto-tone: var(--wb-success-text);
}

.wb-rf-auto-icon {
  display: inline-flex;
  color: var(--wb-rf-auto-tone);
}

.wb-rf-auto-text {
  display: grid;
  gap: 2px;
  min-width: 0;
  font-size: var(--wb-fs-body);
}

.wb-rf-auto-text strong {
  color: var(--wb-rf-auto-tone);
  font-size: var(--wb-fs-body);
  font-weight: 650;
}

.wb-rf-auto-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.wb-rf-auto-tools .wb-rf-btn {
  gap: 4px;
}

.wb-rf-auto-log {
  display: grid;
  grid-column: 1 / -1;
  max-height: 180px;
  overflow: auto;
  border-top: 1px solid var(--wb-line);
}

.wb-rf-auto-log li {
  display: flex;
  gap: 14px;
  padding: 5px 0;
  font-size: var(--wb-fs-body);
}

.wb-rf-auto-log time {
  flex: none;
  width: 64px;
  color: var(--wb-quiet-text);
  font-variant-numeric: tabular-nums;
}
</style>
