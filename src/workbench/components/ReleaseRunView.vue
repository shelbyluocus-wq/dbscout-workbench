<script setup>
// One update on screen: the page of its current step and the footer with the
// one next action. Steps that are simulated say so in their confirmations;
// the build step runs Cocos Creator for real. In one-click mode the bar above
// the page follows the run and the footer only offers to pause it.
import { computed, inject, provide } from "vue";
import { ArrowLeft, ArrowRight, LoaderCircle, Zap } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useConfirm } from "../composables/useConfirm.js";
import { cocosBuildConfirmOptions, createCocosBackend } from "../composables/useCocosBuild.js";
import { cocosOutputDir } from "../utils/cocosBuildCommand.js";
import { isTauriRuntime } from "../utils/tauriBridge.js";
import {
  RELEASE_PAGE_BY_ID,
  RELEASE_TASK_BY_ID,
  TASK_STATUS,
  adjacentPage,
  dependentsOf,
  missingDependencies,
  nextTaskOnPage,
} from "../releaseFlowState.js";
import { autopilotRuleSummary, formatReleaseDate, pageTitle, releaseErrorText, taskTitle } from "../utils/releaseFlowFormat.js";
import ReleaseAutopilotBar from "./ReleaseAutopilotBar.vue";
import ReleaseFlowOverview from "./ReleaseFlowOverview.vue";
import ReleaseDatabasePage from "./ReleaseDatabasePage.vue";
import ReleaseSvnPage from "./ReleaseSvnPage.vue";
import ReleaseFileSyncPage from "./ReleaseFileSyncPage.vue";
import ReleaseTransferPage from "./ReleaseTransferPage.vue";
import ReleaseDiffPage from "./ReleaseDiffPage.vue";
import ReleaseCocosPage from "./ReleaseCocosPage.vue";
import ReleaseFlowSummary from "./ReleaseFlowSummary.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
  flow: { type: Object, required: true },
  transfer: { type: Object, default: null },
  exclusionTemplates: { type: Array, default: () => [] },
});

const openNewUpdate = inject("releaseNewUpdate", () => {});
const { confirm } = useConfirm();
const state = props.flow.state;

const PAGE_COMPONENTS = {
  brief: ReleaseFlowOverview,
  database: ReleaseDatabasePage,
  clientSvn: ReleaseSvnPage,
  clientSync: ReleaseFileSyncPage,
  clientTransfer: ReleaseTransferPage,
  clientDiff: ReleaseDiffPage,
  build: ReleaseCocosPage,
  summary: ReleaseFlowSummary,
};
// Pages built around wide tables or two columns get more room.
const WIDE_PAGES = new Set(["clientSync", "clientDiff", "build"]);
// Real operations, so their confirmations carry no demo note.
const REAL_TASKS = new Set(["build.cocos"]);
const CONFIRMED_TASKS = new Set(["db.sync", "db.restore"]);

const pageComponent = computed(() => PAGE_COMPONENTS[state.page] || ReleaseFlowOverview);
const pageProps = computed(() => {
  const base = { flow: props.flow, workspace: props.workspace };
  if (state.page === "database") return { ...base, exclusionTemplates: props.exclusionTemplates };
  if (state.page === "clientTransfer") return { ...base, transfer: props.transfer };
  return base;
});
const busy = computed(() => props.flow.busy.value);
const platform = computed(() => props.flow.platform.value);
const runContext = computed(() => [platform.value.name, formatReleaseDate(state.brief.date)].join(" · "));
provide("releaseRunContext", runContext);

/* ── Footer: the one next action of the current page ── */
function blockerText(taskId, blocker) {
  if (blocker === "notStarted") return t("releaseFlow.blocker.notStarted");
  if (blocker === "busy") return t("releaseFlow.blocker.busy");
  if (blocker === "dependency") {
    const [missing] = missingDependencies(taskId, state.tasks, state.brief);
    return t("releaseFlow.blocker.dependency", { step: taskTitle(missing) });
  }
  return "";
}

