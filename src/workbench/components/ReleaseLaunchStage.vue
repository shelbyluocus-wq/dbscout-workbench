<script setup>
import { Check, CircleCheck, Clock3 } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import ReleaseActionList from "./ReleaseActionList.vue";

const props = defineProps({ workflow: { type: Object, required: true } });
const { config, draft, complete, busy } = props.workflow;
</script>

<template>
  <section v-if="complete" class="rw-finished" role="status">
    <CircleCheck :size="40" /><div><h3>{{ t('release.finished') }}</h3><p>{{ t('release.finishedHint') }}</p></div>
  </section>
  <p class="rw-inline-note"><Clock3 :size="17" />{{ t('release.clockHint') }}</p>
  <div class="rw-timeline">
    <div><span>{{ t('release.maintenanceStart') }}</span><strong>{{ config.maintenanceStart.replace('T', ' ') }}</strong></div>
    <div><span>{{ t('release.maintenanceEnd') }}</span><strong>{{ config.maintenanceEnd.replace('T', ' ') }}</strong></div>
    <div><span>{{ t('release.clientOpen') }}</span><strong>{{ config.clientOpen.replace('T', ' ') }}</strong></div>
  </div>
  <ReleaseActionList :workflow="workflow" :actions="['maintenance', 'restart', 'health']" />
  <section v-if="draft.results.health === 'done'" class="rw-section rw-health">
    <h3>{{ t('release.healthTitle') }} <span class="rw-tag">{{ t('release.demo') }}</span></h3>
    <p v-for="key in ['healthServer', 'healthActivities', 'healthClient']" :key="key"><Check :size="16" class="rw-success" />{{ t(`release.${key}`) }}</p>
  </section>
  <label class="rw-check rw-prepared"><input v-model="draft.checks.launch" type="checkbox" :disabled="!!busy || draft.results.health !== 'done' || complete">{{ t('release.launchReview') }}</label>
  <ReleaseActionList :workflow="workflow" :actions="['open']" />
</template>
