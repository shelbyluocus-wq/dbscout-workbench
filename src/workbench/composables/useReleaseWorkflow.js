import { computed, reactive, ref, watch } from "vue";
import {
  RELEASE_DRAFT_KEY, RELEASE_PLATFORMS, createReleaseDraft,
  invalidateReleaseActions, invalidateReleaseFrom, planPreview, releaseActionBlock, restoreReleaseState,
  stepActions, stepComplete,
} from "../releaseWorkflowState.js";

function defaultStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function useReleaseWorkflow({ storage = defaultStorage(), delay = 280, now = () => new Date() } = {}) {
  let saved = null;
  let storageUnavailable = !storage;
  try { saved = storage?.getItem(RELEASE_DRAFT_KEY); } catch { storageUnavailable = true; }
  const state = reactive(restoreReleaseState(saved));
  const persistenceError = ref(storageUnavailable);
  const busy = ref("");
  const progress = ref(0);
  const invalidated = ref(false);
  const conflictDemo = ref(false);
  const buildFailureDemo = ref(false);
  const draft = computed(() => state.drafts[state.platform]);
  const config = computed(() => draft.value.config);
  const complete = computed(() => stepComplete(draft.value, 5));
  const doneCount = computed(() => Array.from({ length: 6 }, (_, step) => stepComplete(draft.value, step)).filter(Boolean).length);
  const nextAction = computed(() => stepActions(state.step, config.value).find((key) => draft.value.results[key] !== "done") || "");
  const blocked = computed(() => nextAction.value ? releaseActionBlock(draft.value, nextAction.value) : "");
  let generation = 0;
  let timer = null;
  let finishWait = null;

  function save() {
    try {
      if (!storage) throw new Error("storage unavailable");
      storage.setItem(RELEASE_DRAFT_KEY, JSON.stringify(state));
      persistenceError.value = false;
    } catch { persistenceError.value = true; }
  }
  const stopSaving = watch(state, save, { deep: true, flush: "post" });

  function log(action, status) {
    draft.value.logs.push({ action, status, time: now().toISOString() });
    if (draft.value.logs.length > 100) draft.value.logs.splice(0, draft.value.logs.length - 100);
  }

  function invalidate(step, roots) {
    const before = Object.keys(draft.value.results);
    if (roots) invalidateReleaseActions(draft.value, roots);
    else invalidateReleaseFrom(draft.value, step);
    const hadResults = before.some((key) => !Object.hasOwn(draft.value.results, key));
    if (hadResults) invalidated.value = true;
  }

  function updateConfig(key, value, step) {
    if (busy.value || !Object.hasOwn(config.value, key) || key === "plans") return;
    if (config.value[key] === value) return;
    const roots = ["maintenanceStart", "maintenanceEnd", "clientOpen"].includes(key) ? ["schedule"]
      : key === "serverPackage" ? ["serverUpload"] : key === "reloadActivity" ? ["activityReload"] : null;
    invalidate(step, roots);
    if (key === "date") {
      const previous = config.value.date;
      for (const field of ["maintenanceStart", "maintenanceEnd", "clientOpen"]) {
        if (config.value[field].startsWith(`${previous}T`)) config.value[field] = `${value}${config.value[field].slice(10)}`;
      }
    }
    config.value[key] = value;
  }

  function updatePlan(id, key, value) {
    if (busy.value || !["kind", "name", "rowKey", "table", "field", "start", "end", "note"].includes(key)) return;
    const row = config.value.plans.find((entry) => entry.id === id);
    if (!row || row[key] === value) return;
    invalidate(1);
    row[key] = value;
  }

  function addPlan() {
    if (busy.value || config.value.plans.length >= 100) return;
    invalidate(1);
    config.value.plans.push({
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind: "feature", name: "",
      rowKey: "", table: "demo_feature_schedule", field: "enabled", start: config.value.date, end: "", note: "", current: 0,
    });
  }

  function removePlan(id) {
    if (busy.value) return;
    invalidate(1);
    config.value.plans = config.value.plans.filter((row) => row.id !== id);
  }

  function switchPlatform(platform) {
    if (busy.value || !RELEASE_PLATFORMS.includes(platform)) return;
    state.platform = platform;
    invalidated.value = false;
    conflictDemo.value = false;
    buildFailureDemo.value = false;
  }

  function go(step) {
    if (busy.value || !Number.isInteger(step) || step < 0 || step > 5) return;
    state.step = step;
  }

  function wait() {
    return new Promise((resolve) => {
      finishWait = resolve;
      timer = setTimeout(() => { timer = null; finishWait = null; resolve(); }, delay);
    });
  }

  async function run(action = nextAction.value) {
    if (busy.value || releaseActionBlock(draft.value, action)) return false;
    const token = ++generation;
    busy.value = action;
    progress.value = 0;
    draft.value.results[action] = "running";
    log(action, "running");
    for (let tick = 1; tick <= 3; tick += 1) {
      await wait();
      if (token !== generation) return false;
      progress.value = tick * 33;
    }
    let status = "done";
    if (action === "svn" && conflictDemo.value && (!draft.value.conflicts.code || !draft.value.conflicts.config)) status = "blocked";
    if (action === "build" && buildFailureDemo.value) { status = "failed"; buildFailureDemo.value = false; }
    if (action === "dbPreview") draft.value.preview = planPreview(config.value);
    draft.value.results[action] = status;
    log(action, status);
    busy.value = "";
    progress.value = 100;
    invalidated.value = false;
    return status === "done";
  }

  function cancel() {
    if (!busy.value) return;
    generation += 1;
    clearTimeout(timer);
    finishWait?.();
    timer = null;
    finishWait = null;
    const action = busy.value;
    draft.value.results[action] = "cancelled";
    log(action, "cancelled");
    busy.value = "";
    progress.value = 0;
  }

  function reset() {
    cancel();
    state.drafts[state.platform] = createReleaseDraft(state.platform);
    state.step = 0;
    invalidated.value = false;
    conflictDemo.value = false;
    buildFailureDemo.value = false;
  }

  function report() {
    return JSON.stringify({
      demo: true, realOperationsExecuted: false, timezone: "Asia/Shanghai",
      exportedAt: now().toISOString(), platform: state.platform, ...draft.value,
    }, null, 2);
  }

  function dispose() { cancel(); save(); stopSaving(); }

  return {
    state, draft, config, complete, doneCount, busy, progress, nextAction, blocked,
    persistenceError, invalidated, conflictDemo, buildFailureDemo,
    updateConfig, updatePlan, addPlan, removePlan, switchPlatform, go, run, cancel, reset, report, dispose,
  };
}
