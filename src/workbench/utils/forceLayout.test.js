import test from "node:test";
import assert from "node:assert/strict";
import { forceCollide, forceManyBody, forceSimulation } from "d3-force";

import { LAYOUT_ALPHA, chargeTheta, createForceLayout, createLayoutHost, settleSteps } from "./forceLayout.js";
import { forceCollideFast, forceManyBodyFast } from "./fastForces.js";

// A star (0 linked to 1–4) and a pair (5–6), started on a line.
function graph() {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const seeds = new Float32Array(ids.flatMap((_, at) => [at * 20, (at % 2) * 15]));
  const radius = new Float32Array(ids.length).fill(6);
  const links = new Uint32Array([0, 1, 0, 2, 0, 3, 0, 4, 5, 6]);
  return { ids, seeds, radius, links, fixed: new Float32Array(0), alpha: LAYOUT_ALPHA.fresh, reset: true };
}

function settle(layout, limit = 2000) {
  let steps = 0;
  while (layout.step() && steps < limit) steps += 1;
  return steps;
}

function distance(xy, left, right) {
  return Math.hypot(xy[left * 2] - xy[right * 2], xy[left * 2 + 1] - xy[right * 2 + 1]);
}

test("a fresh layout settles, keeps linked tables near and circles apart", () => {
  const layout = createForceLayout();
  layout.setGraph(graph());
  assert.equal(layout.running(), true);
  const steps = settle(layout);
  assert.ok(steps > 50 && steps < 400, `settled in ${steps} steps`);
  assert.equal(layout.running(), false);
  assert.equal(layout.step(), false, "a resting layout does no work");
  const xy = layout.positions();
  assert.ok(xy.every(Number.isFinite));
  assert.ok(distance(xy, 5, 6) < distance(xy, 0, 5), "the pair stays together");
  for (let left = 0; left < 7; left += 1) {
    for (let right = left + 1; right < 7; right += 1) assert.ok(distance(xy, left, right) >= 12 - 0.5, "no overlap");
  }
});

test("tables already laid out keep their place when the graph grows", () => {
  const layout = createForceLayout();
  layout.setGraph(graph());
  settle(layout);
  const before = layout.positions();
  const grown = graph();
  grown.ids = [...grown.ids, "h"];
  grown.seeds = Float32Array.from([...before, 400, 400]);
  grown.radius = new Float32Array(8).fill(6);
  grown.links = Uint32Array.from([...grown.links, 6, 7]);
  grown.alpha = 0;
  grown.reset = false;
  layout.setGraph(grown);
  const after = layout.positions();
  for (let at = 0; at < 7; at += 1) assert.ok(distance(before, at, at) === 0 && Math.abs(after[at * 2] - before[at * 2]) < 1e-3);
  assert.deepEqual([after[14], after[15]], [400, 400], "the new table starts at its seed");
});

test("a table put somewhere stays there; restoring lets it go", () => {
  const layout = createForceLayout();
  const fixed = graph();
  fixed.fixed = new Float32Array([1, 300, -200]);
  layout.setGraph(fixed);
  settle(layout);
  let xy = layout.positions();
  assert.deepEqual([xy[2], xy[3]], [300, -200]);
  layout.releaseAll(LAYOUT_ALPHA.update);
  assert.equal(layout.running(), true);
  settle(layout);
  xy = layout.positions();
  assert.ok(distance(xy, 0, 1) < Math.hypot(300 - xy[0], -200 - xy[1]), "pulled back toward its neighbour");
});

test("dragging keeps the layout awake until released", () => {
  const layout = createForceLayout();
  layout.setGraph({ ...graph(), alpha: 0 });
  assert.equal(layout.running(), false);
  layout.setAlphaTarget(LAYOUT_ALPHA.drag);
  layout.pin(2, 50, 50);
  for (let step = 0; step < 500; step += 1) layout.step();
  assert.equal(layout.running(), true, "still awake while the pointer holds a table");
  const xy = layout.positions();
  assert.deepEqual([xy[4], xy[5]], [50, 50]);
  layout.setAlphaTarget(0);
  settle(layout);
  assert.equal(layout.running(), false);
});

test("large graphs settle in fewer, coarser steps", () => {
  assert.equal(settleSteps(500), 300);
  assert.ok(settleSteps(2000) < 300);
  assert.ok(settleSteps(5000) < settleSteps(2000));
  assert.ok(chargeTheta(5000) > chargeTheta(500));
});

test("the host answers a graph at once and streams positions until rest", () => {
  const tasks = [];
  const posted = [];
  let clock = 0;
  const host = createLayoutHost((message) => posted.push(message), {
    // Each reading of the clock moves it on, as real work would.
    now: () => (clock += 1),
    schedule: (task) => tasks.push(task),
    cancel: () => {},
  });
  host.receive({ type: "graph", version: 7, ...graph() });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].version, 7);
  assert.equal(posted[0].buffer.length, 14);
  assert.equal(posted[0].running, true);
  for (let frame = 0; frame < 1000 && tasks.length; frame += 1) {
    clock += 16;
    tasks.shift()();
  }
  assert.equal(tasks.length, 0, "the loop stops by itself");
  assert.equal(posted.at(-1).running, false);
  host.receive({ type: "pin", index: 3, x: 99, y: 98 });
  assert.equal(tasks.length, 0, "a pin alone does not wake a resting layout");
  host.receive({ type: "drag", active: true });
  assert.equal(tasks.length, 1);
  tasks.shift()();
  assert.deepEqual([posted.at(-1).buffer[6], posted.at(-1).buffer[7]], [99, 98]);
  host.receive({ type: "stop" });
});

test("the fast many-body force matches d3's when it approximates nothing", () => {
  const make = () => Array.from({ length: 60 }, (_, at) => ({ x: Math.cos(at * 1.7) * (20 + at * 3), y: Math.sin(at * 1.3) * (15 + at * 2), vx: 0, vy: 0 }));
  const reference = make();
  const fast = make();
  forceSimulation(reference).stop().force("charge", forceManyBody().strength(-120).theta(0)).alphaDecay(0).velocityDecay(0).tick();
  forceSimulation(fast).stop().force("charge", forceManyBodyFast({ strength: -120, theta: 0 })).alphaDecay(0).velocityDecay(0).tick();
  for (let at = 0; at < reference.length; at += 1) {
    assert.ok(Math.abs(reference[at].x - fast[at].x) < 1e-6 && Math.abs(reference[at].y - fast[at].y) < 1e-6, `table ${at}`);
  }
});

test("the fast collision force separates overlapping circles like d3's", () => {
  const make = () => Array.from({ length: 40 }, (_, at) => ({ x: (at % 7) * 3, y: Math.floor(at / 7) * 3, vx: 0, vy: 0, r: 5 }));
  const fast = make();
  const simulation = forceSimulation(fast).stop().force("collide", forceCollideFast({ radius: (node) => node.r }));
  simulation.tick(300);
  let closest = Infinity;
  for (let left = 0; left < fast.length; left += 1) {
    for (let right = left + 1; right < fast.length; right += 1) {
      closest = Math.min(closest, Math.hypot(fast[left].x - fast[right].x, fast[left].y - fast[right].y));
    }
  }
  assert.ok(closest > 9, `closest pair ${closest.toFixed(2)}`);
  const reference = make();
  forceSimulation(reference).stop().force("collide", forceCollide((node) => node.r)).tick(300);
  const spread = (nodes) => Math.max(...nodes.map((node) => Math.hypot(node.x, node.y)));
  assert.ok(Math.abs(spread(fast) - spread(reference)) / spread(reference) < 0.25, "about as spread out as d3's");
});
