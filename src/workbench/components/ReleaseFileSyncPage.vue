<script setup>
// Phase 2, step 2: copy the development client over the platform client.
// Exclusion rules keep version-control and platform-only files out; files
// and folders are added with the system's file dialog, which opens in the
// client folder and only accepts what lies inside it. The preview shows what
// each rule holds back before anything is copied.
import { computed, nextTick, ref } from "vue";
import { ArrowRight, ChevronDown, File, Folder, FolderOpen, Plus, TextCursorInput } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { DEMO_PROJECT_IGNORES } from "../utils/releaseFlowDemo.js";
import { ALWAYS_EXCLUDED_RULES, cleanExclusionRules, ruleForPick } from "../utils/releaseFileRules.js";
import { invokeWorkbench } from "../utils/tauriBridge.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseRuleList from "./ReleaseRuleList.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
});
defineEmits(["run", "rerun", "navigate"]);

const platform = computed(() => props.flow.platform.value);
const rules = computed(() => props.flow.fileRules.value);
const projectRules = computed(() => rules.value.filter((rule) => DEMO_PROJECT_IGNORES.includes(rule)));
const ownRules = computed(() => rules.value.filter((rule) => !DEMO_PROJECT_IGNORES.includes(rule)));
const plan = computed(() => props.flow.fileSyncPlan.value);
const locked = computed(() => props.flow.busy.value || props.flow.finished.value);
const filter = ref("copy");
const menuOpen = ref(false);
const menuRef = ref(null);
const typing = ref(false);
const draft = ref("");
const pickNotice = ref(null);
const picking = ref(false);

const counts = computed(() => ({
  added: plan.value.copy.filter((entry) => entry.status === "A").length,
  modified: plan.value.copy.filter((entry) => entry.status === "M").length,
  deleted: plan.value.remove.length,
  excluded: plan.value.excluded.length,
}));

const rows = computed(() => {
  if (filter.value === "excluded") return plan.value.excluded.map((entry) => ({ ...entry, kind: "excluded" }));
  return [
    ...plan.value.copy.map((entry) => ({ ...entry, kind: "copy" })),
    ...plan.value.remove.map((entry) => ({ ...entry, kind: "copy" })),
    ...plan.value.kept.map((entry) => ({ ...entry, kind: "kept" })),
  ];
});

function setOwnRules(next) {
  props.flow.setFileRules([...projectRules.value, ...next]);
}

function setProjectRules(next) {
  props.flow.setFileRules([...next, ...ownRules.value]);
}

function addRule(rule) {
  const value = String(rule || "").trim();
  if (!value) return false;
  const known = cleanExclusionRules([...rules.value, ...ALWAYS_EXCLUDED_RULES]).map((entry) => entry.toLowerCase());
  if (known.includes(cleanExclusionRules([value])[0]?.toLowerCase())) {
    pickNotice.value = { tone: "warning", text: t("releaseFlow.files.pick.duplicate", { rule: value }) };
    return false;
  }
  return props.flow.setFileRules([...rules.value, value]);
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) void nextTick(() => menuRef.value?.querySelector("button")?.focus());
}

function onMenuKeydown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  menuOpen.value = false;
}

// The dialog opens in the development client; anything inside either client folder counts.
async function pick(kind) {
  menuOpen.value = false;
  pickNotice.value = null;
  picking.value = true;
  try {
    const result = await invokeWorkbench("release_pick_exclusion", {
      request: {
        roots: [platform.value.sourceClient, platform.value.targetClient],
        kind,
        title: t(kind === "folder" ? "releaseFlow.files.pick.folderTitle" : "releaseFlow.files.pick.fileTitle"),
      },
    });
    if (result?.status === "picked") {
      const rule = ruleForPick(result.relative, result.kind);
      if (addRule(rule)) pickNotice.value = { tone: "success", text: t(`releaseFlow.files.pick.added.${result.kind}`, { rule }) };
    } else if (result?.status && result.status !== "cancelled") {
      pickNotice.value = {
        tone: "danger",
        text: t(`releaseFlow.files.pick.${result.status}`, { path: result.path, source: platform.value.sourceClient }),
      };
    }
  } catch (error) {
    pickNotice.value = { tone: "danger", text: String(error?.message || error) };
  } finally {
    picking.value = false;
  }
}

function startTyping() {
  menuOpen.value = false;
  typing.value = true;
  void nextTick(() => document.querySelector(".wb-rf-rule-form input")?.focus());
}

function submitTyped() {
  if (addRule(draft.value)) {
    pickNotice.value = null;
    draft.value = "";
    typing.value = false;
  }
}

function onMenuFocusOut(event) {
  if (!menuRef.value?.parentElement?.contains(event.relatedTarget)) menuOpen.value = false;
}
</script>

