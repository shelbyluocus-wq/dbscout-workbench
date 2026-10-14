// A relation graph as typed arrays, for the canvas renderer and the force
// layout: node order, sizes, sides and problems, line ends and statuses, and
// who is next to whom. Built once per graph so per-frame work only touches
// numbers. Also where tables start before the layout settles: where they
// already were, else beside the tables they are linked to, else in rings by
// distance from the current table.

export const SIDE = Object.freeze({ center: 0, out: 1, in: 2, both: 3, none: 4 });
export const STATUS = Object.freeze({ confirmed: 0, unconfirmed: 1, stale: 2, conflict: 3 });
export const ISSUE = Object.freeze({ none: 0, stale: 1, conflict: 2 });

// Circle sizes grow with how many tables reference a table, on a log scale so
// a table referenced by a thousand others still stands out from one
// referenced by a hundred.
const RADIUS_MIN = 4;
const RADIUS_MAX = 30;
const RADIUS_PER_LOG = 3.4;
const CENTER_RADIUS_MIN = 10;
// Room each table gets when it starts in a ring (about the 60×60 rule of thumb).
export const SEED_CELL = 56;
const RING_GAP = 40;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function canvasNodeRadius(referencedBy, { center = false } = {}) {
  const count = Math.max(0, Number(referencedBy) || 0);
  const radius = Math.min(RADIUS_MAX, RADIUS_MIN + RADIUS_PER_LOG * Math.log1p(count));
  return center ? Math.max(CENTER_RADIUS_MIN, radius) : radius;
}

function statusCode(status) {
  return STATUS[status] ?? STATUS.confirmed;
}

export function buildGraphModel(graph) {
  const nodes = graph?.nodes || [];
  const count = nodes.length;
  const ids = new Array(count);
  const index = new Map();
  const radius = new Float32Array(count);
  const side = new Uint8Array(count);
  const depth = new Int16Array(count);
  const issue = new Uint8Array(count);
  // Status of a self reference plus one; 0 when there is none.
  const loop = new Uint8Array(count);
  const referencedBy = new Uint32Array(count);
  nodes.forEach((node, at) => {
    ids[at] = node.id;
    index.set(node.id, at);
    referencedBy[at] = Math.max(0, Number(node.referencedBy) || 0);
    radius[at] = canvasNodeRadius(node.referencedBy, { center: node.depth === 0 });
    side[at] = SIDE[node.side] ?? SIDE.none;
    depth[at] = Number.isFinite(node.depth) ? node.depth : -1;
    issue[at] = ISSUE[node.issue] ?? ISSUE.none;
    loop[at] = node.selfStatus ? statusCode(node.selfStatus) + 1 : 0;
  });
  const links = (graph?.links || []).filter((link) => index.has(link.source) && index.has(link.target));
  const linkCount = links.length;
  const source = new Uint32Array(linkCount);
  const target = new Uint32Array(linkCount);
  const forward = new Uint8Array(linkCount);
  const backward = new Uint8Array(linkCount);
  const status = new Uint8Array(linkCount);
  const degree = new Uint32Array(count);
  links.forEach((link, at) => {
    source[at] = index.get(link.source);
    target[at] = index.get(link.target);
    forward[at] = link.forward ? 1 : 0;
    backward[at] = link.backward ? 1 : 0;
    status[at] = statusCode(link.status);
    degree[source[at]] += 1;
    degree[target[at]] += 1;
  });
  // Neighbours in compressed rows: those of node i are neighbors[offsets[i] .. offsets[i + 1]).
  const offsets = new Uint32Array(count + 1);
  for (let at = 0; at < count; at += 1) offsets[at + 1] = offsets[at] + degree[at];
  const neighbors = new Uint32Array(linkCount * 2);
  const linkOf = new Uint32Array(linkCount * 2);
  const filled = offsets.slice(0, count);
  for (let at = 0; at < linkCount; at += 1) {
    const from = source[at];
    const to = target[at];
    neighbors[filled[from]] = to;
    linkOf[filled[from]] = at;
    filled[from] += 1;
    neighbors[filled[to]] = from;
    linkOf[filled[to]] = at;
    filled[to] += 1;
  }
  let maxRadius = 0;
  for (let at = 0; at < count; at += 1) maxRadius = Math.max(maxRadius, radius[at]);
  return {
    graph,
    links,
    count,
    maxRadius,
    ids,
    index,
    radius,
    side,
    depth,
    issue,
    loop,
    referencedBy,
    linkCount,
    source,
    target,
    forward,
    backward,
    status,
    degree,
    offsets,
    neighbors,
    linkOf,
    centerIndex: index.get(graph?.center) ?? -1,
  };
}

