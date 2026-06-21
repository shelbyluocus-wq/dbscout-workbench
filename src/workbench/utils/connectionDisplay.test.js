import test from "node:test";
import assert from "node:assert/strict";
import { filterVisibleConnections, isDemoConnection, isRealConnection } from "./connectionDisplay.js";

test("isDemoConnection identifies built-in demo connections", () => {
  assert.equal(isDemoConnection({ id: "demo" }), true);
  assert.equal(isDemoConnection({ id: "demo-staging" }), true);
  assert.equal(isDemoConnection({ id: "demo-test" }), true);
  assert.equal(isDemoConnection({ id: "mysql-1" }), false);
});

test("filterVisibleConnections hides demo connections when a real connection exists", () => {
  const connections = [
    { id: "demo", label: "Demo" },
    { id: "demo-test", label: "Test" },
    { id: "mysql-1", label: "Prod" },
  ];
  assert.deepEqual(filterVisibleConnections(connections), [{ id: "mysql-1", label: "Prod" }]);
});

test("filterVisibleConnections keeps demo connections when no real connection exists", () => {
  const connections = [
    { id: "demo", label: "Demo" },
    { id: "demo-test", label: "Test" },
  ];
  assert.deepEqual(filterVisibleConnections(connections), connections);
});

test("isRealConnection is the inverse of demo detection", () => {
  assert.equal(isRealConnection({ id: "demo" }), false);
  assert.equal(isRealConnection({ id: "clickhouse-1" }), true);
});