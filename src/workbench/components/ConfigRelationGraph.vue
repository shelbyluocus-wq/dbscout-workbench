<script setup>
// Draws one local relation graph: tables as circles sized by how many tables
// reference them, the relations between two tables as one line coloured by
// its worst status. Hovering, focusing or dragging a table keeps only it and
// its direct neighbours bright. Tables can be dragged (neighbours follow on
// springs and everything swings back on release), the wheel zooms around the
// pointer, dragging empty space pans and the bottom edge resizes the graph.
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { LocateFixed, Maximize2, ZoomIn, ZoomOut } from "lucide-vue-next";
import {
  relationStatusLabel,
  relationTitle,
  tableDisplayComment,
  tableDisplayName,
} from "../utils/configRelations.js";
import {
  GRAPH_HEIGHT,
  clampGraphHeight,
  graphNeighbors,
  layoutRelationGraph,
  linkSegment,
} from "../utils/relationGraph.js";
import { useGraphViewport } from "../composables/useGraphViewport.js";
import { useGraphForces } from "../composables/useGraphForces.js";

const props = defineProps({
  // Result of localRelationGraph().
  graph: { type: Object, required: true },
  // Backend lowercase-name -> { name, comment } map.
  tables: { type: Object, default: () => ({}) },
  height: { type: Number, default: GRAPH_HEIGHT.default },
  // Fill the parent instead of using `height`; hides the resize edge and the
  // expand button (used by the enlarged view).
  fill: { type: Boolean, default: false },
});

const emit = defineEmits(["open-table", "expand", "update:height"]);

const MARKER_STATUSES = Object.freeze(["confirmed", "unconfirmed", "stale", "conflict", "active"]);
// Highlighted lines of these statuses switch to the accent colour; stale and
// conflict keep their warning colours so the problem stays visible.
const ACCENT_STATUSES = new Set(["confirmed", "unconfirmed"]);
const ZOOM_STEP = 1.25;
// Labels keep one on-screen size at every zoom level.
const LABEL_SCREEN_SIZE = 10.5;
const LABEL_SCREEN_GAP = 3;
// Past this many tables, outer-ring labels would pile up; they fade in as the
// user zooms toward OUTER_LABEL_FULL_SCALE and show at once on hover/focus.
const ALL_LABELS_NODE_LIMIT = 24;
const OUTER_LABEL_FADE_START = 0.8;
const OUTER_LABEL_FULL_SCALE = 1.1;
const DRAG_THRESHOLD_PX = 4;
const RESIZE_KEY_STEP = 20;
// Share of the fitted height kept free below the drawing for the zoom buttons.
const CONTROLS_RESERVE = 0.14;

const markerPrefix = `wb-relation-graph-${Math.random().toString(36).slice(2, 10)}`;
const hostEl = ref(null);
const svgEl = ref(null);
const hostSize = ref({ width: 0, height: 0 });
const hoverId = ref("");
const dragId = ref("");
let press = null;
let resizeObserver = null;

const layout = computed(() => layoutRelationGraph(props.graph, (id) => tableDisplayName(props.tables, id)));
const fit = computed(() => {
  const bounds = layout.value?.bounds || { x: -100, y: -100, width: 200, height: 200 };
  return { ...bounds, height: bounds.height * (1 + CONTROLS_RESERVE) };
});

const viewport = useGraphViewport({ fit, hostSize, svgEl });
const { viewBox, scale, panning } = viewport;
const forces = useGraphForces();

watch(layout, (next) => {
  if (!next) return;
  const homes = new Map([...next.positions].map(([id, position]) => [id, { x: position.x, y: position.y }]));
  forces.rebuild(props.graph.nodes, props.graph.links, homes);
}, { immediate: true });

let fitted = false;
watch(fit, () => {
  viewport.resetView({ animate: fitted });
  fitted = true;
}, { immediate: true });

const activeId = computed(() => dragId.value || hoverId.value);
const neighbors = computed(() => graphNeighbors(props.graph, activeId.value));
const radii = computed(() => new Map(props.graph.nodes.map((node) => [node.id, node.radius])));
const positions = computed(() => {
  const current = forces.positions.value;
  return current.size ? current : layout.value?.positions || new Map();
});

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

// Text that does not change while tables move, kept out of the per-frame work.
const nodeTexts = computed(() => new Map(props.graph.nodes.map((node) => [node.id, {
  hint: nodeHint(node),
  label: layout.value?.positions.get(node.id)?.label || "",
}])));
const linkHints = computed(() => new Map(props.graph.links.map((link) => [link.id, linkHint(link)])));

