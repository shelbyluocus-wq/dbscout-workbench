<script setup>
// Phase 2, step 3: run the platform's table conversion with a template from
// the one-click table transfer. Templates are shared with that dialog: a
// template made or changed here shows there, and the other way round. The
// conversion's output is always copied into the platform client; choosing a
// template here remembers it for the platform.
import { computed, inject, nextTick, ref } from "vue";
import { ArrowRight, Check, FileSpreadsheet, FileText, FolderOpen, FolderSearch, Plus } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { tPlatform } from "../utils/platformLabels.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
  transfer: { type: Object, default: null },
});
defineEmits(["run", "rerun", "navigate"]);

const tools = inject("releaseWorkbenchTools", null);
const platform = computed(() => props.flow.platform.value);
const templates = computed(() => props.flow.templates.value);
const selected = computed(() => props.flow.selectedTemplate.value);
const busy = computed(() => props.flow.busy.value || props.flow.finished.value);
const transferBusy = computed(() => Boolean(props.transfer?.isRunning?.value));
const task = computed(() => props.flow.state.tasks["client.transfer"]);
const creating = ref(false);
const newName = ref("");
const nameError = ref("");
const nameRef = ref(null);

const STRATEGIES = Object.freeze(["theirs", "mine", "manual"]);

function fileName(path) {
  return String(path || "").split(/[\\/]/).pop();
}

