// Drawing a large relation graph on a 2D canvas, after Obsidian's graph
// view: only what is on screen, lines batched by colour into a handful of
// paths, circles that shrink slower than the zoom so a zoomed-out graph does
// not turn to dust, names that fade in as the user zooms (busy tables first),
// never pile on top of each other and never crowd the screen, arrowheads
// once they can be seen, and everything outside the active table's
// neighbourhood faded. Pure functions over a frame description, so they can
// be checked with a recording context.
import { SIDE, STATUS } from "./relationGraphModel.js";

const TAU = Math.PI * 2;
// Circles never shrink below this many pixels.
const NODE_SCREEN_MIN = 1.6;
// Names appear on the smallest circles from this zoom, on the largest from
// LABEL_SCALE_LARGEST, and fade in over half an octave below that.
const LABEL_SCALE_SMALLEST = 0.56;
const LABEL_SCALE_LARGEST = 0.048;
const LABEL_FADE_OCTAVES = 0.5;
const LABEL_RADIUS_RANGE = [4, 30];
const LABEL_GAP_PX = 3;
const LABEL_MAX_CHARS = 24;
const LABEL_BUDGET = 320;
// Besides the names that always show, at most one name per this much screen
// area (busier tables first), so a whole picture stays calm at any view size.
const LABEL_AREA_PX = 10000;
const LABEL_GRID_PX = 8;
const LABEL_PAD_PX = 2;
// Arrowheads fade in between these zoom levels.
const ARROW_FADE = [0.28, 0.45];
// Circles smaller than this (screen radius) are drawn as plain round dots,
// and the very smallest as squares, which look the same at that size and
// cost far less. Past ROUND_DOTS_MAX tables in view every dot is a square.
const DOT_RADIUS_PX = 2.6;
const SQUARE_DOT_RADIUS_PX = 1.8;
const ROUND_DOTS_MAX = 1500;
// Dashes are costly to draw; past this many lines in a style, or zoomed out,
// unconfirmed lines go solid and lighter instead.
const DASHED_LINES_MAX = 400;
const DASHED_SCALE_MIN = 0.5;
const BUSY_FOCUS_LINKS = 40;
const INVISIBLE_ALPHA = 0.03;
const ARROW_PX = 6.5;
const FIELD_SCALE_MIN = 0.45;
const FIELD_LABEL_MAX = 40;
// Faded tables and lines keep this much of their colour.
export const FADED_ALPHA = 0.16;
// Plain lines are fainter the further the user zooms out, so thousands of
// them read as structure rather than a dark blot; lines with a problem keep
// more of their colour.
const LINE_ALPHA = Object.freeze({ min: 0.11, max: 0.3, fullScale: 0.8 });
const ISSUE_LINE_ALPHA = Object.freeze({ min: 0.4, fullScale: 0.6 });
const VIEW_MARGIN_PX = 40;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ── colours ───────────────────────────────────────────────────

const TOKENS = Object.freeze({
  text: "--wb-text",
  secondary: "--wb-secondary-text",
  quiet: "--wb-quiet-text",
  surface: "--wb-surface",
  accent: "--wb-accent",
  accentControl: "--wb-accent-control",
  warning: "--wb-warning-border",
  danger: "--wb-danger",
  out: "--wb-relation-out",
  outSoft: "--wb-relation-out-soft",
  in: "--wb-relation-in",
  inSoft: "--wb-relation-in-soft",
});

/** [r, g, b, a] from rgb()/rgba()/color(srgb …) text, or null. */
export function parseColor(text) {
  const value = String(text || "").trim();
  let match = value.match(/^rgba?\(([^)]+)\)$/iu);
  if (match) {
    const parts = match[1].split(/[\s,/]+/u).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
    return [parts[0], parts[1], parts[2], Number.isFinite(parts[3]) ? parts[3] : 1];
  }
  match = value.match(/^color\(srgb\s+([^)]+)\)$/iu);
  if (match) {
    const parts = match[1].split(/[\s/]+/u).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
    return [parts[0] * 255, parts[1] * 255, parts[2] * 255, Number.isFinite(parts[3]) ? parts[3] : 1];
  }
  match = value.match(/^#([0-9a-f]{6})$/iu);
  if (match) {
    const number = parseInt(match[1], 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255, 1];
  }
  return null;
}

