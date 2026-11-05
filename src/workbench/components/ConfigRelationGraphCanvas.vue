<script setup>
// Draws a large relation graph (past the ring view's size, up to a whole
// database) the way Obsidian's graph view does: positions come from a force
// layout running in a worker, one canvas draws only what is on screen, and
// drawing stops whenever nothing moves. Tables keep the ring view's colours,
// card, pin and open gestures: hover lights a table's neighbourhood and dims
// the rest, a click opens the table, a right-click pins its card. Dragging a
// table brings the small tables hanging on it along while the rest of the
// picture holds still, and leaves it where it is dropped; the
// wheel zooms smoothly around the pointer, a released pan coasts, and names
// fade in as the user zooms, busier tables first. A new picture takes the
// shape of the view, so a wide window is filled rather than left with empty
// sides. A picture opened before in this session comes back at once (eased
// into the new shape when the view differs), and a changed graph only
// adjusts.
import { t } from "../i18n/index.js";
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { tableDisplayComment, tableDisplayName } from "../utils/configRelations.js";
import { GRAPH_HEIGHT } from "../utils/relationGraph.js";
import { relationGraphCard } from "../utils/relationGraphCard.js";
import { buildGraphModel, layoutAspect, neighborMask, positionsBox, seedPositions } from "../utils/relationGraphModel.js";
import { LAYOUT_ALPHA } from "../utils/forceLayoutAlpha.js";
import { createLayoutRunner, recallLayout, rememberLayout } from "../utils/relationGraphLayout.js";
import { createGraphCamera, wheelFactor } from "../utils/graphCamera.js";
import { drawGraphFrame, nodeAtPoint, nodeScreenRadius, readGraphPalette, shortLabel } from "../utils/relationGraphCanvas.js";
import { TOOL_STRIP_PX } from "../utils/relationGraphGeometry.js";
import { prefersReducedMotion } from "../composables/useGraphViewport.js";
import { quadtree } from "d3-quadtree";
import ConfigRelationGraphFrame from "./ConfigRelationGraphFrame.vue";

const props = defineProps({
  // Result of localRelationGraph() or databaseRelationGraph().
  graph: { type: Object, required: true },
  // Backend lowercase-name -> { name, comment } map.
  tables: { type: Object, default: () => ({}) },
  height: { type: Number, default: GRAPH_HEIGHT.default },
  fill: { type: Boolean, default: false },
  // Names the picture so its layout is remembered for the session.
  layoutKey: { type: String, default: "" },
  currentTable: { type: String, default: "" },
  explore: { type: Boolean, default: false },
  notice: { type: Object, default: null },
});

const emit = defineEmits(["open-table", "expand", "update:height", "focus-table"]);

const ZOOM_STEP = 1.4;
const DRAG_THRESHOLD_PX = 4;
const COAST_WINDOW_MS = 80;
const KEY_PAN_PX = 60;
const FIT_PADDING_PX = 36;
// "Fit" never blows a small drawing up past this scale (circles grow with
// the square root of the zoom, so a few tables can come this close).
const MAX_FIT_SCALE = 2.4;
const FADE_RATE = 0.2;
// The note about arranging appears only for layouts that take a while.
const STATUS_DELAY_MS = 450;
// Tables appear from the middle out, at least this many per frame.
const REVEAL_PER_FRAME = 50;
const REVEAL_FRAMES = 30;
const LABEL_SIZE = 11;
const FILL_LABEL_SIZE = 12;
const FIELD_LABEL_MAX = 2;
const SETTLE_DRAW_BUDGET_MS = 18;

const canvasEl = ref(null);
const hostSize = ref({ width: 0, height: 0 });
const hoverId = ref("");
const pinnedId = ref("");
const dragId = ref("");
const panning = ref(false);
const arranged = ref(false);
const settling = ref(false);
const cardAnchor = shallowRef(null);

const currentTable = computed(() => String(props.currentTable || props.graph.center || "").toLowerCase());

// ── model and layout ──────────────────────────────────────────

const model = computed(() => markRaw(buildGraphModel(props.graph)));
let xy = new Float32Array(0);
let drawnModel = null;
let drawnKey = null;
let layoutVersion = 0;
let layoutRunning = false;
// The view's width-to-height ratio the picture was laid out for; it keeps
// that shape while the view stays open, however it is resized.
let layoutShape = 1;
// Tables the user put somewhere, by id: [x, y].
let fixed = new Map();
let runner = null;
let statusTimer = 0;
let pictured = false;

