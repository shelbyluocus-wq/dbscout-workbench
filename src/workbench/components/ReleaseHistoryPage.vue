<script setup>
// The history: every update, client build and SVN operation, newest first,
// filtered by platform and kind, with the selected record beside the list.
// Records stay on this device and are kept when a new update starts.
import { computed, ref, watch } from "vue";
import { t } from "../i18n/index.js";
import { HISTORY_KINDS } from "../releaseWorkspaceState.js";
import { formatDayOf } from "../utils/releaseFlowFormat.js";
import { groupHistoryByDay } from "../utils/releaseHistoryFormat.js";
import ReleaseHistoryDetail from "./ReleaseHistoryDetail.vue";
import ReleaseHistoryList from "./ReleaseHistoryList.vue";
import ReleaseSectionHead from "./ReleaseSectionHead.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const platformFilter = ref("all");
const kindFilter = ref("all");
const entries = computed(() => props.workspace.history.value.filter((entry) =>
  (platformFilter.value === "all" || entry.platformId === platformFilter.value)
  && (kindFilter.value === "all" || entry.kind === kindFilter.value)));
const groups = computed(() => groupHistoryByDay(entries.value));
const selectedId = ref(props.workspace.ui.historyEntryId || "");
props.workspace.ui.historyEntryId = "";
const selected = computed(() => entries.value.find((entry) => entry.id === selectedId.value) || entries.value[0] || null);

watch(entries, (list) => {
  if (!list.some((entry) => entry.id === selectedId.value)) selectedId.value = list[0]?.id || "";
});
</script>

<template>
  <ReleaseSectionHead :workspace="workspace" :title="t('releaseFlow.history.title')" :description="t('releaseFlow.history.description')" />

  <div class="wb-rf-history-filters">
    <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.history.platformFilter')">
      <button type="button" role="radio" :aria-checked="platformFilter === 'all'" @click="platformFilter = 'all'">{{ t('releaseFlow.history.all') }}</button>
      <button
        v-for="platform in workspace.state.platforms"
        :key="platform.id"
        type="button"
        role="radio"
        :aria-checked="platformFilter === platform.id"
        @click="platformFilter = platform.id"
      >{{ platform.name }}</button>
    </div>
    <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.history.kindFilter')">
      <button type="button" role="radio" :aria-checked="kindFilter === 'all'" @click="kindFilter = 'all'">{{ t('releaseFlow.history.all') }}</button>
      <button
        v-for="kind in HISTORY_KINDS"
        :key="kind"
        type="button"
        role="radio"
        :aria-checked="kindFilter === kind"
        @click="kindFilter = kind"
      >{{ t(`releaseFlow.history.kind.${kind}`) }}</button>
    </div>
  </div>

  <div v-if="entries.length" class="wb-rf-history">
    <div class="wb-rf-history-days">
      <section v-for="group in groups" :key="group.key" class="wb-rf-history-day" :aria-label="formatDayOf(group.at)">
        <h4>{{ formatDayOf(group.at) }}</h4>
        <ReleaseHistoryList :entries="group.entries" :selected-id="selected?.id || ''" @select="selectedId = $event" />
      </section>
    </div>
    <ReleaseHistoryDetail v-if="selected" :key="selected.id" :workspace="workspace" :entry="selected" />
  </div>
  <p v-else class="wb-rf-empty">{{ t('releaseFlow.history.empty') }}</p>
</template>
