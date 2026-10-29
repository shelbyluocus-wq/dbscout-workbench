<script setup>
// Phase 4, preparing in the GM while the servers still run: the config
// version packed from the relay database, the activity table, the client hot
// update (uploaded, confirmed, synced) and the server version the company GM
// builds and syncs. Without downtime the activities are reloaded here.
import { computed } from "vue";
import { Database, Gift, MonitorSmartphone, Server } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatReleaseBytes } from "../utils/releaseFlowFormat.js";
import ReleaseGmTaskList from "./ReleaseGmTaskList.vue";
import ReleasePageHead from "./ReleasePageHead.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const hot = computed(() => state.brief.mode === "hot");

const groups = computed(() => [
  { id: "config", icon: Database, tasks: ["gm.configPack"] },
  { id: "activity", icon: Gift, tasks: ["gm.activityUpload", "gm.activityCurrent", "gm.activityReload"] },
  { id: "client", icon: MonitorSmartphone, tasks: ["gm.clientUpload", "gm.clientPull", "gm.clientPush"] },
  { id: "server", icon: Server, tasks: ["gm.serverBuild", "gm.serverPush"] },
]
  .map((group) => ({ ...group, tasks: group.tasks.filter((id) => props.flow.applies(id)) }))
  .filter((group) => group.tasks.length));

// What each upload sends, shown until it is done.
const details = computed(() => {
  const files = props.flow.gmFiles.value;
  const build = state.tasks["build.cocos"].result;
  const platform = props.flow.platform.value;
  return {
    "gm.configPack": t("releaseFlow.gm.packRoute", { database: platform.targetDatabase, platform: platform.name }),
    "gm.activityUpload": files.activity,
    "gm.serverBuild": files.server,
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
