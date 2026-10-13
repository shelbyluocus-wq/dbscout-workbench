// The relation graph around one config table: which tables to show for a
// depth and direction, how their relations merge into lines, how large each
// node is, and where it sits. Pure functions over the backend graph payload
// (`{ edges, tables }`), so the component only draws.

export const GRAPH_MAX_NODES = 60;
export const GRAPH_MAX_DEPTH = 2;

const STATUS_RANK = Object.freeze({ confirmed: 0, unconfirmed: 1, stale: 2, conflict: 3 });
const PAIR_SEPARATOR = "\u001f";

const NODE_RADIUS_MIN = 6;
const NODE_RADIUS_MAX = 16;
const CENTER_RADIUS_MIN = 11;
const FIRST_RING_MIN = 92;
const RING_GAP = 84;
const NODE_SPACING = 40;
const LABEL_MAX_CHARS = 18;
const LABEL_CHAR_WIDTH = 6.2;
const LABEL_OFFSET = 12;
const BOUNDS_PADDING = 18;

function lower(name) {
  return String(name || "").trim().toLowerCase();
}

function statusRank(status) {
  return STATUS_RANK[status] ?? STATUS_RANK.unconfirmed;
}

export function worseStatus(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return statusRank(right) > statusRank(left) ? right : left;
}

// Rejected relations are not relations; they never reach the graph.
function activeEdges(graph) {
  const edges = [];
  for (const edge of graph?.edges || []) {
    if (!edge || edge.status === "rejected") continue;
    const source = lower(edge.sourceTable);
    const target = lower(edge.targetTable);
    if (!source || !target) continue;
    edges.push({ ...edge, sourceTable: source, targetTable: target });
  }
  return edges;
}

