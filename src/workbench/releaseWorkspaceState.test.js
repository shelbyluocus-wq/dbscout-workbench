import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASE_FLOW_STORAGE_KEY, RELEASE_TASKS, TASK_STATUS, idleTaskState } from "./releaseFlowState.js";
import {
  MAX_HISTORY_ENTRIES,
  RELEASE_HISTORY_STORAGE_KEY,
  cleanPlanEntry,
  compactHistory,
  createRun,
  createWorkspaceData,
  historyEntryFromRun,
  migrateLegacyFlow,
  platformCard,
  readStoredHistory,
  restorePlans,
  restoreRun,
  runIssues,
  runStatus,
  toolHistoryEntry,
  writeStoredWorkspace,
} from "./releaseWorkspaceState.js";
import { createDemoPlatforms, planEntryKey } from "./utils/releaseFlowDemo.js";

const PLATFORMS = createDemoPlatforms();
const TODAY = "2026-10-24";
const translate = (key, values = {}) => `${key}${JSON.stringify(values)}`;

function startedRun(patch = {}) {
  const run = createRun({ id: "run-a", platformId: "tw", today: TODAY, createdAt: 1 });
  run.brief.prepared = true;
  run.brief.started = true;
  run.startedAt = 2;
  return Object.assign(run, patch);
}

function setTask(run, id, status, extra = {}) {
  run.tasks[id] = { ...idleTaskState(), status, ...extra };
}

test("memo entries keep known fields only and every platform's note", () => {
  const entry = cleanPlanEntry({ id: "plan-1", name: "  红龙女王  ", category: "dragon", ref: 1061, notes: { tw: "10/28 開放", sea: "x" }, devFlag: 3, extra: true }, PLATFORMS);
  assert.deepEqual(entry, {
    id: "plan-1",
    category: "other",
    name: "红龙女王",
    ref: "1061",
    notes: { douyin: "", tap: "", wanxin: "", tw: "10/28 開放" },
  });
  assert.equal(cleanPlanEntry({ id: "plan-2", name: "" }, PLATFORMS), null);
  assert.equal(cleanPlanEntry({ name: "x" }, PLATFORMS), null);
  assert.equal(cleanPlanEntry({ id: "plan-3", name: "x".repeat(80), notes: {} }, PLATFORMS).name.length, 60);
});

test("the memo is seeded once from the demo items and then only restored", () => {
  const seeded = restorePlans(null, { platforms: PLATFORMS, today: TODAY, translate });
  assert.equal(seeded.items.length, 35);
  assert.equal(seeded.seededOn, TODAY);
  assert.equal(seeded.items[0].devFlag, 1);
  const restored = restorePlans({ items: [seeded.items[0], seeded.items[0], { id: "broken" }], seededOn: "2026-10-01" }, { platforms: PLATFORMS, today: TODAY, translate });
  assert.equal(restored.items.length, 1, "duplicates and broken entries are dropped");
  assert.equal(restored.seededOn, "2026-10-01");
  assert.deepEqual(restorePlans({ items: [] }, { platforms: PLATFORMS, today: TODAY, translate }).items, [], "an emptied memo stays empty");
});

test("only entries naming a table row can be written", () => {
  assert.equal(planEntryKey({ category: "hero", ref: "1061" }), 1061);
  assert.deepEqual(planEntryKey({ category: "feature", ref: "117 · 100" }), { BuildID: 117, Idx: 100 });
  assert.equal(planEntryKey({ category: "feature", ref: "117" }), null);
  assert.equal(planEntryKey({ category: "hero", ref: "" }), null);
  assert.equal(planEntryKey({ category: "other", ref: "5" }), null);
});

