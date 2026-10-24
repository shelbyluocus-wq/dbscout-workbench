<script setup>
// The end of the guide: what this release did, phase by phase, with a
// timeline and a plain-text record to paste into a chat or a ticket.
import { computed, onBeforeUnmount, ref } from "vue";
import { Check, CircleCheck, Copy, PartyPopper } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_PAGE_BY_ID, RELEASE_PHASES, RELEASE_TASKS, RELEASE_TASK_BY_ID, TASK_STATUS, taskApplies } from "../releaseFlowState.js";
import {
  formatClockTime,
  formatReleaseBytes,
  formatReleaseCount,
  formatReleaseDate,
  formatReleaseDuration,
  gmResultText,
  phaseTitle,
  taskTitle,
} from "../utils/releaseFlowFormat.js";
import ReleaseStatusIcon from "./ReleaseStatusIcon.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const complete = computed(() => props.flow.complete.value);
const platform = computed(() => props.flow.platform.value);
const copied = ref(false);
let copiedTimer = null;
onBeforeUnmount(() => clearTimeout(copiedTimer));

const applicable = computed(() => RELEASE_TASKS.filter((definition) => taskApplies(definition, state.brief)));
const remaining = computed(() => applicable.value.filter((definition) =>
  ![TASK_STATUS.DONE, TASK_STATUS.SKIPPED].includes(state.tasks[definition.id].status)));

function resultLine(taskId) {
  const task = state.tasks[taskId];
  if (task.status === TASK_STATUS.SKIPPED) return t("releaseFlow.summary.skipped");
  const result = task.result || {};
  switch (taskId) {
    case "db.sync":
      return t("releaseFlow.summary.db.sync", { tables: result.tables, rows: formatReleaseCount(result.rows) });
    case "db.plans":
      return t("releaseFlow.summary.db.plans", { open: result.open ?? 0, close: result.close ?? 0 });
    case "client.svn":
      return t("releaseFlow.summary.client.svn", { revision: result.revision, count: result.resolved || 0 });
    case "client.sync":
      return t("releaseFlow.files.done", { added: result.added, modified: result.modified, deleted: result.deleted });
    case "client.transfer":
      return t("releaseFlow.transfer.done", { count: result.copiedFiles });
    case "client.diff":
      return t("releaseFlow.diff.done", { count: result.files });
    case "build.cocos":
      return t("releaseFlow.summary.build", {
        version: platform.value.cocosVersion,
        platform: platform.value.buildPlatform,
        size: formatReleaseBytes(result.sizeBytes),
      });
    default:
      return gmResultText(taskId, result);
  }
}

const phases = computed(() => RELEASE_PHASES.map((phase) => ({
  id: phase,
  tasks: applicable.value
    .filter((definition) => RELEASE_PAGE_BY_ID.get(definition.page)?.phase === phase)
    .map((definition) => ({ id: definition.id, status: state.tasks[definition.id].status })),
})).filter((phase) => phase.tasks.length));

const history = computed(() => state.history
  .filter((entry) => entry.taskId && ["done", "attention", "failed", "skipped"].includes(entry.event))
  .slice(-40));

const totalTime = computed(() => {
  const started = state.history.find((entry) => entry.event === "started")?.at;
  const finished = Math.max(0, ...RELEASE_TASKS.map((definition) => state.tasks[definition.id].finishedAt || 0));
  return started && finished > started ? formatReleaseDuration(finished - started) : "";
});

const briefLine = computed(() => [
  platform.value.name,
  formatReleaseDate(state.brief.date),
  t(`releaseFlow.mode.${state.brief.mode}`),
].join(" · "));

