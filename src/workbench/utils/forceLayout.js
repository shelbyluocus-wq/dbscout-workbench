// The force layout behind large relation graphs, after Obsidian's graph
// view: every table pushes the others away, relations pull linked tables
// together, a gentle pull keeps the picture centred and circles never
// overlap. The same engine runs in the layout worker or, where workers are
// unavailable, on the main thread in small slices. Tables the user dragged
// stay where they were dropped until the layout is restored.
//
// Tables keep generous room around them, so the whole picture reads calmly
// and zooming in brings the detail. The picture takes the shape of the view
// it is drawn in: a wide view gets a wide picture rather than a ball with
// empty sides.
//
// Dragging moves one table and the small tables hanging on it; every other
// table is held where it is for the drag and the moment after, so the
// picture never turns or shivers around the pointer.
import { forceLink, forceSimulation } from "d3-force";
import { forceCollideFast, forceManyBodyFast, forcePull } from "./fastForces.js";
import { LAYOUT_ALPHA } from "./forceLayoutAlpha.js";

export { LAYOUT_ALPHA };

// Tuned for circles of 4–30 units (see canvasNodeRadius).
const LINK_DISTANCE = 54;
const CHARGE = -590;
const CHARGE_THETA = 0.9;
// Tables farther apart than this ignore each other, so small islands settle
// beside the main picture instead of being pushed far out by all of it.
const CHARGE_RANGE = 1280;
// Room kept around every circle: no two tables come closer than twice this.
const COLLIDE_PADDING = 20;
const CENTER_STRENGTH = 0.05;
// The picture's shape: while the layout runs, the pull toward the middle is
// rebalanced between across and up-down until the tables spread about as
// wide, for their height, as the view. How the graph is linked decides how
// much rebalancing that takes, so it is measured, not assumed; a single
// busy table with its fan stays rounder (the limit).
const SHAPE_GAIN = 0.15;
const SHAPE_LIMIT = Math.log(6);
const SHAPE_MIN_TABLES = 12;
// Neighbours with at most this many relations follow a dragged table.
const FOLLOW_MAX_LINKS = 3;
const VELOCITY_DECAY = 0.4;
// Followers glide behind the pointer rather than swing past it.
const DRAG_VELOCITY_DECAY = 0.6;

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
  let pairs = [];
  // Tables held in place for the current drag, and whether it is still going on.
  let held = [];
  let dragging = false;
  // The view's width-to-height ratio, and half the log of how much harder
  // the pull toward the middle is up-down than across.
  let aspect = 1;
  let squeeze = 0;
  const simulation = forceSimulation([])
    .stop()
    .randomSource(seededSource())
    .velocityDecay(VELOCITY_DECAY)
    .alphaMin(LAYOUT_ALPHA.rest)
    .force("charge", forceManyBodyFast({ strength: CHARGE, theta: CHARGE_THETA, distanceMax: CHARGE_RANGE }))
    .force("link", forceLink([]).distance((link) => LINK_DISTANCE + link.source.r + link.target.r))
    .force("collide", forceCollideFast({ radius: (node) => node.r + COLLIDE_PADDING }))
    .force("pull", forcePull({ x: CENTER_STRENGTH, y: CENTER_STRENGTH }));
  simulation.alpha(0);

  function applySqueeze() {
    simulation.force("pull").setStrength(CENTER_STRENGTH / Math.exp(squeeze), CENTER_STRENGTH * Math.exp(squeeze));
  }

  // A new picture, or a view of another shape, starts from the balance that
  // suits loosely linked tables; a changed graph in the same view keeps
  // what the layout has found so far.
  function setShape(next, restart) {
    const value = Number.isFinite(next) && next > 0 ? next : 1;
    if (restart || value !== aspect) squeeze = Math.log(value) / 2;
    aspect = value;
    applySqueeze();
  }

  // Measures how wide the tables spread for their height and moves the
  // balance toward the view's shape: most while the layout is half settled,
  // nothing while the picture first unfolds or once it rests, and nothing
  // while tables are held for a drag.
  function steerShape() {
    if (held.length || dragging || nodes.length < SHAPE_MIN_TABLES) return;
    const alpha = simulation.alpha();
    const weight = 4 * alpha * (1 - alpha);
    if (!(weight > 0)) return;
    let sumX = 0;
    let sumY = 0;
    for (const node of nodes) {
      sumX += node.x;
      sumY += node.y;
    }
    const meanX = sumX / nodes.length;
    const meanY = sumY / nodes.length;
    let spreadX = 0;
    let spreadY = 0;
    for (const node of nodes) {
      spreadX += (node.x - meanX) ** 2;
      spreadY += (node.y - meanY) ** 2;
    }
    if (!(spreadX > 0) || !(spreadY > 0)) return;
    const error = Math.log(aspect) - Math.log(spreadX / spreadY) / 2;
    squeeze = Math.min(SHAPE_LIMIT, Math.max(-SHAPE_LIMIT, squeeze + SHAPE_GAIN * weight * error));
    applySqueeze();
  }

  /**
   * Replaces the graph. `ids` names the tables in order; `seeds` holds
   * [x, y] pairs where new tables start (tables already known keep their
   * place and speed unless `reset`); `links` holds index pairs; `fixed` holds
   * [index, x, y] triples for tables the user put somewhere; `aspect` is the
   * width-to-height ratio of the view the picture should fill.
   */
  function setGraph({ ids, seeds, radius, links, fixed, alpha = LAYOUT_ALPHA.update, reset = false, aspect: viewAspect = 1 }) {
    releaseHeld();
    dragging = false;
    simulation.alphaTarget(0);
    setShape(viewAspect, reset);
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
    pairs = [];
    for (const node of nodes) node.degree = 0;
    for (let cursor = 0; cursor + 1 < links.length; cursor += 2) {
      pairs.push({ source: links[cursor], target: links[cursor + 1] });
      if (nodes[links[cursor]]) nodes[links[cursor]].degree += 1;
      if (nodes[links[cursor + 1]]) nodes[links[cursor + 1]].degree += 1;
    }
    simulation.force("link").links(pairs);
    // A changed graph carries on settling; a new picture moves only as much
    // as it asks, so one remembered at rest stays at rest even when the
    // previous picture had not settled yet.
    simulation.alpha(reset ? alpha : Math.max(simulation.alpha(), alpha));
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

  // Every table but `movers` and the small tables hanging on them (a few
  // relations at most) stays exactly where it is, with no speed left over.
  function holdAllBut(movers) {
    const moving = new Set(movers);
    const follows = new Set(movers);
    // Direct neighbours only, whatever order the relations come in.
    for (const link of pairs) {
      if (moving.has(link.source) && link.target.degree <= FOLLOW_MAX_LINKS) follows.add(link.target);
      if (moving.has(link.target) && link.source.degree <= FOLLOW_MAX_LINKS) follows.add(link.source);
    }
    for (const node of nodes) {
      node.vx = 0;
      node.vy = 0;
      if (follows.has(node) || node.fx != null || node.fy != null) continue;
      node.fx = node.x;
      node.fy = node.y;
      held.push(node);
    }
  }

  // "Restore layout": the tables the user put somewhere may move again. A
  // picture at rest lets just them (and their small tables) find their way
  // back; one still settling simply carries on.
  function releaseAll(alpha = LAYOUT_ALPHA.update) {
    releaseHeld();
    dragging = false;
    simulation.alphaTarget(0);
    const pinned = nodes.filter((node) => node.fx != null || node.fy != null);
    for (const node of pinned) {
      node.fx = null;
      node.fy = null;
    }
    if (!pinned.length) return;
    if (!running()) holdAllBut(pinned);
    reheat(alpha);
  }

  // A drag starts: the dragged table moves, and so do the small tables that
  // hang on it; everything else holds still.
  function beginDrag(index) {
    const dragged = nodes[index];
    if (!dragged) return;
    releaseHeld();
    dragging = true;
    holdAllBut([dragged]);
    simulation.velocityDecay(DRAG_VELOCITY_DECAY);
    simulation.alphaTarget(LAYOUT_ALPHA.drag);
    reheat(LAYOUT_ALPHA.drag);
  }

  // The drag ends: its followers come to rest while the others stay held;
  // once all is still the hold is let go without moving anything.
  function endDrag() {
    dragging = false;
    simulation.alphaTarget(0);
    simulation.alpha(Math.min(simulation.alpha(), LAYOUT_ALPHA.dragSettle));
  }

  function releaseHeld() {
    for (const node of held) {
      node.fx = null;
      node.fy = null;
    }
    held = [];
    simulation.velocityDecay(VELOCITY_DECAY);
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
    steerShape();
    const active = running();
    if (!active && !dragging && held.length) releaseHeld();
    return active;
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
    beginDrag,
    endDrag,
    held: () => held.length,
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
        if (message.active) layout.beginDrag(message.index);
        else layout.endDrag();
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
