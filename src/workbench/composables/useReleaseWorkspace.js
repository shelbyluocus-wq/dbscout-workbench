import { computed, reactive, ref, watch } from "vue";
import { t } from "../i18n/index.js";
import { flowComplete, localDateIso } from "../releaseFlowState.js";
import {
  PLATFORM_FLAG_FIELDS,
  PLATFORM_TEXT_FIELDS,
  RELEASE_HISTORY_STORAGE_KEY,
  RELEASE_SPEEDS,
  RELEASE_TOOL_SECTIONS,
  RELEASE_WORKSPACE_STORAGE_KEY,
  cleanPlanEntry,
  compactHistory,
  createRun,
  createWorkspaceData,
  historyEntryFromRun,
  platformCard,
  toolHistoryEntry,
  readLegacyFlow,
  readStoredHistory,
  readStoredWorkspace,
  writeStoredHistory,
  writeStoredWorkspace,
} from "../releaseWorkspaceState.js";
import { createDemoHistory, createDemoRuns } from "../utils/releaseWorkspaceDemo.js";
import { createReleaseDemoDriver } from "../utils/releaseFlowDemoDriver.js";
import { createCoalescedTask } from "../utils/coalescedTask.js";
import { abortableSleep, createRunFlow } from "./useReleaseFlow.js";

function everySecond(callback) {
  const timer = setInterval(callback, 1000);
  return () => clearInterval(timer);
}

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// Editing a platform field invalidates the first task of its open update that used it.
const PLATFORM_FIELD_TASKS = Object.freeze({
  sourceDatabase: "db.sync",
  targetDatabase: "db.sync",
  sourceClient: "client.sync",
  targetClient: "client.svn",
  transferTemplateId: "client.transfer",
  cocosVersion: "build.cocos",
  cocosPath: "build.cocos",
  buildPlatform: "build.cocos",
  buildConfig: "build.cocos",
  buildOutputName: "build.cocos",
  buildDebug: "build.cocos",
  buildMd5Cache: "build.cocos",
  buildQaGuard: "build.cocos",
});

let planSequence = 0;

/**
 * The release workspace: every platform's update side by side (each with its
 * own progress, schedule and server clock watch), the history, the open-plan
 * memo and the shared settings. Progress persists on this device, so an
 * update left half-way continues the next time the workspace opens.
 */
