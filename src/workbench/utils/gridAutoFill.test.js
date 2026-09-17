import test from "node:test";
import assert from "node:assert/strict";
import {
  canUseFillHandle,
  mapFillTargets,
  planAutoFill,
  resolveFillPreview,
} from "./gridAutoFill.js";

function filledValues(sourceMatrix, direction, fillCount, mode = "auto") {
  const result = planAutoFill({ sourceMatrix, direction, fillCount, mode });
  assert.equal(result.ok, true, result.reason || "expected a successful fill plan");
  return result;
}

test("single number fills an ascending series of step 1", () => {
  const result = filledValues([["1"]], "down", 3);
  assert.equal(result.mode, "series");
  assert.deepEqual(result.matrix, [["2"], ["3"], ["4"]]);
});

test("Ctrl or copy mode repeats a single number", () => {
  const result = filledValues([["1"]], "down", 3, "copy");
  assert.equal(result.mode, "copy");
  assert.deepEqual(result.matrix, [["1"], ["1"], ["1"]]);
});

test("two numbers continue an arithmetic series", () => {
  const result = filledValues([["1"], ["3"]], "down", 3);
  assert.deepEqual(result.matrix, [["5"], ["7"], ["9"]]);
});

test("identical numbers copy instead of inventing a step", () => {
  const result = filledValues([["5"], ["5"]], "down", 2);
  assert.equal(result.mode, "copy");
  assert.deepEqual(result.matrix, [["5"], ["5"]]);
});

test("non-arithmetic numbers tile the source block", () => {
  const result = filledValues([["1"], ["2"], ["4"]], "down", 4);
  assert.equal(result.mode, "copy");
  assert.deepEqual(result.matrix, [["1"], ["2"], ["4"], ["1"]]);
});

test("text plus a trailing number increments the number and keeps padding", () => {
  assert.deepEqual(filledValues([["产品1"]], "down", 1).matrix, [["产品2"]]);
  assert.deepEqual(filledValues([["item01"]], "down", 2).matrix, [["item02"], ["item03"]]);
});

test("two text-plus-number cells continue the numeric step", () => {
  const result = filledValues([["第1名"], ["第3名"]], "down", 2);
  assert.deepEqual(result.matrix, [["第5名"], ["第7名"]]);
});

test("dates increment by day and keep the source format", () => {
  const result = filledValues([["2024-01-01"]], "down", 2);
  assert.deepEqual(result.matrix, [["2024-01-02"], ["2024-01-03"]]);
});

test("two dates use the day gap as the step", () => {
  const result = filledValues([["2024/1/1"], ["2024/1/3"]], "down", 2);
  assert.deepEqual(result.matrix, [["2024/1/5"], ["2024/1/7"]]);
});

test("weekday and month lists continue and wrap", () => {
  assert.deepEqual(filledValues([["星期一"]], "down", 2).matrix, [["星期二"], ["星期三"]]);
  assert.deepEqual(filledValues([["周日"]], "down", 2).matrix, [["周一"], ["周二"]]);
  assert.deepEqual(filledValues([["十二月"]], "down", 1).matrix, [["一月"]]);
  assert.deepEqual(filledValues([["Monday"]], "down", 1).matrix, [["Tuesday"]]);
  assert.deepEqual(filledValues([["January"]], "down", 1).matrix, [["February"]]);
  assert.deepEqual(filledValues([["甲"]], "down", 2).matrix, [["乙"], ["丙"]]);
});

test("plain text copies", () => {
  const result = filledValues([["Alice"]], "down", 2);
  assert.equal(result.mode, "copy");
  assert.deepEqual(result.matrix, [["Alice"], ["Alice"]]);
});

test("empty and null values copy as empty strings", () => {
  const result = filledValues([[null], [""]], "down", 2);
  assert.deepEqual(result.matrix, [[""], [""]]);
});

test("filling up or left decrements a series", () => {
  assert.deepEqual(filledValues([["5"]], "up", 3).matrix, [["2"], ["3"], ["4"]]);
  assert.deepEqual(filledValues([["星期一"]], "up", 2).matrix, [["星期六"], ["星期日"]]);
  assert.deepEqual(filledValues([["1", "2"]], "left", 2).matrix, [["-1", "0"]]);
});

