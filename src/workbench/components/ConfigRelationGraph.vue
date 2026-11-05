<script setup>
// Draws one local relation graph: tables as circles sized by how many tables
// reference them and tinted by which side of the current table they are on,
// the relations between two tables as one line coloured by its worst status.
// Lines bow around tables in their way and every name takes the side of its
// table that keeps lines and arrowheads clear; in a crowded ring the names
// that would pile up wait until zooming in makes room for them. Hovering,
// focusing or dragging a table keeps only it and its direct neighbours
// bright, and names them. Tables can be dragged anywhere and stay there; the
// wheel zooms around the pointer, dragging empty space pans, the bottom edge
// resizes the inline graph, and a large view stretches the rings to use its
// room.
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import {
  relationStatusLabel,
  relationTitle,
  tableDisplayComment,
  tableDisplayName,
} from "../utils/configRelations.js";
import { GRAPH_HEIGHT, graphNeighbors, layoutRelationGraph } from "../utils/relationGraph.js";
import { relationGraphCard } from "../utils/relationGraphCard.js";
import {
  TOOL_STRIP_PX,
  arrowZones,
  layoutSpread,
  linkGeometry,
  linkPieces,
  placeLabels,
  screenPoint,
  textWidth,
} from "../utils/relationGraphGeometry.js";
import { useGraphViewport } from "../composables/useGraphViewport.js";
import { useGraphArrangement } from "../composables/useGraphArrangement.js";
import ConfigRelationGraphFrame from "./ConfigRelationGraphFrame.vue";

const props = defineProps({
  // Result of localRelationGraph().
  graph: { type: Object, required: true },
  // Backend lowercase-name -> { name, comment } map.
  tables: { type: Object, default: () => ({}) },
  height: { type: Number, default: GRAPH_HEIGHT.default },
  // Full-screen view: fills its parent, hides the resize edge and the
  // full-screen button, and shows comments under names.
  fill: { type: Boolean, default: false },
  // Names the graph so dragged tables keep their place for the session.
  layoutKey: { type: String, default: "" },
  // Lowercase name of the table open in the tab; it is not offered for opening.
  currentTable: { type: String, default: "" },
  // Offer "center on this table" in the pinned card (full-screen view).
  explore: { type: Boolean, default: false },
  // A short line over the graph after a change ({ id, text }).
  notice: { type: Object, default: null },
});

const emit = defineEmits(["open-table", "expand", "update:height", "focus-table"]);

const MARKER_STATUSES = Object.freeze(["confirmed", "unconfirmed", "stale", "conflict", "active"]);
// Highlighted lines of these statuses switch to the accent colour; stale and
// conflict keep their warning colours so the problem stays visible.
const ACCENT_STATUSES = new Set(["confirmed", "unconfirmed"]);
const ZOOM_STEP = 1.25;
// Names keep one on-screen size at every zoom level.
const LABEL_SCREEN_SIZE = 11;
const FILL_LABEL_SCREEN_SIZE = 13;
const COMMENT_SCREEN_SIZE = 11;
const LABEL_SCREEN_GAP = 5;
const LINE_HEIGHT = 1.3;
const COMMENT_MAX_CHARS = 16;
const FIELD_LABEL_SCREEN_SIZE = 10.5;
const FIELD_LABEL_MAX = 2;
// "Fit" stops enlarging a small graph here (screen pixels per graph unit).
const MAX_FIT_SCALE = 1.6;
// A large view stretches the rings to fill itself at about this scale.
const SPREAD_SCALE = 1.15;
// The dot grid behind the graph keeps one on-screen density at every zoom.
const GRID_SCREEN_STEP = 18;
const GRID_SCREEN_DOT = 0.9;
// Halo drawn around the current table, in screen pixels.
const CENTER_HALO = 5;
// Past this many tables, outer-ring names would pile up; they fade in as the
// user zooms toward OUTER_LABEL_FULL_SCALE and show at once on hover/focus.
const ALL_LABELS_NODE_LIMIT = 24;
const OUTER_LABEL_FADE_START = 0.8;
const OUTER_LABEL_FULL_SCALE = 1.1;
// The active table's neighbours are always named, unless there are more than
// this many: then they only come first among the names that wait for room.
const NAMED_NEIGHBORS_MAX = 12;
// Tables referenced by at least this many others are busy: where their name
// waits for room it may take any free side.
const BUSY_TABLE_REFERENCES = 8;
const DRAG_THRESHOLD_PX = 4;
const NUDGE_STEP_PX = 12;
// Screen room kept free right of the drawing for the tool strip.
const CONTROLS_RESERVE_PX = 48;

