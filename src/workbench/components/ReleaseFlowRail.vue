<script setup>
// Step rail of the release workspace: the update brief, the four phases with
// their steps, and the result page. Steps outside this release stay listed
// but disabled, so the whole route remains visible.
import { computed } from "vue";
import { CircleCheck, ClipboardList, Flag } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_PHASES } from "../releaseFlowState.js";
import { pageTitle, phaseTitle } from "../utils/releaseFlowFormat.js";
import ReleaseStatusIcon from "./ReleaseStatusIcon.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});

const emit = defineEmits(["navigate"]);

const pages = computed(() => props.flow.pages.value);
const current = computed(() => props.flow.state.page);
const overview = computed(() => pages.value.find((entry) => entry.id === "overview"));
const summary = computed(() => pages.value.find((entry) => entry.id === "summary"));

const phases = computed(() => RELEASE_PHASES.map((phase, index) => {
  const entries = pages.value.filter((entry) => entry.phase === phase);
  const active = entries.filter((entry) => entry.applies);
  return {
    id: phase,
    number: index + 1,
    pages: entries,
    applies: active.length > 0,
    done: active.length > 0 && active.every((entry) => entry.status === "done" || entry.status === "skipped"),
  };
}));

const summaryText = computed(() => t("releaseFlow.rail.progress", props.flow.progressSummary.value));
const progressStyle = computed(() => {
  const { done, total } = props.flow.progressSummary.value;
  return { transform: `scaleX(${total ? done / total : 0})` };
});

function iconStatus(entry) {
  if (!entry.applies) return "notApplicable";
  if (["done", "skipped", "running", "failed", "attention"].includes(entry.status)) return entry.status;
  return "pending";
}

function stateLabel(entry) {
  return t(`releaseFlow.rail.state.${iconStatus(entry)}`);
}
</script>

<template>
  <nav class="wb-rf-rail" :aria-label="t('releaseFlow.rail.label')">
    <div class="wb-rf-rail-scroll">
      <ul class="wb-rf-rail-list">
        <li>
          <button
            type="button"
            class="wb-rf-rail-page"
            data-release-page="overview"
            :aria-current="current === 'overview' ? 'step' : undefined"
            :aria-label="`${pageTitle('overview')} · ${stateLabel(overview)}`"
            @click="emit('navigate', 'overview')"
          >
            <CircleCheck v-if="overview.status === 'done'" :size="15" class="wb-rf-status is-done" aria-hidden="true" />
            <ClipboardList v-else :size="15" class="wb-rf-status" aria-hidden="true" />
            <span class="wb-rf-rail-label">{{ pageTitle('overview') }}</span>
          </button>
        </li>
        <li v-for="phase in phases" :key="phase.id" class="wb-rf-phase" :class="{ 'is-inactive': !phase.applies, 'is-done': phase.done }">
          <div class="wb-rf-phase-head">
            <span class="wb-rf-phase-number" aria-hidden="true">{{ phase.number }}</span>
            <span>{{ phaseTitle(phase.id) }}</span>
            <small v-if="!phase.applies">{{ t('releaseFlow.rail.notNeeded') }}</small>
          </div>
          <ul class="wb-rf-rail-pages">
            <li v-for="entry in phase.pages" :key="entry.id">
              <button
                type="button"
                class="wb-rf-rail-page"
                :data-release-page="entry.id"
                :disabled="!entry.applies"
                :aria-current="current === entry.id ? 'step' : undefined"
                :aria-label="`${pageTitle(entry.id)} · ${stateLabel(entry)}`"
                @click="emit('navigate', entry.id)"
              >
                <ReleaseStatusIcon :status="iconStatus(entry)" :size="14" />
                <span class="wb-rf-rail-label">{{ pageTitle(entry.id) }}</span>
              </button>
            </li>
          </ul>
        </li>
        <li class="wb-rf-phase">
          <button
            type="button"
            class="wb-rf-rail-page"
            data-release-page="summary"
            :aria-current="current === 'summary' ? 'step' : undefined"
            :aria-label="`${pageTitle('summary')} · ${stateLabel(summary)}`"
            @click="emit('navigate', 'summary')"
          >
            <CircleCheck v-if="summary.status === 'done'" :size="15" class="wb-rf-status is-done" aria-hidden="true" />
            <Flag v-else :size="14" class="wb-rf-status" aria-hidden="true" />
            <span class="wb-rf-rail-label">{{ pageTitle('summary') }}</span>
          </button>
        </li>
      </ul>
    </div>
    <div class="wb-rf-rail-footer">
      <span>{{ summaryText }}</span>
      <div class="wb-rf-progress" aria-hidden="true"><span :style="progressStyle" /></div>
    </div>
  </nav>
</template>
