import test from "node:test";
import assert from "node:assert/strict";
import {
  clipboardMaskIsSparse,
  clipboardMasksEqual,
  tileClipboardMatrix,
  tileClipboardMatrixToSelection,
  tileClipboardPayload,
} from "./gridClipboardFill.js";

test("tiles a copied row down a taller selection", () => {
  const result = tileClipboardMatrix([["1", "100"]], 4, 2);

  assert.equal(result.ok, true);
  assert.deepEqual(result.matrix, [
    ["1", "100"],
    ["1", "100"],
    ["1", "100"],
    ["1", "100"],
  ]);
});

test("tiles a copied column across a wider selection", () => {
  const result = tileClipboardMatrix([["A"], ["B"]], 2, 4);

  assert.equal(result.ok, true);
  assert.deepEqual(result.matrix, [
    ["A", "A", "A", "A"],
    ["B", "B", "B", "B"],
  ]);
});

test("tiles a two-dimensional pattern in both directions", () => {
  const result = tileClipboardMatrix([["A", "B"], ["C", "D"]], 4, 4);

  assert.equal(result.ok, true);
  assert.deepEqual(result.matrix, [
    ["A", "B", "A", "B"],
    ["C", "D", "C", "D"],
    ["A", "B", "A", "B"],
    ["C", "D", "C", "D"],
  ]);
});

test("keeps an exact-size matrix unchanged", () => {
  const matrix = [["A", "B"], ["C", "D"]];
  const result = tileClipboardMatrix(matrix, 2, 2);

  assert.equal(result.ok, true);
  assert.deepEqual(result.matrix, matrix);
  assert.notEqual(result.matrix, matrix);
});

test("rejects a selection that is not an exact multiple of the source", () => {
  const result = tileClipboardMatrix([["1", "100"]], 3, 3);

  assert.deepEqual(result, {
    ok: false,
    reason: "incompatible-size",
    source: { rowCount: 1, columnCount: 2, columnCounts: [2], rectangular: true },
    target: { rowCount: 3, columnCount: 3 },
  });
});

test("rejects an irregular clipboard matrix", () => {
  const result = tileClipboardMatrix([["A", "B"], ["C"]], 2, 2);

  assert.deepEqual(result, {
    ok: false,
    reason: "irregular-source",
    source: { rowCount: 2, columnCount: 2, columnCounts: [2, 1], rectangular: false },
    target: { rowCount: 2, columnCount: 2 },
  });
});

test("expands a multi-row single-column selection to fit a copied row", () => {
  const result = tileClipboardMatrixToSelection([["1", "100"]], 4, 1);

  assert.equal(result.ok, true);
  assert.deepEqual(result.selection, { rowCount: 4, columnCount: 1 });
  assert.deepEqual(result.target, { rowCount: 4, columnCount: 2 });
  assert.deepEqual(result.matrix, [
    ["1", "100"],
    ["1", "100"],
    ["1", "100"],
    ["1", "100"],
  ]);
});

test("expands a single-row multi-column selection to fit a copied column", () => {
  const result = tileClipboardMatrixToSelection([["A"], ["B"]], 1, 4);

  assert.equal(result.ok, true);
  assert.deepEqual(result.selection, { rowCount: 1, columnCount: 4 });
  assert.deepEqual(result.target, { rowCount: 2, columnCount: 4 });
  assert.deepEqual(result.matrix, [
    ["A", "A", "A", "A"],
    ["B", "B", "B", "B"],
  ]);
});

test("does not expand a multi-column selection with an incompatible width", () => {
  const result = tileClipboardMatrixToSelection([["1", "100"]], 4, 3);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "incompatible-size");
  assert.deepEqual(result.selection, { rowCount: 4, columnCount: 3 });
  assert.deepEqual(result.target, { rowCount: 4, columnCount: 3 });
});

test("tiles sparse clipboard values without selecting holes", () => {
  const result = tileClipboardPayload(
    [["A", "", "C"]],
    [[true, false, true]],
    2,
    6,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.matrix, [
    ["A", "", "C", "A", "", "C"],
    ["A", "", "C", "A", "", "C"],
  ]);
  assert.deepEqual(result.mask, [
    [true, false, true, true, false, true],
    [true, false, true, true, false, true],
  ]);
  assert.equal(clipboardMaskIsSparse(result.mask), true);
});

test("rejects clipboard metadata whose mask shape does not match its matrix", () => {
  const result = tileClipboardPayload([["A", "B"]], [[true]], 1, 2);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-mask");
});

test("compares sparse masks by shape and selected positions", () => {
  assert.equal(clipboardMasksEqual([[true, false]], [[true, false]]), true);
  assert.equal(clipboardMasksEqual([[true, false]], [[false, true]]), false);
  assert.equal(clipboardMasksEqual([[true, false]], [[true], [false]]), false);
});