const markerPrefix = `wb-relation-graph-${Math.random().toString(36).slice(2, 10)}`;
const svgEl = ref(null);
const hostSize = ref({ width: 0, height: 0 });
const hoverId = ref("");
const dragId = ref("");
// Right-clicked table whose highlight and card stay put while the pointer roams.
const pinnedId = ref("");
let press = null;
let emptyPress = null;

const currentTable = computed(() => String(props.currentTable || props.graph.center || "").toLowerCase());
const labelSize = computed(() => (props.fill ? FILL_LABEL_SCREEN_SIZE : LABEL_SCREEN_SIZE));

function labelFor(id) {
  return tableDisplayName(props.tables, id);
}

// ── layout: rings stretched to the view, dragged tables kept ─────

const baseLayout = computed(() => layoutRelationGraph(props.graph, labelFor));
// A string so a resize that keeps the same stretch does not relayout.
const spreadKey = computed(() => {
  const spread = layoutSpread(hostSize.value, baseLayout.value?.extent, { scale: SPREAD_SCALE });
  return `${spread.x}:${spread.y}`;
});
const spread = computed(() => {
  const [x, y] = spreadKey.value.split(":").map(Number);
  return { x, y };
});
const layout = computed(() => (spreadKey.value === "1:1"
  ? baseLayout.value
  : layoutRelationGraph(props.graph, labelFor, { spread: spread.value })));

const arrangement = useGraphArrangement();
const positions = computed(() => {
  const current = arrangement.positions.value;
  return current.size ? current : layout.value?.positions || new Map();
});
const radii = computed(() => new Map(props.graph.nodes.map((node) => [node.id, node.radius])));

// What "fit" shows: set for a new picture and when the user asks; the room for
// the tool strip follows the measured width.
const contentBox = shallowRef({ x: -100, y: -100, width: 200, height: 200 });
const fitBox = computed(() => withControlsReserve(contentBox.value));
const viewport = useGraphViewport({ fit: fitBox, hostSize, svgEl, maxFitScale: MAX_FIT_SCALE });
const { viewBox, scale, panning } = viewport;

function withControlsReserve(box) {
  const width = hostSize.value.width;
  const share = width > 0 ? Math.min(0.16, Math.max(0.02, CONTROLS_RESERVE_PX / width)) : 0.16;
  return { ...box, width: box.width * (1 + share) };
}

