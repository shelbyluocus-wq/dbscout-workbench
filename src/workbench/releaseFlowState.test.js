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
  pageApplies,
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
  return { ...createReleaseBrief("2026-10-24"), started: true, prepared: true, ...patch };
}

test("a maintenance release with everything in scope runs every step except the hot-update reloads", () => {
  const ids = applicableTasks(startedBrief()).map((definition) => definition.id);
  assert.ok(!ids.includes("gm.activityReload"));
  assert.ok(!ids.includes("gm.configReload"));
  for (const id of ["gm.maintenance", "gm.shutdown", "gm.serverApply", "gm.configApply", "gm.restart", "gm.open"]) assert.ok(ids.includes(id), id);
  // Restoring the database is an action beside the steps, never one of them.
  assert.ok(!ids.includes("db.restore"));
  assert.equal(ids.length, RELEASE_TASKS.length - 3);
});

test("everything the GM can prepare while the servers run comes before the maintenance", () => {
  const brief = startedBrief();
  const prepared = ["gm.configPack", "gm.activityCurrent", "gm.clientPush", "gm.serverPush"];
  assert.deepEqual(missingDependencies("gm.maintenance", tasksWith(), brief), prepared);
  // Applying waits for the servers to close; the start waits for what is applied.
  assert.deepEqual(missingDependencies("gm.serverApply", tasksWith({ "gm.serverPush": "done" }), brief), ["gm.shutdown"]);
  assert.deepEqual(missingDependencies("gm.configApply", tasksWith({ "gm.configPack": "done" }), brief), ["gm.shutdown"]);
  // Without downtime the config version is applied and reloaded right away.
  const hot = startedBrief({ mode: "hot", scope: { database: true, client: false, server: false, activity: false } });
  assert.deepEqual(applicableTasks(hot).map((definition) => definition.id), ["db.sync", "db.plans", "gm.configPack", "gm.configApply", "gm.configReload"]);
  assert.equal(taskBlocker("gm.configApply", tasksWith({ "db.sync": "done", "db.plans": "done", "gm.configPack": "done" }), hot), "");
});

test("restoring the database is an action: it waits for nothing and nothing waits for it", () => {
  const brief = startedBrief();
  assert.deepEqual(RELEASE_TASKS.filter((definition) => definition.action).map((definition) => definition.id), ["db.restore"]);
  assert.equal(taskBlocker("db.restore", tasksWith(), brief), "");
  assert.deepEqual(dependentsOf("db.restore"), []);
  assert.ok(!dependentsOf("db.sync").includes("db.restore"));
  // It neither counts toward progress nor keeps the database page from being done.
  const tasks = tasksWith({ "db.sync": "done", "db.plans": "done" });
  assert.equal(pageStatus("database", tasks, brief), "done");
  assert.equal(nextTaskOnPage("database", tasks, brief), "");
  tasks["db.restore"].status = TASK_STATUS.RUNNING;
  assert.equal(taskBlocker("client.svn", tasks, brief), "busy");
});

test("the shutdown is the only task nobody starts: it follows the scheduled maintenance", () => {
  assert.deepEqual(RELEASE_TASKS.filter((definition) => definition.auto).map((definition) => definition.id), ["gm.shutdown"]);
  const brief = startedBrief();
  assert.equal(taskBlocker("gm.shutdown", tasksWith(), brief), "dependency");
  assert.equal(taskBlocker("gm.shutdown", tasksWith({ "gm.maintenance": "done" }), brief), "");
  assert.equal(taskBlocker("gm.restart", tasksWith({ "gm.maintenance": "done" }), brief), "dependency");
});

