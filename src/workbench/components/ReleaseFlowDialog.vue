<script setup>
// Release workspace: every platform's update on the left as cards, the open
// update's steps under its card, and the workspace pages (overview, history,
// open plans, client build, SVN, platform settings) in the header. Updates
// keep their own progress on this device, so the workspace can be closed and
// resumed, and several platforms can be updated side by side.
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from "vue";
import { CalendarCheck2, FolderGit2, History, LayoutDashboard, Minus, Package, Rocket, Server, X } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_TASKS, TASK_STATUS } from "../releaseFlowState.js";
import { useConfirm } from "../composables/useConfirm.js";
import { useEscClose } from "../composables/useEscClose.js";
import { useReleaseWorkspace } from "../composables/useReleaseWorkspace.js";
import { composeDrivers, createReleaseBuildDriver } from "../composables/useCocosBuild.js";
import { createReleaseRealDriver } from "../composables/useReleaseRealDriver.js";
import { createReleaseDemoDriver } from "../utils/releaseFlowDemoDriver.js";
import { isTauriRuntime } from "../utils/tauriBridge.js";
import ReleasePlatformBoard from "./ReleasePlatformBoard.vue";
import ReleaseDemoMenu from "./ReleaseDemoMenu.vue";
import ReleaseNewUpdateDialog from "./ReleaseNewUpdateDialog.vue";
import ReleaseHomePage from "./ReleaseHomePage.vue";
import ReleasePlatformPage from "./ReleasePlatformPage.vue";
import ReleaseRunView from "./ReleaseRunView.vue";
import ReleaseHistoryPage from "./ReleaseHistoryPage.vue";
import ReleasePlanBoard from "./ReleasePlanBoard.vue";
import ReleaseBuildPage from "./ReleaseBuildPage.vue";
import ReleaseSvnToolPage from "./ReleaseSvnToolPage.vue";
import ReleasePlatformsPage from "./ReleasePlatformsPage.vue";
import "../releaseFlow.css";
import "../releaseWorkspace.css";

const props = defineProps({
  minimized: { type: Boolean, default: false },
  connections: { type: Array, default: () => [] },
  databasesByConnection: { type: Object, default: () => ({}) },
  databaseSync: { type: Object, default: null },
  backupCenter: { type: Object, default: null },
  transfer: { type: Object, default: null },
  exclusionTemplates: { type: Array, default: () => [] },
});

const emit = defineEmits([
  "close",
  "minimize",
  "status-change",
  "open-database-sync",
  "open-backup-center",
  "open-table-transfer",
]);

const realMode = isTauriRuntime();

// On desktop, real drivers execute database sync, snapshots, plan SQL, SVN,
// client sync, table conversion and Cocos builds; browser previews use mocks.
const workspace = useReleaseWorkspace({
  realMode,
  connections: () => props.connections,
  databasesByConnection: () => props.databasesByConnection,
  templates: () => props.transfer?.templates?.value || [],
  driver: composeDrivers(
    createReleaseBuildDriver({ simulateFailure: (context) => !realMode && context.demo.buildFailure && context.attempt === 1 }),
    createReleaseRealDriver(),
    createReleaseDemoDriver(),
  ),
});
onBeforeUnmount(() => workspace.dispose());

const view = workspace.view;
const dialogRef = ref(null);
const mainRef = ref(null);
const newUpdate = reactive({ open: false, platformId: "" });

// Any page can start a new update; the dialog asks which platform (and what
// to do with an update that platform still has open).
provide("releaseNewUpdate", (platformId = "") => {
  newUpdate.platformId = platformId;
  newUpdate.open = true;
});

provide("releaseWorkbenchTools", {
  openDatabaseSync: (target) => emit("open-database-sync", target),
  openBackupCenter: (options) => emit("open-backup-center", options),
  openTableTransfer: () => emit("open-table-transfer"),
});

// Confirmations and the new-update dialog are layers above the workspace and
// take Escape first.
const busy = computed(() => workspace.anyBusy.value);
const { confirm } = useConfirm();

// Updates in one-click mode only go on while the workspace is open; they
// pick up where they were when it opens again.
async function requestClose() {
  const running = workspace.autopilotRuns.value.length;
  if (running && !(await confirm({
    title: t("releaseFlow.autopilot.close.title"),
    message: t("releaseFlow.autopilot.close.message", { count: running }),
    confirmText: t("releaseFlow.autopilot.close.action"),
    cancelText: t("releaseFlow.cancel"),
  }))) return;
  emit("close");
}