test("each column is planned independently when filling down", () => {
  const result = filledValues([
    ["1", "产品1"],
    ["3", "产品3"],
  ], "down", 2);
  assert.deepEqual(result.matrix, [
    ["5", "产品5"],
    ["7", "产品7"],
  ]);
});

test("filling right plans each row independently", () => {
  const result = filledValues([
    ["1", "2"],
    ["A", "B"],
  ], "right", 2);
  assert.deepEqual(result.matrix, [
    ["3", "4"],
    ["A", "B"],
  ]);
});

test("copy mode tiles against the source origin when filling up", () => {
  const result = filledValues([["1"], ["2"]], "up", 3, "copy");
  assert.deepEqual(result.matrix, [["2"], ["1"], ["2"]]);
});

test("rejects empty or invalid fill requests", () => {
  assert.equal(planAutoFill({ sourceMatrix: [["1"]], direction: "down", fillCount: 0 }).ok, false);
  assert.equal(planAutoFill({ sourceMatrix: [], direction: "down", fillCount: 1 }).ok, false);
  assert.equal(planAutoFill({ sourceMatrix: [["1"], ["2", "3"]], direction: "down", fillCount: 1 }).ok, false);
});

test("resolveFillPreview picks the dominant axis and stays inside loaded bounds", () => {
  const source = { top: 2, bottom: 3, left: 1, right: 2 };
  assert.deepEqual(resolveFillPreview(source, 6, 2), {
    direction: "down",
    fillCount: 3,
    previewBounds: { top: 2, bottom: 6, left: 1, right: 2 },
  });
  assert.deepEqual(resolveFillPreview(source, 0, 1), {
    direction: "up",
    fillCount: 2,
    previewBounds: { top: 0, bottom: 3, left: 1, right: 2 },
  });
  assert.deepEqual(resolveFillPreview(source, 3, 5), {
    direction: "right",
    fillCount: 3,
    previewBounds: { top: 2, bottom: 3, left: 1, right: 5 },
  });
  assert.deepEqual(resolveFillPreview(source, 2, 0), {
    direction: "left",
    fillCount: 1,
    previewBounds: { top: 2, bottom: 3, left: 0, right: 2 },
  });
  assert.equal(resolveFillPreview(source, 2, 1).fillCount, 0);
  assert.equal(resolveFillPreview(source, 10, 1, { maxRow: 7, maxColumn: 8 }).fillCount, 4);
});

test("mapFillTargets lists only the new cells in visual order", () => {
  const source = { top: 2, bottom: 2, left: 0, right: 0 };
  assert.deepEqual(mapFillTargets(source, "down", 2), [
    { rowIndex: 3, columnIndex: 0, matrixRow: 0, matrixCol: 0 },
    { rowIndex: 4, columnIndex: 0, matrixRow: 1, matrixCol: 0 },
  ]);
  assert.deepEqual(mapFillTargets(source, "up", 2), [
    { rowIndex: 0, columnIndex: 0, matrixRow: 0, matrixCol: 0 },
    { rowIndex: 1, columnIndex: 0, matrixRow: 1, matrixCol: 0 },
  ]);
});

test("fill handle is only available for a contiguous editable selection", () => {
  const range = {
    tabId: "tab-1",
    anchor: { rowIndex: 0, columnIndex: 0 },
    focus: { rowIndex: 1, columnIndex: 1 },
    toggledCells: [],
  };
  assert.equal(canUseFillHandle(range, { readOnly: false, editing: false }), true);
  assert.equal(canUseFillHandle(range, { readOnly: true, editing: false }), false);
  assert.equal(canUseFillHandle(range, { readOnly: false, editing: true }), false);
  assert.equal(canUseFillHandle(null, { readOnly: false, editing: false }), false);
  assert.equal(canUseFillHandle({
    ...range,
    toggledCells: [{ rowIndex: 3, columnIndex: 3 }],
  }, { readOnly: false, editing: false }), false);
});
