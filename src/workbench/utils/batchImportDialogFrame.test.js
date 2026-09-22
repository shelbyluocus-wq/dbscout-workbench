import test from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_IMPORT_DIALOG_FRAME_KEY,
  clampDialogFrame,
  loadBatchImportDialogFrame,
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
  saveBatchImportDialogFrame({ left: 24, top: 32, width: 960, height: 700 }, storage);
  assert.equal(JSON.parse(saved[0]).version, 1);
  assert.equal(storage.getItem(BATCH_IMPORT_DIALOG_FRAME_KEY), saved[0]);
  assert.deepEqual(loadBatchImportDialogFrame(storage, viewport), { left: 24, top: 32, width: 960, height: 700 });

  saved[0] = "{";
  assert.equal(loadBatchImportDialogFrame(storage, viewport), null);
  saved[0] = JSON.stringify({ version: 1, left: "wide" });
  assert.equal(loadBatchImportDialogFrame(storage, viewport), null);
});