function runLabel(taskId) {
  if (taskId === "db.plans") {
    const { open, close } = props.flow.planCounts.value;
    return open + close ? t("releaseFlow.task.db.plans.runCount", { count: open + close }) : t("releaseFlow.task.db.plans.runNone");
  }
  return t(`releaseFlow.task.${taskId}.run`);
}

function nextStep(pageId) {
  const nextPage = adjacentPage(pageId, state.brief, 1);
  return {
    status: nextPage === "summary"
      ? t("releaseFlow.footer.doneLast")
      : t("releaseFlow.footer.doneNext", { step: pageTitle(nextPage) }),
    primary: { label: t(nextPage === "summary" ? "releaseFlow.footer.toSummary" : "releaseFlow.footer.next"), action: "next" },
  };
}

function runningFooter() {
  return {
    status: t("releaseFlow.footer.running", { step: taskTitle(props.flow.runningTask.value) }),
    running: true,
    primary: { label: t("releaseFlow.footer.runningButton"), disabled: true },
  };
}

const autopilot = props.flow.autopilot;
const autoActive = computed(() => autopilot.active.value);
// One-click mode can take over an open update from wherever it is.
const autoOffered = computed(() => !props.flow.finished.value && !autoActive.value && autopilot.status.value !== "paused"
  && (state.brief.started || props.flow.canStart.value));

const footer = computed(() => {
  const flow = props.flow;
  const pageId = state.page;
  if (autoActive.value) {
    if (flow.runningTask.value) return runningFooter();
    return {
      status: t("releaseFlow.autopilot.footer"),
      primary: { label: t("releaseFlow.autopilot.runningButton"), disabled: true },
    };
  }
  if (flow.finished.value) {
    // A finished update shows its result first; a new update starts from there.
    return {
      status: t("releaseFlow.footer.finished"),
      tone: "success",
      primary: pageId === "summary"
        ? { label: t("releaseFlow.footer.newRelease"), action: "newUpdate" }
        : { label: t("releaseFlow.footer.toSummary"), action: "summary" },
    };
  }
  if (pageId === "brief") {
    if (state.brief.started) return { ...nextStep("brief"), status: t("releaseFlow.footer.started") };
    return {
      status: flow.canStart.value ? t("releaseFlow.footer.ready") : t("releaseFlow.footer.confirmFirst"),
      primary: { label: t("releaseFlow.footer.start"), action: "start", disabled: !flow.canStart.value },
    };
  }
  if (pageId === "summary") {
    return {
      status: flow.complete.value ? t("releaseFlow.footer.complete") : t("releaseFlow.footer.incomplete"),
      primary: { label: t("releaseFlow.footer.newRelease"), action: "newUpdate", disabled: busy.value },
    };
  }
  if (flow.runningTask.value) return runningFooter();
  if (pageId === "clientSvn" && flow.conflictsPending.value) {
    const pending = flow.svnConflicts.value.filter((conflict) => !conflict.choice).length;
    return {
      status: pending ? t("releaseFlow.footer.conflictsLeft", { count: pending }) : t("releaseFlow.footer.conflictsChosen"),
      tone: "warning",
      primary: { label: t("releaseFlow.footer.resolve"), action: "resolve", disabled: pending > 0 },
    };
  }
  const page = RELEASE_PAGE_BY_ID.get(pageId);
  const tasks = page.tasks.filter((id) => flow.applies(id) && !RELEASE_TASK_BY_ID.get(id).action);
  const nextTask = nextTaskOnPage(pageId, state.tasks, state.brief);
  if (!nextTask) {
    const rerun = tasks.length === 1 && state.tasks[tasks[0]].status === TASK_STATUS.DONE ? tasks[0] : "";
    return { ...nextStep(pageId), tone: "success", rerun };
  }
  const blocker = flow.blockerOf(nextTask);
  const failed = state.tasks[nextTask].status === TASK_STATUS.FAILED;
  const definition = RELEASE_TASK_BY_ID.get(nextTask);
  let status = blockerText(nextTask, blocker);
  if (!status && failed) status = releaseErrorText(state.tasks[nextTask].error);
  if (!status && tasks.length > 1) {
    const settled = tasks.filter((id) => [TASK_STATUS.DONE, TASK_STATUS.SKIPPED].includes(state.tasks[id].status)).length;
    status = t("releaseFlow.footer.pageProgress", { done: settled, total: tasks.length });
  }
  const label = failed ? t("releaseFlow.footer.retry") : runLabel(nextTask);
  return {
    status,
    tone: failed ? "danger" : "",
    primary: { label, action: "run", taskId: nextTask, disabled: Boolean(blocker) },
    skip: definition.skippable && !blocker ? nextTask : "",
  };
});

