<script setup>
// The chrome around a relation graph drawing, shared by the ring view (SVG)
// and the large-graph view (canvas): the framed area the drawing fills, the
// tool strip (zoom, fit, restore layout, find, help, full screen), the
// bottom edge that resizes the inline graph, the info card (floating in the
// half away from its table, or docked under a narrow graph once pinned), a
// quiet note while a large layout is still settling, and a short notice
// after a change such as a new depth. Every right-click inside is consumed
// here and handed to the drawing, so no menu of the app, the WebView or the
// system opens over the graph.
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CircleHelp, LoaderCircle, LocateFixed, Maximize2, RotateCcw, Search, ZoomIn, ZoomOut } from "lucide-vue-next";
import { GRAPH_HEIGHT, clampGraphHeight } from "../utils/relationGraph.js";
import { cardPlacement } from "../utils/relationGraphGeometry.js";
import ConfigRelationGraphCard from "./ConfigRelationGraphCard.vue";
import ConfigRelationGraphFind from "./ConfigRelationGraphFind.vue";

const props = defineProps({
  // Full-screen view: fills its parent, without the resize edge or the full-screen button.
  fill: { type: Boolean, default: false },
  height: { type: Number, default: GRAPH_HEIGHT.default },
  // Info card model (see relationGraphCard.js) or null.
  card: { type: Object, default: null },
  // Host-pixel center and on-screen radius of the card's table.
  cardAnchor: { type: Object, default: null },
  // Some tables were dragged: offer "restore layout".
  arranged: { type: Boolean, default: false },
  // State classes for the drawing area (panning, dragging, hovering…).
  hostClass: { type: [Object, Array, String], default: null },
  // Shown at the bottom left while a large layout settles.
  status: { type: String, default: "" },
  // A short line at the top after a change ({ id, text }); it fades on its own.
  notice: { type: Object, default: null },
  // Tables the find box can jump to: [{ id, name, comment }].
  findItems: { type: Array, default: () => [] },
});

// `act` carries the tool strip, find box and card actions to the drawing:
// zoomIn, zoomOut, fit, resetLayout, expand, find (id), open (id), focus (id), unpin.
const emit = defineEmits(["act", "update:height", "resize", "contextmenu"]);

const RESIZE_KEY_STEP = 20;
// The floating card keeps this much room from the table it describes (pixels).
const CARD_CLEARANCE = 14;
const CARD_MIN_HEIGHT = 96;
// Narrower graphs dock a pinned card under the canvas instead of over it.
const DOCK_BELOW_WIDTH = 560;
const NOTICE_MS = 2600;

const helpId = `wb-relation-graph-help-${Math.random().toString(36).slice(2, 10)}`;
const helpLines = computed(() => ["navigate", "drag", "open", "pin", ...(props.findItems.length > 1 ? ["find"] : []), "reset", "size"]);
const hostEl = ref(null);
const hostSize = ref({ width: 0, height: 0 });
const finding = ref(false);
let resizeObserver = null;

// ── info card ─────────────────────────────────────────────────

const docked = computed(() => Boolean(props.card?.pinned) && !props.fill && hostSize.value.width < DOCK_BELOW_WIDTH);

// Floating, the card takes the half (in wide views the corner) away from its
// table and may grow until it would reach it.
const cardFrame = computed(() => {
  if (!props.card || docked.value) return null;
  const { height } = hostSize.value;
  const anchor = props.cardAnchor;
  const placement = cardPlacement(anchor, hostSize.value);
  const reach = (anchor?.radius || 0) + CARD_CLEARANCE;
  const room = !anchor
    ? height / 2
    : placement.span
      ? (placement.vertical === "top" ? anchor.y - reach : height - anchor.y - reach) - 8
      : height - 16;
  return {
    class: [`is-${placement.vertical}`, `is-${placement.horizontal}`, { "is-span": placement.span }],
    style: { maxHeight: `${Math.round(Math.max(CARD_MIN_HEIGHT, Math.min(height - 16, room)))}px` },
  };
});

// ── notice: shown for a moment after each change ───────────────

const shownNotice = ref("");
let noticeTimer = 0;
watch(() => props.notice?.id, () => {
  clearTimeout(noticeTimer);
  shownNotice.value = props.notice?.text || "";
  if (shownNotice.value) noticeTimer = setTimeout(() => { shownNotice.value = ""; }, NOTICE_MS);
});

