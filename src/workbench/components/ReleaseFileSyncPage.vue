<script setup>
// Phase 2, step 2: copy the development client over the platform client.
// Exclusion rules keep version-control and platform-only files out; the
// preview shows what each rule holds back before anything is copied.
import { computed, ref } from "vue";
import { ArrowRight, FolderOpen, Lock, Plus, X } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { ALWAYS_EXCLUDED_RULES } from "../utils/releaseFileRules.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
defineEmits(["run", "rerun", "navigate"]);

const platform = computed(() => props.flow.platform.value);
const rules = computed(() => props.flow.fileRules.value);
const plan = computed(() => props.flow.fileSyncPlan.value);
const busy = computed(() => props.flow.busy.value);
const draft = ref("");
const filter = ref("all");

const counts = computed(() => ({
  added: plan.value.copy.filter((entry) => entry.status === "A").length,
  modified: plan.value.copy.filter((entry) => entry.status === "M").length,
  deleted: plan.value.remove.length,
  excluded: plan.value.excluded.length,
}));

const rows = computed(() => {
  const copied = [
    ...plan.value.copy.map((entry) => ({ ...entry, kind: "copy" })),
    ...plan.value.remove.map((entry) => ({ ...entry, kind: "copy" })),
    ...plan.value.kept.map((entry) => ({ ...entry, kind: "kept" })),
  ];
  const excluded = plan.value.excluded.map((entry) => ({ ...entry, kind: "excluded" }));
  if (filter.value === "copy") return copied;
  if (filter.value === "excluded") return excluded;
  return [...copied, ...excluded];
});

function addRule() {
  const rule = draft.value.trim();
  if (!rule) return;
  props.flow.setFileRules([...rules.value, rule]);
  draft.value = "";
}

function removeRule(rule) {
  props.flow.setFileRules(rules.value.filter((entry) => entry !== rule));
}
</script>