<template>
  <ReleasePageHead page-id="clientSync" />

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
    <section class="wb-rf-card" aria-labelledby="wb-rf-file-rules">
      <div class="wb-rf-group-head">
        <h4 id="wb-rf-file-rules">{{ t('releaseFlow.files.rules') }}</h4>
        <span class="wb-rf-count">{{ rules.length + ALWAYS_EXCLUDED_RULES.length }}</span>
        <div class="wb-rf-group-tools wb-rf-add-menu" @focusout="onMenuFocusOut">
          <button
            type="button"
            class="wb-rf-btn is-small"
            data-release-add-rule
            aria-haspopup="menu"
            :aria-expanded="menuOpen"
            :disabled="locked || picking"
            @click="toggleMenu"
          >
            <Plus :size="13" aria-hidden="true" />{{ t('releaseFlow.files.add') }}<ChevronDown :size="13" aria-hidden="true" />
          </button>
          <div v-if="menuOpen" ref="menuRef" class="wb-rf-menu wb-rf-add-menu-list" role="menu" @keydown="onMenuKeydown">
            <button type="button" role="menuitem" class="wb-rf-menu-item" data-release-pick="file" @click="pick('file')">
              <File :size="14" aria-hidden="true" />{{ t('releaseFlow.files.pick.file') }}
            </button>
            <button type="button" role="menuitem" class="wb-rf-menu-item" data-release-pick="folder" @click="pick('folder')">
              <Folder :size="14" aria-hidden="true" />{{ t('releaseFlow.files.pick.folder') }}
            </button>
            <button type="button" role="menuitem" class="wb-rf-menu-item" @click="startTyping">
              <TextCursorInput :size="14" aria-hidden="true" />{{ t('releaseFlow.files.pick.pattern') }}
            </button>
          </div>
        </div>
      </div>
      <p v-if="pickNotice" class="wb-rf-notice" :class="`is-${pickNotice.tone}`" role="status">{{ pickNotice.text }}</p>
      <form v-if="typing" class="wb-rf-rule-form" @submit.prevent="submitTyped">
        <input
          v-model="draft"
          class="wb-rf-input wb-rf-code"
          :placeholder="t('releaseFlow.files.addPlaceholder')"
          :aria-label="t('releaseFlow.files.addPlaceholder')"
          :title="t('releaseFlow.files.syntax')"
          :disabled="locked"
          spellcheck="false"
          @keydown.escape.stop.prevent="typing = false"
        />
        <button type="submit" class="wb-rf-btn is-small" :disabled="locked || !draft.trim()">{{ t('releaseFlow.files.addRule') }}</button>
      </form>
      <ReleaseRuleList :rules="ownRules" :locked="ALWAYS_EXCLUDED_RULES" :label="t('releaseFlow.files.rules')" :disabled="locked" @update="setOwnRules" />
      <details v-if="projectRules.length" class="wb-rf-project-rules">
        <summary>{{ t('releaseFlow.files.projectRules', { count: projectRules.length }) }}</summary>
        <ReleaseRuleList :rules="projectRules" :disabled="locked" @update="setProjectRules" />
      </details>
      <label class="wb-rf-check">
        <input type="checkbox" :checked="flow.workspace.rules.mirrorDeletes" :disabled="locked" @change="flow.setMirrorDeletes($event.target.checked)" />
        {{ t('releaseFlow.files.mirror') }}
      </label>
    </section>

    <section class="wb-rf-card" aria-labelledby="wb-rf-file-preview">
      <div class="wb-rf-group-head">
        <h4 id="wb-rf-file-preview">{{ t('releaseFlow.files.preview') }}</h4>
        <div class="wb-rf-group-tools">
          <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.files.filter')">
            <button
              v-for="value in ['copy', 'excluded']"
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
          <span class="wb-rf-code wb-rf-file-path" :title="row.path">{{ row.path }}</span>
          <span v-if="row.kind === 'excluded'" class="wb-rf-file-rule wb-rf-code">{{ row.rule }}</span>
          <span v-else-if="row.kind === 'kept'" class="wb-rf-file-rule">{{ t('releaseFlow.files.kept') }}</span>
        </li>
      </ul>
    </section>
  </div>

  <ReleaseTaskPanel :flow="flow" task-id="client.sync">
    <template #done="{ result }">
      <strong>{{ t('releaseFlow.files.done', { added: result.added, modified: result.modified, deleted: result.deleted }) }}</strong>
      <span v-if="result.warnings?.length" class="wb-rf-warning-text">{{ t('releaseFlow.files.doneMissing', { count: result.warnings.length }) }}</span>
      <span v-else class="wb-rf-muted">{{ t('releaseFlow.files.doneExcluded', { count: result.excluded }) }}</span>
    </template>
  </ReleaseTaskPanel>
  <ul v-if="flow.state.tasks['client.sync'].result?.warnings?.length" class="wb-rf-list wb-rf-missing" :aria-label="t('releaseFlow.files.missingList')">
    <li v-for="warning in flow.state.tasks['client.sync'].result.warnings" :key="warning.path" class="wb-rf-code">{{ warning.path }}</li>
  </ul>
</template>

<style scoped>
.wb-rf-files-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: 20px;
  align-items: start;
}

.wb-rf-project-rules summary {
  width: fit-content;
  margin-bottom: 8px;
  color: var(--wb-secondary-text);
  font-size: 12.5px;
  cursor: pointer;
}

.wb-rf-rule-form {
  display: flex;
  gap: 8px;
}

.wb-rf-rule-form input {
  flex: 1 1 auto;
  height: 28px;
}

.wb-rf-file-list {
  max-height: 320px;
  overflow-y: auto;
}

.wb-rf-file {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  border-top: 1px solid var(--wb-line);
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

.wb-rf-file-rule {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  color: var(--wb-quiet-text);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-file-status {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
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

.wb-rf-add-menu {
  position: relative;
}

.wb-rf-add-menu-list {
  top: calc(100% + 6px);
  right: 0;
  width: 220px;
}

.wb-rf-missing {
  display: grid;
  gap: 4px;
  margin-top: -16px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--wb-warning-surface);
  color: var(--wb-warning-text);
}
</style>
