<script setup>
// First page: which platform, which day, maintenance or not, and what this
// release contains. The step rail adapts to these answers right away.
import { computed } from "vue";
import { Check, Database, Gift, MonitorSmartphone, Server } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_MODES, RELEASE_SCOPES, localDateIso } from "../releaseFlowState.js";
import { addDays } from "../utils/releasePlanNotes.js";
import { formatReleaseWeekday } from "../utils/releaseFlowFormat.js";
import ReleasePageHead from "./ReleasePageHead.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const busy = computed(() => props.flow.busy.value);
const started = computed(() => state.brief.started);
const today = localDateIso();
const SCOPE_ICONS = { database: Database, client: MonitorSmartphone, server: Server, activity: Gift };

const relativeDay = computed(() => {
  if (state.brief.date === today) return t("releaseFlow.overview.today");
  if (state.brief.date === addDays(today, 1)) return t("releaseFlow.overview.tomorrow");
  return "";
});

function scopeDisabled(scope) {
  return busy.value || (scope === "server" && state.brief.mode === "hot");
}
</script>

<template>
  <ReleasePageHead page-id="overview" />

  <section class="wb-rf-group" aria-labelledby="wb-rf-platform-title">
    <div class="wb-rf-group-head">
      <h4 id="wb-rf-platform-title">{{ t('releaseFlow.overview.platform') }}</h4>
      <div class="wb-rf-group-tools">
        <button type="button" class="wb-rf-link" @click="emit('navigate', 'platforms')">{{ t('releaseFlow.overview.platformSettings') }}</button>
      </div>
    </div>
    <div class="wb-rf-platforms" role="radiogroup" :aria-label="t('releaseFlow.overview.platform')">
      <button
        v-for="platform in state.platforms"
        :key="platform.id"
        type="button"
        role="radio"
        class="wb-rf-platform"
        :aria-checked="platform.id === state.brief.platformId"
        :disabled="busy || (started && platform.id !== state.brief.platformId)"
        :title="started && platform.id !== state.brief.platformId ? t('releaseFlow.overview.platformLocked') : undefined"
        @click="flow.setPlatform(platform.id)"
      >
        <span class="wb-rf-platform-name">
          <strong>{{ platform.name }}</strong>
          <Check v-if="platform.id === state.brief.platformId" :size="15" aria-hidden="true" />
        </span>
        <span class="wb-rf-code wb-rf-muted">{{ platform.targetDatabase }}</span>
      </button>
    </div>
  </section>

  <div class="wb-rf-overview-row">
    <section class="wb-rf-group" aria-labelledby="wb-rf-date-title">
      <div class="wb-rf-group-head"><h4 id="wb-rf-date-title">{{ t('releaseFlow.overview.date') }}</h4></div>
      <div class="wb-rf-date">
        <input
          type="date"
          class="wb-rf-input"
          :value="state.brief.date"
          :disabled="busy"
          :aria-label="t('releaseFlow.overview.date')"
          @change="flow.setDate($event.target.value)"
        />
        <span>{{ formatReleaseWeekday(state.brief.date) }}</span>
        <span v-if="relativeDay" class="wb-rf-chip is-accent">{{ relativeDay }}</span>
      </div>
    </section>

    <section class="wb-rf-group" aria-labelledby="wb-rf-mode-title">
      <div class="wb-rf-group-head"><h4 id="wb-rf-mode-title">{{ t('releaseFlow.overview.mode') }}</h4></div>
      <div class="wb-rf-segmented" role="radiogroup" aria-labelledby="wb-rf-mode-title">
        <button
          v-for="mode in RELEASE_MODES"
          :key="mode"
          type="button"
          role="radio"
          :aria-checked="state.brief.mode === mode"
          :disabled="busy"
          @click="flow.setMode(mode)"
        >{{ t(`releaseFlow.mode.${mode}`) }}</button>
      </div>
      <p class="wb-rf-hint">{{ t(`releaseFlow.overview.modeHint.${state.brief.mode}`) }}</p>
    </section>
  </div>

  <section class="wb-rf-group" aria-labelledby="wb-rf-scope-title">
    <div class="wb-rf-group-head"><h4 id="wb-rf-scope-title">{{ t('releaseFlow.overview.scope') }}</h4></div>
    <div class="wb-rf-scopes">
      <button
        v-for="scope in RELEASE_SCOPES"
        :key="scope"
        type="button"
        class="wb-rf-scope"
        :aria-pressed="state.brief.scope[scope]"
        :disabled="scopeDisabled(scope)"
        :title="scope === 'server' && state.brief.mode === 'hot' ? t('releaseFlow.scope.serverHot') : undefined"
        @click="flow.setScope(scope, !state.brief.scope[scope])"
      >
        <component :is="SCOPE_ICONS[scope]" :size="17" aria-hidden="true" />
        <span>{{ t(`releaseFlow.scope.${scope}`) }}</span>
        <Check v-if="state.brief.scope[scope]" :size="14" class="wb-rf-scope-check" aria-hidden="true" />
      </button>
    </div>
  </section>

  <label class="wb-rf-ready" :class="{ 'is-on': state.brief.prepared }">
    <input type="checkbox" :checked="state.brief.prepared" :disabled="started" @change="flow.setPrepared($event.target.checked)" />
    <span>{{ t('releaseFlow.overview.prepared') }}</span>
  </label>
</template>

<style scoped>
.wb-rf-platforms {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.wb-rf-platform {
  display: grid;
  gap: 6px;
  height: auto;
  min-height: 0;
  padding: 16px 18px;
  border: 1px solid var(--wb-border);
  border-radius: 12px;
  background: var(--wb-table-surface);
  font-weight: 400;
  text-align: left;
}

.wb-rf-platform:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--wb-accent) 45%, var(--wb-border));
  background: var(--wb-table-surface);
}

.wb-rf-platform[aria-checked="true"] {
  border-color: color-mix(in srgb, var(--wb-accent) 65%, transparent);
  box-shadow: 0 0 0 3px var(--wb-accent-soft);
}

.wb-rf-platform-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--wb-text);
}

.wb-rf-platform-name strong {
  font-size: 16px;
  font-weight: 650;
}

.wb-rf-platform-name svg {
  color: var(--wb-accent);
}

.wb-rf-overview-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 32px;
}

.wb-rf-date {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}

.wb-rf-date input {
  width: 170px;
}

.wb-rf-scopes {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.wb-rf-scope {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  min-height: 40px;
  padding: 0 16px;
  border: 1px solid var(--wb-border-strong);
  border-radius: 10px;
  background: var(--wb-table-surface);
  color: var(--wb-secondary-text);
  font-size: 13px;
  font-weight: 550;
}

.wb-rf-scope[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--wb-accent) 60%, transparent);
  background: var(--wb-accent-soft);
  color: var(--wb-text);
}

.wb-rf-scope-check {
  color: var(--wb-accent);
}

.wb-rf-ready {
  display: flex;
  align-items: center;
  gap: 10px;
  width: fit-content;
  padding: 12px 16px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
}

.wb-rf-ready.is-on {
  border-style: solid;
  border-color: var(--wb-success-border);
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}

.wb-rf-ready input {
  margin: 0;
  accent-color: var(--wb-accent);
}

@media (max-width: 1180px) {
  .wb-rf-platforms {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
