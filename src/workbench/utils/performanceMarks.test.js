import test from "node:test";
import assert from "node:assert/strict";

import { markPerf, measureAsync } from "./performanceMarks.js";

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
