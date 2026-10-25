<script setup>
// Phase 1: overwrite the platform database with the development one, then
// apply the platform's open plan to it. The plan itself is edited in the
// open-plans tool; this page only writes what the plan says for this day.
import { computed, ref } from "vue";
import { ArrowDown, ArrowRight, ArrowUp, Database, Plus } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { DEMO_PLAN_TABLES, planItemKeyLabel } from "../utils/releaseFlowDemo.js";
import { formatPlanDate } from "../utils/releasePlanNotes.js";
import { formatReleaseCount } from "../utils/releaseFlowFormat.js";
import ReleaseChipList from "./ReleaseChipList.vue";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseStatusIcon from "./ReleaseStatusIcon.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  exclusionTemplates: { type: Array, default: () => [] },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const platform = computed(() => props.flow.platform.value);
const plan = computed(() => props.flow.syncPlan.value);
const excluded = computed(() => props.flow.syncExclusions.value);
const busy = computed(() => props.flow.busy.value);
const draft = ref("");
const planTablesKept = computed(() => DEMO_PLAN_TABLES.every((table) => excluded.value.includes(table)));
const addable = computed(() => plan.value.catalog.filter((name) => !excluded.value.includes(name)));
const templates = computed(() => props.exclusionTemplates.filter((template) => template?.tables?.length));

const groups = computed(() => props.flow.planGroups.value);
const counts = computed(() => props.flow.planCounts.value);
const changes = computed(() => groups.value.flatMap((group) => group.rows
  .filter((row) => row.change === "open" || row.change === "close")
  .map((row) => ({ ...row, category: group.id }))));
const unreadable = computed(() => groups.value.flatMap((group) => group.rows.filter((row) => row.change === "skip")));
const statements = computed(() => props.flow.planSql.value);

function status(taskId) {
  const value = state.tasks[taskId].status;
  return value === "idle" ? "pending" : value;
}

function addDraft() {
  const name = draft.value.trim();
  if (!name) return;
  props.flow.setSyncExclusions([...excluded.value, name]);
  draft.value = "";
}

function remove(name) {
  props.flow.setSyncExclusions(excluded.value.filter((table) => table !== name));
}

function togglePlanTables() {
  const rest = excluded.value.filter((table) => !DEMO_PLAN_TABLES.includes(table));
  props.flow.setSyncExclusions(planTablesKept.value ? rest : [...rest, ...DEMO_PLAN_TABLES]);
}
</script>

