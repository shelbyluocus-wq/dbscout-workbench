import test from "node:test";
import assert from "node:assert/strict";

import { DenseRowStore } from "./rowStore.js";
import { applyCommittedCellToTab } from "./utils/committedCellSync.js";

function table(rows, { absoluteStart = 0 } = {}) {
  return {
    primaryKeys: ["id"],
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "name" },
    ],
    rowStore: new DenseRowStore(rows, {
      absoluteStart,
      totalLength: absoluteStart + rows.length,
    }),
  };
}

test("sequential committed-cell events synchronize a primary key and sibling field", () => {
  const tab = table([{ id: "1", name: "Alice" }], { absoluteStart: 200 });

  assert.equal(applyCommittedCellToTab(tab, {
    rowKey: "id=1",
    column: "id",
    oldValue: "1",
    newValue: "2",
  }), true);
  assert.equal(applyCommittedCellToTab(tab, {
    rowKey: "id=2",
    column: "name",
    oldValue: "Alice",
    newValue: "Alicia",
  }), true);

  assert.deepEqual(tab.rowStore.toArray(), [{ id: "2", name: "Alicia" }]);
});

test("an already-applied primary-key event is a no-op on a later loaded page", () => {
  const tab = table([{ id: "2", name: "Alice" }], { absoluteStart: 200 });

  assert.equal(applyCommittedCellToTab(tab, {
    rowKey: "id=1",
    column: "id",
    oldValue: "1",
    newValue: "2",
  }), false);
  assert.deepEqual(tab.rowStore.toArray(), [{ id: "2", name: "Alice" }]);
});

test("sibling synchronization never overwrites a newer local value", () => {
  const tab = table([{ id: "1", name: "Locally edited" }]);

  assert.equal(applyCommittedCellToTab(tab, {
    rowKey: "id=1",
    column: "name",
    oldValue: "Alice",
    newValue: "Remote edit",
  }), false);
  assert.deepEqual(tab.rowStore.toArray(), [{ id: "1", name: "Locally edited" }]);
});