// ── find ──────────────────────────────────────────────────────

function onFind(id) {
  finding.value = false;
  emit("act", "find", id);
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
    emit("resize", hostSize.value);
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
  clearTimeout(noticeTimer);
});

</script>

<template>
  <!-- Every right-click in the graph, the docked card included, is handled here. -->
  <div class="wb-relation-graph-frame" :class="{ 'is-fill': fill }" @contextmenu.prevent.stop="emit('contextmenu', $event)">
    <div
      ref="hostEl"
      class="wb-relation-graph"
      :class="[hostClass, { 'is-fill': fill, 'is-resizing': liveHeight !== null }]"
      :style="fill ? undefined : { height: `${shownHeight}px` }"
    >
      <slot />
      <Transition name="wb-relation-graph-notice">
        <p v-if="shownNotice" class="wb-relation-graph-notice" role="status">{{ shownNotice }}</p>
      </Transition>
      <p v-if="status" class="wb-relation-graph-settling" role="status">
        <LoaderCircle :size="12" class="wb-relation-graph-settling-spin" aria-hidden="true" />{{ status }}
      </p>
      <ConfigRelationGraphFind
        v-if="finding"
        :items="findItems"
        @pick="onFind"
        @close="finding = false"
      />
      <Transition name="wb-relation-graph-card">
        <ConfigRelationGraphCard
          v-if="card && cardFrame"
          class="wb-relation-graph-card-float"
          :class="cardFrame.class"
          :style="cardFrame.style"
          :card="card"
          @open="emit('act', 'open', $event)"
          @focus="emit('act', 'focus', $event)"
          @unpin="emit('act', 'unpin')"
        />
      </Transition>
      <div class="wb-relation-graph-zoom">
        <button type="button" :title="t('relations.graph.zoomIn')" :aria-label="t('relations.graph.zoomIn')" @click="emit('act', 'zoomIn')">
          <ZoomIn :size="14" aria-hidden="true" />
        </button>
        <button type="button" :title="t('relations.graph.zoomOut')" :aria-label="t('relations.graph.zoomOut')" @click="emit('act', 'zoomOut')">
          <ZoomOut :size="14" aria-hidden="true" />
        </button>
        <button type="button" :title="t('relations.graph.fit')" :aria-label="t('relations.graph.fit')" @click="emit('act', 'fit')">
          <LocateFixed :size="14" aria-hidden="true" />
        </button>
        <button
          v-if="arranged"
          type="button"
          class="wb-relation-graph-reset"
          :title="t('relations.graph.resetLayout')"
          :aria-label="t('relations.graph.resetLayout')"
          @click="emit('act', 'resetLayout')"
        >
          <RotateCcw :size="14" aria-hidden="true" />
        </button>
        <span class="wb-relation-graph-zoom-divider" aria-hidden="true" />
        <button
          v-if="findItems.length > 1"
          type="button"
          class="wb-relation-graph-find-toggle"
          :class="{ 'is-active': finding }"
          :title="t('relations.graph.find.open')"
          :aria-label="t('relations.graph.find.open')"
          :aria-expanded="finding"
          @click="finding = !finding"
        >
          <Search :size="14" aria-hidden="true" />
        </button>
        <span class="wb-relation-graph-help">
          <button type="button" :aria-label="t('relations.graph.help')" :aria-describedby="helpId">
            <CircleHelp :size="14" aria-hidden="true" />
          </button>
          <span :id="helpId" role="tooltip" class="wb-relation-graph-help-tip">
            <strong>{{ t('relations.graph.help') }}</strong>
            <span v-for="key in helpLines" :key="key">{{ t(`relations.graph.help.${key}`) }}</span>
          </span>
        </span>
        <button v-if="!fill" type="button" :title="t('relations.graph.expand')" :aria-label="t('relations.graph.expand')" @click="emit('act', 'expand')">
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
    <Transition name="wb-relation-graph-dock">
      <ConfigRelationGraphCard
        v-if="card && docked"
        class="wb-relation-graph-card-dock"
        :card="card"
        docked
        @open="emit('act', 'open', $event)"
        @focus="emit('act', 'focus', $event)"
        @unpin="emit('act', 'unpin')"
      />
    </Transition>
  </div>
