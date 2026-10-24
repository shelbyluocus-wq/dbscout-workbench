<script setup>
// Guided release workspace: one place that walks a release from the database
// overwrite through the client copy, the Cocos build and the GM operations.
// Progress is kept on this device, so the workspace can be closed and resumed.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowLeft, ArrowRight, FlaskConical, Rocket, SlidersHorizontal, X } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useConfirm } from "../composables/useConfirm.js";
import { useEscClose } from "../composables/useEscClose.js";
import { useReleaseFlow } from "../composables/useReleaseFlow.js";
import {
  RELEASE_PAGE_BY_ID,
  RELEASE_TASK_BY_ID,
  TASK_STATUS,
  adjacentPage,
  dependentsOf,
  missingDependencies,
  nextTaskOnPage,
} from "../releaseFlowState.js";
import { formatReleaseDate, pageTitle, releaseErrorText, taskTitle } from "../utils/releaseFlowFormat.js";
import ReleaseFlowRail from "./ReleaseFlowRail.vue";
import ReleaseFlowOverview from "./ReleaseFlowOverview.vue";
import ReleaseDatabaseSyncPage from "./ReleaseDatabaseSyncPage.vue";
import ReleasePlanBoard from "./ReleasePlanBoard.vue";
import ReleaseSvnPage from "./ReleaseSvnPage.vue";
import ReleaseFileSyncPage from "./ReleaseFileSyncPage.vue";
import ReleaseTransferPage from "./ReleaseTransferPage.vue";
import ReleaseDiffPage from "./ReleaseDiffPage.vue";
import ReleaseCocosPage from "./ReleaseCocosPage.vue";
import ReleaseGmTasksPage from "./ReleaseGmTasksPage.vue";
import ReleaseGmSchedulePage from "./ReleaseGmSchedulePage.vue";
import ReleaseFlowSummary from "./ReleaseFlowSummary.vue";
import "../releaseFlow.css";

const props = defineProps({
  templates: { type: Array, default: () => [] },
  exclusionTemplates: { type: Array, default: () => [] },
});

const emit = defineEmits(["close"]);

const flow = useReleaseFlow({ templates: () => props.templates });
const state = flow.state;
const dialogRef = ref(null);
const pageRef = ref(null);
const menuOpen = ref(false);
const menuRef = ref(null);
const menuButtonRef = ref(null);
const confirming = ref(false);
const { confirm } = useConfirm();

const busy = computed(() => flow.busy.value);
useEscClose(() => true, () => emit("close"), () => busy.value || confirming.value, { dialogRef });
onBeforeUnmount(() => flow.dispose());

const PAGE_COMPONENTS = {
  overview: ReleaseFlowOverview,
  dbSync: ReleaseDatabaseSyncPage,
  dbPlans: ReleasePlanBoard,
  clientSvn: ReleaseSvnPage,
  clientSync: ReleaseFileSyncPage,
  clientTransfer: ReleaseTransferPage,
  clientDiff: ReleaseDiffPage,
  build: ReleaseCocosPage,
  gmUpload: ReleaseGmTasksPage,
  gmSchedule: ReleaseGmSchedulePage,
  gmLaunch: ReleaseGmTasksPage,
  summary: ReleaseFlowSummary,
};

const pageComponent = computed(() => PAGE_COMPONENTS[state.page] || ReleaseFlowOverview);
const pageProps = computed(() => {
  if (state.page === "dbSync") return { flow, exclusionTemplates: props.exclusionTemplates };
  if (state.page === "gmUpload" || state.page === "gmLaunch") return { flow, pageId: state.page };
  return { flow };
});

const briefText = computed(() => [
  flow.platform.value.name,
  formatReleaseDate(state.brief.date),
  t(`releaseFlow.mode.${state.brief.mode}`),
].join(" · "));

function focusPageHeading() {
  pageRef.value?.querySelector("h3")?.focus({ preventScroll: true });
}

watch(
  () => state.page,
  async () => {
    menuOpen.value = false;
    await nextTick();
    if (pageRef.value) pageRef.value.scrollTop = 0;
    focusPageHeading();
  },
);

// Open on the page's heading rather than its first field, so opening the
// workspace never lands in a date picker by accident.
onMounted(() => void nextTick(focusPageHeading));

function navigate(pageId) {
  flow.go(pageId);
}

/* ── Footer: the one next action of the current page ── */
const CONFIRMED_TASKS = new Set(["db.sync", "gm.restart", "gm.open"]);

