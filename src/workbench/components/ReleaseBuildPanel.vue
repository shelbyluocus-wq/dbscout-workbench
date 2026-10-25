<script setup>
// The settings and checks of a Cocos Creator build, shared by the client
// build page and an update's build step: the client project and its engine
// version, the editor (found ones offered), the platform, an exported build
// configuration, the output folder, and what stops or warns about the build
// before it starts. The command line it will run is shown for reference.
import { computed, onBeforeUnmount, ref } from "vue";
import { Check, CircleAlert, Copy, FileJson, FolderOpen, RefreshCw, TriangleAlert } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { cocosBuildCommand, cocosFamily, cocosPlatformsFor, isNativeCocosPlatform } from "../utils/cocosBuildCommand.js";
import ReleaseCombobox from "./ReleaseCombobox.vue";

const props = defineProps({
  tool: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
  projectLocked: { type: Boolean, default: false },
});

const state = props.tool.state;
const options = computed(() => props.tool.options.value);
const target = computed(() => props.tool.target.value || {});
const engine = computed(() => props.tool.engineVersion.value);
const family = computed(() => cocosFamily(engine.value || options.value.version) || 3);
const platforms = computed(() => cocosPlatformsFor(engine.value || options.value.version));
const problems = computed(() => props.tool.problems.value);
const command = computed(() => cocosBuildCommand({ ...options.value, version: engine.value || options.value.version }));
const output = computed(() => state.output);
const platformDraft = ref(options.value.platform);
const copied = ref(false);
let copiedTimer = null;
onBeforeUnmount(() => clearTimeout(copiedTimer));

function field(key, value) {
  props.tool.update({ [key]: value });
}

async function pick(kind) {
  const backend = props.tool.backend;
  const start = kind === "editor" ? options.value.editorPath : options.value.projectPath;
  const picked = await (kind === "editor" ? backend.pickEditor(start) : kind === "project" ? backend.pickProject(start) : backend.pickConfig(start)).catch(() => null);
  if (!picked) return;
  if (kind === "editor") field("cocosPath", picked);
  else if (kind === "project") field("targetClient", picked);
  else field("buildConfig", picked);
}

function useEditor(editor) {
  props.tool.update({ cocosPath: editor.path, cocosVersion: editor.version || options.value.version });
}

function setPlatform(value) {
  platformDraft.value = value;
  field("buildPlatform", String(value || "").trim());
}

