import test from "node:test";
import assert from "node:assert/strict";
import {
  cloneGridSelection,
  createGridSelection,
  gridSelectionActualBounds,
  gridSelectionCount,
  gridSelectionIsContiguous,
  gridSelectionMask,
  isGridCellSelected,
  toggleGridSelectionCell,
} from "./gridCellSelection.js";

function position(rowIndex, columnIndex, rowKey = `row-${rowIndex}`, column = `col-${columnIndex}`) {
  return { rowIndex, columnIndex, rowKey, column };
}

test("creates and clones a rectangular grid selection", () => {
  const selection = createGridSelection("tab-1", position(1, 1), position(3, 4));
  const cloned = cloneGridSelection(selection);

  assert.equal(gridSelectionCount(selection), 12);
  assert.equal(gridSelectionIsContiguous(selection), true);
  assert.deepEqual(gridSelectionActualBounds(selection), { top: 1, bottom: 3, left: 1, right: 4 });
  assert.deepEqual(cloned, selection);
  assert.notEqual(cloned.anchor, selection.anchor);
  assert.notEqual(cloned.toggledCells, selection.toggledCells);
});

test("ctrl-style toggles add and remove cells outside a base range", () => {
  const base = createGridSelection("tab-1", position(0, 0));
  const added = toggleGridSelectionCell(base, "tab-1", position(2, 2));

  assert.equal(added.selected, true);
  assert.equal(gridSelectionCount(added.selection), 2);
  assert.equal(isGridCellSelected(added.selection, 0, 0), true);
  assert.equal(isGridCellSelected(added.selection, 2, 2), true);
  assert.deepEqual(gridSelectionActualBounds(added.selection), { top: 0, bottom: 2, left: 0, right: 2 });

  const removed = toggleGridSelectionCell(added.selection, "tab-1", position(2, 2));
  assert.equal(removed.selected, false);
  assert.equal(gridSelectionCount(removed.selection), 1);
  assert.deepEqual(gridSelectionActualBounds(removed.selection), { top: 0, bottom: 0, left: 0, right: 0 });
});

test("ctrl-style toggle can carve and restore a hole inside a rectangle", () => {
  const base = createGridSelection("tab-1", position(0, 0), position(2, 2));
  const carved = toggleGridSelectionCell(base, "tab-1", position(1, 1));

  assert.equal(carved.selected, false);
  assert.equal(gridSelectionCount(carved.selection), 8);
  assert.equal(gridSelectionIsContiguous(carved.selection), false);
  assert.equal(isGridCellSelected(carved.selection, 1, 1), false);
  assert.deepEqual(gridSelectionMask(carved.selection), [
    [true, true, true],
    [true, false, true],
    [true, true, true],
  ]);

  const restored = toggleGridSelectionCell(carved.selection, "tab-1", position(1, 1));
  assert.equal(restored.selected, true);
  assert.equal(gridSelectionCount(restored.selection), 9);
  assert.equal(gridSelectionIsContiguous(restored.selection), true);
});

test("removing the base cell promotes the actual bounds to remaining extras", () => {
  let selection = createGridSelection("tab-1", position(0, 0));
  selection = toggleGridSelectionCell(selection, "tab-1", position(5, 3)).selection;
  const removedBase = toggleGridSelectionCell(selection, "tab-1", position(0, 0));

  assert.equal(removedBase.selected, false);
  assert.equal(gridSelectionCount(removedBase.selection), 1);
  assert.deepEqual(gridSelectionActualBounds(removedBase.selection), { top: 5, bottom: 5, left: 3, right: 3 });
  assert.deepEqual(gridSelectionMask(removedBase.selection), [[true]]);
});

test("toggling the last selected cell clears the selection", () => {
  const base = createGridSelection("tab-1", position(0, 0));
  const result = toggleGridSelectionCell(base, "tab-1", position(0, 0));

  assert.equal(result.selected, false);
  assert.equal(result.selection, null);
});
