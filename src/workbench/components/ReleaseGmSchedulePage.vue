<script setup>
// Phase 4: the maintenance window and the moment players receive the client
// update. A day timeline shows both, so a client update opening before
// maintenance ends is visible at a glance.
import { computed } from "vue";
import { TriangleAlert } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatReleaseRange, formatReleaseTime } from "../utils/releaseFlowFormat.js";
import ReleaseGmTaskList from "./ReleaseGmTaskList.vue";
import ReleasePageHead from "./ReleasePageHead.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const busy = computed(() => props.flow.busy.value);
const maintenance = computed(() => props.flow.applies("gm.maintenance"));
const clientOpen = computed(() => props.flow.applies("gm.clientOpen"));
const problem = computed(() => props.flow.scheduleProblem.value);
const tasks = computed(() => ["gm.maintenance", "gm.clientOpen"].filter((id) => props.flow.applies(id)));
const TICKS = [0, 6, 12, 18, 24];
const windowLabel = computed(() => t("releaseFlow.schedule.window", {
  window: formatReleaseRange(state.schedule.maintenanceStart, state.schedule.maintenanceEnd, { dayIso: state.brief.date }),
}));
const pinLabel = computed(() => t("releaseFlow.schedule.pin", {
  time: formatReleaseTime(state.schedule.clientOpenAt, { dayIso: state.brief.date }),
}));

function minutesIntoDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return 0;
  const offsetDays = Math.round((Date.parse(`${match[1]}T00:00:00Z`) - Date.parse(`${state.brief.date}T00:00:00Z`)) / 86400000);
  return Math.max(0, Math.min(1440, offsetDays * 1440 + Number(match[2]) * 60 + Number(match[3])));
}

function percent(value) {
  return `${(minutesIntoDay(value) / 1440) * 100}%`;
}

const windowStyle = computed(() => {
  const start = minutesIntoDay(state.schedule.maintenanceStart);
  const end = Math.max(start, minutesIntoDay(state.schedule.maintenanceEnd));
  return { left: `${(start / 1440) * 100}%`, width: `${((end - start) / 1440) * 100}%` };
});

function update(key, event) {
  props.flow.setSchedule({ [key]: event.target.value });
}
</script>

<template>
  <div>
    <ReleasePageHead page-id="gmSchedule" :description="maintenance ? '' : t('releaseFlow.page.gmSchedule.descriptionHot')" />

    <div class="wb-rf-stack">
      <section class="wb-rf-section wb-rf-schedule-form" aria-labelledby="wb-rf-schedule-title">
        <div class="wb-rf-section-head">
          <h4 id="wb-rf-schedule-title">{{ t('releaseFlow.schedule.title') }}</h4>
        </div>
        <div class="wb-rf-schedule-fields">
          <label v-if="maintenance" class="wb-rf-field">
            {{ t('releaseFlow.schedule.start') }}
            <input type="datetime-local" :value="state.schedule.maintenanceStart" :disabled="busy" @change="update('maintenanceStart', $event)" />
          </label>
          <label v-if="maintenance" class="wb-rf-field">
            {{ t('releaseFlow.schedule.end') }}
            <input type="datetime-local" :value="state.schedule.maintenanceEnd" :disabled="busy" @change="update('maintenanceEnd', $event)" />
          </label>
          <label v-if="clientOpen" class="wb-rf-field">
            {{ t('releaseFlow.schedule.clientOpen') }}
            <input
              type="datetime-local"
              :value="state.schedule.clientOpenAt"
              :disabled="busy || (maintenance && state.schedule.clientOpenFollowsMaintenance)"
              @change="update('clientOpenAt', $event)"
            />
          </label>
        </div>
        <label v-if="maintenance && clientOpen" class="wb-rf-check">
          <input
            type="checkbox"
            :checked="state.schedule.clientOpenFollowsMaintenance"
            :disabled="busy"
            @change="flow.setSchedule({ clientOpenFollowsMaintenance: $event.target.checked })"
          />
          {{ t('releaseFlow.schedule.follow') }}
        </label>
        <p v-if="problem" class="wb-rf-notice is-warning" role="alert">
          <TriangleAlert :size="14" aria-hidden="true" />
          <span>{{ t(`releaseFlow.schedule.problem.${problem}`) }}</span>
        </p>

        <div class="wb-rf-timeline" role="img" :aria-label="t('releaseFlow.schedule.timeline')">
          <div class="wb-rf-timeline-track">
            <span v-if="maintenance" class="wb-rf-timeline-window" :style="windowStyle">
              <span>{{ windowLabel }}</span>
            </span>
            <span v-if="clientOpen" class="wb-rf-timeline-pin" :style="{ left: percent(state.schedule.clientOpenAt) }">
              <span>{{ pinLabel }}</span>
            </span>
          </div>
          <div class="wb-rf-timeline-ticks" aria-hidden="true">
            <span v-for="tick in TICKS" :key="tick" :style="{ left: `${(tick / 24) * 100}%` }">{{ String(tick).padStart(2, '0') }}:00</span>
          </div>
        </div>
      </section>

      <ReleaseGmTaskList
        :flow="flow"
        page-id="gmSchedule"
        :tasks="tasks"
        @run="emit('run', $event)"
        @rerun="emit('rerun', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.wb-rf-schedule-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 220px));
  gap: 12px;
}

.wb-rf-timeline {
  display: grid;
  gap: 4px;
  margin-top: 6px;
  padding: 30px 6px 0;
}

.wb-rf-timeline-track {
  position: relative;
  height: 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-accent) 10%, transparent);
}

.wb-rf-timeline-window {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 4px;
  border-radius: 999px;
  background: var(--wb-warning-border);
}

.wb-rf-timeline-window > span,
.wb-rf-timeline-pin > span {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  color: var(--wb-warning-text);
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}

.wb-rf-timeline-pin {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 2px;
  margin-left: -1px;
  border-radius: 2px;
  background: var(--wb-accent);
}

.wb-rf-timeline-pin > span {
  top: calc(100% + 4px);
  bottom: auto;
  left: 6px;
  color: var(--wb-text);
}

.wb-rf-timeline-ticks {
  position: relative;
  height: 44px;
  color: var(--wb-quiet-text);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.wb-rf-timeline-ticks span {
  position: absolute;
  top: 28px;
  transform: translateX(-50%);
}

.wb-rf-timeline-ticks span:first-child {
  transform: none;
}

.wb-rf-timeline-ticks span:last-child {
  transform: translateX(-100%);
}
</style>
