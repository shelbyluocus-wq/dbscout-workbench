// Geometry for drawing the relation graph: how far the ring layout spreads in
// a large view, where each line runs (straight, or bowed around tables in its
// way), which side of each table its name sits on so names stay clear of
// lines and arrowheads, and which corner the info card uses. Pure functions
// over graph-unit positions, so the component only draws.

// ── spread: use the room a large view offers ────────────────────

export const MAX_LAYOUT_SPREAD = 3.25;
const SPREAD_STEP = 0.25;
const MAX_SPREAD_ASPECT = 1.8;
const MIN_EXTENT = 80;

/**
 * How much to stretch the ring layout so it fills a `width`×`height` pixel
 * host at about `scale` pixels per graph unit. `extent` is the box around the
 * table centers at spread 1; `margin` is the room names and circles need
 * around it. Never below 1 (the compact layout), never past `max`, and in
 * steps so resizing the window does not relayout at every pixel.
 */
export function layoutSpread({ width, height } = {}, extent, { scale = 1.15, fill = 0.82, margin = 140, max = MAX_LAYOUT_SPREAD } = {}) {
  if (!(width > 0) || !(height > 0) || !extent) return { x: 1, y: 1 };
  const step = (value) => Math.min(max, Math.max(1, Math.floor(value / SPREAD_STEP) * SPREAD_STEP));
  const along = (pixels, size) => step(((pixels * fill) / scale - margin) / Math.max(MIN_EXTENT, size || 0));
  let x = along(width, extent.width);
  let y = along(height, extent.height);
  // An ellipse may be wider than tall, but not a flat band.
  if (x > y * MAX_SPREAD_ASPECT) x = step(y * MAX_SPREAD_ASPECT);
  if (y > x * MAX_SPREAD_ASPECT) y = step(x * MAX_SPREAD_ASPECT);
  return { x, y };
}

// ── lines ───────────────────────────────────────────────────────

const LINE_GAP = 2;
// Clearance a line keeps from tables that are not its ends.
const OBSTACLE_PADDING = 7;
// Bowing stops here (share of the line length); past it the line just passes close.
const MAX_BEND = 0.45;
// Tables this close to a line's ends are its neighbours' business, not obstacles.
const END_ZONE = 0.06;

function unit(dx, dy) {
  const length = Math.hypot(dx, dy);
  return length > 1e-9 ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
}

/**
 * The bow (signed offset of the quadratic control point from the chord
 * midpoint, along the chord's left normal) a line needs to pass around the
 * tables in its way. 0 when nothing is in the way.
 */
export function lineBend(from, to, obstacles) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return 0;
  const normal = { x: -dy / length, y: dx / length };
  const needs = { 1: 0, [-1]: 0 };
  let blocked = false;
  for (const { x, y, radius } of obstacles) {
    const t = ((x - from.x) * dx + (y - from.y) * dy) / (length * length);
    if (t <= END_ZONE || t >= 1 - END_ZONE) continue;
    const side = (x - from.x) * normal.x + (y - from.y) * normal.y;
    const clearance = (Number(radius) || 0) + OBSTACLE_PADDING;
    if (Math.abs(side) >= clearance) continue;
    blocked = true;
    // A control-point offset h moves the curve 2t(1-t)h away from the chord at t.
    const reach = 2 * t * (1 - t);
    for (const direction of [1, -1]) {
      const toward = side * direction;
      // Bowing away from the table only has to clear what is left of the gap;
      // bowing toward it has to go all the way around it.
      const required = toward < 0 ? (clearance + toward) / reach : (toward + clearance) / reach;
      needs[direction] = Math.max(needs[direction], required);
    }
  }
  if (!blocked) return 0;
  const direction = needs[1] <= needs[-1] ? 1 : -1;
  return direction * Math.min(needs[direction], length * MAX_BEND);
}

/**
 * Where a merged relation line runs: from circle edge to circle edge, bowed
 * around tables in its way. Returns the SVG path, both ends, the point at its
 * middle (for a field label) and a straight approximation for collision
 * checks, or null when an end is not drawn.
 */
