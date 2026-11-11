import assert from "node:assert/strict";
import { test } from "node:test";
import { composeDrivers } from "./composables/useCocosBuild.js";
import { createReleaseRealDriver } from "./composables/useReleaseRealDriver.js";
import { useReleaseWorkspace } from "./composables/useReleaseWorkspace.js";
import { RELEASE_FLOW_SCHEMA, RELEASE_FLOW_STORAGE_KEY } from "./releaseFlowState.js";
import { RELEASE_HISTORY_STORAGE_KEY, RELEASE_WORKSPACE_SCHEMA, RELEASE_WORKSPACE_STORAGE_KEY } from "./releaseWorkspaceState.js";
import { createReleaseDemoDriver } from "./utils/releaseFlowDemoDriver.js";

const START = new Date(2026, 9, 24, 9, 30);
const TEMPLATES = [{ id: "juesheng-2", name: "决胜2", scriptPath: "D:\\tools\\gen.bat", projectRoot: "D:\\jswz\\release\\tw\\jswz" }];

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  };
}

function cancelled() {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

const immediate = (ms, signal) => (signal?.aborted ? Promise.reject(cancelled()) : Promise.resolve());

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

// The real time, moved by hand instead of once a second.
function manualClock(start = START) {
  let time = start.getTime();
  const ticks = new Set();
  return {
    now: () => new Date(time),
    ticker(callback) {
      ticks.add(callback);
      return () => ticks.delete(callback);
    },
    async advance(ms) {
      time += ms;
      for (const callback of ticks) callback();
      await settle();
    },
  };
}

function createWorkspace(t, { clock = manualClock(), seed = false, ...options } = {}) {
  const workspace = useReleaseWorkspace({
    storage: memoryStorage(),
    sleep: immediate,
    now: clock.now,
    ticker: clock.ticker,
    templates: () => TEMPLATES,
    seed,
    ...options,
  });
  t.after(() => workspace.dispose());
  return workspace;
}

function newUpdate(workspace, platformId = "tw") {
  const { status, runId } = workspace.createUpdate(platformId);
  assert.equal(status, "created");
  return workspace.flowFor(runId);
}

async function runAll(flow, ids) {
  for (const id of ids) assert.equal(await flow.runTask(id), true, id);
}

const DATABASE_ONLY = { database: true, client: false };
const CLIENT_ONLY = { database: false, client: true };
const CLIENT_TASKS = ["client.sync", "client.transfer", "client.diff", "build.cocos"];

function startWith(flow, scope) {
  for (const [name, enabled] of Object.entries(scope)) flow.setScope(name, enabled);
  flow.setPrepared(true);
  flow.start();
}

async function finishDatabaseUpdate(flow) {
  startWith(flow, DATABASE_ONLY);
  await runAll(flow, ["db.sync", "db.plans"]);
}

test("an update ends after the client build and lands in the history", async (t) => {
  const storage = memoryStorage();
  const clock = manualClock();
  const workspace = createWorkspace(t, { storage, clock });
  const flow = newUpdate(workspace);
  assert.deepEqual([workspace.view.section, workspace.view.runId], ["run", flow.id]);
  assert.equal(flow.platform.value.id, "tw");
  assert.equal(flow.state.brief.date, "2026-10-24");
  assert.equal(flow.canStart.value, false);
  assert.equal(await flow.runTask("db.sync"), false, "nothing runs before the update starts");

  flow.setPrepared(true);
  assert.equal(flow.start(), true);
  assert.equal(flow.state.page, "database");
  assert.equal(await flow.runTask("db.plans"), false, "the plan waits for the overwrite");

  await runAll(flow, ["db.sync"]);
  const sync = flow.state.tasks["db.sync"].result;
  assert.deepEqual([sync.tables, sync.excluded, sync.rows], [334, 2, 140193]);
  assert.equal(sync.backup.database, "newsg_tw_cfg");
  // Development opens everything, so TW's plan closes what is not due yet.
  assert.deepEqual({ ...flow.planCounts.value }, { open: 0, close: 9, keep: 25, skip: 1 });
  assert.deepEqual(flow.planSql.value, [
    "UPDATE `heroprop` SET `OpenFlag` = 0 WHERE `ID` IN (1062, 1063, 6517, 5511, 5517, 5417, 5418);",
    "UPDATE `buildopenplatprop` SET `IsOpen` = 0 WHERE (`BuildID`, `Idx`) IN ((134, 100), (197, 100));",
  ]);
  await runAll(flow, ["db.plans"]);
  assert.equal(flow.state.tasks["db.plans"].result.close, 9);
  assert.equal(Object.keys(flow.state.tasks["db.plans"].result.written).length, 9);
  assert.deepEqual({ ...flow.planCounts.value }, { open: 0, close: 0, keep: 34, skip: 1 });

  await runAll(flow, ["client.svn"]);
  assert.equal(flow.state.tasks["client.svn"].status, "attention");
  assert.deepEqual(flow.svnConflicts.value.map((conflict) => conflict.path), [
    "assets\\config\\Config.ts", "assets\\resources\\version.manifest",
  ]);
  assert.equal(await flow.runTask("client.sync"), false, "conflicts block the copy");
  assert.equal(await flow.resolveConflicts(), false, "every conflict needs a choice");
  flow.setConflictChoice(flow.svnConflicts.value[0].path, "manual");
  flow.setConflictChoice(flow.svnConflicts.value[1].path, "theirs");
  assert.equal(await flow.resolveConflicts(), true);
  assert.equal(flow.state.tasks["client.svn"].status, "done");
  assert.deepEqual(flow.state.tasks["client.svn"].result.choices, ["manual", "theirs"]);
  assert.ok(flow.state.tasks["client.svn"].logs.some((line) => line.text.includes("--accept working")));

  await runAll(flow, CLIENT_TASKS);
  const build = flow.state.tasks["build.cocos"].result;
  assert.deepEqual([build.exitCode, build.hotUpdate, build.qaFindings], [36, "1.024", 0]);
  assert.equal(flow.complete.value, true);
  assert.deepEqual(flow.progressSummary.value, { done: 7, total: 7 });

  // A finished update is kept in the history once and becomes read-only.
  assert.equal(flow.finished.value, true);
  assert.equal(flow.blockerOf("db.sync"), "finished");
  assert.equal(flow.setDate("2026-10-31"), false);
  const [record] = workspace.history.value;
  assert.deepEqual(
    [record.kind, record.platformId, record.outcome, record.demo, record.stats.done, record.stats.total],
    ["release", "tw", "done", true, 7, 7],
  );
  assert.equal(record.steps.find((step) => step.taskId === "db.sync").result.backup.database, "newsg_tw_cfg");
  assert.equal(workspace.cards.value.find((card) => card.platformId === "tw").status, "done");
  workspace.dispose();

  const reopened = createWorkspace(t, { storage, clock });
  const again = reopened.flowFor(flow.id);
  assert.equal(again.finished.value, true);
  assert.ok(again.state.events.some((entry) => entry.event === "started"), "the summary still knows when the update began");
  assert.equal(reopened.history.value.length, 1, "the record is written once");
});

test("updates of different platforms keep their own progress", async (t) => {
  const clock = manualClock();
  const workspace = createWorkspace(t, { clock });
  const tw = newUpdate(workspace, "tw");
  const douyin = newUpdate(workspace, "douyin");
  assert.equal(workspace.view.runId, douyin.id, "a new update opens on screen");
  startWith(tw, DATABASE_ONLY);
  startWith(douyin, DATABASE_ONLY);
  await runAll(tw, ["db.sync"]);
  assert.equal(douyin.state.tasks["db.sync"].status, "idle");

  const cards = Object.fromEntries(workspace.cards.value.map((card) => [card.platformId, card]));
  assert.deepEqual([cards.tw.status, cards.tw.progress.done, cards.tw.progress.total], ["active", 1, 2]);
  assert.equal(cards.douyin.runId, douyin.id);
  assert.equal(cards.wanxin.status, "idle");
  assert.equal(workspace.openPlatform("tw"), true);
  assert.equal(workspace.view.runId, tw.id);
  assert.equal(workspace.openPlatform("wanxin"), true);
  assert.deepEqual([workspace.view.section, workspace.view.platformId], ["platform", "wanxin"]);
});

test("a platform keeps one open update: a new one continues it, or replaces it once abandoned", async (t) => {
  const workspace = createWorkspace(t);
  const first = newUpdate(workspace, "tap");
  assert.deepEqual(workspace.createUpdate("tap"), { status: "open", runId: first.id });
  // An update that never started leaves no record when abandoned.
  assert.equal(workspace.abandonUpdate(first.id), true);
  assert.equal(workspace.history.value.length, 0);
  assert.deepEqual([workspace.view.section, workspace.view.platformId], ["platform", "tap"]);

  const second = newUpdate(workspace, "tap");
  startWith(second, DATABASE_ONLY);
  await runAll(second, ["db.sync"]);
  assert.equal(workspace.abandonUpdate(second.id), true);
  const [abandoned] = workspace.history.value;
  assert.deepEqual([abandoned.outcome, abandoned.platformId, abandoned.stats.done], ["abandoned", "tap", 1]);
  assert.equal(workspace.runOf("tap"), null);

  // A finished update makes room for the next one without asking.
  const third = newUpdate(workspace, "tap");
  await finishDatabaseUpdate(third);
  assert.equal(third.finished.value, true);
  const next = workspace.createUpdate("tap");
  assert.equal(next.status, "created");
  assert.notEqual(next.runId, third.id);
  assert.deepEqual(workspace.history.value.map((entry) => entry.outcome), ["done", "abandoned"]);
});

test("workspace pages open beside an update and lead back to the step it was on", async (t) => {
  const storage = memoryStorage();
  const workspace = createWorkspace(t, { storage });
  const flow = newUpdate(workspace);
  flow.setPrepared(true);
  flow.start();
  await runAll(flow, ["db.sync", "db.plans"]);
  assert.equal(workspace.openSection("plans"), true);
  workspace.openSection("build");
  assert.deepEqual({ ...workspace.view.returnTo }, { section: "run", runId: flow.id, platformId: "" }, "page to page keeps the way back");
  workspace.setPlanNote("hero-1062", "tw", "已開放");
  assert.equal(flow.state.tasks["db.plans"].stale, true, "a memo edit marks the written plan out of date");
  workspace.dispose();

  const reopened = createWorkspace(t, { storage });
  assert.equal(reopened.view.section, "build");
  reopened.back();
  assert.equal(reopened.view.section, "run");
  assert.equal(reopened.currentFlow.value.state.page, "database");
  reopened.openSection("history");
  reopened.openHome();
  assert.equal(reopened.view.returnTo, null);
});

test("the open-plan memo is the plan: edits, new entries, reminders and rows left out", async (t) => {
  const workspace = createWorkspace(t);
  const flow = newUpdate(workspace);
  flow.setPrepared(true);
  flow.start();
  await runAll(flow, ["db.sync", "db.plans"]);
  // Another platform's note leaves TW's write alone.
  workspace.setPlanNote("hero-1063", "douyin", "暫不開放");
  assert.equal(flow.state.tasks["db.plans"].status, "done");
  workspace.setPlanNote("hero-1062", "tw", "已開放");
  assert.equal(flow.state.tasks["db.plans"].status, "idle");
  assert.deepEqual({ ...flow.planCounts.value }, { open: 1, close: 0, keep: 33, skip: 1 });

  // A new hero with its ID is written; a topic without one is listed to do by hand.
  const hero = workspace.addPlanEntry({ category: "hero", name: "新英雄", ref: "1099", notes: { tw: "10/24 開放" } });
  assert.equal(flow.planCounts.value.open, 2);
  assert.match(flow.planSql.value.join("\n"), /1062, 1099/);
  const topic = workspace.addPlanEntry({ category: "other", name: "首儲活動", notes: { tw: "10/24 開放" } });
  assert.deepEqual(flow.planReminders.value.map((entry) => entry.id), [topic.id]);
  // A feature needs both of its keys to be written.
  workspace.addPlanEntry({ category: "feature", name: "半個功能", ref: "201", notes: { tw: "10/24 開放" } });
  assert.equal(flow.planReminders.value.length, 2);

  // Leaving an entry out of this update drops it from the write only.
  flow.setPlanSkip(hero.id, true);
  assert.equal(flow.planCounts.value.open, 1);
  assert.doesNotMatch(flow.planSql.value.join("\n"), /1099/);
  assert.equal(workspace.removePlanEntry(hero.id), true);
  assert.equal(flow.state.planSkips[hero.id], undefined);
  assert.equal(workspace.addPlanEntry({ name: "  " }), null, "an entry needs a name");
  assert.equal(workspace.updatePlanEntry(topic.id, { name: "首儲活動 2", notes: { douyin: "11/1 開放" } }), true);
  const updated = workspace.state.plans.items.find((entry) => entry.id === topic.id);
  assert.deepEqual([updated.name, updated.notes.tw, updated.notes.douyin], ["首儲活動 2", "10/24 開放", "11/1 開放"]);
});

test("an overwrite backs up first; a restore returns to that backup and resets the overwrite", async (t) => {
  const workspace = createWorkspace(t);
  const flow = newUpdate(workspace);
  flow.setPrepared(true);
  flow.start();
  assert.equal(flow.blockerOf("db.restore"), "noBackup");
  await runAll(flow, ["db.sync", "db.plans"]);
  const backup = flow.backup.value;
  assert.deepEqual([backup.database, backup.simulated, backup.tables], ["newsg_tw_cfg", true, 336]);
  const logs = flow.state.tasks["db.sync"].logs.map((line) => line.text);
  assert.ok(logs.findIndex((line) => line.startsWith("backup ")) < logs.findIndex((line) => line.startsWith("copy ")), "the backup comes before any copy");
  assert.equal(flow.restoreImpact.value.length, 3);

  await runAll(flow, ["db.restore"]);
  assert.equal(flow.state.tasks["db.restore"].result.backup.id, backup.id);
  assert.deepEqual([flow.state.tasks["db.sync"].status, flow.state.tasks["db.sync"].stale], ["idle", true]);
  assert.equal(flow.state.tasks["db.plans"].status, "idle");
  assert.equal(flow.backup.value, null);
  assert.equal(flow.blockerOf("db.restore"), "noBackup", "a restore is offered once per backup");
  assert.deepEqual(flow.progressSummary.value, { done: 0, total: 7 });
  await runAll(flow, ["db.sync"]);
  assert.equal(flow.state.tasks["db.restore"].status, "idle", "a new overwrite makes a new backup");
});

test("cards say what needs attention: conflicts, missing files and a missed start", async (t) => {
  const clock = manualClock();
  const workspace = createWorkspace(t, { clock });
  const card = (platformId) => workspace.cards.value.find((entry) => entry.platformId === platformId);
  const tw = newUpdate(workspace, "tw");
  tw.setPrepared(true);
  tw.start();
  workspace.setDemoOption("missingFiles", true);
  await runAll(tw, ["client.svn"]);
  assert.equal(card("tw").status, "attention");
  assert.deepEqual([card("tw").issues[0].kind, card("tw").issues[0].count], ["conflicts", 2]);
  tw.setAllConflictChoices("theirs");
  await tw.resolveConflicts();
  await runAll(tw, ["client.sync"]);
  assert.deepEqual(tw.state.tasks["client.sync"].result.warnings.map((warning) => warning.code), ["missing", "missing"]);
  assert.deepEqual([card("tw").issues[0].kind, card("tw").issues[0].count], ["missing", 2]);

  const tap = newUpdate(workspace, "tap");
  assert.equal(card("tap").status, "pending");
  assert.equal(card("tap").plannedAt, new Date(2026, 9, 24).getTime());
  await clock.advance(24 * 3600000);
  assert.deepEqual([card("tap").status, card("tap").issues[0].kind], ["attention", "overdue"]);
  assert.equal(tap.state.brief.started, false);
  assert.equal(card("wanxin").status, "idle");
});

test("the history keeps its own storage and keeps real records when demo ones are cleared", (t) => {
  const storage = memoryStorage();
  const workspace = createWorkspace(t, { storage, seed: true });
  assert.ok(workspace.history.value.length >= 4, "a first open seeds demo records");
  assert.ok(workspace.history.value.every((entry) => entry.demo));
  assert.equal(workspace.runOf("wanxin").brief.date, "2026-10-26", "and a demo update scheduled two days ahead");
  assert.equal(workspace.cards.value.find((entry) => entry.platformId === "douyin").status, "done");

  workspace.recordTool({
    kind: "build",
    platformId: "tw",
    platformName: "TW",
    demo: false,
    outcome: "done",
    startedAt: START.getTime() - 60000,
    finishedAt: START.getTime(),
    details: { platform: "android", exitCode: 36 },
    logs: ["Build success"],
  });
  workspace.clearDemoHistory();
  assert.deepEqual(workspace.history.value.map((entry) => [entry.kind, entry.demo]), [["build", false]]);
  const saved = JSON.parse(storage.data.get(RELEASE_HISTORY_STORAGE_KEY));
  assert.deepEqual(saved.entries.map((entry) => entry.logs[0].text), ["Build success"]);
  workspace.dispose();
  const workspaceSaved = JSON.parse(storage.data.get(RELEASE_WORKSPACE_STORAGE_KEY));
  assert.equal(workspaceSaved.schema, RELEASE_WORKSPACE_SCHEMA);
  assert.equal("history" in workspaceSaved, false, "the history is not written with every change of an update");
});

test("old GM-only drafts cannot execute and old endpoints do not block retained work", async (t) => {
  const calls = [];
  const storage = memoryStorage({
    [RELEASE_WORKSPACE_STORAGE_KEY]: JSON.stringify({
      schema: RELEASE_WORKSPACE_SCHEMA,
      companyGm: { url: "https://company.invalid", account: "old" },
      platforms: [{ id: "tw", gm: { url: "https://platform.invalid" } }],
      autopilot: { openServers: "auto", lateStart: "postpone" },
      runs: [{
        id: "run-saved",
        platformId: "tw",
        createdAt: START.getTime(),
        brief: { date: "2026-10-24", mode: "maintenance", scope: { database: false, client: false, server: true, activity: true }, prepared: true, started: true },
        page: "gmServer",
        demo: false,
        schedule: { maintenanceStart: "2026-10-24T10:00" },
        autopilot: { status: "running", taskId: "gm.shutdown" },
        tasks: {
          "gm.serverBuild": { status: "done", result: {} },
          "gm.shutdown": { status: "running" },
        },
      }],
      view: { section: "run", runId: "run-saved" },
    }),
  });
  const demo = createReleaseDemoDriver();
  const workspace = createWorkspace(t, { storage, driver: { run(taskId, context, io) {
    calls.push(taskId);
    return demo.run(taskId, context, io);
  } } });
  const flow = workspace.flowFor("run-saved");
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(flow.state.page, "brief");
  assert.equal(flow.state.brief.started, false);
  assert.equal(flow.canStart.value, false);
  assert.equal(flow.state.autopilot.status, "off");
  assert.equal(flow.setScope("server", true), false);
  assert.equal(await flow.runTask("gm.open"), false);
  await assert.rejects(demo.run("gm.open", {}, {}), { code: "unknownTask" });
  startWith(flow, DATABASE_ONLY);
  await runAll(flow, ["db.sync", "db.plans"]);
  assert.equal(flow.finished.value, true);
  workspace.dispose();
  const saved = storage.data.get(RELEASE_WORKSPACE_STORAGE_KEY);
  assert.doesNotMatch(saved, /companyGm|platform.invalid|company.invalid|gm\.|maintenance|schedule|openServers|lateStart/);
  assert.equal(JSON.parse(saved).runs[0].demo, true);
});

test("keeping the plan tables out of the overwrite starts from the platform's own flags", (t) => {
  const workspace = createWorkspace(t);
  const flow = newUpdate(workspace);
  flow.setSyncExclusions([...flow.syncExclusions.value, "heroprop", "buildopenplatprop"]);
  assert.equal(flow.planGroups.value.every((group) => !group.synced), true);
  assert.deepEqual({ ...flow.planCounts.value }, { open: 6, close: 0, keep: 28, skip: 1 });
});

test("rerunning finished work resets what was built on it", async (t) => {
  const workspace = createWorkspace(t);
  const flow = newUpdate(workspace);
  flow.setPrepared(true);
  flow.start();
  workspace.setDemoOption("conflicts", false);
  await runAll(flow, ["client.svn", "client.sync", "client.transfer"]);
  assert.equal(flow.state.tasks["client.sync"].result.excluded, 9);
  flow.setFileRules([...flow.fileRules.value, "*.meta"]);
  assert.equal(flow.state.tasks["client.sync"].status, "idle");
  assert.equal(flow.state.tasks["client.transfer"].status, "idle");
  assert.equal(flow.state.tasks["client.svn"].status, "done");
  await runAll(flow, ["client.sync"]);
  assert.equal(flow.state.tasks["client.sync"].result.excluded, 11);
  await runAll(flow, ["client.svn"]);
  assert.equal(flow.state.tasks["client.sync"].status, "idle");
});

test("platform settings changed elsewhere reset only that platform's update", async (t) => {
  const workspace = createWorkspace(t);
  const tw = newUpdate(workspace, "tw");
  const tap = newUpdate(workspace, "tap");
  for (const flow of [tw, tap]) {
    flow.setPrepared(true);
    flow.start();
    await runAll(flow, ["db.sync"]);
  }
  assert.equal(workspace.updatePlatform("tw", { targetDatabase: "newsg_tw2_cfg" }), true);
  assert.equal(tw.state.tasks["db.sync"].stale, true);
  assert.equal(tap.state.tasks["db.sync"].status, "done");
  assert.equal(workspace.updatePlatform("tap", { buildDebug: true }), true);
  assert.equal(workspace.state.platforms.find((platform) => platform.id === "tap").buildDebug, true);
});

test("a skipped conversion still lets the diff review run", async (t) => {
  const workspace = createWorkspace(t);
  const flow = newUpdate(workspace);
  flow.setPrepared(true);
  flow.start();
  workspace.setDemoOption("conflicts", false);
  await runAll(flow, ["client.svn", "client.sync"]);
  assert.equal(flow.skipTask("client.diff"), false, "only optional steps can be skipped");
  assert.equal(flow.skipTask("client.transfer"), true);
  assert.equal(flow.state.tasks["client.transfer"].status, "skipped");
  await runAll(flow, ["client.diff"]);
});

test("a stopped run returns to idle and says so in its log", async (t) => {
  let release;
  const blocking = (ms, signal) => new Promise((resolve, reject) => {
    release = resolve;
    signal.addEventListener("abort", () => reject(cancelled()), { once: true });
  });
  const workspace = createWorkspace(t, { sleep: blocking });
  const flow = newUpdate(workspace);
  flow.setPrepared(true);
  flow.start();
  const running = flow.runTask("db.sync");
  assert.equal(flow.busy.value, true);
  assert.equal(workspace.anyBusy.value, true);
  assert.equal(await flow.runTask("client.svn"), false, "one task at a time per update");
  flow.cancel();
  assert.equal(await running, false);
  assert.equal(flow.state.tasks["db.sync"].status, "idle");
  assert.match(flow.state.tasks["db.sync"].logs.at(-1).text, /stopped/);
  assert.equal(typeof release, "function");
});

test("a failed build keeps what the tool reported and succeeds on retry", async (t) => {
  const workspace = createWorkspace(t);
  const flow = newUpdate(workspace);
  flow.setPrepared(true);
  flow.start();
  workspace.setDemoOption("conflicts", false);
  workspace.setDemoOption("buildFailure", true);
  await runAll(flow, ["client.svn", "client.sync", "client.transfer", "client.diff"]);
  assert.equal(await flow.runTask("build.cocos"), false);
  assert.equal(flow.state.tasks["build.cocos"].status, "failed");
  assert.equal(flow.state.tasks["build.cocos"].error, "buildFailed");
  assert.equal(flow.state.tasks["build.cocos"].result.exitCode, 34);
  assert.equal(workspace.cards.value.find((card) => card.platformId === "tw").issues[0].kind, "failed");
  assert.equal(await flow.runTask("build.cocos"), true);
  assert.equal(flow.state.tasks["build.cocos"].result.exitCode, 36);
});

test("changing the date resets date-bound work without changing completed sync", async (t) => {
  const workspace = createWorkspace(t);
  const flow = newUpdate(workspace);
  startWith(flow, { database: true, client: true });
  await runAll(flow, ["db.sync", "db.plans"]);
  assert.equal(flow.setDate("2026-10-31"), true);
  assert.equal(flow.state.tasks["db.plans"].status, "idle");
  assert.equal(flow.state.tasks["db.sync"].status, "done");
  assert.equal(workspace.cards.value.find((card) => card.platformId === "tw").plannedAt, new Date(2026, 9, 31).getTime());
});

test("a v2 draft becomes an update of its platform and its notes seed the memo", (t) => {
  const storage = memoryStorage({
    [RELEASE_FLOW_STORAGE_KEY]: JSON.stringify({
      schema: RELEASE_FLOW_SCHEMA,
      brief: { platformId: "douyin", date: "2026-10-23", mode: "maintenance", scope: DATABASE_ONLY, prepared: true, started: true },
      tasks: { "db.sync": { status: "done", result: { tables: 20 } }, "gm.serverBuild": { status: "done" } },
      notes: { "hero-1062": { douyin: "11/1 開放" } },
      page: "overview",
      history: [{ at: START.getTime() - 3600000, taskId: "", event: "started" }],
      demo: { speed: "fast", clockOffset: 5000 },
    }),
  });
  const workspace = createWorkspace(t, { storage });
  const run = workspace.runOf("douyin");
  assert.equal(run.brief.date, "2026-10-23", "a started update keeps its day");
  assert.equal(run.page, "brief");
  assert.equal(run.tasks["db.sync"].status, "done");
  assert.equal(run.tasks["gm.serverBuild"], undefined);
  assert.equal(run.clockOffset, undefined);
  assert.deepEqual([workspace.view.section, workspace.view.runId], ["run", run.id]);
  assert.equal(workspace.state.plans.items.find((entry) => entry.id === "hero-1062").notes.douyin, "11/1 開放");
  assert.equal(workspace.state.demo.speed, "fast");
  workspace.dispose();
  assert.equal(storage.data.has(RELEASE_FLOW_STORAGE_KEY), false);
});

test("a corrupt or foreign saved workspace falls back to an empty one", (t) => {
  for (const raw of ["{", JSON.stringify({ schema: 99 }), JSON.stringify([1, 2])]) {
    const workspace = createWorkspace(t, { storage: memoryStorage({ [RELEASE_WORKSPACE_STORAGE_KEY]: raw }) });
    assert.deepEqual(workspace.state.platforms.map((platform) => platform.id), ["douyin", "tap", "wanxin", "tw"]);
    assert.deepEqual(workspace.state.runs, []);
    assert.equal(workspace.view.section, "home");
  }
});

test("an unstarted draft follows the calendar; a started update keeps its day", (t) => {
  const stored = (started) => memoryStorage({
    [RELEASE_WORKSPACE_STORAGE_KEY]: JSON.stringify({
      schema: RELEASE_WORKSPACE_SCHEMA,
      runs: [{ id: "run-draft", platformId: "douyin", brief: { date: "2026-10-20", started }, schedule: { maintenanceStart: "2026-10-20T10:00", maintenanceEnd: "2026-10-20T12:00" } }],
    }),
  });
  const draft = createWorkspace(t, { storage: stored(false) }).runOf("douyin");
  assert.equal(draft.brief.date, "2026-10-24");
  assert.equal(draft.schedule, undefined);
  const started = createWorkspace(t, { storage: stored(true) }).runOf("douyin");
  assert.equal(started.brief.date, "2026-10-20");
});

/* ── One-click mode ── */

// One-click mode moves on through promises; wait until it rests.
async function until(predicate, what) {
  for (let round = 0; round < 400; round += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`never: ${what}`);
}

test("one-click mode completes all seven steps without waiting on removed work", async (t) => {
  const storage = memoryStorage();
  const clock = manualClock();
  const workspace = createWorkspace(t, { storage, clock });
  assert.equal(workspace.setAutopilotRule("svnConflicts", "theirs"), true);
  assert.equal(workspace.setAutopilotRule("svnConflicts", "maybe"), false);
  const flow = newUpdate(workspace);
  assert.equal(flow.autopilot.start(), false, "the files must be confirmed first");
  flow.setPrepared(true);
  assert.equal(flow.autopilot.start(), true);
  assert.equal(workspace.cards.value.find((card) => card.platformId === "tw").autopilot, true);

  await until(() => flow.autopilot.status.value === "done", "finished preparation");
  assert.equal(flow.state.brief.started, true);
  assert.equal(flow.state.tasks["client.svn"].status, "done");
  assert.deepEqual(flow.state.tasks["client.svn"].result.choices, ["theirs", "theirs"]);
  assert.equal(flow.state.page, "build", "the run shows the last retained step");
  assert.ok(flow.state.autopilot.log.some((entry) => entry.kind === "resolved"));

  assert.equal(flow.finished.value, true);
  assert.deepEqual(flow.progressSummary.value, { done: 7, total: 7 });
  assert.equal(workspace.history.value[0].outcome, "done");
  assert.equal(workspace.cards.value.find((card) => card.platformId === "tw").autopilot, false);
});

test("one-click mode pauses where a rule says so and goes on once the person lets it", async (t) => {
  const workspace = createWorkspace(t);
  workspace.setAutopilotRule("diffReview", "stop");
  const flow = newUpdate(workspace);
  startWith(flow, CLIENT_ONLY);
  flow.autopilot.start();
  // SVN conflicts stop by default.
  await until(() => flow.autopilot.status.value === "paused", "paused at the conflicts");
  assert.deepEqual([flow.state.autopilot.reason, flow.state.autopilot.taskId], ["conflicts", "client.svn"]);
  const card = workspace.cards.value.find((entry) => entry.platformId === "tw");
  assert.deepEqual([card.status, card.issues[0].kind], ["attention", "autoPaused"]);
  // The person settles the conflicts by hand and lets the run go on.
  flow.setAllConflictChoices("mine");
  assert.equal(await flow.resolveConflicts(), true);
  assert.equal(flow.autopilot.resume(), true);
  await until(() => flow.autopilot.status.value === "paused", "paused before the review");
  assert.deepEqual([flow.state.autopilot.reason, flow.state.autopilot.taskId], ["review", "client.diff"]);
  assert.equal(flow.state.tasks["client.diff"].status, "idle", "nothing is reviewed without the person");
  flow.autopilot.resume();
  await until(() => flow.state.tasks["build.cocos"].status === "done", "past the review");
  await until(() => flow.autopilot.status.value === "done", "client preparation complete");
  assert.deepEqual(flow.progressSummary.value, { done: 5, total: 5 });
});

test("a failing step is retried by the rules, then waits for the person", async (t) => {
  const demo = createReleaseDemoDriver();
  let failures = 2;
  const driver = {
    run(taskId, context, io) {
      if (taskId === "db.sync" && failures > 0) {
        failures -= 1;
        return Promise.reject(Object.assign(new Error("svn"), { code: "failed" }));
      }
      return demo.run(taskId, context, io);
    },
  };
  const delays = [];
  const sleep = (ms, signal) => {
    delays.push(ms);
    return immediate(ms, signal);
  };
  const workspace = createWorkspace(t, { driver, sleep });
  workspace.setAutopilotRule("retries", 1);
  workspace.setAutopilotRule("retryDelay", 60);
  const flow = newUpdate(workspace);
  startWith(flow, DATABASE_ONLY);
  flow.autopilot.start();
  await until(() => flow.autopilot.status.value === "paused", "paused after the retry");
  assert.deepEqual([flow.state.autopilot.reason, flow.state.autopilot.taskId], ["failed", "db.sync"]);
  assert.equal(failures, 0, "one try and one retry");
  assert.ok(delays.includes(60000), "the retry waits as long as the rules say");
  assert.equal(workspace.cards.value.find((card) => card.platformId === "tw").issues[0].kind, "autoPaused");
  // Continuing gives the step its retries again.
  flow.autopilot.resume();
  await until(() => flow.state.tasks["db.sync"].status === "done", "the sync succeeds");
  assert.ok(flow.state.autopilot.log.filter((entry) => entry.kind === "retry").length >= 1);
});

test("the demo's failed build is retried by itself", async (t) => {
  const workspace = createWorkspace(t);
  workspace.setDemoOption("buildFailure", true);
  workspace.setAutopilotRule("svnConflicts", "theirs");
  const flow = newUpdate(workspace);
  startWith(flow, CLIENT_ONLY);
  flow.autopilot.start();
  await until(() => flow.state.tasks["build.cocos"].status === "done", "the client is built");
  assert.ok(flow.state.tasks["build.cocos"].logs.length > 0);
  assert.deepEqual(flow.state.autopilot.log.filter((entry) => entry.kind === "retry").map((entry) => entry.taskId), ["build.cocos"]);
});

test("pausing, stopping and leaving one-click mode hand the update back to the person", async (t) => {
  const workspace = createWorkspace(t);
  const flow = newUpdate(workspace);
  startWith(flow, DATABASE_ONLY);
  flow.autopilot.start();
  // Stopping a step (here: while nothing runs) pauses the run instead of restarting it.
  flow.cancel();
  assert.deepEqual([flow.autopilot.status.value, flow.state.autopilot.reason], ["paused", "stopped"]);
  assert.equal(flow.autopilot.stop(), true);
  assert.equal(flow.autopilot.status.value, "off");
  assert.equal(flow.autopilot.resume(), false);
  assert.equal(workspace.autopilotRuns.value.length, 0);
});

test("one-click mode goes on where it was when the workspace opens again", async (t) => {
  const storage = memoryStorage();
  const clock = manualClock();
  const first = createWorkspace(t, { storage, clock, sleep: (ms, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(cancelled()), { once: true });
  }) });
  const flow = newUpdate(first);
  startWith(flow, DATABASE_ONLY);
  flow.autopilot.start();
  await until(() => flow.busy.value, "sync running");
  assert.equal(first.autopilotRuns.value.length, 1);
  first.dispose();
  await settle();

  const reopened = createWorkspace(t, { storage, clock });
  const again = reopened.flowFor(flow.id);
  assert.equal(again.autopilot.status.value, "running");
  await until(() => again.autopilot.status.value === "done", "finished after reopening");
  assert.equal(again.finished.value, true);
});

