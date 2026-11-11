<script setup>
// Platform settings, a workspace page: where each platform's update goes, plus
// adding new release channels and deleting unused ones. Changing a platform
// resets the steps of its open update that used the changed value.
import { computed, nextTick, ref, watch } from "vue";
import { FolderOpen, Plus, Trash2 } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useConfirm } from "../composables/useConfirm.js";
import { pickPlatformPathValue } from "../utils/releasePlatformFields.js";
import ReleasePlatformEditor from "./ReleasePlatformEditor.vue";
import ReleaseSectionHead from "./ReleaseSectionHead.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const { confirm } = useConfirm();
const platforms = computed(() => props.workspace.state.platforms);
const returnRun = computed(() => {
  const target = props.workspace.view.returnTo;
  return target?.section === "run" ? props.workspace.flowFor(target.runId) : null;
});
const returnPlatformId = computed(() => {
  const target = props.workspace.view.returnTo;
  if (target?.section === "platform") return target.platformId;
  return returnRun.value?.platform.value.id || "";
});
const selectedId = ref(returnPlatformId.value || platforms.value[0]?.id || "");
const selected = computed(() => platforms.value.find((entry) => entry.id === selectedId.value) || platforms.value[0] || null);
// A platform with an update on its card says how far it is.
const states = computed(() => Object.fromEntries(props.workspace.cards.value
  .filter((card) => card.runId && card.status !== "done")
  .map((card) => [card.platformId, card.status])));

const adding = ref(false);
const nameInputRef = ref(null);
const newName = ref("");
const copyFromId = ref("");
const newTargetDb = ref("");
const newTargetClient = ref("");

function openAddForm() {
  adding.value = true;
  newName.value = "";
  copyFromId.value = selected.value?.id || platforms.value[0]?.id || "";
  newTargetDb.value = "";
  newTargetClient.value = "";
  void nextTick(() => nameInputRef.value?.focus());
}

function cancelAddForm() {
  adding.value = false;
  newName.value = "";
  newTargetDb.value = "";
  newTargetClient.value = "";
}

async function browseNewTargetClient() {
  const picked = await pickPlatformPathValue("folder");
  if (picked) newTargetClient.value = picked;
}

function submitAddPlatform() {
  const trimmed = newName.value.trim();
  if (!trimmed) return;
  const created = props.workspace.addPlatform({
    name: trimmed,
    copyFromId: copyFromId.value,
    targetDatabase: newTargetDb.value,
    targetClient: newTargetClient.value,
  });
  if (!created) return;
  selectedId.value = created.id;
  cancelAddForm();
}

async function removeSelected() {
  const target = selected.value;
  if (!target || platforms.value.length <= 1) return;
  const run = props.workspace.runOf(target.id);
  const hasOpenRun = Boolean(run && !run.outcome);
  const accepted = await confirm({
    title: t("releaseFlow.platformEditor.deleteTitle", { name: target.name }),
    message: t(hasOpenRun ? "releaseFlow.platformEditor.deleteOpenRunMessage" : "releaseFlow.platformEditor.deleteMessage", {
      name: target.name,
    }),
    confirmText: t("releaseFlow.platformEditor.deleteAction"),
    cancelText: t("releaseFlow.cancel"),
    danger: true,
  });
  if (!accepted) return;
  const currentIndex = platforms.value.findIndex((entry) => entry.id === target.id);
  if (!props.workspace.removePlatform(target.id)) return;
  const next = platforms.value[Math.min(Math.max(0, currentIndex), platforms.value.length - 1)];
  selectedId.value = next?.id || "";
}

watch(
  () => props.workspace.ui.addingPlatform,
  (requested) => {
    if (!requested) return;
    props.workspace.ui.addingPlatform = false;
    openAddForm();
  },
  { immediate: true },
);

watch(platforms, (list) => {
  if (!list.some((entry) => entry.id === selectedId.value)) {
    selectedId.value = list[0]?.id || "";
  }
});
</script>