function groupBy(edges, field) {
  const groups = new Map();
  for (const edge of edges) {
    const key = edge[field];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  return groups;
}

// How many other tables point at each table, across the whole database.
function referenceCounts(edges) {
  const sources = new Map();
  for (const edge of edges) {
    if (edge.sourceTable === edge.targetTable) continue;
    if (!sources.has(edge.targetTable)) sources.set(edge.targetTable, new Set());
    sources.get(edge.targetTable).add(edge.sourceTable);
  }
  return new Map([...sources].map(([table, set]) => [table, set.size]));
}

export function nodeRadius(referencedBy, { center = false } = {}) {
  const count = Math.max(0, Number(referencedBy) || 0);
  const radius = Math.min(NODE_RADIUS_MAX, Math.max(NODE_RADIUS_MIN, NODE_RADIUS_MIN + 2.2 * Math.sqrt(count)));
  return center ? Math.max(CENTER_RADIUS_MIN, radius) : radius;
}

function normalizeOptions(options = {}) {
  const depth = Math.min(GRAPH_MAX_DEPTH, Math.max(1, Math.round(Number(options.depth) || 1)));
  let outgoing = options.outgoing !== false;
  let incoming = options.incoming !== false;
  if (!outgoing && !incoming) outgoing = incoming = true;
  const maxNodes = Math.max(2, Number(options.maxNodes) || GRAPH_MAX_NODES);
  return { depth, outgoing, incoming, maxNodes };
}

function byName(left, right) {
  return left.localeCompare(right);
}

// Tables reached from `center` within `depth` steps along the enabled
// directions. Depth-1 tables record which side of the center they are on;
// deeper ones inherit their parent's side so the layout keeps them together.
function reachTables(center, bySource, byTarget, options) {
  const nodes = new Map([[center, { id: center, depth: 0, side: "center", parent: null }]]);
  const hidden = new Set();
  let frontier = [center];
  for (let depth = 1; depth <= options.depth && frontier.length; depth += 1) {
    const next = [];
    const visit = (table, parent, side) => {
      const known = nodes.get(table);
      if (known) {
        if (depth === 1 && known.depth === 1 && known.side !== side) known.side = "both";
        return;
      }
      if (nodes.size >= options.maxNodes) {
        hidden.add(table);
        return;
      }
      const node = { id: table, depth, side: depth === 1 ? side : nodes.get(parent).side, parent };
      nodes.set(table, node);
      next.push(table);
    };
    for (const table of frontier) {
      if (options.outgoing) {
        const targets = (bySource.get(table) || []).map((edge) => edge.targetTable).sort(byName);
        for (const target of targets) visit(target, table, "out");
      }
      if (options.incoming) {
        const sources = (byTarget.get(table) || []).map((edge) => edge.sourceTable).sort(byName);
        for (const source of sources) visit(source, table, "in");
      }
    }
    frontier = next;
  }
  for (const id of nodes.keys()) hidden.delete(id);
  return { nodes, hidden: hidden.size };
}

// Every relation between two shown tables becomes part of one line per table
// pair; arrows say which way the references go.
function mergeLinks(edges, nodes) {
  const links = new Map();
  const selfLoops = new Map();
  for (const edge of edges) {
    const { sourceTable: source, targetTable: target } = edge;
    if (!nodes.has(source) || !nodes.has(target)) continue;
    if (source === target) {
      selfLoops.set(source, worseStatus(selfLoops.get(source), edge.status));
      continue;
    }
    const [first, second] = source < target ? [source, target] : [target, source];
    const id = `${first}${PAIR_SEPARATOR}${second}`;
    let link = links.get(id);
    if (!link) {
      link = { id, source: first, target: second, forward: false, backward: false, status: "", relations: [] };
      links.set(id, link);
    }
    if (source === first) link.forward = true;
    else link.backward = true;
    link.status = worseStatus(link.status, edge.status);
    link.relations.push(edge);
  }
  for (const link of links.values()) link.relations.sort((left, right) => left.id.localeCompare(right.id));
  return { links: [...links.values()].sort((left, right) => left.id.localeCompare(right.id)), selfLoops };
}

export function localRelationGraph(graph, centerTable, options = {}) {
  const center = lower(centerTable);
  if (!center) return null;
  const settings = normalizeOptions(options);
  const edges = activeEdges(graph);
  const { nodes, hidden } = reachTables(center, groupBy(edges, "sourceTable"), groupBy(edges, "targetTable"), settings);
  const { links, selfLoops } = mergeLinks(edges, nodes);
  const counts = referenceCounts(edges);
  const issues = new Map();
  for (const link of links) {
    for (const end of [link.source, link.target]) issues.set(end, worseStatus(issues.get(end), link.status));
  }
  for (const [table, status] of selfLoops) issues.set(table, worseStatus(issues.get(table), status));
  const shown = [...nodes.values()].map((node) => {
    const referencedBy = counts.get(node.id) || 0;
    const issue = issues.get(node.id);
    return {
      ...node,
      referencedBy,
      radius: nodeRadius(referencedBy, { center: node.depth === 0 }),
      selfStatus: selfLoops.get(node.id) || "",
      issue: issue === "stale" || issue === "conflict" ? issue : "",
    };
  });
  return { center, nodes: shown, links, hidden, options: settings };
}

const SIDE_ORDER = Object.freeze({ out: 0, both: 1, in: 2 });

function ringRadius(count, minimum) {
  return Math.max(minimum, (count * NODE_SPACING) / (2 * Math.PI));
}

// Outgoing tables sit to the right of the center, incoming ones to the
// left, tables in both directions between them.
function firstRingAngles(nodes) {
  const ordered = [...nodes].sort((left, right) =>
    SIDE_ORDER[left.side] - SIDE_ORDER[right.side] || byName(left.id, right.id));
  const count = ordered.length;
  const step = (2 * Math.PI) / Math.max(1, count);
  const outCount = ordered.filter((node) => node.side === "out").length;
  const start = outCount > 0
    ? -((outCount - 1) / 2) * step
    : Math.PI - ((count - 1) / 2) * step;
  return new Map(ordered.map((node, index) => [node.id, start + index * step]));
}

function normalizeAngle(angle) {
  const turn = 2 * Math.PI;
  return ((angle % turn) + turn) % turn;
}

// Second-ring tables follow their parents around the circle.
function secondRingAngles(nodes, parentAngles) {
  if (!nodes.length) return new Map();
  const ordered = [...nodes].sort((left, right) =>
    normalizeAngle(parentAngles.get(left.parent) ?? 0) - normalizeAngle(parentAngles.get(right.parent) ?? 0) ||
    byName(left.id, right.id));
  const step = (2 * Math.PI) / ordered.length;
  const firstParent = ordered[0].parent;
  const firstGroup = ordered.filter((node) => node.parent === firstParent).length;
  const start = (parentAngles.get(firstParent) ?? 0) - ((firstGroup - 1) / 2) * step;
  return new Map(ordered.map((node, index) => [node.id, start + index * step]));
}

export function graphLabel(text) {
  const value = String(text || "");
  return value.length > LABEL_MAX_CHARS ? `${value.slice(0, LABEL_MAX_CHARS - 1)}…` : value;
}

// Fixed rings: the picture at rest is the same every time a table opens, so
// users can learn it. Dragging only disturbs it temporarily (see
// relationGraphForces.js).
export function layoutRelationGraph(local, labelFor = (id) => id) {
  if (!local) return null;
  const first = local.nodes.filter((node) => node.depth === 1);
  const second = local.nodes.filter((node) => node.depth === 2);
  const firstRadius = ringRadius(first.length, FIRST_RING_MIN);
  const secondRadius = ringRadius(second.length, firstRadius + RING_GAP);
  const angles = firstRingAngles(first);
  const outerAngles = secondRingAngles(second, angles);
  const positions = new Map();
  let bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  for (const node of local.nodes) {
    let x = 0;
    let y = 0;
    if (node.depth === 1) {
      x = firstRadius * Math.cos(angles.get(node.id));
      y = firstRadius * Math.sin(angles.get(node.id));
    } else if (node.depth === 2) {
      x = secondRadius * Math.cos(outerAngles.get(node.id));
      y = secondRadius * Math.sin(outerAngles.get(node.id));
    }
    const label = graphLabel(labelFor(node.id));
    const halfLabel = (label.length * LABEL_CHAR_WIDTH) / 2;
    positions.set(node.id, { x, y, label, labelY: y + node.radius + LABEL_OFFSET });
    bounds = {
      minX: Math.min(bounds.minX, x - Math.max(node.radius, halfLabel)),
      maxX: Math.max(bounds.maxX, x + Math.max(node.radius, halfLabel)),
      minY: Math.min(bounds.minY, y - node.radius),
      maxY: Math.max(bounds.maxY, y + node.radius + LABEL_OFFSET + 4),
    };
  }
  const box = {
    x: bounds.minX - BOUNDS_PADDING,
    y: bounds.minY - BOUNDS_PADDING,
    width: bounds.maxX - bounds.minX + BOUNDS_PADDING * 2,
    height: bounds.maxY - bounds.minY + BOUNDS_PADDING * 2,
  };
  return { positions, bounds: box };
}

// Tables directly linked to `id` among the shown ones, plus `id` itself.
export function graphNeighbors(local, id) {
  const neighbors = new Set();
  if (!local || !id) return neighbors;
  neighbors.add(id);
  for (const link of local.links) {
    if (link.source === id) neighbors.add(link.target);
    else if (link.target === id) neighbors.add(link.source);
  }
  return neighbors;
}

// Line endpoints trimmed to the node circles so arrowheads stay visible.
export function linkSegment(link, positions, radii) {
  const from = positions.get(link.source);
  const to = positions.get(link.target);
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const startGap = (radii.get(link.source) || 0) + 2;
  const endGap = (radii.get(link.target) || 0) + 2;
  return {
    x1: from.x + ux * startGap,
    y1: from.y + uy * startGap,
    x2: to.x - ux * endGap,
    y2: to.y - uy * endGap,
  };
}

export function graphStatuses(local) {
  const present = new Set();
  for (const link of local?.links || []) present.add(link.status);
  for (const node of local?.nodes || []) if (node.selfStatus) present.add(node.selfStatus);
  return Object.keys(STATUS_RANK).filter((status) => present.has(status));
}

// ── persisted view options ─────────────────────────────────────

export const GRAPH_OPTIONS_STORAGE_KEY = "dbscout_relation_graph_options";
export const GRAPH_HEIGHT = Object.freeze({ min: 180, default: 260, max: 640 });
export const DEFAULT_GRAPH_OPTIONS = Object.freeze({
  collapsed: false,
  depth: 1,
  outgoing: true,
  incoming: true,
  height: GRAPH_HEIGHT.default,
});

export function clampGraphHeight(value) {
  const height = Math.round(Number(value));
  if (!Number.isFinite(height)) return GRAPH_HEIGHT.default;
  return Math.min(GRAPH_HEIGHT.max, Math.max(GRAPH_HEIGHT.min, height));
}

function storedOptions(options) {
  const { depth, outgoing, incoming } = normalizeOptions(options);
  return { collapsed: options?.collapsed === true, depth, outgoing, incoming, height: clampGraphHeight(options?.height) };
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function loadGraphOptions(storage = defaultStorage()) {
  try {
    const saved = JSON.parse(storage?.getItem(GRAPH_OPTIONS_STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return { ...DEFAULT_GRAPH_OPTIONS };
    return storedOptions(saved);
  } catch {
    return { ...DEFAULT_GRAPH_OPTIONS };
  }
}

export function saveGraphOptions(options, storage = defaultStorage()) {
  try {
    storage?.setItem(GRAPH_OPTIONS_STORAGE_KEY, JSON.stringify(storedOptions(options)));
  } catch {
    // Storage may be full or unavailable; the options still apply this session.
  }
}
