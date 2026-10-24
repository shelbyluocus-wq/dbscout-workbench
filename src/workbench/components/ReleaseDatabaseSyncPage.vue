<script setup>
// Phase 1, step 1: overwrite the platform database with the development one,
// keeping excluded tables as they are on the platform.
import { computed, ref } from "vue";
import { ArrowRight, Database, Plus, ShieldCheck, X } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_PLAN_CATEGORIES } from "../utils/releaseFlowDemo.js";
import { formatReleaseCount } from "../utils/releaseFlowFormat.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  exclusionTemplates: { type: Array, default: () => [] },
});
defineEmits(["run", "rerun", "navigate"]);

const platform = computed(() => props.flow.platform.value);
const plan = computed(() => props.flow.syncPlan.value);
const excluded = computed(() => props.flow.syncExclusions.value);
const busy = computed(() => props.flow.busy.value);
const draft = ref("");

const PLAN_TABLES = RELEASE_PLAN_CATEGORIES.map((category) => category.table);
const planTablesKept = computed(() => PLAN_TABLES.every((table) => excluded.value.includes(table)));
const addable = computed(() => plan.value.catalog.filter((name) => !excluded.value.includes(name)));
const templates = computed(() => props.exclusionTemplates.filter((template) => template?.tables?.length));

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
  const rest = excluded.value.filter((table) => !PLAN_TABLES.includes(table));
  props.flow.setSyncExclusions(planTablesKept.value ? rest : [...rest, ...PLAN_TABLES]);
}

function applyTemplate(template) {
  props.flow.setSyncExclusions([...excluded.value, ...template.tables]);
}
</script>

<template>
  <div>
    <ReleasePageHead page-id="dbSync" />

    <div class="wb-rf-stack">
      <div class="wb-rf-route">
        <div class="wb-rf-route-node">
          <span><Database :size="13" aria-hidden="true" />{{ t('releaseFlow.dbSync.source') }}</span>
          <strong class="wb-rf-code">{{ platform.sourceDatabase }}</strong>
        </div>
        <span class="wb-rf-route-arrow" aria-hidden="true"><ArrowRight :size="18" /></span>
        <div class="wb-rf-route-node is-target">
          <span><Database :size="13" aria-hidden="true" />{{ t('releaseFlow.dbSync.target', { platform: platform.name }) }}</span>
          <strong class="wb-rf-code">{{ platform.targetDatabase }}</strong>
        </div>
      </div>

      <div class="wb-rf-stats" role="group" :aria-label="t('releaseFlow.dbSync.planLabel')">
        <div class="wb-rf-stat"><strong>{{ plan.tables.length }}</strong><span>{{ t('releaseFlow.dbSync.tables') }}</span></div>
        <div class="wb-rf-stat"><strong>{{ formatReleaseCount(plan.rows) }}</strong><span>{{ t('releaseFlow.dbSync.rows') }}</span></div>
        <div class="wb-rf-stat is-muted"><strong>{{ plan.excluded.length }}</strong><span>{{ t('releaseFlow.dbSync.excluded') }}</span></div>
      </div>

      <section class="wb-rf-section" aria-labelledby="wb-rf-sync-exclusions">
        <div class="wb-rf-section-head">
          <h4 id="wb-rf-sync-exclusions">{{ t('releaseFlow.dbSync.exclusions') }}</h4>
          <div class="wb-rf-section-tools">
            <button type="button" class="wb-rf-link" :disabled="busy" @click="togglePlanTables">
              {{ t(planTablesKept ? 'releaseFlow.dbSync.overwritePlanTables' : 'releaseFlow.dbSync.keepPlanTables') }}
            </button>
          </div>
        </div>
        <p class="wb-rf-hint">{{ t(planTablesKept ? 'releaseFlow.dbSync.planTablesKept' : 'releaseFlow.dbSync.planTablesSynced') }}</p>
        <ul class="wb-rf-list wb-rf-exclusions" :aria-label="t('releaseFlow.dbSync.exclusions')">
          <li v-for="name in excluded" :key="name" class="wb-rf-chip">
            <span class="wb-rf-code">{{ name }}</span>
            <button type="button" class="wb-rf-chip-remove" :disabled="busy" :aria-label="t('releaseFlow.dbSync.remove', { table: name })" @click="remove(name)">
              <X :size="11" aria-hidden="true" />
            </button>
          </li>
          <li v-if="!excluded.length" class="wb-rf-muted">{{ t('releaseFlow.dbSync.noExclusions') }}</li>
        </ul>
        <form class="wb-rf-inline-form" @submit.prevent="addDraft">
          <input
            v-model="draft"
            class="wb-rf-input wb-rf-code"
            list="wb-rf-sync-tables"
            :placeholder="t('releaseFlow.dbSync.addPlaceholder')"
            :aria-label="t('releaseFlow.dbSync.addPlaceholder')"
            :disabled="busy"
            spellcheck="false"
          />
          <datalist id="wb-rf-sync-tables">
            <option v-for="name in addable" :key="name" :value="name" />
          </datalist>
          <button type="submit" :disabled="busy || !draft.trim()"><Plus :size="13" aria-hidden="true" /> {{ t('releaseFlow.dbSync.add') }}</button>
        </form>
        <div v-if="templates.length" class="wb-rf-templates">
          <span class="wb-rf-muted">{{ t('releaseFlow.dbSync.templates') }}</span>
          <button v-for="template in templates" :key="template.id" type="button" class="wb-rf-ghost" :disabled="busy" @click="applyTemplate(template)">
            {{ t('releaseFlow.dbSync.applyTemplate', { name: template.name, count: template.tables.length }) }}
          </button>
        </div>
      </section>

      <p class="wb-rf-notice"><ShieldCheck :size="14" aria-hidden="true" />{{ t('releaseFlow.dbSync.safety') }}</p>

      <ReleaseTaskPanel :flow="flow" task-id="db.sync">
        <template #done="{ result }">
          <strong>{{ t('releaseFlow.dbSync.done', { tables: result.tables, rows: formatReleaseCount(result.rows) }) }}</strong>
          <span class="wb-rf-code">{{ t('releaseFlow.dbSync.snapshot', { path: result.snapshot }) }}</span>
        </template>
      </ReleaseTaskPanel>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-exclusions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wb-rf-exclusions .wb-rf-chip {
  padding-right: 3px;
}

.wb-rf-chip-remove {
  display: grid;
  place-items: center;
  width: 18px;
  min-height: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--wb-quiet-text);
}

.wb-rf-chip-remove:hover:not(:disabled) {
  border: none;
  background: var(--wb-accent-soft);
  color: var(--wb-text);
}

.wb-rf-inline-form {
  display: flex;
  gap: 8px;
  max-width: 420px;
}

.wb-rf-inline-form input {
  flex: 1 1 auto;
}

.wb-rf-inline-form button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.wb-rf-templates {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
</style>
