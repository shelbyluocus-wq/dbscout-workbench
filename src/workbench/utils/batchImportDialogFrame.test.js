import test from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_IMPORT_DIALOG_FRAME_KEY,
  centerDialogFrame,
  clampDialogFrame,
  loadBatchImportDialogFrame,
  moveDialogFrame,
  resizeDialogFrame,
  saveBatchImportDialogFrame,
} from "./batchImportDialogFrame.js";

const viewport = { width: 1400, height: 900 };
const start = { left: 200, top: 80, width: 880, height: 640 };

test("dragging one edge keeps the opposite edge in place", () => {
  const right = resizeDialogFrame(start, { x: 120, y: 0 }, { right: true }, viewport);
  assert.equal(right.left, start.left);
  assert.equal(right.width, start.width + 120);
  assert.equal(right.top, start.top);
  assert.equal(right.height, start.height);

  const left = resizeDialogFrame(start, { x: -40, y: 0 }, { left: true }, viewport);
  assert.equal(left.left + left.width, start.left + start.width);
  assert.equal(left.width, start.width + 40);

  const bottom = resizeDialogFrame(start, { x: 0, y: 80 }, { bottom: true }, viewport);
  assert.equal(bottom.top, start.top);
  assert.equal(bottom.height, start.height + 80);

  const top = resizeDialogFrame(start, { x: 0, y: -30 }, { top: true }, viewport);
  assert.equal(top.top + top.height, start.top + start.height);
  assert.equal(top.height, start.height + 30);
});

test("dragging a corner keeps the opposite corner anchored", () => {
  const grown = resizeDialogFrame(start, { x: 60, y: 40 }, { right: true, bottom: true }, viewport);
  assert.equal(grown.left, start.left);
  assert.equal(grown.top, start.top);
  assert.equal(grown.width, start.width + 60);
  assert.equal(grown.height, start.height + 40);

  const shrunk = resizeDialogFrame(start, { x: 30, y: 20 }, { left: true, top: true }, viewport);
  assert.equal(shrunk.left + shrunk.width, start.left + start.width);
  assert.equal(shrunk.top + shrunk.height, start.top + start.height);
});

test("resize stops at the minimum size and the screen edge", () => {
  const tooSmall = resizeDialogFrame(start, { x: 500, y: 400 }, { left: true, top: true }, viewport);
  assert.equal(tooSmall.left + tooSmall.width, start.left + start.width);
  assert.equal(tooSmall.top + tooSmall.height, start.top + start.height);
  assert.equal(tooSmall.width, 640);
  assert.equal(tooSmall.height, 420);

  const tooWide = resizeDialogFrame(start, { x: 2000, y: 0 }, { right: true }, viewport);
  assert.equal(tooWide.left, start.left);
  assert.equal(tooWide.left + tooWide.width, viewport.width - 16);
});

test("a saved frame is pulled back inside the screen", () => {
  const frame = clampDialogFrame({ left: -20, top: 2000, width: 4000, height: 10 }, { width: 1000, height: 700 });
  assert.equal(frame.left, 16);
  assert.equal(frame.width, 1000 - 32);
  assert.equal(frame.height, 420);
  assert.equal(frame.top + frame.height, 700 - 16);
});

test("dialog size is remembered and ignored when the saved value is unusable", () => {
  const saved = [];
  const storage = {
    getItem: () => saved[0] || null,
    setItem: (_key, value) => {
      saved[0] = value;
    },
  };
  saveBatchImportDialogFrame({ left: 24, top: 32, width: 960, height: 700, positioned: true }, storage, viewport);
  const stored = JSON.parse(saved[0]);
  assert.equal(stored.version, 1);
  assert.equal(stored.positioned, true);
  assert.equal(stored.viewportWidth, viewport.width);
  assert.equal(storage.getItem(BATCH_IMPORT_DIALOG_FRAME_KEY), saved[0]);
  assert.deepEqual(loadBatchImportDialogFrame(storage, viewport), { left: 24, top: 32, width: 960, height: 700 });

  saved[0] = "{";
  assert.equal(loadBatchImportDialogFrame(storage, viewport), null);
  saved[0] = JSON.stringify({ version: 1, left: "wide" });
  assert.equal(loadBatchImportDialogFrame(storage, viewport), null);
});

test("a saved place is centered when the window was never dragged or the screen changed", () => {
  const saved = [];
  const storage = {
    getItem: () => saved[0] || null,
    setItem: (_key, value) => {
      saved[0] = value;
    },
  };
  const fullscreen = { width: 1920, height: 1080 };
  saveBatchImportDialogFrame({ left: 16, top: 20, width: 700, height: 480 }, storage, { width: 800, height: 600 });
  const centered = loadBatchImportDialogFrame(storage, fullscreen);
  assert.deepEqual(centered, centerDialogFrame({ width: 700, height: 480 }, fullscreen));
  assert.equal(centered.left, Math.round((fullscreen.width - 700) / 2));
  assert.equal(centered.top, Math.round((fullscreen.height - 480) / 2));

  saveBatchImportDialogFrame(
    { left: 40, top: 50, width: 700, height: 480, positioned: true },
    storage,
    fullscreen,
  );
  assert.deepEqual(loadBatchImportDialogFrame(storage, fullscreen), { left: 40, top: 50, width: 700, height: 480 });
  assert.deepEqual(loadBatchImportDialogFrame(storage, { width: 1960, height: 1120 }), {
    left: 40,
    top: 50,
    width: 700,
    height: 480,
  });
  const restored = loadBatchImportDialogFrame(storage, { width: 1280, height: 800 });
  assert.equal(restored.left, Math.round((1280 - 700) / 2));
  assert.equal(restored.top, Math.round((800 - 480) / 2));
});

test("dragging the window moves it and keeps it on screen", () => {
  const moved = moveDialogFrame(start, { x: 30, y: -20 }, viewport);
  assert.equal(moved.left, start.left + 30);
  assert.equal(moved.top, start.top - 20);
  assert.equal(moved.width, start.width);
  assert.equal(moved.height, start.height);

  const stuck = moveDialogFrame(start, { x: -5000, y: 5000 }, viewport);
  assert.equal(stuck.left, 16);
  assert.equal(stuck.top + stuck.height, viewport.height - 16);
  assert.equal(stuck.width, start.width);
});