function linkPairs(next) {
  const pairs = new Uint32Array(next.linkCount * 2);
  for (let link = 0; link < next.linkCount; link += 1) {
    pairs[link * 2] = next.source[link];
    pairs[link * 2 + 1] = next.target[link];
  }
  return pairs;
}

function positionsById(source, points) {
  const known = new Map();
  if (!source) return known;
  for (let at = 0; at < source.count; at += 1) known.set(source.ids[at], [points[at * 2], points[at * 2 + 1]]);
  return known;
}

function packFixed(next) {
  const packed = [];
  for (const [id, point] of fixed) {
    const at = next.index.get(id);
    if (at !== undefined) packed.push(at, point[0], point[1]);
  }
  return new Float32Array(packed);
}

function remember({ resting = !layoutRunning } = {}) {
  if (!drawnModel || !drawnKey) return;
  rememberLayout(drawnKey, { ids: drawnModel.ids, xy, fixed, resting, aspect: layoutShape });
}

// `quiet`: the layout only eases around a dropped table; no note for that.
function setStatus(running, { quiet = false } = {}) {
  layoutRunning = running;
  clearTimeout(statusTimer);
  if (!running || quiet) {
    settling.value = false;
    return;
  }
  statusTimer = setTimeout(() => { settling.value = layoutRunning; }, STATUS_DELAY_MS);
}

// A new or changed graph: tables already drawn keep their place, new ones
// grow out of their neighbours, and a picture seen before comes back as it
// was (stretched to this view when it was laid out for another shape).
function syncLayout() {
  const next = model.value;
  const key = props.layoutKey || "";
  const sameKey = drawnModel !== null && key === drawnKey;
  if (!sameKey) remember();
  if (!sameKey) layoutShape = layoutAspect(hostSize.value.width, hostSize.value.height, FIT_PADDING_PX);
  const memory = sameKey ? null : recallLayout(key, layoutShape);
  const known = sameKey ? positionsById(drawnModel, xy) : memory?.points || null;
  if (!sameKey) fixed = new Map(memory?.fixed || []);
  for (const id of [...fixed.keys()]) if (!next.index.has(id)) fixed.delete(id);
  arranged.value = fixed.size > 0;
  const seeds = seedPositions(next, known, { aspect: layoutShape });
  for (const [id, point] of fixed) {
    const at = next.index.get(id);
    seeds[at * 2] = point[0];
    seeds[at * 2 + 1] = point[1];
  }
  const everyKnown = Boolean(known?.size) && next.ids.every((id) => known.has(id));
  const unchanged = sameKey && everyKnown && drawnModel.count === next.count && drawnModel.linkCount === next.linkCount;
  let alpha = LAYOUT_ALPHA.fresh;
  if (memory?.resting && everyKnown) alpha = 0;
  else if (unchanged) alpha = 0;
  else if (known?.size) alpha = LAYOUT_ALPHA.update;
  xy = seeds;
  layoutVersion += 1;
  setStatus(alpha > 0);
  runner?.setGraph({
    version: layoutVersion,
    ids: next.ids,
    seeds,
    radius: next.radius,
    links: linkPairs(next),
    fixed: packFixed(next),
    alpha,
    reset: !sameKey,
    aspect: layoutShape,
  });
  resetCaches(next);
  if (pinnedId.value && !next.index.has(pinnedId.value)) pinnedId.value = "";
  if (hoverId.value && !next.index.has(hoverId.value)) hoverId.value = "";
  drawnModel = next;
  drawnKey = key;
  startReveal(known?.size ? null : seeds);
  if (!sameKey || !pictured) {
    // A new picture follows the layout until the user takes the camera.
    fitted = true;
    fitDrawing({ animate: pictured });
  }
  pictured = true;
  tree = null;
  invalidate();
}

function onPositions(message) {
  if (message?.type !== "positions" || message.version !== layoutVersion || !drawnModel) return;
  if (message.buffer.length !== drawnModel.count * 2) return;
  xy = message.buffer;
  if (drag) {
    xy[drag.index * 2] = drag.x;
    xy[drag.index * 2 + 1] = drag.y;
  }
  tree = null;
  if (layoutRunning && !message.running) {
    setStatus(false);
    remember({ resting: true });
    if (fitted) fitDrawing();
    invalidate();
    return;
  }
  requestSettleDraw();
}

// While a layout settles, a picture that is costly to draw is redrawn less
// often, so pointer, wheel and keys keep their turn on the main thread.
let settleTimer = 0;
function requestSettleDraw() {
  const cost = Math.max(lastDrawMs, heavy() ? frameCost : 0);
  if (cost <= SETTLE_DRAW_BUDGET_MS || drag) {
    invalidate();
    return;
  }
  contentDirty = true;
  if (settleTimer) return;
  settleTimer = setTimeout(() => {
    settleTimer = 0;
    invalidate();
  }, Math.min(120, cost));
}

