<script setup>
// Open plans, a tool beside the release steps: every platform's note for each
// hero, mount, spirit, battle pet and feature, read as a rule and judged for
// a chosen day. Looking at another day here never changes the release; the
// database step writes the release platform's plan for the update day.
import { computed, ref } from "vue";
import { t } from "../i18n/index.js";
import { RELEASE_PLAN_CATEGORIES, RELEASE_PLAN_ITEMS, planItemKeyLabel } from "../utils/releaseFlowDemo.js";
import { evaluatePlanRule, parsePlanNote } from "../utils/releasePlanNotes.js";
import { formatReleaseWeekday } from "../utils/releaseFlowFormat.js";
import ReleasePageHead from "./ReleasePageHead.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const busy = computed(() => props.flow.busy.value);
const viewDate = ref(state.brief.date);
const releasePlatform = computed(() => props.flow.platform.value.id);
const category = computed(() => RELEASE_PLAN_CATEGORIES.find((entry) => entry.id === state.planCategory) || RELEASE_PLAN_CATEGORIES[0]);
const items = computed(() => RELEASE_PLAN_ITEMS.filter((item) => item.category === category.value.id));
const categoryCounts = computed(() => Object.fromEntries(RELEASE_PLAN_CATEGORIES.map((entry) => [
  entry.id,
  RELEASE_PLAN_ITEMS.filter((item) => item.category === entry.id).length,
])));

function verdict(item, platformId) {
  const note = props.flow.noteFor(item, platformId);
  const result = evaluatePlanRule(parsePlanNote(note, viewDate.value), viewDate.value);
  if (result.reason === "upcoming") return { tone: "is-later", text: t("releaseFlow.plan.cell.upcoming", { days: result.days }) };
  if (result.state === "open") return { tone: "is-open", text: t("releaseFlow.plan.cell.open") };
  if (result.state === "closed") return { tone: "is-closed", text: t(result.reason === "ended" ? "releaseFlow.plan.cell.ended" : "releaseFlow.plan.cell.closed") };
  return result.reason === "unknown"
    ? { tone: "is-unknown", text: t("releaseFlow.plan.cell.unknown") }
    : { tone: "is-empty", text: "—" };
}

function onDateChange(event) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) viewDate.value = event.target.value;
}
</script>

<template>
  <ReleasePageHead page-id="plans" />

  <div class="wb-rf-plan-toolbar">
    <div class="wb-rf-segmented" role="tablist" :aria-label="t('releaseFlow.plan.categories')">
      <button
        v-for="entry in RELEASE_PLAN_CATEGORIES"
        :key="entry.id"
        type="button"
        role="tab"
        :aria-selected="entry.id === category.id"
        :data-plan-category="entry.id"
        @click="flow.setPlanCategory(entry.id)"
      >
        {{ t(`releaseFlow.plan.category.${entry.id}`) }}
        <span class="wb-rf-count">{{ categoryCounts[entry.id] }}</span>
      </button>
    </div>
    <label class="wb-rf-plan-date">
      <span>{{ t('releaseFlow.plan.viewDate') }}</span>
      <input type="date" class="wb-rf-input" :value="viewDate" @change="onDateChange" />
      <button v-if="viewDate !== state.brief.date" type="button" class="wb-rf-link" @click="viewDate = state.brief.date">
        {{ t('releaseFlow.plan.backToRelease') }}
      </button>
      <span v-else class="wb-rf-muted">{{ formatReleaseWeekday(viewDate) }}</span>
    </label>
  </div>

  <div class="wb-rf-plan-matrix" role="tabpanel">
    <table class="wb-rf-table">
      <thead>
        <tr>
          <th scope="col" class="wb-rf-plan-item-col">{{ t('releaseFlow.plan.column.item') }}</th>
          <th v-for="platform in state.platforms" :key="platform.id" scope="col" :class="{ 'is-release': platform.id === releasePlatform }">
            {{ platform.name }}
            <span v-if="platform.id === releasePlatform" class="wb-rf-plan-release">{{ t('releaseFlow.plan.thisRelease') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.id" :data-plan-item="item.id">
          <th scope="row">
            <strong>{{ item.name }}</strong>
            <span class="wb-rf-code wb-rf-muted">{{ planItemKeyLabel(item) }}</span>
          </th>
          <td v-for="platform in state.platforms" :key="platform.id" :class="{ 'is-release': platform.id === releasePlatform }">
            <div class="wb-rf-plan-cell">
              <input
                class="wb-rf-plan-note"
                :value="flow.noteFor(item, platform.id)"
                :disabled="busy"
                :placeholder="t('releaseFlow.plan.notePlaceholder')"
                :aria-label="t('releaseFlow.plan.noteLabel', { item: item.name, platform: platform.name })"
                @input="flow.setNote(item.id, platform.id, $event.target.value)"
              />
              <span class="wb-rf-plan-verdict" :class="verdict(item, platform.id).tone">{{ verdict(item, platform.id).text }}</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <p class="wb-rf-hint wb-rf-plan-foot">
    <span>{{ t('releaseFlow.plan.target', { table: category.table, flag: category.flagColumn, key: category.keyColumns.join(', ') }) }}</span>
    <span>{{ t('releaseFlow.plan.syntax') }}</span>
  </p>
</template>

<style scoped>
.wb-rf-plan-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
}

.wb-rf-plan-toolbar .wb-rf-count {
  margin-left: 2px;
}

.wb-rf-plan-date {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--wb-secondary-text);
  font-size: 12.5px;
}

.wb-rf-plan-date input {
  width: 160px;
}

.wb-rf-plan-matrix {
  overflow-x: auto;
  border: 1px solid var(--wb-border);
  border-radius: 12px;
  background: var(--wb-table-surface);
}

/* Fixed columns share the width evenly, so the release platform's column
   stays in view; narrower windows scroll the matrix instead. */
.wb-rf-plan-matrix table {
  min-width: 760px;
  table-layout: fixed;
}

.wb-rf-plan-matrix th:first-child,
.wb-rf-plan-matrix td:first-child {
  padding-left: 18px;
}

.wb-rf-plan-item-col {
  width: 200px;
}

.wb-rf-plan-matrix tbody th {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-plan-matrix tbody th strong {
  margin-right: 8px;
  font-size: 13px;
  font-weight: 600;
}

.wb-rf-plan-matrix .is-release {
  background: color-mix(in srgb, var(--wb-accent) 5%, transparent);
}

.wb-rf-plan-release {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--wb-accent-control);
  color: var(--wb-accent-control-text);
  font-size: 10.5px;
  font-weight: 650;
}

.wb-rf-plan-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wb-rf-plan-note {
  flex: 1 1 auto;
  width: 0;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--wb-text);
  font-size: 13px;
  box-shadow: none;
}

.wb-rf-plan-note:hover:not(:disabled) {
  border-color: var(--wb-border);
}

.wb-rf-plan-note:focus {
  border-color: var(--wb-accent);
  background: var(--wb-cell-editor);
}

.wb-rf-plan-verdict {
  flex: none;
  min-width: 52px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
}

.wb-rf-plan-verdict.is-open {
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}

.wb-rf-plan-verdict.is-closed,
.wb-rf-plan-verdict.is-empty {
  color: var(--wb-quiet-text);
}

.wb-rf-plan-verdict.is-later {
  background: var(--wb-accent-soft);
  color: var(--wb-text);
}

.wb-rf-plan-verdict.is-unknown {
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
}

.wb-rf-plan-foot {
  display: grid;
  gap: 2px;
}
</style>
