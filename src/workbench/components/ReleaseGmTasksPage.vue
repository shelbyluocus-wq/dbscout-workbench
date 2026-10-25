<script setup>
// Phase 4, uploads: the activity table, the client hot update and the
// server, each made current separately. Without downtime the activities are
// reloaded here instead of at the restart.
import { computed } from "vue";
import { Gift, MonitorSmartphone, Server } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatReleaseBytes } from "../utils/releaseFlowFormat.js";
import ReleaseGmTaskList from "./ReleaseGmTaskList.vue";
import ReleasePageHead from "./ReleasePageHead.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const hot = computed(() => state.brief.mode === "hot");

const groups = computed(() => [
  { id: "activity", icon: Gift, tasks: ["gm.activityUpload", "gm.activityCurrent", "gm.activityReload"] },
  { id: "client", icon: MonitorSmartphone, tasks: ["gm.clientUpload"] },
  { id: "server", icon: Server, tasks: ["gm.serverUpload", "gm.serverCurrent"] },
]
  .map((group) => ({ ...group, tasks: group.tasks.filter((id) => props.flow.applies(id)) }))
  .filter((group) => group.tasks.length));

// What each upload sends, shown until it is done.
const details = computed(() => {
  const files = props.flow.gmFiles.value;
  const build = state.tasks["build.cocos"].result;
  return {
    "gm.activityUpload": files.activity,
    "gm.serverUpload": files.server,
    "gm.clientUpload": build?.sizeBytes ? `${files.client} · ${formatReleaseBytes(build.sizeBytes)}` : files.client,
  };
});
</script>

<template>
  <ReleasePageHead page-id="gmUpload">
    <template #tag><span class="wb-rf-chip is-quiet">{{ t('releaseFlow.gm.simulatedTag') }}</span></template>
  </ReleasePageHead>

  <section v-for="group in groups" :key="group.id" class="wb-rf-group" :aria-labelledby="`wb-rf-gm-${group.id}`">
    <div class="wb-rf-group-head">
      <component :is="group.icon" :size="15" class="wb-rf-muted" aria-hidden="true" />
      <h4 :id="`wb-rf-gm-${group.id}`">{{ t(`releaseFlow.gm.group.${group.id}`) }}</h4>
      <span v-if="group.id === 'activity'" class="wb-rf-count">
        {{ t(hot ? 'releaseFlow.gm.reloadNeeded' : 'releaseFlow.gm.reloadNotNeeded') }}
      </span>
    </div>
    <ReleaseGmTaskList
      :flow="flow"
      page-id="gmUpload"
      :tasks="group.tasks"
      :details="details"
      @run="emit('run', $event)"
      @rerun="emit('rerun', $event)"
    />
  </section>
</template>
