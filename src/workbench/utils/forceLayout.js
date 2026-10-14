// The force layout behind large relation graphs, after Obsidian's graph
// view: every table pushes the others away, relations pull linked tables
// together, a gentle pull keeps the picture centred and circles never
// overlap. The same engine runs in the layout worker or, where workers are
// unavailable, on the main thread in small slices. Tables the user dragged
// stay where they were dropped until the layout is restored.
import { forceLink, forceSimulation, forceX, forceY } from "d3-force";
import { forceCollideFast, forceManyBodyFast } from "./fastForces.js";
import { LAYOUT_ALPHA } from "./forceLayoutAlpha.js";

export { LAYOUT_ALPHA };

// Tuned for circles of 4–30 units (see canvasNodeRadius).
const LINK_DISTANCE = 34;
const CHARGE = -230;
const CHARGE_THETA = 0.9;
// Tables farther apart than this ignore each other, so small islands settle
// beside the main picture instead of being pushed far out by all of it.
const CHARGE_RANGE = 800;
const COLLIDE_PADDING = 7;
const CENTER_STRENGTH = 0.05;

// Larger graphs settle in fewer, slightly coarser steps: the picture they
// reach is as readable, in about half the time (d3's default is 300 steps).
export function settleSteps(count) {
  if (count <= 1000) return 300;
  return count <= 3000 ? 220 : 160;
}

export function chargeTheta(count) {
  return count > 2500 ? 1.1 : CHARGE_THETA;
}

// d3's linear congruential generator, seeded: the same graph settles the same way.
function seededSource(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export function createForceLayout() {
  let nodes = [];
  let byId = new Map();
  const simulation = forceSimulation([])
    .stop()
    .randomSource(seededSource())
    .alphaMin(LAYOUT_ALPHA.rest)
    .force("charge", forceManyBodyFast({ strength: CHARGE, theta: CHARGE_THETA, distanceMax: CHARGE_RANGE }))
    .force("link", forceLink([]).distance((link) => LINK_DISTANCE + link.source.r + link.target.r))
    .force("collide", forceCollideFast({ radius: (node) => node.r + COLLIDE_PADDING }))
    .force("x", forceX(0).strength(CENTER_STRENGTH))
    .force("y", forceY(0).strength(CENTER_STRENGTH));
  simulation.alpha(0);

  /**
   * Replaces the graph. `ids` names the tables in order; `seeds` holds
   * [x, y] pairs where new tables start (tables already known keep their
   * place and speed unless `reset`); `links` holds index pairs; `fixed` holds
   * [index, x, y] triples for tables the user put somewhere.
   */
  function setGraph({ ids, seeds, radius, links, fixed, alpha = LAYOUT_ALPHA.update, reset = false }) {
    if (reset) byId = new Map();
    const next = new Array(ids.length);
    const nextById = new Map();
    for (let at = 0; at < ids.length; at += 1) {
      const id = ids[at];
      let node = byId.get(id);
      if (!node) node = { id, x: seeds[at * 2], y: seeds[at * 2 + 1], vx: 0, vy: 0 };
      node.r = radius[at];
      node.fx = null;
      node.fy = null;
      next[at] = node;
      nextById.set(id, node);
    }
    const fixedLength = fixed?.length || 0;
    for (let cursor = 0; cursor + 2 < fixedLength; cursor += 3) {
      const node = next[fixed[cursor]];
      if (!node) continue;
      node.x = node.fx = fixed[cursor + 1];
      node.y = node.fy = fixed[cursor + 2];
    }
    nodes = next;
    byId = nextById;
    simulation.alphaDecay(1 - LAYOUT_ALPHA.rest ** (1 / settleSteps(nodes.length)));
    simulation.force("charge").setTheta(chargeTheta(nodes.length));
    simulation.nodes(nodes);
    const pairs = [];
    for (let cursor = 0; cursor + 1 < links.length; cursor += 2) pairs.push({ source: links[cursor], target: links[cursor + 1] });
    simulation.force("link").links(pairs);
    simulation.alpha(Math.max(simulation.alpha(), alpha));
  }

  function pin(index, x, y) {
    const node = nodes[index];
    if (!node) return;
    node.x = node.fx = x;
    node.y = node.fy = y;
  }

  function unpin(index) {
    const node = nodes[index];
    if (!node) return;
    node.fx = null;
    node.fy = null;
  }

  // "Restore layout": every table may move again.
  function releaseAll(alpha = LAYOUT_ALPHA.update) {
    for (const node of nodes) {
      node.fx = null;
      node.fy = null;
    }
    reheat(alpha);
  }

  function reheat(alpha) {
    simulation.alpha(Math.max(simulation.alpha(), alpha));
  }

  function setAlphaTarget(value) {
    simulation.alphaTarget(value);
    if (value > 0) reheat(value);
  }

  function running() {
    return simulation.alpha() >= LAYOUT_ALPHA.rest || simulation.alphaTarget() > 0;
  }

  // One step; false once the layout is at rest.
  function step() {
    if (!running() || !nodes.length) return false;
    simulation.tick();
    return running();
  }

  function positions(into = new Float32Array(nodes.length * 2)) {
    for (let at = 0; at < nodes.length; at += 1) {
      into[at * 2] = nodes[at].x;
      into[at * 2 + 1] = nodes[at].y;
    }
    return into;
  }

  return {
    setGraph,
    pin,
    unpin,
    releaseAll,
    reheat,
    setAlphaTarget,
    running,
    step,
    positions,
    alpha: () => simulation.alpha(),
    size: () => nodes.length,
  };
}

// The layout's side of the conversation with the page, shared by the worker
// and the main-thread fallback: messages in, a positions callback out.
export function createLayoutHost(post, { now = () => globalThis.performance?.now?.() ?? Date.now(), schedule, cancel, frameMs = 16, budgetMs = 6 } = {}) {
  const layout = createForceLayout();
  let version = 0;
  let timer = 0;

  function send() {
    post({ type: "positions", version, buffer: layout.positions(), alpha: layout.alpha(), running: layout.running() });
  }

  // Small graphs take several steps per frame so they settle quickly; a
  // large one takes one and leaves the rest of the frame.
  function loop() {
    timer = 0;
    const started = now();
    let active = layout.step();
    while (active && now() - started < budgetMs) active = layout.step();
    send();
    if (active) timer = schedule(loop, Math.max(0, frameMs - (now() - started)));
  }

  function wake() {
    if (!timer && layout.running()) timer = schedule(loop, 0);
  }

  function stop() {
    if (timer) cancel(timer);
    timer = 0;
  }

  function receive(message) {
    switch (message?.type) {
      case "graph":
        version = message.version;
        layout.setGraph(message);
        send();
        wake();
        break;
      case "pin":
        layout.pin(message.index, message.x, message.y);
        wake();
        break;
      case "unpin":
        layout.unpin(message.index);
        wake();
        break;
      case "drag":
        layout.setAlphaTarget(message.active ? LAYOUT_ALPHA.drag : 0);
        wake();
        break;
      case "release":
        layout.releaseAll(message.alpha);
        wake();
        break;
      case "stop":
        stop();
        break;
      default:
        break;
    }
  }

  return { receive, stop };
}
