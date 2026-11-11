<script setup>
// Add or edit one open-plan entry: its name, kind and (optional) ID, and each
// platform's note. Name and ID offer database-backed / preset dropdowns while
// remaining free text; per-platform notes support date pickers, quick status
// dropdowns, and one-shot fill across all platforms.
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { t } from "../i18n/index.js";
import { useEscClose } from "../composables/useEscClose.js";
import { PLAN_LIMITS } from "../releaseWorkspaceState.js";
import { PLAN_MEMO_CATEGORIES, RELEASE_PLAN_CATEGORIES, planEntryKey } from "../utils/releaseFlowDemo.js";
import {
  buildPlanNameOptions,
  buildPlanNotePresets,
  buildPlanRefOptions,
} from "../utils/releasePlanCandidates.js";
import { formatPlanDate, parsePlanNote } from "../utils/releasePlanNotes.js";
import { localDateIso } from "../releaseFlowState.js";
import ReleaseCombobox from "./ReleaseCombobox.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
  mode: { type: String, default: "add" },
  item: { type: Object, default: () => ({}) },
});

const emit = defineEmits(["close", "delete"]);
const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), null, { dialogRef });

const platforms = computed(() => props.workspace.state.platforms);
const today = localDateIso();
const draft = reactive({
  name: props.item.name || "",
  category: props.item.category || "hero",
  ref: props.item.ref || "",
  notes: Object.fromEntries(platforms.value.map((platform) => [platform.id, props.item.notes?.[platform.id] || ""])),
});
const touched = ref(false);
const candidates = ref([]);
const lastPickedName = ref(props.item.name || "");
let candidateRequestSeq = 0;

const nameMissing = computed(() => !draft.name.trim());
const tableCategory = computed(() => RELEASE_PLAN_CATEGORIES.find((entry) => entry.id === draft.category) || null);
// Whether an update can write this entry, or only lists it to do by hand.
const writable = computed(() => planEntryKey({ category: draft.category, ref: draft.ref }) !== null);
const nameOptions = computed(() => buildPlanNameOptions(candidates.value, t));
const refOptions = computed(() => buildPlanRefOptions(candidates.value, t));
const notePresets = computed(() => buildPlanNotePresets(today, today, t));

async function refreshCandidates(categoryId) {
  const seq = ++candidateRequestSeq;
  if (typeof props.workspace.loadPlanCandidates !== "function") {
    candidates.value = [];
    return;
  }
  const list = await props.workspace.loadPlanCandidates(categoryId);
  if (seq === candidateRequestSeq) candidates.value = Array.isArray(list) ? list : [];
}

watch(() => draft.category, (nextCategory) => {
  void refreshCandidates(nextCategory);
}, { immediate: true });

function onPickName(_value, raw) {
  const cand = raw?.candidate;
  if (!cand) return;
  draft.name = cand.name;
  if (cand.ref) draft.ref = cand.ref;
  lastPickedName.value = cand.name;
}

function onPickRef(_value, raw) {
  const cand = raw?.candidate;
  if (!cand) return;
  draft.ref = cand.ref;
  if (cand.name && (!draft.name.trim() || draft.name === lastPickedName.value)) {
    draft.name = cand.name;
    lastPickedName.value = cand.name;
  }
}

function dateOf(note) {
  const rule = parsePlanNote(note, today);
  return rule.kind === "window" ? rule.from || rule.to || "" : "";
}

function setDate(platformId, action, value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  draft.notes[platformId] = t(action === "close" ? "releaseFlow.note.close" : "releaseFlow.note.open", { date: formatPlanDate(value, today) });
}

function applyPreset(platformId, event) {
  const value = event.target.value;
  event.target.value = "";
  if (!value) return;
  draft.notes[platformId] = value === "__clear__" ? "" : value;
}

