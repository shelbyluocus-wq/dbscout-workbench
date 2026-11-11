<script setup>
// The client build page: build a platform's client (or any other Cocos
// project) with the installed Cocos Creator, without running an update.
// Before a real build the confirmation names the project, versions, platform
// and output folder; when the platform's update has not reached its build
// step, it also says the full release has not run. Builds go to the history.
import { computed, onBeforeUnmount } from "vue";
import { CircleCheck, CircleX, FolderOpen, Package, Square } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { tPlatform } from "../utils/platformLabels.js";
import { useConfirm } from "../composables/useConfirm.js";
import { cocosBuildConfirmOptions, useCocosBuildTool } from "../composables/useCocosBuild.js";
import { TASK_STATUS } from "../releaseFlowState.js";
import { describeCocosExit } from "../utils/cocosBuildCommand.js";
import { formatReleaseDuration } from "../utils/releaseFlowFormat.js";
import { isTauriRuntime } from "../utils/tauriBridge.js";
import ReleaseBuildPanel from "./ReleaseBuildPanel.vue";
import ReleaseSectionHead from "./ReleaseSectionHead.vue";
import ReleaseTaskLog from "./ReleaseTaskLog.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const preview = !isTauriRuntime();
const { confirm } = useConfirm();
const tool = useCocosBuildTool({ workspace: props.workspace });
onBeforeUnmount(() => tool.dispose());

const state = tool.state;
const targetId = computed(() => tool.targetId.value);
const platforms = computed(() => props.workspace.state.platforms);
const result = computed(() => state.result);
const running = computed(() => tool.running.value);

// The platform's update reached its build step when its client steps are settled.
const flowReady = computed(() => {
  const run = props.workspace.runOf(targetId.value);
  const diff = run?.tasks["client.diff"]?.status;
  return diff === TASK_STATUS.DONE || diff === TASK_STATUS.SKIPPED;
});

function hints(lines) {
  const text = lines.map((line) => line.text).join("\n");
  const found = [];
  if (/android[_ ]?sdk|sdk (?:path|not found)|ANDROID_HOME/i.test(text)) found.push("sdk");
  if (/\bndk\b/i.test(text)) found.push("ndk");
  if (/java|jdk/i.test(text) && /not found|missing|找不到/i.test(text)) found.push("jdk");
  return found;
}

async function start() {
  const project = state.project;
  const confirmed = await confirm(cocosBuildConfirmOptions({
    options: tool.options.value,
    project,
    outputDir: tool.outputDir.value,
    output: state.output,
    direct: targetId.value !== "custom" && !flowReady.value,
    preview,
  }));
  if (!confirmed) return;
  await tool.build({ simulate: preview && props.workspace.state.demo.buildFailure ? "failure" : "" });
}

function reveal() {
  void tool.backend.reveal(result.value?.outputDir || tool.outputDir.value).catch(() => {});
}

function outcomeText() {
  if (state.error) return state.error;
  const value = result.value;
  if (!value) return "";
  if (value.outcome === "cancelled") return t("releaseFlow.build.cancelled");
  if (value.outcome === "success" && value.qa?.status === "findings") return t("releaseFlow.build.qa.findings", { count: value.qa.findings.length });
  return t(`releaseFlow.cocos.exit.${describeCocosExit(tool.engineVersion.value || tool.options.value.version, value.exitCode)}`);
}
</script>

