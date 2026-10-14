// The relation graph around one config table, or of the whole database:
// which tables to show for a depth and direction, how their relations merge
// into lines, how large each node is, and (for small graphs) where it sits.
// Pure functions over the backend graph payload (`{ edges, tables }`), so the
// components only draw.

// A safety limit far above real config databases; past it the busiest tables win.
export const GRAPH_MAX_NODES = 6000;
export const GRAPH_MAX_DEPTH = 2;
// Up to this many tables a graph is drawn as rings with routed lines and
// placed names; larger ones are laid out by forces and drawn on a canvas.
export const RING_GRAPH_MAX_NODES = 60;

const STATUS_RANK = Object.freeze({ confirmed: 0, unconfirmed: 1, stale: 2, conflict: 3 });
const PAIR_SEPARATOR = "\u001f";

const NODE_RADIUS_MIN = 6;
const NODE_RADIUS_MAX = 16;
const CENTER_RADIUS_MIN = 11;
const FIRST_RING_MIN = 92;
const RING_GAP = 84;
const NODE_SPACING = 40;
// Second-ring neighbours keep a little more room than the ring's average.
const SECOND_RING_SPACING = 1.25;
const LABEL_MAX_CHARS = 18;
const LABEL_CHAR_WIDTH = 6.2;
const LABEL_OFFSET = 6;
const LABEL_LINE_HEIGHT = 14;
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

