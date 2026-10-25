import assert from "node:assert/strict";
import { test } from "node:test";
import { useReleaseFlow } from "./composables/useReleaseFlow.js";
import { RELEASE_FLOW_SCHEMA, RELEASE_FLOW_STORAGE_KEY } from "./releaseFlowState.js";
import { createReleaseDemoDriver } from "./utils/releaseFlowDemoDriver.js";

const START = new Date(2026, 9, 24, 9, 30);
const TEMPLATES = [{ id: "juesheng-2", name: "决胜2", scriptPath: "D:\\tools\\gen.bat", projectRoot: "D:\\jswz\\release\\tw\\jswz" }];

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), data };
}

function cancelled() {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

const immediate = (ms, signal) => (signal?.aborted ? Promise.reject(cancelled()) : Promise.resolve());

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

// The server clock, moved by hand instead of once a second.
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

function createFlow(t, { clock = manualClock(), ...options } = {}) {
  const flow = useReleaseFlow({
    storage: memoryStorage(),
    sleep: immediate,
    now: clock.now,
    ticker: clock.ticker,
    templates: () => TEMPLATES,
    ...options,
  });
  t.after(() => flow.dispose());
  return flow;
}

async function runAll(flow, ids) {
  for (const id of ids) assert.equal(await flow.runTask(id), true, id);
}

const SERVER_ONLY = { database: false, client: false, server: true, activity: false };
const CLIENT_TASKS = ["client.sync", "client.transfer", "client.diff", "build.cocos"];
const UPLOADS = ["gm.activityUpload", "gm.activityCurrent", "gm.clientUpload", "gm.serverUpload", "gm.serverCurrent"];

function startServerOnly(flow) {
  for (const [scope, enabled] of Object.entries(SERVER_ONLY)) flow.setScope(scope, enabled);
  flow.setPrepared(true);
  flow.start();
}

test("a maintenance release runs from the brief to the reopened servers", async (t) => {
  const storage = memoryStorage();
  const clock = manualClock();
  const flow = createFlow(t, { storage, clock });
  assert.equal(flow.state.brief.platformId, "tw");
  assert.equal(flow.state.brief.date, "2026-10-24");
  assert.equal(flow.canStart.value, false);
  assert.equal(await flow.runTask("db.sync"), false, "nothing runs before the release starts");

  flow.setPrepared(true);
  assert.equal(flow.start(), true);
  assert.equal(flow.state.page, "database");
  assert.equal(await flow.runTask("db.plans"), false, "the plan waits for the overwrite");

  await runAll(flow, ["db.sync"]);
  const sync = flow.state.tasks["db.sync"].result;
  assert.deepEqual([sync.tables, sync.excluded, sync.rows], [334, 2, 140193]);
  assert.match(sync.snapshot, /newsg_tw_cfg/);
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

  await runAll(flow, [...CLIENT_TASKS, ...UPLOADS]);
  const build = flow.state.tasks["build.cocos"].result;
  assert.deepEqual([build.exitCode, build.hotUpdate, build.qaFindings], [36, "1.024", 0]);
  assert.equal(flow.state.tasks["gm.clientUpload"].result.file, "jswz_hotupdate_1.024.zip");
  assert.equal(flow.state.tasks["gm.activityUpload"].result.file, "activity_20261024.xlsx");

  // The GM keeps the time: the servers close by themselves at 10:00.
  assert.equal(flow.serverPhase.value, "running");
  assert.equal(await flow.scheduleMaintenance(), true);
  assert.equal(flow.serverPhase.value, "scheduled");
  assert.equal(flow.state.tasks["gm.clientOpen"].status, "done", "the hot update's opening goes with the window");
  assert.equal(flow.blockerOf("gm.restart"), "dependency");
  await clock.advance(29 * 60000 + 59000);
  assert.equal(flow.serverPhase.value, "scheduled", "a second early nothing happens");
  await clock.advance(1000);
  assert.equal(flow.serverPhase.value, "maintenance");
  assert.equal(flow.players.value, 0);
  assert.ok(flow.state.tasks["gm.shutdown"].result.players > 0);
  const closed = flow.state.history.find((entry) => entry.taskId === "gm.shutdown" && entry.event === "done");
  assert.equal(closed.serverAt, new Date(2026, 9, 24, 10, 0).getTime());

  await runAll(flow, ["gm.restart"]);
  assert.equal(flow.serverPhase.value, "readyToOpen");
  await runAll(flow, ["gm.open"]);
  assert.equal(flow.serverPhase.value, "restored");
  assert.equal(flow.clientOpenAt.value, new Date(2026, 9, 24, 10, 0).getTime(), "the hot update opens with the early reopening");
  assert.equal(flow.complete.value, true);
  assert.deepEqual(flow.progressSummary.value, { done: 17, total: 17 });
  flow.dispose();

  const reopened = createFlow(t, { storage, clock });
  assert.equal(reopened.complete.value, true);
  assert.equal(reopened.serverPhase.value, "restored");
  assert.ok(reopened.state.history.some((entry) => entry.event === "started"), "the summary still knows when the release began");
});

test("the maintenance window and the hot update's opening are scheduled together", async (t) => {
  const flow = createFlow(t);
  flow.setPrepared(true);
  flow.start();
  assert.equal(flow.scheduleBlocker.value, "gm.clientOpen");
  assert.equal(await flow.scheduleMaintenance(), false, "the hot update needs its package first");
  assert.equal(flow.state.tasks["gm.maintenance"].status, "idle", "nothing is half scheduled");
  flow.setScope("client", false);
  assert.equal(flow.scheduleBlocker.value, "");
  assert.equal(await flow.scheduleMaintenance(), true);
  assert.equal(flow.serverPhase.value, "scheduled");
});

test("a schedule can be withdrawn before the servers close, and the demo can skip the wait", async (t) => {
  const flow = createFlow(t);
  startServerOnly(flow);
  await flow.scheduleMaintenance();
  assert.equal(flow.cancelSchedule(), true);
  assert.equal(flow.serverPhase.value, "running");
  assert.equal(flow.state.tasks["gm.maintenance"].stale, true);
  assert.equal(flow.state.history.at(-1).event, "cancelled");

  assert.equal(await flow.scheduleMaintenance(), true);
  assert.equal(await flow.fastForward(), true);
  assert.equal(flow.serverPhase.value, "maintenance");
  assert.equal(flow.state.demo.clockOffset, 30 * 60000);
  assert.equal(flow.cancelSchedule(), false, "closed servers cannot be unscheduled");
  // A new release starts on the real clock again.
  await runAll(flow, ["gm.serverUpload", "gm.serverCurrent", "gm.restart", "gm.open"]);
  assert.equal(flow.restart(), true);
  assert.equal(flow.state.demo.clockOffset, 0);
});

test("a start time that has passed moves on when the release starts and blocks scheduling", async (t) => {
  const flow = createFlow(t, { clock: manualClock(new Date(2026, 9, 24, 10, 32)) });
  startServerOnly(flow);
  assert.equal(flow.state.schedule.maintenanceStart, "2026-10-24T10:50");
  assert.equal(flow.state.schedule.maintenanceEnd, "2026-10-24T12:50");
  assert.equal(flow.scheduleProblem.value, "");
  flow.setSchedule({ maintenanceStart: "2026-10-24T10:30" });
  assert.equal(flow.scheduleProblem.value, "startPassed");
  assert.equal(await flow.scheduleMaintenance(), false);
  assert.equal(flow.suggestSchedule(), true);
  assert.equal(flow.scheduleProblem.value, "");
});

test("a refused shutdown waits for a retry; an interrupted one runs again", async (t) => {
  const demo = createReleaseDemoDriver();
  let refusals = 1;
  const driver = {
    run(taskId, context, io) {
      if (taskId === "gm.shutdown" && refusals > 0) {
        refusals -= 1;
        return Promise.reject(Object.assign(new Error("refused"), { code: "failed" }));
      }
      return demo.run(taskId, context, io);
    },
  };
  const clock = manualClock();
  const flow = createFlow(t, { clock, driver });
  startServerOnly(flow);
  await flow.scheduleMaintenance();
  await clock.advance(30 * 60000);
  assert.equal(flow.state.tasks["gm.shutdown"].status, "failed");
  assert.equal(flow.shutdownRefused.value, true);
  assert.equal(flow.serverPhase.value, "scheduled");
  await clock.advance(1000);
  assert.equal(flow.state.tasks["gm.shutdown"].status, "failed", "no retry loop against the GM");
  assert.equal(await flow.runTask("gm.shutdown"), true);
  assert.equal(flow.serverPhase.value, "maintenance");

  const storage = memoryStorage({
    [RELEASE_FLOW_STORAGE_KEY]: JSON.stringify({
      schema: RELEASE_FLOW_SCHEMA,
      brief: { platformId: "tw", date: "2026-10-24", mode: "maintenance", scope: SERVER_ONLY, prepared: true, started: true },
      tasks: { "gm.maintenance": { status: "done", result: {} }, "gm.shutdown": { status: "running" } },
    }),
  });
  const later = manualClock(new Date(2026, 9, 24, 10, 5));
  const restored = createFlow(t, { storage, clock: later });
  assert.equal(restored.state.tasks["gm.shutdown"].error, "interrupted");
  assert.equal(restored.shutdownRefused.value, false);
  await later.advance(1000);
  assert.equal(restored.serverPhase.value, "maintenance");
});

test("tools open beside the steps and lead back to where the person was", async (t) => {
  const storage = memoryStorage();
  const flow = createFlow(t, { storage });
  flow.go("plans");
  flow.go("platforms");
  flow.returnToFlow();
  assert.equal(flow.state.page, "overview");
  flow.setPrepared(true);
  flow.start();
  await runAll(flow, ["db.sync", "db.plans"]);
  flow.go("plans");
  assert.equal(flow.state.page, "plans");
  flow.setNote("hero-1062", "tw", "已開放");
  assert.equal(flow.state.tasks["db.plans"].stale, true, "a plan edit marks the written plan out of date");
  assert.deepEqual(flow.progressSummary.value, { done: 1, total: 17 });
  flow.dispose();

  const reopened = createFlow(t, { storage });
  assert.equal(reopened.state.page, "plans");
  reopened.returnToFlow();
  assert.equal(reopened.state.page, "database");
});

test("editing a written plan marks the write stale and only the edited row changes", async (t) => {
  const flow = createFlow(t);
  flow.setPrepared(true);
  flow.start();
  await runAll(flow, ["db.sync", "db.plans"]);
  flow.setNote("hero-1062", "tw", "已開放");
  assert.equal(flow.state.tasks["db.plans"].status, "idle");
  assert.equal(flow.state.tasks["db.plans"].stale, true);
  assert.deepEqual({ ...flow.planCounts.value }, { open: 1, close: 0, keep: 33, skip: 1 });
  // Another platform's note does not touch this release.
  flow.setNote("hero-1063", "douyin", "暫不開放");
  assert.deepEqual({ ...flow.planCounts.value }, { open: 1, close: 0, keep: 33, skip: 1 });
  // Overwriting again brings development values back into synced tables.
  await runAll(flow, ["db.sync"]);
  assert.equal(flow.planCounts.value.close, 8);
});

test("keeping the plan tables out of the overwrite starts from the platform's own flags", (t) => {
  const flow = createFlow(t);
  flow.setSyncExclusions([...flow.syncExclusions.value, "heroprop", "buildopenplatprop"]);
  assert.equal(flow.planGroups.value.every((group) => !group.synced), true);
  assert.deepEqual({ ...flow.planCounts.value }, { open: 6, close: 0, keep: 28, skip: 1 });
});

test("rerunning finished work resets what was built on it", async (t) => {
  const flow = createFlow(t);
  flow.setPrepared(true);
  flow.start();
  flow.setDemoOption("conflicts", false);
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

test("a skipped conversion still lets the diff review run", async (t) => {
  const flow = createFlow(t);
  flow.setPrepared(true);
  flow.start();
  flow.setDemoOption("conflicts", false);
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
  const flow = createFlow(t, { sleep: blocking });
  flow.setPrepared(true);
  flow.start();
  const running = flow.runTask("db.sync");
  assert.equal(flow.busy.value, true);
  assert.equal(await flow.runTask("client.svn"), false, "one task at a time");
  flow.cancel();
  assert.equal(await running, false);
  assert.equal(flow.state.tasks["db.sync"].status, "idle");
  assert.match(flow.state.tasks["db.sync"].logs.at(-1).text, /stopped/);
  assert.equal(typeof release, "function");
});

test("the demo's first Cocos build can fail with exit code 34 and succeed on retry", async (t) => {
  const flow = createFlow(t);
  flow.setPrepared(true);
  flow.start();
  flow.setDemoOption("conflicts", false);
  flow.setDemoOption("buildFailure", true);
  await runAll(flow, ["client.svn", "client.sync", "client.transfer", "client.diff"]);
  assert.equal(await flow.runTask("build.cocos"), false);
  assert.equal(flow.state.tasks["build.cocos"].status, "failed");
  assert.equal(flow.state.tasks["build.cocos"].error, "buildFailed");
  assert.equal(flow.state.tasks["build.cocos"].result.exitCode, 34);
  assert.equal(await flow.runTask("build.cocos"), true);
  assert.equal(flow.state.tasks["build.cocos"].result.exitCode, 36);
});

test("a no-downtime release reloads activities instead of restarting", async (t) => {
  const flow = createFlow(t);
  assert.equal(flow.setMode("hot"), true);
  assert.equal(flow.state.brief.scope.server, false);
  assert.equal(flow.setScope("server", true), false, "server versions need a restart");
  assert.equal(flow.applies("gm.activityReload"), true);
  for (const id of ["gm.maintenance", "gm.shutdown", "gm.restart", "gm.open"]) assert.equal(flow.applies(id), false, id);
  flow.setScope("database", false);
  flow.setScope("client", false);
  flow.setPrepared(true);
  flow.start();
  assert.equal(flow.state.page, "gmUpload");
  await runAll(flow, ["gm.activityUpload", "gm.activityCurrent", "gm.activityReload"]);
  assert.equal(flow.complete.value, true);
  assert.equal(flow.serverPhase.value, "running");
});

test("without downtime the hot update opens when the person says", (t) => {
  const flow = createFlow(t);
  flow.setMode("hot");
  flow.setSchedule({ clientOpenAt: "2026-10-24T15:00" });
  assert.equal(flow.state.schedule.clientOpenAt, "2026-10-24T15:00", "there is no maintenance end to follow");
  flow.setMode("maintenance");
  assert.equal(flow.state.schedule.clientOpenAt, "2026-10-24T12:00", "with maintenance it follows the end again");
  flow.setSchedule({ maintenanceEnd: "2026-10-24T12:30" });
  assert.equal(flow.state.schedule.clientOpenAt, "2026-10-24T12:30");
});

test("changing the date shifts the schedule and resets date-bound work", async (t) => {
  const flow = createFlow(t);
  flow.setPrepared(true);
  flow.start();
  await runAll(flow, ["db.sync", "db.plans", "gm.maintenance"]);
  assert.equal(flow.setDate("2026-10-31"), true);
  assert.equal(flow.state.schedule.maintenanceStart, "2026-10-31T10:00");
  assert.equal(flow.state.tasks["db.plans"].status, "idle");
  assert.equal(flow.state.tasks["gm.maintenance"].status, "idle");
  assert.equal(flow.state.tasks["db.sync"].status, "done");
  flow.setSchedule({ maintenanceEnd: "2026-10-31T13:00" });
  assert.equal(flow.state.schedule.clientOpenAt, "2026-10-31T13:00", "the client update follows the end of maintenance");
  flow.setSchedule({ maintenanceEnd: "2026-10-31T09:00" });
  assert.equal(flow.scheduleProblem.value, "endBeforeStart");
});

test("a corrupt, foreign or older saved flow falls back to the sample release", (t) => {
  const older = JSON.stringify({ schema: 1, brief: { platformId: "tw", date: "2026-10-24", started: true } });
  for (const raw of ["{", JSON.stringify({ schema: 99 }), JSON.stringify([1, 2]), older]) {
    const flow = createFlow(t, { storage: memoryStorage({ [RELEASE_FLOW_STORAGE_KEY]: raw }) });
    assert.deepEqual(flow.state.platforms.map((platform) => platform.id), ["douyin", "tap", "wanxin", "tw"]);
    assert.equal(flow.state.brief.started, false);
  }
});

test("an unstarted draft follows the calendar; a started release keeps its day", (t) => {
  const stored = (started) => memoryStorage({
    [RELEASE_FLOW_STORAGE_KEY]: JSON.stringify({ schema: RELEASE_FLOW_SCHEMA, brief: { platformId: "douyin", date: "2026-10-20", started } }),
  });
  const draft = createFlow(t, { storage: stored(false) });
  assert.equal(draft.state.brief.date, "2026-10-24");
  assert.equal(draft.state.brief.platformId, "douyin");
  const started = createFlow(t, { storage: stored(true) });
  assert.equal(started.state.brief.date, "2026-10-20");
});