<template>
  <div>
    <ReleasePageHead page-id="clientSync" />

    <div class="wb-rf-stack">
      <div class="wb-rf-route">
        <div class="wb-rf-route-node">
          <span><FolderOpen :size="13" aria-hidden="true" />{{ t('releaseFlow.files.source') }}</span>
          <strong class="wb-rf-code">{{ platform.sourceClient }}</strong>
        </div>
        <span class="wb-rf-route-arrow" aria-hidden="true"><ArrowRight :size="18" /></span>
        <div class="wb-rf-route-node is-target">
          <span><FolderOpen :size="13" aria-hidden="true" />{{ t('releaseFlow.files.target', { platform: platform.name }) }}</span>
          <strong class="wb-rf-code">{{ platform.targetClient }}</strong>
        </div>
      </div>

      <div class="wb-rf-files-grid">
        <section class="wb-rf-section" aria-labelledby="wb-rf-file-rules">
          <div class="wb-rf-section-head">
            <h4 id="wb-rf-file-rules">{{ t('releaseFlow.files.rules') }}</h4>
            <span class="wb-rf-muted">{{ t('releaseFlow.files.rulesCount', { count: rules.length + ALWAYS_EXCLUDED_RULES.length }) }}</span>
          </div>
          <ul class="wb-rf-list wb-rf-rules">
            <li v-for="rule in ALWAYS_EXCLUDED_RULES" :key="rule" class="wb-rf-rule is-locked" :title="t('releaseFlow.files.locked')">
              <span class="wb-rf-code">{{ rule }}</span>
              <Lock :size="12" aria-hidden="true" />
              <span class="wb-rf-muted">{{ t('releaseFlow.files.locked') }}</span>
            </li>
            <li v-for="rule in rules" :key="rule" class="wb-rf-rule">
              <span class="wb-rf-code">{{ rule }}</span>
              <button type="button" class="wb-rf-rule-remove" :disabled="busy" :aria-label="t('releaseFlow.files.removeRule', { rule })" @click="removeRule(rule)">
                <X :size="12" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <form class="wb-rf-rule-form" @submit.prevent="addRule">
            <input
              v-model="draft"
              class="wb-rf-input wb-rf-code"
              :placeholder="t('releaseFlow.files.addPlaceholder')"
              :aria-label="t('releaseFlow.files.addPlaceholder')"
              :disabled="busy"
              spellcheck="false"
            />
            <button type="submit" :disabled="busy || !draft.trim()"><Plus :size="13" aria-hidden="true" /> {{ t('releaseFlow.files.add') }}</button>
          </form>
          <p class="wb-rf-hint">{{ t('releaseFlow.files.syntax') }}</p>
          <label class="wb-rf-check">
            <input type="checkbox" :checked="flow.state.mirrorDeletes" :disabled="busy" @change="flow.setMirrorDeletes($event.target.checked)" />
            {{ t('releaseFlow.files.mirror') }}
          </label>
        </section>

        <section class="wb-rf-section" aria-labelledby="wb-rf-file-preview">
          <div class="wb-rf-section-head">
            <h4 id="wb-rf-file-preview">{{ t('releaseFlow.files.preview') }}</h4>
            <div class="wb-rf-section-tools">
              <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.files.filter')">
                <button
                  v-for="value in ['all', 'copy', 'excluded']"
                  :key="value"
                  type="button"
                  role="radio"
                  :aria-checked="filter === value"
                  @click="filter = value"
                >{{ t(`releaseFlow.files.filter.${value}`) }}</button>
              </div>
            </div>
          </div>
          <div class="wb-rf-stats">
            <div class="wb-rf-stat is-success"><strong>{{ counts.added }}</strong><span>{{ t('releaseFlow.files.added') }}</span></div>
            <div class="wb-rf-stat"><strong>{{ counts.modified }}</strong><span>{{ t('releaseFlow.files.modified') }}</span></div>
            <div class="wb-rf-stat is-warning"><strong>{{ counts.deleted }}</strong><span>{{ t('releaseFlow.files.deleted') }}</span></div>
            <div class="wb-rf-stat is-muted"><strong>{{ counts.excluded }}</strong><span>{{ t('releaseFlow.files.excluded') }}</span></div>
          </div>
          <ul class="wb-rf-list wb-rf-file-list" :aria-label="t('releaseFlow.files.preview')">
            <li v-for="row in rows" :key="row.path" class="wb-rf-file" :class="`is-${row.kind}`">
              <span class="wb-rf-file-status" :class="`is-${row.status}`" :title="t(`releaseFlow.files.status.${row.status}`)">{{ row.status }}</span>
              <span class="wb-rf-code wb-rf-file-path">{{ row.path }}</span>
              <span v-if="row.kind === 'excluded'" class="wb-rf-chip is-quiet">{{ t('releaseFlow.files.excludedBy', { rule: row.rule }) }}</span>
              <span v-else-if="row.kind === 'kept'" class="wb-rf-chip is-quiet">{{ t('releaseFlow.files.kept') }}</span>
            </li>
          </ul>
        </section>
      </div>

      <ReleaseTaskPanel :flow="flow" task-id="client.sync">
        <template #done="{ result }">
          <strong>{{ t('releaseFlow.files.done', { added: result.added, modified: result.modified, deleted: result.deleted }) }}</strong>
          <span>{{ t('releaseFlow.files.doneExcluded', { count: result.excluded }) }}</span>
        </template>
      </ReleaseTaskPanel>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-files-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.25fr);
  gap: 16px;
  align-items: start;
}

.wb-rf-rules {
  display: grid;
  gap: 4px;
}

.wb-rf-rule {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 0 4px 0 10px;
  border-radius: 6px;
  background: var(--wb-field-surface);
}

.wb-rf-rule .wb-rf-code {
  flex: 1 1 auto;
}

.wb-rf-rule.is-locked {
  color: var(--wb-secondary-text);
}

.wb-rf-rule.is-locked .wb-rf-code {
  flex: none;
}

.wb-rf-rule-remove {
  display: grid;
  place-items: center;
  width: 24px;
  min-height: 24px;
  height: 24px;
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: var(--wb-quiet-text);
}

.wb-rf-rule-remove:hover:not(:disabled) {
  border-color: transparent;
  background: var(--wb-accent-soft);
  color: var(--wb-text);
}

.wb-rf-rule-form {
  display: flex;
  gap: 8px;
}

.wb-rf-rule-form input {
  flex: 1 1 auto;
}

.wb-rf-rule-form button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.wb-rf-file-list {
  max-height: 340px;
  overflow-y: auto;
  border-top: 1px solid var(--wb-line);
}

.wb-rf-file {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  padding: 0 4px;
  border-bottom: 1px solid var(--wb-line);
}

.wb-rf-file.is-excluded .wb-rf-file-path,
.wb-rf-file.is-kept .wb-rf-file-path {
  color: var(--wb-quiet-text);
}

.wb-rf-file-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-file-status {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--wb-accent-soft);
  color: var(--wb-text);
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  font-size: 11px;
  font-weight: 700;
}

.wb-rf-file-status.is-A {
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}

.wb-rf-file-status.is-D {
  background: var(--wb-warning-surface);
  color: var(--wb-warning-text);
}

.wb-rf-file.is-excluded .wb-rf-file-status {
  background: transparent;
  color: var(--wb-quiet-text);
}
</style>
