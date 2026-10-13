<script setup>
// Draws one local relation graph: tables as circles sized by how many tables
// reference them and tinted by which side of the current table they are on,
// the relations between two tables as one line coloured by its worst status.
// Hovering, focusing or dragging a table keeps only it and its direct
// neighbours bright. Tables can be dragged (neighbours follow on springs and
// everything swings back on release), the wheel zooms around the pointer,
// dragging empty space pans and the bottom edge resizes the graph.
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDownLeft, ArrowUpRight, CircleHelp, Lock, LocateFixed, Maximize2, Repeat2, ZoomIn, ZoomOut } from "lucide-vue-next";
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
  graphNodeRelations,
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
const LABEL_SCREEN_SIZE = 11;
const LABEL_SCREEN_GAP = 4;
// "Fit" stops enlarging a small graph here (screen pixels per graph unit).
const MAX_FIT_SCALE = 1.6;
// The dot grid behind the graph keeps one on-screen density at every zoom.
const GRID_SCREEN_STEP = 18;
const GRID_SCREEN_DOT = 0.9;
// Halo drawn around the current table, in screen pixels.
const CENTER_HALO = 5;
// Past this many tables, outer-ring labels would pile up; they fade in as the
// user zooms toward OUTER_LABEL_FULL_SCALE and show at once on hover/focus.
const ALL_LABELS_NODE_LIMIT = 24;
const OUTER_LABEL_FADE_START = 0.8;
const OUTER_LABEL_FULL_SCALE = 1.1;
const DRAG_THRESHOLD_PX = 4;
const UNLOCKED_ROWS_PER_SECTION = 5;
const RESIZE_KEY_STEP = 20;
// Share of the fitted width kept free right of the drawing for the tool strip.
const CONTROLS_RESERVE = 0.16;

const markerPrefix = `wb-relation-graph-${Math.random().toString(36).slice(2, 10)}`;
const helpId = `${markerPrefix}-help`;
const HELP_LINES = Object.freeze(["navigate", "drag", "open", "lock", "reset", "size"]);
const CARD_SECTION_ICONS = Object.freeze({ references: ArrowUpRight, referencedBy: ArrowDownLeft, self: Repeat2 });
const hostEl = ref(null);
const svgEl = ref(null);
const hostSize = ref({ width: 0, height: 0 });
const hoverId = ref("");
const dragId = ref("");
// Right-clicked table whose highlight and card stay put while the pointer roams.
const lockedId = ref("");
let press = null;
let emptyPress = null;
let resizeObserver = null;

const layout = computed(() => layoutRelationGraph(props.graph, (id) => tableDisplayName(props.tables, id)));
const fit = computed(() => {
  const bounds = layout.value?.bounds || { x: -100, y: -100, width: 200, height: 200 };
  return { ...bounds, width: bounds.width * (1 + CONTROLS_RESERVE) };
});

const viewport = useGraphViewport({ fit, hostSize, svgEl, maxFitScale: MAX_FIT_SCALE });
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

const activeId = computed(() => dragId.value || lockedId.value || hoverId.value);
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

// ── corner card: the active table's drawn relations, field by field ──

function relationRow(relation, locked) {
  const end = (table, column) => ({
    table,
    column,
    name: tableDisplayName(props.tables, table),
    // The center table is already open; every other drawn table can be opened.
    clickable: locked && table !== props.graph.center,
  });
  return {
    id: relation.id,
    status: relation.status,
    ends: [end(relation.sourceTable, relation.sourceColumn), end(relation.targetTable, relation.targetColumn)],
  };
}

const card = computed(() => {
  const id = activeId.value;
  const node = id ? props.graph.nodes.find((candidate) => candidate.id === id) : null;
  if (!node) return null;
  const locked = lockedId.value === id;
  const relations = graphNodeRelations(props.graph, id);
  const sections = [
    { key: "references", relations: relations.references },
    { key: "referencedBy", relations: relations.referencedBy },
    { key: "self", relations: relations.self },
  ]
    .filter((section) => section.relations.length)
    .map((section) => {
      // Unlocked, the card cannot scroll, so long lists stop early.
      const shown = locked ? section.relations : section.relations.slice(0, UNLOCKED_ROWS_PER_SECTION);
      return {
        key: section.key,
        count: section.relations.length,
        rows: shown.map((relation) => relationRow(relation, locked)),
        more: section.relations.length - shown.length,
      };
    });
  return {
    id,
    locked,
    name: tableDisplayName(props.tables, id),
    comment: tableDisplayComment(props.tables, id),
    center: node.depth === 0,
    total: node.referencedBy,
    sections,
  };
});

