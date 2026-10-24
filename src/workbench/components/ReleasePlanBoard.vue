<script setup>
// Phase 1, step 2: each platform's open plan for heroes, mounts, spirits,
// battle pets and features. Notes are read as rules ("10/28 開放",
// "暫不開放"…) and evaluated for the update date; one write then opens or
// closes exactly the rows whose state differs from the plan.
import { computed } from "vue";
import { ArrowDown, ArrowUp, CalendarDays, Check, Info } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { planItemName } from "../utils/releaseFlowDemo.js";
import { addDays, formatPlanDate } from "../utils/releasePlanNotes.js";
import { formatReleaseDate } from "../utils/releaseFlowFormat.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const busy = computed(() => props.flow.busy.value);
const platform = computed(() => props.flow.platform.value);
const locale = computed(() => props.flow.locale.value);
const otherPlatforms = computed(() =>
  state.comparePlatforms ? state.platforms.filter((entry) => entry.id !== platform.value.id) : []);
const groups = computed(() => props.flow.planGroups.value);
const group = computed(() => groups.value.find((entry) => entry.id === state.planCategory) || groups.value[0]);
const counts = computed(() => props.flow.planCounts.value);
const statements = computed(() => props.flow.planSql.value);
const task = computed(() => state.tasks["db.plans"]);
// Rows the last write changed, so they read "opened" / "closed" afterwards.
const written = computed(() => (task.value.status === "done" ? task.value.result?.written || {} : {}));

function rowState(row) {
  if (row.change === "keep" && Object.hasOwn(written.value, row.item.id)) return "written";
  return row.change;
}

function changeCount(entry) {
  return entry.counts.open + entry.counts.close;
}

function ruleText(rule) {
  const date = (iso) => formatPlanDate(iso, state.brief.date);
  if (rule.kind !== "window") return t(`releaseFlow.plan.rule.${rule.kind}`);
  // `to` is the first closed day; people read the last open day.
  const last = rule.to ? date(addDays(rule.to, -1)) : "";
  if (rule.from && last) return t("releaseFlow.plan.rule.range", { from: date(rule.from), to: last });
  if (rule.from) return t("releaseFlow.plan.rule.from", { date: date(rule.from) });
  return t("releaseFlow.plan.rule.until", { date: last });
}

function verdictText(row) {
  const { reason, days } = row.verdict;
  if (reason === "upcoming") return t("releaseFlow.plan.verdict.upcoming", { days });
  return t(`releaseFlow.plan.verdict.${reason}`);
}

function verdictTone(row) {
  if (row.verdict.reason === "unknown") return "is-danger";
  if (row.verdict.reason === "empty") return "is-quiet";
  return row.verdict.state === "open" ? "is-success" : "";
}

function writeText(row) {
  if (rowState(row) === "written") return t(row.current ? "releaseFlow.plan.write.opened" : "releaseFlow.plan.write.closed");
  if (row.change === "skip") return t("releaseFlow.plan.write.skip");
  if (row.change === "keep") return t(row.current ? "releaseFlow.plan.write.keepOpen" : "releaseFlow.plan.write.keepClosed");
  return t(`releaseFlow.plan.write.${row.change}`);
}

function writeTitle(row) {
  const current = row.current ? t("releaseFlow.plan.state.open") : t("releaseFlow.plan.state.closed");
  return t("releaseFlow.plan.write.title", { current, rule: ruleText(row.rule) });
}

function onDateChange(event) {
  props.flow.setDate(event.target.value);
}
</script>

