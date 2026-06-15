const PERF_PREFIX = "[dbscout:perf]";
const SLOW_FRAME_MS = 32;

export function isPerformanceLoggingEnabled() {
  return Boolean(globalThis.__DBSCOUT_PERF_ENABLED__ || import.meta.env?.DEV) && typeof performance !== "undefined";
}

function roundedNow() {
  return Number(performance.now().toFixed(2));
}

function roundedDuration(start) {
  return Number((performance.now() - start).toFixed(2));
}

export function markPerf(label, details = {}) {
  if (!isPerformanceLoggingEnabled()) return null;
  const at = roundedNow();
  console.debug(PERF_PREFIX, label, { at, ...details });
  return at;
}

export async function measureAsync(label, action, details = {}) {
  if (!isPerformanceLoggingEnabled()) return action();
  const start = performance.now();
  try {
    const result = await action();
    console.debug(PERF_PREFIX, label, { ...details, durationMs: roundedDuration(start) });
    return result;
  } catch (error) {
    console.debug(PERF_PREFIX, `${label}:error`, {
      ...details,
      durationMs: roundedDuration(start),
      error: String(error?.message || error),
    });
    throw error;
  }
}

export function sampleNextFrame(label, details = {}) {
  if (!isPerformanceLoggingEnabled() || typeof requestAnimationFrame !== "function") return;
  const start = performance.now();
  requestAnimationFrame(() => {
    const frameDelayMs = roundedDuration(start);
    if (frameDelayMs >= SLOW_FRAME_MS) {
      console.debug(PERF_PREFIX, label, { ...details, frameDelayMs });
    }
  });
}