test("a no-downtime release reloads activities and skips maintenance, restart and server", () => {
  const brief = startedBrief({ mode: "hot", scope: { database: true, client: true, server: false, activity: true } });
  const ids = applicableTasks(brief).map((definition) => definition.id);
  assert.ok(ids.includes("gm.activityReload"));
  assert.ok(ids.includes("gm.configReload"));
  for (const id of ["gm.maintenance", "gm.shutdown", "gm.restart", "gm.open", "gm.serverBuild", "gm.serverPush", "gm.serverApply"]) assert.ok(!ids.includes(id), id);
  assert.deepEqual(
    applicablePages(brief).map((entry) => entry.id),
    ["brief", "database", "clientSvn", "clientSync", "clientTransfer", "clientDiff", "build", "gmUpload", "gmServer", "summary"],
  );
  // Without the client or the database there is nothing to apply or open later, so no server page.
  assert.equal(pageApplies("gmServer", { ...brief, scope: { ...brief.scope, client: false } }), true);
  assert.equal(pageApplies("gmServer", { ...brief, scope: { ...brief.scope, client: false, database: false } }), false);
});

test("content left out of the release removes its pages", () => {
  const brief = startedBrief({ scope: { database: false, client: false, server: true, activity: false } });
  assert.deepEqual(
    applicablePages(brief).map((entry) => entry.id),
    ["brief", "gmUpload", "gmServer", "summary"],
  );
  assert.equal(adjacentPage("brief", brief, 1), "gmUpload");
  assert.equal(adjacentPage("gmServer", brief, 1), "summary");
});

test("a task waits for its applicable dependencies and the start of the release", () => {
  const brief = startedBrief();
  const tasks = tasksWith();
  assert.equal(taskBlocker("db.sync", tasks, { ...brief, started: false }), "notStarted");
  assert.equal(taskBlocker("db.sync", tasks, brief), "");
  assert.equal(taskBlocker("db.plans", tasks, brief), "dependency");
  assert.deepEqual(missingDependencies("gm.restart", tasks, brief), ["gm.shutdown", "gm.serverApply", "gm.configApply", "gm.activityCurrent"]);
  // Dependencies outside the release do not block.
  const serverOnly = startedBrief({ scope: { database: false, client: false, server: true, activity: false } });
  assert.deepEqual(missingDependencies("gm.restart", tasks, serverOnly), ["gm.shutdown", "gm.serverApply"]);
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
  // The maintenance waits for the hot update, so everything after it is built on the client too.
  assert.deepEqual(dependentsOf("client.svn").sort(), [
    "build.cocos", "client.diff", "client.sync", "client.transfer", "gm.clientOpen", "gm.clientPull", "gm.clientPush",
    "gm.clientUpload", "gm.configApply", "gm.configReload", "gm.maintenance", "gm.open", "gm.restart", "gm.serverApply", "gm.shutdown",
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
  assert.equal(pageStatus("gmServer", tasksWith(), { ...brief, mode: "hot", scope: { ...brief.scope, client: false, database: false } }), "notApplicable");
  assert.equal(pageStatus("gmServer", tasksWith({ "gm.maintenance": "done" }), brief), "partial");
  assert.equal(nextTaskOnPage("gmUpload", tasksWith({ "gm.activityUpload": "done" }), brief), "gm.configPack");
  assert.equal(nextTaskOnPage("gmUpload", tasksWith({ "gm.configPack": "done", "gm.activityUpload": "done" }), brief), "gm.activityCurrent");
  const done = tasksWith(Object.fromEntries(RELEASE_TASKS.map((definition) => [definition.id, "done"])));
  assert.deepEqual(flowProgress(done, brief), { done: 22, total: 22 });
  assert.equal(pageStatus("brief", done, brief), "done");
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
  const fallback = createReleaseBrief("2026-10-24");
  const brief = restoreBrief({ platformId: "sea", date: "nope", mode: "party", scope: { server: false, extra: true }, started: "yes" }, fallback);
  // The platform belongs to the update, not to its brief.
  assert.equal("platformId" in brief, false);
  assert.equal(brief.date, "2026-10-24");
  assert.equal(brief.mode, "maintenance");
  assert.deepEqual(brief.scope, { database: true, client: true, server: false, activity: true });
  assert.equal(brief.started, false);
});
