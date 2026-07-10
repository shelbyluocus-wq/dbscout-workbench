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

test("incomplete Tauri invoke capability falls back before headers or an IPC span are created", async () => {
  const createPerformanceRecorder = requireRecorderApi();
  const previousInternals = globalThis.__TAURI_INTERNALS__;
  const previousWindow = globalThis.window;
  const previousRecorder = globalThis.__DBSCOUT_PERFORMANCE__;
  const previousFlag = globalThis.__DBSCOUT_PERF_ENABLED__;
  const previousConsoleFlag = globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__;
  const previousDebug = console.debug;
  let nowCalls = 0;
  let invokeCalls = 0;
  let observedOptions;
  const consoleRecords = [];
  const recorder = createPerformanceRecorder({
    now: () => {
      nowCalls += 1;
      return nowCalls;
    },
  });
  recorder.beginRun({ scenario: "invoke-preflight" });
  globalThis.__DBSCOUT_PERFORMANCE__ = recorder;
  globalThis.__DBSCOUT_PERF_ENABLED__ = true;
  globalThis.__DBSCOUT_PERF_CONSOLE_ENABLED__ = true;
  console.debug = (...args) => consoleRecords.push(args);
  globalThis.window = { __TAURI_INTERNALS__: {} };
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (_command, _args, options) => {
      invokeCalls += 1;
      observedOptions = options;
      return "unexpected-tauri-result";
    },
  };

  try {
    const connections = await invokeWorkbench("list_connections", {});

    assert.equal(Array.isArray(connections), true);
    assert.equal(connections.length > 0, true);
    assert.equal(invokeCalls, 0);
    assert.equal(observedOptions, undefined);
    assert.equal(nowCalls, 1, "only beginRun may read the recorder clock");
    assert.deepEqual(recorder.snapshot().events, []);
    assert.deepEqual(consoleRecords, [], "preflight mock fallback must not start legacy invoke timing");
  } finally {
    console.debug = previousDebug;
    restoreGlobal("__TAURI_INTERNALS__", previousInternals);
    restoreGlobal("window", previousWindow);
    restoreGlobal("__DBSCOUT_PERFORMANCE__", previousRecorder);
    restoreGlobal("__DBSCOUT_PERF_ENABLED__", previousFlag);
    restoreGlobal("__DBSCOUT_PERF_CONSOLE_ENABLED__", previousConsoleFlag);
  }
});

test("a started Tauri invoke error never falls back and retains its error IPC span", async () => {
  const createPerformanceRecorder = requireRecorderApi();
  const previousInternals = globalThis.__TAURI_INTERNALS__;
  const previousWindow = globalThis.window;
  const previousRecorder = globalThis.__DBSCOUT_PERFORMANCE__;
  const recorder = createPerformanceRecorder({ now: (() => {
    let value = 0;
    return () => ++value;
  })() });
  const expected = new Error("Tauri API not available at runtime");
  let invokeCalls = 0;
  let observedOptions;
  recorder.beginRun({ scenario: "started-transport-error" });
  globalThis.__DBSCOUT_PERFORMANCE__ = recorder;
  globalThis.window = globalThis;
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (_command, _args, options) => {
      invokeCalls += 1;
      observedOptions = options;
      throw expected;
    },
  };

  try {
    await assert.rejects(invokeWorkbench("list_connections", {}), (error) => error === expected);
    assert.equal(invokeCalls, 1);
    assert.equal(typeof observedOptions.headers["x-dbscout-perf-run-id"], "string");
    assert.equal(typeof observedOptions.headers["x-dbscout-perf-span-id"], "string");
    const [event] = recorder.snapshot().events;
    assert.equal(event.label, "ipc:list_connections");
    assert.equal(event.outcome, "error");
  } finally {
    restoreGlobal("__TAURI_INTERNALS__", previousInternals);
    restoreGlobal("window", previousWindow);
    restoreGlobal("__DBSCOUT_PERFORMANCE__", previousRecorder);
  }
});

test("real Tauri business errors are rethrown and retain an error IPC span", async () => {
  const createPerformanceRecorder = requireRecorderApi();
  const previousInternals = globalThis.__TAURI_INTERNALS__;
  const previousWindow = globalThis.window;
  const previousRecorder = globalThis.__DBSCOUT_PERFORMANCE__;
  const recorder = createPerformanceRecorder({ now: (() => {
    let value = 0;
    return () => ++value;
  })() });
  const expected = new Error("Database service not available for this account");
  recorder.beginRun({ scenario: "business-error" });
  globalThis.__DBSCOUT_PERFORMANCE__ = recorder;
  globalThis.window = globalThis;
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async () => {
      throw expected;
    },
  };

  try {
    await assert.rejects(invokeWorkbench("list_connections", {}), (error) => error === expected);
    const [event] = recorder.snapshot().events;
    assert.equal(event.label, "ipc:list_connections");
    assert.equal(event.outcome, "error");
    assert.equal(JSON.stringify(event).includes(expected.message), false);
  } finally {
    restoreGlobal("__TAURI_INTERNALS__", previousInternals);
    restoreGlobal("window", previousWindow);
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
