<script setup>
// The one-click panel of the brief: the rules for the problems a run can
// meet (shared by every platform). With the
// rules set, "One-click run" in the footer takes the update to the end by
// itself and only stops where a rule says so.
import { computed, ref } from "vue";
import { ChevronDown, Zap } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { AUTOPILOT_GROUPS, AUTOPILOT_RETRIES, AUTOPILOT_RETRY_DELAYS, AUTOPILOT_RULES } from "../releaseAutopilotState.js";
import { autopilotRuleSummary } from "../utils/releaseFlowFormat.js";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, required: true },
});

const state = props.flow.state;
const rules = computed(() => props.workspace.state.autopilot);
const open = ref(!state.brief.started);
const groups = computed(() => AUTOPILOT_GROUPS.map((group) => ({
  id: group,
  rules: AUTOPILOT_RULES.filter((rule) => rule.group === group),
})));
const summary = computed(() => autopilotRuleSummary(rules.value));

function set(ruleId, value) {
  props.workspace.setAutopilotRule(ruleId, value);
}
</script>

<template>
  <section class="wb-rf-group wb-rf-auto-panel" aria-labelledby="wb-rf-auto-title" data-release-autopilot-panel>
    <div class="wb-rf-group-head">
      <Zap :size="15" class="wb-rf-muted" aria-hidden="true" />
      <h4 id="wb-rf-auto-title">{{ t('releaseFlow.autopilot.title') }}</h4>
      <span class="wb-rf-count">{{ t('releaseFlow.autopilot.shared') }}</span>
      <div class="wb-rf-group-tools">
        <button v-if="open" type="button" class="wb-rf-link" @click="workspace.resetAutopilotRules()">{{ t('releaseFlow.autopilot.reset') }}</button>
        <button type="button" class="wb-rf-link" :aria-expanded="open" aria-controls="wb-rf-auto-body" @click="open = !open">
          {{ t(open ? 'releaseFlow.autopilot.collapse' : 'releaseFlow.autopilot.expand') }}
          <ChevronDown :size="13" class="wb-rf-auto-chevron" :class="{ 'is-open': open }" aria-hidden="true" />
        </button>
      </div>
    </div>
    <ul v-if="!open" class="wb-rf-list wb-rf-auto-summary">
      <li v-for="line in summary" :key="line">{{ line }}</li>
    </ul>

    <div v-else id="wb-rf-auto-body" class="wb-rf-auto-body">
      <div v-for="group in groups" :key="group.id" class="wb-rf-auto-group">
        <h5>{{ t(`releaseFlow.autopilot.group.${group.id}`) }}</h5>
        <div v-for="rule in group.rules" :key="rule.id" class="wb-rf-auto-rule" :data-release-rule="rule.id">
          <span :id="`wb-rf-rule-${rule.id}`">{{ t(`releaseFlow.autopilot.rule.${rule.id}`) }}</span>
          <div class="wb-rf-segmented is-small" role="radiogroup" :aria-labelledby="`wb-rf-rule-${rule.id}`">
            <button
              v-for="choice in rule.choices"
              :key="choice"
              type="button"
              role="radio"
              :aria-checked="rules[rule.id] === choice"
              @click="set(rule.id, choice)"
            >{{ t(`releaseFlow.autopilot.choice.${rule.id}.${choice}`) }}</button>
          </div>
        </div>
      </div>

      <div class="wb-rf-auto-group">
        <h5>{{ t('releaseFlow.autopilot.group.failures') }}</h5>
        <div class="wb-rf-auto-rule">
          <span id="wb-rf-rule-retries">{{ t('releaseFlow.autopilot.retries') }}</span>
          <div class="wb-rf-segmented is-small" role="radiogroup" aria-labelledby="wb-rf-rule-retries">
            <button
              v-for="count in AUTOPILOT_RETRIES"
              :key="count"
              type="button"
              role="radio"
              :aria-checked="rules.retries === count"
              @click="set('retries', count)"
            >{{ t('releaseFlow.autopilot.retryCount', { count }) }}</button>
          </div>
        </div>
        <div class="wb-rf-auto-rule">
          <span id="wb-rf-rule-delay">{{ t('releaseFlow.autopilot.retryDelay') }}</span>
          <div class="wb-rf-segmented is-small" role="radiogroup" aria-labelledby="wb-rf-rule-delay">
            <button
              v-for="seconds in AUTOPILOT_RETRY_DELAYS"
              :key="seconds"
              type="button"
              role="radio"
              :aria-checked="rules.retryDelay === seconds"
              :disabled="!rules.retries"
              @click="set('retryDelay', seconds)"
            >{{ t('releaseFlow.autopilot.seconds', { seconds }) }}</button>
          </div>
        </div>
        <p class="wb-rf-hint">{{ t('releaseFlow.autopilot.alwaysStops') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wb-rf-auto-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
}

.wb-rf-auto-summary li {
  padding: 3px 10px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-body);
}

.wb-rf-auto-body {
  display: grid;
  gap: 16px;
}

.wb-rf-auto-body h5 {
  margin: 0;
  font-size: var(--wb-fs-body);
  font-weight: 650;
}

.wb-rf-auto-group {
  display: grid;
  gap: 2px;
}

.wb-rf-auto-group > h5 {
  margin-bottom: 4px;
  color: var(--wb-secondary-text);
}

.wb-rf-auto-rule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 16px;
  min-height: 38px;
  border-top: 1px solid var(--wb-line);
  font-size: var(--wb-fs-body);
}

.wb-rf-auto-chevron {
  transition: transform 0.15s ease;
}

.wb-rf-auto-chevron.is-open {
  transform: rotate(180deg);
}

@media (prefers-reduced-motion: reduce) {
  .wb-rf-auto-chevron {
    transition: none;
  }
}
</style>
