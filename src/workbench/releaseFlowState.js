// Guided release flow of one platform's update: pages, tasks and their
// dependencies, kept apart from the UI. The brief (update date, update mode
// and scope) decides which tasks apply; a task can run once every applicable
// dependency is done or skipped. Rerunning or changing the input of a
// finished task resets the tasks that depend on it. Several updates (one per
// platform) live side by side in the release workspace
// (releaseWorkspaceState.js).

// The v2 single-flow draft; the v3 workspace migrates it into one update.
export const RELEASE_FLOW_STORAGE_KEY = "dbscout_release_flow_v2";
export const RELEASE_FLOW_SCHEMA = 2;
export const RELEASE_PHASES = Object.freeze(["database", "client", "build", "gm"]);
export const RELEASE_SCOPES = Object.freeze(["database", "client", "server", "activity"]);
export const RELEASE_MODES = Object.freeze(["maintenance", "hot"]);
export const TASK_STATUS = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  ATTENTION: "attention",
  DONE: "done",
  FAILED: "failed",
  SKIPPED: "skipped",
});

export const MAX_LOG_LINES = 160;
const MAX_HISTORY = 120;

function task(id, page, { scope = "", mode = "", deps = [], skippable = false, auto = false, action = false } = {}) {
  return Object.freeze({ id, page, scope, mode, deps: Object.freeze(deps), skippable, auto, action });
}

// Order is the order the guide offers them in. `scope` limits a task to
// releases that include that content; `mode` to maintenance or hot updates.
// An `auto` task is not started by a person: the shutdown runs when the
// scheduled maintenance time arrives. An `action` is offered beside the steps
// (restoring the database from the backup its overwrite made): it never
// counts toward progress and nothing depends on it.
export const RELEASE_TASKS = Object.freeze([
  task("db.sync", "database", { scope: "database" }),
  task("db.restore", "database", { scope: "database", action: true }),
  task("db.plans", "database", { scope: "database", deps: ["db.sync"] }),
  task("client.svn", "clientSvn", { scope: "client" }),
  task("client.sync", "clientSync", { scope: "client", deps: ["client.svn"] }),
  task("client.transfer", "clientTransfer", { scope: "client", deps: ["client.sync"], skippable: true }),
  task("client.diff", "clientDiff", { scope: "client", deps: ["client.transfer"] }),
  task("build.cocos", "build", { scope: "client", deps: ["client.diff"] }),
  task("gm.activityUpload", "gmUpload", { scope: "activity" }),
  task("gm.activityCurrent", "gmUpload", { scope: "activity", deps: ["gm.activityUpload"] }),
  task("gm.activityReload", "gmUpload", { scope: "activity", mode: "hot", deps: ["gm.activityCurrent"] }),
  task("gm.clientUpload", "gmUpload", { scope: "client", deps: ["build.cocos"] }),
  task("gm.serverUpload", "gmUpload", { scope: "server", mode: "maintenance" }),
  task("gm.serverCurrent", "gmUpload", { scope: "server", mode: "maintenance", deps: ["gm.serverUpload"] }),
  task("gm.maintenance", "gmServer", { mode: "maintenance" }),
  task("gm.clientOpen", "gmServer", { scope: "client", deps: ["gm.clientUpload"] }),
  task("gm.shutdown", "gmServer", { mode: "maintenance", deps: ["gm.maintenance"], auto: true }),
  task("gm.restart", "gmServer", {
    mode: "maintenance",
    deps: ["db.plans", "gm.activityCurrent", "gm.serverCurrent", "gm.shutdown"],
  }),
  task("gm.open", "gmServer", { mode: "maintenance", deps: ["gm.restart", "gm.clientOpen"] }),
]);

export const RELEASE_TASK_BY_ID = new Map(RELEASE_TASKS.map((entry) => [entry.id, entry]));

function page(id, phase) {
  const tasks = RELEASE_TASKS.filter((entry) => entry.page === id).map((entry) => entry.id);
  return Object.freeze({ id, phase, tasks: Object.freeze(tasks) });
}

export const RELEASE_PAGES = Object.freeze([
  page("brief", ""),
  page("database", "database"),
  page("clientSvn", "client"),
  page("clientSync", "client"),
  page("clientTransfer", "client"),
  page("clientDiff", "client"),
  page("build", "build"),
  page("gmUpload", "gm"),
  page("gmServer", "gm"),
  page("summary", ""),
]);

export const RELEASE_PAGE_BY_ID = new Map(RELEASE_PAGES.map((entry) => [entry.id, entry]));

