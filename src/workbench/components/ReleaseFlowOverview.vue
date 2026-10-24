<script setup>
// First page: which platform, which day, maintenance or not, and what this
// release contains. The step rail adapts to these answers right away.
import { computed, ref } from "vue";
import { CalendarDays, Check, Database, FolderOpen, Gift, MonitorSmartphone, Pencil, Server } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_MODES, RELEASE_SCOPES, localDateIso } from "../releaseFlowState.js";
import { addDays } from "../utils/releasePlanNotes.js";
import { formatReleaseDate } from "../utils/releaseFlowFormat.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleasePlatformEditor from "./ReleasePlatformEditor.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const editing = ref(false);
const busy = computed(() => props.flow.busy.value);
const started = computed(() => state.brief.started);
const today = localDateIso();
const SCOPE_ICONS = { database: Database, client: MonitorSmartphone, server: Server, activity: Gift };

const dateLabel = computed(() => formatReleaseDate(state.brief.date));
const relativeDay = computed(() => {
  if (state.brief.date === today) return t("releaseFlow.overview.today");
  if (state.brief.date === addDays(today, 1)) return t("releaseFlow.overview.tomorrow");
  return "";
});

function scopeDisabled(scope) {
  return busy.value || (scope === "server" && state.brief.mode === "hot");
}

function onDateInput(event) {
  props.flow.setDate(event.target.value);
}
</script>

<template>
  <div class="wb-rf-overview">
    <ReleasePageHead page-id="overview" :eyebrow="t('releaseFlow.overview.eyebrow')" />

    <div class="wb-rf-stack">
      <section class="wb-rf-section" aria-labelledby="wb-rf-platform-title">
        <div class="wb-rf-section-head">
          <h4 id="wb-rf-platform-title">{{ t('releaseFlow.overview.platform') }}</h4>
          <div class="wb-rf-section-tools">
            <button type="button" class="wb-rf-link" :aria-expanded="editing" :disabled="busy" @click="editing = !editing">
              <Pencil :size="12" aria-hidden="true" /> {{ t(editing ? 'releaseFlow.overview.editDone' : 'releaseFlow.overview.edit') }}
            </button>
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
            @click="flow.setPlatform(platform.id)"
          >
            <span class="wb-rf-platform-name">
              <strong>{{ platform.name }}</strong>
              <Check v-if="platform.id === state.brief.platformId" :size="14" aria-hidden="true" />
            </span>
            <span class="wb-rf-platform-line"><Database :size="12" aria-hidden="true" />{{ platform.targetDatabase }}</span>
            <span class="wb-rf-platform-line"><FolderOpen :size="12" aria-hidden="true" />{{ platform.targetClient }}</span>
          </button>
        </div>
        <p v-if="started" class="wb-rf-hint">{{ t('releaseFlow.overview.platformLocked') }}</p>
        <ReleasePlatformEditor v-if="editing" :flow="flow" :platform="flow.platform.value" />
      </section>

      <div class="wb-rf-overview-row">
        <section class="wb-rf-section" aria-labelledby="wb-rf-date-title">
          <div class="wb-rf-section-head">
            <h4 id="wb-rf-date-title">{{ t('releaseFlow.overview.date') }}</h4>
          </div>
          <div class="wb-rf-date">
            <CalendarDays :size="16" aria-hidden="true" />
            <input
              type="date"
              class="wb-rf-input"
              :value="state.brief.date"
              :disabled="busy"
              :aria-label="t('releaseFlow.overview.date')"
              @change="onDateInput"
            />
            <span class="wb-rf-date-label">{{ dateLabel }}<em v-if="relativeDay">{{ relativeDay }}</em></span>
          </div>
          <p class="wb-rf-hint">{{ t('releaseFlow.overview.dateHint') }}</p>
        </section>

        <section class="wb-rf-section" aria-labelledby="wb-rf-mode-title">
          <div class="wb-rf-section-head">
            <h4 id="wb-rf-mode-title">{{ t('releaseFlow.overview.mode') }}</h4>
          </div>
          <div class="wb-rf-segmented" role="radiogroup" :aria-labelledby="'wb-rf-mode-title'">
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

      <section class="wb-rf-section" aria-labelledby="wb-rf-scope-title">
        <div class="wb-rf-section-head">
          <h4 id="wb-rf-scope-title">{{ t('releaseFlow.overview.scope') }}</h4>
          <span class="wb-rf-muted">{{ t('releaseFlow.overview.scopeHint') }}</span>
        </div>
        <div class="wb-rf-scopes">
          <label
            v-for="scope in RELEASE_SCOPES"
            :key="scope"
            class="wb-rf-scope"
            :class="{ 'is-on': state.brief.scope[scope], 'is-disabled': scopeDisabled(scope) }"
          >
            <input
              type="checkbox"
              :checked="state.brief.scope[scope]"
              :disabled="scopeDisabled(scope)"
              @change="flow.setScope(scope, $event.target.checked)"
            />
            <component :is="SCOPE_ICONS[scope]" :size="16" aria-hidden="true" class="wb-rf-scope-icon" />
            <span class="wb-rf-scope-text">
              <strong>{{ t(`releaseFlow.scope.${scope}`) }}</strong>
              <small>{{ scope === 'server' && state.brief.mode === 'hot' ? t('releaseFlow.scope.serverHot') : t(`releaseFlow.scope.${scope}.hint`) }}</small>
            </span>
          </label>
        </div>
      </section>

      <label class="wb-rf-prepared" :class="{ 'is-on': state.brief.prepared }">
        <input type="checkbox" :checked="state.brief.prepared" :disabled="started" @change="flow.setPrepared($event.target.checked)" />
        <span>
          <strong>{{ t('releaseFlow.overview.prepared') }}</strong>
          <small>{{ t('releaseFlow.overview.preparedHint') }}</small>
        </span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-platforms {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.wb-rf-platform {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-field-surface);
  color: var(--wb-secondary-text);
  font-size: 12px;
  font-weight: 400;
  text-align: left;
}

