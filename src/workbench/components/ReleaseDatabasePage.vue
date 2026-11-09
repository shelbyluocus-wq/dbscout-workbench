<script setup>
// Phase 1: overwrite the platform's intranet relay database with the
// development one (after backing it up, which a restore returns to), then
// write the open plan for this day. The GM later packs a config version from
// the relay database and the platform's GM applies it; that is where the
// change goes live, and where it is rolled back. The plan itself is the memo
// on the open plans page; this page writes the entries that name a table row
// and lists the others.
import { computed, ref } from "vue";
import { ArrowDown, ArrowRight, ArrowUp, Database, DatabaseBackup, Globe, Plus, RotateCcw } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatPlanDate } from "../utils/releasePlanNotes.js";
import { formatDateTime, formatReleaseCount } from "../utils/releaseFlowFormat.js";
import ReleaseChipList from "./ReleaseChipList.vue";
import ReleaseCombobox from "./ReleaseCombobox.vue";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseStatusIcon from "./ReleaseStatusIcon.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
  exclusionTemplates: { type: Array, default: () => [] },
});
const emit = defineEmits(["run", "rerun", "navigate"]);

const state = props.flow.state;
const platform = computed(() => props.flow.platform.value);
const plan = computed(() => props.flow.syncPlan.value);
const excluded = computed(() => props.flow.syncExclusions.value);
const busy = computed(() => props.flow.busy.value);
const locked = computed(() => busy.value || props.flow.finished.value);
const draft = ref("");
const addable = computed(() => plan.value.catalog.filter((name) => !excluded.value.includes(name)));
const templates = computed(() => props.exclusionTemplates.filter((template) => template?.tables?.length));

const backup = computed(() => props.flow.backup.value);
const restore = computed(() => state.tasks["db.restore"]);
const syncDone = computed(() => state.tasks["db.sync"].status === "done");

const groups = computed(() => props.flow.planGroups.value);
const counts = computed(() => props.flow.planCounts.value);
const changes = computed(() => groups.value.flatMap((group) => group.rows
  .filter((row) => row.change === "open" || row.change === "close")
  .map((row) => ({ ...row, category: group.id }))));
const unreadable = computed(() => groups.value.flatMap((group) => group.rows.filter((row) => row.change === "skip")));
const reminders = computed(() => props.flow.planReminders.value);
const statements = computed(() => props.flow.planSql.value);

function status(taskId) {
  const value = state.tasks[taskId].status;
  return value === "idle" ? "pending" : value;
}

function add(name) {
  const value = String(name ?? draft.value).trim();
  if (!value) return;
  props.flow.setSyncExclusions([...excluded.value, value]);
  draft.value = "";
}

function remove(name) {
  props.flow.setSyncExclusions(excluded.value.filter((table) => table !== name));
}
</script>

