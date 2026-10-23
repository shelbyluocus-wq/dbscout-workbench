<script setup>
import { computed } from "vue";
import { ArrowRight, Plus, ShieldCheck, Trash2 } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { planPreview, RELEASE_CATEGORIES } from "../releaseWorkflowState.js";
import ReleaseActionList from "./ReleaseActionList.vue";

const props = defineProps({ workflow: { type: Object, required: true } });
const { config, draft, busy } = props.workflow;
const preview = computed(() => planPreview(config.value));
const changes = computed(() => (draft.value.preview || []).filter((row) => row.changed));
const excluded = computed(() => [...new Set([
  ...config.value.dbExclusions.split(/\r?\n/).map((name) => name.trim()).filter(Boolean),
  ...(config.value.planMode === "preserve" ? config.value.plans.map((row) => row.table.trim()).filter(Boolean) : []),
])]);
const nameOf = (row) => row.name || t('release.exampleObject', { kind: t(`release.${row.kind}`) });
const update = (key, event) => props.workflow.updateConfig(key, event.target.value, 1);
const edit = (row, key, event) => props.workflow.updatePlan(row.id, key, event.target.value);
</script>

<template>
  <div class="rw-form-grid">
    <label class="rw-field">{{ t('release.sourceDb') }}<input :value="config.sourceDb" :disabled="!!busy" @input="update('sourceDb', $event)"></label>
    <label class="rw-field">{{ t('release.targetDb') }}<input :value="config.targetDb" :disabled="!!busy" @input="update('targetDb', $event)"></label>
    <label class="rw-field">{{ t('release.planMode') }}
      <select :value="config.planMode" :disabled="!!busy" @change="update('planMode', $event)">
        <option value="preserve">{{ t('release.preserve') }}</option><option value="overwrite">{{ t('release.overwrite') }}</option>
      </select>
      <small>{{ t('release.planModeHint') }}</small>
    </label>
    <label class="rw-field">{{ t('release.dbExclusions') }}<textarea :value="config.dbExclusions" :disabled="!!busy" rows="3" @input="update('dbExclusions', $event)" /></label>
  </div>
  <section class="rw-section">
    <div class="rw-section-heading"><h3>{{ t('release.plans') }}</h3><button type="button" class="rw-btn" :disabled="!!busy || config.plans.length >= 100" @click="workflow.addPlan"><Plus :size="14" />{{ t('release.addPlan') }}</button></div>
    <p class="rw-help">{{ t('release.planHint') }}</p>
    <div class="rw-table-scroll" tabindex="0" :aria-label="t('release.plans')">
      <table class="rw-table rw-plans-table">
        <thead><tr><th scope="col">{{ t('release.kind') }}</th><th scope="col">{{ t('release.object') }}</th><th scope="col">{{ t('release.start') }}</th><th scope="col">{{ t('release.end') }}</th><th scope="col">{{ t('release.result') }}</th><th scope="col">{{ t('release.note') }}</th><th scope="col"><span class="rw-sr-only">{{ t('release.removePlan', { name: '' }) }}</span></th></tr></thead>
        <tbody>
          <tr v-for="(row, index) in config.plans" :key="row.id">
            <td><select :value="row.kind" :disabled="!!busy" :aria-label="`${t('release.kind')} ${index + 1}`" @change="edit(row, 'kind', $event)"><option v-for="kind in RELEASE_CATEGORIES" :key="kind" :value="kind">{{ t(`release.${kind}`) }}</option></select></td>
            <td><input :value="row.name" :placeholder="nameOf(row)" :disabled="!!busy" :aria-label="`${t('release.object')} ${index + 1}`" @input="edit(row, 'name', $event)"></td>
            <td><input type="date" :value="row.start" :disabled="!!busy" :aria-label="`${t('release.start')} ${index + 1}`" @input="edit(row, 'start', $event)"></td>
            <td><input type="date" :value="row.end" :disabled="!!busy" :aria-label="`${t('release.end')} ${index + 1}`" @input="edit(row, 'end', $event)"></td>
            <td><span class="rw-tag" :class="{ 'is-open': preview[index].valid && preview[index].next, 'is-warning': !preview[index].valid }">{{ t(`release.${!preview[index].valid ? 'invalid' : preview[index].next ? 'enabled' : 'disabled'}`) }}</span></td>
            <td><input :value="row.note" :placeholder="t('release.note')" :disabled="!!busy" :aria-label="`${t('release.note')} ${index + 1}`" @input="edit(row, 'note', $event)"></td>
            <td><button type="button" class="rw-icon-btn" :disabled="!!busy" :aria-label="t('release.removePlan', { name: nameOf(row) })" @click="workflow.removePlan(row.id)"><Trash2 :size="14" /></button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <details class="rw-details">
      <summary>{{ t('release.mapping') }}</summary>
      <p class="rw-help">{{ t('release.mappingHint') }}</p>
      <div v-for="(row, index) in config.plans" :key="row.id" class="rw-mapping-row">
        <strong>{{ nameOf(row) }}</strong>
        <label class="rw-field">{{ t('release.table') }}<input :value="row.table" :aria-label="`${t('release.table')} ${index + 1}`" :disabled="!!busy" @input="edit(row, 'table', $event)"></label>
        <label class="rw-field">{{ t('release.rowKey') }}<input :value="row.rowKey" :aria-label="`${t('release.rowKey')} ${index + 1}`" :disabled="!!busy" @input="edit(row, 'rowKey', $event)"></label>
        <label class="rw-field">{{ t('release.field') }}<input :value="row.field" :aria-label="`${t('release.field')} ${index + 1}`" :disabled="!!busy" @input="edit(row, 'field', $event)"></label>
      </div>
    </details>
  </section>
  <section v-if="draft.preview" class="rw-section rw-preview" data-release-preview>
    <h3>{{ t('release.dbPreview', { count: changes.length }) }}</h3>
    <p class="rw-help">{{ t('release.dbPreviewHint') }}</p>
    <p class="rw-help"><strong>{{ t('release.excluded') }}:</strong> {{ excluded.join(', ') || '—' }}</p>
    <div v-for="row in changes" :key="row.id" class="rw-change-row"><strong>{{ nameOf(row) }}</strong><code>{{ row.table }} / {{ row.rowKey }} / {{ row.field }}</code><span>{{ row.current }}</span><ArrowRight :size="14" /><span class="rw-success">{{ row.next }}</span></div>
    <p v-if="!changes.length" class="rw-help">{{ t('release.noChanges') }}</p>
    <label class="rw-check"><input v-model="draft.checks.database" type="checkbox" :disabled="!!busy || draft.results.dbApply === 'done'">{{ t('release.reviewDatabase') }}</label>
  </section>
  <p class="rw-inline-note"><ShieldCheck :size="17" />{{ t('release.backupHint') }}</p>
  <ReleaseActionList :workflow="workflow" :actions="['dbPreview', 'dbApply']" />
</template>