.wb-rf-platform[aria-checked="true"] {
  border-color: color-mix(in srgb, var(--wb-accent) 60%, transparent);
  background: var(--wb-accent-soft);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--wb-accent) 35%, transparent);
}

.wb-rf-platform-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--wb-text);
  font-size: 14px;
}

.wb-rf-platform-name svg {
  color: var(--wb-accent);
}

.wb-rf-platform-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  font-family: var(--wb-font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-overview-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}

.wb-rf-date {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--wb-secondary-text);
}

.wb-rf-date input {
  width: 160px;
}

.wb-rf-date-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--wb-text);
  font-size: 13px;
}

.wb-rf-date-label em {
  padding: 0 6px;
  border-radius: 4px;
  background: var(--wb-accent-soft);
  color: var(--wb-text);
  font-size: 11px;
  font-style: normal;
  line-height: 18px;
}

.wb-rf-scopes {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.wb-rf-scope {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-field-surface);
  cursor: pointer;
}

.wb-rf-scope.is-on {
  border-color: color-mix(in srgb, var(--wb-accent) 45%, transparent);
  background: var(--wb-accent-soft);
}

.wb-rf-scope.is-disabled {
  opacity: 0.6;
  cursor: default;
}

.wb-rf-scope input {
  margin: 2px 0 0;
  accent-color: var(--wb-accent);
}

.wb-rf-scope-icon {
  margin-top: 1px;
  color: var(--wb-secondary-text);
}

.wb-rf-scope-text {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.wb-rf-scope-text strong {
  font-size: 13px;
  font-weight: 600;
}

.wb-rf-scope-text small,
.wb-rf-prepared small {
  color: var(--wb-secondary-text);
  font-size: 11.5px;
  line-height: 1.5;
}

.wb-rf-prepared {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 16px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: 10px;
  cursor: pointer;
}

.wb-rf-prepared.is-on {
  border-style: solid;
  border-color: var(--wb-success-border);
  background: var(--wb-success-surface);
}

.wb-rf-prepared input {
  margin: 2px 0 0;
  accent-color: var(--wb-accent);
}

.wb-rf-prepared span {
  display: grid;
  gap: 3px;
}

.wb-rf-prepared strong {
  font-size: 13px;
  font-weight: 600;
}

@media (max-width: 1180px) {
  .wb-rf-scopes {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
