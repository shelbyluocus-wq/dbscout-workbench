import test from "node:test";
import assert from "node:assert/strict";

import { CAMERA_MAX_SCALE, createGraphCamera, wheelFactor } from "./graphCamera.js";

function settle(camera, limit = 400) {
  let frames = 0;
  while (camera.step() && frames < limit) frames += 1;
  return frames;
}

test("a wheel notch zooms about 1.5 times, and fast wheels are capped", () => {
  assert.ok(Math.abs(wheelFactor({ deltaY: -100, deltaMode: 0 }) - 1.5) < 1e-9);
  assert.ok(Math.abs(wheelFactor({ deltaY: 100, deltaMode: 0 }) - 1 / 1.5) < 1e-9);
  assert.ok(wheelFactor({ deltaY: -3, deltaMode: 1 }) > 1, "line-based wheels zoom too");
  assert.equal(wheelFactor({ deltaY: -10000, deltaMode: 0 }), 2.25);
  assert.equal(wheelFactor({ deltaY: 0 }), 1);
});

test("zooming eases in and keeps the point under the pointer still", () => {
  const camera = createGraphCamera();
  camera.setSize(800, 600);
  camera.jumpTo({ scale: 1, x: 0, y: 0 });
  const under = camera.toGraph(600, 150);
  camera.zoomAt(2, 600, 150);
  assert.ok(camera.step(), "the first frame is only part of the way");
  assert.ok(camera.view.scale > 1 && camera.view.scale < 2);
  settle(camera);
  assert.ok(Math.abs(camera.view.scale - 2) < 1e-6);
  const after = camera.toScreen(under.x, under.y);
  assert.ok(Math.abs(after.x - 600) < 1e-6 && Math.abs(after.y - 150) < 1e-6);
});

test("fit shows the whole box, never past the cap, within the zoom limits", () => {
  const camera = createGraphCamera();
  camera.setSize(800, 600);
  camera.fitTo({ x: -200, y: -100, width: 400, height: 200 }, { padding: 0, animate: false });
  assert.equal(camera.view.scale, 2);
  assert.deepEqual([camera.view.x, camera.view.y], [0, 0]);
  camera.fitTo({ x: 0, y: 0, width: 10, height: 10 }, { padding: 0, maxScale: 1.6, animate: false });
  assert.equal(camera.view.scale, 1.6);
  camera.setLimits({ min: 0.5, max: 4 });
  camera.zoomAt(100);
  settle(camera);
  assert.equal(camera.view.scale, 4);
  assert.ok(CAMERA_MAX_SCALE >= 4);
});

test("a released pan coasts to a stop", () => {
  const camera = createGraphCamera();
  camera.setSize(800, 600);
  camera.jumpTo({ scale: 2, x: 0, y: 0 });
  camera.panBy(40, 0);
  assert.equal(camera.view.x, -20);
  camera.coast(10, 0);
  const frames = settle(camera);
  assert.ok(frames > 5 && frames < 200, `${frames} frames`);
  assert.ok(camera.view.x < -20 - 10, "kept moving after release");
  assert.equal(camera.step(), false);
});