function reportText() {
  const lines = [
    t("releaseFlow.summary.reportTitle"),
    briefLine.value,
    "",
  ];
  for (const phase of phases.value) {
    lines.push(`【${phaseTitle(phase.id)}】`);
    for (const task of phase.tasks) {
      const mark = task.status === TASK_STATUS.DONE ? "✓" : task.status === TASK_STATUS.SKIPPED ? "–" : "·";
      const detail = task.status === TASK_STATUS.DONE || task.status === TASK_STATUS.SKIPPED ? `：${resultLine(task.id)}` : "";
      lines.push(`${mark} ${taskTitle(task.id)}${detail}`);
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

function pageOf(taskId) {
  return RELEASE_TASK_BY_ID.get(taskId)?.page || "overview";
}
</script>

<template>
  <div>
    <header v-if="complete" class="wb-rf-summary-hero">
      <span class="wb-rf-summary-mark" aria-hidden="true"><PartyPopper :size="22" /></span>
      <div>
        <h3 tabindex="-1">{{ t('releaseFlow.summary.title') }}</h3>
        <p>{{ briefLine }}<template v-if="totalTime"> · {{ t('releaseFlow.summary.total', { time: totalTime }) }}</template></p>
      </div>
      <button type="button" class="wb-rf-summary-copy" @click="copyReport">
        <Check v-if="copied" :size="14" aria-hidden="true" />
        <Copy v-else :size="14" aria-hidden="true" />
        {{ t(copied ? 'releaseFlow.summary.copied' : 'releaseFlow.summary.copy') }}
      </button>
    </header>
    <header v-else class="wb-rf-page-head">
      <span class="wb-rf-eyebrow">{{ briefLine }}</span>
      <h3 tabindex="-1">{{ t('releaseFlow.summary.pendingTitle') }}</h3>
      <p>{{ t('releaseFlow.summary.pendingDescription', { count: remaining.length }) }}</p>
    </header>

    <div class="wb-rf-stack">
      <ul v-if="!complete" class="wb-rf-list wb-rf-remaining">
        <li v-for="definition in remaining" :key="definition.id">
          <ReleaseStatusIcon :status="state.tasks[definition.id].status === 'idle' ? 'pending' : state.tasks[definition.id].status" :size="14" />
          <span>{{ taskTitle(definition.id) }}</span>
          <button type="button" class="wb-rf-link" @click="emit('navigate', pageOf(definition.id))">{{ t('releaseFlow.summary.goTo') }}</button>
        </li>
      </ul>

      <div class="wb-rf-summary-grid">
        <section v-for="phase in phases" :key="phase.id" class="wb-rf-section wb-rf-summary-phase" :aria-labelledby="`wb-rf-summary-${phase.id}`">
          <div class="wb-rf-section-head">
            <h4 :id="`wb-rf-summary-${phase.id}`">{{ phaseTitle(phase.id) }}</h4>
          </div>
          <ul class="wb-rf-list">
            <li v-for="task in phase.tasks" :key="task.id" class="wb-rf-summary-task">
              <ReleaseStatusIcon :status="task.status === 'idle' ? 'pending' : task.status" :size="14" />
              <div>
                <strong>{{ taskTitle(task.id) }}</strong>
                <span v-if="task.status === 'done' || task.status === 'skipped'">{{ resultLine(task.id) }}</span>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <section v-if="history.length" class="wb-rf-section" aria-labelledby="wb-rf-summary-history">
        <div class="wb-rf-section-head">
          <h4 id="wb-rf-summary-history">{{ t('releaseFlow.summary.history') }}</h4>
        </div>
        <ol class="wb-rf-list wb-rf-history">
          <li v-for="(entry, index) in history" :key="index" :class="`is-${entry.event}`">
            <time :datetime="new Date(entry.at).toISOString()">{{ formatClockTime(entry.at) }}</time>
            <CircleCheck v-if="entry.event === 'done'" :size="13" aria-hidden="true" />
            <ReleaseStatusIcon v-else :status="entry.event" :size="13" />
            <span>{{ taskTitle(entry.taskId) }}</span>
            <span class="wb-rf-muted">{{ t(`releaseFlow.summary.event.${entry.event}`) }}</span>
          </li>
        </ol>
      </section>

      <p class="wb-rf-hint">{{ t('releaseFlow.summary.demoNote') }}</p>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-summary-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
  padding: 18px 20px;
  border: 1px solid var(--wb-success-border);
  border-radius: 12px;
  background: var(--wb-success-surface);
}

.wb-rf-summary-hero h3 {
  margin: 0;
  font-size: 19px;
  font-weight: 650;
  outline: none;
}

.wb-rf-summary-hero p {
  margin: 4px 0 0;
  color: var(--wb-secondary-text);
  font-size: 13px;
}

.wb-rf-summary-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--wb-table-surface);
  color: var(--wb-success-text);
}

.wb-rf-summary-copy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  min-height: 32px;
}

.wb-rf-remaining {
  display: grid;
  gap: 4px;
}

.wb-rf-remaining li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  background: var(--wb-field-surface);
  font-size: 12.5px;
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

.wb-rf-summary-phase ul {
  display: grid;
  gap: 10px;
}

.wb-rf-summary-task {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.wb-rf-summary-task > .wb-rf-status {
  margin-top: 1px;
}

.wb-rf-summary-task div {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.wb-rf-summary-task strong {
  font-size: 12.5px;
  font-weight: 600;
}

.wb-rf-summary-task div > span {
  color: var(--wb-secondary-text);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.wb-rf-history {
  display: grid;
  gap: 2px;
  max-height: 260px;
  overflow-y: auto;
}

.wb-rf-history li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  font-size: 12.5px;
}

.wb-rf-history time {
  width: 64px;
  color: var(--wb-quiet-text);
  font-variant-numeric: tabular-nums;
}

.wb-rf-history .is-done svg {
  color: var(--wb-success-text);
}
</style>
