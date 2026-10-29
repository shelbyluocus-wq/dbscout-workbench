import { computed, reactive, watch } from "vue";
import { language, t } from "../i18n/index.js";
import {
  RELEASE_PAGES,
  RELEASE_SCOPES,
  RELEASE_TASKS,
  RELEASE_TASK_BY_ID,
  TASK_STATUS,
  adjacentPage,
  appendHistory,
  appendTaskLog,
  flowComplete,
  flowProgress,
  idleTaskState,
  invalidateTasks,
  normalizeTasks,
  pageApplies,
  pageStatus,
  runningTaskId,
  taskApplies,
  taskBlocker,
} from "../releaseFlowState.js";
import { CONFLICT_CHOICES, RELEASE_SPEEDS, cleanTableNames, shiftDate } from "../releaseWorkspaceState.js";
import { countPlanChanges, isIsoDate, parsePlanNote, planChanges, planStatements } from "../utils/releasePlanNotes.js";
import {
  DEMO_CLIENT_CHANGES,
  DEMO_CONFIG_TABLES,
  DEMO_DIFF_FILES,
  DEMO_GM,
  DEMO_HOT_UPDATE,
  DEMO_SERVERS,
  RELEASE_PLAN_CATEGORIES,
  demoDatabaseFlag,
  planEntryKey,
} from "../utils/releaseFlowDemo.js";
import { localInputTime, onlinePlayers, serverPhase, suggestedWindow } from "../utils/releaseServer.js";
import { cleanExclusionRules, excludingRule } from "../utils/releaseFileRules.js";
import { cocosBuildCommand, cocosBuildOptions } from "../utils/cocosBuildCommand.js";
import { formatDateTime } from "../utils/releaseFlowFormat.js";
import { createAutopilot } from "./useReleaseAutopilot.js";

export { CONFLICT_CHOICES, RELEASE_SPEEDS };

function cancelledError() {
  const error = new Error("cancelled");
  error.code = "cancelled";
  return error;
}