test("a saved update is restored for a known platform with a consistent outcome", () => {
  assert.equal(restoreRun({ id: "x", platformId: "sea" }, { platforms: PLATFORMS, today: TODAY }), null);
  assert.equal(restoreRun({ platformId: "tw" }, { platforms: PLATFORMS, today: TODAY }), null);
  const run = restoreRun({
    id: "run-b",
    platformId: "tw",
    outcome: "done",
    brief: { date: "2026-10-20", started: true },
    planSkips: { "hero-1061": true, "hero-1062": "yes" },
    svnDemo: { committed: ["a.ts", 3], revision: 2 },
    clockOffset: 60000,
    page: "nowhere",
  }, { platforms: PLATFORMS, today: TODAY });
  assert.equal(run.outcome, "", "an update is only done when its steps are");
  assert.deepEqual(run.planSkips, { "hero-1061": true });
  assert.deepEqual(run.svnDemo.committed, ["a.ts"]);
  assert.deepEqual([run.clockOffset, run.page, run.brief.date], [undefined, "brief", "2026-10-20"]);
});

test("one update per platform, and the view falls back to the overview", () => {
  const data = createWorkspaceData({
    stored: {
      runs: [
        { id: "old", platformId: "tw", createdAt: 1 },
        { id: "new", platformId: "tw", createdAt: 2 },
        { id: "tap", platformId: "tap", createdAt: 1 },
      ],
      view: { section: "run", runId: "old" },
    },
    today: TODAY,
    translate,
  });
  assert.deepEqual(data.runs.map((run) => run.id), ["new", "tap"]);
  assert.deepEqual(data.view, { section: "home", runId: "", platformId: "", returnTo: null });
  const tool = createWorkspaceData({
    stored: { runs: [{ id: "tap", platformId: "tap" }], view: { section: "plans", returnTo: { section: "run", runId: "tap" } } },
    today: TODAY,
    translate,
  });
  assert.deepEqual(tool.view, { section: "plans", runId: "", platformId: "", returnTo: { section: "run", runId: "tap", platformId: "" } });
  assert.equal(tool.build.targetId, "douyin");
  assert.equal(tool.build.custom.buildPlatform, "android");
});

test("issues are listed worst first and decide the card's state", () => {
  const run = startedRun();
  assert.deepEqual(runIssues(run), []);
  assert.equal(runStatus(run), "active");
  setTask(run, "client.svn", TASK_STATUS.ATTENTION, { result: { conflicts: ["a", "b"] } });
  setTask(run, "build.cocos", TASK_STATUS.FAILED, { error: "buildFailed" });
  setTask(run, "client.sync", TASK_STATUS.DONE, { result: { warnings: [{ code: "missing", path: "x" }] } });
  setTask(run, "db.plans", TASK_STATUS.IDLE, { stale: true });
  assert.deepEqual(runIssues(run).map((issue) => issue.kind), ["failed", "conflicts", "missing", "stale"]);
  assert.equal(runStatus(run), "attention");

  const draft = createRun({ id: "d", platformId: "tap", today: TODAY });
  assert.equal(runStatus(draft, { now: new Date(2026, 9, 24, 9, 0).getTime() }), "pending");
  assert.deepEqual(runIssues(draft, { now: new Date(2026, 9, 24, 23, 59).getTime() }), []);
  assert.deepEqual(runIssues(draft, { now: new Date(2026, 9, 25, 0, 1).getTime() }).map((issue) => issue.kind), ["overdue"]);

  const history = [
    { kind: "release", platformId: "tw", outcome: "done", finishedAt: 10 },
    { kind: "release", platformId: "tw", outcome: "abandoned", finishedAt: 30 },
    { kind: "build", platformId: "tw", outcome: "done", finishedAt: 40 },
  ];
  const tw = PLATFORMS.find((platform) => platform.id === "tw");
  assert.deepEqual(
    (({ status, lastUpdate, runId }) => ({ status, lastUpdate, runId }))(platformCard(tw, { history })),
    { status: "done", lastUpdate: 10, runId: "" },
    "only a finished update counts as the last update",
  );
  assert.equal(platformCard(PLATFORMS[0], { history }).status, "idle");
});