function cardHint(current) {
  if (current.locked) return t("relations.graph.card.unlockHint");
  return current.center ? t("relations.graph.card.lockHint") : t("relations.graph.card.openLockHint");
}

// ── right-click lock ─────────────────────────────────────────

function toggleLock(id) {
  lockedId.value = lockedId.value === id ? "" : id;
}

// A lock on a table that is no longer drawn has nothing to show.
watch(() => props.graph, (graph) => {
  if (lockedId.value && !graph.nodes.some((node) => node.id === lockedId.value)) lockedId.value = "";
});

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

// Double-clicking empty space brings the whole graph back into view.
function onDoubleClick(event) {
  if (event.target?.closest?.(".wb-relation-graph-node")) return;
  viewport.resetView();
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
  // A press on empty space that does not turn into a pan releases the lock.
  emptyPress = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
  viewport.startPan(event);
  capture(event);
}

function endEmptyPress(event) {
  if (!emptyPress || event.pointerId !== emptyPress.pointerId) return;
  const moved = Math.hypot(event.clientX - emptyPress.clientX, event.clientY - emptyPress.clientY) >= DRAG_THRESHOLD_PX;
  emptyPress = null;
  if (!moved) lockedId.value = "";
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
          markerWidth="6"
          markerHeight="6"
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
            [`is-side-${node.side}`]: node.depth > 0,
            'is-faded': node.faded,
            'is-hovered': node.hovered,
            'is-dragged': node.dragged,
            'is-locked': lockedId === node.id,
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
          @contextmenu.prevent.stop="toggleLock(node.id)"
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
            text-anchor="middle"
            :y="node.labelY"
            :font-size="node.fontSize"
            :opacity="node.labelOpacity < 1 ? node.labelOpacity : undefined"
          >{{ node.label }}</text>
        </g>
      </g>
    </svg>
    <!-- Unlocked, the node's aria-label already speaks for the card; locked,
         the card holds buttons and becomes a region of its own. -->
    <Transition name="wb-relation-graph-card">
      <div
        v-if="card"
        class="wb-relation-graph-card"
        :class="{ 'is-locked': card.locked }"
        :role="card.locked ? 'region' : undefined"
        :aria-label="card.locked ? card.name : undefined"
        :aria-hidden="card.locked ? undefined : 'true'"
      >
        <div class="wb-relation-graph-card-head">
          <strong>{{ card.name }}</strong>
          <span v-if="card.center" class="wb-relation-graph-card-badge">{{ t('relations.graph.card.center') }}</span>
          <span v-if="card.locked" class="wb-relation-graph-card-badge is-lock">
            <Lock :size="10" aria-hidden="true" />{{ t('relations.graph.card.locked') }}
          </span>
        </div>
        <p v-if="card.comment" class="wb-relation-graph-card-comment">{{ card.comment }}</p>
        <section v-for="section in card.sections" :key="section.key" class="wb-relation-graph-card-section" :class="`is-${section.key}`">
          <h4>
            <component :is="CARD_SECTION_ICONS[section.key]" :size="11" :stroke-width="2.2" aria-hidden="true" />
            {{ t(`relations.graph.card.${section.key}`, { count: section.count }) }}
          </h4>
          <ul>
            <li v-for="row in section.rows" :key="row.id" class="wb-relation-graph-card-row">
              <span class="wb-relation-graph-card-key">
                <!-- The arrow rides with the target so a narrow card breaks before it. -->
                <template v-for="(end, index) in row.ends" :key="index">
                  <span class="wb-relation-graph-card-end">
                    <span v-if="index" class="wb-relation-graph-card-arrow" aria-hidden="true">→ </span>
                    <button
                      v-if="end.clickable"
                      type="button"
                      class="wb-relation-graph-card-table"
                      :title="t('relations.graph.card.openTable', { name: end.name })"
                      @click="openNode(end.table)"
                    >{{ end.name }}</button>
                    <span v-else class="wb-relation-graph-card-table is-plain">{{ end.name }}</span>.<span class="wb-relation-graph-card-column">{{ end.column }}</span>
                  </span>
                </template>
              </span>
              <span
                v-if="row.status !== 'confirmed'"
                class="wb-relation-graph-card-status"
                :class="`is-${row.status}`"
              >{{ relationStatusLabel(row.status, t) }}</span>
            </li>
          </ul>
          <p v-if="section.more" class="wb-relation-graph-card-line is-quiet">
            {{ t('relations.graph.card.more', { count: section.more }) }}
          </p>
        </section>
        <footer class="wb-relation-graph-card-foot">
          <span>{{ t('relations.graph.card.total', { count: card.total }) }}</span>
          <span class="wb-relation-graph-card-hint">{{ cardHint(card) }}</span>
        </footer>
      </div>
    </Transition>
    <div class="wb-relation-graph-zoom">
      <button type="button" :title="t('relations.graph.zoomIn')" :aria-label="t('relations.graph.zoomIn')" @click="viewport.zoomBy(ZOOM_STEP)">
        <ZoomIn :size="14" aria-hidden="true" />
      </button>
      <button type="button" :title="t('relations.graph.zoomOut')" :aria-label="t('relations.graph.zoomOut')" @click="viewport.zoomBy(1 / ZOOM_STEP)">
        <ZoomOut :size="14" aria-hidden="true" />
      </button>
      <button type="button" :title="t('relations.graph.fit')" :aria-label="t('relations.graph.fit')" @click="viewport.resetView()">
        <LocateFixed :size="14" aria-hidden="true" />
      </button>
      <span class="wb-relation-graph-zoom-divider" aria-hidden="true" />
      <span class="wb-relation-graph-help">
        <button type="button" :aria-label="t('relations.graph.help')" :aria-describedby="helpId">
          <CircleHelp :size="14" aria-hidden="true" />
        </button>
        <span :id="helpId" role="tooltip" class="wb-relation-graph-help-tip">
          <strong>{{ t('relations.graph.help') }}</strong>
          <span v-for="key in HELP_LINES" :key="key">{{ t(`relations.graph.help.${key}`) }}</span>
        </span>
      </span>
      <button v-if="!fill" type="button" :title="t('relations.graph.expand')" :aria-label="t('relations.graph.expand')" @click="emit('expand')">
        <Maximize2 :size="14" aria-hidden="true" />
      </button>
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
  border-radius: 8px;
  background: var(--wb-field-surface);
  box-shadow: inset 0 0 0 1px var(--wb-line);
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

.wb-relation-graph-grid-dot {
  fill: color-mix(in srgb, var(--wb-text) 13%, transparent);
}

.wb-relation-graph-link {
  stroke: color-mix(in srgb, var(--wb-text) 26%, transparent);
  stroke-width: 1.3;
  transition: opacity var(--wb-duration-base) ease, stroke var(--wb-duration-base) ease, stroke-width var(--wb-duration-base) ease;
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
  fill: color-mix(in srgb, var(--wb-text) 42%, transparent);
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
  transition: opacity var(--wb-duration-base) ease;
}

.wb-relation-graph-node.is-center {
  cursor: grab;
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
  filter: drop-shadow(0 2px 4px color-mix(in srgb, var(--wb-text) 30%, transparent));
}

.wb-relation-graph-node:focus-visible .wb-relation-graph-dot {
  stroke: var(--wb-accent);
  stroke-width: 3;
}

.wb-relation-graph-node.is-locked .wb-relation-graph-dot {
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
  font-weight: 600;
}

/* Floating tool strip, stacked on the right edge so the hover card can use
   the width. */
.wb-relation-graph-zoom {
  position: absolute;
  right: 8px;
  bottom: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 2px;
  border-radius: 8px;
  background: var(--wb-menu-surface);
  box-shadow: 0 0 0 1px var(--wb-border), 0 2px 6px rgba(0, 0, 0, 0.08);
}

.wb-relation-graph-zoom button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  min-height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--wb-secondary-text);
}

