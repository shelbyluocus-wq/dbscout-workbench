<script setup>
// Phase 2, step 3: run the platform's table conversion with a template from
// the one-click table transfer. Choosing a template here remembers it for
// the platform.
import { computed } from "vue";
import { Check, FileSpreadsheet, FileText, FolderOpen, TriangleAlert } from "lucide-vue-next";
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

function samePath(left, right) {
  const normalize = (value) => String(value || "").trim().replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

const projectMismatch = computed(() =>
  Boolean(selected.value?.projectRoot) && !samePath(selected.value.projectRoot, platform.value.targetClient));

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
  <div>
    <ReleasePageHead page-id="clientTransfer" />

    <div class="wb-rf-stack">
      <section class="wb-rf-section" aria-labelledby="wb-rf-transfer-templates">
        <div class="wb-rf-section-head">
          <h4 id="wb-rf-transfer-templates">{{ t('releaseFlow.transfer.templates') }}</h4>
          <span class="wb-rf-muted">{{ t('releaseFlow.transfer.templatesHint') }}</span>
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
              <FileSpreadsheet :size="14" aria-hidden="true" />
              <strong>{{ template.name }}</strong>
              <Check v-if="template.id === selected?.id" :size="14" class="wb-rf-template-check" aria-hidden="true" />
            </span>
            <span class="wb-rf-template-line"><FileText :size="12" aria-hidden="true" />
              <span class="wb-rf-code">{{ template.scriptPath || t('releaseFlow.transfer.noScript') }}</span>
            </span>
            <span class="wb-rf-template-line"><FolderOpen :size="12" aria-hidden="true" />
              <span class="wb-rf-code">{{ template.projectRoot || t('releaseFlow.transfer.noProject') }}</span>
            </span>
          </button>
        </div>
        <p v-else class="wb-rf-empty">{{ t('releaseFlow.transfer.empty') }}</p>
        <p v-if="projectMismatch" class="wb-rf-notice is-warning">
          <TriangleAlert :size="14" aria-hidden="true" />
          <span>{{ t('releaseFlow.transfer.mismatch', { project: selected.projectRoot, client: platform.targetClient }) }}</span>
        </p>
      </section>

      <ol class="wb-rf-list wb-rf-stages" :aria-label="t('releaseFlow.transfer.stages')">
        <li v-for="(stage, index) in STAGES" :key="stage.id" class="wb-rf-stage" :class="`is-${stageState(index)}`">
          <span class="wb-rf-stage-number">{{ index + 1 }}</span>
          <span>
            <strong>{{ t(`releaseFlow.transfer.stage.${stage.id}`) }}</strong>
            <small>{{ t(`releaseFlow.transfer.stage.${stage.id}.hint`) }}</small>
          </span>
        </li>
      </ol>

      <ReleaseTaskPanel :flow="flow" task-id="client.transfer">
        <template #done="{ result }">
          <strong>{{ t('releaseFlow.transfer.done', { count: result.copiedFiles }) }}</strong>
          <span class="wb-rf-code">{{ t('releaseFlow.transfer.output', { path: result.outputDir }) }}</span>
        </template>
      </ReleaseTaskPanel>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-template-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}

.wb-rf-template {
  display: grid;
  gap: 5px;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-field-surface);
  color: var(--wb-secondary-text);
  font-size: 12px;
  font-weight: 400;
  text-align: left;
}

.wb-rf-template[aria-checked="true"] {
  border-color: color-mix(in srgb, var(--wb-accent) 60%, transparent);
  background: var(--wb-accent-soft);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--wb-accent) 35%, transparent);
}

.wb-rf-template-name {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--wb-text);
  font-size: 13.5px;
}

.wb-rf-template-check {
  margin-left: auto;
  color: var(--wb-accent);
}

.wb-rf-template-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.wb-rf-template-line .wb-rf-code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-stages {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.wb-rf-stage {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  color: var(--wb-secondary-text);
}

.wb-rf-stage span:last-child {
  display: grid;
  gap: 2px;
}

.wb-rf-stage strong {
  color: var(--wb-text);
  font-size: 12.5px;
  font-weight: 600;
}

.wb-rf-stage small {
  font-size: 11.5px;
  line-height: 1.5;
}

.wb-rf-stage-number {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--wb-border-strong);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
}

.wb-rf-stage.is-running {
  border-color: color-mix(in srgb, var(--wb-accent) 50%, transparent);
  background: var(--wb-accent-soft);
}

.wb-rf-stage.is-running .wb-rf-stage-number {
  border-color: var(--wb-accent);
  color: var(--wb-accent);
}

.wb-rf-stage.is-done .wb-rf-stage-number {
  border-color: var(--wb-success-border);
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}
</style>
