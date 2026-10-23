<script setup>
import { computed } from "vue";
import { CalendarClock, Info } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { releaseArtifact, releaseConfigError } from "../releaseWorkflowState.js";
import ReleaseActionList from "./ReleaseActionList.vue";

const props = defineProps({ workflow: { type: Object, required: true } });
const { config, state, busy } = props.workflow;
const artifact = computed(() => releaseArtifact(config.value, state.platform));
const scheduleError = computed(() => releaseConfigError(config.value, 4));
const update = (key, event) => props.workflow.updateConfig(key, event.target.value, 4);
</script>

<template>
  <p class="rw-inline-note"><Info :size="16" />{{ t('release.gmUnavailable') }}</p>
  <section class="rw-section rw-upload-section">
    <div><h3>{{ t('release.activities') }}</h3><p class="rw-help">{{ t('release.activityHint') }}</p></div>
    <ReleaseActionList :workflow="workflow" :actions="['activityUpload', 'activityCurrent']" />
    <label class="rw-check"><input type="checkbox" :checked="config.reloadActivity" :disabled="!!busy" @change="workflow.updateConfig('reloadActivity', $event.target.checked, 4)">{{ t('release.reloadActivity') }}</label>
    <ReleaseActionList v-if="config.reloadActivity" :workflow="workflow" :actions="['activityReload']" />
  </section>
  <section class="rw-section rw-upload-section">
    <h3>{{ t('release.clientPackage') }}</h3><code class="rw-wrap">{{ artifact }}</code>
    <ReleaseActionList :workflow="workflow" :actions="['clientUpload']" />
  </section>
  <section class="rw-section rw-upload-section">
    <h3>{{ t('release.serverPackage') }}</h3><p class="rw-help">{{ t('release.serverHint') }}</p>
    <label class="rw-field"><span class="rw-sr-only">{{ t('release.serverPackage') }}</span><input :value="config.serverPackage" :disabled="!!busy" @input="update('serverPackage', $event)"></label>
    <ReleaseActionList :workflow="workflow" :actions="['serverUpload', 'serverCurrent']" />
  </section>
  <section class="rw-section">
    <h3 class="rw-heading-icon"><CalendarClock :size="18" />{{ t('release.scheduleTitle') }}</h3>
    <p class="rw-help">{{ t('release.timezone') }}</p>
    <div class="rw-form-grid rw-three-fields">
      <label v-for="key in ['maintenanceStart', 'maintenanceEnd', 'clientOpen']" :key="key" class="rw-field">{{ t(`release.${key}`) }}<input type="datetime-local" :value="config[key]" :disabled="!!busy" @input="update(key, $event)"></label>
    </div>
    <p class="rw-help">{{ t('release.scheduleHint') }}</p>
    <p v-if="scheduleError" class="rw-error" role="alert">{{ t(`release.error_${scheduleError}`) }}</p>
    <ReleaseActionList :workflow="workflow" :actions="['schedule']" />
  </section>
</template>
