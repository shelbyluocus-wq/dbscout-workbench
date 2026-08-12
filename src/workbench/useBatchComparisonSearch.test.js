import test from "node:test";
import assert from "node:assert/strict";
import {
  comparisonCellSearchText,
  comparisonSearchColumns,
  findBatchComparisonSearchMatches,
  nextBatchComparisonSearchIndex,
} from "./composables/useBatchComparisonSearch.js";

const columns = [
  { name: "name", primaryKey: false },
  { name: "id", primaryKey: true },
  { name: "note", primaryKey: false },
];

const rows = [
  {
    id: "row-1",
    status: "updated",
    after: { id: 1, name: "Alpha Hero", note: "new" },
    before: { id: 1, name: "Alpha Hero", note: "old" },
  },
  {
    id: "row-2",
    status: "updated",
    after: { id: 2, name: "Beta", note: "ALPHA trail" },
    before: { id: 2, name: "Beta", note: "kept" },
  },
  {
    id: "row-error",
    status: "error",
    error: "Alpha should not be searched",
    after: null,
    before: null,
  },
];

test("comparison search counts the same row and field once across both sides", () => {
  const matches = findBatchComparisonSearchMatches(rows, columns, "Alpha Hero", {
    mode: "continuous",
    showPrimaryKeys: true,
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].row, rows[0]);
  assert.equal(matches[0].columnName, "name");
  assert.equal(matches[0].after.matched, true);
  assert.equal(matches[0].before.matched, true);
});

test("comparison search uses displayed row and column order and skips error text", () => {
  const matches = findBatchComparisonSearchMatches(rows, columns, "alpha", {
    mode: "continuous",
    showPrimaryKeys: true,
  });

  assert.deepEqual(
    matches.map((match) => [match.row.id, match.columnName]),
    [["row-1", "name"], ["row-2", "note"]],
  );
  assert.deepEqual(comparisonSearchColumns(columns, true).map((column) => column.name), ["id", "name", "note"]);
});

test("hidden primary keys do not participate in comparison search", () => {
  assert.equal(
    findBatchComparisonSearchMatches(rows, columns, "2", {
      mode: "exact",
      showPrimaryKeys: false,
    }).length,
    0,
  );
  assert.deepEqual(comparisonSearchColumns(columns, false).map((column) => column.name), ["name", "note"]);
});

test("comparison search keeps exact, continuous and fuzzy semantics aligned with table search", () => {
  assert.equal(findBatchComparisonSearchMatches(rows, columns, "Alpha Hero", { mode: "exact" }).length, 1);
  assert.equal(findBatchComparisonSearchMatches(rows, columns, "alpha hero", { mode: "exact" }).length, 0);
  assert.equal(findBatchComparisonSearchMatches(rows, columns, "hero", { mode: "continuous" }).length, 1);
  assert.equal(findBatchComparisonSearchMatches(rows, columns, "AHa", { mode: "fuzzy" }).length > 0, true);
});

test("comparison search treats null like the visible table value", () => {
  assert.equal(comparisonCellSearchText(null), "NULL");
  assert.equal(comparisonCellSearchText(undefined), "NULL");
  assert.equal(comparisonCellSearchText(0), "0");
});

test("comparison search navigation wraps at both ends", () => {
  assert.equal(nextBatchComparisonSearchIndex(0, 3, 1), 1);
  assert.equal(nextBatchComparisonSearchIndex(2, 3, 1), 0);
  assert.equal(nextBatchComparisonSearchIndex(0, 3, -1), 2);
  assert.equal(nextBatchComparisonSearchIndex(0, 0, 1), 0);
});
