import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ZOOM, MIN_ZOOM, centerAfterZoom, clampZoom, fitZoomFor, fittedFrame, wheelZoomFactor } from "./useGraphViewport.js";

test("zooming keeps the point under the pointer in place", () => {
  const center = { x: 0, y: 0 };
  const point = { x: 100, y: 50 };
  const next = centerAfterZoom(center, point, 1, 2);
  assert.deepEqual(next, { x: 50, y: 25 });
  // The point's offset from the view center halves when the zoom doubles.
  assert.equal(point.x - next.x, (point.x - center.x) / 2);
  assert.deepEqual(centerAfterZoom(next, point, 2, 1), center);
});

test("zoom stays within its limits", () => {
  assert.equal(clampZoom(100), MAX_ZOOM);
  assert.equal(clampZoom(0.01), MIN_ZOOM);
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(0.1, 0.05), 0.1, "a lowered floor lets a shrunken fit zoom out further");
});

test("fitting never blows a small drawing up past the readable scale", () => {
  assert.equal(fitZoomFor(1.2, 1.6), 1, "a drawing that already fits is shown as is");
  assert.equal(fitZoomFor(4, 1.6), 0.4);
  assert.equal(fitZoomFor(0, 1.6), 1, "an unmeasured host keeps the default");
  assert.equal(fitZoomFor(9), 1, "no limit by default");
});

test("the fitted view frames the drawing, letterboxing included", () => {
  // A square drawing in a wide host: the frame is as tall as the drawing and wider.
  assert.deepEqual(fittedFrame({ x: -50, y: -50, width: 100, height: 100 }, { width: 400, height: 200 }), {
    x0: -100, y0: -50, x1: 100, y1: 50, scale: 2,
  });
  // A small drawing is not blown up past the readable scale: the frame grows instead.
  const capped = fittedFrame({ x: 0, y: 0, width: 10, height: 10 }, { width: 100, height: 100 }, 2);
  assert.equal(capped.scale, 2);
  assert.deepEqual([capped.x0, capped.x1], [-20, 30]);
  assert.equal(fittedFrame({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }), null, "no size yet");
  assert.equal(fittedFrame(null, { width: 100, height: 100 }), null);
});

test("wheel up zooms in, wheel down zooms out, line deltas count like pixels", () => {
  assert.ok(wheelZoomFactor({ deltaY: -100, deltaMode: 0 }) > 1);
  assert.ok(wheelZoomFactor({ deltaY: 100, deltaMode: 0 }) < 1);
  assert.equal(wheelZoomFactor({ deltaY: 0 }), 1);
  const pixels = wheelZoomFactor({ deltaY: 48, deltaMode: 0 });
  const lines = wheelZoomFactor({ deltaY: 3, deltaMode: 1 });
  assert.ok(Math.abs(pixels - lines) < 1e-12);
});
