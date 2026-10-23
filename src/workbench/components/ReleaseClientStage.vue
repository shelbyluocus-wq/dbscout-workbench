<script setup>
import { computed, ref, watch } from "vue";
import { t } from "../i18n/index.js";
import { releaseFilePreview } from "../releaseWorkflowState.js";
import ReleaseActionList from "./ReleaseActionList.vue";

const props = defineProps({ workflow: { type: Object, required: true }, templates: { type: Array, default: () => [] } });
const { config, draft, busy, conflictDemo } = props.workflow;
const files = computed(() => releaseFilePreview(config.value.fileExclusions));
const selectedPath = ref(files.value[0].path);
const selectedFile = computed(() => files.value.find((file) => file.path === selectedPath.value));
const selectedTemplate = computed(() => props.templates.find((template) => template.id === config.value.templateId));
watch(() => [config.value.templateId, props.templates, busy.value], () => {
  if (!busy.value && config.value.templateId !== "demo" && !selectedTemplate.value) {
    props.workflow.updateConfig("templateId", "demo", 2);
  }
}, { immediate: true, deep: true });
const update = (key, event) => props.workflow.updateConfig(key, event.target.value, 2);
</script>

<template>
  <div class="rw-form-grid">
    <label class="rw-field">{{ t('release.sourceClient') }}<input :value="config.sourceClient" :disabled="!!busy" @input="update('sourceClient', $event)"></label>
    <label class="rw-field">{{ t('release.targetClient') }}<input :value="config.targetClient" :disabled="!!busy" @input="update('targetClient', $event)"></label>
    <label class="rw-field">{{ t('release.fileExclusions') }}<textarea :value="config.fileExclusions" :disabled="!!busy" rows="4" @input="update('fileExclusions', $event)" /><small>{{ t('release.fileExclusionsHint') }}</small></label>
    <div>
      <label class="rw-field">{{ t('release.transferTemplate') }}
        <select :value="config.templateId" :disabled="!!busy" @change="update('templateId', $event)"><option value="demo">{{ t('release.demoTemplate') }}</option><option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option></select>
        <small>{{ t('release.templateHint') }}</small>
      </label>
      <p v-if="selectedTemplate" class="rw-help rw-wrap"><strong>{{ t('release.script') }}:</strong> {{ selectedTemplate.scriptPath || t('release.notConfigured') }}<br><strong>{{ t('release.targetClient') }}:</strong> {{ selectedTemplate.projectRoot || t('release.notConfigured') }}</p>
    </div>
  </div>
  <label class="rw-check"><input v-model="conflictDemo" type="checkbox" :disabled="!!busy || !!draft.results.svn">{{ t('release.simulateConflict') }}</label>
  <section v-if="draft.results.svn === 'blocked'" class="rw-warning-panel" role="alert">
    <h3>{{ t('release.conflictTitle') }}</h3><p>{{ t('release.conflictHint') }}</p>
    <label v-for="(file, key) in { code: 'assets/scripts/Channel.ts', config: 'settings/platform.json' }" :key="key" class="rw-conflict-row"><code>{{ file }}</code>
      <select v-model="draft.conflicts[key]" :aria-label="file" :disabled="!!busy"><option :value="undefined" disabled>{{ t('release.choose') }}</option><option value="local">{{ t('release.local') }}</option><option value="remote">{{ t('release.remote') }}</option></select>
    </label>
  </section>
  <ReleaseActionList :workflow="workflow" :actions="['svn', 'copy', 'transfer']" />
  <section class="rw-section">
    <h3>{{ t('release.diffTitle') }}</h3><p class="rw-help">{{ t('release.diffHint') }}</p>
    <div class="rw-diff">
      <div class="rw-file-list" role="group" :aria-label="t('release.diffTitle')">
        <button v-for="file in files" :key="file.path" type="button" :class="{ 'is-selected': file.path === selectedPath }" :aria-pressed="file.path === selectedPath" @click="selectedPath = file.path"><code>{{ file.path }}</code><span class="rw-tag" :class="{ 'is-open': !file.excluded }">{{ t(`release.${file.excluded ? 'excluded' : 'modified'}`) }}</span></button>
      </div>
      <div class="rw-diff-code">
        <p><code>{{ selectedFile.path }}</code></p>
        <p v-if="selectedFile.excluded" class="rw-help">{{ t('release.excluded') }}</p>
        <template v-else><span class="rw-help">{{ t('release.before') }}</span><pre class="rw-code-before">- {{ selectedFile.before }}</pre><span class="rw-help">{{ t('release.after') }}</span><pre class="rw-code-after">+ {{ selectedFile.after }}</pre></template>
      </div>
    </div>
    <label class="rw-check"><input v-model="draft.checks.diff" type="checkbox" :disabled="!!busy || draft.results.transfer !== 'done' || draft.results.diff === 'done'">{{ t('release.reviewDiff') }}</label>
    <ReleaseActionList :workflow="workflow" :actions="['diff']" />
  </section>
</template>
