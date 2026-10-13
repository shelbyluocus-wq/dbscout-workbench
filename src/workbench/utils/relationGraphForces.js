// Spring physics for the relation graph. Every table is tied to its ring
// position and every relation line to its ring length, so the picture at rest
// is always the deterministic ring layout. Dragging a table pins it under the
// pointer; its neighbours are pulled along through the line springs, and on
// release everything swings back. Collision keeps circles from overlapping
// while things move.

const HOME_STRENGTH = 0.045;
const LINK_STRENGTH = 0.06;
// Share of each node's velocity lost per tick.
const VELOCITY_DECAY = 0.32;
const COLLIDE_PADDING = 4;
const COLLIDE_STRENGTH = 0.5;
// Below this movement per tick (graph units) the picture counts as settled.
export const REST_SPEED = 0.02;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {{ nodes: Array<{ id: string, x?: number, y?: number, homeX: number, homeY: number, radius?: number }>,
 *           links: Array<{ source: string, target: string }> }} graph
 */
export function createGraphSimulation({ nodes = [], links = [] } = {}) {
  const states = new Map();
  for (const node of nodes) {
    const homeX = finite(node.homeX);
    const homeY = finite(node.homeY);
    states.set(node.id, {
      id: node.id,
      x: finite(node.x, homeX),
      y: finite(node.y, homeY),
      vx: 0,
      vy: 0,
      homeX,
      homeY,
      radius: Math.max(0, finite(node.radius)),
      pinned: false,
    });
  }
  const list = [...states.values()];
  const springs = [];
  for (const link of links) {
    const a = states.get(link.source);
    const b = states.get(link.target);
    if (!a || !b || a === b) continue;
    springs.push({ a, b, rest: Math.hypot(b.homeX - a.homeX, b.homeY - a.homeY) });
  }
  let pinnedCount = 0;

  function pull(state, fx, fy) {
    if (state.pinned) return;
    state.vx += fx;
    state.vy += fy;
  }

  function applySprings() {
    for (const { a, b, rest } of springs) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1e-6;
      const force = ((distance - rest) / distance) * LINK_STRENGTH * 0.5;
      pull(a, dx * force, dy * force);
      pull(b, -dx * force, -dy * force);
    }
  }

  function applyCollisions() {
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        const minimum = a.radius + b.radius + COLLIDE_PADDING;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const squared = dx * dx + dy * dy;
        if (squared >= minimum * minimum) continue;
        let distance = Math.sqrt(squared);
        if (distance < 1e-6) {
          // Coincident circles: separate them along a stable direction.
          dx = 1;
          dy = 0;
          distance = 1;
        }
        const push = ((minimum - distance) / distance) * COLLIDE_STRENGTH * 0.5;
        pull(a, -dx * push, -dy * push);
        pull(b, dx * push, dy * push);
      }
    }
  }

  // Advances one step; returns whether anything is still moving.
  function tick() {
    for (const state of list) pull(state, (state.homeX - state.x) * HOME_STRENGTH, (state.homeY - state.y) * HOME_STRENGTH);
    applySprings();
    applyCollisions();
    let fastest = 0;
    for (const state of list) {
      if (state.pinned) {
        state.vx = 0;
        state.vy = 0;
        continue;
      }
      state.vx *= 1 - VELOCITY_DECAY;
      state.vy *= 1 - VELOCITY_DECAY;
      state.x += state.vx;
      state.y += state.vy;
      fastest = Math.max(fastest, Math.abs(state.vx), Math.abs(state.vy));
    }
    return pinnedCount > 0 || fastest >= REST_SPEED;
  }

  function pin(id, x, y) {
    const state = states.get(id);
    if (!state) return;
    if (!state.pinned) pinnedCount += 1;
    state.pinned = true;
    state.x = finite(x, state.x);
    state.y = finite(y, state.y);
    state.vx = 0;
    state.vy = 0;
  }

  function unpin(id) {
    const state = states.get(id);
    if (!state?.pinned) return;
    state.pinned = false;
    pinnedCount -= 1;
  }

  function snapshot() {
    return new Map(list.map((state) => [state.id, { x: state.x, y: state.y }]));
  }

  return { tick, pin, unpin, snapshot, has: (id) => states.has(id) };
}

/**
 * Where each table starts when the graph changes: tables already drawn keep
 * their place, new ones grow out of the table that brought them in, and with
 * nothing to animate from they start at rest.
 */
export function startPositions(nodes, homes, previous) {
  const starts = new Map();
  for (const node of nodes) {
    const home = homes.get(node.id) || { x: 0, y: 0 };
    const kept = previous?.get(node.id);
    const parent = node.parent ? previous?.get(node.parent) : null;
    starts.set(node.id, kept || parent || (previous?.size ? previous.get(nodes[0]?.id) : null) || home);
  }
  return starts;
}
