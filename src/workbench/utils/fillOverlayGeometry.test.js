import test from "node:test";
import assert from "node:assert/strict";
import {
  clampRectToViewport,
  resolveFillPreviewTipPosition,
  resolvePixelAxisDelta,
  resolveTargetBounds,
} from "./fillOverlayGeometry.js";

test("resolveTargetBounds splits out only the newly filled cells in all four directions", () => {
  const source = { top: 2, bottom: 3, left: 1, right: 2 };
  assert.deepEqual(resolveTargetBounds(source, "down", 3), { top: 4, bottom: 6, left: 1, right: 2 });
  assert.deepEqual(resolveTargetBounds(source, "up", 2), { top: 0, bottom: 1, left: 1, right: 2 });
  assert.deepEqual(resolveTargetBounds(source, "right", 2), { top: 2, bottom: 3, left: 3, right: 4 });
  assert.deepEqual(resolveTargetBounds(source, "left", 1), { top: 2, bottom: 3, left: 0, right: 0 });
  assert.equal(resolveTargetBounds(source, "down", 0), null);
});

test("resolvePixelAxisDelta measures exact excursion outside the source rectangle", () => {
  const sourceRect = { left: 100, right: 220, top: 80, bottom: 108 };
  assert.deepEqual(resolvePixelAxisDelta({ pointerX: 150, pointerY: 95, sourceRect }), {
    vertical: 0,
    horizontal: 0,
  });
  assert.deepEqual(resolvePixelAxisDelta({ pointerX: 360, pointerY: 138, sourceRect }), {
    vertical: 30,
    horizontal: 140,
  });
  assert.deepEqual(resolvePixelAxisDelta({ pointerX: 80, pointerY: 50, sourceRect }), {
    vertical: 30,
    horizontal: 20,
  });
});

test("clampRectToViewport clips off-screen edges and marks clipped sides without shrinking visible ones", () => {
  const viewport = {
    contentLeft: 40,
    contentRight: 440,
    contentTop: 60,
    contentBottom: 360,
  };
  const scrolledTop = clampRectToViewport(
    { left: 100, right: 200, top: 20, bottom: 180 },
    viewport,
    { minTop: 88, minLeft: 40 },
  );
  assert.deepEqual(scrolledTop, {
    left: 60,
    top: 28,
    width: 100,
    height: 92,
    clientLeft: 100,
    clientTop: 88,
    clientRight: 200,
    clientBottom: 180,
    clippedTop: true,
    clippedBottom: false,
    clippedLeft: false,
    clippedRight: false,
  });

  // Completely scrolled out returns null.
  assert.equal(
    clampRectToViewport({ left: 100, right: 200, top: 10, bottom: 40 }, viewport),
    null,
  );
});

test("resolveFillPreviewTipPosition keeps the ScreenTip beside the active edge and flips near viewport edges", () => {
  const viewport = { contentLeft: 40, contentRight: 500, contentTop: 60, contentBottom: 400 };
  const shellRect = { left: 0, top: 0 };
  const previewRect = { clientLeft: 120, clientRight: 220, clientTop: 100, clientBottom: 240 };

  const downTip = resolveFillPreviewTipPosition({
    previewRect,
    direction: "down",
    pointer: { x: 180, y: 220 },
    viewport,
    shellRect,
    tipWidth: 100,
    tipHeight: 26,
  });
  assert.equal(downTip.left, 230);
  assert.equal(downTip.top, 207);

  // Near right edge: flips cleanly to the left of the preview frame.
  const nearRight = resolveFillPreviewTipPosition({
    previewRect: { clientLeft: 380, clientRight: 480, clientTop: 100, clientBottom: 240 },
    direction: "down",
    pointer: { x: 430, y: 200 },
    viewport,
    shellRect,
    tipWidth: 100,
    tipHeight: 26,
  });
  assert.equal(nearRight.left, 270);

  // Near bottom edge during horizontal drag: flips above the preview frame.
  const nearBottom = resolveFillPreviewTipPosition({
    previewRect: { clientLeft: 120, clientRight: 360, clientTop: 350, clientBottom: 386 },
    direction: "right",
    pointer: { x: 300, y: 370 },
    viewport,
    shellRect,
    tipWidth: 100,
    tipHeight: 26,
  });
  assert.equal(nearBottom.top, 316);
});
