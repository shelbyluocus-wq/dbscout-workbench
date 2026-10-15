// d3-force compatible forces for graphs of thousands of tables: many-body
// repulsion with a flat Barnes–Hut quadtree and circle collision with a
// uniform grid, both over typed arrays, and a pull toward the middle whose
// across and up-down strengths can change every step. They follow d3's
// forceManyBody, forceCollide and forceX/forceY formulas (including
// predicted positions for collisions) but avoid per-node closures, objects
// and rebuilt arrays, which is where d3 spends its time at this size.

const MAX_DEPTH = 32;
const INTERNAL = -2;
const EMPTY = -1;

// A tiny deterministic nudge for tables that sit exactly on top of each other.
function jiggler() {
  let state = 7;
  return () => {
    state = (1664525 * state + 1013904223) % 4294967296;
    return (state / 4294967296 - 0.5) * 1e-6;
  };
}

/**
 * Every table pushes every other away, by d3's formula
 * `v += d * strength * alpha / |d|²`; distant groups act through their
 * centre of mass once a cell is small enough for its distance (theta).
 */
export function forceManyBodyFast({ strength = -30, theta = 0.9, distanceMin = 1, distanceMax = Infinity } = {}) {
  let nodes = [];
  let xs = new Float64Array(0);
  let ys = new Float64Array(0);
  let next = new Int32Array(0);
  let capacity = 0;
  let cellX = new Float64Array(0);
  let cellY = new Float64Array(0);
  let cellSize = new Float64Array(0);
  let mass = new Float64Array(0);
  let sumX = new Float64Array(0);
  let sumY = new Float64Array(0);
  let head = new Int32Array(0);
  let kids = new Int32Array(0);
  let cells = 0;
  let stack = new Int32Array(64);
  let theta2 = theta * theta;
  const distanceMin2 = distanceMin * distanceMin;
  const distanceMax2 = distanceMax * distanceMax;
  const jiggle = jiggler();

  function ensureCells(count) {
    if (count <= capacity) return;
    const grown = Math.max(count, capacity * 2, 64);
    const copy = (Kind, from, size) => {
      const to = new Kind(size);
      to.set(from.subarray(0, Math.min(from.length, size)));
      return to;
    };
    cellX = copy(Float64Array, cellX, grown);
    cellY = copy(Float64Array, cellY, grown);
    cellSize = copy(Float64Array, cellSize, grown);
    mass = copy(Float64Array, mass, grown);
    sumX = copy(Float64Array, sumX, grown);
    sumY = copy(Float64Array, sumY, grown);
    head = copy(Int32Array, head, grown);
    const children = new Int32Array(grown * 4);
    children.set(kids.subarray(0, Math.min(kids.length, grown * 4)));
    kids = children;
    capacity = grown;
  }

  function newCell(x, y, size) {
    ensureCells(cells + 1);
    const cell = cells++;
    cellX[cell] = x;
    cellY[cell] = y;
    cellSize[cell] = size;
    mass[cell] = 0;
    sumX[cell] = 0;
    sumY[cell] = 0;
    head[cell] = EMPTY;
    kids.fill(EMPTY, cell * 4, cell * 4 + 4);
    return cell;
  }

  function childFor(cell, x, y) {
    const half = cellSize[cell] / 2;
    const right = x >= cellX[cell] + half ? 1 : 0;
    const bottom = y >= cellY[cell] + half ? 1 : 0;
    const slot = cell * 4 + right + bottom * 2;
    if (kids[slot] === EMPTY) kids[slot] = newCell(cellX[cell] + right * half, cellY[cell] + bottom * half, half);
    return kids[slot];
  }

  function insert(point) {
    const x = xs[point];
    const y = ys[point];
    let cell = 0;
    for (let depth = 0; ; depth += 1) {
      mass[cell] += 1;
      sumX[cell] += x;
      sumY[cell] += y;
      if (head[cell] === EMPTY) {
        head[cell] = point;
        next[point] = EMPTY;
        return;
      }
      if (head[cell] !== INTERNAL) {
        const other = head[cell];
        if ((xs[other] === x && ys[other] === y) || depth >= MAX_DEPTH) {
          next[point] = other;
          head[cell] = point;
          return;
        }
        // Split: the points already here (all at one spot) move one level down.
        const child = childFor(cell, xs[other], ys[other]);
        head[child] = other;
        mass[child] = mass[cell] - 1;
        sumX[child] = sumX[cell] - x;
        sumY[child] = sumY[cell] - y;
        head[cell] = INTERNAL;
      }
      cell = childFor(cell, x, y);
    }
  }

  function build() {
    const count = nodes.length;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let at = 0; at < count; at += 1) {
      const x = nodes[at].x;
      const y = nodes[at].y;
      xs[at] = x;
      ys[at] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    cells = 0;
    ensureCells(count * 2 + 16);
    newCell(minX, minY, Math.max(maxX - minX, maxY - minY, 1) * 1.0001);
    for (let at = 0; at < count; at += 1) insert(at);
  }

  function push(cell, top) {
    if (top >= stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
    }
    stack[top] = cell;
    return top + 1;
  }

  function apply(point, scale) {
    const x = xs[point];
    const y = ys[point];
    let vx = 0;
    let vy = 0;
    let top = push(0, 0);
    while (top > 0) {
      const cell = stack[--top];
      if (!mass[cell]) continue;
      if (head[cell] !== INTERNAL) {
        for (let other = head[cell]; other !== EMPTY; other = next[other]) {
          if (other === point) continue;
          let dx = xs[other] - x;
          let dy = ys[other] - y;
          let l = dx * dx + dy * dy;
          if (l >= distanceMax2) continue;
          if (dx === 0) {
            dx = jiggle();
            l += dx * dx;
          }
          if (dy === 0) {
            dy = jiggle();
            l += dy * dy;
          }
          if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l);
          vx += (dx * scale) / l;
          vy += (dy * scale) / l;
        }
        continue;
      }
      const dx = sumX[cell] / mass[cell] - x;
      const dy = sumY[cell] / mass[cell] - y;
      let l = dx * dx + dy * dy;
      const size = cellSize[cell];
      if ((size * size) / theta2 < l) {
        if (l < distanceMax2) {
          if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l);
          vx += (dx * scale * mass[cell]) / l;
          vy += (dy * scale * mass[cell]) / l;
        }
        continue;
      }
      for (let slot = cell * 4; slot < cell * 4 + 4; slot += 1) {
        if (kids[slot] !== EMPTY) top = push(kids[slot], top);
      }
    }
    nodes[point].vx += vx;
    nodes[point].vy += vy;
  }

  function force(alpha) {
    const count = nodes.length;
    if (count < 2) return;
    build();
    const scale = strength * alpha;
    // A fixed table ends the step where it is held, whatever pushes it.
    for (let at = 0; at < count; at += 1) {
      if (nodes[at].fx == null || nodes[at].fy == null) apply(at, scale);
    }
  }

  force.initialize = (list) => {
    nodes = list;
    xs = new Float64Array(list.length);
    ys = new Float64Array(list.length);
    next = new Int32Array(list.length);
  };

  // Larger theta: coarser and quicker (d3's Barnes–Hut accuracy).
  force.setTheta = (value) => {
    theta2 = value * value;
  };

  return force;
}

