<script setup>
// A platform with no update on its card: when it was last updated, its
// records, and the way to start its next update.
import { computed, inject } from "vue";
import { Plus } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { cocosPlatformChoices } from "../utils/cocosBuildCommand.js";
import { formatDateTime } from "../utils/releaseFlowFormat.js";
import ReleaseHistoryList from "./ReleaseHistoryList.vue";
import ReleaseSectionHead from "./ReleaseSectionHead.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const openNewUpdate = inject("releaseNewUpdate", () => {});
const platformId = computed(() => props.workspace.view.platformId);
const platform = computed(() => props.workspace.platformById(platformId.value));
const card = computed(() => props.workspace.cards.value.find((entry) => entry.platformId === platformId.value));
const entries = computed(() => props.workspace.historyFor(platformId.value));
const buildPlatformLabel = computed(() => {
  const current = platform.value;
  if (!current) return "";
  const id = current.buildPlatform || "";
  return cocosPlatformChoices(current.cocosVersion).find((item) => item.value === id)?.label || id;
});

function openHistory(entryId) {
  props.workspace.ui.historyEntryId = entryId;
  props.workspace.openSection("history");
}
</script>

<template>
  <ReleaseSectionHead
    :workspace="workspace"
    :title="platform?.name || ''"
    :description="card?.lastUpdate ? t('releaseFlow.platformPage.last', { time: formatDateTime(card.lastUpdate) }) : t('releaseFlow.platformPage.never')"
  >
    <template #actions>
      <button type="button" class="wb-rf-btn is-primary" data-release-create-platform @click="openNewUpdate(platformId)">
        <Plus :size="14" aria-hidden="true" />{{ t('releaseFlow.board.new') }}
      </button>
    </template>
  </ReleaseSectionHead>

  <dl v-if="platform" class="wb-rf-facts">
    <div class="wb-rf-fact"><dt>{{ t('releaseFlow.platformEditor.targetDatabase') }}</dt><dd class="wb-rf-code">{{ platform.targetDatabase }}</dd></div>
    <div class="wb-rf-fact"><dt>{{ t('releaseFlow.platformEditor.targetClient') }}</dt><dd class="wb-rf-code">{{ platform.targetClient }}</dd></div>
    <div class="wb-rf-fact"><dt>{{ t('releaseFlow.cocos.version') }}</dt><dd class="wb-rf-code">{{ platform.cocosVersion }} · {{ buildPlatformLabel }}</dd></div>
  </dl>

  <section class="wb-rf-group" aria-labelledby="wb-rf-platform-history">
    <div class="wb-rf-group-head">
      <h4 id="wb-rf-platform-history">{{ t('releaseFlow.platformPage.history') }}</h4>
      <span class="wb-rf-count">{{ entries.length }}</span>
    </div>
    <ReleaseHistoryList v-if="entries.length" :entries="entries" @select="openHistory" />
    <p v-else class="wb-rf-empty">{{ t('releaseFlow.home.noHistory') }}</p>
  </section>
</template>
