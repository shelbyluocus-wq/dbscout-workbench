import test from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_IMPORT_COMPARISON_DETAIL_LIMIT,
  appendBatchImportComparisonRows,
  comparisonRowsForChunk,
  createBatchImportComparison,
} from "./composables/batchImportComparison.js";

test("batch import comparison maps backend outcomes to Excel rows", () => {
  const sheet = {
    sheetName: "player",
    workbookSheetName: "player",
    targetTableName: "player",
  };
  const chunk = [
    { row: 2, draft: { id: "1", name: "Ada 2" } },
    { row: 3, draft: { id: "2", name: "Bob" } },
    { row: 4, draft: { id: "", name: "Broken" } },
  ];
  const rows = comparisonRowsForChunk(sheet, chunk, {
    outcomes: [
      {
        index: 0,
        status: "updated",
        preview: {
          identity: { id: "1" },
          changes: [{ columnName: "name", oldValue: "Ada", newValue: "Ada 2" }],
        },
      },
      { index: 1, status: "unchanged" },
      { index: 2, status: "error" },
    ],
    errors: [{ index: 2, columnName: "id", error: "字段 id 不能为空" }],
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].row, 2);
  assert.equal(rows[0].status, "updated");
  assert.equal(rows[1].row, 4);
  assert.equal(rows[1].status, "error");
  assert.equal(rows[1].value, "");
});

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
