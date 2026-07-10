import test from "node:test";
import assert from "node:assert/strict";

const visualRowsModule = await import("./visualRows.js").catch(() => ({}));
const { createVisualRowModel } = visualRowsModule;

function makeModel({ dataCount = 3, insertRows = [], reads = null } = {}) {
  const rows = Array.from({ length: dataCount }, (_, index) => ({ id: `data-${index}` }));
  return createVisualRowModel({
    dataRowCount: rows.length,
    dataRowAt(index) {
      if (reads) reads.push(index);
      return rows[index];
    },
    insertRows,
    makeInsertRow(insertRow) {
      return { id: `insert-${insertRow.id}` };
    },
  });
}

function entryIds(model) {
  return model.map((entry) => entry.row.id);
}

test("visual rows preserve anchored and trailing draft order without copying data rows", () => {
  assert.equal(typeof createVisualRowModel, "function", "visualRows module is unavailable");
  const model = makeModel({
    insertRows: [
      { id: "a", anchorIndex: 0 },
      { id: "b", anchorIndex: 2 },
      { id: "c", anchorIndex: null },
      { id: "d", anchorIndex: 99 },
    ],
  });

  assert.equal(model.length, 7);
  assert.deepEqual(entryIds(model), [
    "insert-a",
    "data-0",
    "data-1",
    "insert-b",
    "data-2",
    "insert-c",
    "insert-d",
  ]);
  assert.equal(model.at(-1).rowId, "d");
});

test("visual rows translate data and insert indexes in both directions", () => {
  assert.equal(typeof createVisualRowModel, "function", "visualRows module is unavailable");
  const model = makeModel({
    insertRows: [
      { id: "a", anchorIndex: 1 },
      { id: "b", anchorIndex: 1 },
      { id: "tail", anchorIndex: null },
    ],
  });

  assert.equal(model.visualIndexOfData(0), 0);
  assert.equal(model.visualIndexOfData(1), 3);
  assert.equal(model.visualIndexOfData(2), 4);
  assert.equal(model.visualIndexOfInsert("a"), 1);
  assert.equal(model.visualIndexOfInsert("b"), 2);
  assert.equal(model.visualIndexOfInsert("tail"), 5);
  assert.deepEqual(model.at(3), { type: "data", dataIndex: 1, row: { id: "data-1" } });
  assert.equal(model.at(1).rowId, "a");
});

test("a rebuilt visual model reflects inserted and removed drafts", () => {
  assert.equal(typeof createVisualRowModel, "function", "visualRows module is unavailable");
  const first = makeModel({ insertRows: [{ id: "a", anchorIndex: 1 }] });
  const second = makeModel({ insertRows: [{ id: "b", anchorIndex: 0 }] });

  assert.equal(first.visualIndexOfInsert("a"), 1);
  assert.equal(first.visualIndexOfInsert("b"), -1);
  assert.equal(second.visualIndexOfInsert("a"), -1);
  assert.equal(second.visualIndexOfInsert("b"), 0);
  assert.deepEqual(entryIds(second), ["insert-b", "data-0", "data-1", "data-2"]);
});

test("range traversal reads only addressed data rows", () => {
  assert.equal(typeof createVisualRowModel, "function", "visualRows module is unavailable");
  const reads = [];
  const model = makeModel({
    dataCount: 100_000,
    insertRows: [{ id: "a", anchorIndex: 50_000 }],
    reads,
  });

  const entries = [...model.iterateRange(49_999, 50_002)];

  assert.deepEqual(entries.map((entry) => entry.type), ["data", "insert", "data"]);
  assert.deepEqual(reads, [49_999, 50_000]);
});