export function linkGeometry(link, positions, radii, obstacles = []) {
  const from = positions.get(link.source);
  const to = positions.get(link.target);
  if (!from || !to) return null;
  const others = obstacles.filter((item) => item.id !== link.source && item.id !== link.target);
  const bend = lineBend(from, to, others);
  const startGap = (radii.get(link.source) || 0) + LINE_GAP;
  const endGap = (radii.get(link.target) || 0) + LINE_GAP;
  if (!bend) {
    const direction = unit(to.x - from.x, to.y - from.y);
    const x1 = from.x + direction.x * startGap;
    const y1 = from.y + direction.y * startGap;
    const x2 = to.x - direction.x * endGap;
    const y2 = to.y - direction.y * endGap;
    return { d: `M ${x1} ${y1} L ${x2} ${y2}`, x1, y1, x2, y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, bend: 0 };
  }
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };
  const cx = (from.x + to.x) / 2 + normal.x * bend;
  const cy = (from.y + to.y) / 2 + normal.y * bend;
  // Trim along the curve's own direction at each end so arrowheads point right.
  const out = unit(cx - from.x, cy - from.y);
  const into = unit(to.x - cx, to.y - cy);
  const x1 = from.x + out.x * startGap;
  const y1 = from.y + out.y * startGap;
  const x2 = to.x - into.x * endGap;
  const y2 = to.y - into.y * endGap;
  return {
    d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`,
    x1,
    y1,
    x2,
    y2,
    mx: 0.25 * x1 + 0.5 * cx + 0.25 * x2,
    my: 0.25 * y1 + 0.5 * cy + 0.25 * y2,
    bend,
  };
}

// Straight pieces that follow a line closely enough to test names against it.
export function linkPieces(geometry) {
  if (!geometry) return [];
  if (!geometry.bend) return [[geometry.x1, geometry.y1, geometry.x2, geometry.y2]];
  return [
    [geometry.x1, geometry.y1, geometry.mx, geometry.my],
    [geometry.mx, geometry.my, geometry.x2, geometry.y2],
  ];
}

// The last stretch of a line, where its arrowhead sits.
const ARROW_ZONE = 14;

function zoneAt(px, py, qx, qy) {
  const length = Math.hypot(px - qx, py - qy);
  if (length < 1e-6) return null;
  const share = Math.min(1, ARROW_ZONE / length);
  return [px + (qx - px) * share, py + (qy - py) * share, px, py];
}

// Where the arrowheads of a line sit: at its target end, its source end, or both.
export function arrowZones(geometry, { start = false, end = true } = {}) {
  if (!geometry) return [];
  const pieces = linkPieces(geometry);
  const zones = [];
  if (end) {
    const [x1, y1, x2, y2] = pieces.at(-1);
    zones.push(zoneAt(x2, y2, x1, y1));
  }
  if (start) {
    const [x1, y1, x2, y2] = pieces[0];
    zones.push(zoneAt(x1, y1, x2, y2));
  }
  return zones.filter(Boolean);
}

// ── names ───────────────────────────────────────────────────────

// Eight sides around a table, clockwise from the right (screen y points down).
const DIRECTIONS = Object.freeze(Array.from({ length: 8 }, (_, index) => {
  const angle = (index * Math.PI) / 4;
  return { index, angle, x: Math.cos(angle), y: Math.sin(angle) };
}));
const SIDE_THRESHOLD = 0.38;
// How much worse than a table's best side a name that waits for room may
// settle for: down to beside the table, never toward its lines.
const AWAY_SIDE_SLACK = 4;

const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

// Rough width of a line of text: CJK takes a full em, the rest a bit over half.
export function textWidth(text, fontSize) {
  let width = 0;
  for (const char of String(text || "")) width += WIDE_CHAR.test(char) ? 1 : 0.58;
  return width * fontSize;
}

function angleGap(left, right) {
  const difference = Math.abs(left - right) % (2 * Math.PI);
  return difference > Math.PI ? 2 * Math.PI - difference : difference;
}

function boxesOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function boxHitsCircle(box, x, y, radius) {
  const nearestX = Math.min(Math.max(x, box.x0), box.x1);
  const nearestY = Math.min(Math.max(y, box.y0), box.y1);
  return Math.hypot(x - nearestX, y - nearestY) < radius;
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const cross = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function boxHitsSegment(box, [x1, y1, x2, y2]) {
  if (Math.max(x1, x2) < box.x0 || Math.min(x1, x2) > box.x1 || Math.max(y1, y2) < box.y0 || Math.min(y1, y2) > box.y1) return false;
  const inside = (x, y) => x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1;
  if (inside(x1, y1) || inside(x2, y2)) return true;
  return segmentsCross(x1, y1, x2, y2, box.x0, box.y0, box.x1, box.y0) ||
    segmentsCross(x1, y1, x2, y2, box.x1, box.y0, box.x1, box.y1) ||
    segmentsCross(x1, y1, x2, y2, box.x1, box.y1, box.x0, box.y1) ||
    segmentsCross(x1, y1, x2, y2, box.x0, box.y1, box.x0, box.y0);
}

// The text box and anchor for a name on one side of a table.
export function labelBox(node, direction, { gap, width, height }) {
  const reach = node.radius + gap;
  const ax = node.x + direction.x * reach;
  const ay = node.y + direction.y * reach;
  let anchor = "middle";
  let x0 = ax - width / 2;
  if (direction.x > SIDE_THRESHOLD) {
    anchor = "start";
    x0 = ax;
  } else if (direction.x < -SIDE_THRESHOLD) {
    anchor = "end";
    x0 = ax - width;
  }
  let y0 = ay - height / 2;
  if (direction.y > SIDE_THRESHOLD) y0 = ay;
  else if (direction.y < -SIDE_THRESHOLD) y0 = ay - height;
  return { anchor, x: ax, x0, x1: x0 + width, y0, y1: y0 + height };
}

/**
 * Picks the side each table's name sits on: away from the lines that meet the
 * table, clear of other tables, names and arrowheads, outward from the center
 * when that is free, and below when nothing else decides. Busy tables choose
 * first; a table keeps its previous side unless another is clearly better.
 * Names never pile up: a name with a `rank` (1, 2, …) comes after the
 * unranked ones, in rank order, and takes its best side that covers no name
 * already placed, no other table and no arrowhead, and stays inside
 * `frame`; from rank 2 on, only a side facing away from the table's lines
 * will do, so names stay off the spokes of a ring. Without such a side the
 * name is left out, and shows once the user zooms in far enough for it to fit.
 *
 * nodes:    [{ id, x, y, radius, width, height, rank }] in graph units
 * lines:    [{ source, target, pieces: [[x1, y1, x2, y2], ...], arrows: [[...], ...] }]
 * obstacles tables without a name to place, which names still avoid
 * frame     { x0, y0, x1, y1 } ranked names must stay inside, or null
 * returns   Map(id -> { direction, anchor, x, y0, x0, x1, y1 }), without left-out names
 */
export function placeLabels(nodes, lines, { center = null, gap = 4, previous = null, obstacles = [], frame = null } = {}) {
  const byId = new Map([...obstacles, ...nodes].map((node) => [node.id, node]));
  const incident = new Map(nodes.map((node) => [node.id, []]));
  for (const line of lines) {
    const from = byId.get(line.source);
    const to = byId.get(line.target);
    if (!from || !to) continue;
    incident.get(from.id)?.push(Math.atan2(to.y - from.y, to.x - from.x));
    incident.get(to.id)?.push(Math.atan2(from.y - to.y, from.x - to.x));
  }
  const circles = [...byId.values()];
  const centerNode = center ? byId.get(center) : null;
  const order = [...nodes].sort((left, right) =>
    (left.rank || 0) - (right.rank || 0) ||
    Number(right.id === center) - Number(left.id === center) ||
    (incident.get(right.id)?.length || 0) - (incident.get(left.id)?.length || 0) ||
    right.radius - left.radius ||
    left.id.localeCompare(right.id));
  // Bounds of every line piece and arrowhead, computed once for all tables.
  const pieces = [];
  for (const line of lines) {
    for (const piece of line.pieces || []) pieces.push({ piece, line, penalty: 3, bounds: segmentBounds(piece) });
    for (const arrow of line.arrows || []) pieces.push({ piece: arrow, line, penalty: 5, arrow: true, bounds: segmentBounds(arrow) });
  }
  const placed = [];
  const result = new Map();
  for (const node of order) {
    const angles = incident.get(node.id) || [];
    const outward = centerNode && centerNode.id !== node.id && Math.hypot(node.x - centerNode.x, node.y - centerNode.y) > 1e-6
      ? Math.atan2(node.y - centerNode.y, node.x - centerNode.x)
      : null;
    // How good each side is before collisions; collisions only ever subtract,
    // so sides that cannot beat the best so far are never checked.
    const candidates = DIRECTIONS.map((direction) => {
      let score = angles.length ? 2 * Math.min(...angles.map((angle) => angleGap(direction.angle, angle))) : 2 * Math.PI;
      if (outward !== null) score += 0.7 * Math.cos(direction.angle - outward);
      score += 0.3 * direction.y;
      if (previous?.get(node.id) === direction.index) score += 0.45;
      return { direction, score };
    }).sort((left, right) => right.score - left.score);
    const optional = node.rank > 0;
    const lowest = node.rank >= 2 ? candidates[0].score - AWAY_SIDE_SLACK : -Infinity;
    let best = null;
    for (const candidate of candidates) {
      if ((best && candidate.score <= best.score) || candidate.score < lowest) break;
      const box = labelBox(node, candidate.direction, { gap, width: node.width, height: node.height });
      if (optional && crowded(box, node, { circles, placed, pieces, frame, margin: gap / 2 })) continue;
      const score = candidate.score - collisions(box, node, circles, placed, pieces);
      if (!best || score > best.score) best = { score, direction: candidate.direction, box };
    }
    if (!best) continue;
    placed.push(best.box);
    result.set(node.id, { direction: best.direction.index, ...best.box });
  }
  return result;
}

// Whether a name box (with a margin around it) would cover a name already
// placed, another table or an arrowhead, or stick out of the frame.
function crowded(box, node, { circles, placed, pieces, frame, margin }) {
  const room = { x0: box.x0 - margin, y0: box.y0 - margin, x1: box.x1 + margin, y1: box.y1 + margin };
  if (frame && (room.x0 < frame.x0 || room.y0 < frame.y0 || room.x1 > frame.x1 || room.y1 > frame.y1)) return true;
  return placed.some((other) => boxesOverlap(room, other)) ||
    circles.some((other) => other.id !== node.id && boxHitsCircle(box, other.x, other.y, other.radius + 2)) ||
    pieces.some(({ piece, arrow, bounds }) => arrow &&
      bounds.x1 >= box.x0 && bounds.x0 <= box.x1 && bounds.y1 >= box.y0 && bounds.y0 <= box.y1 &&
      boxHitsSegment(box, piece));
}

function segmentBounds([x1, y1, x2, y2]) {
  return { x0: Math.min(x1, x2), x1: Math.max(x1, x2), y0: Math.min(y1, y2), y1: Math.max(y1, y2) };
}

// What a name box would cover: other tables, names already placed, lines it
// does not belong to, and any arrowhead (arrowheads tell the direction).
function collisions(box, node, circles, placed, pieces) {
  let penalty = 0;
  for (const other of circles) {
    if (other.id !== node.id && boxHitsCircle(box, other.x, other.y, other.radius + 2)) penalty += 6;
  }
  for (const other of placed) if (boxesOverlap(box, other)) penalty += 6;
  for (const { piece, line, penalty: cost, arrow, bounds } of pieces) {
    if (bounds.x1 < box.x0 || bounds.x0 > box.x1 || bounds.y1 < box.y0 || bounds.y0 > box.y1) continue;
    if (!arrow && (line.source === node.id || line.target === node.id)) continue;
    if (boxHitsSegment(box, piece)) penalty += cost;
  }
  return penalty;
}

// ── card and tool strip ─────────────────────────────────────────

// The tool strip runs along the right edge of every graph view (see
// ConfigRelationGraphFrame.vue: 8px from the edge, 28px wide); names keep
// this much room clear of it.
export const TOOL_STRIP_PX = 38;

// Narrower than this, the info card spans the graph's width.
const WIDE_HOST = 560;

/**
 * Where the info card goes so it never covers the table it describes: the
 * half (and in wide views the corner) away from that table.
 */
export function cardPlacement(point, { width, height } = {}) {
  if (!point || !(width > 0) || !(height > 0)) return { vertical: "bottom", horizontal: "left", span: false };
  const vertical = point.y > height / 2 ? "top" : "bottom";
  if (width < WIDE_HOST) return { vertical, horizontal: "left", span: true };
  return { vertical, horizontal: point.x > width / 2 ? "left" : "right", span: false };
}

// Graph units to pixels inside the host, for an SVG that fits its viewBox
// (xMidYMid meet).
export function screenPoint(point, viewBox, { width, height } = {}) {
  if (!point || !viewBox || !(width > 0) || !(height > 0)) return null;
  const scale = Math.min(width / viewBox.width, height / viewBox.height);
  return {
    x: (point.x - viewBox.x) * scale + (width - viewBox.width * scale) / 2,
    y: (point.y - viewBox.y) * scale + (height - viewBox.height * scale) / 2,
  };
}

// ── arrangement ────────────────────────────────────────────────

/**
 * Where each table starts when the picture changes: tables already drawn keep
 * their place, new ones grow out of the table that brought them in, and with
 * nothing drawn before they start where they belong.
 */
export function glideStarts(nodes, targets, previous) {
  const starts = new Map();
  for (const node of nodes) {
    const target = targets.get(node.id) || { x: 0, y: 0 };
    const kept = previous?.get(node.id);
    const parent = node.parent ? previous?.get(node.parent) : null;
    const center = previous?.size ? previous.get(nodes[0]?.id) : null;
    starts.set(node.id, kept || parent || center || target);
  }
  return starts;
}
