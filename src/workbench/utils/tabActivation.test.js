import test from "node:test";
import assert from "node:assert/strict";

import {
  captureTableTabViewState,
  readTableTabViewState,
  resetTableTabViewState,
} from "./tabActivation.js";

test("table tabs retain independent scroll and selection state", () => {
  const first = { id: "tab-1" };
  const second = { id: "tab-2" };

  captureTableTabViewState(first, {
    scrollTop: 560,
    scrollLeft: 120,
    editor: {
      selectedCell: { tabId: first.id, rowKey: "id=21", column: "name" },
      selectedRange: {
        tabId: first.id,
        anchor: { rowIndex: 20, columnIndex: 1 },
        focus: { rowIndex: 22, columnIndex: 2 },
      },
      textDraft: "Alice",
    },
  });
  captureTableTabViewState(second, { scrollTop: 84, scrollLeft: 0 });

  assert.equal(readTableTabViewState(first).scrollTop, 560);
  assert.equal(readTableTabViewState(first).scrollLeft, 120);
  assert.equal(readTableTabViewState(first).editor.selectedCell.rowKey, "id=21");
  assert.equal(readTableTabViewState(second).scrollTop, 84);
});

test("reopening a table invalidates its retained view state", () => {
  const tab = { id: "tab-1" };
  captureTableTabViewState(tab, { scrollTop: 560 });

  resetTableTabViewState(tab);

  assert.equal(readTableTabViewState(tab), null);
  assert.equal(tab.tableViewRevision, 1);
});

test("table view snapshots deeply clone sparse selection fields", () => {
  const tab = { id: "tab-1" };
  const editor = {
    selectedCell: { tabId: tab.id, rowKey: "id=3", column: "guild" },
    selectedRange: {
      tabId: tab.id,
      anchor: { rowIndex: 0, columnIndex: 0, rowKey: "id=1", column: "name" },
      focus: { rowIndex: 2, columnIndex: 2, rowKey: "id=3", column: "guild" },
      shiftAnchor: { rowIndex: 2, columnIndex: 2, rowKey: "id=3", column: "guild" },
      toggledCells: [{ rowIndex: 1, columnIndex: 1, rowKey: "id=2", column: "level" }],
    },
    textDraft: "Green",
  };

  captureTableTabViewState(tab, { editor });
  editor.selectedRange.shiftAnchor.rowIndex = 99;
  editor.selectedRange.toggledCells[0].columnIndex = 99;
  const firstRead = readTableTabViewState(tab);
  firstRead.editor.selectedRange.shiftAnchor.rowIndex = 88;
  firstRead.editor.selectedRange.toggledCells[0].columnIndex = 88;
  const secondRead = readTableTabViewState(tab);

  assert.equal(secondRead.editor.selectedRange.shiftAnchor.rowIndex, 2);
  assert.equal(secondRead.editor.selectedRange.toggledCells[0].columnIndex, 1);
});
