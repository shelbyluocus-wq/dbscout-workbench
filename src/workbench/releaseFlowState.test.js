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
  flowComplete,
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
  return Object.fromEntries(RELEASE_TASKS.map((definition) => [
    definition.id, { ...idleTaskState(), status: statuses[definition.id] || TASK_STATUS.IDLE },
  ]));
}

function startedBrief(patch = {}) {
  return { ...createReleaseBrief("2026-10-24"), started: true, prepared: true, ...patch };
}

test("the release contains only database and client preparation, ending at the build", () => {
  assert.deepEqual(applicableTasks(startedBrief()).map((definition) => definition.id), [
    "db.sync", "db.plans", "client.svn", "client.sync", "client.transfer", "client.diff", "build.cocos",
  ]);
  assert.deepEqual(applicablePages(startedBrief()).map((entry) => entry.id), [
    "brief", "database", "clientSvn", "clientSync", "clientTransfer", "clientDiff", "build", "summary",
  ]);
  assert.equal(adjacentPage("build", startedBrief(), 1), "summary");
  assert.equal(pageApplies("gmServer", startedBrief()), false);
  assert.equal(taskBlocker("gm.open", tasksWith(), startedBrief()), "notApplicable");
});

test("restoring the database is an action: it waits for nothing and nothing waits for it", () => {
  const brief = startedBrief();
  assert.deepEqual(RELEASE_TASKS.filter((definition) => definition.action).map((definition) => definition.id), ["db.restore"]);
  assert.equal(taskBlocker("db.restore", tasksWith(), brief), "");
  assert.deepEqual(dependentsOf("db.restore"), []);
  assert.deepEqual(dependentsOf("db.sync"), ["db.plans"]);
  const tasks = tasksWith({ "db.sync": "done", "db.plans": "done" });
  assert.equal(pageStatus("database", tasks, brief), "done");
  assert.equal(nextTaskOnPage("database", tasks, brief), "");
  tasks["db.restore"].status = TASK_STATUS.RUNNING;
  assert.equal(taskBlocker("client.svn", tasks, brief), "busy");
});

test("content left out of the release removes its pages and an empty scope cannot complete", () => {
  const brief = startedBrief({ scope: { database: true, client: false } });
  assert.deepEqual(applicablePages(brief).map((entry) => entry.id), ["brief", "database", "summary"]);
  assert.equal(adjacentPage("brief", brief, 1), "database");
  assert.equal(adjacentPage("database", brief, 1), "summary");
  const empty = startedBrief({ scope: { database: false, client: false } });
  assert.deepEqual(applicablePages(empty).map((entry) => entry.id), ["brief", "summary"]);
  assert.equal(flowComplete(tasksWith(), empty), false);
});

test("a task waits for its dependencies and the start of the release", () => {
  const brief = startedBrief();
  const tasks = tasksWith();
  assert.equal(taskBlocker("db.sync", tasks, { ...brief, started: false }), "notStarted");
  assert.equal(taskBlocker("db.sync", tasks, brief), "");
  assert.equal(taskBlocker("db.plans", tasks, brief), "dependency");
  assert.deepEqual(missingDependencies("build.cocos", tasks, brief), ["client.diff"]);
  tasks["db.sync"].status = TASK_STATUS.RUNNING;
  assert.equal(taskBlocker("client.svn", tasks, brief), "busy");
  assert.equal(taskBlocker("db.sync", tasks, brief), "running");
});

test("skipped conversion permits the diff review", () => {
  const tasks = tasksWith({ "client.svn": "done", "client.sync": "done", "client.transfer": "skipped" });
  assert.equal(taskBlocker("client.diff", tasks, startedBrief()), "");
});

test("invalidating a task resets only the retained work built on it", () => {
  assert.deepEqual(dependentsOf("client.svn").sort(), ["build.cocos", "client.diff", "client.sync", "client.transfer"]);
  const tasks = tasksWith({ "client.svn": "done", "client.sync": "done", "client.transfer": "done", "db.sync": "done" });
  assert.deepEqual(invalidateTasks(tasks, ["client.sync"]), ["client.sync", "client.transfer"]);
  assert.equal(tasks["client.svn"].status, "done");
  assert.equal(tasks["client.sync"].status, "idle");
  assert.equal(tasks["client.sync"].stale, true);
  assert.equal(tasks["db.sync"].status, "done");
  assert.deepEqual(invalidateTasks(tasks, ["client.svn"], { includeRoots: false }), []);
});

test("page status and progress count seven retained steps, never the restore action", () => {
  const brief = startedBrief();
  assert.equal(pageStatus("database", tasksWith(), brief), "pending");
  assert.equal(pageStatus("database", tasksWith({ "db.sync": "done" }), brief), "partial");
  assert.equal(nextTaskOnPage("database", tasksWith({ "db.sync": "done" }), brief), "db.plans");
  assert.equal(pageStatus("clientSvn", tasksWith({ "client.svn": "attention" }), brief), "attention");
  assert.equal(pageStatus("clientTransfer", tasksWith({ "client.transfer": "skipped" }), brief), "skipped");
  const done = tasksWith(Object.fromEntries(RELEASE_TASKS.map((definition) => [definition.id, "done"])));
  assert.deepEqual(flowProgress(done, brief), { done: 7, total: 7 });
  assert.equal(pageStatus("brief", done, brief), "done");
  assert.equal(pageStatus("summary", done, brief), "done");
});

test("restoring progress drops removed tasks and rejects interrupted or unsupported successes", () => {
  const tasks = restoreTasks({
    "client.svn": { status: "done", result: { revision: 1 } },
    "client.sync": { status: "running" },
    "build.cocos": { status: "done" },
    "db.sync": { status: "bogus" },
    "gm.shutdown": { status: "running" },
    "gm.open": { status: "done" },
  }, startedBrief());
  assert.equal(tasks["client.svn"].status, "done");
  assert.equal(tasks["client.sync"].status, "failed");
  assert.equal(tasks["client.sync"].error, "interrupted");
  assert.equal(tasks["build.cocos"].status, "idle");
  assert.equal(tasks["build.cocos"].stale, true);
  assert.equal(tasks["db.sync"].status, "idle");
  assert.deepEqual(Object.keys(tasks), RELEASE_TASKS.map((task) => task.id));
});

test("a restored brief drops old modes and server or activity scope", () => {
  const brief = restoreBrief({
    platformId: "sea", date: "nope", mode: "maintenance",
    scope: { database: false, server: true, activity: true, extra: true }, started: "yes",
  }, createReleaseBrief("2026-10-24"));
  assert.deepEqual(brief, {
    date: "2026-10-24", scope: { database: false, client: true }, prepared: false, started: false,
  });
});