function outerLabelOpacity() {
  if (props.graph.nodes.length <= ALL_LABELS_NODE_LIMIT) return 1;
  const progress = (scale.value - OUTER_LABEL_FADE_START) / (OUTER_LABEL_FULL_SCALE - OUTER_LABEL_FADE_START);
  return Math.min(1, Math.max(0, progress));
}

const drawnNodes = computed(() => {
  const current = positions.value;
  const active = activeId.value;
  const outerOpacity = outerLabelOpacity();
  const fontSize = LABEL_SCREEN_SIZE / scale.value;
  const gap = LABEL_SCREEN_GAP / scale.value;
  return props.graph.nodes.flatMap((node) => {
    const position = current.get(node.id);
    if (!position) return [];
    const highlighted = Boolean(active) && neighbors.value.has(node.id);
    const labelOpacity = node.depth < 2 || highlighted ? 1 : outerOpacity;
    const texts = nodeTexts.value.get(node.id);
    return [{
      ...node,
      x: position.x,
      y: position.y,
      label: texts?.label || "",
      labelOpacity,
      labelY: node.radius + gap + fontSize * 0.8,
      fontSize,
      faded: Boolean(active) && !highlighted,
      hovered: active === node.id,
      dragged: dragId.value === node.id,
      hint: texts?.hint || "",
    }];
  });
});

const drawnLinks = computed(() => {
  const current = positions.value;
  const active = activeId.value;
  return props.graph.links.flatMap((link) => {
    const segment = linkSegment(link, current, radii.value);
    if (!segment) return [];
    const touches = Boolean(active) && (link.source === active || link.target === active);
    const accent = touches && ACCENT_STATUSES.has(link.status);
    return [{
      ...link,
      ...segment,
      faded: Boolean(active) && !touches,
      highlighted: touches,
      accent,
      marker: markerUrl(accent ? "active" : link.status),
      hint: linkHints.value.get(link.id) || "",
    }];
  });
});

function markerUrl(status) {
  return `url(#${markerPrefix}-${status})`;
}

// A small loop on top of the circle for a table that references itself.
function selfLoopPath(radius) {
  const spread = Math.max(3, radius * 0.45);
  return `M ${-spread} ${-radius + 1} C ${-spread * 2.2} ${-radius - 13}, ${spread * 2.2} ${-radius - 13}, ${spread} ${-radius + 1}`;
}

function openNode(id) {
  const node = props.graph.nodes.find((candidate) => candidate.id === id);
  if (!node?.depth) return;
  emit("open-table", {
    name: tableDisplayName(props.tables, node.id),
    comment: tableDisplayComment(props.tables, node.id),
  });
}

// ── pointer: drag a table, pan empty space, click to open ─────

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
    press = { pointerId: event.pointerId, id: nodeEl.dataset.id, clientX: event.clientX, clientY: event.clientY, moved: false };
    return;
  }
  viewport.startPan(event);
  capture(event);
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
    forces.pin(press.id, viewport.graphPoint(event));
    return;
  }
  viewport.movePan(event);
}