// After a worker failure the main-thread layout starts from what is drawn.
function onRestart() {
  if (!drawnModel) return;
  layoutVersion += 1;
  runner.setGraph({
    version: layoutVersion,
    ids: drawnModel.ids,
    seeds: xy,
    radius: drawnModel.radius,
    links: linkPairs(drawnModel),
    fixed: packFixed(drawnModel),
    alpha: layoutRunning ? LAYOUT_ALPHA.update : 0,
    reset: true,
    aspect: layoutShape,
  });
}

function resetArrangement() {
  fixed = new Map();
  arranged.value = false;
  setStatus(true);
  runner?.release(LAYOUT_ALPHA.update * 1.6);
  fitted = true;
  invalidate();
}

// ── camera ────────────────────────────────────────────────────

const camera = createGraphCamera();
// True while the view follows the whole drawing; the user's zoom or pan ends it.
let fitted = true;

function drawingBox() {
  return positionsBox(xy, drawnModel?.count || 0, (drawnModel?.maxRadius || 0) + 10);
}

function updateLimits() {
  const box = drawingBox();
  if (!box) return;
  const whole = camera.fitScale(box, FIT_PADDING_PX);
  camera.setLimits({ min: Math.min(0.05, whole * 0.4), max: 8 });
}

function fitDrawing({ animate = true } = {}) {
  updateLimits();
  camera.fitTo(drawingBox(), { padding: FIT_PADDING_PX, maxScale: MAX_FIT_SCALE, animate: animate && !prefersReducedMotion() });
  requestDraw();
}

function fitToDrawing() {
  fitted = true;
  fitDrawing();
}

function zoomBy(factor) {
  fitted = false;
  camera.zoomAt(factor);
  requestDraw();
}

// ── colours and text ──────────────────────────────────────────

let palette = null;
let fontFamily = "system-ui, sans-serif";
let monoFamily = "ui-monospace, Consolas, monospace";
let labels = [];
let widths = new Map();
let fields = [];
let labelOrder = new Uint32Array(0);

function readTheme() {
  if (!canvasEl.value) return;
  const next = readGraphPalette(canvasEl.value);
  const style = canvasEl.value.ownerDocument.defaultView.getComputedStyle(canvasEl.value);
  const family = style.fontFamily || fontFamily;
  if (palette && JSON.stringify(next) === JSON.stringify(palette) && family === fontFamily) return;
  palette = next;
  fontFamily = family;
  monoFamily = style.getPropertyValue("--wb-font-mono").trim() || monoFamily;
  widths = new Map();
  invalidate();
}

// Style changes come in bursts (a theme switch touches several places);
// read the colours once they are over.
let themeTimer = 0;
function scheduleThemeRead() {
  clearTimeout(themeTimer);
  themeTimer = setTimeout(readTheme, 80);
}

function resetCaches(next) {
  labels = new Array(next.count);
  widths = new Map();
  fields = new Array(next.linkCount);
  // Busier tables claim room for their names first.
  labelOrder = Uint32Array.from(next.ids.keys()).sort((left, right) => next.radius[right] - next.radius[left]);
}

function labelText(at) {
  if (labels[at] === undefined) labels[at] = shortLabel(tableDisplayName(props.tables, drawnModel.ids[at]));
  return labels[at];
}

function labelWidth(at, size, bold) {
  const key = at * 2 + (bold ? 1 : 0);
  let width = widths.get(key);
  if (width === undefined) {
    const ctx = context();
    ctx.font = `${bold ? 600 : 400} ${LABEL_SIZE}px ${fontFamily}`;
    width = ctx.measureText(labelText(at)).width;
    widths.set(key, width);
  }
  return (width * size) / LABEL_SIZE;
}

// The source fields of a line, for its label while one of its tables is active.
function fieldText(link) {
  if (fields[link] === undefined) {
    const columns = [...new Set(drawnModel.links[link].relations.map((relation) => relation.sourceColumn))];
    const shown = columns.slice(0, FIELD_LABEL_MAX).join(", ");
    fields[link] = columns.length > FIELD_LABEL_MAX ? `${shown} +${columns.length - FIELD_LABEL_MAX}` : shown;
  }
  return fields[link];
}

// ── highlight: the active table's neighbourhood stays bright ───

