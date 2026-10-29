<script setup>
// When maintenance starts and ends, and when the client hot update opens
// (with maintenance it can follow the end). Shared by the maintenance page
// and the one-click panel, so both edit the same schedule.
import { computed } from "vue";
import { t } from "../i18n/index.js";

const props = defineProps({
  flow: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
});

const state = props.flow.state;
const maintenance = computed(() => state.brief.mode === "maintenance");
const clientInRelease = computed(() => props.flow.applies("gm.clientOpen"));
const problem = computed(() => props.flow.scheduleProblem.value);
const following = computed(() => maintenance.value && state.schedule.clientOpenFollowsMaintenance);

function update(key, event) {
  props.flow.setSchedule({ [key]: event.target.value });
}
</script>

<template>
  <div class="wb-rf-schedule-fields">
    <label v-if="maintenance" class="wb-rf-field">
      {{ t('releaseFlow.schedule.start') }}
      <input type="datetime-local" :value="state.schedule.maintenanceStart" :disabled="disabled" @change="update('maintenanceStart', $event)" />
    </label>
    <label v-if="maintenance" class="wb-rf-field">
      {{ t('releaseFlow.schedule.end') }}
      <input type="datetime-local" :value="state.schedule.maintenanceEnd" :disabled="disabled" @change="update('maintenanceEnd', $event)" />
    </label>
    <label v-if="clientInRelease" class="wb-rf-field">
      {{ t('releaseFlow.schedule.clientOpen') }}
      <input
        type="datetime-local"
        :value="state.schedule.clientOpenAt"
        :disabled="disabled || following"
        @change="update('clientOpenAt', $event)"
      />
    </label>
  </div>
  <label v-if="maintenance && clientInRelease" class="wb-rf-check">
    <input
      type="checkbox"
      :checked="state.schedule.clientOpenFollowsMaintenance"
      :disabled="disabled"
      @change="flow.setSchedule({ clientOpenFollowsMaintenance: $event.target.checked })"
    />
    {{ t('releaseFlow.schedule.follow') }}
  </label>
  <p v-if="maintenance && problem" class="wb-rf-hint wb-rf-problem">{{ t(`releaseFlow.schedule.problem.${problem}`) }}</p>
</template>

<style scoped>
.wb-rf-schedule-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.wb-rf-problem {
  color: var(--wb-warning-text);
}
</style>