function withConfirm(taskId, options) {
  const note = (props.flow.isReal?.value || REAL_TASKS.has(taskId)) ? undefined : t("releaseFlow.demo.confirmNote");
  return confirm({ note, cancelText: t("releaseFlow.cancel"), ...options });
}

function confirmOptions(taskId) {
  const target = platform.value;
  if (taskId === "db.sync") {
    return {
      title: t("releaseFlow.confirm.sync.title", { database: target.targetDatabase }),
      message: t("releaseFlow.confirm.sync.message", {
        source: target.sourceDatabase,
        target: target.targetDatabase,
        tables: props.flow.syncPlan.value.tables.length,
      }),
      confirmText: t("releaseFlow.confirm.sync.action"),
      danger: true,
    };
  }
  if (taskId === "db.restore") {
    const backup = props.flow.backup.value;
    return {
      title: t("releaseFlow.confirm.restore.title", { database: target.targetDatabase }),
      message: t("releaseFlow.confirm.restore.message", { database: target.targetDatabase, tables: backup?.tables || 0 }),
      items: props.flow.restoreImpact.value,
      confirmText: t("releaseFlow.confirm.restore.action"),
      danger: true,
    };
  }
  return {};
}

// A real build is confirmed with what it will use and where it writes.
const cocos = createCocosBackend();

async function confirmBuild() {
  const options = props.flow.buildOptions.value;
  const project = await cocos.inspect(options).catch(() => null);
  const outputDir = cocosOutputDir({ ...options, version: project?.engine?.version || options.version });
  const output = outputDir ? await cocos.outputStatus(outputDir).catch(() => null) : null;
  return confirm(cocosBuildConfirmOptions({ options, project, outputDir, output, preview: !isTauriRuntime() }));
}

async function runTask(taskId) {
  // In one-click mode the run decides; pause it to act by hand.
  if (autoActive.value) return;
  if (CONFIRMED_TASKS.has(taskId) && !(await withConfirm(taskId, confirmOptions(taskId)))) return;
  if (taskId === "build.cocos" && !(await confirmBuild())) return;
  await props.flow.runTask(taskId);
}

async function rerunTask(taskId) {
  const affected = dependentsOf(taskId).filter((id) => state.tasks[id].status !== TASK_STATUS.IDLE);
  if (affected.length && !(await withConfirm(taskId, {
    title: t("releaseFlow.confirm.rerun.title", { step: taskTitle(taskId) }),
    message: t("releaseFlow.confirm.rerun.message", { count: affected.length }),
    items: affected.map((id) => taskTitle(id)),
    confirmText: t("releaseFlow.confirm.rerun.action"),
  }))) return;
  await runTask(taskId);
}

async function skipTask(taskId) {
  if (autoActive.value) return;
  if (!(await withConfirm(taskId, {
    title: t("releaseFlow.confirm.skip.title", { step: taskTitle(taskId) }),
    message: t(`releaseFlow.task.${taskId}.skipHint`),
    confirmText: t("releaseFlow.confirm.skip.action"),
  }))) return;
  props.flow.skipTask(taskId);
}

function navigate(target) {
  // Workspace pages (open plans, the build page, …) open beside the update.
  if (!props.flow.go(target)) props.workspace.openSection(target);
}

