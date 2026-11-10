<script setup>
// One platform as a note on the board: its state, the update's progress, when
// it was last updated and when the next update is planned, and the first
// thing that needs attention. The open update's steps unfold under it.
import { computed } from "vue";
import { CircleAlert, TriangleAlert, Zap } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatDateTime, formatDayOf, issueText } from "../utils/releaseFlowFormat.js";

const props = defineProps({
  card: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  expanded: { type: Boolean, default: false },
});

const emit = defineEmits(["open"]);

const progressStyle = computed(() => {
  const { done, total } = props.card.progress;
  return { transform: `scaleX(${total ? done / total : 0})` };
});
const showProgress = computed(() => props.card.runId && props.card.status !== "pending" && props.card.status !== "idle");
const issue = computed(() => props.card.issues[0] || null);
const moreIssues = computed(() => Math.max(0, props.card.issues.length - 1));
const label = computed(() => [
  props.card.name,
  t(`releaseFlow.card.status.${props.card.status}`),
  props.card.autopilot ? t("releaseFlow.card.autopilot") : "",
  showProgress.value ? t("releaseFlow.card.progress", props.card.progress) : "",
  issue.value ? issueText(issue.value) : "",
].filter(Boolean).join(" · "));
</script>

<template>
  <article class="wb-rf-note" :class="[`is-${card.status}`, { 'is-selected': selected }]" :data-release-platform="card.platformId">
    <button type="button" class="wb-rf-note-head" :aria-current="selected ? 'true' : undefined" :aria-label="label" @click="emit('open', card.platformId)">
      <span class="wb-rf-note-title">
        <strong>{{ card.name }}</strong>
        <span class="wb-rf-note-tags">
          <span v-if="card.autopilot" class="wb-rf-note-auto" :title="t('releaseFlow.card.autopilot')">
            <Zap :size="11" aria-hidden="true" />{{ t('releaseFlow.card.autopilotShort') }}
          </span>
          <span class="wb-rf-note-state">{{ t(`releaseFlow.card.status.${card.status}`) }}</span>
        </span>
      </span>
      <span v-if="showProgress" class="wb-rf-note-progress">
        <span class="wb-rf-progress" aria-hidden="true"><span :style="progressStyle" /></span>
        <span class="wb-rf-note-count">{{ card.progress.done }}/{{ card.progress.total }}</span>
      </span>
      <span class="wb-rf-note-meta">
        <span v-if="card.plannedAt">{{ t('releaseFlow.card.planned', { time: formatDayOf(card.plannedAt) }) }}</span>
        <span v-if="card.lastUpdate">{{ t('releaseFlow.card.last', { time: formatDateTime(card.lastUpdate) }) }}</span>
        <span v-if="!card.plannedAt && !card.lastUpdate">{{ t('releaseFlow.card.never') }}</span>
      </span>
      <span v-if="issue" class="wb-rf-note-issue" :class="`is-${issue.tone}`">
        <CircleAlert v-if="issue.tone === 'danger'" :size="13" aria-hidden="true" />
        <TriangleAlert v-else :size="13" aria-hidden="true" />
        <span>{{ issueText(issue) }}</span>
        <span v-if="moreIssues" class="wb-rf-note-more">+{{ moreIssues }}</span>
      </span>
    </button>
    <div v-if="expanded" class="wb-rf-note-body">
      <slot />
    </div>
  </article>
</template>
