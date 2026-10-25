<script setup>
// Phase 2, step 4: review what the copy and the conversion changed in the
// platform client's working copy, side by side, and commit or revert from
// here. The working copy of this step is the demo's (simulated); the SVN
// page works on a real one.
import { computed, onMounted } from "vue";
import { ArrowRight } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useSvnWorkspace } from "../composables/useSvnWorkspace.js";
import { RELEASE_SPEEDS } from "../releaseWorkspaceState.js";
import { createDemoSvnSource } from "../utils/releaseSvnDemo.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseSvnWorkspace from "./ReleaseSvnWorkspace.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const platform = computed(() => props.flow.platform.value);
const speed = () => RELEASE_SPEEDS[props.flow.workspace.demo.speed] ?? 1;
const svn = useSvnWorkspace({
  source: createDemoSvnSource({
    memory: props.flow.state.svnDemo,
    platformId: () => platform.value.id,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms * speed())),
  }),
});

onMounted(() => void svn.open(platform.value.targetClient));

function openRealWorkingCopy() {
  props.workspace?.setSvnPath(platform.value.targetClient);
  emit("navigate", "svn");
}
</script>

<template>
  <ReleasePageHead page-id="clientDiff">
    <template #tag>
      <button type="button" class="wb-rf-link wb-rf-head-link" data-release-real-svn @click="openRealWorkingCopy">
        {{ t('releaseFlow.diff.openReal') }}<ArrowRight :size="13" aria-hidden="true" />
      </button>
    </template>
  </ReleasePageHead>

  <ReleaseSvnWorkspace :svn="svn" simulated />

  <ReleaseTaskPanel :flow="flow" task-id="client.diff" :show-log="false">
    <template #done="{ result }">
      <strong>{{ t('releaseFlow.diff.done', { count: result.files }) }}</strong>
    </template>
  </ReleaseTaskPanel>
</template>
