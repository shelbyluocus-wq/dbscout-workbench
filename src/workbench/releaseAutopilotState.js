// One-click mode of an update: the rules a person sets in advance for what
// happens when the run meets a problem, and the decision of what the run does
// next, kept apart from the UI and from the runner (useReleaseAutopilot.js).
// The rules are the workspace's, shared by every platform; each update keeps
// its own one-click state (running, paused and why, retries, a short log).

import {
  RELEASE_TASK_BY_ID,
  TASK_STATUS,
  applicableTasks,
  missingDependencies,
  plainObject,
  statusOf,
} from "./releaseFlowState.js";

/**
 * Every rule with its choices, the first being the default. The defaults
 * stop wherever a wrong guess cannot be undone by running a step again.
 */
export const AUTOPILOT_RULES = Object.freeze([
  Object.freeze({ id: "svnConflicts", group: "client", choices: Object.freeze(["stop", "theirs", "mine"]) }),
  Object.freeze({ id: "missingFiles", group: "client", choices: Object.freeze(["continue", "stop"]) }),
  Object.freeze({ id: "transferFails", group: "client", choices: Object.freeze(["stop", "skip"]) }),
  Object.freeze({ id: "diffReview", group: "client", choices: Object.freeze(["auto", "stop"]) }),
  Object.freeze({ id: "planNotes", group: "database", choices: Object.freeze(["continue", "stop"]) }),
  Object.freeze({ id: "configApply", group: "gm", choices: Object.freeze(["auto", "stop"]) }),
  Object.freeze({ id: "lateStart", group: "gm", choices: Object.freeze(["stop", "postpone"]) }),
  Object.freeze({ id: "openServers", group: "gm", choices: Object.freeze(["auto", "stop"]) }),
]);
export const AUTOPILOT_RULE_BY_ID = new Map(AUTOPILOT_RULES.map((rule) => [rule.id, rule]));
export const AUTOPILOT_GROUPS = Object.freeze(["client", "database", "gm"]);
export const AUTOPILOT_RETRIES = Object.freeze([0, 1, 2, 3]);
export const AUTOPILOT_RETRY_DELAYS = Object.freeze([10, 30, 60, 120]);
export const AUTOPILOT_STATUSES = Object.freeze(["off", "running", "paused", "done"]);
export const AUTOPILOT_LOG_KINDS = Object.freeze([
  "started", "resumed", "paused", "stopped", "retry", "resolved", "skipped", "postponed", "done",
]);
const MAX_LOG = 40;

// Failures that running the step again cannot fix: a person has to look.
export const AUTOPILOT_NO_RETRY = Object.freeze(new Set(["buildPrecheck", "qaFindings", "noBackup", "unknownTask"]));

export function defaultAutopilotRules() {
  const rules = Object.fromEntries(AUTOPILOT_RULES.map((rule) => [rule.id, rule.choices[0]]));
  return { ...rules, retries: 2, retryDelay: 30 };
}

export function restoreAutopilotRules(saved) {
  const rules = defaultAutopilotRules();
  if (!plainObject(saved)) return rules;
  for (const rule of AUTOPILOT_RULES) if (rule.choices.includes(saved[rule.id])) rules[rule.id] = saved[rule.id];
  if (AUTOPILOT_RETRIES.includes(saved.retries)) rules.retries = saved.retries;
  if (AUTOPILOT_RETRY_DELAYS.includes(saved.retryDelay)) rules.retryDelay = saved.retryDelay;
  return rules;
}

export function idleAutopilot() {
  return { status: "off", reason: "", taskId: "", acknowledged: [], retries: {}, retryAt: 0, startedAt: 0, log: [] };
}

export function restoreAutopilot(saved) {
  const auto = idleAutopilot();
  if (!plainObject(saved)) return auto;
  if (AUTOPILOT_STATUSES.includes(saved.status)) auto.status = saved.status;
  auto.reason = typeof saved.reason === "string" ? saved.reason : "";
  auto.taskId = RELEASE_TASK_BY_ID.has(saved.taskId) ? saved.taskId : "";
  auto.acknowledged = Array.isArray(saved.acknowledged) ? saved.acknowledged.filter((id) => RELEASE_TASK_BY_ID.has(id)) : [];
  for (const [id, count] of Object.entries(saved.retries || {})) {
    if (RELEASE_TASK_BY_ID.has(id) && Number.isInteger(count) && count > 0) auto.retries[id] = count;
  }
  auto.startedAt = Number(saved.startedAt) || 0;
  auto.log = Array.isArray(saved.log)
    ? saved.log.filter((entry) => Number(entry?.at) && AUTOPILOT_LOG_KINDS.includes(entry.kind)).slice(-MAX_LOG)
      .map((entry) => ({ at: Number(entry.at), kind: entry.kind, taskId: RELEASE_TASK_BY_ID.has(entry.taskId) ? entry.taskId : "", detail: String(entry.detail || "") }))
    : [];
  // A wait for a retry does not survive closing the workspace; the retry runs on reopening.
  auto.retryAt = 0;
  return auto;
}

