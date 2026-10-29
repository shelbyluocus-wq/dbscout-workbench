import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASE_TASKS, TASK_STATUS, createReleaseBrief, idleTaskState } from "./releaseFlowState.js";
import {
  AUTOPILOT_RULES,
  defaultAutopilotRules,
  idleAutopilot,
  nextAutopilotStep,
  restoreAutopilot,
  restoreAutopilotRules,
} from "./releaseAutopilotState.js";

function tasksWith(statuses = {}, patches = {}) {
  const tasks = {};
  for (const definition of RELEASE_TASKS) {
    tasks[definition.id] = { ...idleTaskState(), status: statuses[definition.id] || TASK_STATUS.IDLE, ...patches[definition.id] };
  }
  return tasks;
}

const ALL_DONE_BEFORE = (id) => {
  const ids = RELEASE_TASKS.map((definition) => definition.id);
  return Object.fromEntries(ids.slice(0, ids.indexOf(id)).map((entry) => [entry, TASK_STATUS.DONE]));
};

function decide({ statuses = {}, patches = {}, rules = {}, auto = {}, brief = {}, ...rest } = {}) {
  return nextAutopilotStep({
    brief: { ...createReleaseBrief("2026-10-24"), prepared: true, started: true, ...brief },
    tasks: tasksWith(statuses, patches),
    rules: { ...defaultAutopilotRules(), ...rules },
    auto: { ...idleAutopilot(), status: "running", ...auto },
    ...rest,
  });
}

test("an update not started yet starts first, once its files are confirmed", () => {
  assert.deepEqual(decide({ brief: { started: false }, canStart: true }), { kind: "start" });
  assert.deepEqual(decide({ brief: { started: false }, canStart: false }), { kind: "pause", reason: "notReady", taskId: "" });
});

test("steps run in guide order and the run ends when every step is settled", () => {
  assert.deepEqual(decide(), { kind: "run", taskId: "db.sync" });
  assert.deepEqual(decide({ statuses: { "db.sync": "done" } }), { kind: "run", taskId: "db.plans" });
  assert.deepEqual(decide({ statuses: { "db.sync": "running" } }), { kind: "wait", reason: "running" });
  const done = Object.fromEntries(RELEASE_TASKS.map((definition) => [definition.id, "done"]));
  assert.deepEqual(decide({ statuses: done }), { kind: "done" });
});

test("SVN conflicts are settled by the rule, or wait for the person", () => {
  const statuses = { ...ALL_DONE_BEFORE("client.svn"), "client.svn": "attention" };
  assert.deepEqual(decide({ statuses }), { kind: "pause", reason: "conflicts", taskId: "client.svn" });
  assert.deepEqual(decide({ statuses, rules: { svnConflicts: "theirs" } }), { kind: "resolve", choice: "theirs" });
  assert.deepEqual(decide({ statuses, rules: { svnConflicts: "mine" } }), { kind: "resolve", choice: "mine" });
});

test("a failed step is retried as often as the rules say, then waits for the person", () => {
  const statuses = { ...ALL_DONE_BEFORE("gm.clientUpload"), "gm.clientUpload": "failed" };
  const patches = { "gm.clientUpload": { error: "gmNetwork" } };
  assert.deepEqual(decide({ statuses, patches }), { kind: "retry", taskId: "gm.clientUpload", attempt: 1 });
  assert.deepEqual(decide({ statuses, patches, auto: { retries: { "gm.clientUpload": 1 } } }), { kind: "retry", taskId: "gm.clientUpload", attempt: 2 });
  assert.deepEqual(decide({ statuses, patches, auto: { retries: { "gm.clientUpload": 2 } } }), { kind: "pause", reason: "failed", taskId: "gm.clientUpload" });
  assert.deepEqual(decide({ statuses, patches, rules: { retries: 0 } }), { kind: "pause", reason: "failed", taskId: "gm.clientUpload" });
  // A step cut off by closing the workspace just runs again; one a retry cannot fix stops at once.
  assert.deepEqual(decide({ statuses, patches: { "gm.clientUpload": { error: "interrupted" } } }), { kind: "run", taskId: "gm.clientUpload" });
  const build = { ...ALL_DONE_BEFORE("build.cocos"), "build.cocos": "failed" };
  assert.deepEqual(decide({ statuses: build, patches: { "build.cocos": { error: "buildPrecheck" } } }), { kind: "pause", reason: "failed", taskId: "build.cocos" });
});

test("a conversion that still fails can be skipped when the rules allow it", () => {
  const statuses = { ...ALL_DONE_BEFORE("client.transfer"), "client.transfer": "failed" };
  const auto = { retries: { "client.transfer": 2 } };
  assert.equal(decide({ statuses, auto }).kind, "pause");
  assert.deepEqual(decide({ statuses, auto, rules: { transferFails: "skip" } }), { kind: "skip", taskId: "client.transfer" });
});

