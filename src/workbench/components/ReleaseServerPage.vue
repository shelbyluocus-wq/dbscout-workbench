<script setup>
// Phase 4, the last stage. With downtime it follows the servers live:
// schedule the maintenance, wait for it (the servers close by themselves at
// the set time), compile and restart during maintenance, then open them by
// hand. Without downtime it only sets when the client hot update opens.
import { computed } from "vue";
import { Clock3, FastForward, FlaskConical, Server, Users } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { DEMO_SERVERS } from "../utils/releaseFlowDemo.js";
import { MAINTENANCE_STAGES, formatCountdown, stageIndex, toLocalInput } from "../utils/releaseServer.js";
import { formatClockTime, formatReleaseCount, formatReleaseRange, formatReleaseTime, taskTitle } from "../utils/releaseFlowFormat.js";
import ReleaseGmTaskList from "./ReleaseGmTaskList.vue";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const mode = computed(() => state.brief.mode);
const maintenance = computed(() => mode.value === "maintenance");
const busy = computed(() => props.flow.busy.value);
const phase = computed(() => props.flow.serverPhase.value);
const now = computed(() => props.flow.serverNow.value);
const problem = computed(() => props.flow.scheduleProblem.value);
const clientInRelease = computed(() => props.flow.applies("gm.clientOpen"));
const current = computed(() => stageIndex(phase.value));
const shutdownAt = computed(() => Date.parse(state.tasks["gm.shutdown"].result?.at || "") || 0);
const openedAt = props.flow.openedAt;
const inMaintenance = computed(() => ["maintenance", "restarting", "readyToOpen", "opening"].includes(phase.value));
const overrun = computed(() => inMaintenance.value && now.value > props.flow.maintenanceEndAt.value);
const windowText = computed(() => formatReleaseRange(state.schedule.maintenanceStart, state.schedule.maintenanceEnd));

const PHASE_TONES = Object.freeze({
  running: "is-live",
  scheduled: "is-waiting",
  closing: "is-down",
  maintenance: "is-down",
  restarting: "is-down",
  readyToOpen: "is-down",
  opening: "is-waiting",
  restored: "is-live",
});

// The big clock: what the person waits for or how long it has been.
const clock = computed(() => {
  if (phase.value === "scheduled") {
    return { label: t("releaseFlow.server.clock.untilStart"), value: formatCountdown(props.flow.maintenanceStartAt.value - now.value) };
  }
  if (inMaintenance.value && shutdownAt.value) {
    return { label: t("releaseFlow.server.clock.inMaintenance"), value: formatCountdown(now.value - shutdownAt.value) };
  }
  if (phase.value === "restored" && openedAt.value) {
    return { label: t("releaseFlow.server.clock.sinceOpen"), value: formatCountdown(now.value - openedAt.value) };
  }
  return null;
});

const clientUpdate = computed(() => {
  const task = state.tasks["gm.clientOpen"];
  if (!clientInRelease.value) return "";
  if (task.status !== "done") return t("releaseFlow.server.client.unscheduled");
  const at = formatReleaseTime(toLocalInput(props.flow.clientOpenAt.value), { dayIso: state.brief.date });
  return now.value >= props.flow.clientOpenAt.value
    ? t("releaseFlow.server.client.open", { version: task.result?.version || "", time: at })
    : t("releaseFlow.server.client.scheduled", { version: task.result?.version || "", time: at });
});

function stageState(index) {
  if (index < current.value || phase.value === "restored") return "done";
  return index === current.value ? "current" : "pending";
}

function stageTime(stage) {
  if (stage.id === "wait" || stage.id === "close") return formatReleaseTime(state.schedule.maintenanceStart, { dayIso: state.brief.date });
  if (stage.id === "open") return formatReleaseTime(state.schedule.maintenanceEnd, { dayIso: state.brief.date });
  if (stage.id === "live" && openedAt.value) return formatClockTime(openedAt.value).slice(0, 5);
  return "";
}