<template>
  <div>
    <ReleasePageHead page-id="dbPlans" />

    <div class="wb-rf-stack">
      <div class="wb-rf-plan-toolbar">
        <label class="wb-rf-plan-date">
          <CalendarDays :size="15" aria-hidden="true" />
          <span>{{ t('releaseFlow.plan.judgeBy') }}</span>
          <input type="date" class="wb-rf-input" :value="state.brief.date" :disabled="busy" @change="onDateChange" />
          <span class="wb-rf-muted">{{ formatReleaseDate(state.brief.date) }}</span>
        </label>
        <label class="wb-rf-check">
          <input type="checkbox" :checked="state.comparePlatforms" @change="flow.setComparePlatforms($event.target.checked)" />
          {{ t('releaseFlow.plan.compare') }}
        </label>
      </div>

      <div class="wb-rf-plan-tabs" role="tablist" :aria-label="t('releaseFlow.plan.categories')">
        <button
          v-for="entry in groups"
          :key="entry.id"
          type="button"
          role="tab"
          :aria-selected="entry.id === group.id"
          :data-plan-category="entry.id"
          @click="flow.setPlanCategory(entry.id)"
        >
          {{ t(`releaseFlow.plan.category.${entry.id}`) }}
          <span v-if="changeCount(entry)" class="wb-rf-plan-badge" :title="t('releaseFlow.plan.badge', { count: changeCount(entry) })">{{ changeCount(entry) }}</span>
        </button>
      </div>

      <p class="wb-rf-hint wb-rf-plan-target">
        <Info :size="13" aria-hidden="true" />
        <span>
          {{ t('releaseFlow.plan.target', { table: group.table, flag: group.flagColumn, key: group.keyColumn }) }}
          · {{ t(group.synced ? 'releaseFlow.plan.synced' : 'releaseFlow.plan.kept') }}
        </span>
      </p>

      <div class="wb-rf-plan-table-wrap" role="tabpanel">
        <table class="wb-rf-table wb-rf-plan-table">
          <thead>
            <tr>
              <th scope="col">{{ t('releaseFlow.plan.column.item') }}</th>
              <th scope="col" class="is-current">{{ t('releaseFlow.plan.column.note', { platform: platform.name }) }}</th>
              <th scope="col">{{ t('releaseFlow.plan.column.verdict') }}</th>
              <th scope="col">{{ t('releaseFlow.plan.column.write') }}</th>
              <th v-for="other in otherPlatforms" :key="other.id" scope="col" class="is-other">{{ other.name }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in group.rows" :key="row.item.id" :class="`is-${rowState(row)}`" :data-plan-item="row.item.id">
              <th scope="row" class="wb-rf-plan-item">
                <strong>{{ planItemName(row.item, locale) }}</strong>
                <span class="wb-rf-code wb-rf-muted">{{ row.item.key }}</span>
              </th>
              <td class="is-current">
                <input
                  class="wb-rf-input wb-rf-plan-note"
                  :value="row.note"
                  :disabled="busy"
                  :placeholder="t('releaseFlow.plan.notePlaceholder')"
                  :aria-label="t('releaseFlow.plan.noteLabel', { item: planItemName(row.item, locale), platform: platform.name })"
                  @input="flow.setNote(row.item.id, platform.id, $event.target.value)"
                />
              </td>
              <td>
                <span class="wb-rf-chip" :class="verdictTone(row)" :title="ruleText(row.rule)">{{ verdictText(row) }}</span>
              </td>
              <td>
                <span class="wb-rf-plan-write" :class="`is-${rowState(row)}`" :title="writeTitle(row)">
                  <ArrowUp v-if="row.change === 'open'" :size="13" aria-hidden="true" />
                  <ArrowDown v-else-if="row.change === 'close'" :size="13" aria-hidden="true" />
                  <Check v-else-if="rowState(row) === 'written'" :size="13" aria-hidden="true" />
                  {{ writeText(row) }}
                </span>
              </td>
              <td v-for="other in otherPlatforms" :key="other.id" class="is-other">
                <input
                  class="wb-rf-input wb-rf-plan-note is-other"
                  :value="flow.noteFor(row.item, other.id)"
                  :disabled="busy"
                  :aria-label="t('releaseFlow.plan.noteLabel', { item: planItemName(row.item, locale), platform: other.name })"
                  @input="flow.setNote(row.item.id, other.id, $event.target.value)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="wb-rf-plan-summary">
        <div class="wb-rf-stats">
          <div class="wb-rf-stat is-success"><strong>{{ counts.open }}</strong><span>{{ t('releaseFlow.plan.count.open') }}</span></div>
          <div class="wb-rf-stat is-warning"><strong>{{ counts.close }}</strong><span>{{ t('releaseFlow.plan.count.close') }}</span></div>
          <div class="wb-rf-stat is-muted"><strong>{{ counts.keep }}</strong><span>{{ t('releaseFlow.plan.count.keep') }}</span></div>
          <div v-if="counts.skip" class="wb-rf-stat is-muted"><strong>{{ counts.skip }}</strong><span>{{ t('releaseFlow.plan.count.skip') }}</span></div>
        </div>
        <details v-if="statements.length" class="wb-rf-plan-sql">
          <summary>{{ t('releaseFlow.plan.sql', { count: statements.length }) }}</summary>
          <pre class="wb-rf-log">{{ statements.join('\n') }}</pre>
        </details>
      </div>

      <p class="wb-rf-hint">{{ t('releaseFlow.plan.syntax') }}</p>

      <ReleaseTaskPanel :flow="flow" task-id="db.plans">
        <template #done="{ result }">
          <strong>{{ result.statements ? t('releaseFlow.plan.done', { open: result.open, close: result.close }) : t('releaseFlow.plan.doneNone') }}</strong>
        </template>
      </ReleaseTaskPanel>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-plan-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 20px;
}

