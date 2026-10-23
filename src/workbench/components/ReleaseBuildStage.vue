<script setup>
import { computed } from "vue";
import { ExternalLink, PackageCheck, PackageOpen } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { releaseArtifact } from "../releaseWorkflowState.js";
import ReleaseActionList from "./ReleaseActionList.vue";

const props = defineProps({ workflow: { type: Object, required: true } });
const { config, draft, state, busy, buildFailureDemo } = props.workflow;
const artifact = computed(() => releaseArtifact(config.value, state.platform));
const legacy = computed(() => config.value.engineVersion.startsWith("2."));
const command = computed(() => `${JSON.stringify(config.value.engine)} ${legacy.value ? "--path" : "--project"} ${JSON.stringify(config.value.targetClient)} --build ${JSON.stringify(`platform=${config.value.buildTarget};configPath=${config.value.buildConfig}`)}`);
const docs = computed(() => legacy.value
  ? "https://docs.cocos.com/creator/2.4/manual/en/publish/publish-in-command-line.html"
  : "https://docs.cocos.com/creator/3.8/manual/en/editor/publish/publish-in-command-line.html");
const update = (key, event) => props.workflow.updateConfig(key, event.target.value, 3);
</script>

<template>
  <div class="rw-form-grid">
    <label class="rw-field">{{ t('release.engine') }}<input :value="config.engine" :disabled="!!busy" @input="update('engine', $event)"></label>
    <label class="rw-field">{{ t('release.engineVersion') }}<select :value="config.engineVersion" :disabled="!!busy" @change="update('engineVersion', $event)"><option>3.8.8</option><option>2.4.15</option></select></label>
    <label class="rw-field">{{ t('release.buildTarget') }}<select :value="config.buildTarget" :disabled="!!busy" @change="update('buildTarget', $event)"><option value="web-mobile">Web Mobile</option><option value="android">Android</option><option value="ios">iOS</option><option value="wechatgame">WeChat Mini Game</option></select></label>
    <label class="rw-field">{{ t('release.buildConfig') }}<input :value="config.buildConfig" :disabled="!!busy" @input="update('buildConfig', $event)"></label>
  </div>
  <section class="rw-section">
    <h3>{{ t('release.targetClient') }}</h3><code class="rw-wrap">{{ config.targetClient }}</code>
    <p class="rw-help">{{ t('release.buildHint') }}</p>
    <pre class="rw-command">{{ command }}</pre>
    <a class="rw-link" :href="docs" target="_blank" rel="noopener noreferrer">{{ t('release.docs') }}<ExternalLink :size="13" /></a>
  </section>
  <label class="rw-check"><input v-model="buildFailureDemo" type="checkbox" :disabled="!!busy || draft.results.build === 'done'">{{ t('release.buildFailure') }}</label>
  <p v-if="draft.results.build === 'failed'" class="rw-warning-panel" role="alert">{{ t('release.buildFailed') }}</p>
  <ReleaseActionList :workflow="workflow" :actions="['build']" />
  <section class="rw-artifact" :class="{ 'is-ready': draft.results.build === 'done' }">
    <PackageCheck v-if="draft.results.build === 'done'" :size="32" /><PackageOpen v-else :size="32" />
    <div><h3>{{ t('release.artifact') }}</h3><strong v-if="draft.results.build === 'done'">{{ artifact }}</strong><p>{{ t(`release.${draft.results.build === 'done' ? 'artifactVerified' : 'artifactPending'}`) }}</p></div>
  </section>
</template>
