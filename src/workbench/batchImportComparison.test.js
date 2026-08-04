import test from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_IMPORT_COMPARISON_DETAIL_LIMIT,
  appendBatchImportComparisonRows,
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