function unionBox(boxes) {
  const list = boxes.filter(Boolean);
  if (!list.length) return null;
  const minX = Math.min(...list.map((box) => box.x));
  const minY = Math.min(...list.map((box) => box.y));
  const maxX = Math.max(...list.map((box) => box.x + box.width));
  const maxY = Math.max(...list.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Everything drawn right now: circles and the names beside them.
function drawingBox() {
  const pad = 10 / Math.max(scale.value, 0.2);
  const boxes = props.graph.nodes.flatMap((node) => {
    const point = positions.value.get(node.id);
    if (!point) return [];
    const label = placement.value?.get(node.id);
    const reach = node.radius + pad;
    const circle = { x: point.x - reach, y: point.y - reach, width: reach * 2, height: reach * 2 };
    return label ? [circle, { x: label.x0 - pad, y: label.y0 - pad, width: label.x1 - label.x0 + pad * 2, height: label.y1 - label.y0 + pad * 2 }] : [circle];
  });
  return unionBox(boxes);
}

// Where tables are headed, with room for a name on any side; used to fit a
// new picture before it has finished gliding into place.
function arrivalBox(pointMap) {
  const fontSize = labelSize.value / Math.max(scale.value, 0.2);
  const boxes = props.graph.nodes.flatMap((node) => {
    const point = pointMap.get(node.id);
    if (!point) return [];
    const reachX = node.radius + textWidth(nodeTexts.value.get(node.id)?.label, fontSize) + fontSize;
    const reachY = node.radius + fontSize * 2.6;
    return [{ x: point.x - reachX, y: point.y - reachY, width: reachX * 2, height: reachY * 2 }];
  });
  return unionBox(boxes);
}



// Without dragged tables, "fit" is the view the graph opened with; with them,
// it takes in wherever they were left.
function fitToDrawing() {
  const box = arrangement.arranged.value ? drawingBox() : layout.value?.bounds;
  if (box) contentBox.value = box;
  viewport.resetView();
}

function resetArrangement() {
  arrangement.reset();
  if (layout.value) contentBox.value = layout.value.bounds;
  viewport.resetView();
}

// ── highlight ─────────────────────────────────────────────────

const activeId = computed(() => dragId.value || pinnedId.value || hoverId.value);
const neighbors = computed(() => graphNeighbors(props.graph, activeId.value));

function displayName(id) {
  const name = tableDisplayName(props.tables, id);
  const comment = tableDisplayComment(props.tables, id);
  return comment ? `${name} · ${comment}` : name;
}

function nodeHint(node) {
  const key = node.depth === 0 ? "relations.graph.centerHint" : "relations.graph.nodeHint";
  const hint = t(key, { name: displayName(node.id), count: node.referencedBy });
  if (!node.selfStatus) return hint;
  return `${hint}\n${t("relations.graph.selfLoop")} · ${relationStatusLabel(node.selfStatus, t)}`;
}

function linkHint(link) {
  return link.relations
    .map((relation) => {
      const title = relationTitle(relation, props.tables);
      return relation.status === "confirmed" ? title : `${title} · ${relationStatusLabel(relation.status, t)}`;
    })
    .join("\n");
}

// The source fields of a line, for its label while one of its tables is active.
function fieldLabel(link) {
  const columns = [...new Set(link.relations.map((relation) => relation.sourceColumn))];
  const shown = columns.slice(0, FIELD_LABEL_MAX).join(", ");
  return columns.length > FIELD_LABEL_MAX ? `${shown} +${columns.length - FIELD_LABEL_MAX}` : shown;
}

// Text that does not change while tables move, kept out of the per-frame work.
function shortComment(text) {
  const value = String(text || "").trim();
  return value.length > COMMENT_MAX_CHARS ? `${value.slice(0, COMMENT_MAX_CHARS - 1)}…` : value;
}

const nodeTexts = computed(() => new Map(props.graph.nodes.map((node) => {
  const comment = props.fill ? shortComment(tableDisplayComment(props.tables, node.id)) : "";
  return [node.id, {
    hint: nodeHint(node),
    label: layout.value?.positions.get(node.id)?.label || "",
    comment,
  }];
})));
const linkTexts = computed(() => new Map(props.graph.links.map((link) => [link.id, { hint: linkHint(link), fields: fieldLabel(link) }])));

function outerLabelOpacity() {
  if (props.graph.nodes.length <= ALL_LABELS_NODE_LIMIT) return 1;
  const progress = (scale.value - OUTER_LABEL_FADE_START) / (OUTER_LABEL_FULL_SCALE - OUTER_LABEL_FADE_START);
  return Math.min(1, Math.max(0, progress));
}

// ── lines: routed around tables in the way ───────────────────

const geometries = computed(() => {
  const current = positions.value;
  const obstacles = props.graph.nodes.flatMap((node) => {
    const point = current.get(node.id);
    return point ? [{ id: node.id, x: point.x, y: point.y, radius: node.radius }] : [];
  });
  return new Map(props.graph.links.map((link) => [link.id, linkGeometry(link, current, radii.value, obstacles)]));
});

// ── names: each on the side of its table that keeps lines clear ──

// The current and the active table are always named, and so are the active
// table's neighbours when there are few. Other names wait for room where
// they would pile up or be cut off by the edge of the fitted view, clear of
// the tool strip (see placeLabels): the active table's neighbours and busy
// tables first, on any free side, then the first ring and the second, on
// the side away from their lines.
function nameRank(node, active, keepNeighbors) {
  if (node.depth === 0 || node.id === active) return 0;
  if (active && neighbors.value.has(node.id)) return keepNeighbors ? 0 : 1;
  if (node.referencedBy >= BUSY_TABLE_REFERENCES) return 1;
  return node.depth < 2 ? 2 : 3;
}

const nameFrame = computed(() => {
  const frame = viewport.fitFrame.value;
  return frame ? { ...frame, x1: frame.x1 - TOOL_STRIP_PX / frame.scale } : null;
});

let previousSides = new Map();
const placement = computed(() => {
  const current = positions.value;
  const unitScale = scale.value;
  const fontSize = labelSize.value / unitScale;
  const commentSize = COMMENT_SCREEN_SIZE / unitScale;
  const outerOpacity = outerLabelOpacity();
  const active = activeId.value;
  const keepNeighbors = Boolean(active) && neighbors.value.size - 1 <= NAMED_NEIGHBORS_MAX;
  const named = [];
  const unnamed = [];
  for (const node of props.graph.nodes) {
    const point = current.get(node.id);
    if (!point) continue;
    const texts = nodeTexts.value.get(node.id);
    const shown = node.depth < 2 || (Boolean(active) && neighbors.value.has(node.id)) || outerOpacity > 0;
    if (!shown || !texts?.label) {
      unnamed.push({ id: node.id, x: point.x, y: point.y, radius: node.radius });
      continue;
    }
    const width = Math.max(textWidth(texts.label, fontSize), texts.comment ? textWidth(texts.comment, commentSize) : 0);
    const height = fontSize * LINE_HEIGHT + (texts.comment ? commentSize * LINE_HEIGHT : 0);
    named.push({ id: node.id, x: point.x, y: point.y, radius: node.radius, width, height, rank: nameRank(node, active, keepNeighbors) });
  }
  const lines = props.graph.links.flatMap((link) => {
    const geometry = geometries.value.get(link.id);
    if (!geometry) return [];
    return [{
      source: link.source,
      target: link.target,
      pieces: linkPieces(geometry),
      arrows: arrowZones(geometry, { start: link.backward, end: link.forward }),
    }];
  });
  const result = placeLabels(named, lines, {
    center: props.graph.center,
    gap: LABEL_SCREEN_GAP / unitScale,
    previous: previousSides,
    obstacles: unnamed,
    frame: nameFrame.value,
  });
  previousSides = new Map([...result].map(([id, side]) => [id, side.direction]));
  return result;
});

// A new picture (or a new graph): glide there and fit it. Declared after the
// values it reads, since it runs once during setup.
let pictured = false;
watch([layout, () => props.layoutKey], ([next]) => {
  if (!next) return;
  arrangement.setLayout({ layoutKey: props.layoutKey, nodes: props.graph.nodes, homes: next.positions, spread: spread.value, animate: pictured });
  // Fit the ring layout plus wherever the user has dragged tables to.
  const dragged = arrangement.arranged.value ? arrivalBox(arrangement.targets()) : null;
  contentBox.value = unionBox([next.bounds, dragged]) || next.bounds;
  viewport.resetView({ animate: pictured });
  pictured = true;
}, { immediate: true });

const drawnNodes = computed(() => {
  const current = positions.value;
  const active = activeId.value;
  const outerOpacity = outerLabelOpacity();
  const fontSize = labelSize.value / scale.value;
  const commentSize = COMMENT_SCREEN_SIZE / scale.value;
  return props.graph.nodes.flatMap((node) => {
    const position = current.get(node.id);
    if (!position) return [];
    const highlighted = Boolean(active) && neighbors.value.has(node.id);
    const labelOpacity = node.depth < 2 || highlighted ? 1 : outerOpacity;
    const texts = nodeTexts.value.get(node.id);
    const side = placement.value.get(node.id);
    return [{
      ...node,
      x: position.x,
      y: position.y,
      label: texts?.label || "",
      comment: texts?.comment || "",
      labelOpacity: side ? labelOpacity : 0,
      // Name position relative to the table, from its chosen side.
      labelX: side ? side.x - position.x : 0,
      labelY: side ? side.y0 - position.y + fontSize * 0.82 : 0,
      commentY: side ? side.y0 - position.y + fontSize * LINE_HEIGHT + commentSize * 0.82 : 0,
      anchor: side?.anchor || "middle",
      fontSize,
      commentSize,
      halo: node.radius + CENTER_HALO / scale.value,
      faded: Boolean(active) && !highlighted,
      hovered: active === node.id,
      dragged: dragId.value === node.id,
      hint: texts?.hint || "",
    }];
  });
});

// Dot grid in graph units, sized so it reads the same at every zoom level.
const grid = computed(() => {
  const step = GRID_SCREEN_STEP / scale.value;
  return { step, dot: GRID_SCREEN_DOT / scale.value, offset: step / 2 };
});
const gridId = `${markerPrefix}-grid`;

const drawnLinks = computed(() => {
  const active = activeId.value;
  const fieldSize = FIELD_LABEL_SCREEN_SIZE / scale.value;
  return props.graph.links.flatMap((link) => {
    const geometry = geometries.value.get(link.id);
    if (!geometry) return [];
    const touches = Boolean(active) && (link.source === active || link.target === active);
    const accent = touches && ACCENT_STATUSES.has(link.status);
    const texts = linkTexts.value.get(link.id);
    return [{
      ...link,
      ...geometry,
      faded: Boolean(active) && !touches,
      highlighted: touches,
      accent,
      marker: markerUrl(accent ? "active" : link.status),
      hint: texts?.hint || "",
      // The full-screen view names the fields of the active table's lines.
      fields: props.fill && touches && !dragId.value ? texts?.fields || "" : "",
      fieldSize,
    }];
  });
});

function markerUrl(status) {
  return `url(#${markerPrefix}-${status})`;
}

// A small loop on top of the circle for a table that references itself.
function selfLoopPath(radius) {
  const spreadOut = Math.max(3, radius * 0.45);
  return `M ${-spreadOut} ${-radius + 1} C ${-spreadOut * 2.2} ${-radius - 13}, ${spreadOut * 2.2} ${-radius - 13}, ${spreadOut} ${-radius + 1}`;
}

// ── info card: the active table's drawn relations, by table ─────

const card = computed(() => {
  // The card stays out of the way while a table is being dragged.
  const id = dragId.value ? "" : pinnedId.value || hoverId.value;
  return relationGraphCard(props.graph, id, {
    pinned: Boolean(id) && pinnedId.value === id,
    tables: props.tables,
    currentTable: currentTable.value,
    explore: props.explore,
  });
});

// Where the card's table is on screen, so the card keeps clear of it.
const cardAnchor = computed(() => {
  if (!card.value) return null;
  const node = props.graph.nodes.find((candidate) => candidate.id === card.value.id);
  const point = screenPoint(positions.value.get(card.value.id), viewBox.value, hostSize.value);
  return point ? { ...point, radius: (node?.radius || 0) * scale.value } : null;
});

// ── pin: right-click a table; right-click it again to let go ─────

function togglePin(id) {
  pinnedId.value = pinnedId.value === id ? "" : id;
}

// A pin on a table that is no longer drawn has nothing to show.
watch(() => props.graph, (graph) => {
  if (pinnedId.value && !graph.nodes.some((node) => node.id === pinnedId.value)) pinnedId.value = "";
});

// Every right-click inside the graph is ours: on a table it pins or unpins
// it, anywhere else (the card included) it lets go. No menu of the app, the
// WebView or the system may open here.
function onContextMenu(event) {
  const nodeEl = event.target?.closest?.(".wb-relation-graph-node");
  if (nodeEl?.dataset.id) {
    togglePin(nodeEl.dataset.id);
    return;
  }
  pinnedId.value = "";
}

// Found through the find box: pinned, with its neighbourhood in view.
function revealNode(id) {
  if (!positions.value.get(id)) return;
  pinnedId.value = id;
  fitToDrawing();
}

// ── opening and centring ──────────────────────────────────────

function openNode(id) {
  if (!id || id === currentTable.value) return;
  emit("open-table", {
    name: tableDisplayName(props.tables, id),
    comment: tableDisplayComment(props.tables, id),
  });
}

function focusNode(id) {
  if (!id) return;
  pinnedId.value = "";
  hoverId.value = "";
  emit("focus-table", { id, name: tableDisplayName(props.tables, id) });
}

// Double-clicking empty space brings the whole drawing back into view.
function onDoubleClick(event) {
  if (event.target?.closest?.(".wb-relation-graph-node")) return;
  fitToDrawing();
}

// ── pointer: drag a table, pan empty space, click to open ─────

let pendingMove = null;
let moveFrame = 0;

function flushMove() {
  if (moveFrame) globalThis.cancelAnimationFrame?.(moveFrame);
  moveFrame = 0;
  if (pendingMove) arrangement.move(pendingMove.id, pendingMove.point);
  pendingMove = null;
}

// Pointer events can outpace the screen; move the table once per frame.
function scheduleMove(id, point) {
  pendingMove = { id, point };
  if (moveFrame || typeof globalThis.requestAnimationFrame !== "function") {
    if (!moveFrame) flushMove();
    return;
  }
  moveFrame = globalThis.requestAnimationFrame(() => {
    moveFrame = 0;
    flushMove();
  });
}

function capture(event) {
  svgEl.value?.setPointerCapture?.(event.pointerId);
}

function releaseCapture(event) {
  if (svgEl.value?.hasPointerCapture?.(event.pointerId)) svgEl.value.releasePointerCapture(event.pointerId);
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const nodeEl = event.target?.closest?.(".wb-relation-graph-node");
  if (nodeEl) {
    // A press only becomes a drag once it moves; until then it may be a click.
    const id = nodeEl.dataset.id;
    const point = viewport.graphPoint(event);
    const at = positions.value.get(id) || point;
    press = {
      pointerId: event.pointerId,
      id,
      clientX: event.clientX,
      clientY: event.clientY,
      // Where on the table it was grabbed, so it does not jump under the pointer.
      offset: { x: at.x - point.x, y: at.y - point.y },
      moved: false,
    };
    return;
  }
  // A press on empty space that does not turn into a pan lets go of a pin.
  emptyPress = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
  viewport.startPan(event);
  capture(event);
}

function endEmptyPress(event) {
  if (!emptyPress || event.pointerId !== emptyPress.pointerId) return;
  const moved = Math.hypot(event.clientX - emptyPress.clientX, event.clientY - emptyPress.clientY) >= DRAG_THRESHOLD_PX;
  emptyPress = null;
  if (!moved) pinnedId.value = "";
}

function onPointerMove(event) {
  if (press && event.pointerId === press.pointerId) {
    if (!(event.buttons & 1)) {
      // The button was released outside the graph before the press became a drag.
      press = null;
      return;
    }
    if (!press.moved) {
      if (Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) < DRAG_THRESHOLD_PX) return;
      press.moved = true;
      dragId.value = press.id;
      capture(event);
    }
    const point = viewport.graphPoint(event);
    scheduleMove(press.id, { x: point.x + press.offset.x, y: point.y + press.offset.y });
    return;
  }
  viewport.movePan(event);
}

function finishPress(event, { cancelled = false } = {}) {
  const { id, moved } = press;
  press = null;
  releaseCapture(event);
  if (moved) {
    flushMove();
    dragId.value = "";
  } else if (!cancelled) {
    openNode(id);
  }
}

function onPointerUp(event) {
  if (press && event.pointerId === press.pointerId) {
    finishPress(event);
    return;
  }
  endEmptyPress(event);
  if (viewport.endPan(event)) releaseCapture(event);
}

function onPointerCancel(event) {
  if (press && event.pointerId === press.pointerId) {
    finishPress(event, { cancelled: true });
    return;
  }
  emptyPress = null;
  if (viewport.endPan(event)) releaseCapture(event);
}

// ── keyboard on a focused table ───────────────────────────────

const NUDGE_KEYS = Object.freeze({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] });

