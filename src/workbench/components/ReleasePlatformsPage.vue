<script setup>
// Platforms, a tool beside the release steps: where each platform's release
// goes. Changing the platform of the current release resets the steps that
// used the changed value.
import { computed, ref } from "vue";
import { t } from "../i18n/index.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleasePlatformEditor from "./ReleasePlatformEditor.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const selectedId = ref(state.brief.platformId);
const selected = computed(() => state.platforms.find((entry) => entry.id === selectedId.value) || state.platforms[0]);
</script>

<template>
  <ReleasePageHead page-id="platforms" />

  <div class="wb-rf-segmented" role="tablist" :aria-label="t('releaseFlow.platformEditor.choose')">
    <button
      v-for="platform in state.platforms"
      :key="platform.id"
      type="button"
      role="tab"
      :aria-selected="platform.id === selected.id"
      @click="selectedId = platform.id"
    >
      {{ platform.name }}
      <span v-if="platform.id === state.brief.platformId" class="wb-rf-count">{{ t('releaseFlow.plan.thisRelease') }}</span>
    </button>
  </div>

  <ReleasePlatformEditor :key="selected.id" :flow="flow" :platform="selected" />
</template>
