<script setup>
// One record of the history: for an update its brief and every step with its
// time, result, errors and warnings (logs on demand); for a client build the
// project, versions, output and release guard; for an SVN operation the
// files, revision and message.
import { computed } from "vue";
import { FolderOpen } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { tPlatform } from "../utils/platformLabels.js";
import { RELEASE_SCOPES } from "../releaseFlowState.js";
import { describeCocosExit } from "../utils/cocosBuildCommand.js";
import {
  formatDateTime,
  formatReleaseDate,
  formatReleaseDuration,
  releaseErrorText,
  stepResultText,
  taskTitle,
} from "../utils/releaseFlowFormat.js";
import { historyTitle } from "../utils/releaseHistoryFormat.js";
import { invokeWorkbench, isTauriRuntime } from "../utils/tauriBridge.js";
import ReleaseStatusIcon from "./ReleaseStatusIcon.vue";
import ReleaseTaskLog from "./ReleaseTaskLog.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
  entry: { type: Object, required: true },
});

const duration = computed(() => (props.entry.finishedAt > props.entry.startedAt ? formatReleaseDuration(props.entry.finishedAt - props.entry.startedAt) : ""));
const scopes = computed(() => RELEASE_SCOPES.filter((scope) => props.entry.brief?.scope?.[scope]));
const details = computed(() => props.entry.details || {});
const platform = computed(() => props.workspace.platformById(props.entry.platformId));
const canReveal = computed(() => isTauriRuntime() && !props.entry.demo && details.value.outputDir);

function stepStatus(step) {
  return step.status === "idle" ? "pending" : step.status;
}

function stepWarnings(step) {
  return Array.isArray(step.result?.warnings) ? step.result.warnings : [];
}

function buildOutcome() {
  if (details.value.error) return details.value.error;
  return t(`releaseFlow.cocos.exit.${describeCocosExit(details.value.engineVersion, details.value.exitCode)}`);
}

function reveal() {
  void invokeWorkbench("reveal_local_path", { path: details.value.outputDir }).catch(() => {});
}
</script>