test("real mode executes database and client steps through backend commands and persists demo: false", async (t) => {
  const storage = memoryStorage();
  const invoked = [];
  const flags = { "hero-1062": 0, "hero-1063": 1 };
  const invoke = async (cmd, payload) => {
    invoked.push([cmd, payload]);
    if (cmd === "preview_database_sync") {
      return {
        tablesToCopy: ["heroprop", "buildopenplatprop"],
        excludedTables: payload?.request?.excludedTables || [],
        estimatedRows: 120,
        warnings: [],
      };
    }
    if (cmd === "list_tables") return [{ name: "heroprop" }, { name: "buildopenplatprop" }, { name: "goodsprop" }];
    if (cmd === "release_read_plan_flags") return { flags: { ...flags }, missingTables: [] };
    if (cmd === "release_client_sync_preview") {
      return { copy: [{ path: "assets/Main.ts", kind: "modified" }], remove: [], kept: [], excluded: [], truncated: false };
    }
    if (cmd === "sync_database_overwrite") {
      return {
        status: "completed",
        copiedTables: ["heroprop", "buildopenplatprop"],
        droppedTables: [],
        copiedRows: 120,
        backupSnapshotPath: "/tmp/tw_snap.sql",
      };
    }
    if (cmd === "list_snapshots") return [{ path: "/tmp/tw_snap.sql", ts: START.getTime(), tableCount: 3 }];
    if (cmd === "restore_snapshot") return { ok: true };
    if (cmd === "release_execute_plan_writes") {
      flags["hero-1062"] = 1;
      return { executedSql: ["UPDATE `heroprop` SET `isopen` = 1 WHERE `heroid` IN (1062)"], affectedRows: 1, statements: 1 };
    }
    if (cmd === "svn_wc_update") return { revision: 1208, updated: 1, lines: ["U    assets/Main.ts"], conflicts: [] };
    if (cmd === "svn_wc_status") return [{ path: "assets/props/heroprop.json", item: "modified", props: "none", treeConflict: false }];
    if (cmd === "release_client_sync_run") {
      return { added: 1, modified: 1, deleted: 0, excluded: 1, warnings: [] };
    }
    if (cmd === "table_transfer_run") return { outputDir: "D:\\tools\\2026-10-24 09-30-00", updatedDirs: [], copiedFiles: 18 };
    throw new Error(`unexpected command: ${cmd}`);
  };
  const listen = async () => () => {};
  const connections = [
    { id: "mysql-jswz", name: "JSWZ", kind: "mysql", connected: true, readOnly: false },
  ];
  const databasesByConnection = {
    "mysql-jswz": ["newsg_4cfg", "newsg_tw_cfg"],
  };
  const driver = composeDrivers(
    createReleaseRealDriver({ invoke, listen }),
    createReleaseDemoDriver(),
  );
  const workspace = createWorkspace(t, {
    storage,
    realMode: true,
    connections,
    databasesByConnection,
    invoke,
    driver,
  });
  const flow = newUpdate(workspace, "tw");
  assert.equal(flow.state.demo, false);
  assert.equal(flow.isReal.value, true);
  assert.equal(flow.resolvedConnection.value?.id, "mysql-jswz");
  assert.equal(invoked.length, 0, "brief page defers live database/filesystem scans");

  flow.setPrepared(true);
  flow.start();
  await until(() => invoked.some(([cmd]) => cmd === "release_read_plan_flags"), "live previews loaded on database page");

  await flow.runTask("db.sync");
  assert.equal(flow.state.tasks["db.sync"].result.snapshot, "/tmp/tw_snap.sql");
  assert.equal(flow.backup.value?.simulated, false);

  workspace.setPlanNote("hero-1062", "tw", "已開放");
  await settle();
  await flow.runTask("db.plans");
  assert.equal(flow.state.tasks["db.plans"].status, "done");
  assert.ok(invoked.some(([cmd]) => cmd === "release_execute_plan_writes"));

  await runAll(flow, ["client.svn", "client.sync", "client.transfer", "client.diff"]);
  const transferCall = invoked.find(([cmd]) => cmd === "table_transfer_run");
  assert.equal(transferCall?.[1]?.request?.skipSvnUpdate, true);
  assert.equal(flow.state.tasks["client.diff"].result.files, 1);

  assert.equal(await flow.runTask("db.restore"), true);
  assert.ok(invoked.some(([cmd, payload]) => cmd === "restore_snapshot" && payload?.request?.snapshotPath === "/tmp/tw_snap.sql"));

  workspace.dispose();
  const saved = JSON.parse(storage.data.get(RELEASE_WORKSPACE_STORAGE_KEY));
  assert.equal(saved.runs[0].demo, false);
});

