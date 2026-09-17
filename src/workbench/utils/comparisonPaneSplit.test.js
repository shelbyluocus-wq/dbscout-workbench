import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COMPARISON_PANE_RATIO,
  MIN_COMPARISON_PANE_RATIO,
  clampComparisonPaneRatio,
  comparisonPaneRatioFromClientX,
  comparisonPaneRatioFromKey,
  comparisonPaneResizerStyle,
  comparisonSplitGridStyle,
  readStoredComparisonPaneRatio,
} from "./comparisonPaneSplit.js";

test("missing stored pane ratio stays even instead of collapsing to the minimum", () => {
  assert.equal(readStoredComparisonPaneRatio(null), DEFAULT_COMPARISON_PANE_RATIO);
  assert.equal(readStoredComparisonPaneRatio(""), DEFAULT_COMPARISON_PANE_RATIO);
  assert.equal(readStoredComparisonPaneRatio("0.7"), 0.7);
  assert.equal(readStoredComparisonPaneRatio("nope"), DEFAULT_COMPARISON_PANE_RATIO);
});

test("pane ratio stays between the visible min and max", () => {
  assert.equal(clampComparisonPaneRatio(0.5), 0.5);
  assert.equal(clampComparisonPaneRatio(0), MIN_COMPARISON_PANE_RATIO);
  assert.equal(clampComparisonPaneRatio(1), 1 - MIN_COMPARISON_PANE_RATIO);
  assert.equal(clampComparisonPaneRatio(Number.NaN), DEFAULT_COMPARISON_PANE_RATIO);
});

test("dragging maps the pointer to the left-pane share of the host", () => {
  const rect = { left: 100, width: 400 };
  assert.equal(comparisonPaneRatioFromClientX(300, rect), 0.5);
  assert.equal(comparisonPaneRatioFromClientX(180, rect), MIN_COMPARISON_PANE_RATIO);
  assert.equal(comparisonPaneRatioFromClientX(420, rect), 0.8);
  assert.equal(comparisonPaneRatioFromClientX(300, { left: 0, width: 0 }), DEFAULT_COMPARISON_PANE_RATIO);
});

test("keyboard nudges the split and Home restores the even split", () => {
  assert.equal(comparisonPaneRatioFromKey(0.5, "ArrowRight"), 0.52);
  assert.equal(comparisonPaneRatioFromKey(0.5, "ArrowLeft", { shift: true }), 0.4);
  assert.equal(comparisonPaneRatioFromKey(0.7, "Home"), DEFAULT_COMPARISON_PANE_RATIO);
  assert.equal(comparisonPaneRatioFromKey(0.5, "ArrowUp"), 0.5);
});

test("grid and overlay styles stay aligned to the same ratio", () => {
  assert.deepEqual(comparisonSplitGridStyle(0.7), {
    gridTemplateColumns: "minmax(0, 0.7fr) minmax(0, 0.3fr)",
  });
  assert.deepEqual(comparisonPaneResizerStyle(0.7), {
    left: "calc(70% - 3.5px)",
  });
});
