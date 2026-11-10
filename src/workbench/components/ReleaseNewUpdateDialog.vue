<script setup>
// Start a new update: pick the platform. A platform keeps one open update at
// a time, so for one that still has an open update the choice is to continue
// it or to abandon it (kept in the history) and start over; a new update
// never mixes with an old one.
import { computed, nextTick, onMounted, ref } from "vue";
import { Check } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useConfirm } from "../composables/useConfirm.js";
import { useEscClose } from "../composables/useEscClose.js";
import { formatDateTime, formatDayOf } from "../utils/releaseFlowFormat.js";

const props = defineProps({
  workspace: { type: Object, required: true },
  platformId: { type: String, default: "" },
});

const emit = defineEmits(["close"]);
const dialogRef = ref(null);
const { confirm } = useConfirm();
useEscClose(() => true, () => emit("close"), null, { dialogRef });

const cards = computed(() => props.workspace.cards.value);
const choice = ref(props.platformId || cards.value.find((card) => !card.runId || card.status === "done")?.platformId || cards.value[0]?.platformId || "");
const card = computed(() => cards.value.find((entry) => entry.platformId === choice.value) || null);
const run = computed(() => (card.value?.runId ? props.workspace.runOf(card.value.platformId) : null));
const openRun = computed(() => (run.value && !run.value.outcome ? run.value : null));
const runBusy = computed(() => Boolean(openRun.value && props.workspace.flowFor(openRun.value.id)?.busy.value));

function stateText(entry) {
  const current = entry.runId ? props.workspace.runOf(entry.platformId) : null;
  if (current && !current.outcome) {
    return current.brief.started
      ? t("releaseFlow.newUpdate.open", entry.progress)
      : t("releaseFlow.newUpdate.scheduled", { time: formatDayOf(entry.plannedAt) || current.brief.date });
  }
  return entry.lastUpdate ? t("releaseFlow.card.last", { time: formatDateTime(entry.lastUpdate) }) : t("releaseFlow.card.never");
}

function create() {
  const result = props.workspace.createUpdate(choice.value);
  if (result.status === "created") emit("close");
}

function continueRun() {
  props.workspace.openRun(openRun.value.id);
  emit("close");
}

async function abandonAndCreate() {
  const target = openRun.value;
  if (!target) return;
  const progress = props.workspace.flowFor(target.id)?.progressSummary.value || { done: 0, total: 0 };
  const accepted = await confirm({
    title: t("releaseFlow.newUpdate.abandonTitle", { platform: card.value.name }),
    message: t(target.brief.started ? "releaseFlow.newUpdate.abandonMessage" : "releaseFlow.newUpdate.abandonDraft", progress),
    confirmText: t("releaseFlow.newUpdate.abandonAction"),
    cancelText: t("releaseFlow.cancel"),
    danger: true,
  });
  if (!accepted || !props.workspace.abandonUpdate(target.id)) return;
  create();
}

onMounted(() => void nextTick(() => dialogRef.value?.querySelector('[aria-checked="true"]')?.focus()));
</script>

<template>
  <div class="wb-rf-modal-backdrop">
    <section ref="dialogRef" class="wb-rf-modal" role="dialog" aria-modal="true" aria-labelledby="wb-rf-new-title" tabindex="-1">
      <header class="wb-rf-modal-head">
        <h3 id="wb-rf-new-title">{{ t('releaseFlow.newUpdate.title') }}</h3>
        <p>{{ t('releaseFlow.newUpdate.description') }}</p>
      </header>
      <div class="wb-rf-choice-list" role="radiogroup" :aria-label="t('releaseFlow.newUpdate.platform')">
        <button
          v-for="entry in cards"
          :key="entry.platformId"
          type="button"
          role="radio"
          class="wb-rf-choice"
          :data-release-choice="entry.platformId"
          :aria-checked="entry.platformId === choice"
          @click="choice = entry.platformId"
        >
          <span class="wb-rf-choice-name">
            <strong>{{ entry.name }}</strong>
            <Check v-if="entry.platformId === choice" :size="15" aria-hidden="true" />
          </span>
          <span class="wb-rf-choice-state" :class="{ 'is-open': entry.runId && entry.status !== 'done' }">{{ stateText(entry) }}</span>
        </button>
      </div>
      <p v-if="openRun" class="wb-rf-notice is-warning" role="status">
        {{ t(openRun.brief.started ? 'releaseFlow.newUpdate.hasOpen' : 'releaseFlow.newUpdate.hasDraft', { platform: card.name }) }}
      </p>
      <footer class="wb-rf-modal-foot">
        <button type="button" class="wb-rf-btn is-quiet" @click="emit('close')">{{ t('releaseFlow.cancel') }}</button>
        <template v-if="openRun">
          <button type="button" class="wb-rf-btn wb-rf-danger-text" :disabled="runBusy" @click="abandonAndCreate">{{ t('releaseFlow.newUpdate.abandon') }}</button>
          <button type="button" class="wb-rf-btn is-primary" data-release-continue @click="continueRun">{{ t('releaseFlow.newUpdate.continue') }}</button>
        </template>
        <button v-else type="button" class="wb-rf-btn is-primary" data-release-create :disabled="!choice" @click="create">{{ t('releaseFlow.newUpdate.create') }}</button>
      </footer>
    </section>
  </div>
</template>