function onNodeKeydown(event, node) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openNode(node.id);
    return;
  }
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    event.preventDefault();
    event.stopPropagation();
    togglePin(node.id);
    return;
  }
  const nudge = NUDGE_KEYS[event.key];
  if (!nudge) return;
  // Arrow keys move the focused table, Shift for bigger steps.
  event.preventDefault();
  event.stopPropagation();
  const at = positions.value.get(node.id);
  if (!at) return;
  const step = (NUDGE_STEP_PX * (event.shiftKey ? 4 : 1)) / scale.value;
  arrangement.move(node.id, { x: at.x + nudge[0] * step, y: at.y + nudge[1] * step });
}

// What the tool strip, the find box and the card ask of the drawing.
const frameActions = {
  zoomIn: () => viewport.zoomBy(ZOOM_STEP),
  zoomOut: () => viewport.zoomBy(1 / ZOOM_STEP),
  fit: fitToDrawing,
  resetLayout: resetArrangement,
  expand: () => emit("expand"),
  find: revealNode,
  open: openNode,
  focus: focusNode,
  unpin: () => {
    pinnedId.value = "";
  },
};

const findItems = computed(() => props.graph.nodes.map((node) => ({
  id: node.id,
  name: tableDisplayName(props.tables, node.id),
  comment: tableDisplayComment(props.tables, node.id),
})));