</template>

<style scoped>
.wb-relation-graph-frame {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.wb-relation-graph-frame.is-fill {
  height: 100%;
}

.wb-relation-graph {
  position: relative;
  height: 260px;
  border-radius: 8px;
  background: var(--wb-field-surface);
  box-shadow: inset 0 0 0 1px var(--wb-line);
  overflow: hidden;
}

.wb-relation-graph.is-fill {
  height: 100%;
}

/* Floating tool strip, stacked on the right edge so the info card can use
   the width. */
.wb-relation-graph-zoom {
  position: absolute;
  right: 8px;
  bottom: 10px;
  z-index: 3;
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

.wb-relation-graph-zoom button:hover:not(:disabled),
.wb-relation-graph-zoom button.is-active {
  background: var(--wb-control-hover);
  color: var(--wb-text);
}

.wb-relation-graph-zoom button:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 0;
}

.wb-relation-graph-zoom .wb-relation-graph-reset {
  color: var(--wb-accent-strong);
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
  z-index: 3;
  display: grid;
  gap: 3px;
  width: max-content;
  max-width: 260px;
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

/* A short line after a change (a new depth, a table found…). */
.wb-relation-graph-notice {
  position: absolute;
  top: 8px;
  left: 50%;
  z-index: 3;
  max-width: calc(100% - 96px);
  margin: 0;
  padding: 3px 10px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--wb-menu-surface);
  box-shadow: 0 0 0 1px var(--wb-border), 0 2px 8px rgba(0, 0, 0, 0.08);
  color: var(--wb-secondary-text);
  font-size: 11px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateX(-50%);
  pointer-events: none;
}

.wb-relation-graph-notice-enter-active,
.wb-relation-graph-notice-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.wb-relation-graph-notice-enter-from,
.wb-relation-graph-notice-leave-to {
  opacity: 0;
  transform: translate(-50%, -4px);
}

/* While a large layout is still settling. */
.wb-relation-graph-settling {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 2px 8px 2px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-menu-surface) 88%, transparent);
  box-shadow: 0 0 0 1px var(--wb-line);
  color: var(--wb-quiet-text);
  font-size: 10.5px;
  line-height: 18px;
  pointer-events: none;
}

.wb-relation-graph-settling-spin {
  animation: wb-relation-graph-spin 900ms linear infinite;
}

@keyframes wb-relation-graph-spin {
  to {
    transform: rotate(1turn);
  }
}

/* Floating card: in the half (or corner) away from the table it describes. */
.wb-relation-graph-card-float {
  position: absolute;
  z-index: 2;
  width: max-content;
  min-width: 200px;
  max-width: min(360px, calc(100% - 64px));
}

.wb-relation-graph-card-float.is-top {
  top: 8px;
}

.wb-relation-graph-card-float.is-bottom {
  bottom: 8px;
}

.wb-relation-graph-card-float.is-left {
  left: 8px;
}

.wb-relation-graph-card-float.is-right {
  right: 48px;
}

/* A narrow graph gives the card its whole width, clear of the tool strip. */
.wb-relation-graph-card-float.is-span {
  right: 44px;
  left: 8px;
  width: auto;
  min-width: 0;
  max-width: none;
}

.wb-relation-graph.is-fill .wb-relation-graph-card-float {
  max-width: min(400px, calc(100% - 64px));
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

.wb-relation-graph-dock-enter-active,
.wb-relation-graph-dock-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.wb-relation-graph-dock-enter-from,
.wb-relation-graph-dock-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* Bottom edge: drag to change the graph height. */
.wb-relation-graph-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 2;
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
  .wb-relation-graph-resize::after,
  .wb-relation-graph-help-tip {
    transition: none;
  }

  .wb-relation-graph-settling-spin {
    animation: none;
  }

  .wb-relation-graph-notice-enter-active,
  .wb-relation-graph-notice-leave-active,
  .wb-relation-graph-card-enter-active,
  .wb-relation-graph-card-leave-active,
  .wb-relation-graph-dock-enter-active,
  .wb-relation-graph-dock-leave-active {
    transition: none;
  }
}
</style>
