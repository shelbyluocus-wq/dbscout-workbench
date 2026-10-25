// Release workspace: every platform's update side by side, the history of
// past updates and tool runs, the open-plan memo and the rules the updates
// share, kept apart from the UI. A platform has at most one update on its
// card: an open one, or the last finished one (read-only) until the next
// update of that platform is created. Each update follows releaseFlowState.js.
// The history is stored under its own key, so the frequent workspace writes
// during a run never re-serialize it.

import {
  RELEASE_FLOW_SCHEMA,
  RELEASE_FLOW_STORAGE_KEY,
  RELEASE_PAGES,
  RELEASE_TASKS,
  TASK_STATUS,
  applicableTasks,
  createReleaseBrief,
  defaultSchedule,
  flowComplete,
  flowProgress,
  localDateIso,
  plainObject,
  restoreBrief,
  restoreTasks,
} from "./releaseFlowState.js";
import { cleanExclusionRules } from "./utils/releaseFileRules.js";
import { isIsoDate } from "./utils/releasePlanNotes.js";
import { localInputTime } from "./utils/releaseServer.js";
import {
  DEMO_DEFAULT_PLATFORM,
  DEMO_FILE_EXCLUSIONS,
  DEMO_SYNC_EXCLUSIONS,
  PLAN_MEMO_CATEGORIES,
  createDemoPlanItems,
  createDemoPlatforms,
} from "./utils/releaseFlowDemo.js";

export const RELEASE_WORKSPACE_STORAGE_KEY = "dbscout_release_flow_v3";
export const RELEASE_HISTORY_STORAGE_KEY = "dbscout_release_history_v1";
export const RELEASE_WORKSPACE_SCHEMA = 3;
// "run" shows one update, "platform" a platform without an update on its card;
// the others are workspace pages any update can open and return from.
export const RELEASE_SECTIONS = Object.freeze(["home", "run", "platform", "history", "plans", "build", "svn", "platforms"]);
export const RELEASE_TOOL_SECTIONS = Object.freeze(["history", "plans", "build", "svn", "platforms"]);
export const RELEASE_SPEEDS = Object.freeze({ normal: 1, fast: 0.35 });
export const CONFLICT_CHOICES = Object.freeze(["theirs", "mine", "manual"]);
export const HISTORY_KINDS = Object.freeze(["release", "build", "svn"]);
export const HISTORY_OUTCOMES = Object.freeze(["done", "failed", "abandoned", "cancelled"]);
export const MAX_HISTORY_ENTRIES = 80;
// Entries keep their step logs while they are recent; older ones keep the
// steps and results only, so the history stays small.
const HISTORY_LOG_LINES = 40;
const RECENT_WITH_LOGS = 15;
const MAX_EVENTS = 120;

export const PLATFORM_TEXT_FIELDS = Object.freeze([
  "name", "sourceDatabase", "targetDatabase", "sourceClient", "targetClient", "transferTemplateId",
  "cocosVersion", "cocosPath", "buildPlatform", "buildConfig", "buildOutputName",
]);
export const PLATFORM_FLAG_FIELDS = Object.freeze(["buildDebug", "buildMd5Cache", "buildQaGuard"]);
export const PLAN_LIMITS = Object.freeze({ name: 60, ref: 40, note: 200 });

function text(value, limit) {
  return Array.from(String(value ?? "").trim()).slice(0, limit).join("");
}

function cleanTableNames(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter((value) => value && !seen.has(value) && seen.add(value));
}

export { cleanTableNames };

function shiftDate(value, fromIso, toIso) {
  return typeof value === "string" && value.startsWith(fromIso) ? `${toIso}${value.slice(fromIso.length)}` : value;
}

export { shiftDate };

/* ── Platforms ─────────────────────────────────────────────────────────── */

export function restorePlatforms(saved, fallback = createDemoPlatforms()) {
  if (!Array.isArray(saved)) return fallback;
  return fallback.map((platform) => {
    const stored = saved.find((entry) => entry?.id === platform.id);
    if (!stored) return platform;
    const next = { ...platform };
    for (const field of PLATFORM_TEXT_FIELDS) if (typeof stored[field] === "string") next[field] = stored[field];
    for (const field of PLATFORM_FLAG_FIELDS) if (typeof stored[field] === "boolean") next[field] = stored[field];
    return next;
  });
}

