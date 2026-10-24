import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELEASE_TASKS,
  TASK_STATUS,
  adjacentPage,
  applicablePages,
  applicableTasks,
  createReleaseBrief,
  dependentsOf,
  flowProgress,
  idleTaskState,
  invalidateTasks,
  missingDependencies,
  nextTaskOnPage,
  pageStatus,
  restoreBrief,
  restoreTasks,
  taskBlocker,
} from "./releaseFlowState.js";

function tasksWith(statuses = {}) {
  const tasks = {};
  for (const definition of RELEASE_TASKS) tasks[definition.id] = { ...idleTaskState(), status: statuses[definition.id] || TASK_STATUS.IDLE };
  return tasks;
}

function startedBrief(patch = {}) {
  return { ...createReleaseBrief("tw", "2026-10-24"), started: true, prepared: true, ...patch };
}

test("a maintenance release with everything in scope runs every task except the hot-update reload", () => {
  const ids = applicableTasks(startedBrief()).map((definition) => definition.id);
  assert.ok(!ids.includes("gm.activityReload"));
  assert.ok(ids.includes("gm.restart") && ids.includes("gm.open") && ids.includes("gm.maintenance"));
  assert.equal(ids.length, RELEASE_TASKS.length - 1);
});

test("a no-downtime release reloads activities and skips maintenance, restart and server", () => {
  const brief = startedBrief({ mode: "hot", scope: { database: true, client: true, server: false, activity: true } });
  const ids = applicableTasks(brief).map((definition) => definition.id);
  assert.ok(ids.includes("gm.activityReload"));
  for (const id of ["gm.maintenance", "gm.restart", "gm.open", "gm.serverUpload", "gm.serverCurrent"]) assert.ok(!ids.includes(id), id);
  assert.deepEqual(
    applicablePages(brief).map((entry) => entry.id),
    ["overview", "dbSync", "dbPlans", "clientSvn", "clientSync", "clientTransfer", "clientDiff", "build", "gmUpload", "gmSchedule", "summary"],
  );
});

test("content left out of the release removes its pages", () => {
  const brief = startedBrief({ scope: { database: false, client: false, server: true, activity: false } });
  assert.deepEqual(
    applicablePages(brief).map((entry) => entry.id),
    ["overview", "gmUpload", "gmSchedule", "gmLaunch", "summary"],
  );
  assert.equal(adjacentPage("overview", brief, 1), "gmUpload");
  assert.equal(adjacentPage("gmLaunch", brief, 1), "summary");
});

test("a task waits for its applicable dependencies and the start of the release", () => {
  const brief = startedBrief();
  const tasks = tasksWith();
  assert.equal(taskBlocker("db.sync", tasks, { ...brief, started: false }), "notStarted");
  assert.equal(taskBlocker("db.sync", tasks, brief), "");
  assert.equal(taskBlocker("db.plans", tasks, brief), "dependency");
  assert.deepEqual(missingDependencies("gm.restart", tasks, brief), ["db.plans", "gm.activityCurrent", "gm.serverCurrent", "gm.maintenance"]);
  // Dependencies outside the release do not block.
  const serverOnly = startedBrief({ scope: { database: false, client: false, server: true, activity: false } });
  assert.deepEqual(missingDependencies("gm.restart", tasks, serverOnly), ["gm.serverCurrent", "gm.maintenance"]);
  tasks["db.sync"].status = TASK_STATUS.RUNNING;
  assert.equal(taskBlocker("client.svn", tasks, brief), "busy");
  assert.equal(taskBlocker("db.sync", tasks, brief), "running");
});

test("skipped dependencies count as settled", () => {
  const brief = startedBrief();
  const tasks = tasksWith({ "client.svn": "done", "client.sync": "done", "client.transfer": "skipped" });
  assert.equal(taskBlocker("client.diff", tasks, brief), "");
});

test("invalidating a task resets everything built on it and marks it stale", () => {
  assert.deepEqual(dependentsOf("client.svn").sort(), [
    "build.cocos", "client.diff", "client.sync", "client.transfer", "gm.clientOpen", "gm.clientUpload", "gm.open",
  ].sort());
  const tasks = tasksWith({ "client.svn": "done", "client.sync": "done", "client.transfer": "done", "db.sync": "done" });
  const reset = invalidateTasks(tasks, ["client.sync"]);
  assert.deepEqual(reset, ["client.sync", "client.transfer"]);
  assert.equal(tasks["client.svn"].status, "done");
  assert.equal(tasks["client.sync"].status, "idle");
  assert.equal(tasks["client.sync"].stale, true);
  assert.equal(tasks["db.sync"].status, "done");
  assert.deepEqual(invalidateTasks(tasks, ["client.svn"], { includeRoots: false }), []);
});

test("page status summarises its applicable tasks", () => {
  const brief = startedBrief();
  assert.equal(pageStatus("gmUpload", tasksWith(), brief), "pending");
  assert.equal(pageStatus("gmUpload", tasksWith({ "gm.activityUpload": "done" }), brief), "partial");
  assert.equal(pageStatus("clientSvn", tasksWith({ "client.svn": "attention" }), brief), "attention");
  assert.equal(pageStatus("clientTransfer", tasksWith({ "client.transfer": "skipped" }), brief), "skipped");
  assert.equal(pageStatus("gmLaunch", tasksWith(), { ...brief, mode: "hot" }), "notApplicable");
  assert.equal(nextTaskOnPage("gmUpload", tasksWith({ "gm.activityUpload": "done" }), brief), "gm.activityCurrent");
  const done = tasksWith(Object.fromEntries(RELEASE_TASKS.map((definition) => [definition.id, "done"])));
  assert.deepEqual(flowProgress(done, brief), { done: 16, total: 16 });
  assert.equal(pageStatus("summary", done, brief), "done");
});

test("restored progress never keeps a running task or an unsupported success", () => {
  const brief = startedBrief();
  const tasks = restoreTasks({
    "client.svn": { status: "done", result: { revision: 1 } },
    "client.sync": { status: "running" },
    "build.cocos": { status: "done" },
    "db.sync": { status: "bogus" },
  }, brief);
  assert.equal(tasks["client.svn"].status, "done");
  assert.equal(tasks["client.sync"].status, "failed");
  assert.equal(tasks["client.sync"].error, "interrupted");
  assert.equal(tasks["build.cocos"].status, "idle");
  assert.equal(tasks["build.cocos"].stale, true);
  assert.equal(tasks["db.sync"].status, "idle");
});

test("a restored brief keeps only known values", () => {
  const fallback = createReleaseBrief("tw", "2026-10-24");
  const brief = restoreBrief({ platformId: "sea", date: "nope", mode: "party", scope: { server: false, extra: true }, started: "yes" }, fallback);
  assert.equal(brief.platformId, "sea");
  assert.equal(brief.date, "2026-10-24");
  assert.equal(brief.mode, "maintenance");
  assert.deepEqual(brief.scope, { database: true, client: true, server: false, activity: true });
  assert.equal(brief.started, false);
});
