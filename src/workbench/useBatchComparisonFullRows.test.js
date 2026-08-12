import test from "node:test";
import assert from "node:assert/strict";
import {
  comparisonIdentityKey,
  consumeFullComparisonDatabaseRows,
  consumeFullComparisonInsertedRows,
  createFullComparisonCursor,
  loadFullComparisonToCompletion,
} from "./composables/useBatchComparisonFullRows.js";

function comparisonTable() {
  return {
    sheetName: "Sheet1",
    tableName: "player",
    columns: [
      { name: "id", primaryKey: true },
      { name: "name", primaryKey: false },
      { name: "note", primaryKey: false },
      { name: "score", primaryKey: false, defaultMode: "value", defaultValue: "10" },
    ],
    fullComparison: {
      primaryKeys: ["id"],
      mappedColumns: ["id", "name", "score"],
      sourceRows: [
        { row: 2, status: "unchanged", draft: { id: "1", name: "Ada" } },
        { row: 3, status: "updated", draft: { id: "2", name: "Bobby" } },
        { row: 4, status: "inserted", draft: { id: "4", name: "Dana" } },
      ],
    },
  };
}

test("complete comparison aligns database rows by primary key", () => {
  const cursor = createFullComparisonCursor(comparisonTable());
  const rows = consumeFullComparisonDatabaseRows(cursor, [
    { id: 1, name: "Ada", note: "kept" },
    { id: 2, name: "Bob", note: "kept", score: "5" },
    { id: "3", name: "Cara", note: "database only" },
  ]);

  assert.deepEqual(rows.map((row) => row.status), ["unchanged", "updated", "deleted"]);
  assert.deepEqual(rows[1].after, { id: "2", name: "Bobby", note: "kept", score: "10" });
  assert.deepEqual(rows[1].changes, [
    { columnName: "name", before: "Bob", after: "Bobby" },
    { columnName: "score", before: "5", after: "10" },
  ]);
  assert.equal(rows[2].after, null);
});

test("complete comparison appends imported rows missing from the database", () => {
  const cursor = createFullComparisonCursor(comparisonTable());
  const [inserted] = consumeFullComparisonInsertedRows(cursor, 1);

  assert.equal(inserted.status, "inserted");
  assert.equal(inserted.before, null);
  assert.deepEqual(inserted.after, { id: "4", name: "Dana", score: "10" });
  assert.equal(comparisonIdentityKey(["id"], inserted.after), '[["id","4"]]');
});

test("complete comparison search loads every remaining page before matching", async () => {
  const state = { rows: [], databaseOffset: 0, complete: false, error: "" };
  let calls = 0;
  const loadMore = async () => {
    calls += 1;
    state.rows.push({ id: calls });
    state.databaseOffset += 1;
    state.complete = calls === 3;
    return state;
  };

  const completed = await loadFullComparisonToCompletion(
    comparisonTable(),
    loadMore,
    () => state,
  );

  assert.equal(calls, 3);
  assert.equal(completed.complete, true);
  assert.deepEqual(completed.rows.map((row) => row.id), [1, 2, 3]);
});