<template>
  <ReleasePageHead page-id="database" />

  <div class="wb-rf-route">
    <div class="wb-rf-route-node">
      <span><Database :size="13" aria-hidden="true" />{{ t('releaseFlow.database.source') }}</span>
      <strong class="wb-rf-code">{{ platform.sourceDatabase }}</strong>
    </div>
    <span class="wb-rf-route-arrow" aria-hidden="true"><ArrowRight :size="18" /></span>
    <div class="wb-rf-route-node is-target">
      <span><Database :size="13" aria-hidden="true" />{{ t('releaseFlow.database.target', { platform: platform.name }) }}</span>
      <strong class="wb-rf-code">{{ platform.targetDatabase }}</strong>
    </div>
  </div>

  <section class="wb-rf-card" aria-labelledby="wb-rf-db-sync">
    <div class="wb-rf-group-head">
      <ReleaseStatusIcon :status="status('db.sync')" :size="16" />
      <h4 id="wb-rf-db-sync">{{ t('releaseFlow.database.sync') }}</h4>
    </div>
    <div class="wb-rf-stats">
      <div class="wb-rf-stat"><strong>{{ formatReleaseCount(plan.tables.length) }}</strong><span>{{ t('releaseFlow.database.tables') }}</span></div>
      <div class="wb-rf-stat"><strong>{{ formatReleaseCount(plan.rows) }}</strong><span>{{ t('releaseFlow.database.rows') }}</span></div>
      <div class="wb-rf-stat is-muted"><strong>{{ plan.excluded.length }}</strong><span>{{ t('releaseFlow.database.kept') }}</span></div>
    </div>
    <div class="wb-rf-exclusions">
      <ReleaseChipList
        :items="excluded"
        :label="t('releaseFlow.database.keptTables')"
        :remove-label="(table) => t('releaseFlow.database.remove', { table })"
        :disabled="busy"
        @remove="remove"
      />
      <form class="wb-rf-inline-form" @submit.prevent="addDraft">
        <input
          v-model="draft"
          class="wb-rf-input wb-rf-code"
          list="wb-rf-sync-tables"
          :placeholder="t('releaseFlow.database.addPlaceholder')"
          :aria-label="t('releaseFlow.database.addPlaceholder')"
          :disabled="busy"
          spellcheck="false"
        />
        <datalist id="wb-rf-sync-tables">
          <option v-for="name in addable" :key="name" :value="name" />
        </datalist>
        <button type="submit" class="wb-rf-btn is-small" :disabled="busy || !draft.trim()"><Plus :size="13" aria-hidden="true" />{{ t('releaseFlow.database.add') }}</button>
      </form>
      <div class="wb-rf-exclusion-tools">
        <label class="wb-rf-check">
          <input type="checkbox" :checked="planTablesKept" :disabled="busy" @change="togglePlanTables" />
          {{ t('releaseFlow.database.keepPlanTables') }}
        </label>
        <button
          v-for="template in templates"
          :key="template.id"
          type="button"
          class="wb-rf-btn is-quiet is-small"
          :disabled="busy"
          @click="flow.setSyncExclusions([...excluded, ...template.tables])"
        >+ {{ template.name }}</button>
      </div>
    </div>
    <ReleaseTaskPanel :flow="flow" task-id="db.sync">
      <template #done="{ result }">
        <strong>{{ t('releaseFlow.database.syncDone', { tables: formatReleaseCount(result.tables) }) }}</strong>
        <span class="wb-rf-muted">{{ t('releaseFlow.database.snapshot') }}</span>
      </template>
    </ReleaseTaskPanel>
  </section>

  <section class="wb-rf-card" aria-labelledby="wb-rf-db-plans">
    <div class="wb-rf-group-head">
      <ReleaseStatusIcon :status="status('db.plans')" :size="16" />
      <h4 id="wb-rf-db-plans">{{ t('releaseFlow.database.plans') }}</h4>
      <div class="wb-rf-group-tools">
        <button type="button" class="wb-rf-link" @click="emit('navigate', 'plans')">
          {{ t('releaseFlow.database.editPlans') }}<ArrowRight :size="13" aria-hidden="true" />
        </button>
      </div>
    </div>
    <p class="wb-rf-plan-sentence">
      {{ t('releaseFlow.database.planSentence', { platform: platform.name, date: formatPlanDate(state.brief.date) }) }}
      <strong v-if="counts.close" class="is-close">{{ t('releaseFlow.database.closeCount', { count: counts.close }) }}</strong>
      <strong v-if="counts.open" class="is-open">{{ t('releaseFlow.database.openCount', { count: counts.open }) }}</strong>
      <strong v-if="!counts.close && !counts.open">{{ t('releaseFlow.database.noChange') }}</strong>
    </p>
    <ul v-if="changes.length" class="wb-rf-list wb-rf-changes">
      <li v-for="row in changes" :key="row.item.id" :class="`is-${row.change}`">
        <span class="wb-rf-change-mark">
          <ArrowUp v-if="row.change === 'open'" :size="13" aria-hidden="true" />
          <ArrowDown v-else :size="13" aria-hidden="true" />
        </span>
        <strong>{{ row.item.name }}</strong>
        <span class="wb-rf-code wb-rf-muted">{{ planItemKeyLabel(row.item) }}</span>
        <span class="wb-rf-muted">{{ t(`releaseFlow.plan.category.${row.category}`) }}</span>
        <span class="wb-rf-change-note">{{ row.note }}</span>
      </li>
    </ul>
    <p v-if="unreadable.length" class="wb-rf-hint">
      {{ t('releaseFlow.database.unreadable', { count: unreadable.length, items: unreadable.map((row) => row.item.name).join('、') }) }}
    </p>
    <details v-if="statements.length" class="wb-rf-sql">
      <summary>{{ t('releaseFlow.database.sql', { count: statements.length }) }}</summary>
      <pre class="wb-rf-log">{{ statements.join('\n') }}</pre>
    </details>
    <ReleaseTaskPanel :flow="flow" task-id="db.plans">
      <template #done="{ result }">
        <strong>{{ result.statements ? t('releaseFlow.database.plansDone', { open: result.open, close: result.close }) : t('releaseFlow.database.plansDoneNone') }}</strong>
      </template>
    </ReleaseTaskPanel>
  </section>
</template>

<style scoped>
.wb-rf-exclusions {
  display: grid;
  gap: 12px;
}

.wb-rf-inline-form {
  display: flex;
  gap: 8px;
  max-width: 420px;
}

.wb-rf-inline-form input {
  flex: 1 1 auto;
  height: 28px;
}

.wb-rf-exclusion-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}

.wb-rf-plan-sentence {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin: 0;
  font-size: 14px;
}

.wb-rf-plan-sentence .is-close {
  color: var(--wb-warning-text);
}

.wb-rf-plan-sentence .is-open {
  color: var(--wb-success-text);
}

.wb-rf-changes {
  display: grid;
  border-top: 1px solid var(--wb-line);
}

.wb-rf-changes li {
  display: grid;
  grid-template-columns: 22px minmax(110px, auto) 70px 56px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 38px;
  border-bottom: 1px solid var(--wb-line);
  font-size: 13px;
}

.wb-rf-change-mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--wb-warning-surface);
  color: var(--wb-warning-text);
}

.wb-rf-changes li.is-open .wb-rf-change-mark {
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}

.wb-rf-changes strong {
  font-weight: 600;
}

.wb-rf-change-note {
  overflow: hidden;
  color: var(--wb-secondary-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-sql summary {
  width: fit-content;
  color: var(--wb-accent);
  font-size: 12.5px;
  cursor: pointer;
}

.wb-rf-sql .wb-rf-log {
  margin-top: 8px;
}
</style>
