import test from "node:test";
import assert from "node:assert/strict";

const reportModule = await import("./performanceReport.js").catch(() => ({}));

function requireApi(name) {
  const api = reportModule[name];
  assert.equal(typeof api, "function", `performanceReport must export ${name}`);
  return api;
}

function steppedNow(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test("recorder keeps bounded events and reports the exact dropped count", () => {
  const createPerformanceRecorder = requireApi("createPerformanceRecorder");
  const recorder = createPerformanceRecorder({ capacity: 3, now: () => 0 });
  recorder.beginRun({ scenario: "grid-navigation", sampleCount: 4 });

  recorder.recordDuration("grid.navigate", 10, { rowCount: 100_000 });
  recorder.recordDuration("grid.navigate", 20, { rowCount: 100_000 });
  recorder.recordDuration("grid.navigate", 30, { rowCount: 100_000 });
  recorder.recordDuration("grid.navigate", 40, { rowCount: 100_000 });

  const snapshot = recorder.snapshot();
  assert.deepEqual(
    snapshot.events.map((event) => event.durationMs),
    [20, 30, 40],
  );
  assert.equal(snapshot.droppedEvents, 1);
});

test("recordDuration results and snapshots cannot mutate buffered events", () => {
  const createPerformanceRecorder = requireApi("createPerformanceRecorder");
  const recorder = createPerformanceRecorder({ now: () => 0 });
  recorder.beginRun({ scenario: "immutable-snapshots" });
  const result = recorder.recordDuration("grid.navigate", 12, { rowCount: 1_000 });

  try {
    result.durationMs = 999;
    result.details.rowCount = 999;
    result.details.sql = "SELECT secret";
  } catch {
    // A deeply frozen safe result is also a valid contract.
  }

  const first = recorder.snapshot();
  assert.equal(first.events[0].durationMs, 12);
  assert.deepEqual(first.events[0].details, { rowCount: 1_000 });
  first.events[0].durationMs = 777;
  first.events[0].details.rowCount = 777;
  first.summaries["grid.navigate"].p95 = 777;

  const second = recorder.snapshot();
  assert.equal(second.events[0].durationMs, 12);
  assert.deepEqual(second.events[0].details, { rowCount: 1_000 });
  assert.equal(second.summaries["grid.navigate"].p95, 12);
  assert.equal(JSON.stringify(second).includes("SELECT secret"), false);
});

test("nearest-rank summaries are pure and include count min max mean p50 and p95", () => {
  const summarizeDurations = requireApi("summarizeDurations");
  const durations = [40, 10, 30, 20];

  assert.deepEqual(summarizeDurations(durations), {
    count: 4,
    min: 10,
    max: 40,
    mean: 25,
    p50: 20,
    p95: 40,
  });
  assert.deepEqual(durations, [40, 10, 30, 20], "summary must not mutate its input");
  assert.deepEqual(summarizeDurations([]), {
    count: 0,
    min: null,
    max: null,
    mean: null,
    p50: null,
    p95: null,
  });
});

test("run metadata is retained and span IDs are unique with only explicit parents", () => {
  const createPerformanceRecorder = requireApi("createPerformanceRecorder");
  const recorder = createPerformanceRecorder({ now: steppedNow([1, 2, 3, 4, 5, 6, 7]) });
  const run = recorder.beginRun({ scenario: "table-open", sampleCount: 3 });
  const root = recorder.beginSpan("table.open", { phase: "interaction" });
  const childA = recorder.beginSpan("ipc.open", {
    phase: "ipc",
    parentSpanId: root.spanId,
    details: { rowCount: 1000 },
  });
  const childB = recorder.beginSpan("ipc.fetch", {
    phase: "ipc",
    parentSpanId: root.spanId,
  });
  const independent = recorder.beginSpan("sidebar.refresh", { phase: "render" });

  childA.end();
  childB.end();
  independent.end();
  root.end();

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.run.runId, run.runId);
  assert.deepEqual(snapshot.run.metadata, { scenario: "table-open", sampleCount: 3 });
  assert.equal(new Set(snapshot.events.map((event) => event.spanId)).size, 4);
  assert.equal(snapshot.events.find((event) => event.spanId === childA.spanId).parentSpanId, root.spanId);
  assert.equal(snapshot.events.find((event) => event.spanId === childB.spanId).parentSpanId, root.spanId);
  assert.equal(snapshot.events.find((event) => event.spanId === independent.spanId).parentSpanId, null);
});

test("endRun closes the run and reset invalidates outstanding spans", () => {
  const createPerformanceRecorder = requireApi("createPerformanceRecorder");
  const recorder = createPerformanceRecorder({ now: steppedNow([1, 2, 3, 4, 5, 6]) });
  recorder.beginRun({ scenario: "reset" });
  const stale = recorder.beginSpan("stale", { phase: "ipc" });

  const ended = recorder.endRun();
  assert.equal(ended.run.active, false);
  assert.equal(typeof ended.run.endedAt, "number");

  recorder.reset();
  recorder.beginRun({ scenario: "replacement" });
  stale.end();
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.droppedEvents, 0);
  assert.equal(snapshot.run.metadata.scenario, "replacement");
});

test("cancelled spans never commit an event", () => {
  const createPerformanceRecorder = requireApi("createPerformanceRecorder");
  const recorder = createPerformanceRecorder({ now: steppedNow([1, 2, 3, 4]) });
  recorder.beginRun({ scenario: "runtime-fallback" });
  const span = recorder.beginSpan("ipc:list_connections", { phase: "ipc" });

  assert.equal(typeof span.cancel, "function", "spans must support cancelling tentative transports");
  span.cancel();
  span.end({ outcome: "error" });

  assert.deepEqual(recorder.snapshot().events, []);
});

test("measureAsync records an error outcome and rethrows the original error", async () => {
  const createPerformanceRecorder = requireApi("createPerformanceRecorder");
  const recorder = createPerformanceRecorder({ now: steppedNow([1, 2, 7]) });
  recorder.beginRun({ scenario: "error" });
  const expected = new Error("sensitive database text");

  await assert.rejects(
    recorder.measureAsync("db.wait", async () => {
      throw expected;
    }, { phase: "database", details: { stage: "query" } }),
    (error) => error === expected,
  );

  const [event] = recorder.snapshot().events;
  assert.equal(event.outcome, "error");
  assert.equal(event.durationMs, 5);
  assert.equal(JSON.stringify(event).includes(expected.message), false, "errors must not leak into performance data");
});

test("disabled recorder performs no timing or lazy detail work and records no events", () => {
  const createPerformanceRecorder = requireApi("createPerformanceRecorder");
  let nowCalls = 0;
  let detailCalls = 0;
  const recorder = createPerformanceRecorder({
    enabled: false,
    now: () => {
      nowCalls += 1;
      return 1;
    },
  });
  const details = () => {
    detailCalls += 1;
    return { rowCount: 1 };
  };

  assert.equal(recorder.beginRun({ scenario: "disabled" }), null);
  const span = recorder.beginSpan("disabled", { phase: "ipc", details });
  span.end(details);
  recorder.recordDuration("disabled", 10, details);

  assert.equal(nowCalls, 0);
  assert.equal(detailCalls, 0);
  assert.deepEqual(recorder.snapshot().events, []);
  assert.equal(recorder.snapshot().droppedEvents, 0);
});
