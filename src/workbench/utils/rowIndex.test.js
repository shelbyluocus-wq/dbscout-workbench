import test from "node:test";
import assert from "node:assert/strict";

import {
  appendTabRows,
  ensureTabRowStore,
  invalidateTabRows,
  mutateTabRow,
  replaceTabRows,
} from "../rowStore.js";

const rowIndexModule = await import("./rowIndex.js").catch(() => ({}));
const { createRowIndex } = rowIndexModule;

function makeTab(rows = Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: `row-${index}` }))) {
  const tab = {
    columns: [{ column_name: "id" }, { column_name: "name" }],
    primaryKeys: ["id"],
    rows,
  };
  ensureTabRowStore(tab);
  return tab;
}

function countingKeyBuilder(count) {
  return (_tab, row) => {
    count.calls += 1;
    return `id=${row.id}`;
  };
}

test("repeated row-key lookups reuse one index build for a data generation", () => {
  assert.equal(typeof createRowIndex, "function", "rowIndex module is unavailable");
  const tab = makeTab(Array.from({ length: 10_000 }, (_, index) => ({ id: String(index) })));
  const count = { calls: 0 };
  const index = createRowIndex(tab, { buildRowKey: countingKeyBuilder(count) });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(index.indexOfKey("id=9999"), 9999);
  }

  assert.equal(count.calls, 10_000);
  assert.deepEqual(index.rowForKey("id=7"), { id: "7" });
  assert.equal(index.keyAt(7), "id=7");
});

test("row index rebuilds after append mutation replace and explicit invalidation", () => {
  assert.equal(typeof createRowIndex, "function", "rowIndex module is unavailable");
  const tab = makeTab([{ id: "1", name: "one" }, { id: "2", name: "two" }]);
  const count = { calls: 0 };
  const index = createRowIndex(tab, { buildRowKey: countingKeyBuilder(count) });

  assert.equal(index.indexOfKey("id=2"), 1);
  assert.equal(count.calls, 2);

  appendTabRows(tab, [{ id: "3", name: "three" }]);
  assert.equal(index.indexOfKey("id=3"), 2);
  assert.equal(count.calls, 5);

  mutateTabRow(tab, 1, (row) => ({ ...row, id: "20" }));
  assert.equal(index.indexOfKey("id=2"), -1);
  assert.equal(index.indexOfKey("id=20"), 1);
  assert.equal(count.calls, 8);

  replaceTabRows(tab, [{ id: "9", name: "nine" }]);
  assert.equal(index.indexOfKey("id=9"), 0);
  assert.equal(count.calls, 9);

  invalidateTabRows(tab);
  assert.equal(index.indexOfKey("id=9"), 0);
  assert.equal(count.calls, 10);
});

test("row index validates row count and primary-key shape even without a version bump", () => {
  assert.equal(typeof createRowIndex, "function", "rowIndex module is unavailable");
  const tab = makeTab([{ id: "1", name: "one" }]);
  const count = { calls: 0 };
  const index = createRowIndex(tab, { buildRowKey: countingKeyBuilder(count) });

  assert.equal(index.indexOfKey("id=1"), 0);
  tab.rows.push({ id: "2", name: "two" });
  assert.equal(index.indexOfKey("id=2"), 1);
  tab.primaryKeys = ["name"];
  assert.equal(index.indexOfKey("id=2"), 1);

  assert.equal(count.calls, 1 + 2 + 2);
});

test("row index exposes primary-key signatures from the same cached pass", () => {
  assert.equal(typeof createRowIndex, "function", "rowIndex module is unavailable");
  const tab = makeTab([{ id: "1", name: "one" }, { id: "2", name: "two" }]);
  const count = { calls: 0 };
  const index = createRowIndex(tab, { buildRowKey: countingKeyBuilder(count) });

  assert.deepEqual([...index.primaryKeySignatures()], ["id=1", "id=2"]);
  assert.equal(index.hasPrimaryKeySignature("id=2"), true);
  assert.equal(index.hasPrimaryKeySignature("id=3"), false);
  assert.deepEqual(index.keys(), ["id=1", "id=2"]);
  assert.equal(count.calls, 2);
});
