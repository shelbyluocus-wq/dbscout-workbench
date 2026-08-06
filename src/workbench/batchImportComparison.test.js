import test from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_IMPORT_COMPARISON_DETAIL_LIMIT,
  appendBatchImportComparisonRows,
  comparisonRowsForReplacement,
  createBatchImportComparison,
} from "./composables/batchImportComparison.js";

test("batch import comparison keeps exact totals while capping retained details", () => {
  const comparison = createBatchImportComparison();
  const first = Array.from({ length: BATCH_IMPORT_COMPARISON_DETAIL_LIMIT }, (_, index) => ({ id: `row-${index}` }));
  const overflow = [{ id: "overflow-1" }, { id: "overflow-2" }];

  appendBatchImportComparisonRows(comparison, first);
  appendBatchImportComparisonRows(comparison, overflow);

  assert.equal(comparison.rows.length, BATCH_IMPORT_COMPARISON_DETAIL_LIMIT);
  assert.equal(comparison.detailTotal, BATCH_IMPORT_COMPARISON_DETAIL_LIMIT + 2);
  assert.equal(comparison.truncated, true);
});


test("comparison rows carry full before/after snapshots for the diff grid", () => {
  const sheet = { sheetName: "Sheet1", targetTableName: "player" };
  const drafts = [{ row: 2, draft: { id: "1", name: "Ada" } }, { row: 3, draft: { id: "2", name: "Bob" } }];
  const result = {
    outcomes: [
      {
        status: "updated",
        index: 0,
        preview: {
          identity: { id: "1" },
          changes: [{ columnName: "name", oldValue: "A", newValue: "Ada" }],
          before: { id: "1", name: "A", score: "9" },
          after: { id: "1", name: "Ada", score: "9" },
        },
      },
      {
        status: "inserted",
        index: 1,
        preview: {
          identity: { id: "2" },
          changes: [],
          after: { id: "2", name: "Bob" },
        },
      },
      {
        status: "deleted",
        preview: {
          identity: { id: "7" },
          changes: [],
          before: { id: "7", name: "Ghost" },
        },
      },
    ],
  };

  const rows = comparisonRowsForReplacement(sheet, drafts, result);
  assert.equal(rows.length, 3);

  const [updated, inserted, deleted] = rows;
  assert.deepEqual(updated.before, { id: "1", name: "A", score: "9" });
  assert.deepEqual(updated.after, { id: "1", name: "Ada", score: "9" });
  assert.equal(inserted.before, null);
  assert.deepEqual(inserted.after, { id: "2", name: "Bob" });
  assert.deepEqual(deleted.before, { id: "7", name: "Ghost" });
  assert.equal(deleted.after, null);
});

test("comparison rows tolerate previews without before/after", () => {
  const sheet = { sheetName: "Sheet1", targetTableName: "player" };
  const drafts = [{ row: 2, draft: { id: "1" } }];
  const result = {
    outcomes: [
      { status: "inserted", index: 0, preview: { identity: { id: "1" }, changes: [] } },
    ],
  };
  const [row] = comparisonRowsForReplacement(sheet, drafts, result);
  assert.equal(row.before, null);
  assert.equal(row.after, null);
});
