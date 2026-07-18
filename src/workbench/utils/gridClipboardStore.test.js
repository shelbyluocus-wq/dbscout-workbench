import test from "node:test";
import assert from "node:assert/strict";
import {
  clearGridClipboardPayload,
  getGridClipboardPayload,
  setGridClipboardPayload,
} from "./gridClipboardStore.js";

test("shares sparse clipboard metadata and returns defensive clones", () => {
  clearGridClipboardPayload();
  setGridClipboardPayload("A\t\tC", {
    kind: "sparse",
    matrix: [["A", "", "C"]],
    mask: [[true, false, true]],
    bounds: { top: 0, bottom: 0, left: 0, right: 2 },
  });

  const first = getGridClipboardPayload("A\t\tC");
  assert.deepEqual(first.mask, [[true, false, true]]);
  first.mask[0][0] = false;
  first.matrix[0][0] = "changed";

  const second = getGridClipboardPayload("A\t\tC");
  assert.deepEqual(second.mask, [[true, false, true]]);
  assert.equal(second.matrix[0][0], "A");
});

test("does not reuse metadata after clipboard text changes", () => {
  clearGridClipboardPayload();
  setGridClipboardPayload("same\ntext", { kind: "cell", matrix: [["same\ntext"]] });

  assert.equal(getGridClipboardPayload("different"), null);
  assert.equal(getGridClipboardPayload("same\r\ntext")?.kind, "cell");
});