// Code-point order: deterministic, and quick enough for thousands of tables.
function byName(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
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

function byRelationId(left, right) {
  return byName(left.id, right.id);
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
      const loop = selfLoops.get(source) || { status: "", relations: [] };
      loop.status = worseStatus(loop.status, edge.status);
      loop.relations.push(edge);
      selfLoops.set(source, loop);
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
  for (const link of links.values()) link.relations.sort(byRelationId);
  for (const loop of selfLoops.values()) loop.relations.sort(byRelationId);
  return { links: [...links.values()].sort(byRelationId), selfLoops };
}

// Nodes with their sizes, self references and worst problem, and the lines
// between them: the shape every graph view draws.
function assembleGraph({ scope, center, nodes, hidden, options }, edges, counts = referenceCounts(edges)) {
  const { links, selfLoops } = mergeLinks(edges, nodes);
  const issues = new Map();
  for (const link of links) {
    for (const end of [link.source, link.target]) issues.set(end, worseStatus(issues.get(end), link.status));
  }
  for (const [table, loop] of selfLoops) issues.set(table, worseStatus(issues.get(table), loop.status));
  const shown = [...nodes.values()].map((node) => {
    const referencedBy = counts.get(node.id) || 0;
    const issue = issues.get(node.id);
    const loop = selfLoops.get(node.id);
    return {
      id: node.id,
      depth: node.depth,
      side: node.side,
      parent: node.parent,
      referencedBy,
      radius: nodeRadius(referencedBy, { center: node.depth === 0 }),
      selfStatus: loop?.status || "",
      selfRelations: loop?.relations || [],
      issue: issue === "stale" || issue === "conflict" ? issue : "",
    };
  });
  return { scope, center, nodes: shown, links, hidden, options };
}

export function localRelationGraph(graph, centerTable, options = {}) {
  const center = lower(centerTable);
  if (!center) return null;
  const settings = normalizeOptions(options);
  const edges = activeEdges(graph);
  const { nodes, hidden } = reachTables(center, groupBy(edges, "sourceTable"), groupBy(edges, "targetTable"), settings);
  return assembleGraph({ scope: "local", center, nodes, hidden, options: settings }, edges);
}

// Every table that takes part in a relation. Tables reachable from the
// current one carry their distance and side like a local graph (depth -1 and
// side "none" for the rest), so the views can still single it out.
export function databaseRelationGraph(graph, centerTable, { maxNodes = GRAPH_MAX_NODES } = {}) {
  const center = lower(centerTable);
  const edges = activeEdges(graph);
  const tables = new Set();
  for (const edge of edges) {
    tables.add(edge.sourceTable);
    tables.add(edge.targetTable);
  }
  const limit = Math.max(1, Number(maxNodes) || GRAPH_MAX_NODES);
  const nodes = center && tables.has(center)
    ? reachTables(center, groupBy(edges, "sourceTable"), groupBy(edges, "targetTable"), {
      depth: Infinity,
      outgoing: true,
      incoming: true,
      maxNodes: limit,
    }).nodes
    : new Map();
  const counts = referenceCounts(edges);
  // Tables out of the current one's reach, busiest first, while room remains.
  const rest = [...tables]
    .filter((table) => !nodes.has(table))
    .sort((left, right) => (counts.get(right) || 0) - (counts.get(left) || 0) || byName(left, right));
  for (const table of rest) {
    if (nodes.size >= limit) break;
    nodes.set(table, { id: table, depth: -1, side: "none", parent: null });
  }
  return assembleGraph({
    scope: "database",
    center,
    nodes,
    hidden: Math.max(0, tables.size - nodes.size),
    options: { maxNodes: limit },
  }, edges, counts);
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

// Evenly around the whole circle, in parent order: the fallback when the
// second ring is too crowded to gather tables by parent.
function evenSecondRing(ordered, parentAngles) {
  const step = (2 * Math.PI) / ordered.length;
  const firstParent = ordered[0].parent;
  const firstGroup = ordered.filter((node) => node.parent === firstParent).length;
  const start = (parentAngles.get(firstParent) ?? 0) - ((firstGroup - 1) / 2) * step;
  return new Map(ordered.map((node, index) => [node.id, start + index * step]));
}

// Second-ring tables gather beside the table that brought them in, spaced
// just far enough apart; neighbouring groups push each other aside instead
// of overlapping. Short lines that do not cross the picture keep the
// direction of each relation easy to follow.
function secondRingAngles(nodes, parentAngles, radius) {
  if (!nodes.length) return new Map();
  const ordered = [...nodes].sort((left, right) =>
    normalizeAngle(parentAngles.get(left.parent) ?? 0) - normalizeAngle(parentAngles.get(right.parent) ?? 0) ||
    byName(left.id, right.id));
  const turn = 2 * Math.PI;
  const step = Math.min(turn / ordered.length, (NODE_SPACING * SECOND_RING_SPACING) / Math.max(radius, 1));
  // Where each table would like to be: centred on its parent, in name order.
  const wanted = [];
  for (let index = 0; index < ordered.length;) {
    const parent = ordered[index].parent;
    let end = index;
    while (end < ordered.length && ordered[end].parent === parent) end += 1;
    const size = end - index;
    const center = normalizeAngle(parentAngles.get(parent) ?? 0);
    for (let offset = 0; offset < size; offset += 1) wanted.push(center + (offset - (size - 1) / 2) * step);
    index = end;
  }
  // Keep at least one step between neighbours: push forward, pull back,
  // meet in the middle, then settle forward once more.
  const forward = [...wanted];
  for (let index = 1; index < forward.length; index += 1) forward[index] = Math.max(forward[index], forward[index - 1] + step);
  const backward = [...wanted];
  for (let index = backward.length - 2; index >= 0; index -= 1) backward[index] = Math.min(backward[index], backward[index + 1] - step);
  const angles = forward.map((value, index) => (value + backward[index]) / 2);
  for (let index = 1; index < angles.length; index += 1) angles[index] = Math.max(angles[index], angles[index - 1] + step);
  // The ring closes on itself: the last table must stay a step short of the first.
  if (angles.at(-1) - angles[0] > turn - step + 1e-9) return evenSecondRing(ordered, parentAngles);
  return new Map(ordered.map((node, index) => [node.id, angles[index]]));
}

export function graphLabel(text) {
  const value = String(text || "");
  return value.length > LABEL_MAX_CHARS ? `${value.slice(0, LABEL_MAX_CHARS - 1)}…` : value;
}

// Fixed rings: the picture at rest is the same every time a table opens, so
// users can learn it. A large view stretches the rings (`spread`, see
// layoutSpread) instead of enlarging circles and names; tables the user drags
// stay where they are dropped (see useGraphArrangement.js).
export function layoutRelationGraph(local, labelFor = (id) => id, { spread = null } = {}) {
  if (!local) return null;
  const stretchX = Number(spread?.x) || 1;
  const stretchY = Number(spread?.y) || 1;
  const first = local.nodes.filter((node) => node.depth === 1);
  const second = local.nodes.filter((node) => node.depth === 2);
  const firstRadius = ringRadius(first.length, FIRST_RING_MIN);
  const secondRadius = ringRadius(second.length, firstRadius + RING_GAP);
  const angles = firstRingAngles(first);
  const outerAngles = secondRingAngles(second, angles, secondRadius);
  const positions = new Map();
  let bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let extent = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
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
    extent = {
      minX: Math.min(extent.minX, x),
      maxX: Math.max(extent.maxX, x),
      minY: Math.min(extent.minY, y),
      maxY: Math.max(extent.maxY, y),
    };
    x *= stretchX;
    y *= stretchY;
    const label = graphLabel(labelFor(node.id));
    // A name can sit on any side of its table; allow most of its width either way.
    const reachX = node.radius + LABEL_OFFSET + label.length * LABEL_CHAR_WIDTH * 0.75;
    const reachY = node.radius + LABEL_OFFSET + LABEL_LINE_HEIGHT;
    positions.set(node.id, { x, y, label });
    bounds = {
      minX: Math.min(bounds.minX, x - reachX),
      maxX: Math.max(bounds.maxX, x + reachX),
      minY: Math.min(bounds.minY, y - reachY),
      maxY: Math.max(bounds.maxY, y + reachY),
    };
  }
  const box = {
    x: bounds.minX - BOUNDS_PADDING,
    y: bounds.minY - BOUNDS_PADDING,
    width: bounds.maxX - bounds.minX + BOUNDS_PADDING * 2,
    height: bounds.maxY - bounds.minY + BOUNDS_PADDING * 2,
  };
  return {
    positions,
    bounds: box,
    // Box around the table centers before stretching.
    extent: { width: extent.maxX - extent.minX, height: extent.maxY - extent.minY },
  };
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

function byRelationEnds(left, right) {
  return left.sourceTable.localeCompare(right.sourceTable) ||
    left.targetTable.localeCompare(right.targetTable) ||
    byRelationId(left, right);
}

// The drawn relations of one table, split into the ones it makes (its column
// points at another table), the ones made at it, and the ones to itself.
export function graphNodeRelations(local, id) {
  const references = [];
  const referencedBy = [];
  for (const link of local?.links || []) {
    if (link.source !== id && link.target !== id) continue;
    for (const relation of link.relations) {
      if (relation.sourceTable === id) references.push(relation);
      else if (relation.targetTable === id) referencedBy.push(relation);
    }
  }
  const node = local?.nodes?.find((candidate) => candidate.id === id);
  return {
    references: references.sort(byRelationEnds),
    referencedBy: referencedBy.sort(byRelationEnds),
    self: [...(node?.selfRelations || [])],
  };
}

// The info card names each other table once, with its fields under it and
// the worst status among them; tables come in name order.
export function groupByOtherTable(relations, id) {
  const groups = new Map();
  for (const relation of relations || []) {
    const other = relation.sourceTable === id ? relation.targetTable : relation.sourceTable;
    const group = groups.get(other) || { table: other, status: "", relations: [] };
    group.status = worseStatus(group.status, relation.status);
    group.relations.push(relation);
    groups.set(other, group);
  }
  return [...groups.values()].sort((left, right) => left.table.localeCompare(right.table));
}

// What a depth switch changed, in a short line for the graph to show, so the
// switch never looks as if nothing happened. Counts include the current table.
export function depthChangeNotice({ depth, previousDepth, before, after }, t) {
  const total = Math.max(0, after - 1);
  if (after > before) return t("relations.graph.depthGrew", { depth, count: after - before, total });
  if (after === before && depth > previousDepth) return t("relations.graph.depthSame", { depth });
  return t("relations.graph.depthShrank", { depth, total });
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