export function appendAutopilotLog(auto, entry) {
  auto.log.push({ taskId: "", detail: "", ...entry });
  if (auto.log.length > MAX_LOG) auto.log.splice(0, auto.log.length - MAX_LOG);
}

/** A rule that stops before (or after) a step, unless the person already let it pass. */
function gate(rules, auto, ruleId, stopChoice, taskId) {
  return rules[ruleId] === stopChoice && !auto.acknowledged.includes(taskId);
}

/**
 * What one-click mode does next for an update, from a snapshot of it:
 *
 *   { brief, tasks, rules, auto, phase, scheduleProblem, planNotes, canStart }
 *
 * `phase` is the server phase (releaseServer.js), `planNotes` how many memo
 * notes the plan step leaves to a person. Returns one of
 *
 *   { kind: "start" }                    start the update
 *   { kind: "run", taskId }              run a step
 *   { kind: "retry", taskId, attempt }   run a failed step again (after the delay)
 *   { kind: "resolve", choice }          settle the SVN conflicts with one choice
 *   { kind: "skip", taskId }             skip a step that may be skipped
 *   { kind: "schedule", postpone }       hand the schedule to the GM (moved first)
 *   { kind: "wait", reason }             nothing to do until the GM or a step moves
 *   { kind: "pause", reason, taskId }    stop and wait for the person
 *   { kind: "done" }                     every step is settled
 *
 * Steps are taken in guide order; the first one not settled decides.
 */
export function nextAutopilotStep({ brief, tasks, rules, auto, phase = "running", scheduleProblem = "", planNotes = 0, canStart = false }) {
  if (!brief.started) return canStart ? { kind: "start" } : { kind: "pause", reason: "notReady", taskId: "" };
  for (const definition of applicableTasks(brief)) {
    const id = definition.id;
    const task = tasks[id];
    const status = statusOf(tasks, id);
    if (status === TASK_STATUS.DONE) {
      // Files the sync could not find are kept as warnings on the step.
      if (id === "client.sync" && task?.result?.warnings?.length && gate(rules, auto, "missingFiles", "stop", id)) {
        return { kind: "pause", reason: "missingFiles", taskId: id };
      }
      continue;
    }
    if (status === TASK_STATUS.SKIPPED) continue;
    if (status === TASK_STATUS.RUNNING) return { kind: "wait", reason: "running" };
    if (status === TASK_STATUS.ATTENTION) {
      if (id === "client.svn" && rules.svnConflicts !== "stop") return { kind: "resolve", choice: rules.svnConflicts };
      return { kind: "pause", reason: "conflicts", taskId: id };
    }
    if (status === TASK_STATUS.FAILED) {
      // Closing the workspace cut the step off; it simply runs again.
      if (task.error === "interrupted") return { kind: "run", taskId: id };
      const used = auto.retries[id] || 0;
      if (!AUTOPILOT_NO_RETRY.has(task.error) && used < rules.retries) return { kind: "retry", taskId: id, attempt: used + 1 };
      if (definition.skippable && rules.transferFails === "skip") return { kind: "skip", taskId: id };
      return { kind: "pause", reason: "failed", taskId: id };
    }
    // Idle. Guide order follows the dependencies, so only a missing input blocks here.
    if (missingDependencies(id, tasks, brief).length) return { kind: "pause", reason: "blocked", taskId: id };
    if (id === "gm.maintenance" || (id === "gm.clientOpen" && brief.mode === "maintenance")) {
      if (scheduleProblem === "endBeforeStart") return { kind: "pause", reason: "schedule", taskId: "gm.maintenance" };
      if (scheduleProblem === "startPassed") {
        return rules.lateStart === "postpone"
          ? { kind: "schedule", postpone: true }
          : { kind: "pause", reason: "lateStart", taskId: "gm.maintenance" };
      }
      return { kind: "schedule", postpone: false };
    }
    // The monitors close the servers at the scheduled time; the flow watches for it.
    if (id === "gm.shutdown") return phase === "scheduled" ? { kind: "wait", reason: "maintenance" } : { kind: "run", taskId: id };
    if (id === "db.plans" && planNotes > 0 && gate(rules, auto, "planNotes", "stop", id)) return { kind: "pause", reason: "planNotes", taskId: id };
    if (id === "client.diff" && gate(rules, auto, "diffReview", "stop", id)) return { kind: "pause", reason: "review", taskId: id };
    if (id === "gm.configApply" && gate(rules, auto, "configApply", "stop", id)) return { kind: "pause", reason: "configApply", taskId: id };
    if (id === "gm.open" && gate(rules, auto, "openServers", "stop", id)) return { kind: "pause", reason: "open", taskId: id };
    return { kind: "run", taskId: id };
  }
  return { kind: "done" };
}