const activeId = computed(() => dragId.value || pinnedId.value || hoverId.value);
let fade = 0;
let focusIndex = -1;
let focusMask = null;

watch(activeId, (id) => {
  const at = id ? drawnModel?.index.get(id) ?? -1 : -1;
  if (at >= 0) {
    focusIndex = at;
    focusMask = neighborMask(drawnModel, at, focusMask?.length === drawnModel.count ? focusMask : undefined);
  }
  invalidate();
});

function stepFade() {
  const goal = activeId.value ? 1 : 0;
  if (prefersReducedMotion() || heavy()) fade = goal;
  else fade += (goal - fade) * FADE_RATE;
  if (Math.abs(goal - fade) < 0.01) fade = goal;
  if (!goal && fade === 0) focusIndex = -1;
  return fade !== goal;
}

// ── reveal: a fresh picture grows from the middle out ──────────

let revealed = null;
let revealOrder = null;
let revealCount = 0;

function startReveal(seeds) {
  const count = drawnModel?.count || 0;
  if (!seeds || prefersReducedMotion() || heavy() || count <= REVEAL_PER_FRAME) {
    revealed = null;
    return;
  }
  const box = positionsBox(seeds, count);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const distance = new Float32Array(count);
  for (let at = 0; at < count; at += 1) distance[at] = Math.hypot(seeds[at * 2] - centerX, seeds[at * 2 + 1] - centerY);
  revealOrder = Uint32Array.from(drawnModel.ids.keys()).sort((left, right) => distance[left] - distance[right]);
  revealed = new Uint8Array(count);
  revealCount = 0;
}

function stepReveal() {
  if (!revealed) return false;
  const batch = Math.max(REVEAL_PER_FRAME, Math.ceil(revealOrder.length / REVEAL_FRAMES));
  const end = Math.min(revealOrder.length, revealCount + batch);
  for (let cursor = revealCount; cursor < end; cursor += 1) revealed[revealOrder[cursor]] = 1;
  revealCount = end;
  if (revealCount >= revealOrder.length) revealed = null;
  return true;
}

// ── drawing: only while something moves ───────────────────────

let frame = 0;
let ctxCache = null;
let pixelRatio = 1;

function context() {
  if (!ctxCache) ctxCache = canvasEl.value.getContext("2d");
  return ctxCache;
}

function requestDraw() {
  if (frame || !canvasEl.value) return;
  frame = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(drawFrame) : setTimeout(drawFrame, 16);
}

function sizeCanvas() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const { width, height } = hostSize.value;
  pixelRatio = globalThis.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * pixelRatio));
  const pixelHeight = Math.max(1, Math.round(height * pixelRatio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    contentDirty = true;
  }
  camera.setSize(width, height);
}

// ── heavy pictures: where drawing a frame takes longer than a frame ─
//
// Some machines draw canvases without the graphics card. Then a big graph
// costs more than a frame to paint, so while only the camera moves the last
// sharp picture is moved and scaled instead (a sharp one follows as soon as
// the camera rests, or every few hundred milliseconds), and highlights
// switch at once instead of fading.
const HEAVY_FRAME_MS = 34;
const SHARP_EVERY_MS = 600;
let contentDirty = true;
let lastFrameAt = 0;
let frameCost = 16;
let snapshot = null;
let snapshotAt = 0;
let sharpView = null;

function heavy() {
  return frameCost > HEAVY_FRAME_MS;
}

// Something drawn changed (not only the camera): the next frame is drawn in full.
function invalidate() {
  contentDirty = true;
  requestDraw();
}

// The gap between a fully drawn frame and the next animation frame tells
// how long painting it really took (the canvas paints after the script).
let lastFrameFull = false;
function noteFrameTime(now) {
  if (lastFrameFull && lastFrameAt && now - lastFrameAt < 250) frameCost = frameCost * 0.7 + (now - lastFrameAt) * 0.3;
  lastFrameAt = now;
}

function takeSnapshot() {
  const canvas = canvasEl.value;
  if (!snapshot) snapshot = { canvas: canvas.ownerDocument.createElement("canvas"), view: null };
  if (snapshot.canvas.width !== canvas.width || snapshot.canvas.height !== canvas.height) {
    snapshot.canvas.width = canvas.width;
    snapshot.canvas.height = canvas.height;
  }
  const copy = snapshot.canvas.getContext("2d");
  copy.setTransform(1, 0, 0, 1, 0, 0);
  copy.clearRect(0, 0, canvas.width, canvas.height);
  copy.drawImage(canvas, 0, 0);
  snapshot.view = { ...sharpView };
}

