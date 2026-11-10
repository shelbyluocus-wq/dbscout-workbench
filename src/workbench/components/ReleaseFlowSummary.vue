<script setup>
// The end of the guide: what this release did, phase by phase, and a
// plain-text record to paste into a chat or a ticket.
import { computed, onBeforeUnmount, ref } from "vue";
import { Check, Copy, PartyPopper } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_PAGE_BY_ID, RELEASE_PHASES, RELEASE_TASKS, RELEASE_TASK_BY_ID, TASK_STATUS, applicableTasks } from "../releaseFlowState.js";
import {
  formatReleaseDate,
  formatReleaseDuration,
  phaseTitle,
  stepResultText,
  taskTitle,
} from "../utils/releaseFlowFormat.js";
import ReleaseStatusIcon from "./ReleaseStatusIcon.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const complete = computed(() => props.flow.complete.value);
const platform = computed(() => props.flow.platform.value);
const copied = ref(false);
let copiedTimer = null;
onBeforeUnmount(() => clearTimeout(copiedTimer));

const applicable = computed(() => applicableTasks(state.brief));
const remaining = computed(() => applicable.value.filter((definition) =>
  ![TASK_STATUS.DONE, TASK_STATUS.SKIPPED].includes(state.tasks[definition.id].status)));

function resultLine(taskId) {
  return stepResultText(taskId, state.tasks[taskId], { cocosVersion: platform.value.cocosVersion });
}

const phases = computed(() => RELEASE_PHASES.map((phase) => ({
  id: phase,
  tasks: applicable.value
    .filter((definition) => RELEASE_PAGE_BY_ID.get(definition.page)?.phase === phase)
    .map((definition) => ({ id: definition.id, status: state.tasks[definition.id].status })),
})).filter((phase) => phase.tasks.length));

const totalTime = computed(() => {
  const started = state.events.find((entry) => entry.event === "started")?.at;
  const finished = Math.max(0, ...RELEASE_TASKS.map((definition) => state.tasks[definition.id].finishedAt || 0));
  return started && finished > started ? formatReleaseDuration(finished - started) : "";
});

const briefLine = computed(() => [
  platform.value.name,
  formatReleaseDate(state.brief.date),
].join(" · "));

function reportText() {
  const lines = [t("releaseFlow.summary.reportTitle"), briefLine.value, ""];
  for (const phase of phases.value) {
    lines.push(`【${phaseTitle(phase.id)}】`);
    for (const task of phase.tasks) {
      const settled = task.status === TASK_STATUS.DONE || task.status === TASK_STATUS.SKIPPED;
      const mark = task.status === TASK_STATUS.DONE ? "✓" : task.status === TASK_STATUS.SKIPPED ? "–" : "·";
      lines.push(`${mark} ${taskTitle(task.id)}${settled ? `：${resultLine(task.id)}` : ""}`);
    }
    lines.push("");
  }
  lines.push(t("releaseFlow.summary.reportFooter"));
  return lines.join("\n");
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(reportText());
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <header v-if="complete" class="wb-rf-summary-hero">
    <span class="wb-rf-summary-mark" aria-hidden="true"><PartyPopper :size="22" /></span>
    <div>
      <h3 tabindex="-1">{{ t('releaseFlow.summary.title') }}</h3>
      <p>{{ briefLine }}<template v-if="totalTime"> · {{ t('releaseFlow.summary.total', { time: totalTime }) }}</template></p>
    </div>
    <button type="button" class="wb-rf-btn" @click="copyReport">
      <Check v-if="copied" :size="14" aria-hidden="true" />
      <Copy v-else :size="14" aria-hidden="true" />
      {{ t(copied ? 'releaseFlow.summary.copied' : 'releaseFlow.summary.copy') }}
    </button>
  </header>
  <header v-else class="wb-rf-page-head">
    <h3 tabindex="-1">{{ t('releaseFlow.summary.pendingTitle') }}</h3>
    <p>{{ t('releaseFlow.summary.pendingDescription', { count: remaining.length }) }}</p>
  </header>

  <ul v-if="!complete" class="wb-rf-list wb-rf-remaining">
    <li v-for="definition in remaining" :key="definition.id">
      <ReleaseStatusIcon :status="state.tasks[definition.id].status === 'idle' ? 'pending' : state.tasks[definition.id].status" :size="14" />
      <span>{{ taskTitle(definition.id) }}</span>
      <button type="button" class="wb-rf-link" @click="emit('navigate', RELEASE_TASK_BY_ID.get(definition.id).page)">{{ t('releaseFlow.summary.goTo') }}</button>
    </li>
  </ul>

  <div class="wb-rf-summary-grid">
    <section v-for="phase in phases" :key="phase.id" class="wb-rf-card" :aria-labelledby="`wb-rf-summary-${phase.id}`">
      <h4 :id="`wb-rf-summary-${phase.id}`" class="wb-rf-summary-phase">{{ phaseTitle(phase.id) }}</h4>
      <ul class="wb-rf-list wb-rf-summary-tasks">
        <li v-for="task in phase.tasks" :key="task.id">
          <ReleaseStatusIcon :status="task.status === 'idle' ? 'pending' : task.status" :size="15" />
          <div>
            <strong>{{ taskTitle(task.id) }}</strong>
            <span v-if="task.status === 'done' || task.status === 'skipped'">{{ resultLine(task.id) }}</span>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.wb-rf-summary-hero {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 22px 24px;
  border: 1px solid var(--wb-success-border);
  border-radius: 14px;
  background: var(--wb-success-surface);
}

.wb-rf-summary-hero h3 {
  margin: 0;
  font-size: var(--wb-fs-display);
  font-weight: 650;
  outline: none;
}

.wb-rf-summary-hero p {
  margin: 4px 0 0;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-body);
}

.wb-rf-summary-hero .wb-rf-btn {
  margin-left: auto;
}

.wb-rf-summary-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: var(--wb-table-surface);
  color: var(--wb-success-text);
}

.wb-rf-remaining {
  display: grid;
  gap: 6px;
}

.wb-rf-remaining li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 0 14px;
  border-radius: 10px;
  background: var(--wb-rf-sunken);
  font-size: var(--wb-fs-body);
}

.wb-rf-remaining .wb-rf-link {
  margin-left: auto;
}

.wb-rf-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

.wb-rf-summary-phase {
  margin: 0;
  font-size: var(--wb-fs-body);
  font-weight: 650;
}

.wb-rf-summary-tasks {
  display: grid;
  gap: 12px;
}

.wb-rf-summary-tasks li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.wb-rf-summary-tasks li > .wb-rf-status {
  margin-top: 1px;
}

.wb-rf-summary-tasks div {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.wb-rf-summary-tasks strong {
  font-size: var(--wb-fs-body);
  font-weight: 600;
}

.wb-rf-summary-tasks div > span {
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-body);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
</style>