export function useReleaseWorkspace({
  storage = globalThis.localStorage,
  driver = createReleaseDemoDriver(),
  templates = () => [],
  sleep = abortableSleep,
  now = () => new Date(),
  ticker = everySecond,
  translate = t,
  seed = true,
} = {}) {
  const today = localDateIso(now());
  const stored = readStoredWorkspace(storage);
  const legacy = stored ? null : readLegacyFlow(storage);
  const fresh = !stored && !legacy;
  const workspace = reactive(createWorkspaceData({ stored, legacy, today, translate, seedRuns: seed ? createDemoRuns : null }));
  const storedHistory = readStoredHistory(storage);
  const history = ref(storedHistory ?? (seed ? compactHistory(createDemoHistory({ today, platforms: workspace.platforms })) : []));
  const view = workspace.view;
  // What a page should show when it opens (not kept between sessions).
  const ui = reactive({ historyEntryId: "" });

  const templateList = computed(() => (typeof templates === "function" ? templates() : templates?.value || templates || []));

  /* ── Persistence ── */
  const persistence = createCoalescedTask(() => writeStoredWorkspace(storage, plain(workspace)), { delayMs: 300, maxWaitMs: 1500 });
  const stopPersisting = watch(() => workspace, () => persistence.schedule(), { deep: true });
  function writeHistory() {
    writeStoredHistory(storage, history.value);
  }
  if (!storedHistory) writeHistory();
  if (fresh || legacy) persistence.schedule();

  /* ── Clock ── */
  // Real time for every update; each update's GM clock adds its own demo offset.
  const clock = ref(now().getTime());
  const stopClock = ticker(() => (clock.value = now().getTime()));

  /* ── Updates ── */
  // Every update keeps a live flow, so a maintenance on one platform closes
  // its servers on time while another platform is on screen.
  const flows = new Map();
  const flowsVersion = ref(0);

  function platformById(platformId) {
    return workspace.platforms.find((platform) => platform.id === platformId) || null;
  }

  function addHistory(entry) {
    history.value = compactHistory([entry, ...history.value.filter((existing) => existing.id !== entry.id)]);
    writeHistory();
  }

  // An update whose every step is settled is finished: it is written to the
  // history once and stays on its card, read-only, until the next one.
  function settle(run) {
    if (run.outcome || !flowComplete(run.tasks, run.brief)) return;
    run.outcome = "done";
    run.finishedAt = now().getTime();
    addHistory(historyEntryFromRun(run, { platform: platformById(run.platformId), outcome: "done", at: run.finishedAt }));
    persistence.flush();
  }

  function syncFlows() {
    const ids = new Set(workspace.runs.map((run) => run.id));
    for (const [id, flow] of flows) {
      if (ids.has(id)) continue;
      flow.dispose();
      flows.delete(id);
    }
    for (const run of workspace.runs) {
      if (flows.has(run.id)) continue;
      flows.set(run.id, createRunFlow({
        workspace,
        run,
        driver,
        templates: templateList,
        sleep,
        now,
        clock,
        flush: () => persistence.flush(),
        onSettled: settle,
      }));
    }
    flowsVersion.value += 1;
  }

  syncFlows();
  for (const run of workspace.runs) settle(run);

  function flowFor(runId) {
    void flowsVersion.value;
    return flows.get(runId) || null;
  }

  function runOf(platformId) {
    return workspace.runs.find((run) => run.platformId === platformId) || null;
  }

  function flowOfPlatform(platformId) {
    const run = runOf(platformId);
    return run ? flowFor(run.id) : null;
  }

  const currentFlow = computed(() => (view.section === "run" ? flowFor(view.runId) : null));
  const flowList = computed(() => {
    void flowsVersion.value;
    return [...flows.values()];
  });
  const anyBusy = computed(() => flowList.value.some((flow) => flow.busy.value));

  const cards = computed(() => workspace.platforms.map((platform) => platformCard(platform, {
    run: runOf(platform.id),
    history: history.value,
    now: clock.value,
  })));

  /* ── View ── */
  function setView(section, { runId = "", platformId = "" } = {}) {
    view.section = section;
    view.runId = runId;
    view.platformId = platformId;
  }

  function openHome() {
    setView("home");
    view.returnTo = null;
  }

  function openRun(runId) {
    if (!flowFor(runId)) return false;
    setView("run", { runId });
    view.returnTo = null;
    return true;
  }

  /** A platform's card: its update when there is one, otherwise its page. */
  function openPlatform(platformId) {
    if (!platformById(platformId)) return false;
    const run = runOf(platformId);
    if (run) return openRun(run.id);
    setView("platform", { platformId });
    view.returnTo = null;
    return true;
  }

  /** A workspace page; "back" leads to the update or page it was opened from. */
  function openSection(section) {
    if (!RELEASE_TOOL_SECTIONS.includes(section)) return false;
    if (!RELEASE_TOOL_SECTIONS.includes(view.section)) {
      view.returnTo = { section: view.section, runId: view.runId, platformId: view.platformId };
    }
    setView(section);
    return true;
  }

  function back() {
    const target = view.returnTo;
    view.returnTo = null;
    if (target?.section === "run" && flowFor(target.runId)) return openRun(target.runId);
    if (target?.section === "platform" && platformById(target.platformId)) return openPlatform(target.platformId);
    openHome();
    return true;
  }

  /* ── Creating, continuing and abandoning updates ── */
  /**
   * Start a new update for a platform. A platform with an open update keeps
   * it: the answer is "open" and the person decides whether to continue it or
   * abandon it first. A finished update is already in the history and makes
   * room for the new one.
   */
  function createUpdate(platformId) {
    if (!platformById(platformId)) return { status: "missing", runId: "" };
    const existing = runOf(platformId);
    if (existing && !existing.outcome) return { status: "open", runId: existing.id };
    if (existing) removeRun(existing.id);
    const run = createRun({ platformId, today: localDateIso(now()), createdAt: now().getTime() });
    workspace.runs.push(run);
    syncFlows();
    openRun(run.id);
    return { status: "created", runId: run.id };
  }

  function removeRun(runId) {
    const index = workspace.runs.findIndex((run) => run.id === runId);
    if (index < 0) return;
    workspace.runs.splice(index, 1);
    syncFlows();
  }

  /** Leave an open update; started work is kept in the history as abandoned. */
  function abandonUpdate(runId) {
    const flow = flowFor(runId);
    const run = flow?.state;
    if (!run || run.outcome || flow.busy.value) return false;
    if (run.brief.started) {
      addHistory(historyEntryFromRun(run, { platform: platformById(run.platformId), outcome: "abandoned", at: now().getTime() }));
    }
    const platformId = run.platformId;
    removeRun(runId);
    if (view.section === "run" && view.runId === runId) openPlatform(platformId);
    if (view.returnTo?.runId === runId) view.returnTo = { section: "platform", runId: "", platformId };
    return true;
  }

  /* ── Platforms ── */
  function updatePlatform(platformId, patch = {}) {
    const target = platformById(platformId);
    const flow = flowOfPlatform(platformId);
    if (!target || flow?.busy.value) return false;
    const roots = [];
    for (const field of PLATFORM_TEXT_FIELDS) {
      if (!Object.hasOwn(patch, field) || typeof patch[field] !== "string") continue;
      const value = field === "name" ? patch[field].slice(0, 40) : patch[field].trim();
      if (value === target[field] || (field === "name" && !value.trim())) continue;
      target[field] = value;
      if (PLATFORM_FIELD_TASKS[field]) roots.push(PLATFORM_FIELD_TASKS[field]);
    }
    for (const field of PLATFORM_FLAG_FIELDS) {
      if (typeof patch[field] !== "boolean" || patch[field] === target[field]) continue;
      target[field] = patch[field];
      roots.push(PLATFORM_FIELD_TASKS[field]);
    }
    if (roots.length) flow?.invalidate(roots);
    return true;
  }

  /* ── Open-plan memo ── */
  // A memo change only touches the updates of platforms whose note it changes.
  function invalidatePlans(platformIds) {
    for (const platformId of platformIds) flowOfPlatform(platformId)?.invalidate(["db.plans"]);
  }

  function touchedPlatforms(before, after) {
    return workspace.platforms
      .map((platform) => platform.id)
      .filter((id) => (before?.notes?.[id] || "") !== (after?.notes?.[id] || "")
        || ((before?.notes?.[id] || after?.notes?.[id])
          && (before?.ref !== after?.ref || before?.category !== after?.category)));
  }

  function planBusy() {
    return anyBusy.value;
  }

  /** Add a memo entry; returns it, or null when it has no name. */
  function addPlanEntry(draft = {}) {
    if (planBusy()) return null;
    planSequence = (planSequence + 1) % 1296;
    const entry = cleanPlanEntry({ ...draft, id: `plan-${now().getTime().toString(36)}-${planSequence.toString(36)}` }, workspace.platforms);
    if (!entry) return null;
    workspace.plans.items.push(entry);
    invalidatePlans(touchedPlatforms(null, entry));
    return entry;
  }

  function updatePlanEntry(id, patch = {}) {
    const index = workspace.plans.items.findIndex((entry) => entry.id === id);
    if (index < 0 || planBusy()) return false;
    const before = plain(workspace.plans.items[index]);
    const merged = { ...before, ...patch, id, notes: { ...before.notes, ...(patch.notes || {}) } };
    const entry = cleanPlanEntry(merged, workspace.platforms);
    if (!entry) return false;
    // A renamed or re-numbered entry is not the row the demo database wrote.
    if (entry.ref !== before.ref || entry.category !== before.category) {
      for (const flags of Object.values(workspace.demoFlags)) delete flags[id];
      delete entry.devFlag;
    }
    workspace.plans.items.splice(index, 1, entry);
    invalidatePlans(touchedPlatforms(before, entry));
    return true;
  }

  function setPlanNote(id, platformId, note) {
    return updatePlanEntry(id, { notes: { [platformId]: String(note ?? "") } });
  }

  function removePlanEntry(id) {
    const index = workspace.plans.items.findIndex((entry) => entry.id === id);
    if (index < 0 || planBusy()) return false;
    const [removed] = workspace.plans.items.splice(index, 1);
    for (const flags of Object.values(workspace.demoFlags)) delete flags[id];
    for (const run of workspace.runs) delete run.planSkips[id];
    invalidatePlans(touchedPlatforms(removed, null));
    return true;
  }

  /* ── History ── */
  /** A client build or an SVN operation finished; keep it in the history. */
  function recordTool(entry) {
    const record = toolHistoryEntry(entry);
    addHistory(record);
    return record;
  }

  function historyFor(platformId) {
    return history.value.filter((entry) => entry.platformId === platformId);
  }

  function clearDemoHistory() {
    history.value = history.value.filter((entry) => !entry.demo);
    writeHistory();
  }

  /* ── Demo options ── */
  function setDemoOption(key, value) {
    if (key === "speed") {
      if (Object.hasOwn(RELEASE_SPEEDS, value)) workspace.demo.speed = value;
      return;
    }
    if (["conflicts", "buildFailure", "missingFiles"].includes(key)) workspace.demo[key] = Boolean(value);
  }

  /** Back to the demo as first opened: seeded updates, history and memo. */
  function resetDemo() {
    if (anyBusy.value) return false;
    for (const flow of flows.values()) flow.dispose();
    flows.clear();
    try {
      storage?.removeItem?.(RELEASE_WORKSPACE_STORAGE_KEY);
      storage?.removeItem?.(RELEASE_HISTORY_STORAGE_KEY);
    } catch {
      // Storage may be unavailable; the fresh state still applies here.
    }
    const day = localDateIso(now());
    const { view: nextView, ...next } = createWorkspaceData({ today: day, translate, seedRuns: seed ? createDemoRuns : null });
    Object.assign(workspace, next);
    Object.assign(view, nextView);
    history.value = seed ? compactHistory(createDemoHistory({ today: day, platforms: workspace.platforms })) : [];
    writeHistory();
    syncFlows();
    openHome();
    persistence.flush();
    return true;
  }

  /* ── Tools ── */
  function setSvnPath(path) {
    workspace.svn.path = String(path || "").trim();
  }

  /** The build page builds a platform's client, or "custom": another client folder. */
  function setBuildTarget(targetId) {
    if (targetId === "custom" || platformById(targetId)) workspace.build.targetId = targetId;
  }

  function buildTarget(targetId = workspace.build.targetId) {
    return targetId === "custom" ? workspace.build.custom : platformById(targetId);
  }

  /** Build settings live on the platform, so its update's build step uses them too. */
  function updateBuildTarget(targetId, patch = {}) {
    if (targetId !== "custom") return updatePlatform(targetId, patch);
    const target = workspace.build.custom;
    for (const field of PLATFORM_TEXT_FIELDS) {
      if (Object.hasOwn(target, field) && typeof patch[field] === "string") target[field] = field === "name" ? patch[field].slice(0, 40) : patch[field].trim();
    }
    for (const field of PLATFORM_FLAG_FIELDS) if (typeof patch[field] === "boolean") target[field] = patch[field];
    return true;
  }

  function dispose() {
    for (const flow of flows.values()) flow.dispose();
    stopClock();
    stopPersisting();
    persistence.flush();
  }

  return {
    state: workspace,
    view,
    ui,
    history,
    cards,
    currentFlow,
    flows: flowList,
    anyBusy,
    clock,
    templates: templateList,
    flowFor,
    runOf,
    flowOfPlatform,
    platformById,
    openHome,
    openRun,
    openPlatform,
    openSection,
    back,
    createUpdate,
    abandonUpdate,
    updatePlatform,
    addPlanEntry,
    updatePlanEntry,
    setPlanNote,
    removePlanEntry,
    addHistory,
    recordTool,
    historyFor,
    clearDemoHistory,
    setDemoOption,
    resetDemo,
    setSvnPath,
    setBuildTarget,
    buildTarget,
    updateBuildTarget,
    now,
    dispose,
  };
}
