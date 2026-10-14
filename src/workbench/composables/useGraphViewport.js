// Zoom and pan for an SVG graph whose drawing fits `fit` (graph units). The
// viewBox is derived from a zoom factor and a center point; the wheel zooms
// around the pointer, buttons and "fit" glide there, and dragging empty
// space pans. "Fit" never blows a small drawing up past `maxFitScale` screen
// pixels per unit, and a fitted view stays fitted while the host resizes.
import { computed, onBeforeUnmount, ref, watch } from "vue";

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 5;
const WHEEL_ZOOM_RATE = 0.0015;
const LINE_HEIGHT_PX = 16;
const GLIDE_MS = 220;

export function prefersReducedMotion() {
  try {
    return Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}

function easeOutCubic(progress) {
  return 1 - (1 - progress) ** 3;
}

/**
 * Runs `onFrame(eased)` on animation frames for `duration` ms, eased out, and
 * returns a function that stops it. Without animation frames (or with
 * reduced motion) it jumps to the end at once.
 */
export function glideFrames(duration, onFrame) {
  if (prefersReducedMotion() || typeof globalThis.requestAnimationFrame !== "function") {
    onFrame(1);
    return () => {};
  }
  const started = globalThis.performance?.now?.() ?? Date.now();
  let frame = 0;
  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    onFrame(easeOutCubic(progress));
    frame = progress < 1 ? globalThis.requestAnimationFrame(step) : 0;
  };
  frame = globalThis.requestAnimationFrame(step);
  return () => {
    if (frame) globalThis.cancelAnimationFrame?.(frame);
    frame = 0;
  };
}

export function clampZoom(value, min = MIN_ZOOM) {
  return Math.min(MAX_ZOOM, Math.max(min, value));
}

// The zoom that shows the whole drawing: 1 unless that would scale it past
// `maxFitScale` (a two-table graph in a large window), then smaller.
export function fitZoomFor(baseScale, maxFitScale = Infinity) {
  const scale = Number(baseScale) || 0;
  return scale > maxFitScale ? maxFitScale / scale : 1;
}

// The center that keeps `point` fixed on screen while zooming from `from` to `to`.
export function centerAfterZoom(center, point, from, to) {
  const ratio = from / to;
  return {
    x: point.x + (center.x - point.x) * ratio,
    y: point.y + (center.y - point.y) * ratio,
  };
}

export function wheelZoomFactor(event) {
  const unit = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? 400 : 1;
  return Math.exp(-(Number(event.deltaY) || 0) * unit * WHEEL_ZOOM_RATE);
}

export function useGraphViewport({ fit, hostSize, svgEl, maxFitScale = Infinity }) {
  const zoom = ref(1);
  const center = ref({ x: 0, y: 0 });
  const panning = ref(false);
  let pan = null;
  let stopGlide = () => {};
  // True while the view shows the fitted drawing; the user's zoom or pan ends it.
  let fitted = true;

  const viewBox = computed(() => {
    const width = fit.value.width / zoom.value;
    const height = fit.value.height / zoom.value;
    return { x: center.value.x - width / 2, y: center.value.y - height / 2, width, height };
  });

  // Screen pixels per graph unit, as the SVG fits its viewBox into the host.
  const scale = computed(() => {
    const { width, height } = hostSize.value;
    if (!width || !height) return 1;
    return Math.min(width / viewBox.value.width, height / viewBox.value.height);
  });

  // Screen pixels per graph unit at zoom 1.
  const baseScale = computed(() => {
    const { width, height } = hostSize.value;
    if (!width || !height) return 0;
    return Math.min(width / fit.value.width, height / fit.value.height);
  });
  const fitZoom = computed(() => fitZoomFor(baseScale.value, maxFitScale));
  const minZoom = computed(() => Math.min(MIN_ZOOM, fitZoom.value * MIN_ZOOM));

  function moveTo(nextZoom, nextCenter, { animate = true } = {}) {
    stopGlide();
    const targetZoom = clampZoom(nextZoom, minZoom.value);
    if (!animate) {
      zoom.value = targetZoom;
      center.value = { ...nextCenter };
      return;
    }
    const fromZoom = zoom.value;
    const fromCenter = { ...center.value };
    stopGlide = glideFrames(GLIDE_MS, (eased) => {
      // Interpolating zoom in log space keeps the glide even in both directions.
      zoom.value = fromZoom * (targetZoom / fromZoom) ** eased;
      center.value = {
        x: fromCenter.x + (nextCenter.x - fromCenter.x) * eased,
        y: fromCenter.y + (nextCenter.y - fromCenter.y) * eased,
      };
    });
  }

  function fitCenter() {
    const box = fit.value;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  function resetView(options) {
    fitted = true;
    moveTo(fitZoom.value, fitCenter(), options);
  }

  function zoomBy(factor, point = center.value, options) {
    fitted = false;
    const target = clampZoom(zoom.value * factor, minZoom.value);
    moveTo(target, centerAfterZoom(center.value, point, zoom.value, target), options);
  }

  // The host size arrives after mount and changes with the resize edge or the
  // window; a fitted view keeps showing the whole drawing. (A new drawing is
  // refitted by the caller, with a glide.)
  watch(hostSize, () => {
    if (fitted) moveTo(fitZoom.value, fitCenter(), { animate: false });
  });

  function graphPoint(event) {
    const matrix = svgEl.value?.getScreenCTM?.();
    if (!matrix) return center.value;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }

  function onWheel(event) {
    event.preventDefault();
    zoomBy(wheelZoomFactor(event), graphPoint(event), { animate: false });
  }

  function startPan(event) {
    stopGlide();
    pan = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, center: { ...center.value } };
    panning.value = true;
  }

  function movePan(event) {
    if (!pan || event.pointerId !== pan.pointerId) return false;
    fitted = false;
    center.value = {
      x: pan.center.x - (event.clientX - pan.clientX) / scale.value,
      y: pan.center.y - (event.clientY - pan.clientY) / scale.value,
    };
    return true;
  }

  function endPan(event) {
    if (!pan || event.pointerId !== pan.pointerId) return false;
    pan = null;
    panning.value = false;
    return true;
  }

  onBeforeUnmount(() => stopGlide());

  return { zoom, center, panning, viewBox, scale, resetView, zoomBy, graphPoint, onWheel, startPan, movePan, endPan };
}