onBeforeUnmount(() => {
  if (moveFrame) globalThis.cancelAnimationFrame?.(moveFrame);
});
</script>

<template>
  <ConfigRelationGraphFrame
    :fill="fill"
    :height="height"
    :card="card"
    :card-anchor="cardAnchor"
    :arranged="arrangement.arranged.value"
    :host-class="{ 'is-panning': panning, 'is-dragging': Boolean(dragId), 'is-hovering': Boolean(activeId) }"
    :notice="notice"
    :find-items="findItems"
    @resize="hostSize = $event"
    @contextmenu="onContextMenu"
    @act="(name, value) => frameActions[name]?.(value)"
    @update:height="emit('update:height', $event)"
  >
    <svg
      ref="svgEl"
      class="wb-relation-graph-canvas"
      :viewBox="`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`"
      role="group"
      :aria-label="t('relations.graph.canvas', { name: tableDisplayName(tables, graph.center) })"
      @wheel="viewport.onWheel"
      @gesturestart="viewport.onGestureStart"
      @gesturechange="viewport.onGestureChange"
      @gestureend="viewport.onGestureEnd"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @dblclick="onDoubleClick"
    >
      <defs>
        <pattern :id="gridId" patternUnits="userSpaceOnUse" :width="grid.step" :height="grid.step">
          <circle class="wb-relation-graph-grid-dot" :cx="grid.offset" :cy="grid.offset" :r="grid.dot" />
        </pattern>
        <marker
          v-for="status in MARKER_STATUSES"
          :id="`${markerPrefix}-${status}`"
          :key="status"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6.5"
          markerHeight="6.5"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" class="wb-relation-graph-arrow" :class="`is-${status}`" />
        </marker>
      </defs>
      <rect
        class="wb-relation-graph-grid"
        :x="viewBox.x - viewBox.width"
        :y="viewBox.y - viewBox.height"
        :width="viewBox.width * 3"
        :height="viewBox.height * 3"
        :fill="`url(#${gridId})`"
      />
      <g class="wb-relation-graph-links">
        <path
          v-for="link in drawnLinks"
          :key="link.id"
          class="wb-relation-graph-link"
          :class="[`is-${link.status}`, { 'is-faded': link.faded, 'is-highlighted': link.highlighted, 'is-accent': link.accent }]"
          :d="link.d"
          :marker-end="link.forward ? link.marker : undefined"
          :marker-start="link.backward ? link.marker : undefined"
        ><title>{{ link.hint }}</title></path>
      </g>
      <g class="wb-relation-graph-field-labels" aria-hidden="true">
        <template v-for="link in drawnLinks" :key="link.id">
          <text
            v-if="link.fields"
            class="wb-relation-graph-field-label"
            text-anchor="middle"
            :x="link.mx"
            :y="link.my + link.fieldSize * 0.35"
            :font-size="link.fieldSize"
          >{{ link.fields }}</text>
        </template>
      </g>
      <g class="wb-relation-graph-nodes">
        <g
          v-for="node in drawnNodes"
          :key="node.id"
          class="wb-relation-graph-node"
          :class="{
            'is-center': node.depth === 0,
            'is-outer': node.depth === 2,
            [`is-side-${node.side}`]: node.depth > 0,
            'is-faded': node.faded,
            'is-hovered': node.hovered,
            'is-dragged': node.dragged,
            'is-pinned': pinnedId === node.id,
            [`has-${node.issue}`]: Boolean(node.issue),
          }"
          :data-id="node.id"
          :transform="`translate(${node.x} ${node.y})`"
          role="button"
          tabindex="0"
          :aria-label="node.hint"
          :aria-pressed="pinnedId === node.id"
          @pointerenter="hoverId = node.id"
          @pointerleave="hoverId = ''"
          @focus="hoverId = node.id"
          @blur="hoverId = ''"
          @keydown="onNodeKeydown($event, node)"
        >
          <circle v-if="node.depth === 0" class="wb-relation-graph-halo" :r="node.halo" />
          <path
            v-if="node.selfStatus"
            class="wb-relation-graph-loop"
            :class="`is-${node.selfStatus}`"
            :d="selfLoopPath(node.radius)"
          />
          <circle class="wb-relation-graph-dot" :r="node.radius" />
          <text
            v-if="node.labelOpacity > 0"
            class="wb-relation-graph-label"
            :text-anchor="node.anchor"
            :x="node.labelX"
            :y="node.labelY"
            :font-size="node.fontSize"
            :opacity="node.labelOpacity < 1 ? node.labelOpacity : undefined"
          >{{ node.label }}</text>
          <text
            v-if="node.comment && node.labelOpacity > 0"
            class="wb-relation-graph-comment"
            :text-anchor="node.anchor"
            :x="node.labelX"
            :y="node.commentY"
            :font-size="node.commentSize"
            :opacity="node.labelOpacity < 1 ? node.labelOpacity : undefined"
          >{{ node.comment }}</text>
        </g>
      </g>
    </svg>
  </ConfigRelationGraphFrame>
