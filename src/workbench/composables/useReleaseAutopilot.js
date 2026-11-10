import { computed, watch } from "vue";
import { RELEASE_TASK_BY_ID, TASK_STATUS } from "../releaseFlowState.js";
import { appendAutopilotLog, idleAutopilot, nextAutopilotStep } from "../releaseAutopilotState.js";

/**
 * One-click mode of one update: runs every step in guide order and settles
 * what it meets by the workspace's rules (releaseAutopilotState.js), pausing
 * where a rule says a person decides. It drives the update through the same
 * actions a person uses, so the steps keep their confirmations' effects,
 * logs, history and resets. Waiting is cheap: nothing runs between steps but
 * a watch on the update.
 */
export function createAutopilot({ flow, rules, sleep, speed = () => 1, now = () => new Date() }) {
  const state = flow.state;
  let controller = null;
  let ticking = false;
  let disposed = false;

  if (!state.autopilot) state.autopilot = idleAutopilot();
  const auto = () => state.autopilot;
  const status = computed(() => auto().status);
  const active = computed(() => status.value === "running");

  function log(kind, extra = {}) {
    appendAutopilotLog(auto(), { at: now().getTime(), kind, ...extra });
  }

  function snapshot() {
    return {
      brief: state.brief,
      tasks: state.tasks,
      rules: rules(),
      auto: auto(),
      planNotes: flow.planNotesLeft.value,
      canStart: flow.canStart.value,
    };
  }

  // What one-click mode would do now, for the bar above the page.
  const next = computed(() => (state.outcome ? { kind: "done" } : nextAutopilotStep(snapshot())));

  function abortWait() {
    controller?.abort();
    controller = null;
    auto().retryAt = 0;
  }

  function start() {
    if (state.outcome || active.value) return false;
    if (!state.brief.started && !flow.canStart.value) return false;
    state.autopilot = { ...idleAutopilot(), status: "running", startedAt: now().getTime(), log: auto().log };
    log("started");
    queueTick();
    return true;
  }

  function pause(reason = "stopped", taskId = "") {
    if (!active.value) return false;
    abortWait();
    Object.assign(auto(), { status: "paused", reason, taskId });
    log("paused", { taskId, detail: reason });
    return true;
  }

  /** Go on after a pause: the step it stopped at may now pass, a failed one is retried afresh. */
  function resume() {
    const current = auto();
    if (current.status !== "paused" || state.outcome) return false;
    if (current.taskId && !current.acknowledged.includes(current.taskId)) current.acknowledged.push(current.taskId);
    if (current.reason === "failed") delete current.retries[current.taskId];
    Object.assign(current, { status: "running", reason: "", taskId: "" });
    log("resumed");
    queueTick();
    return true;
  }

  /** Leave one-click mode; the update goes on by hand from where it is. */
  function stop() {
    if (auto().status !== "running" && auto().status !== "paused") return false;
    abortWait();
    Object.assign(auto(), { status: "off", reason: "", taskId: "" });
    log("stopped");
    return true;
  }

  function follow(taskId) {
    const page = RELEASE_TASK_BY_ID.get(taskId)?.page;
    if (page) flow.go(page);
  }

  async function runStep(taskId) {
    follow(taskId);
    const ran = await flow.runTask(taskId);
    // A step that could not even start would be offered again forever.
    if (!ran && state.tasks[taskId].status === TASK_STATUS.IDLE && active.value) pause("blocked", taskId);
  }

  async function perform(action) {
    if (action.kind === "start") {
      if (!flow.start()) pause("notReady");
      return;
    }
    if (action.kind === "run") return runStep(action.taskId);
    if (action.kind === "retry") {
      const current = auto();
      current.retries[action.taskId] = action.attempt;
      const delay = Math.max(0, rules().retryDelay * 1000 * speed());
      current.retryAt = now().getTime() + delay;
      log("retry", { taskId: action.taskId, detail: String(action.attempt) });
      follow(action.taskId);
      const waiting = new AbortController();
      controller = waiting;
      try {
        await sleep(delay, waiting.signal);
      } catch {
        return;
      } finally {
        if (controller === waiting) controller = null;
        current.retryAt = 0;
      }
      if (active.value) await runStep(action.taskId);
      return;
    }
    if (action.kind === "resolve") {
      follow("client.svn");
      const count = flow.svnConflicts.value.length;
      flow.setAllConflictChoices(action.choice);
      if (await flow.resolveConflicts()) log("resolved", { taskId: "client.svn", detail: `${action.choice}:${count}` });
      else pause("conflicts", "client.svn");
      return;
    }
    if (action.kind === "skip") {
      if (flow.skipTask(action.taskId)) log("skipped", { taskId: action.taskId });
      else pause("failed", action.taskId);
      return;
    }
  }

  async function tick() {
    if (ticking || disposed || !active.value) return;
    ticking = true;
    try {
      // Each action changes the update; a bound keeps a bug from spinning.
      for (let guard = 0; guard < 200 && active.value && !flow.busy.value; guard += 1) {
        const action = nextAutopilotStep(snapshot());
        if (action.kind === "wait") return;
        if (action.kind === "done") {
          Object.assign(auto(), { status: "done", reason: "", taskId: "" });
          log("done");
          return;
        }
        if (action.kind === "pause") {
          pause(action.reason, action.taskId);
          return;
        }
        await perform(action);
      }
    } finally {
      ticking = false;
    }
  }

  function queueTick() {
    if (!disposed) void Promise.resolve().then(tick);
  }

  const stopWatch = watch(
    [status, () => flow.runningTask.value, () => state.outcome],
    () => queueTick(),
  );
  // An update reopened while in one-click mode goes on where it was.
  if (active.value) queueTick();

  function dispose() {
    disposed = true;
    abortWait();
    stopWatch();
  }

  return {
    status,
    active,
    next,
    state: computed(() => auto()),
    start,
    pause,
    resume,
    stop,
    dispose,
  };
}
