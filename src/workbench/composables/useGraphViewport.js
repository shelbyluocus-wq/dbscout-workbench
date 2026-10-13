// Zoom and pan for an SVG graph whose drawing fits `fit` (graph units). The
// viewBox is derived from a zoom factor and a center point; the wheel zooms
// around the pointer, buttons and "fit" glide there, and dragging empty
// space pans.
import { computed, onBeforeUnmount, ref } from "vue";

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

export function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
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

export function useGraphViewport({ fit, hostSize, svgEl }) {
  const zoom = ref(1);
  const center = ref({ x: 0, y: 0 });
  const panning = ref(false);
  let pan = null;
  let glide = 0;

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

  function stopGlide() {
    if (glide) globalThis.cancelAnimationFrame?.(glide);
    glide = 0;
  }

  function moveTo(nextZoom, nextCenter, { animate = true } = {}) {
    stopGlide();
    const targetZoom = clampZoom(nextZoom);
    if (!animate || prefersReducedMotion() || typeof globalThis.requestAnimationFrame !== "function") {
      zoom.value = targetZoom;
      center.value = { ...nextCenter };
      return;
    }
    const fromZoom = zoom.value;
    const fromCenter = { ...center.value };
    const started = globalThis.performance?.now?.() ?? Date.now();
    const step = (now) => {
      const progress = Math.min(1, (now - started) / GLIDE_MS);
      const eased = easeOutCubic(progress);
      // Interpolating zoom in log space keeps the glide even in both directions.
      zoom.value = fromZoom * (targetZoom / fromZoom) ** eased;
      center.value = {
        x: fromCenter.x + (nextCenter.x - fromCenter.x) * eased,
        y: fromCenter.y + (nextCenter.y - fromCenter.y) * eased,
      };
      glide = progress < 1 ? globalThis.requestAnimationFrame(step) : 0;
    };
    glide = globalThis.requestAnimationFrame(step);
  }

  function fitCenter() {
    const box = fit.value;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  function resetView(options) {
    moveTo(1, fitCenter(), options);
  }

  function zoomBy(factor, point = center.value, options) {
    const target = clampZoom(zoom.value * factor);
    moveTo(target, centerAfterZoom(center.value, point, zoom.value, target), options);
  }

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

  onBeforeUnmount(stopGlide);

  return { zoom, center, panning, viewBox, scale, resetView, zoomBy, graphPoint, onWheel, startPan, movePan, endPan };
}
