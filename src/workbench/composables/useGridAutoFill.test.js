import test from "node:test";
import assert from "node:assert/strict";
import { useGridAutoFill } from "./useGridAutoFill.js";

test("fill session records a request only after the preview leaves the source", () => {
  const fill = useGridAutoFill();
  const sourceBounds = { top: 0, bottom: 0, left: 1, right: 1 };
  assert.equal(fill.beginFillSession({
    sourceBounds,
    sourceMatrix: [["1"]],
  }), true);
  assert.equal(fill.isFilling.value, true);
  assert.equal(fill.takeFillRequest(), null);

  fill.beginFillSession({ sourceBounds, sourceMatrix: [["1"]] });
  fill.updateFillPreview(3, 1, { maxRow: 5, maxColumn: 2 });
  const request = fill.takeFillRequest();
  assert.deepEqual(request, {
    sourceBounds,
    sourceMatrix: [["1"]],
    direction: "down",
    fillCount: 3,
    previewBounds: { top: 0, bottom: 3, left: 1, right: 1 },
    mode: "auto",
  });
  assert.equal(fill.isFilling.value, false);
});

test("Ctrl at start or finish forces copy mode", () => {
  const fill = useGridAutoFill();
  fill.beginFillSession({
    sourceBounds: { top: 0, bottom: 0, left: 0, right: 0 },
    sourceMatrix: [["1"]],
    copyKey: true,
  });
  fill.updateFillPreview(2, 0, { maxRow: 4, maxColumn: 2 });
  assert.equal(fill.takeFillRequest().mode, "copy");
});