// The server's own timeline, in server time.
const events = computed(() => state.events
  .filter((entry) => entry.taskId?.startsWith("gm.") && ["gm.maintenance", "gm.clientOpen", "gm.shutdown", "gm.restart", "gm.open"].includes(entry.taskId))
  .filter((entry) => entry.event === "done" || entry.event === "cancelled")
  .slice(-8)
  .reverse());

function update(key, event) {
  props.flow.setSchedule({ [key]: event.target.value });
}
</script>

<template>
  <ReleasePageHead page-id="gmServer" :mode="mode">
    <template #tag><span class="wb-rf-chip is-quiet">{{ t('releaseFlow.gm.simulatedTag') }}</span></template>
  </ReleasePageHead>

  <template v-if="maintenance">
    <section class="wb-rf-server" :class="PHASE_TONES[phase]" aria-live="polite">
      <div class="wb-rf-server-main">
        <span class="wb-rf-server-pill"><span class="wb-rf-server-dot" />{{ t(`releaseFlow.server.phase.${phase}`) }}</span>
        <strong class="wb-rf-server-title">{{ t(`releaseFlow.server.headline.${phase}`) }}</strong>
        <div class="wb-rf-server-meta">
          <span><Users :size="13" aria-hidden="true" />{{ t('releaseFlow.server.players', { count: formatReleaseCount(flow.players.value) }) }}</span>
          <span><Server :size="13" aria-hidden="true" />{{ t(inMaintenance || phase === 'closing' ? 'releaseFlow.server.serversDown' : 'releaseFlow.server.serversUp', { count: DEMO_SERVERS.count }) }}</span>
          <span v-if="state.tasks['gm.maintenance'].status === 'done'"><Clock3 :size="13" aria-hidden="true" />{{ t('releaseFlow.server.window', { window: windowText }) }}</span>
        </div>
      </div>
      <div v-if="clock" class="wb-rf-server-clock">
        <span>{{ clock.label }}</span>
        <strong>{{ clock.value }}</strong>
      </div>
    </section>

    <ol class="wb-rf-list wb-rf-server-stages" :aria-label="t('releaseFlow.server.stages')">
      <li v-for="(stage, index) in MAINTENANCE_STAGES" :key="stage.id" :class="`is-${stageState(index)}`">
        <span class="wb-rf-server-stage-dot" />
        <strong>{{ t(`releaseFlow.server.stage.${stage.id}`) }}</strong>
        <small>{{ stageTime(stage) }}</small>
      </li>
    </ol>

    <p v-if="overrun" class="wb-rf-notice is-warning" role="status">{{ t('releaseFlow.server.overrun', { time: formatReleaseTime(state.schedule.maintenanceEnd) }) }}</p>

    <section v-if="phase === 'running'" class="wb-rf-card" aria-labelledby="wb-rf-schedule-title">
      <div class="wb-rf-group-head">
        <h4 id="wb-rf-schedule-title">{{ t('releaseFlow.server.scheduleTitle') }}</h4>
        <div class="wb-rf-group-tools">
          <button type="button" class="wb-rf-btn is-quiet is-small" :disabled="busy" @click="flow.suggestSchedule()">{{ t('releaseFlow.server.suggest') }}</button>
        </div>
      </div>
      <div class="wb-rf-schedule-fields">
        <label class="wb-rf-field">
          {{ t('releaseFlow.schedule.start') }}
          <input type="datetime-local" :value="state.schedule.maintenanceStart" :disabled="busy" @change="update('maintenanceStart', $event)" />
        </label>
        <label class="wb-rf-field">
          {{ t('releaseFlow.schedule.end') }}
          <input type="datetime-local" :value="state.schedule.maintenanceEnd" :disabled="busy" @change="update('maintenanceEnd', $event)" />
        </label>
        <label v-if="clientInRelease" class="wb-rf-field">
          {{ t('releaseFlow.schedule.clientOpen') }}
          <input
            type="datetime-local"
            :value="state.schedule.clientOpenAt"
            :disabled="busy || state.schedule.clientOpenFollowsMaintenance"
            @change="update('clientOpenAt', $event)"
          />
        </label>
      </div>
      <label v-if="clientInRelease" class="wb-rf-check">
        <input
          type="checkbox"
          :checked="state.schedule.clientOpenFollowsMaintenance"
          :disabled="busy"
          @change="flow.setSchedule({ clientOpenFollowsMaintenance: $event.target.checked })"
        />
        {{ t('releaseFlow.schedule.follow') }}
      </label>
      <p v-if="problem" class="wb-rf-hint wb-rf-problem">{{ t(`releaseFlow.schedule.problem.${problem}`) }}</p>
    </section>

    <ReleaseTaskPanel v-else-if="phase === 'scheduled' && flow.shutdownRefused.value" :flow="flow" task-id="gm.shutdown" />

    <section v-else-if="phase === 'scheduled'" class="wb-rf-card wb-rf-waiting">
      <div class="wb-rf-group-head">
        <h4>{{ t('releaseFlow.server.scheduledTitle', { window: windowText }) }}</h4>
        <div class="wb-rf-group-tools">
          <button type="button" class="wb-rf-btn is-small" :disabled="busy" @click="flow.cancelSchedule()">{{ t('releaseFlow.server.cancelSchedule') }}</button>
          <button type="button" class="wb-rf-btn is-small" :disabled="busy" :title="t('releaseFlow.server.fastForwardHint')" @click="flow.fastForward()">
            <FlaskConical :size="13" aria-hidden="true" /><FastForward :size="13" aria-hidden="true" />{{ t('releaseFlow.server.fastForward') }}
          </button>
        </div>
      </div>
      <p class="wb-rf-hint">{{ t('releaseFlow.server.autoClose') }}</p>
    </section>

    <ReleaseTaskPanel v-else-if="phase === 'closing'" :flow="flow" task-id="gm.shutdown" />

    <section v-else-if="phase !== 'restored'" class="wb-rf-group">
      <div class="wb-rf-group-head"><h4>{{ t('releaseFlow.server.work') }}</h4></div>
      <ReleaseGmTaskList
        :flow="flow"
        page-id="gmServer"
        :tasks="['gm.restart', 'gm.open']"
        @run="emit('run', $event)"
        @rerun="emit('rerun', $event)"
      />
    </section>

    <p v-if="clientUpdate" class="wb-rf-hint wb-rf-client-line">{{ clientUpdate }}</p>

    <section v-if="events.length" class="wb-rf-group" aria-labelledby="wb-rf-server-events">
      <div class="wb-rf-group-head"><h4 id="wb-rf-server-events">{{ t('releaseFlow.server.events') }}</h4></div>
      <ol class="wb-rf-list wb-rf-server-events">
        <li v-for="(entry, index) in events" :key="index">
          <time>{{ formatClockTime(entry.serverAt || entry.at) }}</time>
          <span>{{ entry.event === 'cancelled' ? t('releaseFlow.server.event.cancelled') : taskTitle(entry.taskId) }}</span>
        </li>
      </ol>
    </section>
  </template>

  <template v-else>
    <section class="wb-rf-server is-live">
      <div class="wb-rf-server-main">
        <span class="wb-rf-server-pill"><span class="wb-rf-server-dot" />{{ t('releaseFlow.server.phase.running') }}</span>
        <strong class="wb-rf-server-title">{{ t('releaseFlow.server.headline.hot') }}</strong>
        <div class="wb-rf-server-meta">
          <span><Users :size="13" aria-hidden="true" />{{ t('releaseFlow.server.players', { count: formatReleaseCount(flow.players.value) }) }}</span>
        </div>
      </div>
    </section>
    <section v-if="clientInRelease" class="wb-rf-card">
      <div class="wb-rf-schedule-fields">
        <label class="wb-rf-field">
          {{ t('releaseFlow.schedule.clientOpen') }}
          <input type="datetime-local" :value="state.schedule.clientOpenAt" :disabled="busy" @change="update('clientOpenAt', $event)" />
        </label>
      </div>
      <p class="wb-rf-hint">{{ clientUpdate }}</p>
    </section>
  </template>