<template>
  <ReleasePageHead page-id="database" />

  <div class="wb-rf-route is-three">
    <div class="wb-rf-route-node">
      <span><Database :size="13" aria-hidden="true" />{{ t('releaseFlow.database.source') }}</span>
      <strong class="wb-rf-code">{{ platform.sourceDatabase }}</strong>
    </div>
    <span class="wb-rf-route-arrow" aria-hidden="true"><ArrowRight :size="18" /></span>
    <div class="wb-rf-route-node is-target">
      <span><Database :size="13" aria-hidden="true" />{{ t('releaseFlow.database.target', { platform: platform.name }) }}</span>
      <strong class="wb-rf-code">{{ platform.targetDatabase }}</strong>
    </div>
    <span class="wb-rf-route-arrow" aria-hidden="true"><ArrowRight :size="18" /></span>
    <div class="wb-rf-route-node is-later">
      <span><Globe :size="13" aria-hidden="true" />{{ t('releaseFlow.database.outer', { platform: platform.name }) }}</span>
      <strong>{{ t('releaseFlow.database.outerHow') }}</strong>
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
        :disabled="locked"
        @remove="remove"
      />
      <form class="wb-rf-inline-form" @submit.prevent="add()">
        <ReleaseCombobox
          v-model="draft"
          :options="addable"
          :placeholder="t('releaseFlow.database.addPlaceholder')"
          :empty-text="t('releaseFlow.database.noTable')"
          :disabled="locked"
          @pick="add"
        />
        <button type="submit" class="wb-rf-btn is-small" :disabled="locked || !draft.trim()"><Plus :size="13" aria-hidden="true" />{{ t('releaseFlow.database.add') }}</button>
      </form>
      <div v-if="templates.length" class="wb-rf-exclusion-tools">
        <button
          v-for="template in templates"
          :key="template.id"
          type="button"
          class="wb-rf-btn is-quiet is-small"
          :disabled="locked"
          @click="flow.setSyncExclusions([...excluded, ...template.tables])"
        >+ {{ template.name }}</button>
      </div>
    </div>
    <p class="wb-rf-backup-line">
      <DatabaseBackup :size="14" aria-hidden="true" />
      <span>{{ t('releaseFlow.backup.before', { database: platform.targetDatabase }) }}</span>
      <span class="wb-rf-chip is-quiet">{{ t('releaseFlow.backup.simulated') }}</span>
    </p>
    <ReleaseTaskPanel :flow="flow" task-id="db.sync">
      <template #done="{ result }">
        <strong>{{ t('releaseFlow.database.syncDone', { tables: formatReleaseCount(result.tables) }) }}</strong>
        <span v-if="result.backup" class="wb-rf-muted">{{ t('releaseFlow.backup.made', { time: formatDateTime(result.backup.at) }) }}</span>
      </template>
    </ReleaseTaskPanel>
  </section>

  <section class="wb-rf-card wb-rf-backup" aria-labelledby="wb-rf-db-backup">
    <div class="wb-rf-group-head">
      <ReleaseStatusIcon :status="restore.status === 'idle' ? (backup ? 'done' : 'pending') : status('db.restore')" :size="16" />
      <h4 id="wb-rf-db-backup">{{ t('releaseFlow.backup.title') }}</h4>
      <span v-if="backup" class="wb-rf-chip is-quiet" :title="t('releaseFlow.backup.simulatedHint')">{{ t('releaseFlow.backup.simulated') }}</span>
    </div>
    <template v-if="backup">
      <dl class="wb-rf-facts">
        <div class="wb-rf-fact"><dt>{{ t('releaseFlow.backup.database') }}</dt><dd class="wb-rf-code">{{ backup.database }}</dd></div>
        <div class="wb-rf-fact"><dt>{{ t('releaseFlow.backup.at') }}</dt><dd>{{ formatDateTime(backup.at) }}</dd></div>
        <div class="wb-rf-fact"><dt>{{ t('releaseFlow.backup.content') }}</dt><dd>{{ t('releaseFlow.backup.size', { tables: formatReleaseCount(backup.tables), rows: formatReleaseCount(backup.rows) }) }}</dd></div>
        <div class="wb-rf-fact is-wide"><dt>{{ t('releaseFlow.backup.file') }}</dt><dd class="wb-rf-code">{{ backup.path }}</dd></div>
      </dl>
      <div class="wb-rf-backup-actions">
        <p class="wb-rf-hint">{{ t('releaseFlow.backup.restoreHint', { database: platform.targetDatabase }) }}</p>
        <button type="button" class="wb-rf-btn wb-rf-danger-text" data-release-restore :disabled="Boolean(flow.blockerOf('db.restore'))" @click="emit('run', 'db.restore')">
          <RotateCcw :size="14" aria-hidden="true" />{{ t('releaseFlow.backup.restore') }}
        </button>
      </div>
    </template>
    <p v-else-if="restore.status === 'done'" class="wb-rf-notice is-success" role="status">
      {{ t('releaseFlow.backup.restoredNotice', { time: formatDateTime(restore.result?.backup?.at), database: platform.targetDatabase }) }}
    </p>
    <p v-else-if="syncDone" class="wb-rf-notice is-warning" role="status">{{ t('releaseFlow.backup.none') }}</p>
    <p v-else class="wb-rf-hint">{{ t('releaseFlow.backup.later') }}</p>
    <p class="wb-rf-hint">{{ t('releaseFlow.backup.outer', { platform: platform.name }) }}</p>
    <ReleaseTaskPanel v-if="restore.status === 'running' || restore.status === 'failed'" :flow="flow" task-id="db.restore" />
  </section>

  <section class="wb-rf-card" aria-labelledby="wb-rf-db-plans">
    <div class="wb-rf-group-head">
      <ReleaseStatusIcon :status="status('db.plans')" :size="16" />
      <h4 id="wb-rf-db-plans">{{ t('releaseFlow.database.plans') }}</h4>
      <div class="wb-rf-group-tools">
        <button type="button" class="wb-rf-link" data-release-open-plans @click="emit('navigate', 'plans')">
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
      <li v-for="row in changes" :key="row.item.id" :class="[`is-${row.change}`, { 'is-excluded': row.excluded }]">
        <input
          type="checkbox"
          :checked="!row.excluded"
          :disabled="locked"
          :aria-label="t('releaseFlow.database.include', { item: row.item.name })"
          @change="flow.setPlanSkip(row.item.id, !$event.target.checked)"
        />
        <span class="wb-rf-change-mark">
          <ArrowUp v-if="row.change === 'open'" :size="13" aria-hidden="true" />
          <ArrowDown v-else :size="13" aria-hidden="true" />
        </span>
        <strong>{{ row.item.name }}</strong>
        <span class="wb-rf-code wb-rf-muted">{{ row.item.ref }}</span>
        <span class="wb-rf-muted">{{ t(`releaseFlow.plan.category.${row.category}`) }}</span>
        <span class="wb-rf-change-note">{{ row.note }}</span>
      </li>
    </ul>
    <p v-if="unreadable.length" class="wb-rf-hint">
      {{ t('releaseFlow.database.unreadable', { count: unreadable.length, items: unreadable.map((row) => row.item.name).join('、') }) }}
    </p>
    <p v-if="reminders.length" class="wb-rf-notice is-warning wb-rf-reminders" role="note">
      {{ t('releaseFlow.database.reminders', { count: reminders.length, items: reminders.map((entry) => entry.name).join('、') }) }}
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

.wb-rf-inline-form .wb-rf-combobox {
  flex: 1 1 auto;
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
  font-size: var(--wb-fs-title);
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
  grid-template-columns: 16px 22px minmax(110px, auto) 70px 56px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 38px;
  border-bottom: 1px solid var(--wb-line);
  font-size: var(--wb-fs-body);
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

.wb-rf-changes li input {
  margin: 0;
  accent-color: var(--wb-accent);
}

.wb-rf-changes li.is-excluded > :not(input) {
  color: var(--wb-quiet-text);
}

.wb-rf-changes li.is-excluded .wb-rf-change-mark {
  color: var(--wb-quiet-text);
}

.wb-rf-changes li.is-excluded strong {
  text-decoration: line-through;
}

.wb-rf-backup-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-body);
}

.wb-rf-backup-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
}

.wb-rf-change-note {
  overflow: hidden;
  color: var(--wb-secondary-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-sql summary {
  width: fit-content;
  color: var(--wb-accent-strong);
  font-size: var(--wb-fs-body);
  cursor: pointer;
}

.wb-rf-sql .wb-rf-log {
  margin-top: 8px;
}
</style>
