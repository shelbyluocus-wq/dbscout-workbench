<script setup>
// Open plans, a workspace page: a memo the team keeps for itself, one row per
// hero, mount, spirit, battle pet, feature or anything else, with every
// platform's note ("10/28 開放", "11/30 關閉", "已開放" …) judged for a chosen
// day. Supports multi-selection (with Shift-range) and one-click batch deletion,
// plus quick status presets right inside each cell.
import { computed, ref, watch } from "vue";
import { Pencil, Plus, Search, Trash2 } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useConfirm } from "../composables/useConfirm.js";
import { localDateIso } from "../releaseFlowState.js";
import { PLAN_MEMO_CATEGORIES, planEntryKey } from "../utils/releaseFlowDemo.js";
import { buildPlanNotePresets } from "../utils/releasePlanCandidates.js";
import { evaluatePlanRule, parsePlanNote } from "../utils/releasePlanNotes.js";
import { formatReleaseWeekday } from "../utils/releaseFlowFormat.js";
import ReleasePlanEntryEditor from "./ReleasePlanEntryEditor.vue";
import ReleaseSectionHead from "./ReleaseSectionHead.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const { confirm } = useConfirm();
const items = computed(() => props.workspace.state.plans.items);
const platforms = computed(() => props.workspace.state.platforms);
const busy = computed(() => props.workspace.anyBusy.value);
// The update this page was opened from: its platform column and its day.
const returnRun = computed(() => {
  const target = props.workspace.view.returnTo;
  return target?.section === "run" ? props.workspace.flowFor(target.runId) : null;
});
const releasePlatform = computed(() => returnRun.value?.platform.value.id || "");
const releaseDate = computed(() => returnRun.value?.state.brief.date || localDateIso());
const viewDate = ref(releaseDate.value);
const category = ref("all");
const query = ref("");
const editing = ref(null);
const selectedIds = ref([]);
const lastSelectedId = ref("");

const categoryCounts = computed(() => Object.fromEntries(PLAN_MEMO_CATEGORIES.map((entry) => [
  entry,
  items.value.filter((item) => item.category === entry).length,
])));
const rows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return items.value.filter((item) => (category.value === "all" || item.category === category.value)
    && (!needle || item.name.toLowerCase().includes(needle) || item.ref.toLowerCase().includes(needle)));
});
const selectedSet = computed(() => new Set(selectedIds.value));
const visibleSelectedCount = computed(() => rows.value.filter((item) => selectedSet.value.has(item.id)).length);
const allVisibleSelected = computed(() => rows.value.length > 0 && visibleSelectedCount.value === rows.value.length);
const someVisibleSelected = computed(() => visibleSelectedCount.value > 0 && !allVisibleSelected.value);
const notePresets = computed(() => buildPlanNotePresets(viewDate.value, viewDate.value, t));

watch(items, (list) => {
  if (!selectedIds.value.length) return;
  const alive = new Set(list.map((entry) => entry.id));
  const pruned = selectedIds.value.filter((id) => alive.has(id));
  if (pruned.length !== selectedIds.value.length) selectedIds.value = pruned;
}, { deep: true });

function toggleSelectAllVisible() {
  const visibleIds = rows.value.map((item) => item.id);
  if (!visibleIds.length) return;
  if (allVisibleSelected.value) {
    const drop = new Set(visibleIds);
    selectedIds.value = selectedIds.value.filter((id) => !drop.has(id));
    return;
  }
  const next = new Set(selectedIds.value);
  for (const id of visibleIds) next.add(id);
  selectedIds.value = [...next];
}

function toggleSelectRow(itemId, event) {
  const checked = event.target.checked;
  const next = new Set(selectedIds.value);
  if (event.shiftKey && lastSelectedId.value) {
    const ids = rows.value.map((entry) => entry.id);
    const from = ids.indexOf(lastSelectedId.value);
    const to = ids.indexOf(itemId);
    if (from >= 0 && to >= 0) {
      const [start, end] = from < to ? [from, to] : [to, from];
      for (let i = start; i <= end; i += 1) {
        if (checked) next.add(ids[i]);
        else next.delete(ids[i]);
      }
      selectedIds.value = [...next];
      lastSelectedId.value = itemId;
      return;
    }
  }
  if (checked) next.add(itemId);
  else next.delete(itemId);
  selectedIds.value = [...next];
  lastSelectedId.value = itemId;
}