export function mixColors(left, right, share) {
  return left.map((value, at) => value + (right[at] - value) * share);
}

export function cssColor(color, alpha = 1) {
  const [r, g, b, a] = color;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+(clamp(a * alpha, 0, 1)).toFixed(3)})`;
}

const FALLBACK = Object.freeze({
  text: [26, 28, 32, 1],
  secondary: [86, 92, 102, 1],
  quiet: [128, 134, 144, 1],
  surface: [255, 255, 255, 1],
  accent: [74, 85, 104, 1],
  accentControl: [61, 72, 86, 1],
  warning: [214, 158, 46, 1],
  danger: [200, 60, 60, 1],
  out: [49, 95, 147, 1],
  outSoft: [232, 241, 251, 1],
  in: [107, 74, 149, 1],
  inSoft: [241, 235, 248, 1],
});

/** Colours for the canvas from the theme tokens the element inherits. */
export function readGraphPalette(element) {
  const raw = { ...FALLBACK };
  const view = element?.ownerDocument?.defaultView;
  if (element && view?.getComputedStyle) {
    const probe = element.ownerDocument.createElement("span");
    probe.style.display = "none";
    element.appendChild(probe);
    try {
      for (const [name, token] of Object.entries(TOKENS)) {
        probe.style.color = `var(${token})`;
        raw[name] = parseColor(view.getComputedStyle(probe).color) || raw[name];
      }
    } finally {
      probe.remove();
    }
  }
  return graphPalette(raw);
}

export function graphPalette(raw) {
  const surface = [...raw.surface.slice(0, 3), 1];
  const plain = mixColors(surface, raw.text, 0.1);
  const both = mixColors(raw.outSoft, raw.inSoft, 0.5);
  const bothStroke = mixColors(raw.out, raw.in, 0.5);
  return {
    halo: cssColor(surface),
    label: cssColor(raw.secondary),
    labelStrong: cssColor(raw.text),
    field: cssColor(raw.text),
    line: cssColor(raw.text),
    arrow: cssColor(raw.text, 0.55),
    accent: cssColor(raw.accent),
    centerFill: cssColor(raw.accentControl),
    centerHalo: cssColor(raw.accentControl, 0.22),
    warning: cssColor(raw.warning),
    danger: cssColor(raw.danger),
    fills: [cssColor(raw.accentControl), cssColor(raw.outSoft), cssColor(raw.inSoft), cssColor(both), cssColor(plain)],
    strokes: [cssColor(surface), cssColor(raw.out), cssColor(raw.in), cssColor(bothStroke), cssColor(raw.text, 0.4)],
  };
}

// ── zoom-dependent sizes ──────────────────────────────────────

// Screen radius: shrinks with the square root of the zoom, never below a dot.
export function nodeScreenRadius(radius, scale) {
  return Math.max(NODE_SCREEN_MIN, radius * Math.sqrt(scale));
}

// The zoom from which a name shows, by circle size (busier tables first).
export function labelScale(radius) {
  const [smallest, largest] = LABEL_RADIUS_RANGE;
  const share = clamp((radius - smallest) / (largest - smallest), 0, 1);
  return LABEL_SCALE_SMALLEST * (LABEL_SCALE_LARGEST / LABEL_SCALE_SMALLEST) ** share;
}

export function labelAlpha(scale, radius) {
  return clamp(1 + Math.log2(scale / labelScale(radius)) / LABEL_FADE_OCTAVES, 0, 1);
}

export function lineAlpha(scale, { issue = false } = {}) {
  if (issue) return clamp(ISSUE_LINE_ALPHA.min + (1 - ISSUE_LINE_ALPHA.min) * (scale / ISSUE_LINE_ALPHA.fullScale), ISSUE_LINE_ALPHA.min, 1);
  return clamp(LINE_ALPHA.min + (LINE_ALPHA.max - LINE_ALPHA.min) * (scale / LINE_ALPHA.fullScale), LINE_ALPHA.min, LINE_ALPHA.max);
}

export function arrowAlpha(scale) {
  return clamp((scale - ARROW_FADE[0]) / (ARROW_FADE[1] - ARROW_FADE[0]), 0, 1);
}

export function shortLabel(text) {
  const value = String(text || "");
  return value.length > LABEL_MAX_CHARS ? `${value.slice(0, LABEL_MAX_CHARS - 1)}…` : value;
}

// ── view ──────────────────────────────────────────────────────

/** The graph rectangle on screen (plus a margin), for culling. */
export function viewRect(view, width, height, marginPx = VIEW_MARGIN_PX) {
  const halfWidth = (width / 2 + marginPx) / view.scale;
  const halfHeight = (height / 2 + marginPx) / view.scale;
  return { x0: view.x - halfWidth, y0: view.y - halfHeight, x1: view.x + halfWidth, y1: view.y + halfHeight };
}

export function screenX(view, width, x) {
  return (x - view.x) * view.scale + width / 2;
}

export function screenY(view, height, y) {
  return (y - view.y) * view.scale + height / 2;
}

function segmentInRect(x1, y1, x2, y2, rect) {
  if (Math.max(x1, x2) < rect.x0 || Math.min(x1, x2) > rect.x1) return false;
  if (Math.max(y1, y2) < rect.y0 || Math.min(y1, y2) > rect.y1) return false;
  return true;
}

// ── buckets: one path per colour ──────────────────────────────

function bucket(map, key, make) {
  let entry = map.get(key);
  if (!entry) {
    entry = { ...make(), items: [] };
    map.set(key, entry);
  }
  return entry;
}

function lineStyle(palette, status, emphasis) {
  if (status === STATUS.conflict) return palette.danger;
  if (status === STATUS.stale) return palette.warning;
  return emphasis === 2 ? palette.accent : palette.line;
}

/**
 * Draws one frame. `frame`:
 *   ctx, width, height (CSS px), view { scale, x, y }, model, xy, palette,
 *   font { family, size, mono }, focus (table whose neighbourhood stays
 *   bright, or -1) with its neighbour `mask`, fade (0..1, how far the rest
 *   has dimmed), pinned, dragged, revealed (Uint8Array or null), labelOrder
 *   (indices, busiest first), labelText(index), labelWidth(index, size,
 *   bold), fieldText(link) (or null), selfLoops (bool), reserveRight
 *   (pixels along the right edge that names keep clear of, for the tool strip).
 * Returns what was drawn, for tests and measurements.
 */
export function drawGraphFrame(frame) {
  const { ctx, width, height, view, model, xy, palette } = frame;
  const scale = view.scale;
  const rect = viewRect(view, width, height);
  const active = frame.focus ?? -1;
  const mask = active >= 0 ? frame.mask : null;
  const fade = mask ? clamp(frame.fade ?? 1, 0, 1) : 0;
  const fadedAlpha = 1 - (1 - FADED_ALPHA) * fade;
  const revealed = frame.revealed || null;
  const sizeFactor = Math.sqrt(scale);
  const stats = { links: 0, nodes: 0, labels: 0, arrows: 0 };
  ctx.clearRect(0, 0, width, height);

  const shown = (at) => !revealed || revealed[at] === 1;
  const radiusOf = (at) => Math.max(NODE_SCREEN_MIN, model.radius[at] * sizeFactor);
  const sx = (at) => (xy[at * 2] - view.x) * scale + width / 2;
  const sy = (at) => (xy[at * 2 + 1] - view.y) * scale + height / 2;

  // Lines: emphasis 0 faded, 1 normal, 2 the active table's own. A busy
  // table's own lines stay thin, or its fan would cover everything.
  const lines = new Map();
  const busyFocus = active >= 0 && model.offsets[active + 1] - model.offsets[active] > BUSY_FOCUS_LINKS;
  const arrowsShown = arrowAlpha(scale);
  for (let link = 0; link < model.linkCount; link += 1) {
    const from = model.source[link];
    const to = model.target[link];
    if (!shown(from) || !shown(to)) continue;
    const x1 = xy[from * 2];
    const y1 = xy[from * 2 + 1];
    const x2 = xy[to * 2];
    const y2 = xy[to * 2 + 1];
    if (!segmentInRect(x1, y1, x2, y2, rect)) continue;
    const touches = active >= 0 && (from === active || to === active);
    const emphasis = touches ? 2 : mask ? 0 : 1;
    const status = model.status[link];
    const dashed = status === STATUS.unconfirmed;
    const key = emphasis * 16 + status * 2 + (dashed ? 1 : 0);
    bucket(lines, key, () => {
      const issue = status === STATUS.stale || status === STATUS.conflict;
      const base = emphasis === 2 ? (busyFocus ? 0.55 : 1) : lineAlpha(scale, { issue });
      return {
        color: lineStyle(palette, status, emphasis),
        // One pixel lines take the fast path: a busy fan spanning the
        // window costs a fraction of a wider one.
        width: emphasis === 2 ? (busyFocus ? 1 : 1.8) : 1,
        alpha: emphasis === 0 ? base * fadedAlpha : base,
        dashed,
        emphasis,
      };
    }).items.push(link);
  }
  const ordered = [...lines.values()].sort((left, right) => left.emphasis - right.emphasis);
  const arrowHeads = [];
  for (const group of ordered) {
    // Faded this far, a line cannot be seen; painting it would only cost time.
    if (group.alpha < INVISIBLE_ALPHA) continue;
    ctx.beginPath();
    for (const link of group.items) {
      const from = model.source[link];
      const to = model.target[link];
      const ax = sx(from);
      const ay = sy(from);
      const bx = sx(to);
      const by = sy(to);
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const ra = radiusOf(from);
      const rb = radiusOf(to);
      if (length <= ra + rb + 1) continue;
      ctx.moveTo(ax + ux * ra, ay + uy * ra);
      ctx.lineTo(bx - ux * rb, by - uy * rb);
      stats.links += 1;
      if (arrowsShown > 0 && group.emphasis > 0 && length > ra + rb + ARROW_PX * 2.5) {
        if (model.forward[link]) arrowHeads.push([group, bx - ux * rb, by - uy * rb, ux, uy]);
        if (model.backward[link]) arrowHeads.push([group, ax + ux * ra, ay + uy * ra, -ux, -uy]);
      }
    }
    const dashed = group.dashed && scale >= DASHED_SCALE_MIN && group.items.length <= DASHED_LINES_MAX;
    ctx.globalAlpha = group.dashed && !dashed ? group.alpha * 0.6 : group.alpha;
    ctx.strokeStyle = group.color;
    ctx.lineWidth = group.width;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Arrowheads, in the colour of their line (plain lines a little darker).
  if (arrowHeads.length) {
    const byGroup = new Map();
    for (const head of arrowHeads) bucket(byGroup, head[0], () => ({ group: head[0] })).items.push(head);
    for (const { group, items } of byGroup.values()) {
      ctx.beginPath();
      for (const [, tipX, tipY, ux, uy] of items) {
        const baseX = tipX - ux * ARROW_PX;
        const baseY = tipY - uy * ARROW_PX;
        // Open triangles: filling closes them, and explicit closing is far slower.
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseX - uy * ARROW_PX * 0.45, baseY + ux * ARROW_PX * 0.45);
        ctx.lineTo(baseX + uy * ARROW_PX * 0.45, baseY - ux * ARROW_PX * 0.45);
        stats.arrows += 1;
      }
      ctx.globalAlpha = (group.color === palette.line ? Math.min(1, group.alpha * 2) : group.alpha) * arrowsShown;
      ctx.fillStyle = group.color === palette.line ? palette.arrow : group.color;
      ctx.fill();
    }
  }

  // Circles: one path per colour; tables in the active neighbourhood on top.
  const circles = new Map();
  for (let at = 0; at < model.count; at += 1) {
    if (!shown(at) || at === model.centerIndex) continue;
    const x = xy[at * 2];
    const y = xy[at * 2 + 1];
    const reach = model.radius[at] * sizeFactor / scale + NODE_SCREEN_MIN / scale;
    if (x + reach < rect.x0 || x - reach > rect.x1 || y + reach < rect.y0 || y - reach > rect.y1) continue;
    const lit = !mask || mask[at] === 1;
    const side = model.side[at];
    const issue = model.issue[at];
    const outer = model.depth[at] >= 2 || model.depth[at] < 0;
    const key = (lit ? 1 : 0) * 64 + side * 8 + issue * 2 + (outer ? 1 : 0);
    bucket(circles, key, () => ({
      fill: palette.fills[side] || palette.fills[SIDE.none],
      stroke: issue === 2 ? palette.danger : issue === 1 ? palette.warning : palette.strokes[side] || palette.strokes[SIDE.none],
      // A problem ring stays thin while zoomed out, where hubs touch many lines.
      strokeWidth: issue ? (scale < 0.4 ? 1.4 : 2) : 1.2,
      alpha: lit ? 1 : fadedAlpha,
      fillAlpha: outer ? 0.8 : 1,
      lit,
    })).items.push(at);
  }
  const circleGroups = [...circles.values()].sort((left, right) => Number(left.lit) - Number(right.lit));
  const inView = circleGroups.reduce((sum, group) => sum + group.items.length, 0);
  const squareBelow = inView > ROUND_DOTS_MAX ? DOT_RADIUS_PX : SQUARE_DOT_RADIUS_PX;
  for (const group of circleGroups) {
    // Tiny circles are dots in their outline colour, filled once per colour.
    ctx.globalAlpha = group.alpha;
    ctx.fillStyle = group.stroke;
    let rings = 0;
    let dots = 0;
    for (const at of group.items) {
      const radius = radiusOf(at);
      if (radius >= DOT_RADIUS_PX) {
        rings += 1;
      } else if (radius < squareBelow) {
        ctx.fillRect(sx(at) - radius, sy(at) - radius, radius * 2, radius * 2);
        stats.nodes += 1;
      } else {
        dots += 1;
      }
    }
    if (dots) {
      ctx.beginPath();
      for (const at of group.items) {
        const radius = radiusOf(at);
        if (radius < squareBelow || radius >= DOT_RADIUS_PX) continue;
        const x = sx(at);
        const y = sy(at);
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, TAU);
      }
      ctx.fill();
      stats.nodes += dots;
    }
    if (!rings) continue;
    ctx.beginPath();
    for (const at of group.items) {
      const radius = radiusOf(at);
      if (radius < DOT_RADIUS_PX) continue;
      const x = sx(at);
      const y = sy(at);
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, TAU);
      stats.nodes += 1;
    }
    ctx.globalAlpha = group.alpha * group.fillAlpha;
    ctx.fillStyle = group.fill;
    ctx.fill();
    ctx.globalAlpha = group.alpha;
    ctx.strokeStyle = group.stroke;
    ctx.lineWidth = group.strokeWidth;
    ctx.stroke();
  }

  // The current table: filled with the accent and ringed.
  const center = model.centerIndex;
  if (center >= 0 && shown(center)) {
    const x = sx(center);
    const y = sy(center);
    const radius = radiusOf(center);
    ctx.globalAlpha = !mask || mask[center] === 1 ? 1 : fadedAlpha;
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, TAU);
    ctx.strokeStyle = palette.centerHalo;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fillStyle = palette.centerFill;
    ctx.fill();
    ctx.strokeStyle = palette.strokes[SIDE.center];
    ctx.lineWidth = 2;
    ctx.stroke();
    stats.nodes += 1;
  }

  // Self references: a small loop on top, once circles are big enough to carry one.
  if (frame.selfLoops !== false && scale >= 0.5) {
    ctx.beginPath();
    for (let at = 0; at < model.count; at += 1) {
      if (!model.loop[at] || !shown(at)) continue;
      const x = sx(at);
      const y = sy(at);
      if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;
      const radius = radiusOf(at);
      const spread = Math.max(3, radius * 0.45);
      ctx.moveTo(x - spread, y - radius + 1);
      ctx.bezierCurveTo(x - spread * 2.2, y - radius - 13, x + spread * 2.2, y - radius - 13, x + spread, y - radius + 1);
    }
    ctx.globalAlpha = (mask ? fadedAlpha : 1) * lineAlpha(scale) * 1.5;
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }

  // Rings on the pinned, active and dragged tables.
  for (const [at, color, widthPx] of [[frame.pinned ?? -1, palette.accent, 2.6], [active, palette.accent, 2], [frame.dragged ?? -1, palette.accent, 2.6]]) {
    if (at < 0 || !shown(at) || (at === active && at === frame.pinned)) continue;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(sx(at), sy(at), radiusOf(at) + (at === frame.pinned ? 2 : 1), 0, TAU);
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    ctx.stroke();
  }

  stats.labels = drawLabels(frame, { rect, mask, fade, radiusOf, sx, sy, shown });
  stats.fields = drawFieldLabels(frame, { radiusOf, sx, sy });
  ctx.globalAlpha = 1;
  return stats;
}

// ── names ─────────────────────────────────────────────────────

// A coarse occupancy grid over the screen; a name is drawn only where no
// other name is yet.
function labelGrid(width, height) {
  const columns = Math.ceil(width / LABEL_GRID_PX) + 1;
  const rows = Math.ceil(height / LABEL_GRID_PX) + 1;
  const cells = new Uint8Array(columns * rows);
  const span = (from, to, limit) => [clamp(Math.floor(from / LABEL_GRID_PX), 0, limit - 1), clamp(Math.floor(to / LABEL_GRID_PX), 0, limit - 1)];
  return {
    claim(x0, y0, x1, y1) {
      if (x1 < 0 || y1 < 0 || x0 > width || y0 > height) return false;
      const [c0, c1] = span(x0, x1, columns);
      const [r0, r1] = span(y0, y1, rows);
      for (let row = r0; row <= r1; row += 1) {
        for (let column = c0; column <= c1; column += 1) if (cells[row * columns + column]) return false;
      }
      for (let row = r0; row <= r1; row += 1) cells.fill(1, row * columns + c0, row * columns + c1 + 1);
      return true;
    },
  };
}

function* labelCandidates(frame, mask) {
  const { model } = frame;
  const seen = new Uint8Array(model.count);
  const first = [model.centerIndex, frame.pinned ?? -1, frame.focus ?? -1, frame.dragged ?? -1];
  for (const at of first) {
    if (at < 0 || seen[at]) continue;
    seen[at] = 1;
    yield [at, true];
  }
  const active = frame.focus ?? -1;
  if (mask && active >= 0) {
    // A few neighbours are always named; a busy table's neighbours come
    // first but still fade in with the zoom, or they would bury each other.
    const few = model.offsets[active + 1] - model.offsets[active] <= BUSY_FOCUS_LINKS;
    for (let cursor = model.offsets[active]; cursor < model.offsets[active + 1]; cursor += 1) {
      const at = model.neighbors[cursor];
      if (seen[at]) continue;
      seen[at] = 1;
      yield [at, few];
    }
  }
  for (const at of frame.labelOrder || []) {
    if (seen[at]) continue;
    yield [at, false];
  }
}

function drawLabels(frame, { rect, mask, fade, radiusOf, sx, sy, shown }) {
  const { ctx, width, height, view, model, xy, palette } = frame;
  const size = frame.font?.size || 11;
  const family = frame.font?.family || "system-ui, sans-serif";
  const grid = labelGrid(width, height);
  if (frame.reserveRight > 0) grid.claim(width - frame.reserveRight, 0, width, height);
  const strong = new Set([model.centerIndex, frame.pinned ?? -1, frame.focus ?? -1, frame.dragged ?? -1]);
  // Names that always show come first; the others share the room.
  const room = Math.max(1, Math.floor((width * height) / LABEL_AREA_PX));
  let drawn = 0;
  let others = 0;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = palette.halo;
  let currentFont = "";
  for (const [at, always] of labelCandidates(frame, mask)) {
    if (drawn >= LABEL_BUDGET || (!always && others >= room)) break;
    if (!shown(at)) continue;
    const x = xy[at * 2];
    const y = xy[at * 2 + 1];
    if (x < rect.x0 || x > rect.x1 || y < rect.y0 || y > rect.y1) continue;
    const lit = !mask || mask[at] === 1;
    let alpha = always ? 1 : labelAlpha(view.scale, model.radius[at]);
    // Names outside the active neighbourhood step back entirely.
    if (!lit) alpha *= 1 - fade;
    if (alpha <= 0.02) continue;
    const text = frame.labelText(at);
    if (!text) continue;
    const bold = strong.has(at);
    const textWidth = frame.labelWidth(at, size, bold);
    const left = sx(at) - textWidth / 2;
    const top = sy(at) + radiusOf(at) + LABEL_GAP_PX;
    if (!grid.claim(left - LABEL_PAD_PX, top - LABEL_PAD_PX, left + textWidth + LABEL_PAD_PX, top + size + LABEL_PAD_PX)) continue;
    const font = `${bold ? 600 : 400} ${size}px ${family}`;
    if (font !== currentFont) {
      ctx.font = font;
      currentFont = font;
    }
    ctx.globalAlpha = alpha;
    ctx.strokeText(text, left + textWidth / 2, top);
    ctx.fillStyle = bold ? palette.labelStrong : palette.label;
    ctx.fillText(text, left + textWidth / 2, top);
    drawn += 1;
    if (!always) others += 1;
  }
  return drawn;
}

// The source fields along the active table's lines (full-screen view).
function drawFieldLabels(frame, { radiusOf, sx, sy }) {
  const { ctx, model, view, palette } = frame;
  const active = frame.focus ?? -1;
  if (!frame.fieldText || active < 0 || (frame.fade ?? 1) < 0.5 || view.scale < FIELD_SCALE_MIN || frame.dragged >= 0) return 0;
  const size = Math.max(9.5, (frame.font?.size || 11) - 1.5);
  ctx.font = `${size}px ${frame.font?.mono || "ui-monospace, Consolas, monospace"}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 1;
  ctx.lineWidth = 4;
  ctx.strokeStyle = palette.halo;
  ctx.fillStyle = palette.field;
  let drawn = 0;
  for (let cursor = model.offsets[active]; cursor < model.offsets[active + 1] && drawn < FIELD_LABEL_MAX; cursor += 1) {
    const link = model.linkOf[cursor];
    const text = frame.fieldText(link);
    if (!text) continue;
    const from = model.source[link];
    const to = model.target[link];
    const length = Math.hypot(sx(to) - sx(from), sy(to) - sy(from));
    if (length < radiusOf(from) + radiusOf(to) + 60) continue;
    const x = (sx(from) + sx(to)) / 2;
    const y = (sy(from) + sy(to)) / 2;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    drawn += 1;
  }
  return drawn;
}

