/**
 * Coalesce bursts of change notifications into one run.
 *
 * `schedule()` defers the task until `delayMs` passes without another
 * schedule, but never longer than `maxWaitMs` after the first pending
 * request. `flush()` runs a pending task immediately (no-op when idle unless
 * `force` is set). Used for persistence work that must not run on every
 * keystroke yet must not be postponed indefinitely.
 */
export function createCoalescedTask(run, {
  delayMs = 400,
  maxWaitMs = 2000,
  now = () => Date.now(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  let timer = null;
  let pendingSince = null;

  function clear() {
    if (timer != null) clearTimer(timer);
    timer = null;
  }

  function execute() {
    clear();
    pendingSince = null;
    run();
  }

  function schedule() {
    const current = now();
    if (pendingSince == null) pendingSince = current;
    clear();
    const remainingMaxWait = Math.max(0, pendingSince + maxWaitMs - current);
    timer = setTimer(execute, Math.min(delayMs, remainingMaxWait));
  }

  function flush({ force = false } = {}) {
    if (pendingSince == null && !force) return false;
    execute();
    return true;
  }

  function cancel() {
    clear();
    pendingSince = null;
  }

  function isPending() {
    return pendingSince != null;
  }

  return { schedule, flush, cancel, isPending };
}