// The last sharp picture, moved and scaled to the camera.
function drawSnapshot(ctx, width, height) {
  const from = snapshot.view;
  const view = camera.view;
  const ratio = view.scale / from.scale;
  const dx = (width / 2 - (ratio * width) / 2 + (from.x - view.x) * view.scale) * pixelRatio;
  const dy = (height / 2 - (ratio * height) / 2 + (from.y - view.y) * view.scale) * pixelRatio;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasEl.value.width, canvasEl.value.height);
  ctx.drawImage(snapshot.canvas, dx, dy, snapshot.canvas.width * ratio, snapshot.canvas.height * ratio);
}

function drawFrame(now = globalThis.performance?.now?.() ?? 0) {
  frame = 0;
  if (!canvasEl.value || !drawnModel || !palette) return;
  const { width, height } = hostSize.value;
  if (!width || !height) return;
  noteFrameTime(now);
  const started = globalThis.performance?.now?.() ?? 0;
  if (fitted && layoutRunning) fitDrawing();
  const moving = camera.step();
  const fading = stepFade();
  const revealing = stepReveal();
  if (fading || revealing || drag) contentDirty = true;
  const ctx = context();
  const view = camera.view;
  // Only the camera moved on a heavy picture: move the last sharp one, and
  // paint a sharp one again every so often while the motion goes on.
  if (!contentDirty && moving && heavy() && sharpView) {
    if (!snapshot?.view) {
      takeSnapshot();
      snapshotAt = started;
    }
    if (started - snapshotAt < SHARP_EVERY_MS) {
      drawSnapshot(ctx, width, height);
      followCamera(width, height, view);
      lastFrameFull = false;
      requestDraw();
      return;
    }
  }
  if (snapshot) snapshot.view = null;
  lastFrameFull = true;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  const stats = drawGraphFrame({
    ctx,
    width,
    height,
    view,
    model: drawnModel,
    xy,
    palette,
    font: { family: fontFamily, mono: monoFamily, size: props.fill ? FILL_LABEL_SIZE : LABEL_SIZE },
    focus: focusIndex,
    mask: focusIndex >= 0 ? focusMask : null,
    fade,
    pinned: indexOf(pinnedId.value),
    dragged: indexOf(dragId.value),
    revealed,
    labelOrder,
    labelText,
    labelWidth,
    fieldText: props.fill ? fieldText : null,
    reserveRight: TOOL_STRIP_PX,
  });
  contentDirty = false;
  sharpView = { scale: view.scale, x: view.x, y: view.y };
  followCamera(width, height, view);
  lastStats = stats;
  lastDrawMs = (globalThis.performance?.now?.() ?? 0) - started;
  drawCount += 1;
  if (drawTimes) {
    drawTimes.push(lastDrawMs);
    if (drawTimes.length > 600) drawTimes.shift();
  }
  if (moving || fading || revealing || drag) requestDraw();
}

// What follows the camera without redrawing: the dot grid (at one on-screen
// density) and the card's anchor.
function followCamera(width, height, view) {
  canvasEl.value.style.backgroundPosition = `${(width / 2 - view.x * view.scale) % 18}px ${(height / 2 - view.y * view.scale) % 18}px`;
  updateCardAnchor();
}

let lastStats = null;
let lastDrawMs = 0;
let drawCount = 0;
// The measurements and browser regression tests aim at tables through a
// probe on the canvas: in development, and in a preview opened on the
// generated relation lab (`?relationLab=`), never in the desktop app.
const probeEnabled = import.meta.env.DEV || /[?&]relationLab=/u.test(globalThis.location?.search || "");
// Recent frame costs, kept only for the probe.
const drawTimes = probeEnabled ? [] : null;

function indexOf(id) {
  return id ? drawnModel?.index.get(id) ?? -1 : -1;
}

// ── hit testing ───────────────────────────────────────────────

let tree = null;

function nodeAt(screenX, screenY) {
  if (!drawnModel?.count) return -1;
  if (!tree) {
    tree = quadtree()
      .x((at) => xy[at * 2])
      .y((at) => xy[at * 2 + 1])
      .addAll(Array.from(drawnModel.ids.keys()));
  }
  const { width, height } = hostSize.value;
  return nodeAtPoint({ tree, model: drawnModel, xy, view: camera.view, width, height }, screenX, screenY);
}

