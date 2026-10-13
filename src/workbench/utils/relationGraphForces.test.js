import test from "node:test";
import assert from "node:assert/strict";
import { createGraphSimulation, startPositions } from "./relationGraphForces.js";

// center -- a -- b on a line, c unrelated below.
function chain() {
  return {
    nodes: [
      { id: "center", homeX: 0, homeY: 0, radius: 11 },
      { id: "a", homeX: 100, homeY: 0, radius: 8 },
      { id: "b", homeX: 200, homeY: 0, radius: 8 },
      { id: "c", homeX: 0, homeY: 150, radius: 8 },
    ],
    links: [
      { source: "center", target: "a" },
      { source: "a", target: "b" },
    ],
  };
}

function run(simulation, limit = 2000) {
  let ticks = 0;
  while (simulation.tick() && ticks < limit) ticks += 1;
  return ticks;
}

function near(actual, expected, tolerance = 1) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("a graph at its ring layout is already at rest", () => {
  const simulation = createGraphSimulation(chain());
  assert.equal(simulation.tick(), false);
  assert.deepEqual(simulation.snapshot().get("a"), { x: 100, y: 0 });
});

test("displaced tables swing back to their ring positions and stop", () => {
  const graph = chain();
  graph.nodes[1] = { ...graph.nodes[1], x: 40, y: 80 };
  const simulation = createGraphSimulation(graph);
  const ticks = run(simulation);
  assert.ok(ticks > 5 && ticks < 2000, `settled after ${ticks} ticks`);
  const a = simulation.snapshot().get("a");
  near(a.x, 100);
  near(a.y, 0);
});

test("dragging a table pulls its neighbours along but not unrelated tables", () => {
  const simulation = createGraphSimulation(chain());
  simulation.pin("b", 200, 120);
  for (let i = 0; i < 400; i += 1) assert.equal(simulation.tick(), true, "a pinned table keeps the picture alive");
  const positions = simulation.snapshot();
  assert.deepEqual(positions.get("b"), { x: 200, y: 120 });
  assert.ok(positions.get("a").y > 10, "the linked table follows");
  assert.ok(positions.get("a").y < 120, "but less than the dragged one");
  near(positions.get("c").x, 0);
  near(positions.get("c").y, 150);

  simulation.unpin("b");
  run(simulation);
  const after = simulation.snapshot();
  near(after.get("b").x, 200);
  near(after.get("b").y, 0);
  near(after.get("a").y, 0);
});

test("overlapping circles are pushed apart, even when they coincide", () => {
  const simulation = createGraphSimulation({
    nodes: [
      { id: "x", homeX: 0, homeY: 0, radius: 10 },
      { id: "y", homeX: 0, homeY: 0, radius: 10 },
    ],
    links: [],
  });
  run(simulation);
  const positions = simulation.snapshot();
  const gap = Math.abs(positions.get("y").x - positions.get("x").x);
  assert.ok(gap > 5, `circles separated by ${gap}`);
  assert.ok(Number.isFinite(positions.get("x").x));
});

test("unknown ids and self links are ignored", () => {
  const simulation = createGraphSimulation({
    nodes: [{ id: "only", homeX: 5, homeY: 5 }],
    links: [{ source: "only", target: "only" }, { source: "only", target: "missing" }],
  });
  simulation.pin("missing", 1, 1);
  simulation.unpin("missing");
  assert.equal(simulation.tick(), false);
  assert.equal(simulation.has("missing"), false);
});

test("new tables grow out of the table that brought them in", () => {
  const nodes = [
    { id: "center", parent: null },
    { id: "a", parent: "center" },
    { id: "b", parent: "a" },
    { id: "d", parent: "zzz" },
  ];
  const homes = new Map([["center", { x: 0, y: 0 }], ["a", { x: 100, y: 0 }], ["b", { x: 200, y: 0 }], ["d", { x: 0, y: 90 }]]);
  assert.deepEqual(startPositions(nodes, homes, null), homes, "nothing to animate from: start at rest");
  const previous = new Map([["center", { x: 3, y: 4 }], ["a", { x: 90, y: 10 }]]);
  const starts = startPositions(nodes, homes, previous);
  assert.deepEqual(starts.get("a"), { x: 90, y: 10 }, "kept tables stay put");
  assert.deepEqual(starts.get("b"), { x: 90, y: 10 }, "new tables start on their parent");
  assert.deepEqual(starts.get("d"), { x: 3, y: 4 }, "without a drawn parent they start on the center");
});