test("a history entry keeps every step with its result, error, warnings and last log lines", () => {
  const run = startedRun();
  for (const definition of RELEASE_TASKS) setTask(run, definition.id, TASK_STATUS.DONE, { result: { ok: definition.id } });
  setTask(run, "db.restore", TASK_STATUS.IDLE);
  setTask(run, "client.sync", TASK_STATUS.DONE, {
    result: { warnings: [{ code: "missing", path: "a" }, { code: "missing", path: "b" }] },
    logs: Array.from({ length: 60 }, (_, index) => ({ text: `line ${index}`, tone: "" })),
  });
  setTask(run, "build.cocos", TASK_STATUS.RUNNING);
  const entry = historyEntryFromRun(run, { platform: { name: "TW" }, outcome: "abandoned", at: 99 });
  assert.equal(entry.steps.some((step) => step.taskId === "db.restore"), false, "an action that never ran is not listed");
  assert.equal(entry.steps.find((step) => step.taskId === "build.cocos").status, "failed", "a step cut off is not shown as running");
  const sync = entry.steps.find((step) => step.taskId === "client.sync");
  assert.deepEqual([sync.logs.length, sync.logs[0].text], [40, "line 20"]);
  assert.deepEqual(entry.stats, { done: 6, total: 7, failed: 1, warnings: 2 });
  assert.deepEqual([entry.kind, entry.outcome, entry.platformName, entry.finishedAt], ["release", "abandoned", "TW", 99]);
});

test("the history keeps the newest entries and the logs of recent ones only", () => {
  const entries = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, index) => toolHistoryEntry({
    kind: "build",
    outcome: "done",
    startedAt: index,
    finishedAt: index + 1,
    details: {},
    logs: ["Build success"],
  }));
  const kept = compactHistory(entries);
  assert.equal(kept.length, MAX_HISTORY_ENTRIES);
  assert.equal(kept[0].finishedAt, MAX_HISTORY_ENTRIES + 5);
  assert.equal(kept[0].logs.length, 1);
  assert.equal(kept.at(-1).logs.length, 0);
});

test("a v2 draft that never started migrates without an update", () => {
  const migrated = migrateLegacyFlow({ schema: 2, brief: { platformId: "tw", started: false }, tasks: {} }, { today: TODAY, translate });
  assert.deepEqual(migrated.runs, []);
  assert.deepEqual(migrated.view, { section: "home" });
  assert.equal(migrated.plans.items.length, 35);
});

test("saved histories drop GM entries and steps while keeping non-GM evidence", () => {
  const record = historyEntryFromRun(startedRun(), { platform: { name: "TW" }, outcome: "abandoned", at: 99 });
  record.steps[0] = { taskId: "db.sync", status: "done", result: { backup: { id: "kept" } }, logs: [{ text: "backup done" }] };
  record.steps.push({ taskId: "gm.open", status: "failed", logs: [{ text: "old service log" }] });
  record.events = [{ at: 10, taskId: "db.sync", event: "done" }, { at: 20, taskId: "gm.open", event: "failed", serverAt: 21 }];
  record.brief.mode = "maintenance";
  record.brief.scope.server = true;
  record.schedule = { maintenanceStart: "2026-10-24T10:00" };
  record.stats = { done: 20, total: 22, failed: 1, warnings: 0 };
  const raw = JSON.stringify({ entries: [record, { ...record, id: "local", kind: "gm" }] });
  const history = readStoredHistory({ getItem: (key) => key === RELEASE_HISTORY_STORAGE_KEY ? raw : null });
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].stats, { done: 1, total: 7, failed: 0, warnings: 0 });
  assert.equal(history[0].steps[0].result.backup.id, "kept");
  assert.deepEqual(history[0].steps[0].logs, [{ text: "backup done", tone: "" }]);
  assert.doesNotMatch(JSON.stringify(history), /gm\.|maintenance|schedule|serverAt|old service log/);
  record.brief.scope.client = false;
  record.steps.push({ taskId: "client.sync", status: "done" });
  const databaseOnly = readStoredHistory({ getItem: () => JSON.stringify({ entries: [record] }) });
  assert.deepEqual(databaseOnly[0].stats, { done: 1, total: 2, failed: 0, warnings: 0 });
});

test("legacy storage is removed only after the retained workspace is saved", () => {
  const removed = [];
  assert.equal(writeStoredWorkspace({ setItem() { throw new Error("full"); }, removeItem: (key) => removed.push(key) }, {}), false);
  assert.deepEqual(removed, []);
  assert.equal(writeStoredWorkspace({ setItem() {}, removeItem: (key) => removed.push(key) }, {}), true);
  assert.deepEqual(removed, [RELEASE_FLOW_STORAGE_KEY]);
});
