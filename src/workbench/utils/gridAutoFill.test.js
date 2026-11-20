import test from "node:test";
import assert from "node:assert/strict";
import {
  canUseFillHandle,
  describeFillPreview,
  mapFillTargets,
  planAutoFill,
  resolveDoubleClickFillCount,
  resolveFillPreview,
} from "./gridAutoFill.js";

function filledValues(sourceMatrix, direction, fillCount, mode = "auto") {
  const result = planAutoFill({ sourceMatrix, direction, fillCount, mode });
  assert.equal(result.ok, true, result.reason || "expected a successful fill plan");
  return result;
}

test("WPS/Excel rule: single plain number copies by default and Ctrl/series increments by 1", () => {
  const auto = filledValues([["1"]], "down", 3);
  assert.equal(auto.mode, "copy");
  assert.equal(auto.canToggleMode, true);
  assert.deepEqual(auto.matrix, [["1"], ["1"], ["1"]]);

  const toggled = filledValues([["1"]], "down", 3, "toggle");
  assert.equal(toggled.mode, "series");
  assert.equal(toggled.canToggleMode, true);
  assert.deepEqual(toggled.matrix, [["2"], ["3"], ["4"]]);

  const explicitSeries = filledValues([["1"]], "down", 3, "series");
  assert.equal(explicitSeries.mode, "series");
  assert.deepEqual(explicitSeries.matrix, [["2"], ["3"], ["4"]]);
});

test("WPS/Excel rule: two arithmetic numbers continue a series by default and Ctrl/copy tiles 1, 2, 1, 2", () => {
  const auto = filledValues([["1"], ["2"]], "down", 4);
  assert.equal(auto.mode, "series");
  assert.equal(auto.canToggleMode, true);
  assert.deepEqual(auto.matrix, [["3"], ["4"], ["5"], ["6"]]);

  const toggled = filledValues([["1"], ["2"]], "down", 4, "toggle");
  assert.equal(toggled.mode, "copy");
  assert.equal(toggled.canToggleMode, true);
  assert.deepEqual(toggled.matrix, [["1"], ["2"], ["1"], ["2"]]);

  const stepped = filledValues([["1"], ["3"]], "down", 3);
  assert.deepEqual(stepped.matrix, [["5"], ["7"], ["9"]]);
});

test("decimal precision is preserved when samples share decimal places", () => {
  const result = filledValues([["1.10"], ["1.20"]], "down", 2);
  assert.equal(result.mode, "series");
  assert.deepEqual(result.matrix, [["1.30"], ["1.40"]]);
});

test("identical numbers copy and cannot meaningfully toggle to series", () => {
  const result = filledValues([["5"], ["5"]], "down", 2);
  assert.equal(result.mode, "copy");
  assert.equal(result.canToggleMode, false);
  assert.deepEqual(result.matrix, [["5"], ["5"]]);
});

test("non-arithmetic numbers tile the source block", () => {
  const result = filledValues([["1"], ["2"], ["4"]], "down", 4);
  assert.equal(result.mode, "copy");
  assert.equal(result.canToggleMode, false);
  assert.deepEqual(result.matrix, [["1"], ["2"], ["4"], ["1"]]);
});

test("text plus a trailing number increments by default and Ctrl toggles to copy", () => {
  assert.deepEqual(filledValues([["产品1"]], "down", 2).matrix, [["产品2"], ["产品3"]]);
  assert.deepEqual(filledValues([["产品1"]], "down", 2, "toggle").matrix, [["产品1"], ["产品1"]]);
  assert.deepEqual(filledValues([["item01"]], "down", 2).matrix, [["item02"], ["item03"]]);
  assert.deepEqual(filledValues([["第1名"], ["第3名"]], "down", 2).matrix, [["第5名"], ["第7名"]]);
  assert.deepEqual(filledValues([["item-1"], ["item-2"]], "down", 2).matrix, [["item-3"], ["item-4"]]);
  assert.deepEqual(filledValues([["temp -2"], ["temp -1"]], "down", 3).matrix, [["temp 0"], ["temp 1"], ["temp 2"]]);
});

test("dates increment by day, calendar month, or year and keep source padding", () => {
  assert.deepEqual(filledValues([["2024-01-01"]], "down", 2).matrix, [["2024-01-02"], ["2024-01-03"]]);
  assert.deepEqual(filledValues([["2024/1/1"], ["2024/1/3"]], "down", 2).matrix, [["2024/1/5"], ["2024/1/7"]]);
  assert.deepEqual(filledValues([["2024-01-01"], ["2024-02-01"]], "down", 2).matrix, [["2024-03-01"], ["2024-04-01"]]);
  assert.deepEqual(filledValues([["2024-01-31"], ["2024-02-29"]], "down", 2).matrix, [["2024-03-31"], ["2024-04-30"]]);
  assert.deepEqual(filledValues([["2024-01-01"], ["2025-01-01"]], "down", 2).matrix, [["2026-01-01"], ["2027-01-01"]]);
  assert.deepEqual(filledValues([["2024/1/10"]], "up", 1).matrix, [["2024/1/9"]]);
});