useEscClose(() => !props.minimized, () => void requestClose(), () => busy.value, { dialogRef });

const NAV = Object.freeze([
  { id: "home", icon: LayoutDashboard },
  { id: "history", icon: History },
  { id: "plans", icon: CalendarCheck2 },
  { id: "build", icon: Package },
  { id: "svn", icon: FolderGit2 },
  { id: "platforms", icon: Server },
]);

function openNav(id) {
  if (id === "home") workspace.openHome();
  else workspace.openSection(id);
}

const SECTION_COMPONENTS = {
  home: ReleaseHomePage,
  platform: ReleasePlatformPage,
  history: ReleaseHistoryPage,
  plans: ReleasePlanBoard,
  build: ReleaseBuildPage,
  svn: ReleaseSvnToolPage,
  platforms: ReleasePlatformsPage,
};

const currentFlow = computed(() => workspace.currentFlow.value);
const sectionKey = computed(() => (view.section === "run" ? `run:${view.runId}` : `${view.section}:${view.platformId}`));

const minimizedStatus = computed(() => {
  const cards = workspace.cards.value;
  const focusedRunId = currentFlow.value?.state.id || "";
  const pickCard = (status) => (
    (focusedRunId && cards.find((card) => card.runId === focusedRunId && card.status === status))
    || cards.find((card) => card.status === status)
    || null
  );

  const runningFlow = workspace.flows.value.find((flow) => flow.busy.value || flow.autopilot.active.value);
  if (runningFlow) {
    const card = cards.find((entry) => entry.runId === runningFlow.state.id);
    const done = card?.progress.done || 0;
    const total = card?.progress.total || 0;
    const platform = card?.name || runningFlow.state.platformId;
    const runningTask = RELEASE_TASKS.find((def) => runningFlow.state.tasks[def.id]?.status === TASK_STATUS.RUNNING);
    return {
      tone: "running",
      busy: true,
      shortText: total ? `${done}/${total}` : t("releaseFlow.minimized.short.running"),
      detail: runningTask
        ? t("releaseFlow.minimized.detail.step", { platform, step: t(`releaseFlow.task.${runningTask.id}.title`), done, total })
        : t("releaseFlow.minimized.detail.running", { platform, done, total }),
    };
  }

  const attentionCard = pickCard("attention");
  if (attentionCard) {
    const failed = attentionCard.issues.some((issue) => issue.tone === "danger");
    const done = attentionCard.progress.done || 0;
    const total = attentionCard.progress.total || 0;
    return {
      tone: failed ? "danger" : "attention",
      busy: false,
      shortText: failed ? t("releaseFlow.minimized.short.failed") : t("releaseFlow.minimized.short.attention"),
      detail: failed
        ? t("releaseFlow.minimized.detail.failed", { platform: attentionCard.name, done, total })
        : t("releaseFlow.minimized.detail.attention", { platform: attentionCard.name, done, total }),
    };
  }

  const activeCard = pickCard("active");
  if (activeCard) {
    const done = activeCard.progress.done || 0;
    const total = activeCard.progress.total || 0;
    return {
      tone: "active",
      busy: false,
      shortText: total ? `${done}/${total}` : t("releaseFlow.minimized.short.active"),
      detail: t("releaseFlow.minimized.detail.active", { platform: activeCard.name, done, total }),
    };
  }

  const doneCard = (focusedRunId && cards.find((card) => card.runId === focusedRunId && card.status === "done"))
    || cards.find((card) => card.runId && card.status === "done")
    || null;
  if (doneCard) {
    return {
      tone: "done",
      busy: false,
      shortText: t("releaseFlow.minimized.short.done"),
      detail: t("releaseFlow.minimized.detail.done", { platform: doneCard.name }),
    };
  }

  const pendingCard = pickCard("pending");
  if (pendingCard) {
    return {
      tone: "idle",
      busy: false,
      shortText: t("releaseFlow.minimized.short.pending"),
      detail: t("releaseFlow.minimized.detail.pending", { platform: pendingCard.name }),
    };
  }

  return {
    tone: "idle",
    busy: false,
    shortText: t("releaseFlow.minimized.short.idle"),
    detail: t("releaseFlow.minimized.restoreHint"),
  };
});