function blockerText(taskId, blocker) {
  if (blocker === "notStarted") return t("releaseFlow.blocker.notStarted");
  if (blocker === "busy") return t("releaseFlow.blocker.busy");
  if (blocker === "dependency") {
    const [missing] = missingDependencies(taskId, state.tasks, state.brief);
    return t("releaseFlow.blocker.dependency", { step: taskTitle(missing) });
  }
  return "";
}

const footer = computed(() => {
  const pageId = state.page;
  const nextPage = adjacentPage(pageId, state.brief, 1);
  const nextLabel = nextPage === "summary"
    ? t("releaseFlow.footer.toSummary")
    : t("releaseFlow.footer.next", { step: pageTitle(nextPage) });
  if (pageId === "overview") {
    if (state.brief.started) return { status: t("releaseFlow.footer.started"), primary: { label: nextLabel, action: "next" } };
    return {
      status: flow.canStart.value ? t("releaseFlow.footer.ready") : t("releaseFlow.footer.confirmFirst"),
      primary: { label: t("releaseFlow.footer.start"), action: "start", disabled: !flow.canStart.value },
    };
  }
  if (pageId === "summary") {
    return {
      status: flow.complete.value ? t("releaseFlow.footer.complete") : t("releaseFlow.footer.incomplete"),
      primary: { label: t("releaseFlow.footer.newRelease"), action: "restart", disabled: busy.value },
    };
  }
  const page = RELEASE_PAGE_BY_ID.get(pageId);
  const tasks = page.tasks.filter((id) => flow.applies(id));
  const running = flow.runningTask.value;
  if (running) {
    return {
      status: t("releaseFlow.footer.running", { step: taskTitle(running) }),
      running: true,
      primary: { label: t("releaseFlow.footer.runningButton"), disabled: true },
    };
  }
  if (pageId === "clientSvn" && flow.conflictsPending.value) {
    const pending = flow.svnConflicts.value.filter((conflict) => !conflict.choice).length;
    return {
      status: pending ? t("releaseFlow.footer.conflictsLeft", { count: pending }) : t("releaseFlow.footer.conflictsChosen"),
      tone: "warning",
      primary: { label: t("releaseFlow.footer.resolve"), action: "resolve", disabled: pending > 0 },
    };
  }
  const nextTask = nextTaskOnPage(pageId, state.tasks, state.brief);
  if (!nextTask) {
    const rerun = tasks.length === 1 && state.tasks[tasks[0]].status === TASK_STATUS.DONE ? tasks[0] : "";
    return {
      status: t("releaseFlow.footer.pageDone"),
      tone: "success",
      primary: { label: nextLabel, action: "next" },
      rerun,
    };
  }
  const blocker = flow.blockerOf(nextTask);
  const failed = state.tasks[nextTask].status === TASK_STATUS.FAILED;
  const definition = RELEASE_TASK_BY_ID.get(nextTask);
  // GM pages list operations as cards; the button names the one it runs.
  const multiple = tasks.length > 1;
  let status = blockerText(nextTask, blocker);
  if (!status && failed) status = releaseErrorText(state.tasks[nextTask].error);
  if (!status && multiple) {
    const settled = tasks.filter((id) => [TASK_STATUS.DONE, TASK_STATUS.SKIPPED].includes(state.tasks[id].status)).length;
    status = t("releaseFlow.footer.pageProgress", { done: settled, total: tasks.length });
  }
  let label = failed ? t("releaseFlow.footer.retry") : runLabel(nextTask);
  if (page.phase === "gm") label = failed ? t("releaseFlow.footer.retryStep", { step: taskTitle(nextTask) }) : taskTitle(nextTask);
  return {
    status,
    tone: failed ? "danger" : "",
    primary: { label, action: "run", taskId: nextTask, disabled: Boolean(blocker) },
    skip: definition.skippable && !blocker ? nextTask : "",
  };
});

function runLabel(taskId) {
  if (taskId === "db.plans") {
    const { open, close } = flow.planCounts.value;
    return open + close ? t("releaseFlow.task.db.plans.runCount", { count: open + close }) : t("releaseFlow.task.db.plans.runNone");
  }
  return t(`releaseFlow.task.${taskId}.run`);
}

async function withConfirm(options) {
  confirming.value = true;
  try {
    return await confirm({ note: t("releaseFlow.demo.confirmNote"), cancelText: t("releaseFlow.cancel"), ...options });
  } finally {
    confirming.value = false;
  }
}

