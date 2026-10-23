<script setup>
import { ArrowRight, ClipboardCheck, ListChecks, Save } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import ReleaseActionList from "./ReleaseActionList.vue";

const props = defineProps({ workflow: { type: Object, required: true } });
const { config, busy } = props.workflow;
</script>

<template>
  <div class="rw-form-grid">
    <label class="rw-field">{{ t('release.date') }}<input type="date" :value="config.date" :disabled="!!busy" @input="workflow.updateConfig('date', $event.target.value, 0)"><small>{{ t('release.timezone') }}</small></label>
    <label class="rw-field">{{ t('release.version') }}<input :value="config.version" :disabled="!!busy" maxlength="80" @input="workflow.updateConfig('version', $event.target.value, 0)"></label>
  </div>
  <section class="rw-section">
    <h3>{{ t('release.routeTitle') }}</h3>
    <div class="rw-route">
      <div><span>{{ t('release.development') }}</span><strong>{{ config.sourceDb }}</strong><code>{{ config.sourceClient }}</code></div>
      <ArrowRight :size="22" aria-hidden="true" />
      <div><span>{{ t('release.destination') }}</span><strong>{{ config.targetDb }}</strong><code>{{ config.targetClient }}</code></div>
    </div>
  </section>
  <label class="rw-check rw-prepared"><input type="checkbox" :checked="config.prepared" :disabled="!!busy" @change="workflow.updateConfig('prepared', $event.target.checked, 0)"><span><strong>{{ t('release.prepared') }}</strong><small>{{ t('release.preparedHint') }}</small></span></label>
  <ReleaseActionList :workflow="workflow" :actions="['preflight']" />
  <div class="rw-principles">
    <div><ClipboardCheck :size="18" /><h3>{{ t('release.planFirst') }}</h3><p>{{ t('release.planFirstHint') }}</p></div>
    <div><ListChecks :size="18" /><h3>{{ t('release.gated') }}</h3><p>{{ t('release.gatedHint') }}</p></div>
    <div><Save :size="18" /><h3>{{ t('release.resume') }}</h3><p>{{ t('release.resumeHint') }}</p></div>
  </div>
</template>