// The node and its direct neighbours, as a mask over node indices.
export function neighborMask(model, at, mask = new Uint8Array(model.count)) {
  mask.fill(0);
  if (at < 0 || at >= model.count) return mask;
  mask[at] = 1;
  for (let cursor = model.offsets[at]; cursor < model.offsets[at + 1]; cursor += 1) mask[model.neighbors[cursor]] = 1;
  return mask;
}

// ── where tables start ────────────────────────────────────────

// FNV-1a: a stable number per table name, for a jitter that is the same on every opening.
function hashString(text) {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function jitter(id, spread) {
  const hash = hashString(id);
  const angle = ((hash & 0xffff) / 0x10000) * 2 * Math.PI;
  const distance = spread * (0.45 + 0.55 * ((hash >>> 16) / 0x10000));
  return [Math.cos(angle) * distance, Math.sin(angle) * distance];
}

// Hops from `root` over relations in either direction (-1: not reachable),
// with the neighbour each table was first reached from.
function hopsFrom(model, root) {
  const hops = new Int32Array(model.count).fill(-1);
  const parents = new Int32Array(model.count).fill(-1);
  if (root < 0) return { hops, parents };
  const queue = new Uint32Array(model.count);
  let head = 0;
  let tail = 0;
  hops[root] = 0;
  queue[tail++] = root;
  while (head < tail) {
    const at = queue[head++];
    for (let cursor = model.offsets[at]; cursor < model.offsets[at + 1]; cursor += 1) {
      const next = model.neighbors[cursor];
      if (hops[next] !== -1) continue;
      hops[next] = hops[at] + 1;
      parents[next] = at;
      queue[tail++] = next;
    }
  }
  return { hops, parents };
}

const SIDE_ORDER = Object.freeze([1, 0, 2, 1, 3]);

// One ring of tables between two radii: in the order given, around the whole
// circle starting at `start`, alternating between rows so a crowded ring
// stays compact while neighbours in the order stay neighbours on screen.
function placeRing(xy, order, inner, start) {
  const count = order.length;
  if (!count) return inner;
  const outer = Math.sqrt(inner * inner + (count * SEED_CELL * SEED_CELL) / Math.PI);
  const rows = Math.max(1, Math.round((outer - inner) / SEED_CELL));
  const rowStep = rows > 1 ? (outer - inner) / rows : 0;
  order.forEach((at, rank) => {
    const angle = start + (2 * Math.PI * (rank + 0.5)) / count;
    const radius = inner + rowStep * ((rank % rows) + 0.5);
    xy[at * 2] = Math.cos(angle) * radius;
    xy[at * 2 + 1] = Math.sin(angle) * radius;
  });
  return Math.max(outer, inner + SEED_CELL);
}

function angleOf(xy, at) {
  return Math.atan2(xy[at * 2 + 1], xy[at * 2]);
}

// A new picture: the current table (or the busiest one) in the middle, the
// rest in rings by distance from it. Direct neighbours keep the ring layout's
// sides (tables it references to the right), farther tables gather in the
// direction of the table that brought them in, and tables out of reach
// circle outside.
function radialSeeds(model, xy) {
  const root = model.centerIndex >= 0
    ? model.centerIndex
    : model.degree.reduce((best, value, at) => (value > model.degree[best] ? at : best), 0);
  const { hops, parents } = hopsFrom(model, root);
  const rings = [];
  const unreached = [];
  for (let at = 0; at < model.count; at += 1) {
    if (at === root) continue;
    if (hops[at] < 0) unreached.push(at);
    else (rings[hops[at]] ||= []).push(at);
  }
  let radius = SEED_CELL * 1.6;
  rings.forEach((ring, hop) => {
    if (!ring?.length) return;
    let start = 0;
    if (hop === 1) {
      ring.sort((left, right) => SIDE_ORDER[model.side[left]] - SIDE_ORDER[model.side[right]] || model.ids[left].localeCompare(model.ids[right]));
      const outCount = ring.filter((at) => model.side[at] === SIDE.out).length;
      start = -Math.PI * (outCount / ring.length);
    } else {
      const wanted = new Map(ring.map((at) => [at, (angleOf(xy, parents[at]) + 2 * Math.PI) % (2 * Math.PI)]));
      ring.sort((left, right) => wanted.get(left) - wanted.get(right) || model.ids[left].localeCompare(model.ids[right]));
      start = wanted.get(ring[0]) - Math.PI / ring.length;
    }
    radius = placeRing(xy, ring, radius, start) + RING_GAP;
  });
  unreached.sort((left, right) => model.degree[right] - model.degree[left] || model.ids[left].localeCompare(model.ids[right]));
  placeRing(xy, unreached, radius, 0);
}

// Tables not placed yet that are linked to placed ones go to the middle of
// their placed neighbours, a little apart; repeated until nothing is linked.
function growFromPlaced(model, xy, placed) {
  let frontier = [];
  for (let at = 0; at < model.count; at += 1) if (placed[at]) frontier.push(at);
  const queued = new Uint8Array(model.count);
  while (frontier.length) {
    const next = [];
    for (const at of frontier) {
      for (let cursor = model.offsets[at]; cursor < model.offsets[at + 1]; cursor += 1) {
        const candidate = model.neighbors[cursor];
        if (placed[candidate] || queued[candidate]) continue;
        queued[candidate] = 1;
        next.push(candidate);
      }
    }
    for (const at of next) {
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let cursor = model.offsets[at]; cursor < model.offsets[at + 1]; cursor += 1) {
        const neighbor = model.neighbors[cursor];
        if (placed[neighbor] !== 1) continue;
        sumX += xy[neighbor * 2];
        sumY += xy[neighbor * 2 + 1];
        count += 1;
      }
      const [dx, dy] = jitter(model.ids[at], SEED_CELL * 0.8 + model.radius[at]);
      xy[at * 2] = sumX / count + dx;
      xy[at * 2 + 1] = sumY / count + dy;
    }
    // Placed only after the whole wave, so a wave sees just the tables before it.
    for (const at of next) placed[at] = 1;
    frontier = next;
  }
}

