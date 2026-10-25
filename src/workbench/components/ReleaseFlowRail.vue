<script setup>
// Step rail of the release workspace: the brief, the four phases with their
// steps, the result, and beside them the tools (open plans, platforms) that
// can be opened at any time without leaving the current step.
import { computed } from "vue";
import { CalendarCheck2, ClipboardList, Flag, Server } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_PHASES } from "../releaseFlowState.js";
import { pageTitle, phaseTitle } from "../utils/releaseFlowFormat.js";
import ReleaseStatusIcon from "./ReleaseStatusIcon.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});

const emit = defineEmits(["navigate"]);

const TOOL_ICONS = Object.freeze({ plans: CalendarCheck2, platforms: Server });

const pages = computed(() => props.flow.pages.value);
const current = computed(() => props.flow.state.page);
const mode = computed(() => props.flow.state.brief.mode);
const byId = (id) => pages.value.find((entry) => entry.id === id);

const phases = computed(() => RELEASE_PHASES.map((phase, index) => {
  const entries = pages.value.filter((entry) => entry.phase === phase);
  const active = entries.filter((entry) => entry.applies);
  const settled = active.length > 0 && active.every((entry) => entry.status === "done" || entry.status === "skipped");
  return { id: phase, number: index + 1, pages: entries, applies: active.length > 0, done: settled };
}));

const progressText = computed(() => t("releaseFlow.rail.progress", props.flow.progressSummary.value));
const progressStyle = computed(() => {
  const { done, total } = props.flow.progressSummary.value;
  return { transform: `scaleX(${total ? done / total : 0})` };
});

function iconStatus(entry) {
  if (!entry.applies) return "notApplicable";
  if (["done", "skipped", "running", "failed", "attention"].includes(entry.status)) return entry.status;
  return "pending";
}

function label(entry) {
  return `${pageTitle(entry.id, mode.value)} · ${t(`releaseFlow.rail.state.${iconStatus(entry)}`)}`;
}
</script>

<template>
  <nav class="wb-rf-rail" :aria-label="t('releaseFlow.rail.label')">
    <div class="wb-rf-rail-scroll">
      <button
        type="button"
        class="wb-rf-rail-item is-top"
        data-release-page="overview"
        :aria-current="current === 'overview' ? 'step' : undefined"
        :aria-label="label(byId('overview'))"
        @click="emit('navigate', 'overview')"
      >
        <ReleaseStatusIcon v-if="byId('overview').status === 'done'" status="done" :size="15" />
        <ClipboardList v-else :size="15" class="wb-rf-status" aria-hidden="true" />
        <span class="wb-rf-rail-label">{{ pageTitle('overview') }}</span>
      </button>

      <ol class="wb-rf-list wb-rf-phases">
        <li v-for="phase in phases" :key="phase.id" class="wb-rf-phase" :class="{ 'is-inactive': !phase.applies, 'is-done': phase.done }">
          <div class="wb-rf-phase-head">
            <span class="wb-rf-phase-number" aria-hidden="true">{{ phase.number }}</span>
            <span class="wb-rf-phase-title">{{ phaseTitle(phase.id) }}</span>
          </div>
          <ul class="wb-rf-list wb-rf-phase-pages">
            <li v-for="entry in phase.pages" :key="entry.id">
              <button
                type="button"
                class="wb-rf-rail-item"
                :data-release-page="entry.id"
                :disabled="!entry.applies"
                :aria-current="current === entry.id ? 'step' : undefined"
                :aria-label="label(entry)"
                @click="emit('navigate', entry.id)"
              >
                <ReleaseStatusIcon :status="iconStatus(entry)" :size="14" />
                <span class="wb-rf-rail-label">{{ pageTitle(entry.id, mode) }}</span>
              </button>
            </li>
          </ul>
        </li>
      </ol>

      <button
        type="button"
        class="wb-rf-rail-item is-top"
        data-release-page="summary"
        :aria-current="current === 'summary' ? 'step' : undefined"
        :aria-label="label(byId('summary'))"
        @click="emit('navigate', 'summary')"
      >
        <ReleaseStatusIcon v-if="byId('summary').status === 'done'" status="done" :size="15" />
        <Flag v-else :size="14" class="wb-rf-status" aria-hidden="true" />
        <span class="wb-rf-rail-label">{{ pageTitle('summary') }}</span>
      </button>
    </div>

    <div class="wb-rf-rail-tools" role="group" :aria-label="t('releaseFlow.rail.tools')">
      <span class="wb-rf-rail-caption">{{ t('releaseFlow.rail.tools') }}</span>
      <button
        v-for="tool in flow.tools"
        :key="tool"
        type="button"
        class="wb-rf-rail-item"
        :data-release-page="tool"
        :aria-current="current === tool ? 'page' : undefined"
        @click="emit('navigate', tool)"
      >
        <component :is="TOOL_ICONS[tool]" :size="15" class="wb-rf-status" aria-hidden="true" />
        <span class="wb-rf-rail-label">{{ pageTitle(tool) }}</span>
      </button>
    </div>

    <div class="wb-rf-rail-footer">
      <span>{{ progressText }}</span>
      <div class="wb-rf-progress" aria-hidden="true"><span :style="progressStyle" /></div>
    </div>
  </nav>
</template>

<style scoped>
.wb-rf-rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--wb-line);
  background: color-mix(in srgb, var(--wb-pane-header) 45%, transparent);
}

.wb-rf-rail-scroll {
  display: grid;
  align-content: start;
  gap: 14px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 18px 12px;
  overflow-y: auto;
}

.wb-rf-phases {
  display: grid;
  gap: 14px;
}

.wb-rf-phase-head {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 24px;
  padding: 0 10px;
}

.wb-rf-phase-number {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 6px;
  background: var(--wb-accent-soft);
  color: var(--wb-secondary-text);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.wb-rf-phase.is-done .wb-rf-phase-number {
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}

.wb-rf-phase-title {
  color: var(--wb-text);
  font-size: 12px;
  font-weight: 650;
}

.wb-rf-phase.is-inactive .wb-rf-phase-title,
.wb-rf-phase.is-inactive .wb-rf-phase-number {
  color: var(--wb-quiet-text);
}

.wb-rf-phase-pages {
  display: grid;
  gap: 1px;
  margin-top: 2px;
  margin-left: 18px;
  padding-left: 9px;
  border-left: 1px solid var(--wb-line);
}

.wb-rf-rail-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 32px;
  min-height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--wb-secondary-text);
  font-size: 13px;
  font-weight: 450;
  text-align: left;
}

.wb-rf-rail-item.is-top {
  color: var(--wb-text);
  font-weight: 550;
}

.wb-rf-rail-item:hover:not(:disabled) {
  border: none;
  background: var(--wb-list-hover);
  color: var(--wb-text);
}

.wb-rf-rail-item[aria-current] {
  background: var(--wb-table-surface);
  box-shadow: 0 0 0 1px var(--wb-border), var(--wb-control-shadow);
  color: var(--wb-text);
  font-weight: 650;
}

.wb-rf-rail-item:disabled {
  color: var(--wb-quiet-text);
  opacity: 0.7;
}

.wb-rf-rail-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-rail-tools {
  display: grid;
  gap: 1px;
  padding: 10px 12px;
  border-top: 1px solid var(--wb-line);
}

.wb-rf-rail-caption {
  padding: 2px 10px 6px;
  color: var(--wb-quiet-text);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.wb-rf-rail-footer {
  display: grid;
  gap: 8px;
  padding: 14px 22px 18px;
  border-top: 1px solid var(--wb-line);
  color: var(--wb-secondary-text);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
</style>
