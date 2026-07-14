import test from "node:test";
import assert from "node:assert/strict";

import { useFreezePanes } from "../composables/useFreezePanes.js";
import { applyResolvedFreeze, resolveFreezeTarget } from "./freezeSelection.js";

test("full-column selection freezes through the selected column only", () => {
  assert.deepEqual(resolveFreezeTarget({
    tabId: "tab-1",
    rowCount: 10,
    selectedRange: {
      tabId: "tab-1",
      anchor: { rowIndex: 0, columnIndex: 1 },
      focus: { rowIndex: 9, columnIndex: 1 },
    },
  }), {
    kind: "column",
    rowIndex: 9,
    columnIndex: 1,
    freezeRowStart: 0,
    freezeRows: 0,
    freezeColumns: 2,
  });
});

test("multi-column selection freezes through the rightmost selected column", () => {
  assert.deepEqual(resolveFreezeTarget({
    tabId: "tab-1",
    rowCount: 10,
    selectedRange: {
      tabId: "tab-1",
      anchor: { rowIndex: 9, columnIndex: 3 },
      focus: { rowIndex: 0, columnIndex: 1 },
    },
  }), {
    kind: "column",
    rowIndex: 0,
    columnIndex: 1,
    freezeRowStart: 0,
    freezeRows: 0,
    freezeColumns: 4,
  });
});

test("cell selection freezes through the active row and column", () => {
  assert.deepEqual(resolveFreezeTarget({
    tabId: "tab-1",
    rowCount: 10,
    selectedRange: {
      tabId: "tab-1",
      anchor: { rowIndex: 2, columnIndex: 3 },
      focus: { rowIndex: 2, columnIndex: 3 },
    },
  }), {
    kind: "cell",
    rowIndex: 2,
    columnIndex: 3,
    freezeRowStart: 2,
    freezeRows: 1,
    freezeColumns: 4,
  });
});

test("missing, empty, or stale selection has no freeze target", () => {
  assert.equal(resolveFreezeTarget({ tabId: "tab-1", rowCount: 10, selectedRange: null }), null);
  assert.equal(resolveFreezeTarget({
    tabId: "tab-1",
    rowCount: 0,
    selectedRange: {
      tabId: "tab-1",
      anchor: { rowIndex: 0, columnIndex: 0 },
      focus: { rowIndex: 0, columnIndex: 0 },
    },
  }), null);
  assert.equal(resolveFreezeTarget({
    tabId: "tab-1",
    rowCount: 10,
    selectedRange: { tabId: "tab-2", anchor: {}, focus: {} },
  }), null);
});

test("resolved freeze applies atomically while a missing target preserves the current freeze", () => {
  const freezePanes = useFreezePanes();
  const tab = { frozenRowCount: 1, frozenColumnCount: 2 };

  assert.equal(applyResolvedFreeze({ freezePanes, tab, target: null }), false);
  assert.deepEqual(tab, { frozenRowCount: 1, frozenColumnCount: 2 });

  assert.equal(applyResolvedFreeze({
    freezePanes,
    tab,
    target: { freezeRowStart: 523, freezeRows: 1, freezeColumns: 4 },
  }), true);
  assert.deepEqual(tab, { frozenRowStart: 523, frozenRowCount: 1, frozenColumnCount: 4 });
  assert.deepEqual(freezePanes.frozenRowRangeOf(tab, 1000), { start: 523, count: 1, end: 524 });
});

test("freeze rows leave part of the current viewport scrollable", () => {
  const freezePanes = useFreezePanes();
  const tab = { frozenRowCount: 0, frozenColumnCount: 0, rowHeight: 28, fieldCommentHeight: 32 };

  assert.equal(freezePanes.maxFrozenRowsForViewport(tab, 612), 13);
  assert.equal(applyResolvedFreeze({
    freezePanes,
    tab,
    target: { freezeRows: 1000, freezeColumns: 0 },
    viewportHeight: 612,
  }), true);
  assert.deepEqual(tab, { frozenRowStart: 0, frozenRowCount: 13, frozenColumnCount: 0, rowHeight: 28, fieldCommentHeight: 32 });
});

test("frozen rows stay below the expanded or collapsed field comment band", () => {
  const freezePanes = useFreezePanes();

  assert.equal(freezePanes.fieldCommentBandHeight({ fieldCommentsExpanded: true }), 32);
  assert.equal(freezePanes.frozenRowTopOffset({ fieldCommentsExpanded: true }, 0), 60);
  assert.equal(freezePanes.fieldCommentBandHeight({ fieldCommentsExpanded: false }), 18);
  assert.equal(freezePanes.frozenRowTopOffset({ fieldCommentsExpanded: false }, 2), 102);
  assert.equal(freezePanes.frozenRowTopOffset({ fieldCommentsExpanded: true, fieldCommentHeight: 44, rowHeight: 36 }, 2), 144);
});