function localPoint(event) {
  const rect = canvasEl.value.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// ── info card ─────────────────────────────────────────────────

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

function updateCardAnchor() {
  const at = indexOf(card.value?.id);
  if (at < 0) {
    if (cardAnchor.value) cardAnchor.value = null;
    return;
  }
  const point = camera.toScreen(xy[at * 2], xy[at * 2 + 1]);
  const radius = nodeScreenRadius(drawnModel.radius[at], camera.view.scale);
  const previous = cardAnchor.value;
  if (previous && Math.abs(previous.x - point.x) < 2 && Math.abs(previous.y - point.y) < 2 && Math.abs(previous.radius - radius) < 1) return;
  cardAnchor.value = { x: point.x, y: point.y, radius };
}

watch(card, () => {
  updateCardAnchor();
  invalidate();
});

// ── pin, open, center ─────────────────────────────────────────

function togglePin(id) {
  pinnedId.value = pinnedId.value === id ? "" : id;
}

// Every right-click inside the graph is ours: on a table it pins or unpins
// it, anywhere else (the card included) it lets go.
function onContextMenu(event) {
  if (event.target === canvasEl.value) {
    const point = localPoint(event);
    const at = nodeAt(point.x, point.y);
    if (at >= 0) {
      togglePin(drawnModel.ids[at]);
      return;
    }
  }
  pinnedId.value = "";
}

function openNode(id) {
  if (!id || id === currentTable.value) return;
  emit("open-table", { name: tableDisplayName(props.tables, id), comment: tableDisplayComment(props.tables, id) });
}

function focusNode(id) {
  if (!id) return;
  pinnedId.value = "";
  hoverId.value = "";
  emit("focus-table", { id, name: tableDisplayName(props.tables, id) });
}

// Found through the find box: brought into view and pinned.
function revealNode(id) {
  const at = indexOf(id);
  if (at < 0) return;
  pinnedId.value = id;
  fitted = false;
  camera.fitTo({ x: xy[at * 2] - 1, y: xy[at * 2 + 1] - 1, width: 2, height: 2 }, {
    maxScale: Math.max(camera.view.scale, 1.1),
    animate: !prefersReducedMotion(),
  });
  invalidate();
}

// The tool strip, the find box and the card, answered by the canvas.
function onFrameAction(name, value) {
  if (name === "zoomIn" || name === "zoomOut") zoomBy(name === "zoomIn" ? ZOOM_STEP : 1 / ZOOM_STEP);
  else if (name === "fit") fitToDrawing();
  else if (name === "resetLayout") resetArrangement();
  else if (name === "expand") emit("expand");
  else if (name === "find") revealNode(value);
  else if (name === "open") openNode(value);
  else if (name === "focus") focusNode(value);
  else if (name === "unpin") pinnedId.value = "";
}

const findItems = computed(() => props.graph.nodes.map((node) => ({
  id: node.id,
  name: tableDisplayName(props.tables, node.id),
  comment: tableDisplayComment(props.tables, node.id),
})));

// ── pointer: drag a table, pan empty space, click to open ─────

let press = null;
let pan = null;
let drag = null;
let pinFrame = 0;

function sendPin() {
  pinFrame = 0;
  if (drag) runner?.pin(drag.index, drag.x, drag.y);
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  canvasEl.value.focus({ preventScroll: true });
  const point = localPoint(event);
  const at = nodeAt(point.x, point.y);
  canvasEl.value.setPointerCapture?.(event.pointerId);
  if (at >= 0) {
    const grabbed = camera.toGraph(point.x, point.y);
    press = {
      pointerId: event.pointerId,
      index: at,
      startX: point.x,
      startY: point.y,
      // Where on the table it was grabbed, so it does not jump under the pointer.
      offsetX: xy[at * 2] - grabbed.x,
      offsetY: xy[at * 2 + 1] - grabbed.y,
      moved: false,
    };
    return;
  }
  camera.stopMotion();
  pan = { pointerId: event.pointerId, x: point.x, y: point.y, startX: point.x, startY: point.y, vx: 0, vy: 0, at: 0, moved: false };
  panning.value = true;
}

function onPointerMove(event) {
  const point = localPoint(event);
  if (press && event.pointerId === press.pointerId) {
    if (!press.moved) {
      if (Math.hypot(point.x - press.startX, point.y - press.startY) < DRAG_THRESHOLD_PX) return;
      press.moved = true;
      fitted = false;
      dragId.value = drawnModel.ids[press.index];
      drag = { index: press.index, x: xy[press.index * 2], y: xy[press.index * 2 + 1] };
      runner?.drag(true, press.index);
      setStatus(false);
    }
    const at = camera.toGraph(point.x, point.y);
    drag.x = at.x + press.offsetX;
    drag.y = at.y + press.offsetY;
    xy[drag.index * 2] = drag.x;
    xy[drag.index * 2 + 1] = drag.y;
    tree = null;
    if (!pinFrame) pinFrame = globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(sendPin) : setTimeout(sendPin, 16);
    invalidate();
    return;
  }
  if (pan && event.pointerId === pan.pointerId) {
    const dx = point.x - pan.x;
    const dy = point.y - pan.y;
    if (!pan.moved && Math.hypot(point.x - pan.startX, point.y - pan.startY) >= DRAG_THRESHOLD_PX) pan.moved = true;
    if (!pan.moved) return;
    fitted = false;
    camera.panBy(dx, dy);
    // Keep a smoothed velocity for the coast after release.
    pan.vx = pan.vx * 0.6 + dx * 0.4;
    pan.vy = pan.vy * 0.6 + dy * 0.4;
    pan.at = event.timeStamp;
    pan.x = point.x;
    pan.y = point.y;
    requestDraw();
    return;
  }
  const at = nodeAt(point.x, point.y);
  hoverId.value = at >= 0 ? drawnModel.ids[at] : "";
}

function finishPress(event, { cancelled = false } = {}) {
  const { index, moved } = press;
  press = null;
  if (moved) {
    if (pinFrame) {
      globalThis.cancelAnimationFrame?.(pinFrame);
      sendPin();
    }
    fixed.set(drawnModel.ids[index], [drag.x, drag.y]);
    arranged.value = true;
    drag = null;
    dragId.value = "";
    runner?.drag(false);
    setStatus(true, { quiet: true });
    remember({ resting: false });
  } else if (!cancelled) {
    openNode(drawnModel.ids[index]);
  }
  invalidate();
}

function onPointerUp(event) {
  if (canvasEl.value?.hasPointerCapture?.(event.pointerId)) canvasEl.value.releasePointerCapture(event.pointerId);
  if (press && event.pointerId === press.pointerId) {
    finishPress(event);
    return;
  }
  if (pan && event.pointerId === pan.pointerId) {
    // A pan released while still moving coasts; one held still first stops.
    if (pan.moved && !prefersReducedMotion() && event.timeStamp - pan.at < COAST_WINDOW_MS) camera.coast(pan.vx, pan.vy);
    else if (!pan.moved) pinnedId.value = "";
    pan = null;
    panning.value = false;
    requestDraw();
  }
}

function onPointerCancel(event) {
  if (press && event.pointerId === press.pointerId) {
    finishPress(event, { cancelled: true });
    return;
  }
  pan = null;
  panning.value = false;
}

function onPointerLeave() {
  if (!press && !pan) hoverId.value = "";
}

function onWheel(event) {
  event.preventDefault();
  const point = localPoint(event);
  fitted = false;
  camera.zoomAt(wheelFactor(event), point.x, point.y);
  requestDraw();
}

// WebKit trackpad pinch — event.scale is cumulative across the gesture, so
// each change applies the ratio since the last event around the pointer.
let gestureScale = 1;
function onGestureStart(event) {
  event.preventDefault();
  gestureScale = event.scale || 1;
}
function onGestureChange(event) {
  event.preventDefault();
  const point = localPoint(event);
  const next = event.scale || 1;
  const factor = next / gestureScale;
  gestureScale = next;
  if (factor !== 1) {
    fitted = false;
    camera.zoomAt(factor, point.x, point.y);
    requestDraw();
  }
}
function onGestureEnd(event) {
  event.preventDefault();
  gestureScale = 1;
}

function onDoubleClick(event) {
  const point = localPoint(event);
  if (nodeAt(point.x, point.y) < 0) fitToDrawing();
}

// ── keyboard on the focused canvas ────────────────────────────

const PAN_KEYS = Object.freeze({ ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] });