</template>

<style scoped>
.wb-rf-server {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 24px 26px;
  border: 1px solid var(--wb-border);
  border-radius: 14px;
  background: var(--wb-table-surface);
  --wb-rf-server-tone: var(--wb-success-text);
}

.wb-rf-server.is-waiting { --wb-rf-server-tone: var(--wb-warning-text); }
.wb-rf-server.is-down { --wb-rf-server-tone: var(--wb-danger); }

.wb-rf-server-main {
  display: grid;
  flex: 1 1 auto;
  gap: 10px;
  min-width: 0;
}

.wb-rf-server-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-rf-server-tone) 12%, transparent);
  color: var(--wb-rf-server-tone);
  font-size: 12px;
  font-weight: 650;
}

.wb-rf-server-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent);
  animation: wb-rf-pulse 1.8s ease-in-out infinite;
}

.wb-rf-server.is-down .wb-rf-server-dot {
  animation: none;
}

@keyframes wb-rf-pulse {
  50% { box-shadow: 0 0 0 6px color-mix(in srgb, currentColor 8%, transparent); }
}

.wb-rf-server-title {
  font-size: 20px;
  font-weight: 650;
  line-height: 1.3;
}

.wb-rf-server-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  color: var(--wb-secondary-text);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.wb-rf-server-meta span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.wb-rf-server-clock {
  display: grid;
  flex: none;
  justify-items: end;
  gap: 4px;
  padding-left: 24px;
  border-left: 1px solid var(--wb-line);
}