/** Build settings for a client folder that is no platform's, same fields as a platform. */
export function restoreBuildTarget(saved) {
  const target = {
    id: "custom",
    name: "",
    targetClient: "",
    cocosVersion: "",
    cocosPath: "",
    buildPlatform: "android",
    buildConfig: "",
    buildOutputName: "",
    buildDebug: false,
    buildMd5Cache: true,
    buildQaGuard: true,
  };
  for (const field of PLATFORM_TEXT_FIELDS) if (Object.hasOwn(target, field) && typeof saved?.[field] === "string") target[field] = saved[field];
  for (const field of PLATFORM_FLAG_FIELDS) if (typeof saved?.[field] === "boolean") target[field] = saved[field];
  return target;
}

/* ── Open-plan memo ────────────────────────────────────────────────────── */

/** A memo entry with known fields only, or null when it has no id or name. */
export function cleanPlanEntry(entry, platforms) {
  if (!plainObject(entry)) return null;
  const id = text(entry.id, 80);
  const name = text(entry.name, PLAN_LIMITS.name);
  if (!id || !name) return null;
  const notes = {};
  for (const platform of platforms) {
    const note = entry.notes?.[platform.id];
    notes[platform.id] = typeof note === "string" ? note.slice(0, PLAN_LIMITS.note) : "";
  }
  const cleaned = {
    id,
    category: PLAN_MEMO_CATEGORIES.includes(entry.category) ? entry.category : "other",
    name,
    ref: text(entry.ref, PLAN_LIMITS.ref),
    notes,
  };
  // The development value of a seeded entry, which the demo database starts from.
  if (entry.devFlag === 0 || entry.devFlag === 1) cleaned.devFlag = entry.devFlag;
  return cleaned;
}

export function restorePlans(saved, { platforms, today, translate }) {
  if (plainObject(saved) && Array.isArray(saved.items)) {
    const seen = new Set();
    const items = saved.items
      .map((entry) => cleanPlanEntry(entry, platforms))
      .filter((entry) => entry && !seen.has(entry.id) && seen.add(entry.id));
    return { items, seededOn: isIsoDate(saved.seededOn) ? saved.seededOn : today };
  }
  return { items: createDemoPlanItems(today, translate), seededOn: today };
}

/* ── Rules and demo database ───────────────────────────────────────────── */

function restorePerPlatform(saved, platforms, fallback, clean) {
  return Object.fromEntries(platforms.map((platform) => [
    platform.id,
    Array.isArray(saved?.[platform.id]) ? clean(saved[platform.id]) : [...fallback],
  ]));
}

export function restoreRules(saved, platforms) {
  return {
    syncExclusions: restorePerPlatform(saved?.syncExclusions, platforms, DEMO_SYNC_EXCLUSIONS, cleanTableNames),
    fileExclusions: restorePerPlatform(saved?.fileExclusions, platforms, DEMO_FILE_EXCLUSIONS, cleanExclusionRules),
    mirrorDeletes: saved?.mirrorDeletes !== false,
  };
}

// Open flags the demo platform databases hold after plan writes, per
// platform and memo entry. A real driver reads the database instead.
function restoreDemoFlags(saved, platforms, items) {
  const known = new Set(items.map((item) => item.id));
  return Object.fromEntries(platforms.map((platform) => [
    platform.id,
    Object.fromEntries(Object.entries(saved?.[platform.id] || {})
      .filter(([itemId, flag]) => known.has(itemId) && (flag === 0 || flag === 1))),
  ]));
}

function restoreDemo(saved) {
  const demo = plainObject(saved) || {};
  return {
    conflicts: demo.conflicts !== false,
    buildFailure: demo.buildFailure === true,
    missingFiles: demo.missingFiles === true,
    speed: Object.hasOwn(RELEASE_SPEEDS, demo.speed) ? demo.speed : "normal",
  };
}

/* ── Updates (runs) ────────────────────────────────────────────────────── */

let runSequence = 0;

export function createRunId(now = Date.now()) {
  runSequence = (runSequence + 1) % 1296;
  return `run-${now.toString(36)}-${runSequence.toString(36).padStart(2, "0")}`;
}