// Islands with nothing placed: one busiest table each on a spiral outside
// the drawing, the rest of the island grown around it.
function placeIslands(model, xy, placed) {
  let centerX = 0;
  let centerY = 0;
  let count = 0;
  for (let at = 0; at < model.count; at += 1) {
    if (!placed[at]) continue;
    centerX += xy[at * 2];
    centerY += xy[at * 2 + 1];
    count += 1;
  }
  centerX /= Math.max(1, count);
  centerY /= Math.max(1, count);
  let reach = 0;
  for (let at = 0; at < model.count; at += 1) {
    if (placed[at]) reach = Math.max(reach, Math.hypot(xy[at * 2] - centerX, xy[at * 2 + 1] - centerY));
  }
  const rest = [];
  for (let at = 0; at < model.count; at += 1) if (!placed[at]) rest.push(at);
  rest.sort((left, right) => model.degree[right] - model.degree[left] || model.ids[left].localeCompare(model.ids[right]));
  let slot = 0;
  for (const at of rest) {
    if (placed[at]) continue;
    const angle = slot * GOLDEN_ANGLE;
    const radius = reach + SEED_CELL * (1.5 + 1.2 * Math.sqrt(slot));
    xy[at * 2] = centerX + Math.cos(angle) * radius;
    xy[at * 2 + 1] = centerY + Math.sin(angle) * radius;
    placed[at] = 1;
    slot += 1;
    growFromPlaced(model, xy, placed);
  }
}

/**
 * Starting positions as [x0, y0, x1, y1, …]. `known` maps table ids to
 * [x, y] where they were last drawn; those stay put and new tables grow out
 * of them. Without any, the picture starts in rings around the current table.
 */
export function seedPositions(model, known = null) {
  const xy = new Float32Array(model.count * 2);
  const placed = new Uint8Array(model.count);
  let placedCount = 0;
  if (known?.size) {
    for (let at = 0; at < model.count; at += 1) {
      const point = known.get(model.ids[at]);
      if (!point) continue;
      xy[at * 2] = point[0];
      xy[at * 2 + 1] = point[1];
      placed[at] = 1;
      placedCount += 1;
    }
  }
  if (!placedCount) {
    radialSeeds(model, xy);
    return xy;
  }
  growFromPlaced(model, xy, placed);
  placeIslands(model, xy, placed);
  return xy;
}

// The box around every table center, or null without tables.
export function positionsBox(xy, count, pad = 0) {
  if (!count) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let at = 0; at < count; at += 1) {
    const x = xy[at * 2];
    const y = xy[at * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}