export function abortableSleep(ms, signal) {
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

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * State and actions of one platform's update inside the release workspace.
 * Every task runs through `driver`; this prepares each task's input, records
 * its logs, result and events, and resets later work when an earlier input
 * changes. Platforms, the open-plan memo, the rules and the demo options
 * belong to the workspace and are shared by every update.
 */
export function createRunFlow({
  workspace,
  run,
  driver,
  templates = computed(() => []),
  sleep = abortableSleep,
  now = () => new Date(),
  // The real time, ticking; each update's GM clock adds its own demo offset.
  clock,
  flush = () => {},
  onSettled = () => {},
}) {
  const state = run;
  const progress = reactive({ taskId: "", fraction: 0 });
  let controller = null;

  const platform = computed(() => workspace.platforms.find((entry) => entry.id === state.platformId) || workspace.platforms[0]);
  const runningTask = computed(() => runningTaskId(state.tasks));
  const busy = computed(() => Boolean(runningTask.value));
  const finished = computed(() => state.outcome === "done");
  const progressSummary = computed(() => flowProgress(state.tasks, state.brief));
  const complete = computed(() => flowComplete(state.tasks, state.brief));
  const templateList = computed(() => templates.value || []);

  const pages = computed(() => RELEASE_PAGES.map((entry) => ({
    ...entry,
    applies: pageApplies(entry.id, state.brief),
    status: pageStatus(entry.id, state.tasks, state.brief),
  })));

  /* ── Database ── */
  const syncExclusions = computed(() => workspace.rules.syncExclusions[platform.value.id] || []);
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

  function noteFor(entry, platformId = platform.value.id) {
    return entry?.notes?.[platformId] ?? "";
  }

  // The memo entries this update can write: a category with a plan table and
  // an ID naming the row. Entries left out by the person stay listed but are
  // not written.
  const planGroups = computed(() => {
    const excluded = new Set(syncExclusions.value);
    const flags = workspace.demoFlags[platform.value.id] || {};
    return RELEASE_PLAN_CATEGORIES.map((category) => {
      const synced = !excluded.has(category.table);
      const entries = workspace.plans.items
        .filter((entry) => entry.category === category.id)
        .map((entry) => ({ entry, key: planEntryKey(entry) }))
        .filter(({ key }) => key !== null)
        .map(({ entry, key }) => ({ ...entry, key }));
      const rows = planChanges(entries, {
        dateIso: state.brief.date,
        noteFor: (item) => noteFor(item),
        currentFor: (item) => flags[item.id]
          ?? demoDatabaseFlag(item, { synced, note: noteFor(item), dateIso: state.brief.date }),
      }).map((row) => ({ ...row, excluded: state.planSkips[row.item.id] === true }));
      return { ...category, synced, rows, counts: countPlanChanges(rows.filter((row) => !row.excluded)) };
    });
  });

  // Memo entries whose note changes them on the update day but which name no
  // table row (other topics, a missing ID): the page lists them to do by hand.
  const planReminders = computed(() => workspace.plans.items.filter((entry) => {
    if (planEntryKey(entry) !== null) return false;
    const rule = parsePlanNote(noteFor(entry), state.brief.date);
    return rule.kind === "window" && (rule.from === state.brief.date || rule.to === state.brief.date);
  }));

  // Notes the plan write leaves to a person: unreadable ones and reminders.
  const planNotesLeft = computed(() => planGroups.value
    .reduce((sum, group) => sum + group.rows.filter((row) => row.change === "skip").length, 0) + planReminders.value.length);

  const writtenGroups = computed(() => planGroups.value.map((group) => ({ ...group, rows: group.rows.filter((row) => !row.excluded) })));
  const planCounts = computed(() => countPlanChanges(writtenGroups.value.flatMap((group) => group.rows)));
  const planSql = computed(() => planStatements(writtenGroups.value));

  // What a finished task did to the demo platform database: an overwrite
  // brings development values back into synced tables, a plan write stores
  // the planned flags. Returns the flags written by a plan write.
  function applyDemoDatabase(taskId) {
    const written = {};
    if (taskId !== "db.sync" && taskId !== "db.plans") return written;
    const flags = workspace.demoFlags[platform.value.id] || (workspace.demoFlags[platform.value.id] = {});
    for (const group of planGroups.value) {
      for (const row of group.rows) {
        if (taskId === "db.sync" && group.synced) delete flags[row.item.id];
        if (taskId === "db.plans" && !row.excluded && (row.change === "open" || row.change === "close")) {
          written[row.item.id] = row.next;
        }
      }
    }
    Object.assign(flags, written);
    return written;
  }

  // The overwrite's backup; a restore is only offered when one was made.
  const backup = computed(() => {
    const sync = state.tasks["db.sync"];
    return sync.status === TASK_STATUS.DONE && sync.result?.backup?.id ? sync.result.backup : null;
  });

  // What a restore undoes, for its confirmation.
  const restoreImpact = computed(() => {
    const target = backup.value;
    if (!target) return [];
    const lines = [t("releaseFlow.backup.impact.tables", { count: target.tables, time: formatDateTime(target.at) })];
    const written = state.tasks["db.plans"].status === TASK_STATUS.DONE ? Object.keys(state.tasks["db.plans"].result?.written || {}).length : 0;
    if (written) lines.push(t("releaseFlow.backup.impact.plans", { count: written }));
    lines.push(t("releaseFlow.backup.impact.rerun"));
    return lines;
  });

  /* ── Client ── */
  const fileRules = computed(() => workspace.rules.fileExclusions[platform.value.id] || []);
  const fileSyncPlan = computed(() => {
    const copy = [];
    const remove = [];
    const kept = [];
    const excluded = [];
    for (const change of DEMO_CLIENT_CHANGES) {
      const rule = excludingRule(change.path, fileRules.value);
      if (rule) excluded.push({ ...change, rule });
      else if (change.status !== "D") copy.push(change);
      else if (workspace.rules.mirrorDeletes) remove.push(change);
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
  // File names follow the GM's conventions: the activity table is named
  // "platform_comment.xlsx", a hot update "ver_platform_version.zip" and a
  // server version "servver_platform_version.zip".
  const gmFiles = computed(() => {
    const day = state.brief.date.replace(/-/g, "");
    const id = platform.value.id;
    return {
      activity: `${id}_activity_${day}.xlsx`,
      server: `servver_${id}_${DEMO_GM.serverVersion}.zip`,
      client: `ver_${id}_${DEMO_HOT_UPDATE.next}.zip`,
      clientVersion: DEMO_HOT_UPDATE.next,
    };
  });

  /* ── Server clock ── */
  // The GM side keeps time: maintenance starts by itself when its time comes.
  // The demo can move this update's clock forward instead of waiting.
  const serverNow = computed(() => clock.value + (state.clockOffset || 0));
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

  const buildOptions = computed(() => cocosBuildOptions(platform.value));
  const cocosCommand = computed(() => cocosBuildCommand(buildOptions.value));

  /* ── Navigation ── */
  function go(pageId) {
    if (!RELEASE_PAGES.some((entry) => entry.id === pageId)) return false;
    state.page = pageId;
    return true;
  }

  function step(direction) {
    const target = adjacentPage(state.page, state.brief, direction);
    if (target) go(target);
  }

  // Finished tasks that used a changed input are reset and marked stale, so
  // their pages say why they need to run again.
  function invalidate(roots) {
    if (finished.value) return [];
    return invalidateTasks(state.tasks, roots);
  }

  function editable() {
    return !busy.value && !finished.value;
  }

  /* ── Brief ── */
  function setDate(dateIso) {
    if (!editable() || !isIsoDate(dateIso) || dateIso === state.brief.date) return false;
    const previous = state.brief.date;
    state.brief.date = dateIso;
    for (const key of ["maintenanceStart", "maintenanceEnd", "clientOpenAt"]) {
      state.schedule[key] = shiftDate(state.schedule[key], previous, dateIso);
    }
    invalidate(["db.plans", "gm.maintenance", "gm.clientOpen"]);
    return true;
  }

  function setMode(mode) {
    if (!editable() || mode === state.brief.mode || !["maintenance", "hot"].includes(mode)) return false;
    state.brief.mode = mode;
    if (mode === "hot") state.brief.scope.server = false;
    normalizeTasks(state.tasks, state.brief);
    // Back to maintenance, a following hot update lines up with its end again.
    setSchedule({});
    return true;
  }

  function setScope(scope, enabled) {
    if (!editable() || !RELEASE_SCOPES.includes(scope)) return false;
    if (scope === "server" && enabled && state.brief.mode === "hot") return false;
    state.brief.scope[scope] = Boolean(enabled);
    normalizeTasks(state.tasks, state.brief);
    return true;
  }

  function setPrepared(value) {
    if (state.brief.started) return;
    state.brief.prepared = Boolean(value);
  }

  const canStart = computed(() =>
    !state.brief.started && state.brief.prepared && RELEASE_SCOPES.some((scope) => state.brief.scope[scope]));

  function record(taskId, event) {
    const entry = { at: now().getTime(), taskId, event };
    // GM steps also keep the server's time, which the demo can fast-forward.
    if (taskId.startsWith("gm.")) entry.serverAt = serverNow.value;
    appendHistory(state.events, entry);
  }

  function start() {
    if (!canStart.value) return false;
    ensureFutureSchedule();
    state.brief.started = true;
    state.startedAt = now().getTime();
    appendHistory(state.events, { at: state.startedAt, taskId: "", event: "started" });
    step(1);
    return true;
  }

  /* ── Inputs ── */
  function setSyncExclusions(tables) {
    if (!editable()) return;
    const next = cleanTableNames(tables);
    if (next.join("\u001f") === syncExclusions.value.join("\u001f")) return;
    workspace.rules.syncExclusions[platform.value.id] = next;
    invalidate(["db.sync"]);
  }

  function toggleSyncExclusion(table) {
    const current = syncExclusions.value;
    setSyncExclusions(current.includes(table) ? current.filter((name) => name !== table) : [...current, table]);
  }

  function setPlanSkip(itemId, skipped) {
    if (!editable() || Boolean(state.planSkips[itemId]) === Boolean(skipped)) return;
    if (skipped) state.planSkips[itemId] = true;
    else delete state.planSkips[itemId];
    invalidate(["db.plans"]);
  }

  function setFileRules(rules) {
    if (!editable()) return false;
    const next = cleanExclusionRules(rules);
    if (next.join("\u001f") === fileRules.value.join("\u001f")) return false;
    workspace.rules.fileExclusions[platform.value.id] = next;
    invalidate(["client.sync"]);
    return true;
  }

  function setMirrorDeletes(value) {
    if (!editable() || workspace.rules.mirrorDeletes === Boolean(value)) return;
    workspace.rules.mirrorDeletes = Boolean(value);
    invalidate(["client.sync"]);
  }

  function setConflictChoice(path, choice) {
    if (!editable() || !CONFLICT_CHOICES.includes(choice)) return;
    state.conflictChoices[path] = choice;
  }

  function setAllConflictChoices(choice) {
    for (const conflict of svnConflicts.value) setConflictChoice(conflict.path, choice);
  }

  function setSchedule(patch = {}) {
    if (!editable()) return;
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
    if (!editable()) return false;
    const { start: from, end } = suggestedWindow(serverNow.value);
    setSchedule({ maintenanceStart: from, maintenanceEnd: end });
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
    if (!editable() || phase.value !== "scheduled") return false;
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
    state.clockOffset = (state.clockOffset || 0) + Math.max(0, maintenanceStartAt.value - serverNow.value);
    return maybeAutoShutdown();
  }

  const stopAutoShutdown = watch([serverNow, phase, busy], () => void maybeAutoShutdown());

  /* ── Running tasks ── */
  const attempts = {};

  function contextFor(taskId) {
    return {
      taskId,
      runId: state.id,
      brief: plain(state.brief),
      platform: plain(platform.value),
      schedule: plain(state.schedule),
      syncPlan: plain(syncPlan.value),
      plan: { counts: { ...planCounts.value }, statements: [...planSql.value] },
      files: plain(fileSyncPlan.value),
      template: plain(selectedTemplate.value),
      diff: diffFiles,
      build: plain(buildOptions.value),
      cocos: { command: plain(cocosCommand.value) },
      gmFiles: { ...gmFiles.value },
      backup: plain(backup.value),
      results: Object.fromEntries(RELEASE_TASKS.map((definition) => [definition.id, plain(state.tasks[definition.id].result)])),
      demo: { ...workspace.demo },
      attempt: attempts[taskId] || 1,
      now,
      serverNow: () => serverNow.value,
    };
  }

  function createIo(entry, taskId, signal) {
    const factor = RELEASE_SPEEDS[workspace.demo.speed] ?? 1;
    return {
      signal,
      log(line, tone = "") {
        appendTaskLog(entry, line, tone);
      },
      // A fraction from 0 to 1, or null while the tool reports no progress.
      progress(fraction) {
        if (progress.taskId !== taskId) return;
        progress.fraction = fraction === null ? null : Math.max(0, Math.min(1, Number(fraction) || 0));
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
        // A tool that failed may still say why (exit code, output folder, findings).
        if (error?.result) entry.result = plain(error.result);
        else if (Number.isFinite(error?.exitCode)) entry.result = { exitCode: error.exitCode };
        record(taskId, TASK_STATUS.FAILED);
      }
      return false;
    } finally {
      if (controller === current) controller = null;
      progress.taskId = "";
      flush();
      onSettled(state);
    }
  }

  function blockerOf(taskId) {
    if (finished.value) return "finished";
    const blocker = taskBlocker(taskId, state.tasks, state.brief);
    if (blocker || taskId !== "db.restore") return blocker;
    return backup.value ? "" : "noBackup";
  }

  async function runTask(taskId) {
    if (blockerOf(taskId)) return false;
    if (state.tasks[taskId].status !== TASK_STATUS.IDLE) {
      // Rerunning finished work makes everything built on it out of date.
      invalidateTasks(state.tasks, [taskId], { includeRoots: false });
    }
    if (taskId === "client.svn") state.conflictChoices = {};
    // A new overwrite makes an earlier restore history.
    if (taskId === "db.sync") state.tasks["db.restore"] = idleTaskState();
    // New client content means a new working copy to review.
    if (["client.svn", "client.sync", "client.transfer"].includes(taskId)) {
      state.svnDemo = { committed: [], reverted: [], revision: state.svnDemo?.revision || 0, commits: state.svnDemo?.commits || [] };
    }
    attempts[taskId] = (attempts[taskId] || 0) + 1;
    return perform(taskId, taskId, {
      finish(entry, result) {
        if (taskId === "db.restore") {
          entry.result = result;
          entry.status = TASK_STATUS.DONE;
          // The platform database is back to its state before the overwrite:
          // the overwrite and everything built on it has to run again.
          invalidateTasks(state.tasks, ["db.sync"]);
          workspace.demoFlags[platform.value.id] = {};
          return;
        }
        const written = applyDemoDatabase(taskId);
        entry.result = taskId === "db.plans" ? { ...result, written } : result;
        entry.status = taskId === "client.svn" && result.conflicts?.length ? TASK_STATUS.ATTENTION : TASK_STATUS.DONE;
      },
    });
  }

  const conflictsReady = computed(() => svnConflicts.value.length > 0 && svnConflicts.value.every((conflict) => conflict.choice));

  async function resolveConflicts() {
    if (!editable() || !conflictsPending.value || !conflictsReady.value) return false;
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
    if (!definition?.skippable || blockerOf(taskId)) return false;
    invalidateTasks(state.tasks, [taskId], { includeRoots: false });
    state.tasks[taskId] = { ...idleTaskState(), status: TASK_STATUS.SKIPPED, finishedAt: now().getTime() };
    record(taskId, TASK_STATUS.SKIPPED);
    onSettled(state);
    return true;
  }

  function cancel() {
    // Stopping a step also stops one-click mode, or it would run it again.
    autopilot?.pause("stopped", runningTask.value);
    controller?.abort();
  }

  function taskState(taskId) {
    return state.tasks[taskId];
  }

  function applies(taskId) {
    return taskApplies(RELEASE_TASK_BY_ID.get(taskId), state.brief);
  }

  function dispose() {
    autopilot?.dispose();
    controller?.abort();
    stopAutoShutdown();
  }

  let autopilot = null;
  const api = {
    id: state.id,
    state,
    workspace,
    progress,
    locale: language.locale,
    platform,
    pages,
    runningTask,
    busy,
    finished,
    progressSummary,
    complete,
    canStart,
    templates: templateList,
    syncExclusions,
    syncPlan,
    planGroups,
    planCounts,
    planSql,
    planReminders,
    planNotesLeft,
    backup,
    restoreImpact,
    fileRules,
    fileSyncPlan,
    svnConflicts,
    conflictsPending,
    conflictsReady,
    selectedTemplate,
    diffFiles,
    buildOptions,
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
    noteFor,
    go,
    step,
    invalidate,
    setDate,
    setMode,
    setScope,
    setPrepared,
    start,
    setSyncExclusions,
    toggleSyncExclusion,
    setPlanSkip,
    setFileRules,
    setMirrorDeletes,
    setConflictChoice,
    setAllConflictChoices,
    setSchedule,
    suggestSchedule,
    scheduleMaintenance,
    cancelSchedule,
    fastForward,
    runTask,
    resolveConflicts,
    skipTask,
    cancel,
    taskState,
    blockerOf,
    applies,
    dispose,
  };
  autopilot = createAutopilot({
    flow: api,
    rules: () => workspace.autopilot,
    sleep,
    speed: () => RELEASE_SPEEDS[workspace.demo.speed] ?? 1,
    now,
  });
  api.autopilot = autopilot;
  return api;
}
