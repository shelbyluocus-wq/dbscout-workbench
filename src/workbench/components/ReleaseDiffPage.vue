<script setup>
// Phase 2, step 4: review what the copy and the conversion changed in the
// platform client's working copy, side by side, and commit or revert from
// here. Uses the real SVN working copy in desktop mode and the simulated
// working copy in demo / browser preview mode.
import { computed, onMounted, watch } from "vue";
import { ArrowRight, FolderGit2 } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { createSvnBackendSource, useSvnWorkspace } from "../composables/useSvnWorkspace.js";
import { RELEASE_SPEEDS } from "../releaseWorkspaceState.js";
import { createDemoSvnSource } from "../utils/releaseSvnDemo.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseRoutePathNode from "./ReleaseRoutePathNode.vue";
import ReleaseSvnWorkspace from "./ReleaseSvnWorkspace.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const isReal = computed(() => Boolean(props.flow.isReal?.value));
const platform = computed(() => props.flow.platform.value);
const locked = computed(() => props.flow.busy.value || props.flow.finished.value);
const speed = () => RELEASE_SPEEDS[props.flow.workspace.demo.speed] ?? 1;
const backendSource = createSvnBackendSource();
const demoSource = createDemoSvnSource({
  memory: props.flow.state.svnDemo,
  platformId: () => platform.value.id,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms * speed())),
});
const activeSource = () => (isReal.value ? backendSource : demoSource);
const source = {
  get kind() { return activeSource().kind; },
  info: (...args) => activeSource().info(...args),
  status: (...args) => activeSource().status(...args),
  update: (...args) => activeSource().update?.(...args),
  fileDiff: (...args) => activeSource().fileDiff(...args),
  commit: (...args) => activeSource().commit(...args),
  revert: (...args) => activeSource().revert(...args),
  resolve: (...args) => activeSource().resolve(...args),
  log: (...args) => activeSource().log(...args),
  pickFolder: (...args) => activeSource().pickFolder?.(...args),
};

const svn = useSvnWorkspace({
  source,
  onRecord(record) {
    props.workspace?.recordTool?.({
      kind: "svn",
      platformId: platform.value.id,
      platformName: platform.value.name,
      demo: !isReal.value,
      outcome: record.outcome,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      details: { ...record.details, action: record.kind },
    });
  },
});

onMounted(() => void svn.open(platform.value.targetClient));
watch(
  [
    () => platform.value.targetClient,
    isReal,
    () => props.flow.state.tasks["client.sync"].finishedAt,
    () => props.flow.state.tasks["client.transfer"].finishedAt,
  ],
  ([targetClient]) => {
    if (targetClient) void svn.open(targetClient);
  },
);

function openRealWorkingCopy() {
  props.workspace?.setSvnPath(platform.value.targetClient);
  emit("navigate", "svn");
}
</script>

<template>
  <ReleasePageHead page-id="clientDiff">
    <template #tag>
      <button type="button" class="wb-rf-link wb-rf-head-link" data-release-real-svn @click="openRealWorkingCopy">
        {{ t(isReal ? 'releaseFlow.diff.openSvnTool' : 'releaseFlow.diff.openReal') }}<ArrowRight :size="13" aria-hidden="true" />
      </button>
    </template>
  </ReleasePageHead>

  <ReleaseRoutePathNode
    :workspace="workspace"
    :platform="platform"
    field-key="targetClient"
    :label="t('releaseFlow.svn.target', { platform: platform.name })"
    target
    :disabled="locked"
  >
    <template #icon><FolderGit2 :size="13" aria-hidden="true" /></template>
  </ReleaseRoutePathNode>

  <ReleaseSvnWorkspace :svn="svn" :simulated="!isReal" />

  <ReleaseTaskPanel :flow="flow" task-id="client.diff" :show-log="false">
    <template #done="{ result }">
      <strong>{{ t('releaseFlow.diff.done', { count: result.files }) }}</strong>
    </template>
  </ReleaseTaskPanel>
</template>