function pad(value) {
  return String(value).padStart(2, "0");
}

export function localDateIso(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function defaultSchedule(dateIso) {
  return {
    maintenanceStart: `${dateIso}T10:00`,
    maintenanceEnd: `${dateIso}T12:00`,
    clientOpenAt: `${dateIso}T12:00`,
    clientOpenFollowsMaintenance: true,
  };
}

export function createReleaseBrief(dateIso = localDateIso()) {
  return {
    date: dateIso,
    mode: "maintenance",
    scope: { database: true, client: true, server: true, activity: true },
    prepared: false,
    started: false,
  };
}

export function idleTaskState() {
  return { status: TASK_STATUS.IDLE, startedAt: 0, finishedAt: 0, result: null, error: "", stale: false, logs: [] };
}

export function taskApplies(definition, brief) {
  if (!definition || !brief) return false;
  if (definition.mode && definition.mode !== brief.mode) return false;
  if (definition.scope && !brief.scope?.[definition.scope]) return false;
  return true;
}

/** The steps of this release: applicable tasks, without the side actions. */
export function applicableTasks(brief) {
  return RELEASE_TASKS.filter((definition) => !definition.action && taskApplies(definition, brief));
}

function stepApplies(id, brief) {
  const definition = RELEASE_TASK_BY_ID.get(id);
  return !definition?.action && taskApplies(definition, brief);
}

export function pageApplies(pageId, brief) {
  if (pageId === "brief" || pageId === "summary") return true;
  const entry = RELEASE_PAGE_BY_ID.get(pageId);
  return Boolean(entry?.tasks.some((id) => stepApplies(id, brief)));
}

export function phaseApplies(phase, brief) {
  return RELEASE_PAGES.some((entry) => entry.phase === phase && pageApplies(entry.id, brief));
}

function settled(status) {
  return status === TASK_STATUS.DONE || status === TASK_STATUS.SKIPPED;
}

export function statusOf(tasks, id) {
  return tasks?.[id]?.status || TASK_STATUS.IDLE;
}

/** Applicable dependencies that are not done or skipped yet. */
export function missingDependencies(id, tasks, brief) {
  const definition = RELEASE_TASK_BY_ID.get(id);
  if (!definition) return [];
  return definition.deps.filter((dependency) => {
    const dependencyDefinition = RELEASE_TASK_BY_ID.get(dependency);
    return taskApplies(dependencyDefinition, brief) && !settled(statusOf(tasks, dependency));
  });
}

export function runningTaskId(tasks) {
  return RELEASE_TASKS.find((definition) => statusOf(tasks, definition.id) === TASK_STATUS.RUNNING)?.id || "";
}

/** Why a task cannot run now: "" when it can. */
export function taskBlocker(id, tasks, brief) {
  const definition = RELEASE_TASK_BY_ID.get(id);
  if (!definition || !taskApplies(definition, brief)) return "notApplicable";
  if (!brief.started) return "notStarted";
  const running = runningTaskId(tasks);
  if (running) return running === id ? "running" : "busy";
  if (missingDependencies(id, tasks, brief).length) return "dependency";
  return "";
}

/** The tasks that depend on `id`, directly or through other tasks. */
export function dependentsOf(id) {
  const result = new Set();
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const definition of RELEASE_TASKS) {
      if (result.has(definition.id)) continue;
      if (definition.deps.some((dependency) => frontier.includes(dependency))) {
        result.add(definition.id);
        next.push(definition.id);
      }
    }
    frontier = next;
  }
  return [...result];
}

/**
 * Reset `roots` and everything depending on them. Returns the ids of tasks
 * that had a result; those are marked stale so their page can say why.
 */
export function invalidateTasks(tasks, roots, { includeRoots = true } = {}) {
  const ids = new Set(includeRoots ? roots : []);
  for (const root of roots) for (const id of dependentsOf(root)) ids.add(id);
  const reset = [];
  for (const id of RELEASE_TASKS.map((definition) => definition.id)) {
    if (!ids.has(id)) continue;
    const current = tasks[id];
    if (!current || current.status === TASK_STATUS.IDLE || current.status === TASK_STATUS.RUNNING) continue;
    tasks[id] = { ...idleTaskState(), stale: true };
    reset.push(id);
  }
  return reset;
}

