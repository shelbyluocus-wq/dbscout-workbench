<script setup>
// The board on the left: every platform as a note, top to bottom, so the
// state of all updates shows at a glance. A click opens that platform's
// update (or its page when it has none); the update on screen lists its steps
// under its note. A new update starts from the button at the top.
import { computed, inject } from "vue";
import { Plus } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import ReleasePlatformCard from "./ReleasePlatformCard.vue";
import ReleaseRunSteps from "./ReleaseRunSteps.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const openNewUpdate = inject("releaseNewUpdate", () => {});
const view = props.workspace.view;
const cards = computed(() => props.workspace.cards.value);
const currentRun = computed(() => (view.section === "run" ? view.runId : ""));
// The steps unfold under the update on screen, or the one a page was opened from.
const unfolded = computed(() => currentRun.value || (view.returnTo?.section === "run" ? view.returnTo.runId : ""));

function selected(card) {
  if (view.section === "run") return card.runId === view.runId;
  return view.section === "platform" && view.platformId === card.platformId;
}

function navigate(runId, pageId) {
  const flow = props.workspace.flowFor(runId);
  if (!flow) return;
  flow.go(pageId);
  props.workspace.openRun(runId);
}
</script>

<template>
  <aside class="wb-rf-board" :aria-label="t('releaseFlow.board.label')">
    <div class="wb-rf-board-top">
      <button type="button" class="wb-rf-btn wb-rf-board-new" data-release-new-update @click="openNewUpdate()">
        <Plus :size="15" aria-hidden="true" />{{ t('releaseFlow.board.new') }}
      </button>
    </div>
    <div class="wb-rf-board-scroll">
      <p class="wb-rf-board-caption">{{ t('releaseFlow.board.platforms') }}</p>
      <ReleasePlatformCard
        v-for="card in cards"
        :key="card.platformId"
        :card="card"
        :selected="selected(card)"
        :expanded="Boolean(card.runId && card.runId === unfolded && workspace.flowFor(card.runId))"
        @open="workspace.openPlatform"
      >
        <ReleaseRunSteps
          v-if="card.runId && card.runId === unfolded && workspace.flowFor(card.runId)"
          :flow="workspace.flowFor(card.runId)"
          :current="card.runId === currentRun"
          @navigate="navigate(card.runId, $event)"
        />
      </ReleasePlatformCard>
    </div>
  </aside>
</template>
