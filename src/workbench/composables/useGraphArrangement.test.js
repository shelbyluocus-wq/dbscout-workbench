import test from "node:test";
import assert from "node:assert/strict";
import { effectScope } from "vue";

import { forgetGraphArrangements, useGraphArrangement } from "./useGraphArrangement.js";

const NODES = [{ id: "hero" }, { id: "skill", parent: "hero" }, { id: "item", parent: "hero" }];
const HOMES = new Map([["hero", { x: 0, y: 0 }], ["skill", { x: 100, y: 0 }], ["item", { x: -100, y: 0 }]]);

function arrangement() {
  const scope = effectScope();
  const graph = scope.run(() => useGraphArrangement());
  return { graph, stop: () => scope.stop() };
}

test("tables sit on the ring layout until one is dragged, which then stays put", () => {
  forgetGraphArrangements();
  const { graph, stop } = arrangement();
  graph.setLayout({ layoutKey: "c1|hero", nodes: NODES, homes: HOMES });
  assert.deepEqual(graph.positions.value.get("skill"), { x: 100, y: 0 });
  assert.equal(graph.arranged.value, false);

  graph.move("skill", { x: 140, y: 60 });
  assert.deepEqual(graph.positions.value.get("skill"), { x: 140, y: 60 });
  assert.deepEqual(graph.positions.value.get("item"), { x: -100, y: 0 }, "neighbours do not move");
  assert.equal(graph.arranged.value, true);

  // A later picture of the same graph keeps the dragged table where it was left.
  graph.setLayout({ layoutKey: "c1|hero", nodes: NODES, homes: HOMES });
  assert.deepEqual(graph.positions.value.get("skill"), { x: 140, y: 60 });
  graph.move("missing", { x: 1, y: 1 });
  graph.move("item", { x: Number.NaN, y: 0 });
  assert.deepEqual(graph.positions.value.get("item"), { x: -100, y: 0 });
  stop();
});

test("an arrangement survives the view, scales with its stretch and can be undone", () => {
  forgetGraphArrangements();
  const inline = arrangement();
  inline.graph.setLayout({ layoutKey: "c1|hero", nodes: NODES, homes: HOMES });
  inline.graph.move("skill", { x: 120, y: 30 });
  inline.stop();

  // The full-screen view of the same graph is stretched 2× across.
  const full = arrangement();
  const stretched = new Map([...HOMES].map(([id, point]) => [id, { x: point.x * 2, y: point.y }]));
  full.graph.setLayout({ layoutKey: "c1|hero", nodes: NODES, homes: stretched, spread: { x: 2, y: 1 } });
  assert.deepEqual(full.graph.positions.value.get("skill"), { x: 240, y: 30 });
  assert.deepEqual(full.graph.targets().get("item"), { x: -200, y: 0 });

  full.graph.reset();
  assert.equal(full.graph.arranged.value, false);
  assert.deepEqual(full.graph.positions.value.get("skill"), { x: 200, y: 0 });
  // Another graph never sees this one's arrangement.
  full.graph.move("skill", { x: 0, y: 99 });
  full.graph.setLayout({ layoutKey: "c1|skill", nodes: NODES, homes: HOMES });
  assert.deepEqual(full.graph.positions.value.get("skill"), { x: 100, y: 0 });
  full.stop();
});

test("without a key the arrangement lives as long as the graph", () => {
  forgetGraphArrangements();
  const { graph, stop } = arrangement();
  graph.setLayout({ nodes: NODES, homes: HOMES });
  graph.move("hero", { x: 5, y: 5 });
  graph.setLayout({ nodes: NODES, homes: HOMES });
  assert.deepEqual(graph.positions.value.get("hero"), { x: 5, y: 5 });
  stop();
  const other = arrangement();
  other.graph.setLayout({ nodes: NODES, homes: HOMES });
  assert.deepEqual(other.graph.positions.value.get("hero"), { x: 0, y: 0 });
  other.stop();
});