/** Drop finished work whose applicable dependencies are no longer settled. */
export function normalizeTasks(tasks, brief) {
  const reset = [];
  for (const definition of RELEASE_TASKS) {
    const status = statusOf(tasks, definition.id);
    if (status === TASK_STATUS.IDLE || status === TASK_STATUS.RUNNING) continue;
    if (!taskApplies(definition, brief)) continue;
    if (missingDependencies(definition.id, tasks, brief).length) {
      tasks[definition.id] = { ...idleTaskState(), stale: true };
      reset.push(definition.id);
    }
  }
  return reset;
}

export function pageStatus(pageId, tasks, brief) {
  const entry = RELEASE_PAGE_BY_ID.get(pageId);
  if (!entry || !pageApplies(pageId, brief)) return "notApplicable";
  if (pageId === "brief") return brief.started ? "done" : "ready";
  if (pageId === "summary") return flowComplete(tasks, brief) ? "done" : "pending";
  const statuses = entry.tasks
    .filter((id) => stepApplies(id, brief))
    .map((id) => statusOf(tasks, id));
  if (statuses.includes(TASK_STATUS.RUNNING)) return "running";
  if (statuses.includes(TASK_STATUS.FAILED)) return "failed";
  if (statuses.includes(TASK_STATUS.ATTENTION)) return "attention";
  if (statuses.every(settled)) return statuses.every((status) => status === TASK_STATUS.SKIPPED) ? "skipped" : "done";
  return statuses.some(settled) ? "partial" : "pending";
}

/** The first applicable task on the page that still needs to run. */
export function nextTaskOnPage(pageId, tasks, brief) {
  const entry = RELEASE_PAGE_BY_ID.get(pageId);
  if (!entry) return "";
  return entry.tasks.find((id) => stepApplies(id, brief) && !settled(statusOf(tasks, id))) || "";
}

export function flowProgress(tasks, brief) {
  const applicable = applicableTasks(brief);
  const done = applicable.filter((definition) => settled(statusOf(tasks, definition.id))).length;
  return { done, total: applicable.length };
}

export function flowComplete(tasks, brief) {
  const { done, total } = flowProgress(tasks, brief);
  return total > 0 && done === total;
}

export function applicablePages(brief) {
  return RELEASE_PAGES.filter((entry) => pageApplies(entry.id, brief));
}

export function adjacentPage(pageId, brief, step) {
  const pages = applicablePages(brief);
  const index = pages.findIndex((entry) => entry.id === pageId);
  return pages[index + step]?.id || "";
}

export function appendTaskLog(state, line, tone = "") {
  state.logs.push({ text: String(line), tone });
  if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
}

export function appendHistory(history, entry) {
  history.push(entry);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

export function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function restoreTask(saved) {
  const base = idleTaskState();
  if (!plainObject(saved)) return base;
  const status = Object.values(TASK_STATUS).includes(saved.status) ? saved.status : TASK_STATUS.IDLE;
  return {
    ...base,
    // A run cannot survive a reload; offer it again instead of a fake success.
    status: status === TASK_STATUS.RUNNING ? TASK_STATUS.FAILED : status,
    error: status === TASK_STATUS.RUNNING ? "interrupted" : String(saved.error || ""),
    startedAt: Number(saved.startedAt) || 0,
    finishedAt: Number(saved.finishedAt) || 0,
    result: plainObject(saved.result),
    stale: saved.stale === true,
    logs: Array.isArray(saved.logs)
      ? saved.logs.slice(-MAX_LOG_LINES).filter((line) => line && typeof line.text === "string")
        .map((line) => ({ text: line.text, tone: String(line.tone || "") }))
      : [],
  };
}

export function restoreBrief(saved, fallback) {
  const brief = { ...fallback, scope: { ...fallback.scope } };
  if (!plainObject(saved)) return brief;
  if (/^\d{4}-\d{2}-\d{2}$/.test(saved.date || "")) brief.date = saved.date;
  if (RELEASE_MODES.includes(saved.mode)) brief.mode = saved.mode;
  for (const scope of RELEASE_SCOPES) {
    if (typeof saved.scope?.[scope] === "boolean") brief.scope[scope] = saved.scope[scope];
  }
  brief.prepared = saved.prepared === true;
  brief.started = saved.started === true;
  return brief;
}

/** Task states for every known task; unknown or malformed entries start idle. */
export function restoreTasks(saved, brief) {
  const tasks = {};
  for (const definition of RELEASE_TASKS) tasks[definition.id] = restoreTask(saved?.[definition.id]);
  // Only a consistent dependency chain survives; never an isolated success.
  normalizeTasks(tasks, brief);
  return tasks;
}
