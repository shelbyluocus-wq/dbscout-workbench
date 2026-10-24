import assert from "node:assert/strict";
import { test } from "node:test";
import { useReleaseFlow } from "./composables/useReleaseFlow.js";
import { RELEASE_FLOW_STORAGE_KEY } from "./releaseFlowState.js";

const NOW = new Date(2026, 9, 24, 9, 30);
const TEMPLATES = [{ id: "juesheng-2", name: "决胜2", scriptPath: "D:\\tools\\gen.bat", projectRoot: "D:\\release\\tw\\client" }];

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), data };
}

function cancelled() {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

const immediate = (ms, signal) => (signal?.aborted ? Promise.reject(cancelled()) : Promise.resolve());

function createFlow(options = {}) {
  return useReleaseFlow({ storage: memoryStorage(), sleep: immediate, now: () => NOW, templates: () => TEMPLATES, ...options });
}

async function runAll(flow, ids) {
  for (const id of ids) assert.equal(await flow.runTask(id), true, id);
}

const CLIENT_TASKS = ["client.sync", "client.transfer", "client.diff", "build.cocos"];
const GM_TASKS = [
  "gm.activityUpload", "gm.activityCurrent", "gm.clientUpload", "gm.serverUpload", "gm.serverCurrent",
  "gm.maintenance", "gm.clientOpen", "gm.restart", "gm.open",
];

test("a maintenance release runs from the brief to the open servers", async () => {
  const storage = memoryStorage();
  const flow = createFlow({ storage });
  assert.equal(flow.state.brief.platformId, "tw");
  assert.equal(flow.state.brief.date, "2026-10-24");
  assert.equal(flow.canStart.value, false);
  assert.equal(await flow.runTask("db.sync"), false, "nothing runs before the release starts");

  flow.setPrepared(true);
  assert.equal(flow.start(), true);
  assert.equal(flow.state.page, "dbSync");
  assert.equal(await flow.runTask("db.plans"), false, "the plan waits for the overwrite");

  await runAll(flow, ["db.sync"]);
  assert.match(flow.state.tasks["db.sync"].result.snapshot, /game_config_tw/);
  // Development opens everything, so the plan closes what is not due yet.
  assert.deepEqual({ ...flow.planCounts.value }, { open: 0, close: 13, keep: 16, skip: 1 });
  await runAll(flow, ["db.plans"]);
  assert.equal(flow.state.tasks["db.plans"].result.close, 13);
  assert.equal(Object.keys(flow.state.tasks["db.plans"].result.written).length, 13);
  assert.deepEqual({ ...flow.planCounts.value }, { open: 0, close: 0, keep: 29, skip: 1 });

  await runAll(flow, ["client.svn"]);
  assert.equal(flow.state.tasks["client.svn"].status, "attention");
  assert.equal(flow.svnConflicts.value.length, 2);
  assert.equal(await flow.runTask("client.sync"), false, "conflicts block the copy");
  assert.equal(await flow.resolveConflicts(), false, "every conflict needs a choice");
  flow.setConflictChoice(flow.svnConflicts.value[0].path, "theirs");
  flow.setConflictChoice(flow.svnConflicts.value[1].path, "manual");
  assert.equal(await flow.resolveConflicts(), true);
  assert.equal(flow.state.tasks["client.svn"].status, "done");
  assert.deepEqual(flow.state.tasks["client.svn"].result.choices, ["theirs", "manual"]);
  assert.ok(flow.state.tasks["client.svn"].logs.some((line) => line.text.includes("--accept working")));

  await runAll(flow, [...CLIENT_TASKS, ...GM_TASKS]);
  assert.equal(flow.state.tasks["build.cocos"].result.exitCode, 36);
  assert.equal(flow.state.tasks["gm.clientUpload"].result.file, "client_tw_web-mobile_20261024.zip");
  assert.equal(flow.complete.value, true);
  assert.deepEqual(flow.progressSummary.value, { done: 16, total: 16 });
  flow.dispose();

  const reopened = useReleaseFlow({ storage, sleep: immediate, now: () => NOW });
  assert.equal(reopened.complete.value, true);
  assert.equal(reopened.state.tasks["gm.open"].status, "done");
  assert.ok(reopened.state.history.some((entry) => entry.event === "started"), "the summary still knows when the release began");
  reopened.dispose();
});

test("editing a written plan marks the write stale and only the edited row changes", async () => {
  const flow = createFlow();
  flow.setPrepared(true);
  flow.start();
  await runAll(flow, ["db.sync", "db.plans"]);
  flow.setNote("hero-1015", "tw", "已開放");
  assert.equal(flow.state.tasks["db.plans"].status, "idle");
  assert.equal(flow.state.tasks["db.plans"].stale, true);
  assert.deepEqual({ ...flow.planCounts.value }, { open: 1, close: 0, keep: 28, skip: 1 });
  // Another platform's note does not touch this release.
  flow.setNote("hero-1016", "cn", "暫不開放");
  assert.deepEqual({ ...flow.planCounts.value }, { open: 1, close: 0, keep: 28, skip: 1 });
  // Overwriting again brings development values back into synced tables.
  await runAll(flow, ["db.sync"]);
  assert.equal(flow.planCounts.value.close, 12);
  flow.dispose();
});

test("keeping the plan tables out of the overwrite starts from the platform's own flags", () => {
  const flow = createFlow();
  flow.setSyncExclusions([...flow.syncExclusions.value, "hero", "mount", "spirit", "battle_pet", "function_open"]);
  assert.equal(flow.planGroups.value.every((group) => !group.synced), true);
  assert.deepEqual({ ...flow.planCounts.value }, { open: 8, close: 1, keep: 20, skip: 1 });
  flow.dispose();
});

test("rerunning finished work resets what was built on it", async () => {
  const flow = createFlow();
  flow.setPrepared(true);
  flow.start();
  flow.setDemoOption("conflicts", false);
  await runAll(flow, ["client.svn", "client.sync", "client.transfer"]);
  assert.equal(flow.state.tasks["client.svn"].status, "done");
  flow.setFileRules([...flow.fileRules.value, "*.meta"]);
  assert.equal(flow.state.tasks["client.sync"].status, "idle");
  assert.equal(flow.state.tasks["client.transfer"].status, "idle");
  assert.equal(flow.state.tasks["client.svn"].status, "done");
  await runAll(flow, ["client.sync"]);
  assert.equal(flow.state.tasks["client.sync"].result.excluded, 14);
  await runAll(flow, ["client.svn"]);
  assert.equal(flow.state.tasks["client.sync"].status, "idle");
  flow.dispose();
});

test("a skipped conversion still lets the diff review run", async () => {
  const flow = createFlow();
  flow.setPrepared(true);
  flow.start();
  flow.setDemoOption("conflicts", false);
  await runAll(flow, ["client.svn", "client.sync"]);
  assert.equal(flow.skipTask("client.diff"), false, "only optional steps can be skipped");
  assert.equal(flow.skipTask("client.transfer"), true);
  assert.equal(flow.state.tasks["client.transfer"].status, "skipped");
  await runAll(flow, ["client.diff"]);
  flow.dispose();
});

test("a stopped run returns to idle and says so in its log", async () => {
  let release;
  const blocking = (ms, signal) => new Promise((resolve, reject) => {
    release = resolve;
    signal.addEventListener("abort", () => reject(cancelled()), { once: true });
  });
  const flow = createFlow({ sleep: blocking });
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
  flow.dispose();
});

test("the demo's first Cocos build can fail with exit code 34 and succeed on retry", async () => {
  const flow = createFlow();
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
  flow.dispose();
});

test("a no-downtime release reloads activities instead of restarting", async () => {
  const flow = createFlow();
  assert.equal(flow.setMode("hot"), true);
  assert.equal(flow.state.brief.scope.server, false);
  assert.equal(flow.setScope("server", true), false, "server versions need a restart");
  assert.equal(flow.applies("gm.activityReload"), true);
  assert.equal(flow.applies("gm.restart"), false);
  flow.setScope("database", false);
  flow.setScope("client", false);
  flow.setPrepared(true);
  flow.start();
  assert.equal(flow.state.page, "gmUpload");
  await runAll(flow, ["gm.activityUpload", "gm.activityCurrent", "gm.activityReload"]);
  assert.equal(flow.complete.value, true);
  flow.dispose();
});

test("changing the date shifts the schedule and resets date-bound work", async () => {
  const flow = createFlow();
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
  flow.dispose();
});

test("a corrupt or foreign saved flow falls back to the sample release", () => {
  for (const raw of ["{", JSON.stringify({ schema: 99 }), JSON.stringify([1, 2])]) {
    const flow = createFlow({ storage: memoryStorage({ [RELEASE_FLOW_STORAGE_KEY]: raw }) });
    assert.equal(flow.state.platforms.length, 3);
    assert.equal(flow.state.brief.started, false);
    flow.dispose();
  }
});

test("an unstarted draft follows the calendar; a started release keeps its day", () => {
  const stored = (started) => memoryStorage({
    [RELEASE_FLOW_STORAGE_KEY]: JSON.stringify({ schema: 1, brief: { platformId: "cn", date: "2026-10-20", started } }),
  });
  const draft = createFlow({ storage: stored(false) });
  assert.equal(draft.state.brief.date, "2026-10-24");
  assert.equal(draft.state.brief.platformId, "cn");
  draft.dispose();
  const started = createFlow({ storage: stored(true) });
  assert.equal(started.state.brief.date, "2026-10-20");
  started.dispose();
});
