<script setup>
// Start a new update: pick the platform. A platform keeps one open update at
// a time, so for one that still has an open update the choice is to continue
// it or to abandon it (kept in the history) and start over; a new update
// never mixes with an old one.
import { computed, nextTick, onMounted, ref } from "vue";
import { Check, Plus } from "lucide-vue-next";
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
const newPlatformInputRef = ref(null);
const addingPlatform = ref(false);
const newPlatformName = ref("");
const { confirm } = useConfirm();
useEscClose(() => !addingPlatform.value, () => emit("close"), null, { dialogRef });

const cards = computed(() => props.workspace.cards.value);
const choice = ref(props.platformId || cards.value.find((card) => !card.runId || card.status === "done")?.platformId || cards.value[0]?.platformId || "");
const card = computed(() => cards.value.find((entry) => entry.platformId === choice.value) || null);
const run = computed(() => (card.value?.runId ? props.workspace.runOf(card.value.platformId) : null));
const openRun = computed(() => (run.value && !run.value.outcome ? run.value : null));
const runBusy = computed(() => Boolean(openRun.value && props.workspace.flowFor(openRun.value.id)?.busy.value));

function toggleAddPlatform() {
  addingPlatform.value = !addingPlatform.value;
  newPlatformName.value = "";
  if (addingPlatform.value) {
    void nextTick(() => newPlatformInputRef.value?.focus());
  }
}

function submitInlinePlatform() {
  const trimmed = newPlatformName.value.trim();
  if (!trimmed) return;
  const created = props.workspace.addPlatform({
    name: trimmed,
    copyFromId: choice.value || cards.value[0]?.platformId || "",
  });
  if (!created) return;
  choice.value = created.id;
  addingPlatform.value = false;
  newPlatformName.value = "";
}

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
      <div class="wb-rf-new-platform-row">
        <button
          v-if="!addingPlatform"
          type="button"
          class="wb-rf-btn is-quiet"
          data-new-update-add-platform
          @click="toggleAddPlatform"
        >
          <Plus :size="14" aria-hidden="true" />{{ t('releaseFlow.platformEditor.add') }}
        </button>
        <form
          v-else
          class="wb-rf-new-platform-form"
          @submit.prevent="submitInlinePlatform"
          @keydown.esc.stop="addingPlatform = false"
        >
          <input
            ref="newPlatformInputRef"
            v-model="newPlatformName"
            data-new-update-platform-name
            maxlength="40"
            :aria-label="t('releaseFlow.platformEditor.name')"
            :placeholder="t('releaseFlow.platformEditor.namePlaceholder')"
          />
          <button type="submit" class="wb-rf-btn is-primary" data-new-update-platform-submit :disabled="!newPlatformName.trim()">
            {{ t('releaseFlow.platformEditor.createAction') }}
          </button>
          <button type="button" class="wb-rf-btn is-quiet" @click="addingPlatform = false">{{ t('releaseFlow.cancel') }}</button>
        </form>
      </div>
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

<style scoped>
.wb-rf-new-platform-row {
  display: flex;
  align-items: center;
}

.wb-rf-new-platform-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.wb-rf-new-platform-form input {
  flex: 1 1 180px;
  height: var(--wb-rf-control-h);
  min-width: 0;
  padding: 0 11px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-rf-radius-control);
  background: var(--wb-cell-editor);
  color: var(--wb-text);
  font-size: var(--wb-fs-body);
}

.wb-rf-new-platform-form input:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 2px;
}
</style>