async function copyCommand() {
  try {
    await navigator.clipboard.writeText(command.value.display);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}

function problemText(problem) {
  return t(`releaseFlow.build.problem.${problem.code}`, { engine: problem.engine || "", editor: problem.editor || "" });
}
</script>

<template>
  <div class="wb-rf-build-panel">
    <div class="wb-rf-build-facts">
      <span v-if="state.inspecting" class="wb-rf-muted">{{ t('releaseFlow.build.inspecting') }}</span>
      <template v-else>
        <span class="wb-rf-chip" :class="engine ? 'is-accent' : 'is-quiet'">
          {{ engine ? t('releaseFlow.build.engine', { version: engine }) : t('releaseFlow.build.engineUnknown') }}
        </span>
        <span v-if="state.project?.editorVersion" class="wb-rf-chip">{{ t('releaseFlow.build.editor', { version: state.project.editorVersion }) }}</span>
        <span v-if="state.project?.qaGuard" class="wb-rf-chip">{{ t('releaseFlow.build.hasGuard') }}</span>
      </template>
      <button type="button" class="wb-rf-btn is-small is-quiet" :disabled="state.inspecting" @click="tool.inspect()">
        <RefreshCw :size="13" :class="{ 'wb-rf-spin': state.inspecting }" aria-hidden="true" />{{ t('releaseFlow.build.recheck') }}
      </button>
    </div>

    <div class="wb-rf-build-fields">
      <label class="wb-rf-field is-wide">
        {{ t('releaseFlow.build.project') }}
        <span class="wb-rf-path-field">
          <input
            class="wb-rf-code"
            :value="target.targetClient"
            :disabled="disabled || projectLocked"
            spellcheck="false"
            data-build-project
            @change="field('targetClient', $event.target.value)"
          />
          <button v-if="!projectLocked" type="button" class="wb-rf-btn" :disabled="disabled" @click="pick('project')">
            <FolderOpen :size="14" aria-hidden="true" />{{ t('releaseFlow.build.choose') }}
          </button>
        </span>
      </label>
      <label class="wb-rf-field is-wide">
        {{ t('releaseFlow.build.editorPath') }}
        <span class="wb-rf-path-field">
          <input class="wb-rf-code" :value="target.cocosPath" :disabled="disabled" spellcheck="false" data-build-editor @change="field('cocosPath', $event.target.value)" />
          <button type="button" class="wb-rf-btn" :disabled="disabled" @click="pick('editor')">
            <FolderOpen :size="14" aria-hidden="true" />{{ t('releaseFlow.build.choose') }}
          </button>
        </span>
      </label>
      <div v-if="state.editors.length" class="wb-rf-field is-wide">
        {{ t('releaseFlow.build.found') }}
        <div class="wb-rf-chips">
          <button
            v-for="editor in state.editors"
            :key="editor.path"
            type="button"
            class="wb-rf-chip"
            :class="{ 'is-accent': editor.path === target.cocosPath }"
            :title="editor.path"
            :disabled="disabled"
            @click="useEditor(editor)"
          >
            <Check v-if="editor.path === target.cocosPath" :size="12" aria-hidden="true" />
            Cocos Creator {{ editor.version || '?' }} · {{ t(`releaseFlow.build.source.${editor.source}`) }}
          </button>
        </div>
      </div>
      <label class="wb-rf-field">
        {{ t('releaseFlow.build.version') }}
        <input class="wb-rf-code" :value="target.cocosVersion" :disabled="disabled" spellcheck="false" @change="field('cocosVersion', $event.target.value)" />
      </label>
      <div class="wb-rf-field">
        {{ t('releaseFlow.build.platform') }}
        <ReleaseCombobox
          v-model="platformDraft"
          :options="platforms"
          :label="t('releaseFlow.build.platform')"
          :disabled="disabled"
          @pick="setPlatform"
          @focusout="setPlatform(platformDraft)"
        />
      </div>
      <label class="wb-rf-field is-wide">
        {{ t('releaseFlow.build.config') }}
        <span class="wb-rf-path-field">
          <input
            class="wb-rf-code"
            :value="target.buildConfig"
            :placeholder="t('releaseFlow.build.configPlaceholder')"
            :disabled="disabled"
            spellcheck="false"
            @change="field('buildConfig', $event.target.value)"
          />
          <button type="button" class="wb-rf-btn" :disabled="disabled" @click="pick('config')">
            <FileJson :size="14" aria-hidden="true" />{{ t('releaseFlow.build.choose') }}
          </button>
        </span>
      </label>
      <div v-if="state.project?.buildConfigs?.length" class="wb-rf-field is-wide">
        {{ t('releaseFlow.build.foundConfigs') }}
        <div class="wb-rf-chips">
          <button
            v-for="config in state.project.buildConfigs"
            :key="config"
            type="button"
            class="wb-rf-chip"
            :class="{ 'is-accent': target.buildConfig === config }"
            :disabled="disabled"
            @click="field('buildConfig', config)"
          >{{ config }}</button>
        </div>
      </div>
      <label v-if="family >= 3" class="wb-rf-field">
        {{ t('releaseFlow.build.outputName') }}
        <input class="wb-rf-code" :value="target.buildOutputName" :placeholder="options.platform" :disabled="disabled" spellcheck="false" @change="field('buildOutputName', $event.target.value)" />
      </label>
      <div class="wb-rf-field wb-rf-build-flags">
        <label v-if="!options.configPath" class="wb-rf-check">
          <input type="checkbox" :checked="target.buildDebug" :disabled="disabled" @change="field('buildDebug', $event.target.checked)" />{{ t('releaseFlow.build.debug') }}
        </label>
        <label v-if="!options.configPath" class="wb-rf-check">
          <input type="checkbox" :checked="target.buildMd5Cache" :disabled="disabled" @change="field('buildMd5Cache', $event.target.checked)" />{{ t('releaseFlow.build.md5Cache') }}
        </label>
        <label class="wb-rf-check" :title="state.project?.qaGuard ? '' : t('releaseFlow.build.noGuard')">
          <input type="checkbox" :checked="target.buildQaGuard" :disabled="disabled || !state.project?.qaGuard" @change="field('buildQaGuard', $event.target.checked)" />{{ t('releaseFlow.build.qaGuard') }}
        </label>
      </div>
    </div>

    <p class="wb-rf-build-output">
      <span>{{ t('releaseFlow.build.outputTo') }}</span>
      <span class="wb-rf-code">{{ tool.outputDir.value || '—' }}</span>
      <span v-if="output?.exists && output.entries" class="wb-rf-warning-text">{{ t('releaseFlow.build.outputExists', { count: output.entries }) }}</span>
    </p>

    <ul v-if="problems.length" class="wb-rf-list wb-rf-build-problems">
      <li v-for="problem in problems" :key="problem.code" :class="`is-${problem.level}`">
        <CircleAlert v-if="problem.level === 'error'" :size="14" aria-hidden="true" />
        <TriangleAlert v-else :size="14" aria-hidden="true" />
        <span>{{ problemText(problem) }}</span>
      </li>
    </ul>
    <p v-if="isNativeCocosPlatform(engine || options.version, options.platform)" class="wb-rf-hint">{{ t('releaseFlow.build.nativeHint') }}</p>

    <details class="wb-rf-build-command">
      <summary>{{ t('releaseFlow.cocos.command') }}</summary>
      <div class="wb-rf-build-command-body">
        <pre class="wb-rf-log wb-rf-command">{{ command.display }}</pre>
        <button type="button" class="wb-rf-btn is-quiet is-small" @click="copyCommand">
          <Check v-if="copied" :size="13" aria-hidden="true" />
          <Copy v-else :size="13" aria-hidden="true" />
          {{ t(copied ? 'releaseFlow.cocos.copied' : 'releaseFlow.cocos.copy') }}
        </button>
      </div>
    </details>
  </div>
</template>
