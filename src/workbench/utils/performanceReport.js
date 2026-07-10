const DEFAULT_CAPACITY = 2_000;
const SAFE_RUN_METADATA_KEYS = new Set([
  "architecture",
  "build",
  "engine",
  "environmentId",
  "platform",
  "profile",
  "sampleCount",
  "scenario",
  "version",
  "warmupCount",
]);
const SAFE_DETAIL_KEYS = new Set(["stage"]);
const SAFE_STAGES = new Set([
  "audit",
  "complete",
  "convert",
  "enqueue",
  "paint",
  "pool",
  "query",
  "render",
  "request",
  "response",
  "schema",
  "serialize",
]);

let nextRunId = 0;

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function resolveLazy(value) {
  return typeof value === "function" ? value() : value;
}

function sanitizeRunMetadata(metadata) {
  const resolved = resolveLazy(metadata);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (!SAFE_RUN_METADATA_KEYS.has(key)) continue;
    if (typeof value === "string" || typeof value === "boolean" || finiteNumber(value)) {
      safe[key] = value;
    }
  }
  return safe;
}

function sanitizeDetails(details) {
  const resolved = resolveLazy(details);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (key === "stage") {
      if (typeof value === "string" && SAFE_STAGES.has(value)) safe.stage = value;
      continue;
    }
    if (!/(?:Count|Size|Bytes)$/u.test(key) || !finiteNumber(value)) continue;
    safe[key] = value;
  }
  return safe;
}

function nearestRank(sortedValues, percentile) {
  if (sortedValues.length === 0) return null;
  const rank = Math.max(1, Math.ceil(percentile * sortedValues.length));
  return sortedValues[rank - 1];
}

export function summarizeDurations(durations) {
  const values = durations.filter(finiteNumber).slice().sort((left, right) => left - right);
  if (values.length === 0) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p95: null };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    min: values[0],
    max: values[values.length - 1],
    mean: total / values.length,
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
  };
}

const NOOP_SPAN = Object.freeze({
  runId: null,
  spanId: null,
  parentSpanId: null,
  end() {},
});

export function createPerformanceRecorder({
  capacity = DEFAULT_CAPACITY,
  enabled = true,
  now = defaultNow,
} = {}) {
  const boundedCapacity = Math.max(0, Math.trunc(Number(capacity) || 0));
  let buffer = enabled ? new Array(boundedCapacity) : [];
  let bufferStart = 0;
  let bufferSize = 0;
  let droppedEvents = 0;
  let generation = 0;
  let run = null;
  let spanSequence = 0;

  function orderedEvents() {
    const events = new Array(bufferSize);
    for (let index = 0; index < bufferSize; index += 1) {
      events[index] = buffer[(bufferStart + index) % boundedCapacity];
    }
    return events;
  }

  function append(event) {
    if (boundedCapacity === 0) {
      droppedEvents += 1;
      return;
    }
    if (bufferSize < boundedCapacity) {
      buffer[(bufferStart + bufferSize) % boundedCapacity] = event;
      bufferSize += 1;
      return;
    }
    buffer[bufferStart] = event;
    bufferStart = (bufferStart + 1) % boundedCapacity;
    droppedEvents += 1;
  }

  function clearEvents() {
    buffer = enabled ? new Array(boundedCapacity) : [];
    bufferStart = 0;
    bufferSize = 0;
    droppedEvents = 0;
  }

  function beginRun(metadata = {}) {
    if (!enabled) return null;
    generation += 1;
    spanSequence = 0;
    clearEvents();
    run = {
      runId: `perf-run-${++nextRunId}`,
      active: true,
      startedAt: now(),
      endedAt: null,
      metadata: sanitizeRunMetadata(metadata),
    };
    return { ...run, metadata: { ...run.metadata } };
  }

  function beginSpan(label, { phase = null, parentSpanId = null, details = null } = {}) {
    if (!enabled || !run?.active) return NOOP_SPAN;
    const spanGeneration = generation;
    const runId = run.runId;
    const spanId = `${runId}-span-${++spanSequence}`;
    const startedAt = now();
    const initialDetails = sanitizeDetails(details);
    let ended = false;
    return Object.freeze({
      runId,
      spanId,
      parentSpanId: parentSpanId || null,
      end(options = {}) {
        if (ended || generation !== spanGeneration || !run?.active || run.runId !== runId) return;
        ended = true;
        const endedAt = now();
        const outcome = typeof options === "object" && options?.outcome === "error" ? "error" : "success";
        const extraDetails = typeof options === "function" ? options : options?.details;
        append({
          type: "span",
          runId,
          spanId,
          parentSpanId: parentSpanId || null,
          label: String(label),
          phase: typeof phase === "string" ? phase : null,
          startedAt,
          endedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          outcome,
          details: { ...initialDetails, ...sanitizeDetails(extraDetails) },
        });
      },
    });
  }

  function recordDuration(label, durationMs, details = null) {
    if (!enabled || !run?.active || !finiteNumber(durationMs)) return null;
    const event = {
      type: "duration",
      runId: run.runId,
      spanId: null,
      parentSpanId: null,
      label: String(label),
      phase: null,
      durationMs: Math.max(0, durationMs),
      outcome: "success",
      details: sanitizeDetails(details),
    };
    append(event);
    return event;
  }

  function snapshot() {
    const events = orderedEvents().map((event) => ({ ...event, details: { ...event.details } }));
    return {
      run: run ? { ...run, metadata: { ...run.metadata } } : null,
      events,
      droppedEvents,
      summaries: summarizeEvents(events),
    };
  }

  function endRun() {
    if (enabled && run?.active) {
      run = { ...run, active: false, endedAt: now() };
      generation += 1;
    }
    return snapshot();
  }

  function reset() {
    generation += 1;
    run = null;
    spanSequence = 0;
    clearEvents();
  }

  function summary(label) {
    return summarizeDurations(
      orderedEvents()
        .filter((event) => event.label === label)
        .map((event) => event.durationMs),
    );
  }

  async function measureAsync(label, action, options = {}) {
    const span = beginSpan(label, options);
    try {
      const result = await action();
      span.end();
      return result;
    } catch (error) {
      span.end({ outcome: "error" });
      throw error;
    }
  }

  return Object.freeze({
    beginRun,
    beginSpan,
    endRun,
    isEnabled: () => enabled,
    isRunActive: () => Boolean(enabled && run?.active),
    measureAsync,
    recordDuration,
    reset,
    snapshot,
    summary,
  });
}

export function summarizeEvents(events) {
  const grouped = new Map();
  for (const event of events) {
    if (!finiteNumber(event?.durationMs) || typeof event?.label !== "string") continue;
    const durations = grouped.get(event.label) || [];
    durations.push(event.durationMs);
    grouped.set(event.label, durations);
  }
  return Object.fromEntries(
    [...grouped.entries()].map(([label, durations]) => [label, summarizeDurations(durations)]),
  );
}

function structuredPerformanceAvailable() {
  return Boolean(globalThis.__DBSCOUT_PERF_ENABLED__ === true || import.meta.env?.DEV);
}

export function getGlobalPerformanceRecorder() {
  const existing = globalThis.__DBSCOUT_PERFORMANCE__;
  if (existing && typeof existing.beginSpan === "function") return existing;
  if (!structuredPerformanceAvailable()) return null;
  const recorder = createPerformanceRecorder();
  globalThis.__DBSCOUT_PERFORMANCE__ = recorder;
  return recorder;
}

if (structuredPerformanceAvailable()) getGlobalPerformanceRecorder();