test("custom platforms can be added, persisted, used in updates and open plans, and removed safely", async (t) => {
  const storage = memoryStorage();
  const workspace = createWorkspace(t, { storage });
  workspace.state.rules.fileExclusions.tw = ["/ServerOnly/"];
  const created = workspace.addPlatform({
    name: "  东南亚服  ",
    copyFromId: "tw",
    targetDatabase: "newsg_sea_cfg",
    targetClient: "D:\\client\\jswz-sea",
  });
  assert.ok(created);
  assert.match(created.id, /^plat-/);
  assert.equal(created.name, "东南亚服");
  assert.equal(created.sourceDatabase, "newsg_4cfg");
  assert.equal(created.targetDatabase, "newsg_sea_cfg");
  assert.equal(created.targetClient, "D:\\client\\jswz-sea");
  assert.deepEqual(workspace.state.rules.fileExclusions[created.id], ["/ServerOnly/"]);
  assert.equal(workspace.state.platformsCustomized, true);
  assert.equal(workspace.state.plans.items[0].notes[created.id], "");

  workspace.setPlanNote("hero-1062", created.id, "10/24 開放");
  const flow = newUpdate(workspace, created.id);
  startWith(flow, { database: true, client: true });
  await runAll(flow, ["db.sync", "db.plans"]);
  assert.equal(flow.state.tasks["db.plans"].status, "done");

  workspace.openPlatform(created.id);
  workspace.state.build.targetId = created.id;
  assert.equal(workspace.removePlatform(created.id), true);
  assert.equal(workspace.state.platforms.some((entry) => entry.id === created.id), false);
  assert.equal(workspace.state.plans.items[0].notes[created.id], undefined);
  assert.equal(workspace.view.section, "platform");
  assert.equal(workspace.state.build.targetId, "douyin");
  assert.equal(workspace.history.value[0].platformId, created.id);
  assert.equal(workspace.history.value[0].outcome, "abandoned");

  const sea2 = workspace.addPlatform({ name: "韩服", copyFromId: "" });
  assert.equal(sea2.sourceDatabase, "newsg_4cfg");
  assert.equal(sea2.targetDatabase, "");
  for (const id of ["douyin", "tap", "wanxin", "tw"]) {
    assert.equal(workspace.removePlatform(id), true);
  }
  assert.equal(workspace.state.platforms.length, 1);
  assert.equal(workspace.removePlatform(sea2.id), false, "at least one platform must remain");

  workspace.dispose();
  const reloaded = createWorkspace(t, { storage });
  assert.deepEqual(reloaded.state.platforms.map((entry) => entry.name), ["韩服"]);
});

test("batch deleting open-plan entries removes them together and resets only affected updates", async (t) => {
  const workspace = createWorkspace(t);
  const tw = newUpdate(workspace, "tw");
  const tap = newUpdate(workspace, "tap");
  workspace.setPlanNote("hero-1061", "tw", "已開放");
  workspace.setPlanNote("hero-1062", "tw", "已開放");
  workspace.setPlanNote("hero-1061", "tap", "");
  workspace.setPlanNote("hero-1062", "tap", "");
  for (const flow of [tw, tap]) {
    startWith(flow, { database: true, client: true });
    await runAll(flow, ["db.sync", "db.plans"]);
  }
  const beforeCount = workspace.state.plans.items.length;
  assert.equal(workspace.removePlanEntries(["hero-1061", "hero-1062", "missing-id"]), 2);
  assert.equal(workspace.state.plans.items.length, beforeCount - 2);
  assert.equal(tw.state.tasks["db.plans"].stale, true);
  assert.equal(tap.state.tasks["db.plans"].status, "done");
});