test("datetime and time cells advance valid calendar/clock steps instead of overflowing seconds", () => {
  assert.deepEqual(
    filledValues([["2024-01-01 10:00:00"]], "down", 2).matrix,
    [["2024-01-02 10:00:00"], ["2024-01-03 10:00:00"]],
  );
  assert.deepEqual(
    filledValues([["2024-01-01 23:00:00"], ["2024-01-02 00:00:00"]], "down", 2).matrix,
    [["2024-01-02 01:00:00"], ["2024-01-02 02:00:00"]],
  );
  assert.deepEqual(
    filledValues([["2024-01-01 00:00:59"], ["2024-01-01 00:01:00"]], "down", 2).matrix,
    [["2024-01-01 00:01:01"], ["2024-01-01 00:01:02"]],
  );
  assert.deepEqual(
    filledValues([["2024-01-01 08:30:00"], ["2024-02-01 08:30:00"]], "down", 2).matrix,
    [["2024-03-01 08:30:00"], ["2024-04-01 08:30:00"]],
  );
  assert.deepEqual(
    filledValues([["23:00:00"]], "down", 2).matrix,
    [["00:00:00"], ["01:00:00"]],
  );
  assert.deepEqual(
    filledValues([["09:00"], ["09:30"]], "down", 2).matrix,
    [["10:00"], ["10:30"]],
  );
});

test("weekday, month, quarter, and zodiac lists continue and wrap seamlessly across boundaries", () => {
  assert.deepEqual(filledValues([["星期一"]], "down", 2).matrix, [["星期二"], ["星期三"]]);
  assert.deepEqual(filledValues([["星期日"], ["星期一"], ["星期二"]], "down", 2).matrix, [["星期三"], ["星期四"]]);
  assert.deepEqual(filledValues([["星期一"], ["星期日"], ["星期六"]], "down", 2).matrix, [["星期五"], ["星期四"]]);
  assert.deepEqual(filledValues([["周日"]], "down", 2).matrix, [["周一"], ["周二"]]);
  assert.deepEqual(filledValues([["十二月"]], "down", 1).matrix, [["一月"]]);
  assert.deepEqual(filledValues([["Monday"]], "down", 1).matrix, [["Tuesday"]]);
  assert.deepEqual(filledValues([["Mon"]], "down", 2).matrix, [["Tue"], ["Wed"]]);
  assert.deepEqual(filledValues([["Jan"]], "down", 2).matrix, [["Feb"], ["Mar"]]);
  assert.deepEqual(filledValues([["Q1"]], "down", 4).matrix, [["Q2"], ["Q3"], ["Q4"], ["Q1"]]);
  assert.deepEqual(filledValues([["甲"]], "down", 2).matrix, [["乙"], ["丙"]]);
  assert.deepEqual(filledValues([["亥"]], "down", 1).matrix, [["子"]]);
});

test("plain text copies and reports canToggleMode as false", () => {
  const result = filledValues([["Alice"]], "down", 2);
  assert.equal(result.mode, "copy");
  assert.equal(result.canToggleMode, false);
  assert.deepEqual(result.matrix, [["Alice"], ["Alice"]]);
});

test("null values are preserved as null instead of turning into empty strings", () => {
  const result = filledValues([[null], [""]], "down", 3);
  assert.equal(result.mode, "copy");
  assert.deepEqual(result.matrix, [[null], [""], [null]]);
});

test("filling up or left decrements series and copies single numbers by default", () => {
  assert.deepEqual(filledValues([["5"]], "up", 3).matrix, [["5"], ["5"], ["5"]]);
  assert.deepEqual(filledValues([["5"]], "up", 3, "series").matrix, [["2"], ["3"], ["4"]]);
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

  const mixedSingle = filledValues([["1", "产品1"]], "down", 2);
  assert.deepEqual(mixedSingle.matrix, [
    ["1", "产品2"],
    ["1", "产品3"],
  ]);
  const mixedSeries = filledValues([["1", "产品1"]], "down", 2, "series");
  assert.deepEqual(mixedSeries.matrix, [
    ["2", "产品2"],
    ["3", "产品3"],
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

test("describeFillPreview reports end value and mode for live tooltip", () => {
  assert.deepEqual(describeFillPreview({
    sourceMatrix: [["1"], ["2"]],
    direction: "down",
    fillCount: 3,
    mode: "auto",
  }), {
    mode: "series",
    canToggleMode: true,
    endValue: "5",
    displayValue: "5",
    fillCount: 3,
    direction: "down",
  });
  assert.deepEqual(describeFillPreview({
    sourceMatrix: [["1"], ["2"]],
    direction: "down",
    fillCount: 3,
    mode: "toggle",
  }), {
    mode: "copy",
    canToggleMode: true,
    endValue: "1",
    displayValue: "1",
    fillCount: 3,
    direction: "down",
  });
  assert.equal(describeFillPreview({
    sourceMatrix: [[null]],
    direction: "down",
    fillCount: 2,
    mode: "auto",
  }).displayValue, "NULL");
});

test("resolveDoubleClickFillCount follows adjacent contiguous non-empty column or falls back to loaded rows", () => {
  const grid = [
    ["1", "10", "a"],
    ["2", "20", "b"],
    ["3", "", "c"],
    ["", "", "d"],
    ["5", "", "e"],
  ];
  const getCellValue = (r, c) => grid[r]?.[c] ?? null;
  // Column 1 has non-empty left neighbor (col 0) for rows 0..2, stops before gap at row 3.
  assert.equal(resolveDoubleClickFillCount({
    sourceBounds: { top: 0, bottom: 1, left: 1, right: 1 },
    totalRows: grid.length,
    columnCount: 3,
    getCellValue,
  }), 1);
  // Column 0 has no left neighbor; right neighbor (col 1) is empty at row 2, so falls back to loaded end.
  assert.equal(resolveDoubleClickFillCount({
    sourceBounds: { top: 0, bottom: 1, left: 0, right: 0 },
    totalRows: grid.length,
    columnCount: 3,
    getCellValue,
  }), 3);
  // Column 1 when row 2 has left empty checks right neighbor (col 2), which is contiguous to row 4.
  assert.equal(resolveDoubleClickFillCount({
    sourceBounds: { top: 2, bottom: 2, left: 1, right: 1 },
    totalRows: grid.length,
    columnCount: 3,
    getCellValue,
  }), 2);
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
