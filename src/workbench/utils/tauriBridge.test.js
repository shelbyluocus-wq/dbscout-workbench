import test from "node:test";
import assert from "node:assert/strict";

import { invokeWorkbench, listenWorkbenchEvent } from "./tauriBridge.js";

const reportModule = await import("./performanceReport.js").catch(() => ({}));

function requireRecorderApi() {
  assert.equal(
    typeof reportModule.createPerformanceRecorder,
    "function",
    "performanceReport must export createPerformanceRecorder",
  );
  return reportModule.createPerformanceRecorder;
}

function restoreGlobal(name, previous) {
  if (previous === undefined) delete globalThis[name];
  else globalThis[name] = previous;
}

test("invokeWorkbench sends active run context as headers without changing the business payload", async () => {
  const createPerformanceRecorder = requireRecorderApi();
  const previousInternals = globalThis.__TAURI_INTERNALS__;
  const previousWindow = globalThis.window;
  const previousRecorder = globalThis.__DBSCOUT_PERFORMANCE__;
  const recorder = createPerformanceRecorder({ now: (() => {
    let value = 0;
    return () => ++value;
  })() });
  const run = recorder.beginRun({ scenario: "ipc" });
  globalThis.__DBSCOUT_PERFORMANCE__ = recorder;
  globalThis.window = globalThis;
  const payload = { request: { connectionId: "demo", page: 2 }, flags: [true, false] };
  const before = JSON.stringify(payload);
  let observed;
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (command, args, options) => {
      observed = { command, args, options };
      return { ok: true };
    },
  };

  try {
    const result = await invokeWorkbench("fetch_table_page", payload);

    assert.deepEqual(result, { ok: true });
    assert.equal(observed.command, "fetch_table_page");
    assert.equal(observed.args, payload, "the same payload object should cross the bridge");
    assert.equal(JSON.stringify(payload), before, "bridge metadata must not mutate the payload");
    assert.equal(observed.options.headers["x-dbscout-perf-run-id"], run.runId);
    assert.equal(typeof observed.options.headers["x-dbscout-perf-span-id"], "string");
    const snapshot = recorder.snapshot();
    assert.equal(snapshot.events.length, 1, "the IPC boundary owns exactly one span");
    assert.equal(snapshot.events[0].spanId, observed.options.headers["x-dbscout-perf-span-id"]);
    assert.equal(snapshot.events[0].phase, "ipc");
  } finally {
    restoreGlobal("__TAURI_INTERNALS__", previousInternals);
    restoreGlobal("window", previousWindow);
    restoreGlobal("__DBSCOUT_PERFORMANCE__", previousRecorder);
  }
});

test("invokeWorkbench sends no performance headers when recording is disabled", async () => {
  const createPerformanceRecorder = requireRecorderApi();
  const previousInternals = globalThis.__TAURI_INTERNALS__;
  const previousWindow = globalThis.window;
  const previousRecorder = globalThis.__DBSCOUT_PERFORMANCE__;
  const recorder = createPerformanceRecorder({ enabled: false, now: () => assert.fail("disabled timer called") });
  globalThis.__DBSCOUT_PERFORMANCE__ = recorder;
  globalThis.window = globalThis;
  let observedOptions = "not called";
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (_command, _args, options) => {
      observedOptions = options;
      return "ok";
    },
  };

  try {
    assert.equal(await invokeWorkbench("list_connections"), "ok");
    assert.equal(observedOptions, undefined);
    assert.deepEqual(recorder.snapshot().events, []);
  } finally {
    restoreGlobal("__TAURI_INTERNALS__", previousInternals);
    restoreGlobal("window", previousWindow);
    restoreGlobal("__DBSCOUT_PERFORMANCE__", previousRecorder);
  }
});

test("mock fallback remains contract-compatible and creates no IPC performance span", async () => {
  const createPerformanceRecorder = requireRecorderApi();
  const previousInternals = globalThis.__TAURI_INTERNALS__;
  const previousRecorder = globalThis.__DBSCOUT_PERFORMANCE__;
  const recorder = createPerformanceRecorder({ now: () => 1 });
  recorder.beginRun({ scenario: "mock" });
  globalThis.__DBSCOUT_PERFORMANCE__ = recorder;
  delete globalThis.__TAURI_INTERNALS__;

  try {
    const connections = await invokeWorkbench("list_connections", {});
    assert.equal(Array.isArray(connections), true);
    assert.equal(connections.length > 0, true);
    assert.deepEqual(recorder.snapshot().events, []);
  } finally {
    restoreGlobal("__TAURI_INTERNALS__", previousInternals);
    restoreGlobal("__DBSCOUT_PERFORMANCE__", previousRecorder);
  }
});

test("listenWorkbenchEvent delegates to Tauri listen when __TAURI_INTERNALS__ is present", async () => {
  const previousInternals = globalThis.__TAURI_INTERNALS__;
  globalThis.__TAURI_INTERNALS__ = {};

  const handler = () => {};
  const unlisten = () => {};
  let observed = null;

  try {
    const result = await listenWorkbenchEvent("search-values-progress", handler, {
      listen: async (eventName, eventHandler) => {
        observed = { eventName, eventHandler };
        return unlisten;
      },
    });

    assert.equal(result, unlisten);
    assert.deepEqual(observed, {
      eventName: "search-values-progress",
      eventHandler: handler,
    });
  } finally {
    if (previousInternals === undefined) delete globalThis.__TAURI_INTERNALS__;
    else globalThis.__TAURI_INTERNALS__ = previousInternals;
  }
});

test("listenWorkbenchEvent returns a noop listener when Tauri events are unavailable", async () => {
  const result = await listenWorkbenchEvent("search-values-progress", () => {}, {
    listen: async () => {
      throw new Error("Cannot read properties of undefined (reading 'listen')");
    },
  });

  assert.equal(typeof result, "function");
  assert.doesNotThrow(() => result());
});