// ── hit testing ───────────────────────────────────────────────

/**
 * The table under a screen point: the closest circle containing it (with a
 * few pixels of slack), searched through a quadtree of table centers.
 */
export function nodeAtPoint({ tree, model, xy, view, width, height }, pointX, pointY, slackPx = 4) {
  if (!tree || !model.count) return -1;
  const x = (pointX - width / 2) / view.scale + view.x;
  const y = (pointY - height / 2) / view.scale + view.y;
  const sizeFactor = Math.sqrt(view.scale);
  const reach = (Math.max(NODE_SCREEN_MIN, model.maxRadius * sizeFactor) + slackPx) / view.scale;
  let best = -1;
  let bestGap = Infinity;
  tree.visit((quad, x0, y0, x1, y1) => {
    if (x0 > x + reach || x1 < x - reach || y0 > y + reach || y1 < y - reach) return true;
    if (!quad.length) {
      for (let entry = quad; entry; entry = entry.next) {
        const at = entry.data;
        const distance = Math.hypot(xy[at * 2] - x, xy[at * 2 + 1] - y) * view.scale;
        const gap = distance - Math.max(NODE_SCREEN_MIN, model.radius[at] * sizeFactor);
        if (gap <= slackPx && gap < bestGap) {
          bestGap = gap;
          best = at;
        }
      }
    }
    return false;
  });
  return best;
}
