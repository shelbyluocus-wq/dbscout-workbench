import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ZOOM, MIN_ZOOM, centerAfterZoom, clampZoom, wheelZoomFactor } from "./useGraphViewport.js";

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
});

test("wheel up zooms in, wheel down zooms out, line deltas count like pixels", () => {
  assert.ok(wheelZoomFactor({ deltaY: -100, deltaMode: 0 }) > 1);
  assert.ok(wheelZoomFactor({ deltaY: 100, deltaMode: 0 }) < 1);
  assert.equal(wheelZoomFactor({ deltaY: 0 }), 1);
  const pixels = wheelZoomFactor({ deltaY: 48, deltaMode: 0 });
  const lines = wheelZoomFactor({ deltaY: 3, deltaMode: 1 });
  assert.ok(Math.abs(pixels - lines) < 1e-12);
});