.wb-rf-server-clock span {
  color: var(--wb-secondary-text);
  font-size: 12px;
}

.wb-rf-server-clock strong {
  font-size: 34px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.1;
}

.wb-rf-server-stages {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

.wb-rf-server-stages li {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 6px;
  padding-top: 2px;
  color: var(--wb-quiet-text);
  font-size: 12.5px;
  text-align: center;
}

.wb-rf-server-stages li::before {
  position: absolute;
  top: 7px;
  right: 50%;
  left: -50%;
  height: 2px;
  background: var(--wb-line);
  content: "";
}

.wb-rf-server-stages li:first-child::before {
  display: none;
}

.wb-rf-server-stages li.is-done::before,
.wb-rf-server-stages li.is-current::before {
  background: var(--wb-success-border);
}

.wb-rf-server-stage-dot {
  position: relative;
  z-index: 1;
  width: 14px;
  height: 14px;
  border: 2px solid var(--wb-border-strong);
  border-radius: 999px;
  background: var(--wb-dialog-surface);
}

.wb-rf-server-stages li.is-done .wb-rf-server-stage-dot {
  border-color: var(--wb-success-text);
  background: var(--wb-success-text);
}

.wb-rf-server-stages li.is-current .wb-rf-server-stage-dot {
  border-color: var(--wb-accent);
  box-shadow: 0 0 0 4px var(--wb-accent-soft);
}

.wb-rf-server-stages li.is-done,
.wb-rf-server-stages li.is-current {
  color: var(--wb-text);
}

.wb-rf-server-stages strong {
  font-weight: 600;
}

.wb-rf-server-stages small {
  min-height: 16px;
  color: var(--wb-quiet-text);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.wb-rf-schedule-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.wb-rf-problem {
  color: var(--wb-warning-text);
}

.wb-rf-waiting .wb-rf-btn {
  gap: 4px;
}

.wb-rf-client-line {
  margin-top: -8px;
}

.wb-rf-server-events {
  display: grid;
}

.wb-rf-server-events li {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 32px;
  border-top: 1px solid var(--wb-line);
  font-size: 12.5px;
}

.wb-rf-server-events time {
  width: 64px;
  color: var(--wb-quiet-text);
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .wb-rf-server-dot {
    animation: none;
  }
}
</style>