export function createRun({ id = createRunId(), platformId, today = localDateIso(), createdAt = Date.now() } = {}) {
  const brief = createReleaseBrief(today);
  return {
    id,
    platformId,
    createdAt,
    startedAt: 0,
    finishedAt: 0,
    // "" while open; "done" once every step is settled. Abandoned updates
    // leave the workspace for the history.
    outcome: "",
    brief,
    schedule: defaultSchedule(today),
    tasks: restoreTasks(null, brief),
    events: [],
    page: "brief",
    conflictChoices: {},
    // Memo entries left out of this update's plan write.
    planSkips: {},
    // What the simulated working copy of the diff step already committed or reverted.
    svnDemo: { committed: [], reverted: [], revision: 0, commits: [] },
    // Demo fast-forward of this update's GM clock, added to the real time.
    clockOffset: 0,
    demo: true,
  };
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

const TASK_IDS = new Set(RELEASE_TASKS.map((definition) => definition.id));

function restoreEvents(saved) {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((entry) => Number(entry?.at) && (TASK_IDS.has(entry.taskId) || (!entry.taskId && entry.event === "started")))
    .slice(-MAX_EVENTS);
}

export function restoreRun(saved, { platforms, today }) {
  if (!plainObject(saved) || typeof saved.id !== "string" || !saved.id) return null;
  if (!platforms.some((platform) => platform.id === saved.platformId)) return null;
  const fallback = createRun({ id: saved.id, platformId: saved.platformId, today, createdAt: Number(saved.createdAt) || Date.now() });
  const brief = restoreBrief(saved.brief, fallback.brief);
  const schedule = restoreSchedule(saved.schedule, defaultSchedule(brief.date));
  // An unstarted draft follows the calendar; a started update keeps its day.
  if (!brief.started && brief.date < today) {
    for (const key of ["maintenanceStart", "maintenanceEnd", "clientOpenAt"]) schedule[key] = shiftDate(schedule[key], brief.date, today);
    brief.date = today;
  }
  const choices = {};
  for (const [path, choice] of Object.entries(saved.conflictChoices || {})) {
    if (CONFLICT_CHOICES.includes(choice)) choices[path] = choice;
  }
  const skips = {};
  for (const [itemId, skipped] of Object.entries(saved.planSkips || {})) if (skipped === true) skips[itemId] = true;
  const tasks = restoreTasks(saved.tasks, brief);
  const done = saved.outcome === "done" && flowComplete(tasks, brief);
  return {
    ...fallback,
    startedAt: Number(saved.startedAt) || 0,
    finishedAt: done ? Number(saved.finishedAt) || 0 : 0,
    outcome: done ? "done" : "",
    brief,
    schedule,
    tasks,
    events: restoreEvents(saved.events),
    page: RELEASE_PAGES.some((entry) => entry.id === saved.page) ? saved.page : "brief",
    conflictChoices: choices,
    planSkips: skips,
    svnDemo: {
      committed: Array.isArray(saved.svnDemo?.committed) ? saved.svnDemo.committed.filter((path) => typeof path === "string") : [],
      reverted: Array.isArray(saved.svnDemo?.reverted) ? saved.svnDemo.reverted.filter((path) => typeof path === "string") : [],
      revision: Number(saved.svnDemo?.revision) || 0,
      commits: Array.isArray(saved.svnDemo?.commits)
        ? saved.svnDemo.commits.filter((commit) => Number(commit?.revision) && Array.isArray(commit.paths)).slice(0, 20)
        : [],
    },
    clockOffset: Number.isFinite(saved.clockOffset) ? saved.clockOffset : 0,
    demo: saved.demo !== false,
  };
}

/** One update per platform: the most recently created one wins. */
function onePerPlatform(runs) {
  const latest = new Map();
  for (const run of runs) {
    const current = latest.get(run.platformId);
    if (!current || run.createdAt >= current.createdAt) latest.set(run.platformId, run);
  }
  return runs.filter((run) => latest.get(run.platformId) === run);
}

function restoreView(saved, runs, platforms) {
  const known = (target) => target && RELEASE_SECTIONS.includes(target.section)
    && (target.section !== "run" || runs.some((run) => run.id === target.runId))
    && (target.section !== "platform" || platforms.some((platform) => platform.id === target.platformId));
  const view = { section: "home", runId: "", platformId: "", returnTo: null };
  if (!known(saved)) return view;
  view.section = saved.section;
  if (saved.section === "run") view.runId = saved.runId;
  if (saved.section === "platform") view.platformId = saved.platformId;
  const back = plainObject(saved.returnTo);
  if (RELEASE_TOOL_SECTIONS.includes(view.section) && known(back) && !RELEASE_TOOL_SECTIONS.includes(back.section)) {
    view.returnTo = { section: back.section, runId: back.section === "run" ? back.runId : "", platformId: back.section === "platform" ? back.platformId : "" };
  }
  return view;
}

/* ── Workspace ─────────────────────────────────────────────────────────── */

/**
 * A fresh, restored or migrated workspace. `stored` is a saved v3 workspace,
 * `legacy` a v2 single-flow draft (migrated into one update); `seedRuns`
 * builds the demo's scheduled updates for a first open.
 */
export function createWorkspaceData({ stored = null, legacy = null, today = localDateIso(), translate, seedRuns = null } = {}) {
  const base = stored || (legacy ? migrateLegacyFlow(legacy, { today, translate }) : null);
  const platforms = restorePlatforms(base?.platforms);
  const plans = restorePlans(base?.plans, { platforms, today, translate });
  const savedRuns = Array.isArray(base?.runs) ? base.runs : (base ? [] : seedRuns?.({ today, platforms }) || []);
  const runs = onePerPlatform(savedRuns.map((run) => restoreRun(run, { platforms, today })).filter(Boolean));
  return {
    platforms,
    plans,
    rules: restoreRules(base?.rules, platforms),
    demoFlags: restoreDemoFlags(base?.demoFlags, platforms, plans.items),
    runs,
    view: restoreView(base?.view, runs, platforms),
    svn: { path: typeof base?.svn?.path === "string" ? base.svn.path : "" },
    build: {
      // The build page's target: a platform, or "custom" for another client folder.
      targetId: base?.build?.targetId === "custom" || platforms.some((platform) => platform.id === base?.build?.targetId)
        ? base.build.targetId
        : platforms[0]?.id || "custom",
      custom: restoreBuildTarget(base?.build?.custom),
    },
    demo: restoreDemo(base?.demo),
  };
}

/** The v2 draft as v3 data: its notes seed the memo, a started flow becomes an update. */
export function migrateLegacyFlow(legacy, { today, translate }) {
  if (!plainObject(legacy)) return null;
  const platforms = restorePlatforms(legacy.platforms);
  const seededOn = isIsoDate(legacy.notesSeededOn) ? legacy.notesSeededOn : today;
  const items = createDemoPlanItems(seededOn, translate).map((item) => {
    const notes = { ...item.notes };
    for (const platform of platforms) {
      const note = legacy.notes?.[item.id]?.[platform.id];
      if (typeof note === "string") notes[platform.id] = note;
    }
    return { ...item, notes };
  });
  const tasks = plainObject(legacy.tasks) || {};
  const worked = Object.values(tasks).some((task) => task?.status && task.status !== TASK_STATUS.IDLE);
  const runs = [];
  if (legacy.brief?.started === true || worked) {
    const platformId = platforms.some((platform) => platform.id === legacy.brief?.platformId) ? legacy.brief.platformId : DEMO_DEFAULT_PLATFORM;
    const events = Array.isArray(legacy.history) ? legacy.history : [];
    const startedAt = events.find((entry) => entry?.event === "started")?.at || 0;
    runs.push({
      id: "run-migrated",
      platformId,
      createdAt: Number(events[0]?.at) || Date.now(),
      startedAt,
      brief: legacy.brief,
      schedule: legacy.schedule,
      tasks,
      events,
      page: legacy.page === "overview" ? "brief" : legacy.page,
      conflictChoices: legacy.conflictChoices,
      clockOffset: legacy.demo?.clockOffset,
      demo: true,
    });
  }
  return {
    platforms,
    plans: { items, seededOn },
    rules: { syncExclusions: legacy.syncExclusions, fileExclusions: legacy.fileExclusions, mirrorDeletes: legacy.mirrorDeletes },
    demoFlags: legacy.demoFlags,
    runs,
    view: runs.length ? { section: "run", runId: runs[0].id } : { section: "home" },
    demo: legacy.demo,
  };
}

function readJson(storage, key) {
  try {
    return JSON.parse(storage?.getItem?.(key) || "null");
  } catch {
    return null;
  }
}

export function readStoredWorkspace(storage) {
  const parsed = readJson(storage, RELEASE_WORKSPACE_STORAGE_KEY);
  return plainObject(parsed) && parsed.schema === RELEASE_WORKSPACE_SCHEMA ? parsed : null;
}

export function readLegacyFlow(storage) {
  const parsed = readJson(storage, RELEASE_FLOW_STORAGE_KEY);
  return plainObject(parsed) && parsed.schema === RELEASE_FLOW_SCHEMA ? parsed : null;
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function writeStoredWorkspace(storage, snapshot) {
  return writeJson(storage, RELEASE_WORKSPACE_STORAGE_KEY, { ...snapshot, schema: RELEASE_WORKSPACE_SCHEMA });
}

/* ── Status of an update, as its platform card shows it ────────────────── */

/** When the update is planned: the maintenance start, else the hot update's opening. */
export function plannedTime(run) {
  if (!run) return 0;
  const key = run.brief.mode === "maintenance" ? "maintenanceStart" : "clientOpenAt";
  const time = localInputTime(run.schedule?.[key]);
  return Number.isFinite(time) ? time : 0;
}

/**
 * What needs a person's attention, most severe first: failed steps, SVN
 * conflicts waiting for a choice, files a sync could not find, steps to run
 * again after an input changed, and a planned time that passed unstarted.
 */
export function runIssues(run, { now = Date.now() } = {}) {
  if (!run || run.outcome === "done") return [];
  const issues = [];
  for (const definition of RELEASE_TASKS) {
    const task = run.tasks[definition.id];
    if (task?.status === TASK_STATUS.FAILED) issues.push({ kind: "failed", tone: "danger", taskId: definition.id, error: task.error });
  }
  const svn = run.tasks["client.svn"];
  if (svn?.status === TASK_STATUS.ATTENTION) {
    issues.push({ kind: "conflicts", tone: "warning", taskId: "client.svn", count: svn.result?.conflicts?.length || 0 });
  }
  for (const definition of RELEASE_TASKS) {
    const warnings = run.tasks[definition.id]?.result?.warnings;
    if (Array.isArray(warnings) && warnings.length) {
      issues.push({ kind: "missing", tone: "warning", taskId: definition.id, count: warnings.length });
    }
  }
  const stale = applicableTasks(run.brief).filter((definition) => run.tasks[definition.id]?.stale
    && run.tasks[definition.id].status === TASK_STATUS.IDLE);
  if (run.brief.started && stale.length) issues.push({ kind: "stale", tone: "warning", taskId: stale[0].id, count: stale.length });
  const planned = plannedTime(run);
  if (!run.brief.started && planned && planned < now) issues.push({ kind: "overdue", tone: "warning", taskId: "" });
  return issues;
}

/** "pending" (not started), "active", "attention" or "done". */
export function runStatus(run, { now = Date.now() } = {}) {
  if (!run) return "idle";
  if (run.outcome === "done") return "done";
  if (!run.brief.started) return runIssues(run, { now }).length ? "attention" : "pending";
  return runIssues(run, { now }).length ? "attention" : "active";
}

export function lastFinishedRelease(history, platformId) {
  let latest = null;
  for (const entry of history) {
    if (entry.kind !== "release" || entry.platformId !== platformId || entry.outcome !== "done") continue;
    if (!latest || entry.finishedAt > latest.finishedAt) latest = entry;
  }
  return latest;
}

/** Everything a platform card shows. */
export function platformCard(platform, { run = null, history = [], now = Date.now() } = {}) {
  const last = lastFinishedRelease(history, platform.id);
  const status = run ? runStatus(run, { now }) : last ? "done" : "idle";
  return {
    platformId: platform.id,
    name: platform.name,
    runId: run?.id || "",
    status,
    progress: run ? flowProgress(run.tasks, run.brief) : { done: 0, total: 0 },
    lastUpdate: run?.outcome === "done" ? run.finishedAt : last?.finishedAt || 0,
    plannedAt: run && run.outcome !== "done" ? plannedTime(run) : 0,
    mode: run?.brief.mode || "",
    issues: runIssues(run, { now }),
  };
}

/* ── History ───────────────────────────────────────────────────────────── */

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stepLogs(task) {
  return (task.logs || []).slice(-HISTORY_LOG_LINES).map((line) => ({ text: line.text, tone: line.tone || "" }));
}

/** The record an update leaves in the history when it finishes or is abandoned. */
export function historyEntryFromRun(run, { platform, outcome, at = Date.now() }) {
  const ran = RELEASE_TASKS.filter((definition) => {
    const status = run.tasks[definition.id]?.status;
    return status && status !== TASK_STATUS.IDLE;
  });
  const listed = new Set([...applicableTasks(run.brief), ...ran]);
  const steps = RELEASE_TASKS.filter((definition) => listed.has(definition)).map((definition) => {
    const task = run.tasks[definition.id];
    return {
      taskId: definition.id,
      status: task.status === TASK_STATUS.RUNNING ? TASK_STATUS.FAILED : task.status,
      startedAt: task.startedAt || 0,
      finishedAt: task.finishedAt || 0,
      result: plain(task.result),
      error: task.error || "",
      logs: stepLogs(task),
    };
  });
  const warnings = steps.reduce((sum, step) => sum + (Array.isArray(step.result?.warnings) ? step.result.warnings.length : 0), 0);
  const progress = flowProgress(run.tasks, run.brief);
  return {
    id: `history-${run.id}`,
    kind: "release",
    runId: run.id,
    platformId: run.platformId,
    platformName: platform?.name || run.platformId,
    demo: run.demo !== false,
    outcome,
    createdAt: run.createdAt,
    startedAt: run.startedAt || run.createdAt,
    finishedAt: at,
    brief: { date: run.brief.date, mode: run.brief.mode, scope: { ...run.brief.scope } },
    schedule: plain(run.schedule),
    steps,
    events: plain(run.events.slice(-MAX_EVENTS)),
    stats: {
      done: progress.done,
      total: progress.total,
      failed: steps.filter((step) => step.status === TASK_STATUS.FAILED).length,
      warnings,
    },
  };
}

/**
 * A tool run (a client build or an SVN operation) for the history. `details`
 * holds what the tool did, `logs` its last output lines.
 */
export function toolHistoryEntry({ kind, platformId = "", platformName = "", demo = false, outcome, startedAt, finishedAt, title = "", details = {}, logs = [] }) {
  const time = Number(finishedAt) || Date.now();
  return {
    id: `history-${kind}-${time.toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`,
    kind,
    platformId,
    platformName,
    demo: Boolean(demo),
    outcome,
    createdAt: Number(startedAt) || time,
    startedAt: Number(startedAt) || time,
    finishedAt: time,
    title: String(title || ""),
    details: plain(details) || {},
    steps: [],
    events: [],
    logs: logs.slice(-HISTORY_LOG_LINES).map((line) => (typeof line === "string" ? { text: line, tone: "" } : { text: String(line.text), tone: line.tone || "" })),
    stats: { done: 0, total: 0, failed: outcome === "failed" ? 1 : 0, warnings: Number(details?.warnings) || 0 },
  };
}

function cleanLogs(lines) {
  return Array.isArray(lines)
    ? lines.filter((line) => line && typeof line.text === "string").map((line) => ({ text: line.text, tone: String(line.tone || "") }))
    : [];
}

function restoreHistoryEntry(entry) {
  if (!plainObject(entry) || typeof entry.id !== "string" || !HISTORY_KINDS.includes(entry.kind)) return null;
  if (!HISTORY_OUTCOMES.includes(entry.outcome) || !Number(entry.finishedAt)) return null;
  return {
    ...entry,
    demo: entry.demo !== false,
    createdAt: Number(entry.createdAt) || Number(entry.finishedAt),
    startedAt: Number(entry.startedAt) || Number(entry.finishedAt),
    finishedAt: Number(entry.finishedAt),
    steps: Array.isArray(entry.steps)
      ? entry.steps.filter((step) => TASK_IDS.has(step?.taskId)).map((step) => ({ ...step, logs: cleanLogs(step.logs) }))
      : [],
    events: Array.isArray(entry.events) ? entry.events.filter((event) => Number(event?.at)) : [],
    logs: cleanLogs(entry.logs),
    stats: plainObject(entry.stats) || { done: 0, total: 0, failed: 0, warnings: 0 },
  };
}

/** Newest first, at most MAX_HISTORY_ENTRIES, logs only on recent entries. */
export function compactHistory(entries) {
  const sorted = [...entries].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, MAX_HISTORY_ENTRIES);
  return sorted.map((entry, index) => {
    if (index < RECENT_WITH_LOGS) return entry;
    return { ...entry, logs: [], steps: entry.steps.map((step) => (step.logs?.length ? { ...step, logs: [] } : step)) };
  });
}

export function readStoredHistory(storage) {
  const parsed = readJson(storage, RELEASE_HISTORY_STORAGE_KEY);
  if (!plainObject(parsed) || !Array.isArray(parsed.entries)) return null;
  return compactHistory(parsed.entries.map(restoreHistoryEntry).filter(Boolean));
}

export function writeStoredHistory(storage, entries) {
  return writeJson(storage, RELEASE_HISTORY_STORAGE_KEY, { schema: 1, entries });
}