function finishPress(event, { cancelled = false } = {}) {
  const { id, moved } = press;
  press = null;
  releaseCapture(event);
  if (moved) {
    forces.release(id);
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
  if (viewport.endPan(event)) releaseCapture(event);
}

function onPointerCancel(event) {
  if (press && event.pointerId === press.pointerId) {
    finishPress(event, { cancelled: true });
    return;
  }
  if (viewport.endPan(event)) releaseCapture(event);
}

// ── height: drag the bottom edge or use the arrow keys ───────

const liveHeight = ref(null);
const shownHeight = computed(() => liveHeight.value ?? clampGraphHeight(props.height));
let resize = null;

// The drag height stays until the parent has stored it, so the edge never
// jumps back for a frame.
watch(() => props.height, () => {
  if (!resize) liveHeight.value = null;
});

function onResizeDown(event) {
  if (event.button !== 0) return;
  resize = { pointerId: event.pointerId, clientY: event.clientY, height: shownHeight.value };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function onResizeMove(event) {
  if (!resize || event.pointerId !== resize.pointerId) return;
  liveHeight.value = clampGraphHeight(resize.height + event.clientY - resize.clientY);
}

function onResizeEnd(event) {
  if (!resize || event.pointerId !== resize.pointerId) return;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  resize = null;
  if (liveHeight.value !== null && liveHeight.value !== clampGraphHeight(props.height)) emit("update:height", liveHeight.value);
  else liveHeight.value = null;
}

function onResizeKey(event) {
  const step = event.key === "ArrowDown" ? RESIZE_KEY_STEP : event.key === "ArrowUp" ? -RESIZE_KEY_STEP : 0;
  if (!step) return;
  event.preventDefault();
  emit("update:height", clampGraphHeight(shownHeight.value + step));
}

onMounted(() => {
  const host = hostEl.value;
  if (!host) return;
  const measure = () => {
    hostSize.value = { width: host.clientWidth, height: host.clientHeight };
  };
  measure();
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(host);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <div
    ref="hostEl"
    class="wb-relation-graph"
    :class="{
      'is-panning': panning,
      'is-dragging': Boolean(dragId),
      'is-hovering': Boolean(activeId),
      'is-fill': fill,
      'is-resizing': liveHeight !== null,
    }"
    :style="fill ? undefined : { height: `${shownHeight}px` }"
  >
    <svg
      ref="svgEl"
      class="wb-relation-graph-canvas"
      :viewBox="`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`"
      role="group"
      :aria-label="t('relations.graph.canvas', { name: tableDisplayName(tables, graph.center) })"
      @wheel="viewport.onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @dblclick.self="viewport.resetView()"
    >
      <defs>
        <marker
          v-for="status in MARKER_STATUSES"
          :id="`${markerPrefix}-${status}`"
          :key="status"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" class="wb-relation-graph-arrow" :class="`is-${status}`" />
        </marker>
      </defs>
      <g class="wb-relation-graph-links">
        <line
          v-for="link in drawnLinks"
          :key="link.id"
          class="wb-relation-graph-link"
          :class="[`is-${link.status}`, { 'is-faded': link.faded, 'is-highlighted': link.highlighted, 'is-accent': link.accent }]"
          :x1="link.x1"
          :y1="link.y1"
          :x2="link.x2"
          :y2="link.y2"
          :marker-end="link.forward ? link.marker : undefined"
          :marker-start="link.backward ? link.marker : undefined"
        ><title>{{ link.hint }}</title></line>
      </g>
      <g class="wb-relation-graph-nodes">
        <g
          v-for="node in drawnNodes"
          :key="node.id"
          class="wb-relation-graph-node"
          :class="{
            'is-center': node.depth === 0,
            'is-outer': node.depth === 2,
            'is-faded': node.faded,
            'is-hovered': node.hovered,
            'is-dragged': node.dragged,
            [`has-${node.issue}`]: Boolean(node.issue),
          }"
          :data-id="node.id"
          :transform="`translate(${node.x} ${node.y})`"
          :role="node.depth ? 'button' : 'img'"
          :tabindex="node.depth ? 0 : undefined"
          :aria-label="node.hint"
          @pointerenter="hoverId = node.id"
          @pointerleave="hoverId = ''"
          @focus="hoverId = node.id"
          @blur="hoverId = ''"
          @keydown.enter.prevent="openNode(node.id)"
          @keydown.space.prevent="openNode(node.id)"
        >
          <title>{{ node.hint }}</title>
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
            text-anchor="middle"
            :y="node.labelY"
            :font-size="node.fontSize"
            :opacity="node.labelOpacity < 1 ? node.labelOpacity : undefined"
          >{{ node.label }}</text>
        </g>
      </g>
    </svg>
    <div class="wb-relation-graph-zoom">
      <button type="button" :title="t('relations.graph.zoomIn')" :aria-label="t('relations.graph.zoomIn')" @click="viewport.zoomBy(ZOOM_STEP)">
        <ZoomIn :size="13" aria-hidden="true" />
      </button>
      <button type="button" :title="t('relations.graph.zoomOut')" :aria-label="t('relations.graph.zoomOut')" @click="viewport.zoomBy(1 / ZOOM_STEP)">
        <ZoomOut :size="13" aria-hidden="true" />
      </button>
      <button type="button" :title="t('relations.graph.fit')" :aria-label="t('relations.graph.fit')" @click="viewport.resetView()">
        <LocateFixed :size="13" aria-hidden="true" />
      </button>
      <template v-if="!fill">
        <span class="wb-relation-graph-zoom-divider" aria-hidden="true" />
        <button type="button" :title="t('relations.graph.expand')" :aria-label="t('relations.graph.expand')" @click="emit('expand')">
          <Maximize2 :size="13" aria-hidden="true" />
        </button>
      </template>
    </div>
    <div
      v-if="!fill"
      class="wb-relation-graph-resize"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('relations.graph.resize')"
      :aria-valuemin="GRAPH_HEIGHT.min"
      :aria-valuemax="GRAPH_HEIGHT.max"
      :aria-valuenow="shownHeight"
      :title="t('relations.graph.resize')"
      tabindex="0"
      @pointerdown="onResizeDown"
      @pointermove="onResizeMove"
      @pointerup="onResizeEnd"
      @pointercancel="onResizeEnd"
      @keydown="onResizeKey"
    />
  </div>
</template>

<style scoped>
.wb-relation-graph {
  position: relative;
  height: 260px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-field-surface);
  overflow: hidden;
}

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

.wb-relation-graph.is-fill {
  height: 100%;
}

.wb-relation-graph.is-panning .wb-relation-graph-canvas,
.wb-relation-graph.is-dragging .wb-relation-graph-canvas,
.wb-relation-graph.is-dragging .wb-relation-graph-node {
  cursor: grabbing;
}

.wb-relation-graph-link {
  stroke: color-mix(in srgb, var(--wb-text) 30%, transparent);
  stroke-width: 1.4;
  transition: opacity 180ms ease, stroke 180ms ease, stroke-width 180ms ease;
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
  fill: color-mix(in srgb, var(--wb-text) 45%, transparent);
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

.wb-relation-graph-node {
  cursor: pointer;
  outline: none;
  transition: opacity 180ms ease;
}

.wb-relation-graph-node.is-center {
  cursor: grab;
}

.wb-relation-graph-node.is-faded {
  opacity: 0.18;
}

.wb-relation-graph-dot {
  fill: color-mix(in srgb, var(--wb-text) 38%, var(--wb-surface));
  stroke: var(--wb-surface);
  stroke-width: 1.5;
  transition: fill 180ms ease;
}

.wb-relation-graph-node.is-outer .wb-relation-graph-dot {
  fill: color-mix(in srgb, var(--wb-text) 24%, var(--wb-surface));
}

.wb-relation-graph-node.is-center .wb-relation-graph-dot {
  fill: var(--wb-accent);
}

.wb-relation-graph-node.has-stale .wb-relation-graph-dot {
  stroke: var(--wb-warning-border);
  stroke-width: 2.5;
}

.wb-relation-graph-node.has-conflict .wb-relation-graph-dot {
  stroke: var(--wb-danger);
  stroke-width: 2.5;
}

.wb-relation-graph-node.is-hovered .wb-relation-graph-dot,
.wb-relation-graph-node:focus-visible .wb-relation-graph-dot {
  fill: var(--wb-accent-strong);
}

.wb-relation-graph-node.is-dragged .wb-relation-graph-dot {
  filter: drop-shadow(0 1px 3px color-mix(in srgb, var(--wb-text) 35%, transparent));
}

.wb-relation-graph-node:focus-visible .wb-relation-graph-dot {
  stroke: var(--wb-accent);
  stroke-width: 3;
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

.wb-relation-graph-label {
  fill: var(--wb-secondary-text);
  paint-order: stroke;
  stroke: var(--wb-surface);
  stroke-width: 3px;
  stroke-linejoin: round;
  pointer-events: none;
  animation: wb-relation-graph-label-in 160ms ease;
}

@keyframes wb-relation-graph-label-in {
  from {
    opacity: 0;
  }
}

.wb-relation-graph-node.is-center .wb-relation-graph-label,
.wb-relation-graph-node.is-hovered .wb-relation-graph-label {
  fill: var(--wb-text);
  font-weight: 650;
}

.wb-relation-graph-zoom {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface);
}

.wb-relation-graph-zoom button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--wb-secondary-text);
  cursor: pointer;
}