<template>
  <ReleaseSectionHead :workspace="workspace" :title="t('releaseFlow.build.title')" :description="t('releaseFlow.build.description')">
    <template #tag>
      <span class="wb-rf-chip" :class="preview ? 'is-quiet' : 'is-accent'">{{ t(preview ? 'releaseFlow.build.preview' : 'releaseFlow.real') }}</span>
    </template>
  </ReleaseSectionHead>

  <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.build.target')">
    <button
      v-for="platform in platforms"
      :key="platform.id"
      type="button"
      role="radio"
      :aria-checked="targetId === platform.id"
      :disabled="running"
      :data-build-target="platform.id"
      @click="workspace.setBuildTarget(platform.id)"
    >{{ platform.name }}</button>
    <button type="button" role="radio" :aria-checked="targetId === 'custom'" :disabled="running" data-build-target="custom" @click="workspace.setBuildTarget('custom')">
      {{ t('releaseFlow.build.custom') }}
    </button>
  </div>

  <section class="wb-rf-card" aria-labelledby="wb-rf-build-settings">
    <div class="wb-rf-group-head"><h4 id="wb-rf-build-settings">{{ t('releaseFlow.build.settings') }}</h4></div>
    <ReleaseBuildPanel :tool="tool" :disabled="running" />
  </section>

  <section class="wb-rf-card" aria-labelledby="wb-rf-build-run">
    <div class="wb-rf-group-head">
      <h4 id="wb-rf-build-run">{{ t('releaseFlow.build.run') }}</h4>
      <div class="wb-rf-group-tools">
        <button v-if="running" type="button" class="wb-rf-btn" data-build-stop @click="tool.cancel()">
          <Square :size="13" aria-hidden="true" />{{ t('releaseFlow.footer.stop') }}
        </button>
        <button v-else type="button" class="wb-rf-btn is-primary" data-build-start :disabled="tool.blocked.value || state.inspecting" @click="start">
          <Package :size="14" aria-hidden="true" />{{ t('releaseFlow.build.start') }}
        </button>
      </div>
    </div>
    <p v-if="preview && !running && !result && !state.error" class="wb-rf-hint">{{ t('releaseFlow.build.previewHint') }}</p>
    <div v-if="running" class="wb-rf-task-running" role="status" aria-live="polite">
      <div class="wb-rf-task-line"><strong>{{ t('releaseFlow.build.running') }}</strong></div>
      <div class="wb-rf-progress is-indeterminate"><span /></div>
    </div>
    <div v-else-if="state.status === 'done'" class="wb-rf-task-line is-success" role="status">
      <CircleCheck :size="16" aria-hidden="true" />
      <div class="wb-rf-task-outcome">
        <strong>{{ t('releaseFlow.build.done', { code: result.exitCode }) }}</strong>
        <span v-if="result.qa?.status === 'passed'">{{ t('releaseFlow.cocos.qaPassed', { count: result.qa.checked }) }}</span>
        <span v-else-if="result.qa?.status">{{ t(`releaseFlow.build.qa.${result.qa.status}`, { count: result.qa.findings?.length || 0 }) }}</span>
        <span v-if="result.simulated" class="wb-rf-chip is-quiet">{{ t('releaseFlow.build.simulatedResult') }}</span>
      </div>
      <span class="wb-rf-task-duration">{{ formatReleaseDuration(state.finishedAt - state.startedAt) }}</span>
    </div>
    <div v-else-if="state.status === 'failed' || state.status === 'cancelled'" class="wb-rf-notice" :class="state.status === 'failed' ? 'is-danger' : 'is-warning'" role="alert">
      <CircleX :size="15" aria-hidden="true" />
      <div class="wb-rf-task-outcome">
        <span>{{ outcomeText() }}</span>
        <span v-for="hint in hints(state.lines)" :key="hint">{{ t(`releaseFlow.build.hint.${hint}`) }}</span>
      </div>
    </div>
    <div v-if="result?.outputDir && state.status === 'done'" class="wb-rf-build-result">
      <span class="wb-rf-code">{{ result.outputDir }}</span>
      <button v-if="!result.simulated" type="button" class="wb-rf-btn is-small" @click="reveal">
        <FolderOpen :size="13" aria-hidden="true" />{{ tPlatform('releaseFlow.build.openOutput') }}
      </button>
    </div>
    <ReleaseTaskLog v-if="state.lines.length" :lines="state.lines" />
  </section>
</template>
