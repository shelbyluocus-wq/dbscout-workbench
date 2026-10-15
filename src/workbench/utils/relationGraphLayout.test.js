import test from "node:test";
import assert from "node:assert/strict";

import { createLayoutRunner, forgetLayouts, recallLayout, rememberLayout } from "./relationGraphLayout.js";

function graph(version = 1) {
  return {
    version,
    ids: ["a", "b"],
    seeds: new Float32Array([0, 0, 50, 0]),
    radius: new Float32Array([6, 6]),
    links: new Uint32Array([0, 1]),
    fixed: new Float32Array(0),
    alpha: 1,
    reset: true,
  };
}

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error("timed out"));
      else setTimeout(check, 10);
    };
    check();
  });
}

test("messages go to the worker and positions come back", () => {
  const sent = [];
  const fake = { postMessage: (message) => sent.push(message), terminate() { this.closed = true; } };
  const received = [];
  const runner = createLayoutRunner({ onPositions: (message) => received.push(message), createWorker: () => fake });
  assert.equal(runner.usesWorker(), true);
  runner.setGraph(graph(3));
  runner.pin(1, 10, 20);
  runner.drag(true);
  assert.deepEqual(sent.map((message) => message.type), ["graph", "pin", "drag"]);
  assert.equal(sent[0].version, 3);
  fake.onmessage({ data: { type: "positions", version: 3 } });
  assert.equal(received.length, 1);
  runner.dispose();
  assert.equal(fake.closed, true);
  fake.onmessage({ data: { type: "positions", version: 3 } });
  assert.equal(received.length, 1, "nothing after disposal");
});

test("without workers the layout runs on the main thread", async () => {
  const received = [];
  const runner = createLayoutRunner({ onPositions: (message) => received.push(message), createWorker: () => null });
  assert.equal(runner.usesWorker(), false);
  await waitFor(() => {
    runner.setGraph(graph(1));
    return received.length > 0;
  });
  await waitFor(() => received.at(-1).running === false);
  assert.equal(received.at(-1).buffer.length, 4);
  runner.dispose();
});

test("a failing worker hands over to the main thread, which asks for the graph again", async () => {
  const fake = { postMessage() {}, terminate() { this.closed = true; } };
  let restarted = 0;
  const runner = createLayoutRunner({ onPositions() {}, onRestart: () => { restarted += 1; }, createWorker: () => fake });
  fake.onerror({ preventDefault() {} });
  assert.equal(fake.closed, true);
  await waitFor(() => restarted === 1);
  assert.equal(runner.usesWorker(), false);
  runner.dispose();
});

test("laid-out graphs are remembered for the session, the oldest forgotten first", () => {
  forgetLayouts();
  rememberLayout("k1", { ids: ["a", "b"], xy: new Float32Array([1, 2, 3, 4]), fixed: new Map([["b", [3, 4]]]), resting: true });
  const entry = recallLayout("k1");
  assert.deepEqual(entry.points.get("b"), [3, 4]);
  assert.deepEqual(entry.fixed.get("b"), [3, 4]);
  assert.equal(entry.resting, true);
  assert.equal(recallLayout("missing"), null);
  for (let index = 0; index < 30; index += 1) rememberLayout(`other${index}`, { ids: ["a"], xy: new Float32Array([0, 0]) });
  assert.equal(recallLayout("k1"), null, "pushed out by newer graphs");
  rememberLayout("", { ids: ["a"], xy: new Float32Array([0, 0]) });
  assert.equal(recallLayout(""), null);
  forgetLayouts();
});

test("a picture laid out for a view of another shape comes back stretched to the new one", () => {
  forgetLayouts();
  rememberLayout("k", { ids: ["a", "b"], xy: new Float32Array([100, 50, -100, -50]), fixed: new Map([["b", [-100, -50]]]), resting: true, aspect: 1 });
  const similar = recallLayout("k", 1.1);
  assert.equal(similar.resting, true, "a view of about the same shape shows it as it was");
  assert.deepEqual(similar.points.get("a"), [100, 50]);
  const wide = recallLayout("k", 4);
  assert.equal(wide.resting, false, "it settles into its new room");
  assert.deepEqual(wide.points.get("a"), [200, 25], "twice as wide, half as tall: the same area");
  assert.deepEqual(wide.fixed.get("b"), [-200, -25], "dragged tables move with the picture");
  assert.deepEqual(recallLayout("k", 1).points.get("a"), [100, 50], "the remembered picture itself is unchanged");
  forgetLayouts();
});