.wb-relation-graph-zoom button:hover {
  background: var(--wb-control-hover);
  color: var(--wb-text);
}

.wb-relation-graph-zoom button:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 1px;
}

.wb-relation-graph-zoom-divider {
  width: 1px;
  margin: 3px 1px;
  background: var(--wb-border);
}

/* Bottom edge: drag to change the graph height. */
.wb-relation-graph-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 6px;
  cursor: ns-resize;
  touch-action: none;
}

.wb-relation-graph-resize::after {
  content: "";
  position: absolute;
  bottom: 2px;
  left: 50%;
  width: 28px;
  height: 2px;
  border-radius: 1px;
  background: var(--wb-border);
  transform: translateX(-50%);
  opacity: 0;
  transition: opacity 150ms ease, background 150ms ease;
}

.wb-relation-graph:hover .wb-relation-graph-resize::after,
.wb-relation-graph-resize:focus-visible::after,
.wb-relation-graph.is-resizing .wb-relation-graph-resize::after {
  opacity: 1;
}

.wb-relation-graph-resize:hover::after,
.wb-relation-graph-resize:focus-visible::after,
.wb-relation-graph.is-resizing .wb-relation-graph-resize::after {
  background: var(--wb-accent);
}

.wb-relation-graph-resize:focus-visible {
  outline: none;
}

@media (prefers-reduced-motion: reduce) {
  .wb-relation-graph-link,
  .wb-relation-graph-node,
  .wb-relation-graph-dot,
  .wb-relation-graph-resize::after {
    transition: none;
  }

  .wb-relation-graph-label {
    animation: none;
  }
}
</style>