<template>
  <ReleaseSectionHead :workspace="workspace" :title="t('releaseFlow.page.platforms.title')" :description="t('releaseFlow.page.platforms.description')">
    <template #actions>
      <button type="button" class="wb-rf-btn is-primary" data-platform-add @click="openAddForm">
        <Plus :size="14" aria-hidden="true" />{{ t('releaseFlow.platformEditor.add') }}
      </button>
    </template>
  </ReleaseSectionHead>

  <form v-if="adding" class="wb-rf-card wb-rf-platform-add-card" data-platform-add-card @submit.prevent="submitAddPlatform" @keydown.esc.stop="cancelAddForm">
    <div class="wb-rf-platform-add-head">
      <h4>{{ t('releaseFlow.platformEditor.add') }}</h4>
      <p>{{ t('releaseFlow.platformEditor.addHint') }}</p>
    </div>
    <div class="wb-rf-platform-add-grid">
      <label class="wb-rf-field">
        {{ t('releaseFlow.platformEditor.name') }}
        <input
          ref="nameInputRef"
          v-model="newName"
          data-platform-new-name
          maxlength="40"
          :placeholder="t('releaseFlow.platformEditor.namePlaceholder')"
        />
      </label>
      <label class="wb-rf-field">
        {{ t('releaseFlow.platformEditor.copyFrom') }}
        <select v-model="copyFromId" data-platform-copy-from>
          <option v-for="platform in platforms" :key="platform.id" :value="platform.id">{{ platform.name }}</option>
          <option value="">{{ t('releaseFlow.platformEditor.copyNone') }}</option>
        </select>
      </label>
      <label class="wb-rf-field">
        {{ t('releaseFlow.platformEditor.targetDatabase') }}
        <input
          v-model="newTargetDb"
          class="wb-rf-code"
          data-platform-new-db
          spellcheck="false"
          :placeholder="t('releaseFlow.platformEditor.chooseDatabase')"
        />
      </label>
      <div class="wb-rf-field">
        <span>{{ t('releaseFlow.platformEditor.targetClient') }}</span>
        <span class="wb-rf-path-field">
          <input
            v-model="newTargetClient"
            class="wb-rf-code"
            data-platform-new-client
            spellcheck="false"
            :aria-label="t('releaseFlow.platformEditor.targetClient')"
          />
          <button type="button" class="wb-rf-btn" data-platform-new-client-browse @click="browseNewTargetClient">
            <FolderOpen :size="14" aria-hidden="true" />{{ t('releaseFlow.platformEditor.browse') }}
          </button>
        </span>
      </div>
    </div>
    <div class="wb-rf-platform-add-actions">
      <button type="button" class="wb-rf-btn is-quiet" data-platform-create-cancel @click="cancelAddForm">{{ t('releaseFlow.cancel') }}</button>
      <button type="submit" class="wb-rf-btn is-primary" data-platform-create-submit :disabled="!newName.trim()">{{ t('releaseFlow.platformEditor.createAction') }}</button>
    </div>
  </form>

  <div class="wb-rf-segmented" role="tablist" :aria-label="t('releaseFlow.platformEditor.choose')">
    <button
      v-for="platform in platforms"
      :key="platform.id"
      type="button"
      role="tab"
      :data-platform-tab="platform.id"
      :aria-selected="platform.id === selected?.id"
      @click="selectedId = platform.id"
    >
      {{ platform.name }}
      <span v-if="states[platform.id]" class="wb-rf-count">{{ t(`releaseFlow.card.status.${states[platform.id]}`) }}</span>
    </button>
  </div>

  <ReleasePlatformEditor v-if="selected" :key="selected.id" :workspace="workspace" :platform="selected">
    <template #actions="{ busy }">
      <button
        type="button"
        class="wb-rf-btn wb-rf-danger-text"
        data-platform-delete
        :disabled="platforms.length <= 1 || busy"
        :title="platforms.length <= 1 ? t('releaseFlow.platformEditor.keepOne') : ''"
        @click="removeSelected"
      >
        <Trash2 :size="14" aria-hidden="true" />{{ t('releaseFlow.platformEditor.delete') }}
      </button>
    </template>
  </ReleasePlatformEditor>
</template>

<style scoped>
.wb-rf-platform-add-card {
  gap: 16px;
}

.wb-rf-platform-add-head {
  display: grid;
  gap: 4px;
}

.wb-rf-platform-add-head h4 {
  margin: 0;
  font-size: var(--wb-fs-title);
  font-weight: 650;
}

.wb-rf-platform-add-head p {
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-body);
}

.wb-rf-platform-add-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}

.wb-rf-platform-add-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 720px) {
  .wb-rf-platform-add-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