/**
 * Circles may not overlap: overlapping pairs move apart (by d3's
 * forceCollide formula, the smaller circle more), found through a grid of
 * cells as wide as the largest circle.
 */
export function forceCollideFast({ radius = (node) => node.r || 1, strength = 1 } = {}) {
  let nodes = [];
  let radii = new Float64Array(0);
  let px = new Float64Array(0);
  let py = new Float64Array(0);
  let cellOf = new Int32Array(0);
  let order = new Int32Array(0);
  let starts = new Int32Array(0);
  const jiggle = jiggler();

  function force() {
    const count = nodes.length;
    if (count < 2) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let largest = 0;
    for (let at = 0; at < count; at += 1) {
      const node = nodes[at];
      const x = node.x + node.vx;
      const y = node.y + node.vy;
      px[at] = x;
      py[at] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (radii[at] > largest) largest = radii[at];
    }
    // Cells as wide as the widest pair; coarser when the picture is very spread out.
    let size = Math.max(largest * 2, 1e-6);
    let columns = Math.floor((maxX - minX) / size) + 1;
    let rows = Math.floor((maxY - minY) / size) + 1;
    while (columns * rows > count * 4 + 64) {
      size *= 2;
      columns = Math.floor((maxX - minX) / size) + 1;
      rows = Math.floor((maxY - minY) / size) + 1;
    }
    const total = columns * rows;
    if (starts.length < total + 1) starts = new Int32Array(total + 1);
    else starts.fill(0, 0, total + 1);
    for (let at = 0; at < count; at += 1) {
      const cell = Math.floor((px[at] - minX) / size) + Math.floor((py[at] - minY) / size) * columns;
      cellOf[at] = cell;
      starts[cell + 1] += 1;
    }
    for (let cell = 0; cell < total; cell += 1) starts[cell + 1] += starts[cell];
    const fill = starts.slice(0, total);
    for (let at = 0; at < count; at += 1) order[fill[cellOf[at]]++] = at;

    for (let at = 0; at < count; at += 1) {
      const node = nodes[at];
      const atFixed = node.fx != null && node.fy != null;
      const ri = radii[at];
      const ri2 = ri * ri;
      const column = cellOf[at] % columns;
      const row = (cellOf[at] - column) / columns;
      for (let dy = -1; dy <= 1; dy += 1) {
        const r = row + dy;
        if (r < 0 || r >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const c = column + dx;
          if (c < 0 || c >= columns) continue;
          const cell = c + r * columns;
          for (let cursor = starts[cell]; cursor < starts[cell + 1]; cursor += 1) {
            const other = order[cursor];
            if (other <= at) continue;
            // Two held tables cannot push each other anywhere.
            if (atFixed && nodes[other].fx != null && nodes[other].fy != null) continue;
            const rj = radii[other];
            const reach = ri + rj;
            let x = px[at] - px[other];
            let y = py[at] - py[other];
            let l = x * x + y * y;
            if (l >= reach * reach) continue;
            if (x === 0) {
              x = jiggle();
              l += x * x;
            }
            if (y === 0) {
              y = jiggle();
              l += y * y;
            }
            l = Math.sqrt(l);
            const push = ((reach - l) / l) * strength;
            x *= push;
            y *= push;
            const rj2 = rj * rj;
            const share = rj2 / (ri2 + rj2);
            const target = nodes[other];
            node.vx += x * share;
            node.vy += y * share;
            target.vx -= x * (1 - share);
            target.vy -= y * (1 - share);
          }
        }
      }
    }
  }

  force.initialize = (list) => {
    nodes = list;
    radii = new Float64Array(list.length);
    px = new Float64Array(list.length);
    py = new Float64Array(list.length);
    cellOf = new Int32Array(list.length);
    order = new Int32Array(list.length);
    list.forEach((node, at) => {
      radii[at] = Number(radius(node)) || 0;
    });
  };

  return force;
}

/**
 * A pull toward the origin, like d3's forceX(0) and forceY(0) with one
 * strength each (`v -= position * strength * alpha`); `setStrength` changes
 * them for the next step without rebuilding anything.
 */
export function forcePull({ x = 0.1, y = 0.1 } = {}) {
  let nodes = [];
  let strengthX = x;
  let strengthY = y;

  function force(alpha) {
    const kx = strengthX * alpha;
    const ky = strengthY * alpha;
    for (const node of nodes) {
      node.vx -= node.x * kx;
      node.vy -= node.y * ky;
    }
  }

  force.initialize = (list) => {
    nodes = list;
  };

  force.setStrength = (nextX, nextY) => {
    strengthX = nextX;
    strengthY = nextY;
  };

  return force;
}