const assetsFolder = computed(() => {
  const root = String(platform.value.targetClient || "").replace(/[\\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  return root ? `${root}${sep}assets` : "assets";
});

const STAGES = Object.freeze([
  { id: "script", until: 0.7 },
  { id: "locate", until: 0.8 },
  { id: "copy", until: 1.01 },
]);

function stageState(index) {
  if (task.value.status === "done") return "done";
  if (task.value.status !== "running") return "pending";
  const fraction = props.flow.progress.fraction ?? 0;
  const current = STAGES.findIndex((stage) => fraction < stage.until);
  if (index < current) return "done";
  return index === current ? "running" : "pending";
}

function choose(template) {
  props.workspace?.updatePlatform(platform.value.id, { transferTemplateId: template.id });
}

function startCreate() {
  creating.value = true;
  newName.value = props.transfer?.suggestTemplateName?.(t("releaseFlow.transfer.newName", { platform: platform.value.name })) || "";
  nameError.value = "";
  void nextTick(() => nameRef.value?.select());
}

function create() {
  const result = props.transfer?.addTemplate(newName.value);
  if (!result || result.status !== "created") {
    nameError.value = t(`releaseFlow.transfer.nameError.${result?.status || "busy"}`);
    return;
  }
  creating.value = false;
  choose(result.template);
}

function setStrategy(value) {
  if (selected.value) props.transfer?.updateTemplate(selected.value.id, { conflictStrategy: value });
}
</script>

<template>
  <ReleasePageHead page-id="clientTransfer" />

  <section class="wb-rf-group" aria-labelledby="wb-rf-transfer-templates">
    <div class="wb-rf-group-head">
      <h4 id="wb-rf-transfer-templates">{{ t('releaseFlow.transfer.templates') }}</h4>
      <span class="wb-rf-count">{{ t('releaseFlow.transfer.templatesHint') }}</span>
      <div class="wb-rf-group-tools">
        <button v-if="tools" type="button" class="wb-rf-link" data-release-open-transfer-tool :disabled="busy" @click="tools.openTableTransfer()">
          {{ t('releaseFlow.transfer.openTransferTool') }}<ArrowRight :size="13" aria-hidden="true" />
        </button>
        <button v-if="transfer" type="button" class="wb-rf-btn is-small" data-release-new-template :disabled="busy || transferBusy" @click="startCreate">
          <Plus :size="13" aria-hidden="true" />{{ t('releaseFlow.transfer.new') }}
        </button>
      </div>
    </div>
    <form v-if="creating" class="wb-rf-inline-form wb-rf-template-new" @submit.prevent="create">
      <input
        ref="nameRef"
        v-model="newName"
        class="wb-rf-input"
        maxlength="40"
        :aria-label="t('releaseFlow.transfer.newNameLabel')"
        :aria-invalid="Boolean(nameError)"
        @input="nameError = ''"
        @keydown.escape.stop.prevent="creating = false"
      />
      <button type="submit" class="wb-rf-btn is-small is-primary">{{ t('releaseFlow.transfer.create') }}</button>
      <button type="button" class="wb-rf-btn is-small is-quiet" @click="creating = false">{{ t('releaseFlow.cancel') }}</button>
      <span v-if="nameError" class="wb-rf-field-error" role="alert">{{ nameError }}</span>
    </form>
    <div v-if="templates.length" class="wb-rf-template-list" role="radiogroup" :aria-label="t('releaseFlow.transfer.templates')">
      <button
        v-for="template in templates"
        :key="template.id"
        type="button"
        role="radio"
        class="wb-rf-template"
        :data-template-id="template.id"
        :aria-checked="template.id === selected?.id"
        :disabled="busy"
        @click="choose(template)"
      >
        <span class="wb-rf-template-name">
          <FileSpreadsheet :size="15" aria-hidden="true" />
          <strong>{{ template.name }}</strong>
          <Check v-if="template.id === selected?.id" :size="15" class="wb-rf-template-check" aria-hidden="true" />
        </span>
        <span v-if="template.scriptPath" class="wb-rf-code" :title="template.scriptPath">{{ fileName(template.scriptPath) }}</span>
        <span v-else class="wb-rf-muted">{{ t('releaseFlow.transfer.noScript') }}</span>
      </button>
    </div>
    <p v-else class="wb-rf-empty">{{ t('releaseFlow.transfer.empty') }}</p>
  </section>

  <section v-if="selected" class="wb-rf-card wb-rf-template-detail" aria-labelledby="wb-rf-template-detail">
    <div class="wb-rf-group-head">
      <h4 id="wb-rf-template-detail">{{ t('releaseFlow.transfer.detail', { name: selected.name }) }}</h4>
      <span v-if="selected.builtIn" class="wb-rf-chip is-quiet">{{ t('releaseFlow.transfer.builtIn') }}</span>
    </div>
    <dl class="wb-rf-facts is-rows">
      <div class="wb-rf-fact">
        <dt>{{ t('releaseFlow.transfer.script') }}</dt>
        <dd>
          <span class="wb-rf-code">{{ selected.scriptPath || t('releaseFlow.transfer.noScript') }}</span>
          <span v-if="transfer" class="wb-rf-fact-actions">
            <button type="button" class="wb-rf-btn is-small is-quiet" :disabled="busy || transferBusy" @click="transfer.pickScript(selected.id)">
              <FileText :size="13" aria-hidden="true" />{{ t('releaseFlow.transfer.pickScript') }}
            </button>
            <button v-if="selected.scriptPath" type="button" class="wb-rf-btn is-small is-quiet" @click="transfer.revealPath(selected.scriptPath)">
              <FolderSearch :size="13" aria-hidden="true" />{{ tPlatform('releaseFlow.transfer.reveal') }}
            </button>
          </span>
        </dd>
      </div>
      <div class="wb-rf-fact">
        <dt>{{ t('releaseFlow.transfer.strategy') }}</dt>
        <dd>
          <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.transfer.strategy')">
            <button
              v-for="strategy in STRATEGIES"
              :key="strategy"
              type="button"
              role="radio"
              :aria-checked="selected.conflictStrategy === strategy"
              :disabled="busy || transferBusy || !transfer"
              @click="setStrategy(strategy)"
            >{{ t(`releaseFlow.transfer.strategy.${strategy}`) }}</button>
          </div>
        </dd>
      </div>
    </dl>
    <details class="wb-rf-fold">
      <summary>{{ t('releaseFlow.transfer.moreSettings') }}</summary>
      <dl class="wb-rf-fold-body wb-rf-facts is-rows">
        <div class="wb-rf-fact">
          <dt>{{ t('releaseFlow.transfer.target') }}</dt>
          <dd><span class="wb-rf-code">{{ assetsFolder }}</span></dd>
        </div>
        <div class="wb-rf-fact">
          <dt>{{ t('releaseFlow.transfer.projectRoot') }}</dt>
          <dd>
            <span class="wb-rf-code">{{ selected.projectRoot || '—' }}</span>
            <span v-if="transfer" class="wb-rf-fact-actions">
              <button type="button" class="wb-rf-btn is-small is-quiet" :disabled="busy || transferBusy" @click="transfer.pickProjectDir(selected.id)">
                <FolderOpen :size="13" aria-hidden="true" />{{ t('releaseFlow.transfer.pickProject') }}
              </button>
            </span>
          </dd>
        </div>
        <div v-if="transfer" class="wb-rf-fact">
          <dt><label for="wb-release-transfer-retention">{{ t('tableTransfer.retention') }}</label></dt>
          <dd>
            <input
              id="wb-release-transfer-retention"
              type="number"
              min="0"
              max="3650"
              step="1"
              :value="selected.retentionDays ?? 7"
              :disabled="busy || transferBusy"
              @change="transfer.updateTemplate(selected.id, { retentionDays: $event.target.value }); $event.target.value = selected.retentionDays"
            />
            <span class="wb-rf-hint">{{ t('tableTransfer.retentionHint') }}</span>
          </dd>
        </div>
      </dl>
    </details>
  </section>

  <ol class="wb-rf-list wb-rf-stages" :aria-label="t('releaseFlow.transfer.stages')">
    <li v-for="(stage, index) in STAGES" :key="stage.id" class="wb-rf-stage" :class="`is-${stageState(index)}`">
      <span class="wb-rf-stage-number">{{ index + 1 }}</span>
      <strong>{{ t(`releaseFlow.transfer.stage.${stage.id}`) }}</strong>
    </li>
  </ol>

  <ReleaseTaskPanel :flow="flow" task-id="client.transfer" log-expanded>
    <template #done="{ result }">
      <strong>{{ t('releaseFlow.transfer.done', { count: result.copiedFiles }) }}</strong>
      <span class="wb-rf-code wb-rf-muted">{{ result.outputDir }}</span>
    </template>
  </ReleaseTaskPanel>
</template>

<style scoped>
.wb-rf-template-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.wb-rf-template {
  display: grid;
  gap: 6px;
  height: auto;
  min-height: 0;
  padding: 16px 18px;
  border: 1px solid var(--wb-border);
  border-radius: 12px;
  background: var(--wb-table-surface);
  font-weight: 400;
  text-align: left;
}

.wb-rf-template[aria-checked="true"] {
  border-color: var(--wb-accent);
  background: color-mix(in srgb, var(--wb-accent-soft) 50%, var(--wb-table-surface));
}

.wb-rf-template-name {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--wb-text);
  font-size: var(--wb-fs-title);
}

.wb-rf-template-check {
  margin-left: auto;
  color: var(--wb-accent-strong);
}

.wb-rf-template .wb-rf-code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-stages {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wb-rf-stage {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--wb-rf-sunken);
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-body);
}

.wb-rf-stage strong {
  font-weight: 600;
}

.wb-rf-stage-number {
  display: grid;
  flex: none;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--wb-table-surface);
  font-size: var(--wb-fs-caption);
  font-weight: 700;
}

.wb-rf-stage.is-running {
  background: var(--wb-accent-soft);
  color: var(--wb-text);
}

.wb-rf-stage.is-done {
  color: var(--wb-success-text);
}

.wb-rf-stage.is-done .wb-rf-stage-number {
  background: var(--wb-success-surface);
}

.wb-rf-template-new {
  flex-wrap: wrap;
  align-items: center;
  max-width: none;
}

.wb-rf-template-new input {
  width: 260px;
}

.wb-rf-facts.is-rows {
  display: grid;
  gap: 12px;
}

.wb-rf-facts.is-rows .wb-rf-fact {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.wb-rf-facts.is-rows dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
  margin: 0;
}

.wb-rf-fact-actions {
  display: inline-flex;
  gap: 4px;
}
</style>
