import test from "node:test";
import assert from "node:assert/strict";

import { markPerf, measureAsync, sampleNextFrame } from "./performanceMarks.js";
import { createPerformanceRecorder } from "./performanceReport.js";

test("markPerf writes development-only performance records", () => {
  const previousFlag = globalThis.__DBSCOUT_PERF_ENABLED__;
  const previousDebug = console.debug;
  const records = [];
  globalThis.__DBSCOUT_PERF_ENABLED__ = true;
  console.debug = (...args) => records.push(args);

  try {
    const at = markPerf("connection.loaded", { count: 12 });

    assert.equal(typeof at, "number");
    assert.equal(records.length, 1);
    assert.equal(records[0][0], "[dbscout:perf]");
    assert.equal(records[0][1], "connection.loaded");
    assert.equal(records[0][2].count, 12);
  } finally {
    console.debug = previousDebug;
    globalThis.__DBSCOUT_PERF_ENABLED__ = previousFlag;
  }
});

test("measureAsync logs duration and returns the wrapped result", async () => {
  const previousFlag = globalThis.__DBSCOUT_PERF_ENABLED__;
  const previousDebug = console.debug;
  const records = [];
  globalThis.__DBSCOUT_PERF_ENABLED__ = true;
  console.debug = (...args) => records.push(args);

  try {
    const result = await measureAsync("invoke:list_connections", async () => "ok", { command: "list_connections" });

    assert.equal(result, "ok");
    assert.equal(records.length, 1);
    assert.equal(records[0][0], "[dbscout:perf]");
    assert.equal(records[0][1], "invoke:list_connections");
    assert.equal(records[0][2].command, "list_connections");
    assert.equal(typeof records[0][2].durationMs, "number");
  } finally {
    console.debug = previousDebug;
    globalThis.__DBSCOUT_PERF_ENABLED__ = previousFlag;
  }
});

test("sampleNextFrame waits for two animation frames before sampling paint completion", () => {
  const previousFlag = globalThis.__DBSCOUT_PERF_ENABLED__;
  const previousConsoleFlag = globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__;
  const previousRaf = globalThis.requestAnimationFrame;
  const callbacks = [];
  globalThis.__DBSCOUT_PERF_ENABLED__ = true;
  globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__ = true;
  globalThis.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };

  try {
    sampleNextFrame("grid.paint");
    assert.equal(callbacks.length, 1);

    callbacks.shift()(0);
    assert.equal(callbacks.length, 1, "the first frame should schedule the paint-completion frame");

    callbacks.shift()(16);
    assert.equal(callbacks.length, 0);
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
    globalThis.__DBSCOUT_PERF_ENABLED__ = previousFlag;
    if (previousConsoleFlag === undefined) delete globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__;
    else globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__ = previousConsoleFlag;
  }
});

test("sampleNextFrame records structured paint completion on the second frame without console noise", () => {
  const previousFlag = globalThis.__DBSCOUT_PERF_ENABLED__;
  const previousConsoleFlag = globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__;
  const previousRecorder = globalThis.__DBSCOUT_PERFORMANCE__;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousDebug = console.debug;
  const callbacks = [];
  const consoleRecords = [];
  const timestamps = [0, 10, 42];
  const recorder = createPerformanceRecorder({ now: () => timestamps.shift() ?? 42 });
  recorder.beginRun({ scenario: "paint-completion" });
  globalThis.__DBSCOUT_PERF_ENABLED__ = true;
  delete globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__;
  globalThis.__DBSCOUT_PERFORMANCE__ = recorder;
  globalThis.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  console.debug = (...args) => consoleRecords.push(args);

  try {
    sampleNextFrame("grid.paint", {
      rowCount: 1_000,
      connectionId: "sensitive-connection",
      sql: "SELECT secret FROM private_table",
    });
    assert.equal(callbacks.length, 1);
    assert.deepEqual(recorder.snapshot().events, []);

    callbacks.shift()(16);
    assert.equal(callbacks.length, 1, "the first frame should only schedule paint completion");
    assert.deepEqual(recorder.snapshot().events, []);

    callbacks.shift()(32);
    const [event] = recorder.snapshot().events;
    assert.equal(event.label, "grid.paint");
    assert.equal(event.phase, "paint");
    assert.equal(event.durationMs, 32);
    assert.deepEqual(event.details, { rowCount: 1_000, stage: "paint" });
    assert.equal(JSON.stringify(event).includes("sensitive-connection"), false);
    assert.equal(JSON.stringify(event).includes("private_table"), false);
    assert.deepEqual(consoleRecords, [], "structured recording should be quiet by default");
  } finally {
    console.debug = previousDebug;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
    if (previousRecorder === undefined) delete globalThis.__DBSCOUT_PERFORMANCE__;
    else globalThis.__DBSCOUT_PERFORMANCE__ = previousRecorder;
    globalThis.__DBSCOUT_PERF_ENABLED__ = previousFlag;
    if (previousConsoleFlag === undefined) delete globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__;
    else globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__ = previousConsoleFlag;
  }
});

test("sampleNextFrame does no frame scheduling or recorder timing for inactive and disabled recorders", () => {
  const previousFlag = globalThis.__DBSCOUT_PERF_ENABLED__;
  const previousConsoleFlag = globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__;
  const previousRecorder = globalThis.__DBSCOUT_PERFORMANCE__;
  const previousRaf = globalThis.requestAnimationFrame;
  let frameCalls = 0;
  globalThis.__DBSCOUT_PERF_ENABLED__ = false;
  globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__ = false;
  globalThis.requestAnimationFrame = () => {
    frameCalls += 1;
    return frameCalls;
  };

  try {
    for (const enabled of [true, false]) {
      let nowCalls = 0;
      const recorder = createPerformanceRecorder({
        enabled,
        now: () => {
          nowCalls += 1;
          return nowCalls;
        },
      });
      globalThis.__DBSCOUT_PERFORMANCE__ = recorder;

      sampleNextFrame(`grid.paint.${enabled ? "inactive" : "disabled"}`, { rowCount: 1_000 });

      assert.equal(nowCalls, 0);
      assert.deepEqual(recorder.snapshot().events, []);
    }
    assert.equal(frameCalls, 0);
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
    if (previousRecorder === undefined) delete globalThis.__DBSCOUT_PERFORMANCE__;
    else globalThis.__DBSCOUT_PERFORMANCE__ = previousRecorder;
    globalThis.__DBSCOUT_PERF_ENABLED__ = previousFlag;
    if (previousConsoleFlag === undefined) delete globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__;
    else globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__ = previousConsoleFlag;
  }
});

test("an active structured benchmark run suppresses legacy console timing noise", () => {
  const previousFlag = globalThis.__DBSCOUT_PERF_ENABLED__;
  const previousRecorder = globalThis.__DBSCOUT_PERFORMANCE__;
  const previousDebug = console.debug;
  const records = [];
  const recorder = createPerformanceRecorder({ now: () => 1 });
  recorder.beginRun({ scenario: "quiet-benchmark" });
  globalThis.__DBSCOUT_PERF_ENABLED__ = true;
  globalThis.__DBSCOUT_PERFORMANCE__ = recorder;
  console.debug = (...args) => records.push(args);

  try {
    assert.equal(markPerf("benchmark.noise"), null);
    assert.deepEqual(records, []);
  } finally {
    console.debug = previousDebug;
    if (previousRecorder === undefined) delete globalThis.__DBSCOUT_PERFORMANCE__;
    else globalThis.__DBSCOUT_PERFORMANCE__ = previousRecorder;
    globalThis.__DBSCOUT_PERF_ENABLED__ = previousFlag;
  }
});