function confirmOptions(taskId) {
  const platform = flow.platform.value;
  if (taskId === "db.sync") {
    return {
      title: t("releaseFlow.confirm.sync.title", { database: platform.targetDatabase }),
      message: t("releaseFlow.confirm.sync.message", {
        source: platform.sourceDatabase,
        target: platform.targetDatabase,
        tables: flow.syncPlan.value.tables.length,
        excluded: flow.syncPlan.value.excluded.length,
      }),
      confirmText: t("releaseFlow.confirm.sync.action"),
      danger: true,
    };
  }
  if (taskId === "gm.restart") {
    return {
      title: t("releaseFlow.confirm.restart.title"),
      message: t("releaseFlow.confirm.restart.message", { platform: platform.name }),
      confirmText: t("releaseFlow.confirm.restart.action"),
      danger: true,
    };
  }
  return {
    title: t("releaseFlow.confirm.open.title"),
    message: t("releaseFlow.confirm.open.message", { platform: platform.name }),
    confirmText: t("releaseFlow.confirm.open.action"),
  };
}

async function runTask(taskId) {
  if (CONFIRMED_TASKS.has(taskId) && !(await withConfirm(confirmOptions(taskId)))) return;
  await flow.runTask(taskId);
}

async function rerunTask(taskId) {
  const affected = dependentsOf(taskId).filter((id) => state.tasks[id].status !== TASK_STATUS.IDLE);
  if (affected.length && !(await withConfirm({
    title: t("releaseFlow.confirm.rerun.title", { step: taskTitle(taskId) }),
    message: t("releaseFlow.confirm.rerun.message", { count: affected.length }),
    items: affected.map((id) => taskTitle(id)),
    confirmText: t("releaseFlow.confirm.rerun.action"),
  }))) return;
  await runTask(taskId);
}

async function skipTask(taskId) {
  if (!(await withConfirm({
    title: t("releaseFlow.confirm.skip.title", { step: taskTitle(taskId) }),
    message: t(`releaseFlow.task.${taskId}.skipHint`),
    confirmText: t("releaseFlow.confirm.skip.action"),
  }))) return;
  flow.skipTask(taskId);
}

async function restart({ resetDemoData = false } = {}) {
  menuOpen.value = false;
  if (!(await withConfirm({
    title: t(resetDemoData ? "releaseFlow.confirm.resetDemo.title" : "releaseFlow.confirm.restart.flowTitle"),
    message: t(resetDemoData ? "releaseFlow.confirm.resetDemo.message" : "releaseFlow.confirm.restart.flowMessage"),
    confirmText: t(resetDemoData ? "releaseFlow.confirm.resetDemo.action" : "releaseFlow.footer.newRelease"),
    danger: resetDemoData,
  }))) return;
  flow.restart({ resetDemoData });
}

function primaryAction() {
  const action = footer.value.primary;
  if (!action || action.disabled) return;
  if (action.action === "start") flow.start();
  else if (action.action === "next") flow.step(1);
  else if (action.action === "run") void runTask(action.taskId);
  else if (action.action === "resolve") void flow.resolveConflicts();
  else if (action.action === "restart") void restart();
}

const previousPage = computed(() => adjacentPage(state.page, state.brief, -1));

/* ── Demo options ── */
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) void nextTick(() => menuRef.value?.querySelector("input, button")?.focus());
}

function onMenuKeydown(event) {
  if (event.key !== "Escape") return;
  // A prevented Escape keeps the dialog open; only the menu closes.
  event.preventDefault();
  menuOpen.value = false;
  menuButtonRef.value?.focus();
}

function onMenuFocusOut(event) {
  const next = event.relatedTarget;
  if (next && (menuRef.value?.contains(next) || menuButtonRef.value?.contains(next))) return;
  menuOpen.value = false;
}

function onDialogPointerDown(event) {
  if (!menuOpen.value) return;
  if (menuRef.value?.contains(event.target) || menuButtonRef.value?.contains(event.target)) return;
  menuOpen.value = false;
}
</script>