.wb-relation-graph-zoom button:hover:not(:disabled) {
  background: var(--wb-control-hover);
  color: var(--wb-text);
}

.wb-relation-graph-zoom button:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 0;
}

.wb-relation-graph-zoom-divider {
  width: 14px;
  height: 1px;
  margin: 2px 0;
  background: var(--wb-border);
}

.wb-relation-graph-help {
  position: relative;
  display: inline-flex;
}

/* How to use the graph, on hover or keyboard focus of the help button. */
.wb-relation-graph-help-tip {
  position: absolute;
  right: calc(100% + 8px);
  bottom: -2px;
  z-index: 2;
  display: grid;
  gap: 3px;
  width: max-content;
  max-width: 240px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--wb-menu-surface);
  box-shadow: 0 0 0 1px var(--wb-border), var(--wb-floating-shadow);
  color: var(--wb-secondary-text);
  font-size: 11px;
  line-height: 1.5;
  opacity: 0;
  pointer-events: none;
  translate: 3px 0;
  transition: opacity var(--wb-duration-fast) ease, translate var(--wb-duration-fast) ease;
}

.wb-relation-graph-help-tip strong {
  color: var(--wb-text);
  font-size: 11px;
  font-weight: 600;
}

.wb-relation-graph-help:hover .wb-relation-graph-help-tip,
.wb-relation-graph-help:focus-within .wb-relation-graph-help-tip {
  opacity: 1;
  translate: 0 0;
}