function applyPresetAll(event) {
  const value = event.target.value;
  event.target.value = "";
  if (!value) return;
  const nextValue = value === "__clear__" ? "" : value;
  for (const platform of platforms.value) {
    draft.notes[platform.id] = nextValue;
  }
}

function save() {
  touched.value = true;
  if (nameMissing.value) return;
  const entry = { name: draft.name, category: draft.category, ref: draft.ref, notes: { ...draft.notes } };
  const ok = props.mode === "edit" ? props.workspace.updatePlanEntry(props.item.id, entry) : props.workspace.addPlanEntry(entry);
  if (ok) emit("close");
}

onMounted(() => void nextTick(() => dialogRef.value?.querySelector("input")?.focus()));
</script>

<template>
  <div class="wb-rf-modal-backdrop">
    <form ref="dialogRef" class="wb-rf-modal is-wide" role="dialog" aria-modal="true" aria-labelledby="wb-rf-plan-editor-title" tabindex="-1" @submit.prevent="save">
      <header class="wb-rf-modal-head">
        <h3 id="wb-rf-plan-editor-title">{{ t(mode === 'edit' ? 'releaseFlow.plan.editor.editTitle' : 'releaseFlow.plan.editor.addTitle') }}</h3>
        <p>{{ t('releaseFlow.plan.editor.description') }}</p>
      </header>
      <div class="wb-rf-plan-editor-fields">
        <div class="wb-rf-field">
          <span>{{ t('releaseFlow.plan.editor.name') }}</span>
          <ReleaseCombobox
            v-model="draft.name"
            :options="nameOptions"
            :code="false"
            :open-on-focus="false"
            :submit-when-closed="true"
            :maxlength="PLAN_LIMITS.name"
            :invalid="touched && nameMissing"
            :label="t('releaseFlow.plan.editor.name')"
            :placeholder="t('releaseFlow.plan.editor.namePlaceholder')"
            :input-props="{ 'data-plan-name': '' }"
            :limit="160"
            @pick="onPickName"
          />
          <span v-if="touched && nameMissing" class="wb-rf-field-error">{{ t('releaseFlow.plan.editor.nameRequired') }}</span>
        </div>
        <label class="wb-rf-field">
          {{ t('releaseFlow.plan.editor.category') }}
          <select v-model="draft.category" data-plan-category-select>
            <option v-for="entry in PLAN_MEMO_CATEGORIES" :key="entry" :value="entry">{{ t(`releaseFlow.plan.category.${entry}`) }}</option>
          </select>
        </label>
        <div class="wb-rf-field">
          <span>{{ t('releaseFlow.plan.editor.ref') }}</span>
          <ReleaseCombobox
            v-model="draft.ref"
            :options="refOptions"
            :open-on-focus="false"
            :submit-when-closed="true"
            align="end"
            :maxlength="PLAN_LIMITS.ref"
            :label="t('releaseFlow.plan.editor.ref')"
            :placeholder="tableCategory?.keyColumns.join(' · ') || ''"
            :input-props="{ 'data-plan-ref': '' }"
            :limit="160"
            @pick="onPickRef"
          />
        </div>
      </div>
      <p class="wb-rf-hint" :class="{ 'is-warning': !writable }">
        {{ writable
          ? t('releaseFlow.plan.editor.writes', { table: tableCategory.table, flag: tableCategory.flagColumn })
          : t(draft.category === 'other' ? 'releaseFlow.plan.editor.otherOnly' : 'releaseFlow.plan.editor.needsRef', { key: tableCategory?.keyColumns.join(' · ') || '' }) }}
      </p>

      <table class="wb-rf-table wb-rf-plan-editor-table">
        <thead>
          <tr>
            <th scope="col">{{ t('releaseFlow.plan.editor.platform') }}</th>
            <th scope="col">{{ t('releaseFlow.plan.editor.date') }}</th>
            <th scope="col">
              <div class="wb-rf-plan-editor-note-head">
                <span>{{ t('releaseFlow.plan.editor.note') }}</span>
                <select
                  class="wb-rf-plan-preset-select"
                  :value="''"
                  :aria-label="t('releaseFlow.plan.editor.presetAll')"
                  data-plan-preset-all
                  @change="applyPresetAll"
                >
                  <option value="">{{ t('releaseFlow.plan.editor.presetAll') }}</option>
                  <option v-for="preset in notePresets" :key="preset.id" :value="preset.value">{{ preset.label }}</option>
                  <option value="__clear__">{{ t('releaseFlow.plan.editor.clearNote') }}</option>
                </select>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="platform in platforms" :key="platform.id">
            <th scope="row">{{ platform.name }}</th>
            <td>
              <div class="wb-rf-plan-editor-date">
                <input
                  type="date"
                  class="wb-rf-input"
                  :value="dateOf(draft.notes[platform.id])"
                  :aria-label="t('releaseFlow.plan.editor.dateLabel', { platform: platform.name })"
                  @change="setDate(platform.id, 'open', $event.target.value)"
                />
                <button
                  type="button"
                  class="wb-rf-btn is-quiet is-small"
                  :disabled="!dateOf(draft.notes[platform.id])"
                  @click="setDate(platform.id, 'close', dateOf(draft.notes[platform.id]))"
                >{{ t('releaseFlow.plan.editor.asClose') }}</button>
              </div>
            </td>
            <td>
              <div class="wb-rf-plan-editor-note-cell">
                <select
                  class="wb-rf-plan-preset-select is-compact"
                  :value="''"
                  :aria-label="t('releaseFlow.plan.editor.presetPlaceholder')"
                  @change="applyPreset(platform.id, $event)"
                >
                  <option value="">{{ t('releaseFlow.plan.editor.presetPlaceholder') }}</option>
                  <option v-for="preset in notePresets" :key="preset.id" :value="preset.value">{{ preset.label }}</option>
                  <option value="__clear__">{{ t('releaseFlow.plan.editor.clearNote') }}</option>
                </select>
                <input
                  v-model="draft.notes[platform.id]"
                  class="wb-rf-input"
                  :maxlength="PLAN_LIMITS.note"
                  :placeholder="t('releaseFlow.plan.notePlaceholder')"
                  :aria-label="t('releaseFlow.plan.noteLabel', { item: draft.name || t('releaseFlow.plan.editor.name'), platform: platform.name })"
                />
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <footer class="wb-rf-modal-foot">
        <button v-if="mode === 'edit'" type="button" class="wb-rf-btn wb-rf-danger-text wb-rf-modal-left" @click="emit('close'); emit('delete', item)">
          {{ t('releaseFlow.plan.delete.action') }}
        </button>
        <button type="button" class="wb-rf-btn is-quiet" @click="emit('close')">{{ t('releaseFlow.cancel') }}</button>
        <button type="submit" class="wb-rf-btn is-primary" data-plan-save>{{ t('releaseFlow.plan.editor.save') }}</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.wb-rf-plan-editor-fields {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px 14px;
}

.wb-rf-plan-editor-table {
  table-layout: fixed;
}

.wb-rf-plan-editor-table th:first-child {
  width: 90px;
}

.wb-rf-plan-editor-table th:nth-child(2) {
  width: 240px;
}

.wb-rf-plan-editor-note-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wb-rf-plan-editor-date {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wb-rf-plan-editor-date input {
  width: 146px;
}

.wb-rf-plan-editor-note-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wb-rf-plan-preset-select {
  flex: none;
  height: 30px;
  max-width: 148px;
  padding: 0 8px;
  border: 1px solid var(--wb-border);
  border-radius: 7px;
  background: var(--wb-control-surface);
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-caption);
  font-weight: 500;
}

.wb-rf-plan-preset-select.is-compact {
  width: 98px;
}

.wb-rf-plan-editor-note-cell .wb-rf-input {
  flex: 1 1 auto;
  width: 0;
  min-width: 0;
}
</style>
