import { computed, reactive, ref, watch } from "vue";
import { language, t } from "../i18n/index.js";
import {
  RELEASE_PAGES,
  RELEASE_SCOPES,
  RELEASE_TOOLS,
  RELEASE_TASKS,
  RELEASE_TASK_BY_ID,
  TASK_STATUS,
  adjacentPage,
  appendHistory,
  appendTaskLog,
  createReleaseBrief,
  defaultSchedule,
  flowComplete,
  flowProgress,
  idleTaskState,
  invalidateTasks,
  isReleaseTool,
  localDateIso,
  normalizeTasks,
  pageApplies,
  pageStatus,
  readStoredFlow,
  restoreBrief,
  restoreTasks,
  runningTaskId,
  taskApplies,
  taskBlocker,
  writeStoredFlow,
} from "../releaseFlowState.js";
import { countPlanChanges, isIsoDate, planChanges, planStatements } from "../utils/releasePlanNotes.js";
import {
  DEMO_CLIENT_CHANGES,
  DEMO_CONFIG_TABLES,
  DEMO_DEFAULT_PLATFORM,
  DEMO_DIFF_FILES,
  DEMO_FILE_EXCLUSIONS,
  DEMO_HOT_UPDATE,
  DEMO_SERVERS,
  DEMO_SYNC_EXCLUSIONS,
  RELEASE_PLAN_CATEGORIES,
  RELEASE_PLAN_ITEMS,
  createDemoNotes,
  createDemoPlatforms,
  demoDatabaseFlag,
} from "../utils/releaseFlowDemo.js";
import { localInputTime, onlinePlayers, serverPhase, suggestedWindow } from "../utils/releaseServer.js";
import { createReleaseDemoDriver } from "../utils/releaseFlowDemoDriver.js";
import { cleanExclusionRules, excludingRule } from "../utils/releaseFileRules.js";
import { cocosBuildCommand } from "../utils/cocosBuildCommand.js";
import { createCoalescedTask } from "../utils/coalescedTask.js";

export const RELEASE_SPEEDS = Object.freeze({ normal: 1, fast: 0.35 });
export const CONFLICT_CHOICES = Object.freeze(["theirs", "mine", "manual"]);
const PLATFORM_FIELDS = Object.freeze([
  "name", "sourceDatabase", "targetDatabase", "sourceClient", "targetClient",
  "transferTemplateId", "cocosVersion", "cocosPath", "buildPlatform", "buildConfig",
]);

// Editing a platform field invalidates the first task that used it.
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
});