<template>
  <div class="wb-dialog-overlay">
    <section
      ref="dialogRef"
      class="wb-dialog wb-rf-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wb-rf-title"
      aria-describedby="wb-rf-brief"
      tabindex="-1"
      @pointerdown="onDialogPointerDown"
    >
      <header class="wb-rf-header">
        <span class="wb-rf-brand" aria-hidden="true"><Rocket :size="17" /></span>
        <div class="wb-rf-heading">
          <h2 id="wb-rf-title">{{ t('releaseFlow.title') }}</h2>
          <span id="wb-rf-brief" class="wb-rf-brief">{{ briefText }}</span>
        </div>
        <div class="wb-rf-header-actions">
          <span class="wb-rf-demo-badge" :title="t('releaseFlow.demo.badgeHint')">
            <FlaskConical :size="12" aria-hidden="true" />{{ t('releaseFlow.demo.badge') }}
          </span>
          <button
            ref="menuButtonRef"
            type="button"
            class="wb-rf-icon-btn"
            aria-haspopup="true"
            aria-controls="wb-rf-demo-menu"
            :aria-expanded="menuOpen"
            @click="toggleMenu"
          >
            <SlidersHorizontal :size="14" aria-hidden="true" />{{ t('releaseFlow.demo.options') }}
          </button>
          <div
            v-if="menuOpen"
            id="wb-rf-demo-menu"
            ref="menuRef"
            class="wb-rf-menu"
            role="group"
            :aria-label="t('releaseFlow.demo.options')"
            @keydown="onMenuKeydown"
            @focusout="onMenuFocusOut"
          >
            <p class="wb-rf-menu-title">{{ t('releaseFlow.demo.optionsHint') }}</p>
            <label>
              <input type="checkbox" :checked="state.demo.conflicts" @change="flow.setDemoOption('conflicts', $event.target.checked)" />
              {{ t('releaseFlow.demo.conflicts') }}
            </label>
            <label>
              <input type="checkbox" :checked="state.demo.buildFailure" @change="flow.setDemoOption('buildFailure', $event.target.checked)" />
              {{ t('releaseFlow.demo.buildFailure') }}
            </label>
            <div class="wb-rf-menu-row">
              <span>{{ t('releaseFlow.demo.speed') }}</span>
              <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.demo.speed')">
                <button
                  v-for="speed in ['normal', 'fast']"
                  :key="speed"
                  type="button"
                  role="radio"
                  :aria-checked="state.demo.speed === speed"
                  @click="flow.setDemoOption('speed', speed)"
                >{{ t(`releaseFlow.demo.speed.${speed}`) }}</button>
              </div>
            </div>
            <div class="wb-rf-menu-divider" />
            <button type="button" class="wb-rf-menu-action" :disabled="busy" @click="restart({ resetDemoData: true })">
              {{ t('releaseFlow.demo.reset') }}
            </button>
          </div>
          <button
            type="button"
            class="wb-rf-icon-btn wb-rf-close"
            :disabled="busy"
            :title="busy ? t('releaseFlow.closeBusy') : t('releaseFlow.close')"
            :aria-label="t('releaseFlow.close')"
            @click="emit('close')"
          >
            <X :size="17" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div class="wb-rf-body">
        <ReleaseFlowRail :flow="flow" @navigate="navigate" />
        <div class="wb-rf-main">
          <div ref="pageRef" class="wb-rf-page" :data-release-current="state.page">
            <component
              :is="pageComponent"
              :key="state.page"
              v-bind="pageProps"
              @run="runTask"
              @rerun="rerunTask"
              @navigate="navigate"
            />
          </div>
          <footer class="wb-rf-footer">
            <div class="wb-rf-footer-status" :data-tone="footer.tone || undefined" aria-live="polite">
              <span>{{ footer.status }}</span>
            </div>
            <button v-if="footer.running" type="button" class="wb-rf-ghost" @click="flow.cancel()">{{ t('releaseFlow.footer.stop') }}</button>
            <button v-if="footer.rerun" type="button" class="wb-rf-ghost" :disabled="busy" @click="rerunTask(footer.rerun)">
              {{ t('releaseFlow.footer.rerun') }}
            </button>
            <button v-if="footer.skip" type="button" class="wb-rf-ghost" :disabled="busy" @click="skipTask(footer.skip)">
              {{ t('releaseFlow.footer.skip') }}
            </button>
            <button v-if="previousPage" type="button" :disabled="busy" @click="flow.step(-1)">
              <ArrowLeft :size="13" aria-hidden="true" /> {{ t('releaseFlow.footer.previous') }}
            </button>
            <button
              type="button"
              class="wb-dialog-primary"
              data-release-primary
              :disabled="footer.primary.disabled"
              @click="primaryAction"
            >
              {{ footer.primary.label }}
              <ArrowRight v-if="footer.primary.action === 'next'" :size="13" aria-hidden="true" />
            </button>
          </footer>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wb-rf-footer-status[data-tone="success"] { color: var(--wb-success-text); }
.wb-rf-footer-status[data-tone="warning"] { color: var(--wb-warning-text); }
.wb-rf-footer-status[data-tone="danger"] { color: var(--wb-danger); }

.wb-rf-footer button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