test("rules that stop pause before their step until the person lets it pass", () => {
  const review = ALL_DONE_BEFORE("client.diff");
  assert.deepEqual(decide({ statuses: review }), { kind: "run", taskId: "client.diff" }, "reviewed by itself by default");
  assert.deepEqual(decide({ statuses: review, rules: { diffReview: "stop" } }), { kind: "pause", reason: "review", taskId: "client.diff" });
  assert.deepEqual(decide({ statuses: review, rules: { diffReview: "stop" }, auto: { acknowledged: ["client.diff"] } }), { kind: "run", taskId: "client.diff" });

  const plans = ALL_DONE_BEFORE("db.plans");
  assert.deepEqual(decide({ statuses: plans, planNotes: 2 }), { kind: "run", taskId: "db.plans" });
  assert.deepEqual(decide({ statuses: plans, planNotes: 2, rules: { planNotes: "stop" } }), { kind: "pause", reason: "planNotes", taskId: "db.plans" });
  assert.deepEqual(decide({ statuses: plans, planNotes: 0, rules: { planNotes: "stop" } }), { kind: "run", taskId: "db.plans" });

  const sync = { ...ALL_DONE_BEFORE("client.sync"), "client.sync": "done" };
  const missing = { "client.sync": { result: { warnings: [{ code: "missing", path: "a" }] } } };
  assert.deepEqual(decide({ statuses: sync, patches: missing }), { kind: "run", taskId: "client.transfer" });
  assert.deepEqual(decide({ statuses: sync, patches: missing, rules: { missingFiles: "stop" } }), { kind: "pause", reason: "missingFiles", taskId: "client.sync" });

  const apply = { ...ALL_DONE_BEFORE("gm.configApply"), "gm.configReload": "done" };
  assert.deepEqual(decide({ statuses: apply, rules: { configApply: "stop" } }), { kind: "pause", reason: "configApply", taskId: "gm.configApply" });
  const open = ALL_DONE_BEFORE("gm.open");
  assert.deepEqual(decide({ statuses: open }), { kind: "run", taskId: "gm.open" });
  assert.deepEqual(decide({ statuses: open, rules: { openServers: "stop" } }), { kind: "pause", reason: "open", taskId: "gm.open" });
});

test("the maintenance is handed to the GM, a passed start moves or stops, and the shutdown is waited for", () => {
  const ready = ALL_DONE_BEFORE("gm.maintenance");
  assert.deepEqual(decide({ statuses: ready }), { kind: "schedule", postpone: false });
  assert.deepEqual(decide({ statuses: ready, scheduleProblem: "startPassed" }), { kind: "pause", reason: "lateStart", taskId: "gm.maintenance" });
  assert.deepEqual(decide({ statuses: ready, scheduleProblem: "startPassed", rules: { lateStart: "postpone" } }), { kind: "schedule", postpone: true });
  assert.deepEqual(decide({ statuses: ready, scheduleProblem: "endBeforeStart", rules: { lateStart: "postpone" } }), { kind: "pause", reason: "schedule", taskId: "gm.maintenance" });
  const scheduled = { ...ready, "gm.maintenance": "done", "gm.clientOpen": "done" };
  assert.deepEqual(decide({ statuses: scheduled, phase: "scheduled" }), { kind: "wait", reason: "maintenance" });
  // A shutdown the monitors did not finish is checked again like any failed step.
  const slow = { ...scheduled, "gm.shutdown": "failed" };
  assert.deepEqual(decide({ statuses: slow, patches: { "gm.shutdown": { error: "shutdownIncomplete" } }, phase: "scheduled" }), { kind: "retry", taskId: "gm.shutdown", attempt: 1 });
});

test("rules and one-click state restore to known values only", () => {
  assert.deepEqual(restoreAutopilotRules(null), defaultAutopilotRules());
  for (const rule of AUTOPILOT_RULES) assert.equal(defaultAutopilotRules()[rule.id], rule.choices[0]);
  const rules = restoreAutopilotRules({ svnConflicts: "theirs", openServers: "nope", retries: 3, retryDelay: 7 });
  assert.deepEqual([rules.svnConflicts, rules.openServers, rules.retries, rules.retryDelay], ["theirs", "auto", 3, 30]);
  const auto = restoreAutopilot({
    status: "running",
    reason: "x",
    taskId: "gm.nothing",
    acknowledged: ["client.diff", "gm.nothing"],
    retries: { "gm.clientUpload": 2, "gm.nothing": 1, "db.sync": -1 },
    retryAt: 123,
    log: [{ at: 5, kind: "retry", taskId: "gm.clientUpload", detail: 1 }, { at: 6, kind: "boom" }],
  });
  assert.deepEqual([auto.status, auto.taskId, auto.acknowledged, auto.retries, auto.retryAt], ["running", "", ["client.diff"], { "gm.clientUpload": 2 }, 0]);
  assert.deepEqual(auto.log, [{ at: 5, kind: "retry", taskId: "gm.clientUpload", detail: "1" }]);
  assert.equal(restoreAutopilot({ status: "flying" }).status, "off");
});
