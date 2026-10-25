<script setup>
// Rows of the history: what ran (an update, a client build or an SVN
// operation), for which platform, when, and how it ended. Simulated entries
// say so; real ones from the build page and the SVN tool do not.
import { FolderGit2, Package, Rocket } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatDateTime, formatReleaseDuration } from "../utils/releaseFlowFormat.js";
import { historyTitle } from "../utils/releaseHistoryFormat.js";

defineProps({
  entries: { type: Array, required: true },
  selectedId: { type: String, default: "" },
  compact: { type: Boolean, default: false },
});

const emit = defineEmits(["select"]);
const ICONS = Object.freeze({ release: Rocket, build: Package, svn: FolderGit2 });
const TONES = Object.freeze({ done: "is-success", failed: "is-danger", abandoned: "is-warning", cancelled: "is-quiet" });
</script>

<template>
  <ul class="wb-rf-list wb-rf-history-list" :class="{ 'is-compact': compact }">
    <li v-for="entry in entries" :key="entry.id">
      <button
        type="button"
        class="wb-rf-history-row"
        :data-history-id="entry.id"
        :aria-current="entry.id === selectedId ? 'true' : undefined"
        @click="emit('select', entry.id)"
      >
        <span class="wb-rf-history-icon" aria-hidden="true"><component :is="ICONS[entry.kind] || Rocket" :size="15" /></span>
        <span class="wb-rf-history-main">
          <span class="wb-rf-history-title">
            <strong>{{ entry.platformName || t('releaseFlow.history.noPlatform') }}</strong>
            <span>{{ historyTitle(entry) }}</span>
          </span>
          <span class="wb-rf-history-meta">
            {{ formatDateTime(entry.finishedAt) }}
            <template v-if="entry.startedAt && entry.finishedAt > entry.startedAt"> · {{ formatReleaseDuration(entry.finishedAt - entry.startedAt) }}</template>
            <template v-if="entry.stats?.warnings"> · {{ t('releaseFlow.history.warnings', { count: entry.stats.warnings }) }}</template>
          </span>
        </span>
        <span class="wb-rf-history-tags">
          <span v-if="entry.demo" class="wb-rf-chip is-quiet">{{ t('releaseFlow.history.demo') }}</span>
          <span class="wb-rf-chip" :class="TONES[entry.outcome]">{{ t(`releaseFlow.history.outcome.${entry.outcome}`) }}</span>
        </span>
      </button>
    </li>
  </ul>
</template>