/* Hover card: bottom-left, clear of the tool strip on the right. */
.wb-relation-graph-card {
  position: absolute;
  bottom: 8px;
  left: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* Kept to part of the canvas so tables beside a pinned card stay reachable. */
  max-width: min(340px, 64%, calc(100% - 56px));
  max-height: calc(100% - 16px);
  padding: 8px 10px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--wb-menu-surface);
  box-shadow: 0 0 0 1px var(--wb-border), var(--wb-floating-shadow);
  color: var(--wb-text);
  font-size: 11px;
  line-height: 1.45;
  pointer-events: none;
}

.wb-relation-graph-card p {
  margin: 0;
}

.wb-relation-graph-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
}

.wb-relation-graph-card-head strong {
  font-size: 12px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.wb-relation-graph-card-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
}

.wb-relation-graph-card-comment {
  display: -webkit-box;
  color: var(--wb-secondary-text);
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

/* Locked: the card takes the pointer so it can scroll and its table names
   can be clicked. */
.wb-relation-graph-card.is-locked {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--wb-accent) 55%, var(--wb-border)), var(--wb-floating-shadow);
  overflow: auto;
  overscroll-behavior: contain;
  pointer-events: auto;
}

.wb-relation-graph-card-section {
  display: grid;
  gap: 2px;
  padding-top: 2px;
}

.wb-relation-graph-card-section h4 {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 2px 0 0;
  color: var(--wb-secondary-text);
  font-size: 10px;
  font-weight: 600;
}

.wb-relation-graph-card-section.is-references h4 svg {
  color: var(--wb-relation-out);
}

.wb-relation-graph-card-section.is-referencedBy h4 svg {
  color: var(--wb-relation-in);
}

.wb-relation-graph-card-section ul {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0 0 0 15px;
  list-style: none;
}

.wb-relation-graph-card-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 6px;
}

.wb-relation-graph-card-key {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 4px;
  min-width: 0;
  font-size: 11px;
  overflow-wrap: anywhere;
}

.wb-relation-graph-card-end {
  min-width: 0;
}

.wb-relation-graph-card-arrow {
  color: var(--wb-quiet-text);
}

.wb-relation-graph-card-table {
  font: inherit;
  font-weight: 600;
  color: var(--wb-text);
}

button.wb-relation-graph-card-table {
  min-height: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--wb-accent-strong);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--wb-accent) 40%, transparent);
  text-underline-offset: 2px;
}

button.wb-relation-graph-card-table:hover:not(:disabled) {
  background: none;
  text-decoration-color: currentColor;
}

button.wb-relation-graph-card-table:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 1px;
  border-radius: 2px;
}

.wb-relation-graph-card-column {
  color: var(--wb-secondary-text);
}

.wb-relation-graph-card-status {
  font-size: 10px;
  font-weight: 600;
  color: var(--wb-secondary-text);
}

.wb-relation-graph-card-status.is-stale {
  color: var(--wb-warning-text);
}

.wb-relation-graph-card-status.is-conflict {
  color: var(--wb-danger);
}

.wb-relation-graph-card-line.is-quiet {
  padding-left: 15px;
  color: var(--wb-quiet-text);
}

.wb-relation-graph-card-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  margin-top: 2px;
  padding-top: 5px;
  border-top: 1px solid var(--wb-line);
  color: var(--wb-quiet-text);
  font-size: 10px;
}

.wb-relation-graph-card-hint {
  margin-left: auto;
}

.wb-relation-graph-card-enter-active,
.wb-relation-graph-card-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.wb-relation-graph-card-enter-from,
.wb-relation-graph-card-leave-to {
  opacity: 0;
  transform: translateY(3px);
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
  background: var(--wb-border-strong);
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
  .wb-relation-graph-resize::after,
  .wb-relation-graph-help-tip {
    transition: none;
  }

  .wb-relation-graph-label {
    animation: none;
  }

  .wb-relation-graph-card-enter-active,
  .wb-relation-graph-card-leave-active {
    transition: none;
  }
}
</style>