.wb-rf-plan-date {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--wb-secondary-text);
  font-size: 12.5px;
}

.wb-rf-plan-date input {
  width: 150px;
}

.wb-rf-plan-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  border-bottom: 1px solid var(--wb-line);
}

.wb-rf-plan-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  margin-bottom: -1px;
  padding: 0 14px;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--wb-secondary-text);
  font-size: 13px;
}

.wb-rf-plan-tabs button:hover:not(:disabled) {
  border: none;
  border-bottom: 2px solid var(--wb-border-strong);
  background: transparent;
  color: var(--wb-text);
}

.wb-rf-plan-tabs button[aria-selected="true"] {
  border-bottom-color: var(--wb-accent);
  color: var(--wb-text);
  font-weight: 650;
}

.wb-rf-plan-badge {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--wb-warning-surface);
  color: var(--wb-warning-text);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  line-height: 17px;
  text-align: center;
}

.wb-rf-plan-target {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: -6px;
}

.wb-rf-plan-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-table-surface);
}

.wb-rf-plan-table th:first-child,
.wb-rf-plan-table td:first-child {
  padding-left: 14px;
}

.wb-rf-plan-item {
  min-width: 150px;
  font-weight: 400;
  text-align: left;
  white-space: nowrap;
}

.wb-rf-plan-item strong {
  margin-right: 8px;
  font-size: 13px;
  font-weight: 600;
}

.wb-rf-plan-table tbody tr.is-open .wb-rf-plan-item,
.wb-rf-plan-table tbody tr.is-written .wb-rf-plan-item {
  box-shadow: inset 3px 0 0 var(--wb-success-border);
}

.wb-rf-plan-table tbody tr.is-close .wb-rf-plan-item {
  box-shadow: inset 3px 0 0 var(--wb-warning-border);
}

.wb-rf-plan-note {
  width: 100%;
  min-width: 150px;
  height: 28px;
}

.wb-rf-plan-note.is-other {
  min-width: 120px;
  border-color: var(--wb-border);
  background: transparent;
  color: var(--wb-secondary-text);
}

th.is-other,
td.is-other {
  background: color-mix(in srgb, var(--wb-pane-header) 40%, transparent);
}

.wb-rf-plan-write {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--wb-quiet-text);
  font-size: 12.5px;
  white-space: nowrap;
}

.wb-rf-plan-write.is-open {
  color: var(--wb-success-text);
  font-weight: 650;
}

.wb-rf-plan-write.is-close {
  color: var(--wb-warning-text);
  font-weight: 650;
}

.wb-rf-plan-write.is-written {
  color: var(--wb-success-text);
}

.wb-rf-plan-summary {
  display: grid;
  gap: 10px;
}

.wb-rf-plan-sql summary {
  width: fit-content;
  color: var(--wb-accent);
  font-size: 12px;
  cursor: pointer;
}

.wb-rf-plan-sql .wb-rf-log {
  margin-top: 8px;
}
</style>
