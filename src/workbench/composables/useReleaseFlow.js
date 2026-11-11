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
  appendTaskLogs,
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
import { CONFLICT_CHOICES, RELEASE_SPEEDS, cleanTableNames } from "../releaseWorkspaceState.js";
import {
  countPlanChanges,
  isIsoDate,
  parsePlanNote,
  planChanges,
  planFlagQueries,
  planStatements,
  planWriteGroups,
} from "../utils/releasePlanNotes.js";
import {
  DEMO_CLIENT_CHANGES,
  DEMO_CONFIG_TABLES,
  DEMO_DIFF_FILES,
  RELEASE_PLAN_CATEGORIES,
  demoDatabaseFlag,
  planEntryKey,
} from "../utils/releaseFlowDemo.js";
import { cleanExclusionRules, excludingRule } from "../utils/releaseFileRules.js";
import { cocosBuildCommand, cocosBuildOptions } from "../utils/cocosBuildCommand.js";
import { formatDateTime } from "../utils/releaseFlowFormat.js";
import { normalizeTableName } from "../utils/normalize.js";
import { invokeWorkbench } from "../utils/tauriBridge.js";
import { createAutopilot } from "./useReleaseAutopilot.js";
import { resolvePlatformConnection } from "./useReleaseRealDriver.js";

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
  connections = computed(() => []),
  databasesByConnection = computed(() => ({})),
  invoke = invokeWorkbench,
  realMode = false,
  sleep = abortableSleep,
  now = () => new Date(),
  flush = () => {},
  onSettled = () => {},
}) {
  const state = run;
  const progress = reactive({ taskId: "", fraction: 0 });
  let controller = null;
  const watchers = [];
  const tickets = { db: 0, plans: 0, files: 0 };

  const isReal = computed(() => Boolean(realMode) && state.demo === false);
  const platform = computed(() => workspace.platforms.find((entry) => entry.id === state.platformId) || workspace.platforms[0]);
  const runningTask = computed(() => runningTaskId(state.tasks));
  const busy = computed(() => Boolean(runningTask.value));
  const finished = computed(() => state.outcome === "done");
  const progressSummary = computed(() => flowProgress(state.tasks, state.brief));
  const complete = computed(() => flowComplete(state.tasks, state.brief));
  const templateList = computed(() => templates.value || []);
  const connectionList = computed(() => connections.value || []);
  const databaseMap = computed(() => databasesByConnection.value || {});
  const resolvedConnection = computed(() => (
    isReal.value ? resolvePlatformConnection(platform.value, connectionList.value, databaseMap.value) : null
  ));

  const liveSync = reactive({
    ready: false,
    loading: false,
    error: "",
    tables: [],
    excluded: [],
    rows: 0,
    catalog: [],
    warnings: [],
  });
  const livePlans = reactive({
    ready: false,
    loading: false,
    error: "",
    flags: {},
    missingTables: [],
  });
  const liveFiles = reactive({
    ready: false,
    loading: false,
    error: "",
    copy: [],
    remove: [],
    kept: [],
    excluded: [],
    truncated: false,
  });

  const pages = computed(() => RELEASE_PAGES.map((entry) => ({
    ...entry,
    applies: pageApplies(entry.id, state.brief),
    status: pageStatus(entry.id, state.tasks, state.brief),
  })));

  /* ── Database ── */
  const syncExclusions = computed(() => workspace.rules.syncExclusions[platform.value.id] || []);
  const syncPlan = computed(() => {
    if (isReal.value) {
      return {
        tables: liveSync.tables,
        excluded: liveSync.excluded.length ? liveSync.excluded : [...syncExclusions.value],
        rows: liveSync.rows,
        catalog: liveSync.catalog,
        warnings: liveSync.warnings,
        loading: liveSync.loading,
        error: liveSync.error,
        ready: liveSync.ready,
      };
    }
    const excluded = new Set(syncExclusions.value);
    const tables = DEMO_CONFIG_TABLES.filter((table) => !excluded.has(table.name));
    return {
      tables,
      excluded: DEMO_CONFIG_TABLES.filter((table) => excluded.has(table.name)).map((table) => table.name),
      rows: tables.reduce((sum, table) => sum + table.rows, 0),
      catalog: DEMO_CONFIG_TABLES.map((table) => table.name),
      warnings: [],
      loading: false,
      error: "",
      ready: true,
    };
  });

  function noteFor(entry, platformId = platform.value.id) {
    return entry?.notes?.[platformId] ?? "";
  }

  function buildPlanCategoryEntries() {
    const excluded = new Set(syncExclusions.value);
    return RELEASE_PLAN_CATEGORIES.map((category) => {
      const synced = !excluded.has(category.table);
      const entries = workspace.plans.items
        .filter((entry) => entry.category === category.id)
        .map((entry) => ({ entry, key: planEntryKey(entry) }))
        .filter(({ key }) => key !== null)
        .map(({ entry, key }) => ({ ...entry, key }));
      return { ...category, synced, entries };
    });
  }

  // The memo entries this update can write: a category with a plan table and
  // an ID naming the row. Entries left out by the person stay listed but are
  // not written.
  const planGroups = computed(() => {
    const flags = workspace.demoFlags[platform.value.id] || {};
    return buildPlanCategoryEntries().map((category) => {
      const { synced, entries } = category;
      const rows = planChanges(entries, {
        dateIso: state.brief.date,
        noteFor: (item) => noteFor(item),
        currentFor: (item) => {
          if (isReal.value) {
            return livePlans.ready ? livePlans.flags[item.id] : null;
          }
          return flags[item.id]
            ?? demoDatabaseFlag(item, { synced, note: noteFor(item), dateIso: state.brief.date });
        },
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
    const planResult = state.tasks["db.plans"].status === TASK_STATUS.DONE ? state.tasks["db.plans"].result : null;
    const written = planResult
      ? (Object.keys(planResult.written || {}).length || (Number(planResult.open || 0) + Number(planResult.close || 0)))
      : 0;
    if (written) lines.push(t("releaseFlow.backup.impact.plans", { count: written }));
    lines.push(t("releaseFlow.backup.impact.rerun"));
    return lines;
  });

  /* ── Client ── */
  const fileRules = computed(() => workspace.rules.fileExclusions[platform.value.id] || []);
  const fileSyncPlan = computed(() => {
    if (isReal.value) {
      return {
        copy: liveFiles.copy,
        remove: liveFiles.remove,
        kept: liveFiles.kept,
        excluded: liveFiles.excluded,
        truncated: liveFiles.truncated,
        loading: liveFiles.loading,
        error: liveFiles.error,
        ready: liveFiles.ready,
      };
    }
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
    return { copy, remove, kept, excluded, truncated: false, loading: false, error: "", ready: true };
  });

  const svnConflicts = computed(() => (state.tasks["client.svn"].result?.conflicts || []).map((path) => ({
    path,
    choice: state.conflictChoices[path] || "",
  })));
  const conflictsPending = computed(() => state.tasks["client.svn"].status === TASK_STATUS.ATTENTION);

  const selectedTemplate = computed(() =>
    templateList.value.find((template) => template.id === platform.value.transferTemplateId) || null);

  const diffFiles = DEMO_DIFF_FILES;

  const buildOptions = computed(() => cocosBuildOptions(platform.value));
  const cocosCommand = computed(() => cocosBuildCommand(buildOptions.value));

  /* ── Live previews (real mode only) ── */
  async function refreshLiveDb() {
    const ticket = ++tickets.db;
    if (!isReal.value || typeof invoke !== "function") {
      Object.assign(liveSync, { ready: false, loading: false, error: "", tables: [], excluded: [], rows: 0, catalog: [], warnings: [] });
      return;
    }
    const connId = resolvedConnection.value?.id || "";
    const sourceDatabase = String(platform.value?.sourceDatabase || "").trim();
    const targetDatabase = String(platform.value?.targetDatabase || "").trim();
    if (!connId || !sourceDatabase) {
      Object.assign(liveSync, { ready: false, loading: false, error: "", tables: [], excluded: [...syncExclusions.value], rows: 0, catalog: [], warnings: [] });
      return;
    }
    liveSync.loading = true;
    liveSync.error = "";
    try {
      if (targetDatabase && targetDatabase.toLowerCase() !== sourceDatabase.toLowerCase()) {
        const preview = await invoke("preview_database_sync", {
          request: {
            connectionId: connId,
            sourceDatabase,
            targetDatabase,
            excludedTables: [...syncExclusions.value],
          },
        });
        if (ticket !== tickets.db) return;
        liveSync.tables = (preview?.includedTables || []).map((name) => ({ name }));
        liveSync.excluded = preview?.excludedTables || [...syncExclusions.value];
        liveSync.rows = Number(preview?.estimatedRows) || 0;
        liveSync.catalog = preview?.sourceTables || [];
        liveSync.warnings = preview?.warnings || [];
        liveSync.ready = true;
      } else {
        const rawTables = await invoke("list_tables", { connectionId: connId, database: sourceDatabase });
        if (ticket !== tickets.db) return;
        const catalog = (Array.isArray(rawTables) ? rawTables : [])
          .map((entry) => (typeof entry === "string" ? entry : normalizeTableName(entry) || entry?.name || ""))
          .filter(Boolean);
        const excludedSet = new Set(syncExclusions.value);
        liveSync.catalog = catalog;
        liveSync.tables = catalog.filter((name) => !excludedSet.has(name)).map((name) => ({ name }));
        liveSync.excluded = catalog.filter((name) => excludedSet.has(name));
        liveSync.rows = 0;
        liveSync.warnings = [];
        liveSync.ready = Boolean(targetDatabase);
      }
    } catch (error) {
      if (ticket !== tickets.db) return;
      liveSync.error = String(error?.message || error || "");
      liveSync.ready = false;
    } finally {
      if (ticket === tickets.db) liveSync.loading = false;
    }
  }

  async function refreshLivePlans({ forceTarget = false } = {}) {
    const ticket = ++tickets.plans;
    if (!isReal.value || typeof invoke !== "function") {
      Object.assign(livePlans, { ready: false, loading: false, error: "", flags: {}, missingTables: [] });
      return;
    }
    const connId = resolvedConnection.value?.id || "";
    const sourceDatabase = String(platform.value?.sourceDatabase || "").trim();
    const targetDatabase = String(platform.value?.targetDatabase || "").trim();
    const syncSettled = forceTarget
      || state.tasks["db.sync"].status === TASK_STATUS.DONE
      || state.tasks["db.sync"].status === TASK_STATUS.SKIPPED
      || !state.brief.scope.database;
    if (!connId || (!sourceDatabase && !targetDatabase)) {
      Object.assign(livePlans, { ready: false, loading: false, error: "", flags: {}, missingTables: [] });
      return;
    }
    const byDb = new Map();
    for (const group of buildPlanCategoryEntries()) {
      if (!group.entries.length) continue;
      const dbName = syncSettled
        ? targetDatabase
        : (group.synced ? (sourceDatabase || targetDatabase) : (targetDatabase || sourceDatabase));
      if (!dbName) continue;
      if (!byDb.has(dbName)) byDb.set(dbName, []);
      byDb.get(dbName).push(group);
    }
    if (!byDb.size) {
      Object.assign(livePlans, { ready: true, loading: false, error: "", flags: {}, missingTables: [] });
      return;
    }
    livePlans.loading = true;
    livePlans.error = "";
    try {
      const flags = {};
      const missing = new Set();
      await Promise.all([...byDb.entries()].map(async ([database, groups]) => {
        const queries = planFlagQueries(groups);
        if (!queries.length) return;
        const response = await invoke("release_read_plan_flags", {
          request: { connectionId: connId, database, groups: queries },
        });
        Object.assign(flags, response?.flags || {});
        for (const table of response?.missingTables || []) missing.add(table);
      }));
      if (ticket !== tickets.plans) return;
      livePlans.flags = flags;
      livePlans.missingTables = [...missing];
      livePlans.ready = true;
    } catch (error) {
      if (ticket !== tickets.plans) return;
      livePlans.error = String(error?.message || error || "");
      livePlans.ready = false;
    } finally {
      if (ticket === tickets.plans) livePlans.loading = false;
    }
  }

  async function refreshLiveFiles() {
    const ticket = ++tickets.files;
    if (!isReal.value || typeof invoke !== "function") {
      Object.assign(liveFiles, { ready: false, loading: false, error: "", copy: [], remove: [], kept: [], excluded: [], truncated: false });
      return;
    }
    const sourceClient = String(platform.value?.sourceClient || "").trim();
    const targetClient = String(platform.value?.targetClient || "").trim();
    if (!sourceClient || !targetClient) {
      Object.assign(liveFiles, { ready: false, loading: false, error: "", copy: [], remove: [], kept: [], excluded: [], truncated: false });
      return;
    }
    liveFiles.loading = true;
    liveFiles.error = "";
    try {
      const response = await invoke("release_client_sync_preview", {
        request: {
          sourceClient,
          targetClient,
          rules: [...fileRules.value],
          mirrorDeletes: Boolean(workspace.rules.mirrorDeletes),
        },
      });
      if (ticket !== tickets.files) return;
      liveFiles.copy = response?.copy || [];
      liveFiles.remove = response?.remove || [];
      liveFiles.kept = response?.kept || [];
      liveFiles.excluded = response?.excluded || [];
      liveFiles.truncated = Boolean(response?.truncated);
      liveFiles.ready = true;
    } catch (error) {
      if (ticket !== tickets.files) return;
      liveFiles.error = String(error?.message || error || "");
      liveFiles.ready = false;
    } finally {
      if (ticket === tickets.files) liveFiles.loading = false;
    }
  }

  async function refreshLiveState({ all = false } = {}) {
    if (!isReal.value) return;
    const jobs = [];
    if (all || state.page === "database") {
      jobs.push(refreshLiveDb(), refreshLivePlans());
    }
    if (all || state.page === "clientSync") {
      jobs.push(refreshLiveFiles());
    }
    await Promise.all(jobs);
  }

  if (realMode) {
    watchers.push(
      watch(
        () => [
          isReal.value,
          state.page === "database",
          resolvedConnection.value?.id || "",
          platform.value?.sourceDatabase || "",
          platform.value?.targetDatabase || "",
          syncExclusions.value.join("\u001f"),
        ],
        ([real, onDbPage]) => {
          if (real && onDbPage) {
            void refreshLiveDb();
            void refreshLivePlans();
          }
        },
        { immediate: true },
      ),
      watch(
        () => [
          isReal.value,
          state.page === "database",
          workspace.plans.items.map((item) => `${item.id}:${item.category}:${item.ref}`),
        ],
        ([real, onDbPage]) => {
          if (real && onDbPage) void refreshLivePlans();
        },
      ),
      watch(
        () => [
          isReal.value,
          state.page === "clientSync",
          platform.value?.sourceClient || "",
          platform.value?.targetClient || "",
          fileRules.value.join("\u001f"),
          workspace.rules.mirrorDeletes,
        ],
        ([real, onFilesPage]) => {
          if (real && onFilesPage) void refreshLiveFiles();
        },
        { immediate: true },
      ),
    );
  }

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
    state.brief.date = dateIso;
    invalidate(["db.plans"]);
    return true;
  }

  function setScope(scope, enabled) {
    if (!editable() || !RELEASE_SCOPES.includes(scope)) return false;
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
    appendHistory(state.events, entry);
  }

  function start() {
    if (!canStart.value) return false;
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

  /* ── Running tasks ── */
  const attempts = {};

  function contextFor(taskId) {
    return {
      taskId,
      runId: state.id,
      demoRun: !isReal.value,
      connectionId: resolvedConnection.value?.id || "",
      connections: plain(connectionList.value),
      databasesByConnection: plain(databaseMap.value),
      brief: plain(state.brief),
      platform: plain(platform.value),
      syncExclusions: [...syncExclusions.value],
      syncPlan: plain(syncPlan.value),
      plan: {
        counts: { ...planCounts.value },
        statements: [...planSql.value],
        writes: planWriteGroups(writtenGroups.value),
      },
      rules: [...fileRules.value],
      mirrorDeletes: Boolean(workspace.rules.mirrorDeletes),
      files: plain(fileSyncPlan.value),
      template: plain(selectedTemplate.value),
      diff: isReal.value ? [] : diffFiles,
      build: plain(buildOptions.value),
      cocos: { command: plain(cocosCommand.value) },
      backup: plain(backup.value),
      results: Object.fromEntries(RELEASE_TASKS.map((definition) => [definition.id, plain(state.tasks[definition.id].result)])),
      demo: { ...workspace.demo },
      attempt: attempts[taskId] || 1,
      now,
    };
  }

  function createIo(entry, taskId, signal) {
    const factor = RELEASE_SPEEDS[workspace.demo.speed] ?? 1;
    return {
      signal,
      log(line, tone = "") {
        appendTaskLog(entry, line, tone);
      },
      logs(entries) {
        appendTaskLogs(entry, entries);
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
    const previous = state.tasks[taskId];
    state.tasks[taskId] = fresh
      ? { ...idleTaskState(), status: TASK_STATUS.RUNNING, startedAt: now().getTime() }
      : { ...previous, status: TASK_STATUS.RUNNING, error: "" };
    const entry = state.tasks[taskId];
    progress.taskId = taskId;
    progress.fraction = 0;
    flush();
    const current = new AbortController();
    controller = current;
    try {
      if (isReal.value && taskId === "db.plans") {
        await refreshLivePlans({ forceTarget: true });
        if (current.signal.aborted) throw cancelledError();
      }
      const context = { ...contextFor(taskId), conflicts, previous: plain(previous.result) };
      const result = await driver.run(driverTaskId, context, createIo(entry, taskId, current.signal));
      if (current.signal.aborted) throw cancelledError();
      finish(entry, plain(result) || {});
      entry.finishedAt = now().getTime();
      record(taskId, entry.status);
      if (isReal.value) {
        if (["db.sync", "db.restore", "db.plans"].includes(taskId)) {
          void refreshLiveDb();
          await refreshLivePlans({ forceTarget: taskId !== "db.restore" });
        } else if (["client.svn", "client.sync", "client.transfer"].includes(taskId) && state.page === "clientSync") {
          void refreshLiveFiles();
        }
      }
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
          if (!isReal.value) workspace.demoFlags[platform.value.id] = {};
          return;
        }
        if (isReal.value) {
          entry.result = result;
        } else {
          const written = applyDemoDatabase(taskId);
          entry.result = taskId === "db.plans" ? { ...result, written } : result;
        }
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
    tickets.db += 1;
    tickets.plans += 1;
    tickets.files += 1;
    while (watchers.length) watchers.pop()();
    autopilot?.dispose();
    controller?.abort();
  }

  let autopilot = null;
  const api = {
    id: state.id,
    state,
    workspace,
    progress,
    isReal,
    resolvedConnection,
    liveSync,
    livePlans,
    liveFiles,
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
    noteFor,
    go,
    step,
    invalidate,
    setDate,
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
    refreshLiveState,
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