function cancelledError() {
  const error = new Error("cancelled");
  error.code = "cancelled";
  return error;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    function onAbort() {
      clearTimeout(timer);
      reject(cancelledError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function everySecond(callback) {
  const timer = setInterval(callback, 1000);
  return () => clearInterval(timer);
}

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cleanTableNames(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter((value) => value && !seen.has(value) && seen.add(value));
}

function shiftDate(value, fromIso, toIso) {
  return typeof value === "string" && value.startsWith(fromIso) ? `${toIso}${value.slice(fromIso.length)}` : value;
}

function restorePlatforms(saved, fallback) {
  if (!Array.isArray(saved)) return fallback;
  return fallback.map((platform) => {
    const stored = saved.find((entry) => entry?.id === platform.id);
    if (!stored) return platform;
    const next = { ...platform };
    for (const field of PLATFORM_FIELDS) if (typeof stored[field] === "string") next[field] = stored[field];
    return next;
  });
}

function restoreNotes(saved, fallback) {
  const notes = {};
  for (const [itemId, byPlatform] of Object.entries(fallback)) {
    notes[itemId] = {};
    for (const [platformId, note] of Object.entries(byPlatform)) {
      const stored = saved?.[itemId]?.[platformId];
      notes[itemId][platformId] = typeof stored === "string" ? stored.slice(0, 200) : note;
    }
  }
  return notes;
}

function restoreSchedule(saved, fallback) {
  const schedule = { ...fallback };
  const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  for (const key of ["maintenanceStart", "maintenanceEnd", "clientOpenAt"]) {
    if (timePattern.test(saved?.[key] || "")) schedule[key] = saved[key];
  }
  if (typeof saved?.clientOpenFollowsMaintenance === "boolean") {
    schedule.clientOpenFollowsMaintenance = saved.clientOpenFollowsMaintenance;
  }
  return schedule;
}

function restoreFlags(saved, platforms) {
  const knownItems = new Set(RELEASE_PLAN_ITEMS.map((item) => item.id));
  return Object.fromEntries(platforms.map((platform) => [
    platform.id,
    Object.fromEntries(Object.entries(saved?.[platform.id] || {})
      .filter(([itemId, flag]) => knownItems.has(itemId) && (flag === 0 || flag === 1))),
  ]));
}

function restorePerPlatform(saved, platforms, fallback, clean) {
  return Object.fromEntries(platforms.map((platform) => [
    platform.id,
    Array.isArray(saved?.[platform.id]) ? clean(saved[platform.id]) : [...fallback],
  ]));
}

/** A fresh or restored flow. Seeded content is written in the current language. */
export function createReleaseFlowData({ stored = null, today = localDateIso(), translate = t } = {}) {
  const platforms = restorePlatforms(stored?.platforms, createDemoPlatforms());
  const fallbackBrief = createReleaseBrief(DEMO_DEFAULT_PLATFORM, today);
  const brief = restoreBrief(stored?.brief, fallbackBrief);
  if (!platforms.some((platform) => platform.id === brief.platformId)) brief.platformId = platforms[0].id;
  const schedule = restoreSchedule(stored?.schedule, defaultSchedule(brief.date));
  // An unstarted draft follows the calendar; a started release keeps its day.
  if (!brief.started && brief.date < today) {
    for (const key of ["maintenanceStart", "maintenanceEnd", "clientOpenAt"]) schedule[key] = shiftDate(schedule[key], brief.date, today);
    brief.date = today;
  }
  const choices = {};
  for (const [path, choice] of Object.entries(stored?.conflictChoices || {})) {
    if (CONFLICT_CHOICES.includes(choice)) choices[path] = choice;
  }
  const demo = stored?.demo || {};
  return {
    platforms,
    notes: restoreNotes(stored?.notes, createDemoNotes(stored?.notesSeededOn || today, translate)),
    notesSeededOn: isIsoDate(stored?.notesSeededOn) ? stored.notesSeededOn : today,
    brief,
    schedule,
    syncExclusions: restorePerPlatform(stored?.syncExclusions, platforms, DEMO_SYNC_EXCLUSIONS, cleanTableNames),
    fileExclusions: restorePerPlatform(stored?.fileExclusions, platforms, DEMO_FILE_EXCLUSIONS, cleanExclusionRules),
    mirrorDeletes: stored?.mirrorDeletes !== false,
    // Open flags the demo platform databases hold after plan writes, per
    // platform. A real driver reads the database instead.
    demoFlags: restoreFlags(stored?.demoFlags, platforms),
    conflictChoices: choices,
    tasks: restoreTasks(stored?.tasks, brief),
    attempts: {},
    history: Array.isArray(stored?.history)
      ? stored.history
        .filter((entry) => Number(entry?.at) && (RELEASE_TASK_BY_ID.has(entry.taskId) || (!entry.taskId && entry.event === "started")))
        .slice(-120)
      : [],
    page: RELEASE_PAGES.some((entry) => entry.id === stored?.page) || isReleaseTool(stored?.page) ? stored.page : "overview",
    // The step a tool was opened from, so leaving the tool returns there.
    returnPage: RELEASE_PAGES.some((entry) => entry.id === stored?.returnPage) ? stored.returnPage : "overview",
    planCategory: RELEASE_PLAN_CATEGORIES.some((entry) => entry.id === stored?.planCategory) ? stored.planCategory : "hero",
    demo: {
      conflicts: demo.conflicts !== false,
      buildFailure: demo.buildFailure === true,
      speed: Object.hasOwn(RELEASE_SPEEDS, demo.speed) ? demo.speed : "normal",
      // Demo fast-forward: added to the real clock for the GM server side.
      clockOffset: Number.isFinite(demo.clockOffset) ? demo.clockOffset : 0,
    },
  };
}

function snapshotOf(state) {
  const { attempts, ...rest } = state;
  return plain(rest);
}

/**
 * State and actions of the guided release workspace. Every task runs through
 * `driver` (the simulation by default); this composable prepares each task's
 * input, records its logs, result and history, and resets later work when an
 * earlier input changes.
 */
export function useReleaseFlow({
  storage = globalThis.localStorage,
  driver = createReleaseDemoDriver(),
  templates = () => [],
  sleep = abortableSleep,
  now = () => new Date(),
  // Drives the server clock; returns a function that stops it.
  ticker = everySecond,
} = {}) {
  const today = localDateIso(now());
  const state = reactive(createReleaseFlowData({ stored: readStoredFlow(storage), today }));
  const progress = reactive({ taskId: "", fraction: 0 });
  let controller = null;

  const persistence = createCoalescedTask(() => writeStoredFlow(storage, snapshotOf(state)), { delayMs: 300, maxWaitMs: 1500 });
  const stopPersisting = watch(() => state, () => persistence.schedule(), { deep: true });

  const platform = computed(() => state.platforms.find((entry) => entry.id === state.brief.platformId) || state.platforms[0]);
  const runningTask = computed(() => runningTaskId(state.tasks));
  const busy = computed(() => Boolean(runningTask.value));
  const progressSummary = computed(() => flowProgress(state.tasks, state.brief));
  const complete = computed(() => flowComplete(state.tasks, state.brief));
  const templateList = computed(() => (typeof templates === "function" ? templates() : templates?.value || templates || []));

  const pages = computed(() => RELEASE_PAGES.map((entry) => ({
    ...entry,
    applies: pageApplies(entry.id, state.brief),
    status: pageStatus(entry.id, state.tasks, state.brief),
  })));

  /* ── Database ── */
  const syncExclusions = computed(() => state.syncExclusions[platform.value.id] || []);
  const syncPlan = computed(() => {
    const excluded = new Set(syncExclusions.value);
    const tables = DEMO_CONFIG_TABLES.filter((table) => !excluded.has(table.name));
    return {
      tables,
      excluded: DEMO_CONFIG_TABLES.filter((table) => excluded.has(table.name)).map((table) => table.name),
      rows: tables.reduce((sum, table) => sum + table.rows, 0),
      catalog: DEMO_CONFIG_TABLES.map((table) => table.name),
    };
  });

  function noteFor(item, platformId = platform.value.id) {
    return state.notes[item.id]?.[platformId] ?? "";
  }

  const planGroups = computed(() => {
    const excluded = new Set(syncExclusions.value);
    const flags = state.demoFlags[platform.value.id] || {};
    return RELEASE_PLAN_CATEGORIES.map((category) => {
      const synced = !excluded.has(category.table);
      const rows = planChanges(
        RELEASE_PLAN_ITEMS.filter((item) => item.category === category.id),
        {
          dateIso: state.brief.date,
          noteFor: (item) => noteFor(item),
          currentFor: (item) => flags[item.id]
            ?? demoDatabaseFlag(item, { synced, note: noteFor(item), dateIso: state.brief.date }),
        },
      );
      return { ...category, synced, rows, counts: countPlanChanges(rows) };
    });
  });

  // What a finished task did to the demo platform database: an overwrite
  // brings development values back into synced tables, a plan write stores
  // the planned flags. Returns the flags written by a plan write.
  function applyDemoDatabase(taskId) {
    const written = {};
    if (taskId !== "db.sync" && taskId !== "db.plans") return written;
    const flags = state.demoFlags[platform.value.id] || (state.demoFlags[platform.value.id] = {});
    for (const group of planGroups.value) {
      for (const row of group.rows) {
        if (taskId === "db.sync" && group.synced) delete flags[row.item.id];
        if (taskId === "db.plans" && (row.change === "open" || row.change === "close")) {
          written[row.item.id] = row.next;
        }
      }
    }
    Object.assign(flags, written);
    return written;
  }
  const planCounts = computed(() => countPlanChanges(planGroups.value.flatMap((group) => group.rows)));
  const planSql = computed(() => planStatements(planGroups.value));

  /* ── Client ── */
  const fileRules = computed(() => state.fileExclusions[platform.value.id] || []);
  const fileSyncPlan = computed(() => {
    const copy = [];
    const remove = [];
    const kept = [];
    const excluded = [];
    for (const change of DEMO_CLIENT_CHANGES) {
      const rule = excludingRule(change.path, fileRules.value);
      if (rule) excluded.push({ ...change, rule });
      else if (change.status !== "D") copy.push(change);
      else if (state.mirrorDeletes) remove.push(change);
      else kept.push(change);
    }
    return { copy, remove, kept, excluded };
  });

  const svnConflicts = computed(() => (state.tasks["client.svn"].result?.conflicts || []).map((path) => ({
    path,
    choice: state.conflictChoices[path] || "",
  })));
  const conflictsPending = computed(() => state.tasks["client.svn"].status === TASK_STATUS.ATTENTION);

  const selectedTemplate = computed(() =>
    templateList.value.find((template) => template.id === platform.value.transferTemplateId) || null);

  const diffFiles = DEMO_DIFF_FILES;

  /* ── GM ── */
  const gmFiles = computed(() => {
    const day = state.brief.date.replace(/-/g, "");
    return {
      activity: `activity_${day}.xlsx`,
      server: `gameserver_${day}.zip`,
      client: `jswz_hotupdate_${DEMO_HOT_UPDATE.next}.zip`,
      clientVersion: DEMO_HOT_UPDATE.next,
    };
  });

  /* ── Server clock ── */
  // The GM side keeps time: maintenance starts by itself when its time comes.
  // The demo can move this clock forward instead of waiting.
  const clock = ref(now().getTime());
  const stopClock = ticker(() => (clock.value = now().getTime()));
  const serverNow = computed(() => clock.value + state.demo.clockOffset);
  const phase = computed(() => serverPhase(state.tasks));
  const maintenanceStartAt = computed(() => localInputTime(state.schedule.maintenanceStart));
  const maintenanceEndAt = computed(() => localInputTime(state.schedule.maintenanceEnd));
  const openedAt = computed(() => Date.parse(state.tasks["gm.open"].result?.at || "") || 0);
  // A hot update that follows the end of maintenance opens with the servers
  // when they reopen early.
  const clientOpenAt = computed(() => {
    const planned = localInputTime(state.schedule.clientOpenAt);
    const early = state.schedule.clientOpenFollowsMaintenance && openedAt.value && openedAt.value < planned;
    return early ? openedAt.value : planned;
  });
  const players = computed(() => onlinePlayers(phase.value, {
    now: serverNow.value,
    openedAt: openedAt.value,
    base: DEMO_SERVERS.online,
  }));

  const cocosCommand = computed(() => cocosBuildCommand({
    editorPath: platform.value.cocosPath,
    projectPath: platform.value.targetClient,
    version: platform.value.cocosVersion,
    platform: platform.value.buildPlatform,
    configPath: platform.value.buildConfig ? `${platform.value.targetClient}\\${platform.value.buildConfig}` : "",
  }));

  /* ── Navigation ── */
  function go(pageId) {
    if (isReleaseTool(pageId)) {
      if (!isReleaseTool(state.page)) state.returnPage = state.page;
      state.page = pageId;
      return;
    }
    if (!RELEASE_PAGES.some((entry) => entry.id === pageId)) return;
    state.page = pageId;
  }

  function returnToFlow() {
    go(state.returnPage || "overview");
  }

  function step(direction) {
    const target = adjacentPage(state.page, state.brief, direction);
    if (target) go(target);
  }

  // Finished tasks that used a changed input are reset and marked stale, so
  // their pages say why they need to run again.
  function invalidate(roots) {
    return invalidateTasks(state.tasks, roots);
  }

  /* ── Brief ── */
  function setPlatform(platformId) {
    if (busy.value || state.brief.started || !state.platforms.some((entry) => entry.id === platformId)) return false;
    state.brief.platformId = platformId;
    return true;
  }

  function setDate(dateIso) {
    if (busy.value || !isIsoDate(dateIso) || dateIso === state.brief.date) return false;
    const previous = state.brief.date;
    state.brief.date = dateIso;
    for (const key of ["maintenanceStart", "maintenanceEnd", "clientOpenAt"]) {
      state.schedule[key] = shiftDate(state.schedule[key], previous, dateIso);
    }
    invalidate(["db.plans", "gm.maintenance", "gm.clientOpen"]);
    return true;
  }

  function setMode(mode) {
    if (busy.value || mode === state.brief.mode || !["maintenance", "hot"].includes(mode)) return false;
    state.brief.mode = mode;
    if (mode === "hot") state.brief.scope.server = false;
    normalizeTasks(state.tasks, state.brief);
    // Back to maintenance, a following hot update lines up with its end again.
    setSchedule({});
    return true;
  }

  function setScope(scope, enabled) {
    if (busy.value || !RELEASE_SCOPES.includes(scope)) return false;
    if (scope === "server" && enabled && state.brief.mode === "hot") return false;
    state.brief.scope[scope] = Boolean(enabled);
    normalizeTasks(state.tasks, state.brief);
    return true;
  }

  function setPrepared(value) {
    state.brief.prepared = Boolean(value);
  }

  const canStart = computed(() =>
    !state.brief.started && state.brief.prepared && RELEASE_SCOPES.some((scope) => state.brief.scope[scope]));

  function start() {
    if (!canStart.value) return false;
    ensureFutureSchedule();
    state.brief.started = true;
    appendHistory(state.history, { at: now().getTime(), taskId: "", event: "started" });
    step(1);
    return true;
  }

  /** Begin a new release: keep platforms, notes and exclusions, drop progress. */
  function restart({ resetDemoData = false } = {}) {
    if (busy.value) return false;
    const keep = resetDemoData ? null : snapshotOf(state);
    const fresh = createReleaseFlowData({
      stored: keep && {
        ...keep,
        brief: { platformId: keep.brief.platformId },
        tasks: {},
        history: [],
        conflictChoices: {},
        page: "overview",
        returnPage: "overview",
        schedule: null,
        demo: { ...keep.demo, clockOffset: 0 },
      },
      today: localDateIso(now()),
    });
    Object.assign(state, fresh);
    return true;
  }

  /* ── Inputs ── */
  function setNote(itemId, platformId, text) {
    if (!state.notes[itemId] || !state.platforms.some((entry) => entry.id === platformId)) return;
    const value = String(text ?? "").slice(0, 200);
    if (state.notes[itemId][platformId] === value) return;
    state.notes[itemId][platformId] = value;
    if (platformId === platform.value.id) invalidate(["db.plans"]);
  }

  function setSyncExclusions(tables) {
    if (busy.value) return;
    const next = cleanTableNames(tables);
    if (next.join("\u001f") === syncExclusions.value.join("\u001f")) return;
    state.syncExclusions[platform.value.id] = next;
    invalidate(["db.sync"]);
  }

  function toggleSyncExclusion(table) {
    const current = syncExclusions.value;
    setSyncExclusions(current.includes(table) ? current.filter((name) => name !== table) : [...current, table]);
  }

  function setFileRules(rules) {
    if (busy.value) return;
    const next = cleanExclusionRules(rules);
    if (next.join("\u001f") === fileRules.value.join("\u001f")) return;
    state.fileExclusions[platform.value.id] = next;
    invalidate(["client.sync"]);
  }

  function setMirrorDeletes(value) {
    if (busy.value || state.mirrorDeletes === Boolean(value)) return;
    state.mirrorDeletes = Boolean(value);
    invalidate(["client.sync"]);
  }

  function setConflictChoice(path, choice) {
    if (busy.value || !CONFLICT_CHOICES.includes(choice)) return;
    state.conflictChoices[path] = choice;
  }

  function setAllConflictChoices(choice) {
    for (const conflict of svnConflicts.value) setConflictChoice(conflict.path, choice);
  }

  function updatePlatform(platformId, patch = {}) {
    const target = state.platforms.find((entry) => entry.id === platformId);
    if (!target || busy.value) return;
    const roots = [];
    for (const field of PLATFORM_FIELDS) {
      if (!Object.hasOwn(patch, field) || typeof patch[field] !== "string" || patch[field] === target[field]) continue;
      target[field] = field === "name" ? patch[field].slice(0, 40) : patch[field].trim();
      if (platformId === platform.value.id && PLATFORM_FIELD_TASKS[field]) roots.push(PLATFORM_FIELD_TASKS[field]);
    }
    if (roots.length) invalidate(roots);
  }

  function setSchedule(patch = {}) {
    if (busy.value) return;
    const before = { ...state.schedule };
    for (const key of ["maintenanceStart", "maintenanceEnd", "clientOpenAt"]) {
      if (typeof patch[key] === "string" && patch[key]) state.schedule[key] = patch[key];
    }
    if (typeof patch.clientOpenFollowsMaintenance === "boolean") {
      state.schedule.clientOpenFollowsMaintenance = patch.clientOpenFollowsMaintenance;
    }
    // Only a maintenance has an end to follow; without downtime the time is the person's.
    if (state.brief.mode === "maintenance" && state.schedule.clientOpenFollowsMaintenance) {
      state.schedule.clientOpenAt = state.schedule.maintenanceEnd;
    }
    const roots = [];
    if (before.maintenanceStart !== state.schedule.maintenanceStart || before.maintenanceEnd !== state.schedule.maintenanceEnd) {
      roots.push("gm.maintenance");
    }
    if (before.clientOpenAt !== state.schedule.clientOpenAt) roots.push("gm.clientOpen");
    if (roots.length) invalidate(roots);
  }

  const scheduleProblem = computed(() => {
    const { maintenanceStart, maintenanceEnd, clientOpenAt: openAt } = state.schedule;
    const maintenance = state.brief.mode === "maintenance";
    if (maintenance && maintenanceEnd <= maintenanceStart) return "endBeforeStart";
    if (maintenance && state.tasks["gm.maintenance"].status === TASK_STATUS.IDLE && maintenanceStartAt.value <= serverNow.value) {
      return "startPassed";
    }
    if (maintenance && state.brief.scope.client && openAt < maintenanceEnd) return "clientBeforeEnd";
    return "";
  });

  /** Move a schedule that already lies in the past to a quarter hour from now. */
  function ensureFutureSchedule() {
    if (state.tasks["gm.maintenance"].status !== TASK_STATUS.IDLE) return false;
    if (maintenanceStartAt.value > serverNow.value) return false;
    return suggestSchedule();
  }

  function suggestSchedule() {
    if (busy.value) return false;
    const { start, end } = suggestedWindow(serverNow.value);
    setSchedule({ maintenanceStart: start, maintenanceEnd: end });
    return true;
  }

  /**
   * Hand the schedule to the GM: the maintenance window, then (with a client
   * in the release) when the hot update opens. Both are handed over or
   * neither, so the hot update never misses its opening time.
   */
  const SCHEDULE_TASKS = Object.freeze(["gm.maintenance", "gm.clientOpen"]);
  const scheduleBlocker = computed(() => SCHEDULE_TASKS.find((id) => applies(id) && blockerOf(id)) || "");

  async function scheduleMaintenance() {
    const ids = SCHEDULE_TASKS.filter((id) => applies(id) && state.tasks[id].status !== TASK_STATUS.DONE);
    if (!ids.length || scheduleBlocker.value) return false;
    if (scheduleProblem.value === "endBeforeStart" || scheduleProblem.value === "startPassed") return false;
    for (const id of ids) {
      if (!(await runTask(id))) return false;
    }
    return true;
  }

  /** Before the servers close, a schedule can still be withdrawn. */
  function cancelSchedule() {
    if (busy.value || phase.value !== "scheduled") return false;
    invalidateTasks(state.tasks, ["gm.maintenance", "gm.clientOpen"]);
    record("gm.maintenance", "cancelled");
    return true;
  }

  // A shutdown the GM refused waits for a person to retry it; one cut off by
  // closing the workspace simply runs again.
  const shutdownRefused = computed(() => {
    const shutdown = state.tasks["gm.shutdown"];
    return shutdown.status === TASK_STATUS.FAILED && shutdown.error !== "interrupted";
  });

  // The shutdown is the GM's, not a click: it runs once the clock passes the
  // scheduled start, wherever the person is in the workspace.
  function maybeAutoShutdown() {
    if (phase.value !== "scheduled" || shutdownRefused.value || busy.value || !applies("gm.shutdown")) return Promise.resolve(false);
    if (serverNow.value < maintenanceStartAt.value) return Promise.resolve(false);
    return runTask("gm.shutdown");
  }

  /** Demo only: jump the server clock to the start of maintenance. */
  function fastForward() {
    if (phase.value !== "scheduled") return Promise.resolve(false);
    state.demo.clockOffset += Math.max(0, maintenanceStartAt.value - serverNow.value);
    return maybeAutoShutdown();
  }

  const stopAutoShutdown = watch([serverNow, phase, busy], () => void maybeAutoShutdown());

  function setPlanCategory(category) {
    if (RELEASE_PLAN_CATEGORIES.some((entry) => entry.id === category)) state.planCategory = category;
  }

  function setDemoOption(key, value) {
    if (key === "speed") {
      if (Object.hasOwn(RELEASE_SPEEDS, value)) state.demo.speed = value;
      return;
    }
    if (key === "conflicts" || key === "buildFailure") state.demo[key] = Boolean(value);
  }

  /* ── Running tasks ── */
  function contextFor(taskId) {
    return {
      taskId,
      brief: plain(state.brief),
      platform: plain(platform.value),
      schedule: plain(state.schedule),
      syncPlan: plain(syncPlan.value),
      plan: { counts: { ...planCounts.value }, statements: [...planSql.value] },
      files: plain(fileSyncPlan.value),
      template: plain(selectedTemplate.value),
      diff: diffFiles,
      cocos: { command: plain(cocosCommand.value) },
      gmFiles: { ...gmFiles.value },
      results: Object.fromEntries(RELEASE_TASKS.map((definition) => [definition.id, plain(state.tasks[definition.id].result)])),
      demo: { ...state.demo },
      attempt: state.attempts[taskId] || 1,
      now,
      serverNow: () => serverNow.value,
    };
  }

  function record(taskId, event) {
    const entry = { at: now().getTime(), taskId, event };
    // GM steps also keep the server's time, which the demo can fast-forward.
    if (taskId.startsWith("gm.")) entry.serverAt = serverNow.value;
    appendHistory(state.history, entry);
  }

  function createIo(entry, taskId, signal) {
    const factor = RELEASE_SPEEDS[state.demo.speed] ?? 1;
    return {
      log(text, tone = "") {
        appendTaskLog(entry, text, tone);
      },
      progress(fraction) {
        if (progress.taskId === taskId) progress.fraction = Math.max(0, Math.min(1, Number(fraction) || 0));
      },
      wait(ms) {
        return sleep(ms * factor, signal);
      },
    };
  }

  async function perform(taskId, driverTaskId, { fresh = true, conflicts = [], finish }) {
    const context = { ...contextFor(taskId), conflicts, previous: plain(state.tasks[taskId].result) };
    const previous = state.tasks[taskId];
    state.tasks[taskId] = fresh
      ? { ...idleTaskState(), status: TASK_STATUS.RUNNING, startedAt: now().getTime() }
      : { ...previous, status: TASK_STATUS.RUNNING, error: "" };
    const entry = state.tasks[taskId];
    progress.taskId = taskId;
    progress.fraction = 0;
    const current = new AbortController();
    controller = current;
    try {
      const result = await driver.run(driverTaskId, context, createIo(entry, taskId, current.signal));
      if (current.signal.aborted) throw cancelledError();
      finish(entry, plain(result) || {});
      entry.finishedAt = now().getTime();
      record(taskId, entry.status);
      return true;
    } catch (error) {
      entry.finishedAt = now().getTime();
      if (error?.code === "cancelled" || current.signal.aborted) {
        appendTaskLog(entry, t("releaseFlow.log.cancelled"), "warning");
        entry.status = fresh ? TASK_STATUS.IDLE : previous.status;
        record(taskId, "cancelled");
      } else {
        entry.status = TASK_STATUS.FAILED;
        entry.error = String(error?.code || error?.message || error || "failed");
        if (Number.isFinite(error?.exitCode)) entry.result = { exitCode: error.exitCode };
        record(taskId, TASK_STATUS.FAILED);
      }
      return false;
    } finally {
      if (controller === current) controller = null;
      progress.taskId = "";
      persistence.flush();
    }
  }

  async function runTask(taskId) {
    if (taskBlocker(taskId, state.tasks, state.brief)) return false;
    if (state.tasks[taskId].status !== TASK_STATUS.IDLE) {
      // Rerunning finished work makes everything built on it out of date.
      invalidateTasks(state.tasks, [taskId], { includeRoots: false });
    }
    if (taskId === "client.svn") state.conflictChoices = {};
    state.attempts[taskId] = (state.attempts[taskId] || 0) + 1;
    return perform(taskId, taskId, {
      finish(entry, result) {
        const written = applyDemoDatabase(taskId);
        entry.result = taskId === "db.plans" ? { ...result, written } : result;
        entry.status = taskId === "client.svn" && result.conflicts?.length ? TASK_STATUS.ATTENTION : TASK_STATUS.DONE;
      },
    });
  }

  const conflictsReady = computed(() => svnConflicts.value.length > 0 && svnConflicts.value.every((conflict) => conflict.choice));

  async function resolveConflicts() {
    if (busy.value || !conflictsPending.value || !conflictsReady.value) return false;
    const conflicts = plain(svnConflicts.value);
    const previous = plain(state.tasks["client.svn"].result);
    return perform("client.svn", "client.svnResolve", {
      fresh: false,
      conflicts,
      finish(entry, result) {
        entry.result = { ...previous, ...result, conflicts: previous.conflicts, choices: conflicts.map((conflict) => conflict.choice) };
        entry.status = TASK_STATUS.DONE;
      },
    });
  }

  function skipTask(taskId) {
    const definition = RELEASE_TASK_BY_ID.get(taskId);
    if (!definition?.skippable || taskBlocker(taskId, state.tasks, state.brief)) return false;
    invalidateTasks(state.tasks, [taskId], { includeRoots: false });
    state.tasks[taskId] = { ...idleTaskState(), status: TASK_STATUS.SKIPPED, finishedAt: now().getTime() };
    record(taskId, TASK_STATUS.SKIPPED);
    return true;
  }

  function cancel() {
    controller?.abort();
  }

  function taskState(taskId) {
    return state.tasks[taskId];
  }

  function blockerOf(taskId) {
    return taskBlocker(taskId, state.tasks, state.brief);
  }

  function applies(taskId) {
    return taskApplies(RELEASE_TASK_BY_ID.get(taskId), state.brief);
  }

  function dispose() {
    controller?.abort();
    stopClock();
    stopAutoShutdown();
    stopPersisting();
    persistence.flush();
  }

  return {
    state,
    progress,
    locale: language.locale,
    platform,
    pages,
    runningTask,
    busy,
    progressSummary,
    complete,
    canStart,
    templates: templateList,
    syncExclusions,
    syncPlan,
    planGroups,
    planCounts,
    planSql,
    fileRules,
    fileSyncPlan,
    svnConflicts,
    conflictsPending,
    conflictsReady,
    selectedTemplate,
    diffFiles,
    cocosCommand,
    gmFiles,
    scheduleProblem,
    scheduleBlocker,
    serverNow,
    serverPhase: phase,
    shutdownRefused,
    players,
    maintenanceStartAt,
    maintenanceEndAt,
    openedAt,
    clientOpenAt,
    tools: RELEASE_TOOLS,
    noteFor,
    go,
    returnToFlow,
    step,
    setPlatform,
    setDate,
    setMode,
    setScope,
    setPrepared,
    start,
    restart,
    setNote,
    setSyncExclusions,
    toggleSyncExclusion,
    setFileRules,
    setMirrorDeletes,
    setConflictChoice,
    setAllConflictChoices,
    updatePlatform,
    setSchedule,
    suggestSchedule,
    scheduleMaintenance,
    cancelSchedule,
    fastForward,
    setPlanCategory,
    setDemoOption,
    runTask,
    resolveConflicts,
    skipTask,
    cancel,
    taskState,
    blockerOf,
    applies,
    dispose,
  };
}