function onKeydown(event) {
  const direction = PAN_KEYS[event.key];
  if (direction) {
    event.preventDefault();
    fitted = false;
    camera.panBy(direction[0] * KEY_PAN_PX, direction[1] * KEY_PAN_PX);
    requestDraw();
    return;
  }
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomBy(ZOOM_STEP);
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    zoomBy(1 / ZOOM_STEP);
  } else if (event.key === "0") {
    event.preventDefault();
    fitToDrawing();
  } else if (event.key === "Escape" && pinnedId.value) {
    // Let go of the pin first; the next Escape may close the view.
    event.preventDefault();
    pinnedId.value = "";
  } else if (event.key === "Enter" && (pinnedId.value || hoverId.value)) {
    event.preventDefault();
    openNode(pinnedId.value || hoverId.value);
  }
}

// ── lifecycle ─────────────────────────────────────────────────

let themeObserver = null;
let colorScheme = null;

function onResize(size) {
  hostSize.value = size;
  sizeCanvas();
  if (fitted) fitDrawing({ animate: false });
  invalidate();
}

watch(model, () => syncLayout());

onMounted(() => {
  runner = createLayoutRunner({ onPositions, onRestart });
  readTheme();
  sizeCanvas();
  syncLayout();
  // Theme switches restyle the tokens; read the colours again.
  const themed = canvasEl.value?.closest?.("[data-theme]");
  if (typeof MutationObserver === "function") {
    themeObserver = new MutationObserver(scheduleThemeRead);
    if (themed) themeObserver.observe(themed, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    themeObserver.observe(document.head, { childList: true });
  }
  colorScheme = globalThis.matchMedia?.("(prefers-color-scheme: dark)") || null;
  colorScheme?.addEventListener?.("change", scheduleThemeRead);
  if (probeEnabled) {
    // Lets the browser regression tests aim at tables on the canvas.
    canvasEl.value.__relationGraph = {
      ids: () => [...(drawnModel?.ids || [])],
      point(id) {
        const at = indexOf(id);
        if (at < 0) return null;
        const rect = canvasEl.value.getBoundingClientRect();
        const point = camera.toScreen(xy[at * 2], xy[at * 2 + 1]);
        return { x: rect.left + point.x, y: rect.top + point.y, radius: nodeScreenRadius(drawnModel.radius[at], camera.view.scale) };
      },
      state: () => ({ scale: camera.view.scale, running: layoutRunning, arranged: arranged.value, stats: lastStats, worker: runner?.usesWorker(), draws: drawCount }),
      drawTimes: (clear = false) => {
        const times = [...drawTimes];
        if (clear) drawTimes.length = 0;
        return times;
      },
    };
  }
});

onBeforeUnmount(() => {
  remember();
  runner?.dispose();
  runner = null;
  clearTimeout(statusTimer);
  clearTimeout(settleTimer);
  if (frame) {
    globalThis.cancelAnimationFrame?.(frame);
    clearTimeout(frame);
  }
  if (pinFrame) globalThis.cancelAnimationFrame?.(pinFrame);
  themeObserver?.disconnect();
  clearTimeout(themeTimer);
  colorScheme?.removeEventListener?.("change", scheduleThemeRead);
});

// The same count as the section head: the tables around the current one.
const statusText = computed(() => {
  if (!settling.value) return "";
  const count = props.graph.nodes.length - (props.graph.scope === "database" ? 0 : 1);
  return t("relations.graph.arranging", { count });
});
</script>

<template>
  <ConfigRelationGraphFrame
    :fill="fill"
    :height="height"
    :card="card"
    :card-anchor="cardAnchor"
    :arranged="arranged"
    :host-class="{ 'is-panning': panning, 'is-dragging': Boolean(dragId), 'is-hovering': Boolean(activeId), 'is-large': true }"
    :status="statusText"
    :notice="notice"
    :find-items="findItems"
    @resize="onResize"
    @contextmenu="onContextMenu"
    @act="onFrameAction"
    @update:height="emit('update:height', $event)"
  >
    <canvas
      ref="canvasEl"
      class="wb-relation-graph-surface"
      :class="{ 'is-over-node': Boolean(hoverId) }"
      tabindex="0"
      role="application"
      :aria-label="t('relations.graph.canvasLarge', { name: tableDisplayName(tables, graph.center), count: graph.nodes.length })"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="onPointerLeave"
      @wheel="onWheel"
      @gesturestart="onGestureStart"
      @gesturechange="onGestureChange"
      @gestureend="onGestureEnd"
      @dblclick="onDoubleClick"
      @keydown="onKeydown"
    />
  </ConfigRelationGraphFrame>
</template>

<style scoped>
.wb-relation-graph-surface {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
  cursor: grab;
  touch-action: none;
  user-select: none;
  /* A dot grid at one on-screen density; its offset follows the pan. */
  background-image: radial-gradient(circle, color-mix(in srgb, var(--wb-text) 13%, transparent) 0.9px, transparent 1.1px);
  background-size: 18px 18px;
}

.wb-relation-graph-surface.is-over-node {
  cursor: pointer;
}

.wb-relation-graph.is-panning .wb-relation-graph-surface,
.wb-relation-graph.is-dragging .wb-relation-graph-surface {
  cursor: grabbing;
}

.wb-relation-graph-surface:focus-visible {
  box-shadow: inset 0 0 0 2px var(--wb-accent);
  border-radius: 8px;
}
</style>
