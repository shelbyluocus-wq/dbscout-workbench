<script setup>
// Phase 3: build the platform client with the installed Cocos Creator, for
// real: the same settings and checks as the client build page (they are the
// platform's), the editor's live output as the step's log, then the
// client's release guard on the output. The build is confirmed with what it
// uses and where it writes before it starts.
import { computed, onBeforeUnmount } from "vue";
import { t } from "../i18n/index.js";
import { useCocosBuildTool } from "../composables/useCocosBuild.js";
import { describeCocosExit } from "../utils/cocosBuildCommand.js";
import { formatReleaseCount } from "../utils/releaseFlowFormat.js";
import { isTauriRuntime } from "../utils/tauriBridge.js";
import ReleaseBuildPanel from "./ReleaseBuildPanel.vue";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
});
defineEmits(["run", "rerun", "navigate"]);

const preview = !isTauriRuntime();
const platform = computed(() => props.flow.platform.value);
const tool = useCocosBuildTool({
  workspace: props.workspace,
  targetId: () => platform.value.id,
  target: () => platform.value,
});
onBeforeUnmount(() => tool.dispose());

const locked = computed(() => props.flow.busy.value || props.flow.finished.value);

function failureText(result, error) {
  if (error === "buildPrecheck") {
    const [problem] = result?.problems || [];
    return problem ? t(`releaseFlow.build.problem.${problem.code}`, { engine: problem.engine || "", editor: problem.editor || "" }) : t("releaseFlow.error.buildPrecheck");
  }
  if (error === "qaFindings") return t("releaseFlow.build.qa.findings", { count: result?.qa?.findings?.length || 0 });
  const code = Number.isFinite(result?.exitCode) ? result.exitCode : null;
  const meaning = t(`releaseFlow.cocos.exit.${describeCocosExit(result?.engineVersion || platform.value.cocosVersion, code)}`);
  return code === null ? meaning : t("releaseFlow.cocos.failed", { code, meaning });
}
</script>

<template>
  <ReleasePageHead page-id="build">
    <template #tag>
      <span class="wb-rf-chip" :class="preview ? 'is-quiet' : 'is-accent'">{{ t(preview ? 'releaseFlow.build.preview' : 'releaseFlow.real') }}</span>
    </template>
  </ReleasePageHead>

  <section class="wb-rf-card" aria-labelledby="wb-rf-cocos-settings">
    <div class="wb-rf-group-head"><h4 id="wb-rf-cocos-settings">{{ t('releaseFlow.build.settings') }}</h4></div>
    <ReleaseBuildPanel :tool="tool" :disabled="locked" />
  </section>

  <ReleaseTaskPanel :flow="flow" task-id="build.cocos" log-expanded>
    <template #done="{ result }">
      <strong>{{ t('releaseFlow.cocos.done', { code: result.exitCode }) }}</strong>
      <span v-if="result.qa?.status === 'passed'">{{ t('releaseFlow.cocos.qaPassed', { count: formatReleaseCount(result.qa.checked) }) }}</span>
      <span v-else-if="result.qa?.status">{{ t(`releaseFlow.build.qa.${result.qa.status}`, { count: result.qa.findings?.length || 0 }) }}</span>
      <span v-if="result.simulated" class="wb-rf-chip is-quiet">{{ t('releaseFlow.build.simulatedResult') }}</span>
    </template>
    <template #failed="{ result, error }">
      <span>{{ failureText(result, error) }}</span>
    </template>
  </ReleaseTaskPanel>
</template>
