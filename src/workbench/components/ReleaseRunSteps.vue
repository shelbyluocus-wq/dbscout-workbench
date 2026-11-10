<script setup>
// The steps of one update, under its platform card: the brief, the three
// phases with their pages and the result. Each step shows its state.
import { computed } from "vue";
import { ClipboardList, Flag } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_PHASES } from "../releaseFlowState.js";
import { pageTitle, phaseTitle } from "../utils/releaseFlowFormat.js";
import ReleaseStatusIcon from "./ReleaseStatusIcon.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  current: { type: Boolean, default: false },
});

const emit = defineEmits(["navigate"]);

const pages = computed(() => props.flow.pages.value);
const page = computed(() => props.flow.state.page);
const byId = (id) => pages.value.find((entry) => entry.id === id);

const phases = computed(() => RELEASE_PHASES.map((phase, index) => {
  const entries = pages.value.filter((entry) => entry.phase === phase);
  const active = entries.filter((entry) => entry.applies);
  const settled = active.length > 0 && active.every((entry) => entry.status === "done" || entry.status === "skipped");
  return { id: phase, number: index + 1, pages: entries, applies: active.length > 0, done: settled };
}));

function iconStatus(entry) {
  if (!entry.applies) return "notApplicable";
  if (["done", "skipped", "running", "failed", "attention"].includes(entry.status)) return entry.status;
  return "pending";
}

function label(entry) {
  return `${pageTitle(entry.id)} · ${t(`releaseFlow.rail.state.${iconStatus(entry)}`)}`;
}

function ariaCurrent(id) {
  return props.current && page.value === id ? "step" : undefined;
}
</script>

<template>
  <nav class="wb-rf-steps" :aria-label="t('releaseFlow.rail.label', { platform: flow.platform.value.name })">
    <button
      type="button"
      class="wb-rf-rail-item is-top"
      data-release-page="brief"
      :aria-current="ariaCurrent('brief')"
      :aria-label="label(byId('brief'))"
      @click="emit('navigate', 'brief')"
    >
      <ReleaseStatusIcon v-if="byId('brief').status === 'done'" status="done" :size="15" />
      <ClipboardList v-else :size="15" class="wb-rf-status" aria-hidden="true" />
      <span class="wb-rf-rail-label">{{ pageTitle('brief') }}</span>
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
              :aria-current="ariaCurrent(entry.id)"
              :aria-label="label(entry)"
              @click="emit('navigate', entry.id)"
            >
              <ReleaseStatusIcon :status="iconStatus(entry)" :size="14" />
              <span class="wb-rf-rail-label">{{ pageTitle(entry.id) }}</span>
            </button>
          </li>
        </ul>
      </li>
    </ol>

    <button
      type="button"
      class="wb-rf-rail-item is-top"
      data-release-page="summary"
      :aria-current="ariaCurrent('summary')"
      :aria-label="label(byId('summary'))"
      @click="emit('navigate', 'summary')"
    >
      <ReleaseStatusIcon v-if="byId('summary').status === 'done'" status="done" :size="15" />
      <Flag v-else :size="14" class="wb-rf-status" aria-hidden="true" />
      <span class="wb-rf-rail-label">{{ pageTitle('summary') }}</span>
    </button>
  </nav>
</template>

<style scoped>
.wb-rf-steps {
  display: grid;
  gap: 10px;
}

.wb-rf-phases {
  display: grid;
  gap: 10px;
}

.wb-rf-phase-head {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 22px;
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
  font-size: var(--wb-fs-caption);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.wb-rf-phase.is-done .wb-rf-phase-number {
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}

.wb-rf-phase-title {
  color: var(--wb-text);
  font-size: var(--wb-fs-body);
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
</style>
