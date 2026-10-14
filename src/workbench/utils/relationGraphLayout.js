// Where a large relation graph's layout runs: in a worker when the platform
// allows it, otherwise on the main thread a few milliseconds per frame.
// Either way the page talks to it the same way and gets positions back
// through `onPositions`. Also the session memory of laid-out graphs, so
// reopening one shows it at once instead of settling again.

const MEMORY_LIMIT = 24;
const FALLBACK_BUDGET_MS = 5;
const memory = new Map();

function defaultWorker() {
  if (typeof Worker !== "function") return null;
  return new Worker(new URL("../workers/relationGraphLayout.worker.js", import.meta.url), { type: "module" });
}

function frameScheduler() {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === "function") return { schedule: (task) => raf(task), cancel: (frame) => globalThis.cancelAnimationFrame?.(frame) };
  return { schedule: (task) => setTimeout(task, 16), cancel: (timer) => clearTimeout(timer) };
}

/**
 * `onPositions({ version, buffer, alpha, running })` receives each frame.
 * `onRestart()` asks the page to send its graph again after the worker
 * failed and the main-thread layout took over.
 */
export function createLayoutRunner({ onPositions, onRestart = () => {}, createWorker = defaultWorker } = {}) {
  let worker = null;
  let local = null;
  let loading = null;
  let disposed = false;

  function startLocal() {
    if (local || loading || disposed) return loading;
    loading = import("./forceLayout.js").then(({ createLayoutHost }) => {
      loading = null;
      if (disposed) return;
      local = createLayoutHost((message) => {
        if (!disposed) onPositions(message);
      }, { ...frameScheduler(), budgetMs: FALLBACK_BUDGET_MS });
      onRestart();
    });
    return loading;
  }

  function fallBack() {
    worker?.terminate?.();
    worker = null;
    void startLocal();
  }

  try {
    worker = createWorker();
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (event) => {
      if (!disposed) onPositions(event.data);
    };
    worker.onerror = (event) => {
      event?.preventDefault?.();
      fallBack();
    };
  } else {
    void startLocal();
  }

  function post(message) {
    if (disposed) return;
    if (worker) worker.postMessage(message);
    else local?.receive(message);
  }

  return {
    // { version, ids, seeds, radius, links, fixed, alpha, reset }
    setGraph: (graph) => post({ type: "graph", ...graph }),
    pin: (index, x, y) => post({ type: "pin", index, x, y }),
    unpin: (index) => post({ type: "unpin", index }),
    drag: (active) => post({ type: "drag", active }),
    release: (alpha) => post({ type: "release", alpha }),
    stop: () => post({ type: "stop" }),
    usesWorker: () => Boolean(worker),
    dispose() {
      post({ type: "stop" });
      disposed = true;
      worker?.terminate?.();
      worker = null;
      local?.stop();
      local = null;
    },
  };
}

// ── session memory ────────────────────────────────────────────

/** { points: Map(id → [x, y]), fixed: Map(id → [x, y]), resting } or null. */
export function recallLayout(key) {
  if (!key || !memory.has(key)) return null;
  const entry = memory.get(key);
  // Most recently used last, so the oldest goes first.
  memory.delete(key);
  memory.set(key, entry);
  return entry;
}

export function rememberLayout(key, { ids, xy, fixed = new Map(), resting = false }) {
  if (!key || !ids?.length) return;
  const points = new Map();
  for (let at = 0; at < ids.length; at += 1) points.set(ids[at], [xy[at * 2], xy[at * 2 + 1]]);
  memory.delete(key);
  memory.set(key, { points, fixed: new Map(fixed), resting });
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

export function forgetLayouts() {
  memory.clear();
}
