<script setup>
// Phase 2, step 3: run the platform's table conversion with a template from
// the one-click table transfer. The template brings the conversion script;
// the output is always copied into the platform client. Choosing a template
// here remembers it for the platform.
import { computed } from "vue";
import { Check, FileSpreadsheet } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
defineEmits(["run", "rerun", "navigate"]);

const platform = computed(() => props.flow.platform.value);
const templates = computed(() => props.flow.templates.value);
const selected = computed(() => props.flow.selectedTemplate.value);
const busy = computed(() => props.flow.busy.value);
const task = computed(() => props.flow.state.tasks["client.transfer"]);

function fileName(path) {
  return String(path || "").split(/[\\/]/).pop();
}

const assetsFolder = computed(() => `${platform.value.targetClient.replace(/[\\/]+$/, "")}\\assets`);

const STAGES = Object.freeze([
  { id: "script", until: 0.7 },
  { id: "locate", until: 0.8 },
  { id: "copy", until: 1.01 },
]);

function stageState(index) {
  if (task.value.status === "done") return "done";
  if (task.value.status !== "running") return "pending";
  const fraction = props.flow.progress.fraction;
  const current = STAGES.findIndex((stage) => fraction < stage.until);
  if (index < current) return "done";
  return index === current ? "running" : "pending";
}

function choose(template) {
  props.flow.updatePlatform(platform.value.id, { transferTemplateId: template.id });
}
</script>

<template>
  <ReleasePageHead page-id="clientTransfer" />

  <section class="wb-rf-group" aria-labelledby="wb-rf-transfer-templates">
    <div class="wb-rf-group-head">
      <h4 id="wb-rf-transfer-templates">{{ t('releaseFlow.transfer.templates') }}</h4>
      <span class="wb-rf-count">{{ t('releaseFlow.transfer.templatesHint') }}</span>
    </div>
    <div v-if="templates.length" class="wb-rf-template-list" role="radiogroup" :aria-label="t('releaseFlow.transfer.templates')">
      <button
        v-for="template in templates"
        :key="template.id"
        type="button"
        role="radio"
        class="wb-rf-template"
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
    <p class="wb-rf-hint">{{ t('releaseFlow.transfer.target') }} <span class="wb-rf-code">{{ assetsFolder }}</span></p>
  </section>

  <ol class="wb-rf-list wb-rf-stages" :aria-label="t('releaseFlow.transfer.stages')">
    <li v-for="(stage, index) in STAGES" :key="stage.id" class="wb-rf-stage" :class="`is-${stageState(index)}`">
      <span class="wb-rf-stage-number">{{ index + 1 }}</span>
      <strong>{{ t(`releaseFlow.transfer.stage.${stage.id}`) }}</strong>
    </li>
  </ol>

  <ReleaseTaskPanel :flow="flow" task-id="client.transfer">
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
  border-color: color-mix(in srgb, var(--wb-accent) 65%, transparent);
  box-shadow: 0 0 0 3px var(--wb-accent-soft);
}

.wb-rf-template-name {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--wb-text);
  font-size: 14px;
}

.wb-rf-template-check {
  margin-left: auto;
  color: var(--wb-accent);
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
  font-size: 13px;
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
  font-size: 11px;
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
</style>