watch(minimizedStatus, (status) => emit("status-change", status), { immediate: true });

function focusHeading() {
  if (props.minimized) return;
  mainRef.value?.querySelector("h3")?.focus({ preventScroll: true });
}

watch(
  () => props.minimized,
  (isMinimized, wasMinimized) => {
    if (!isMinimized && wasMinimized) void nextTick(focusHeading);
  },
);

watch(
  () => [sectionKey.value, currentFlow.value?.state.page],
  async () => {
    await nextTick();
    mainRef.value?.querySelector("[data-release-scroll]")?.scrollTo?.({ top: 0 });
    focusHeading();
  },
);

watch(
  () => [
    Boolean(props.databaseSync?.dialog?.open),
    Boolean(props.backupCenter?.dialog?.open),
    Boolean(props.transfer?.dialog?.open),
  ],
  (nextOpen, prevOpen = []) => {
    if (nextOpen.some((open, idx) => prevOpen[idx] && !open)) {
      void currentFlow.value?.refreshLiveState?.({ all: true });
    }
  },
);

// Open on the page's heading rather than its first field.
onMounted(() => void nextTick(focusHeading));
</script>

<template>
  <div v-show="!minimized" class="wb-dialog-overlay" :aria-hidden="minimized ? 'true' : undefined">
    <section
      ref="dialogRef"
      class="wb-dialog wb-rf-dialog"
      role="dialog"
      :aria-modal="minimized ? undefined : 'true'"
      aria-labelledby="wb-rf-title"
      tabindex="-1"
    >
      <header class="wb-rf-header">
        <span class="wb-rf-brand" aria-hidden="true"><Rocket :size="16" /></span>
        <h2 id="wb-rf-title" class="wb-rf-title">{{ t('releaseFlow.title') }}</h2>
        <nav class="wb-rf-nav" :aria-label="t('releaseFlow.nav.label')">
          <button
            v-for="item in NAV"
            :key="item.id"
            type="button"
            class="wb-rf-nav-item"
            :data-release-section="item.id"
            :aria-current="view.section === item.id ? 'page' : undefined"
            :title="t(`releaseFlow.nav.${item.id}`)"
            @click="openNav(item.id)"
          >
            <component :is="item.icon" :size="15" aria-hidden="true" />
            <span>{{ t(`releaseFlow.nav.${item.id}`) }}</span>
          </button>
        </nav>
        <div class="wb-rf-header-actions">
          <ReleaseDemoMenu v-if="!realMode || currentFlow?.state?.demo" :workspace="workspace" />
          <button
            type="button"
            class="wb-rf-btn is-quiet wb-rf-minimize"
            data-release-minimize
            :title="t('releaseFlow.minimize')"
            :aria-label="t('releaseFlow.minimize')"
            @click="emit('minimize')"
          >
            <Minus :size="17" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="wb-rf-btn is-quiet wb-rf-close"
            :disabled="busy"
            :title="busy ? t('releaseFlow.closeBusy') : t('releaseFlow.close')"
            :aria-label="t('releaseFlow.close')"
            @click="requestClose"
          >
            <X :size="17" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div class="wb-rf-body">
        <ReleasePlatformBoard :workspace="workspace" />
        <main ref="mainRef" class="wb-rf-main" :data-release-section="view.section">
          <ReleaseRunView
            v-if="view.section === 'run' && currentFlow"
            :key="sectionKey"
            :workspace="workspace"
            :flow="currentFlow"
            :transfer="transfer"
            :exclusion-templates="exclusionTemplates"
          />
          <div v-else class="wb-rf-page" data-release-scroll>
            <div class="wb-rf-page-inner" :class="{ 'is-wide': view.section !== 'home' && view.section !== 'platform' }">
              <component
                :is="SECTION_COMPONENTS[view.section] || ReleaseHomePage"
                :key="sectionKey"
                :workspace="workspace"
              />
            </div>
          </div>
        </main>
      </div>

      <ReleaseNewUpdateDialog
        v-if="newUpdate.open"
        :workspace="workspace"
        :platform-id="newUpdate.platformId"
        @close="newUpdate.open = false"
      />
    </section>
  </div>
</template>

<style scoped>
.wb-rf-minimize,
.wb-rf-close {
  width: 34px;
  padding: 0;
}
</style>
