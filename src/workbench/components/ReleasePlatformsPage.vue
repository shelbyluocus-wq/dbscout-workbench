<script setup>
// Platform settings, a workspace page: where each platform's update goes.
// Changing a platform resets the steps of its open update that used the
// changed value.
import { computed, ref } from "vue";
import { t } from "../i18n/index.js";
import ReleasePlatformEditor from "./ReleasePlatformEditor.vue";
import ReleaseSectionHead from "./ReleaseSectionHead.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const platforms = computed(() => props.workspace.state.platforms);
const returnRun = computed(() => {
  const target = props.workspace.view.returnTo;
  return target?.section === "run" ? props.workspace.flowFor(target.runId) : null;
});
const selectedId = ref(returnRun.value?.platform.value.id || platforms.value[0]?.id);
const selected = computed(() => platforms.value.find((entry) => entry.id === selectedId.value) || platforms.value[0]);
// A platform with an update on its card says how far it is.
const states = computed(() => Object.fromEntries(props.workspace.cards.value
  .filter((card) => card.runId && card.status !== "done")
  .map((card) => [card.platformId, card.status])));
</script>

<template>
  <ReleaseSectionHead :workspace="workspace" :title="t('releaseFlow.page.platforms.title')" :description="t('releaseFlow.page.platforms.description')" />

  <div class="wb-rf-segmented" role="tablist" :aria-label="t('releaseFlow.platformEditor.choose')">
    <button
      v-for="platform in platforms"
      :key="platform.id"
      type="button"
      role="tab"
      :aria-selected="platform.id === selected.id"
      @click="selectedId = platform.id"
    >
      {{ platform.name }}
      <span v-if="states[platform.id]" class="wb-rf-count">{{ t(`releaseFlow.card.status.${states[platform.id]}`) }}</span>
    </button>
  </div>

  <ReleasePlatformEditor :key="selected.id" :workspace="workspace" :platform="selected" />
</template>
