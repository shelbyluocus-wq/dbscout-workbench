<script setup>
// Phase 4 pages that are lists of GM operations: uploading the activity
// table, client and server (each made current separately), and restarting
// then opening the servers once maintenance has begun.
import { computed } from "vue";
import { Gift, MonitorSmartphone, Server } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatReleaseBytes, formatReleaseRange } from "../utils/releaseFlowFormat.js";
import ReleaseGmTaskList from "./ReleaseGmTaskList.vue";
import ReleasePageHead from "./ReleasePageHead.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  pageId: { type: String, required: true },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const hot = computed(() => state.brief.mode === "hot");

const groups = computed(() => {
  if (props.pageId === "gmLaunch") {
    return [{ id: "launch", icon: Server, tasks: ["gm.restart", "gm.open"] }];
  }
  return [
    { id: "activity", icon: Gift, tasks: ["gm.activityUpload", "gm.activityCurrent", "gm.activityReload"] },
    { id: "client", icon: MonitorSmartphone, tasks: ["gm.clientUpload"] },
    { id: "server", icon: Server, tasks: ["gm.serverUpload", "gm.serverCurrent"] },
  ]
    .map((group) => ({ ...group, tasks: group.tasks.filter((id) => props.flow.applies(id)) }))
    .filter((group) => group.tasks.length);
});

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

const maintenanceWindow = computed(() => t("releaseFlow.gm.window", {
  window: formatReleaseRange(state.schedule.maintenanceStart, state.schedule.maintenanceEnd),
}));
</script>

<template>
  <div>
    <ReleasePageHead :page-id="pageId" />

    <div class="wb-rf-stack">
      <p v-if="pageId === 'gmLaunch'" class="wb-rf-notice">
        <Server :size="14" aria-hidden="true" />
        <span>{{ maintenanceWindow }}</span>
      </p>

      <section v-for="group in groups" :key="group.id" class="wb-rf-gm-group" :aria-labelledby="`wb-rf-gm-${group.id}`">
        <h4 :id="`wb-rf-gm-${group.id}`" class="wb-rf-gm-group-title">
          <component :is="group.icon" :size="14" aria-hidden="true" />
          {{ t(`releaseFlow.gm.group.${group.id}`) }}
        </h4>
        <ReleaseGmTaskList
          :flow="flow"
          :page-id="pageId"
          :tasks="group.tasks"
          :details="details"
          @run="emit('run', $event)"
          @rerun="emit('rerun', $event)"
        />
        <p v-if="group.id === 'activity'" class="wb-rf-hint wb-rf-gm-note">
          {{ t(hot ? 'releaseFlow.gm.reloadNeeded' : 'releaseFlow.gm.reloadNotNeeded') }}
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-gm-group {
  display: grid;
  gap: 8px;
}

.wb-rf-gm-group-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 12.5px;
  font-weight: 650;
}

.wb-rf-gm-note {
  padding-left: 2px;
}
</style>