function clearSelection() {
  selectedIds.value = [];
  lastSelectedId.value = "";
}

function verdict(item, platformId) {
  const result = evaluatePlanRule(parsePlanNote(item.notes?.[platformId], viewDate.value), viewDate.value);
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

function applyQuickPreset(itemId, platformId, event) {
  const value = event.target.value;
  event.target.value = "";
  if (!value) return;
  props.workspace.setPlanNote(itemId, platformId, value === "__clear__" ? "" : value);
}

function openEditor(item = null) {
  editing.value = item ? { mode: "edit", item } : { mode: "add", item: { category: category.value === "all" ? "hero" : category.value } };
}

async function remove(item) {
  if (!(await confirm({
    title: t("releaseFlow.plan.delete.title", { name: item.name }),
    message: t("releaseFlow.plan.delete.message"),
    confirmText: t("releaseFlow.plan.delete.action"),
    cancelText: t("releaseFlow.cancel"),
    danger: true,
  }))) return;
  props.workspace.removePlanEntry(item.id);
}

async function removeSelected() {
  const targets = [...selectedIds.value];
  if (!targets.length) return;
  if (!(await confirm({
    title: t("releaseFlow.plan.batchDelete.title", { count: targets.length }),
    message: t("releaseFlow.plan.batchDelete.message"),
    confirmText: t("releaseFlow.plan.delete.action"),
    cancelText: t("releaseFlow.cancel"),
    danger: true,
  }))) return;
  if (typeof props.workspace.removePlanEntries === "function") {
    props.workspace.removePlanEntries(targets);
  } else {
    for (const id of targets) props.workspace.removePlanEntry(id);
  }
  clearSelection();
}
</script>

<template>
  <ReleaseSectionHead :workspace="workspace" :title="t('releaseFlow.page.plans.title')" :description="t('releaseFlow.page.plans.description')">
    <template #actions>
      <template v-if="selectedIds.length">
        <button type="button" class="wb-rf-btn is-quiet" data-plan-clear-select :disabled="busy" @click="clearSelection">
          {{ t('releaseFlow.plan.clearSelection', { count: selectedIds.length }) }}
        </button>
        <button type="button" class="wb-rf-btn is-danger" data-plan-batch-delete :disabled="busy" @click="removeSelected">
          <Trash2 :size="14" aria-hidden="true" />{{ t('releaseFlow.plan.batchDelete', { count: selectedIds.length }) }}
        </button>
      </template>
      <button type="button" class="wb-rf-btn is-primary" data-plan-add :disabled="busy" @click="openEditor()">
        <Plus :size="14" aria-hidden="true" />{{ t('releaseFlow.plan.add') }}
      </button>
    </template>
  </ReleaseSectionHead>

  <div class="wb-rf-plan-toolbar">
    <div class="wb-rf-segmented" role="tablist" :aria-label="t('releaseFlow.plan.categories')">
      <button type="button" role="tab" :aria-selected="category === 'all'" data-plan-category="all" @click="category = 'all'">
        {{ t('releaseFlow.plan.category.all') }}<span class="wb-rf-count">{{ items.length }}</span>
      </button>
      <button
        v-for="entry in PLAN_MEMO_CATEGORIES"
        :key="entry"
        type="button"
        role="tab"
        :aria-selected="entry === category"
        :data-plan-category="entry"
        @click="category = entry"
      >
        {{ t(`releaseFlow.plan.category.${entry}`) }}
        <span class="wb-rf-count">{{ categoryCounts[entry] }}</span>
      </button>
    </div>
    <div class="wb-rf-plan-tools">
      <label class="wb-rf-search">
        <Search :size="14" aria-hidden="true" />
        <input v-model="query" type="search" :placeholder="t('releaseFlow.plan.search')" :aria-label="t('releaseFlow.plan.search')" />
      </label>
      <label class="wb-rf-plan-date">
        <span>{{ t('releaseFlow.plan.viewDate') }}</span>
        <input type="date" class="wb-rf-input" :value="viewDate" @change="onDateChange" />
        <button v-if="viewDate !== releaseDate" type="button" class="wb-rf-link" @click="viewDate = releaseDate">
          {{ t(returnRun ? 'releaseFlow.plan.backToRelease' : 'releaseFlow.plan.backToToday') }}
        </button>
        <span v-else class="wb-rf-muted">{{ formatReleaseWeekday(viewDate) }}</span>
      </label>
    </div>
  </div>

  <div v-if="rows.length" class="wb-rf-plan-matrix" role="tabpanel">
    <table class="wb-rf-table" :style="{ minWidth: `${Math.max(780, 310 + platforms.length * 168)}px` }">
      <thead>
        <tr>
          <th scope="col" class="wb-rf-plan-select-col">
            <input
              type="checkbox"
              class="wb-rf-plan-checkbox"
              :checked="allVisibleSelected"
              :indeterminate.prop="someVisibleSelected"
              :disabled="busy"
              :aria-label="t('releaseFlow.plan.selectAll')"
              data-plan-select-all
              @change="toggleSelectAllVisible"
            />
          </th>
          <th scope="col" class="wb-rf-plan-item-col">{{ t('releaseFlow.plan.column.item') }}</th>
          <th v-for="platform in platforms" :key="platform.id" scope="col" :class="{ 'is-release': platform.id === releasePlatform }">
            {{ platform.name }}
            <span v-if="platform.id === releasePlatform" class="wb-rf-plan-release">{{ t('releaseFlow.plan.thisRelease') }}</span>
          </th>
          <th scope="col" class="wb-rf-plan-actions-col"><span class="wb-rf-visually-hidden">{{ t('releaseFlow.plan.column.actions') }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="item.id" :class="{ 'is-selected': selectedSet.has(item.id) }" :data-plan-item="item.id">
          <td class="wb-rf-plan-select-cell">
            <input
              type="checkbox"
              class="wb-rf-plan-checkbox"
              :checked="selectedSet.has(item.id)"
              :disabled="busy"
              :aria-label="t('releaseFlow.plan.selectRow', { name: item.name })"
              :data-plan-select="item.id"
              @click="toggleSelectRow(item.id, $event)"
            />
          </td>
          <th scope="row">
            <strong>{{ item.name }}</strong>
            <span class="wb-rf-plan-item-meta">
              <span v-if="category === 'all'">{{ t(`releaseFlow.plan.category.${item.category}`) }}</span>
              <span v-if="item.ref" class="wb-rf-code">{{ item.ref }}</span>
              <span v-if="planEntryKey(item) === null" class="wb-rf-plan-manual" :title="t('releaseFlow.plan.manualHint')">{{ t('releaseFlow.plan.manual') }}</span>
            </span>
          </th>
          <td v-for="platform in platforms" :key="platform.id" :class="{ 'is-release': platform.id === releasePlatform }">
            <div class="wb-rf-plan-cell">
              <input
                class="wb-rf-plan-note"
                :value="item.notes[platform.id]"
                :disabled="busy"
                :placeholder="t('releaseFlow.plan.notePlaceholder')"
                :aria-label="t('releaseFlow.plan.noteLabel', { item: item.name, platform: platform.name })"
                @change="workspace.setPlanNote(item.id, platform.id, $event.target.value)"
              />
              <select
                class="wb-rf-plan-quick-select"
                :value="''"
                :disabled="busy"
                :aria-label="t('releaseFlow.plan.editor.presetPlaceholder')"
                :title="t('releaseFlow.plan.editor.presetPlaceholder')"
                @change="applyQuickPreset(item.id, platform.id, $event)"
              >
                <option value="">▾</option>
                <option v-for="preset in notePresets" :key="preset.id" :value="preset.value">{{ preset.label }}</option>
                <option value="__clear__">{{ t('releaseFlow.plan.editor.clearNote') }}</option>
              </select>
              <span class="wb-rf-plan-verdict" :class="verdict(item, platform.id).tone">{{ verdict(item, platform.id).text }}</span>
            </div>
          </td>
          <td class="wb-rf-plan-row-actions">
            <button type="button" class="wb-rf-icon-btn" :disabled="busy" :aria-label="t('releaseFlow.plan.edit', { name: item.name })" :title="t('releaseFlow.plan.edit', { name: item.name })" @click="openEditor(item)">
              <Pencil :size="14" aria-hidden="true" />
            </button>
            <button type="button" class="wb-rf-icon-btn is-danger" :disabled="busy" :aria-label="t('releaseFlow.plan.delete', { name: item.name })" :title="t('releaseFlow.plan.delete', { name: item.name })" @click="remove(item)">
              <Trash2 :size="14" aria-hidden="true" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <div v-else class="wb-rf-empty wb-rf-plan-empty">
    <p>{{ t(items.length ? 'releaseFlow.plan.noMatch' : 'releaseFlow.plan.empty') }}</p>
  </div>

  <details class="wb-rf-fold wb-rf-plan-foot">
    <summary>{{ t('releaseFlow.plan.help') }}</summary>
    <div class="wb-rf-fold-body wb-rf-hint">
      <span>{{ t('releaseFlow.plan.syntax') }}</span>
      <span>{{ t('releaseFlow.plan.writes') }}</span>
    </div>
  </details>

  <ReleasePlanEntryEditor
    v-if="editing"
    :workspace="workspace"
    :mode="editing.mode"
    :item="editing.item"
    @close="editing = null"
    @delete="remove($event)"
  />
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
  font-size: var(--wb-fs-body);
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
  min-width: 780px;
  table-layout: fixed;
}

.wb-rf-plan-select-col,
.wb-rf-plan-select-cell {
  width: 40px;
  padding-left: 14px;
  padding-right: 4px;
  text-align: center;
}

.wb-rf-plan-checkbox {
  width: 15px;
  height: 15px;
  margin: 0;
  vertical-align: middle;
  accent-color: var(--wb-accent);
  cursor: pointer;
}

.wb-rf-plan-matrix tbody tr.is-selected {
  background: color-mix(in srgb, var(--wb-accent) 6%, transparent);
}

.wb-rf-plan-item-col {
  width: 196px;
}

.wb-rf-plan-matrix tbody th {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-plan-matrix tbody th strong {
  display: block;
  overflow: hidden;
  margin-right: 8px;
  font-size: var(--wb-fs-body);
  font-weight: 600;
  text-overflow: ellipsis;
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
  font-size: var(--wb-fs-caption);
  font-weight: 650;
}

.wb-rf-plan-cell {
  display: flex;
  align-items: center;
  gap: 4px;
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
  font-size: var(--wb-fs-body);
  box-shadow: none;
}

.wb-rf-plan-note:hover:not(:disabled) {
  border-color: var(--wb-border);
}

.wb-rf-plan-note:focus {
  border-color: var(--wb-accent);
  background: var(--wb-cell-editor);
}

.wb-rf-plan-quick-select {
  flex: none;
  width: 22px;
  height: 24px;
  min-height: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--wb-quiet-text);
  font-size: var(--wb-fs-caption);
  text-align: center;
  appearance: none;
  cursor: pointer;
}

.wb-rf-plan-quick-select:hover:not(:disabled) {
  border-color: var(--wb-border);
  background: var(--wb-control-surface);
  color: var(--wb-text);
}

.wb-rf-plan-verdict {
  flex: none;
  min-width: 52px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--wb-fs-caption);
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

.wb-rf-plan-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
}

.wb-rf-plan-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  color: var(--wb-quiet-text);
  font-size: var(--wb-fs-caption);
  font-weight: 450;
}

.wb-rf-plan-manual {
  padding: 0 6px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: 999px;
}

.wb-rf-plan-actions-col {
  width: 76px;
}

.wb-rf-plan-row-actions {
  white-space: nowrap;
}

.wb-rf-plan-empty {
  display: grid;
  justify-items: start;
  gap: 10px;
}
</style>