<template>
  <article class="wb-rf-card wb-rf-history-detail" :aria-label="historyTitle(entry)">
    <header class="wb-rf-history-detail-head">
      <div>
        <h4>{{ entry.platformName || t('releaseFlow.history.noPlatform') }} · {{ historyTitle(entry) }}</h4>
        <p class="wb-rf-hint">
          {{ formatDateTime(entry.startedAt) }} → {{ formatDateTime(entry.finishedAt) }}<template v-if="duration"> · {{ duration }}</template>
        </p>
      </div>
      <span v-if="entry.demo" class="wb-rf-chip is-quiet" :title="t('releaseFlow.history.demoHint')">{{ t('releaseFlow.history.demo') }}</span>
      <span v-else class="wb-rf-chip is-accent">{{ t('releaseFlow.real') }}</span>
    </header>

    <template v-if="entry.kind === 'release'">
      <div class="wb-rf-history-brief">
        <span class="wb-rf-chip">{{ formatReleaseDate(entry.brief?.date) }}</span>
        <span v-for="scope in scopes" :key="scope" class="wb-rf-chip">{{ t(`releaseFlow.scope.${scope}`) }}</span>
      </div>
      <p class="wb-rf-history-stats">
        {{ t('releaseFlow.history.steps', { done: entry.stats.done, total: entry.stats.total }) }}
        <span v-if="entry.stats.failed" class="is-danger"> · {{ t('releaseFlow.history.failedSteps', { count: entry.stats.failed }) }}</span>
        <span v-if="entry.stats.warnings" class="is-warning"> · {{ t('releaseFlow.history.warnings', { count: entry.stats.warnings }) }}</span>
      </p>
      <ol class="wb-rf-list wb-rf-history-steps">
        <li v-for="step in entry.steps" :key="step.taskId" :class="`is-${stepStatus(step)}`">
          <ReleaseStatusIcon :status="stepStatus(step)" :size="15" />
          <div class="wb-rf-history-step">
            <div class="wb-rf-history-step-line">
              <strong>{{ taskTitle(step.taskId) }}</strong>
              <span v-if="step.finishedAt" class="wb-rf-muted">{{ formatDateTime(step.finishedAt) }}</span>
            </div>
            <span v-if="step.status === 'done' || step.status === 'skipped'" class="wb-rf-history-result">
              {{ stepResultText(step.taskId, step, { cocosVersion: platform?.cocosVersion }) }}
            </span>
            <span v-else-if="step.status === 'failed'" class="wb-rf-history-result is-danger">{{ releaseErrorText(step.error) }}</span>
            <span v-else class="wb-rf-history-result wb-rf-muted">{{ t(`releaseFlow.history.step.${step.status}`) }}</span>
            <ul v-if="stepWarnings(step).length" class="wb-rf-list wb-rf-history-warnings">
              <li v-for="warning in stepWarnings(step)" :key="warning.path">{{ t('releaseFlow.history.missingFile', { path: warning.path }) }}</li>
            </ul>
            <details v-if="step.logs?.length" class="wb-rf-history-log">
              <summary>{{ t('releaseFlow.task.showLog') }}</summary>
              <ReleaseTaskLog :lines="step.logs" />
            </details>
          </div>
        </li>
      </ol>
    </template>

    <template v-else-if="entry.kind === 'build'">
      <dl class="wb-rf-facts">
        <div class="wb-rf-fact"><dt>{{ t('releaseFlow.build.project') }}</dt><dd class="wb-rf-code">{{ details.project }}</dd></div>
        <div class="wb-rf-fact"><dt>{{ t('releaseFlow.cocos.version') }}</dt><dd class="wb-rf-code">{{ details.engineVersion || '—' }} · {{ details.platform }}</dd></div>
        <div class="wb-rf-fact"><dt>{{ t('releaseFlow.cocos.output') }}</dt><dd class="wb-rf-code">{{ details.outputDir }}</dd></div>
      </dl>
      <p class="wb-rf-history-result" :class="{ 'is-danger': entry.outcome === 'failed' }">
        {{ entry.outcome === 'done' ? t('releaseFlow.build.done', { code: details.exitCode }) : buildOutcome() }}
        <template v-if="details.qa?.status === 'passed'"> · {{ t('releaseFlow.cocos.qaPassed', { count: details.qa.checked }) }}</template>
        <template v-else-if="details.qa?.status"> · {{ t(`releaseFlow.build.qa.${details.qa.status}`, { count: details.qa.findings?.length || 0 }) }}</template>
      </p>
      <button v-if="canReveal" type="button" class="wb-rf-btn is-small" @click="reveal">
        <FolderOpen :size="13" aria-hidden="true" />{{ tPlatform('releaseFlow.build.openOutput') }}
      </button>
      <ReleaseTaskLog v-if="entry.logs?.length" :lines="entry.logs" />
    </template>

    <template v-else>
      <dl class="wb-rf-facts">
        <div class="wb-rf-fact"><dt>{{ t('releaseFlow.svn.workingCopy') }}</dt><dd class="wb-rf-code">{{ details.root }}</dd></div>
        <div v-if="details.revision" class="wb-rf-fact"><dt>{{ t('releaseFlow.svn.revision') }}</dt><dd class="wb-rf-code">r{{ details.revision }}</dd></div>
        <div v-if="details.accept" class="wb-rf-fact"><dt>{{ t('releaseFlow.svn.resolveWith') }}</dt><dd>{{ t(`releaseFlow.svn.accept.${details.accept}`) }}</dd></div>
      </dl>
      <p v-if="details.message" class="wb-rf-history-message">{{ details.message }}</p>
      <p v-if="details.error" class="wb-rf-history-result is-danger">{{ details.error }}</p>
      <ul class="wb-rf-list wb-rf-history-files">
        <li v-for="path in details.paths || []" :key="path" class="wb-rf-code">{{ path }}</li>
      </ul>
    </template>
  </article>
</template>