</template>

<style scoped>
.wb-relation-graph-canvas {
  display: block;
  width: 100%;
  height: 100%;
  /* Screen-sized labels can reach past the fitted box when zoomed out. */
  overflow: visible;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.wb-relation-graph.is-panning .wb-relation-graph-canvas,
.wb-relation-graph.is-dragging .wb-relation-graph-canvas,
.wb-relation-graph.is-dragging .wb-relation-graph-node {
  cursor: grabbing;
}

.wb-relation-graph-grid-dot {
  fill: color-mix(in srgb, var(--wb-text) 13%, transparent);
}

.wb-relation-graph-link {
  fill: none;
  stroke: color-mix(in srgb, var(--wb-text) 28%, transparent);
  stroke-width: 1.3;
  stroke-linecap: round;
  transition: opacity var(--wb-duration-base) ease, stroke var(--wb-duration-base) ease, stroke-width var(--wb-duration-base) ease;
}

.wb-relation-graph.is-dragging .wb-relation-graph-link,
.wb-relation-graph.is-dragging .wb-relation-graph-node {
  transition: none;
}

.wb-relation-graph-link.is-accent {
  stroke: var(--wb-accent);
}

.wb-relation-graph-link.is-unconfirmed {
  stroke-dasharray: 4 3;
}

.wb-relation-graph-link.is-stale {
  stroke: var(--wb-warning-border);
}

.wb-relation-graph-link.is-conflict {
  stroke: var(--wb-danger);
}

.wb-relation-graph-link.is-highlighted {
  stroke-width: 2;
}

.wb-relation-graph-link.is-faded {
  opacity: 0.1;
}

.wb-relation-graph-arrow {
  fill: color-mix(in srgb, var(--wb-text) 46%, transparent);
}

.wb-relation-graph-arrow.is-active {
  fill: var(--wb-accent);
}

.wb-relation-graph-arrow.is-stale {
  fill: var(--wb-warning-border);
}

.wb-relation-graph-arrow.is-conflict {
  fill: var(--wb-danger);
}

/* Field names riding on the active table's lines (full-screen view). */
.wb-relation-graph-field-label {
  fill: var(--wb-text);
  font-family: var(--wb-font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);
  paint-order: stroke;
  stroke: var(--wb-surface);
  stroke-width: 4px;
  stroke-linejoin: round;
  pointer-events: none;
  animation: wb-relation-graph-label-in 160ms ease;
}

.wb-relation-graph-node {
  cursor: pointer;
  outline: none;
  transition: opacity var(--wb-duration-base) ease;
}

.wb-relation-graph-node.is-dragged {
  cursor: grabbing;
}

.wb-relation-graph-node.is-faded {
  opacity: 0.18;
}

/* Neighbours take the hue of their side of the current table: tables this
   one references, tables that reference it, or both. */
.wb-relation-graph-dot {
  fill: color-mix(in srgb, var(--wb-text) 10%, var(--wb-surface));
  stroke: color-mix(in srgb, var(--wb-text) 38%, transparent);
  stroke-width: 1.5;
  transition: fill var(--wb-duration-base) ease, stroke var(--wb-duration-base) ease;
}

.wb-relation-graph-node.is-side-out .wb-relation-graph-dot {
  fill: var(--wb-relation-out-soft);
  stroke: var(--wb-relation-out);
}

.wb-relation-graph-node.is-side-in .wb-relation-graph-dot {
  fill: var(--wb-relation-in-soft);
  stroke: var(--wb-relation-in);
}

.wb-relation-graph-node.is-side-both .wb-relation-graph-dot {
  fill: color-mix(in srgb, var(--wb-relation-out-soft) 50%, var(--wb-relation-in-soft));
  stroke: color-mix(in srgb, var(--wb-relation-out) 50%, var(--wb-relation-in));
}

.wb-relation-graph-node.is-outer .wb-relation-graph-dot {
  fill-opacity: 0.7;
  stroke-opacity: 0.6;
  stroke-dasharray: 2.5 2;
}

.wb-relation-graph-node.is-center .wb-relation-graph-dot {
  fill: var(--wb-accent-control);
  stroke: var(--wb-surface);
  stroke-width: 2;
}

.wb-relation-graph-halo {
  fill: none;
  stroke: color-mix(in srgb, var(--wb-accent-control) 22%, transparent);
  stroke-width: 3;
}

.wb-relation-graph-node.has-stale .wb-relation-graph-dot {
  stroke: var(--wb-warning-border);
  stroke-width: 2.5;
  stroke-dasharray: none;
}

.wb-relation-graph-node.has-conflict .wb-relation-graph-dot {
  stroke: var(--wb-danger);
  stroke-width: 2.5;
  stroke-dasharray: none;
}

.wb-relation-graph-node.is-hovered:not(.is-center) .wb-relation-graph-dot,
.wb-relation-graph-node:not(.is-center):focus-visible .wb-relation-graph-dot {
  stroke-width: 2.5;
  stroke-opacity: 1;
  fill-opacity: 1;
}

.wb-relation-graph-node.is-dragged .wb-relation-graph-dot {
  filter: drop-shadow(0 2px 5px color-mix(in srgb, var(--wb-text) 32%, transparent));
}

.wb-relation-graph-node:focus-visible .wb-relation-graph-dot {
  stroke: var(--wb-accent);
  stroke-width: 3;
}

.wb-relation-graph-node.is-pinned .wb-relation-graph-dot {
  stroke: var(--wb-accent);
  stroke-width: 3;
  stroke-dasharray: none;
}

.wb-relation-graph-loop {
  fill: none;
  stroke: color-mix(in srgb, var(--wb-text) 40%, transparent);
  stroke-width: 1.4;
}

.wb-relation-graph-loop.is-stale {
  stroke: var(--wb-warning-border);
}

.wb-relation-graph-loop.is-conflict {
  stroke: var(--wb-danger);
}

.wb-relation-graph-label,
.wb-relation-graph-comment {
  paint-order: stroke;
  stroke: var(--wb-surface);
  stroke-width: 3px;
  stroke-linejoin: round;
  pointer-events: none;
  animation: wb-relation-graph-label-in 160ms ease;
}

.wb-relation-graph-label {
  fill: var(--wb-secondary-text);
}

.wb-relation-graph-comment {
  fill: var(--wb-quiet-text);
}

@keyframes wb-relation-graph-label-in {
  from {
    opacity: 0;
  }
}

.wb-relation-graph-node.is-center .wb-relation-graph-label,
.wb-relation-graph-node.is-hovered .wb-relation-graph-label,
.wb-relation-graph-node.is-pinned .wb-relation-graph-label {
  fill: var(--wb-text);
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .wb-relation-graph-link,
  .wb-relation-graph-node,
  .wb-relation-graph-dot {
    transition: none;
  }

  .wb-relation-graph-label,
  .wb-relation-graph-comment,
  .wb-relation-graph-field-label {
    animation: none;
  }
}
</style>
