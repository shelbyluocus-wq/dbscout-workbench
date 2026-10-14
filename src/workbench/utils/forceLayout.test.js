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

test("dragging moves the table and the small tables on it; the rest of the picture holds still", () => {
  const layout = createForceLayout();
  layout.setGraph(graph());
  settle(layout);
  const before = layout.positions();
  // Table a (index 0) carries four leaves; the pair f–g is elsewhere.
  layout.beginDrag(0);
  assert.equal(layout.held(), 2, "only the unrelated pair is held");
  layout.pin(0, before[0] + 120, before[1] + 60);
  for (let step = 0; step < 400; step += 1) layout.step();
  assert.equal(layout.running(), true, "awake while the pointer holds the table");
  let xy = layout.positions();
  assert.deepEqual([xy[0], xy[1]], [before[0] + 120, before[1] + 60]);
  for (let at = 1; at <= 4; at += 1) assert.ok(distance(xy, 0, at) < 120, `leaf ${at} follows`);
  for (let at = 5; at <= 6; at += 1) {
    assert.deepEqual([xy[at * 2], xy[at * 2 + 1]], [before[at * 2], before[at * 2 + 1]], `table ${at} does not move`);
  }
  layout.endDrag();
  settle(layout);
  assert.equal(layout.running(), false);
  assert.equal(layout.held(), 0, "the hold is let go once everything is still");
  xy = layout.positions();
  for (let at = 5; at <= 6; at += 1) {
    assert.deepEqual([xy[at * 2], xy[at * 2 + 1]], [before[at * 2], before[at * 2 + 1]], `table ${at} still where it was`);
  }
  assert.equal(layout.step(), false, "letting go moves nothing");
});

test("a busy neighbour stays where it is when a table next to it is dragged", () => {
  // Hub h (index 0) has five relations; table t (index 1) hangs on it.
  const ids = ["h", "t", "a", "b", "c", "d"];
  const layout = createForceLayout();
  layout.setGraph({
    ids,
    seeds: new Float32Array(ids.flatMap((_, at) => [at * 30, (at % 3) * 20])),
    radius: new Float32Array(ids.length).fill(6),
    links: new Uint32Array([0, 1, 0, 2, 0, 3, 0, 4, 0, 5]),
    fixed: new Float32Array(0),
    alpha: LAYOUT_ALPHA.fresh,
    reset: true,
  });
  settle(layout);
  const before = layout.positions();
  layout.beginDrag(1);
  layout.pin(1, before[2] + 80, before[3]);
  for (let step = 0; step < 200; step += 1) layout.step();
  const xy = layout.positions();
  assert.deepEqual([xy[0], xy[1]], [before[0], before[1]], "the hub holds still");
  layout.endDrag();
  settle(layout);
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
  host.receive({ type: "drag", active: true, index: 3 });
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

test("restoring the layout moves only the tables the user put somewhere", () => {
  const layout = createForceLayout();
  layout.setGraph(graph());
  settle(layout);
  const rest = layout.positions();
  // Table e (index 4) was dropped far away.
  const fixed = graph();
  fixed.seeds = rest;
  fixed.fixed = new Float32Array([4, rest[8] + 300, rest[9] - 200]);
  fixed.alpha = 0;
  fixed.reset = false;
  layout.setGraph(fixed);
  layout.releaseAll(LAYOUT_ALPHA.update);
  assert.ok(layout.held() > 0, "the others are held while it finds its way back");
  settle(layout);
  const xy = layout.positions();
  assert.ok(distance(xy, 0, 4) < 120, "the released table returns beside its neighbour");
  for (const at of [0, 1, 2, 3, 5, 6]) {
    assert.deepEqual([xy[at * 2], xy[at * 2 + 1]], [rest[at * 2], rest[at * 2 + 1]], `table ${at} does not move`);
  }
  assert.equal(layout.held(), 0);
});