/* ── One-click mode ── */
async function startAutopilot() {
  if (!autoOffered.value) return;
  if (!(await withConfirm("", {
    title: t("releaseFlow.autopilot.confirm.title", { platform: platform.value.name }),
    message: t(state.brief.started ? "releaseFlow.autopilot.confirm.messageRest" : "releaseFlow.autopilot.confirm.message", {
      count: progressLeft.value,
    }),
    items: autopilotRuleSummary(props.workspace.state.autopilot),
    confirmText: t("releaseFlow.autopilot.confirm.action"),
  }))) return;
  autopilot.start();
}

const progressLeft = computed(() => {
  const { done, total } = props.flow.progressSummary.value;
  return Math.max(0, total - done);
});

function primaryAction() {
  const action = footer.value.primary;
  if (!action || action.disabled) return;
  if (action.action === "start") props.flow.start();
  else if (action.action === "next") props.flow.step(1);
  else if (action.action === "run") void runTask(action.taskId);
  else if (action.action === "resolve") void props.flow.resolveConflicts();
  else if (action.action === "summary") props.flow.go("summary");
  else if (action.action === "newUpdate") openNewUpdate(platform.value.id);
}

const previousPage = computed(() => adjacentPage(state.page, state.brief, -1));
</script>

<template>
  <div class="wb-rf-run">
    <div class="wb-rf-page" data-release-scroll :data-release-current="state.page">
      <div class="wb-rf-page-inner" :class="{ 'is-wide': WIDE_PAGES.has(state.page) }">
        <ReleaseAutopilotBar v-if="autopilot.status.value !== 'off'" :flow="flow" :workspace="workspace" />
        <component
          :is="pageComponent"
          :key="state.page"
          v-bind="pageProps"
          @run="runTask"
          @rerun="rerunTask"
          @navigate="navigate"
        />
      </div>
    </div>
    <footer class="wb-rf-footer">
      <button v-if="previousPage" type="button" class="wb-rf-btn is-quiet" :disabled="busy" @click="flow.step(-1)">
        <ArrowLeft :size="14" aria-hidden="true" />{{ t('releaseFlow.footer.previous') }}
      </button>
      <div class="wb-rf-footer-status" :data-tone="footer.tone || undefined" aria-live="polite">
        <span>{{ footer.status }}</span>
      </div>
      <div class="wb-rf-footer-actions">
        <button v-if="footer.running" type="button" class="wb-rf-btn is-quiet" @click="flow.cancel()">{{ t('releaseFlow.footer.stop') }}</button>
        <button v-if="autoActive && !footer.running" type="button" class="wb-rf-btn is-quiet" data-release-auto-pause @click="autopilot.pause()">
          {{ t('releaseFlow.autopilot.pause') }}
        </button>
        <button v-if="autoOffered" type="button" class="wb-rf-btn" data-release-auto-start :disabled="busy" @click="startAutopilot">
          <Zap :size="14" aria-hidden="true" />{{ t(state.brief.started ? 'releaseFlow.autopilot.startRest' : 'releaseFlow.autopilot.start') }}
        </button>
        <button v-if="footer.rerun" type="button" class="wb-rf-btn is-quiet" :disabled="busy" @click="rerunTask(footer.rerun)">
          {{ t('releaseFlow.footer.rerun') }}
        </button>
        <button v-if="footer.skip" type="button" class="wb-rf-btn is-quiet" :disabled="busy" @click="skipTask(footer.skip)">
          {{ t('releaseFlow.footer.skip') }}
        </button>
        <button
          type="button"
          class="wb-rf-btn is-primary is-large"
          data-release-primary
          :disabled="footer.primary.disabled"
          @click="primaryAction"
        >
          <LoaderCircle v-if="footer.running" :size="15" class="wb-rf-spin" aria-hidden="true" />
          <span>{{ footer.primary.label }}</span>
          <ArrowRight v-if="footer.primary.action === 'next'" :size="15" aria-hidden="true" />
        </button>
      </div>
    </footer>
  </div>
</template>
