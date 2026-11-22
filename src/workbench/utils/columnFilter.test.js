import test from "node:test";
import assert from "node:assert/strict";
import {
  collectLocalDistinctValues,
  formatColumnFilterChip,
  getColumnFilter,
  hasActiveColumnFilters,
  matchesColumnFilterRow,
  normalizeColumnFilter,
  removeColumnFilter,
  upsertColumnFilter,
} from "./columnFilter.js";

test("normalizeColumnFilter drops empty rules and deduplicates values", () => {
  assert.equal(normalizeColumnFilter(null), null);
  assert.equal(normalizeColumnFilter({ column: "kind", values: [], operator: "", value: "" }), null);
  assert.equal(normalizeColumnFilter({ column: "kind", operator: "gt", value: "" }), null);

  assert.deepEqual(
    normalizeColumnFilter({ column: "kind", values: ["1", "2", "1"], includeNull: true }),
    { column: "kind", values: ["1", "2"], includeNull: true, operator: "", value: "" },
  );
  assert.deepEqual(
    normalizeColumnFilter({ column: "note", operator: "isEmpty", value: "ignored" }),
    { column: "note", values: [], includeNull: false, operator: "isEmpty", value: "" },
  );
});

test("upsertColumnFilter and removeColumnFilter manage per-column rules case-insensitively", () => {
  let filters = upsertColumnFilter([], { column: "Kind", values: ["1"] });
  filters = upsertColumnFilter(filters, { column: "Level", operator: "gte", value: "10" });
  assert.equal(hasActiveColumnFilters(filters), true);
  assert.equal(getColumnFilter(filters, "kind")?.values[0], "1");

  filters = upsertColumnFilter(filters, { column: "kind", values: ["2", "3"] });
  assert.equal(filters.length, 2);
  assert.deepEqual(getColumnFilter(filters, "Kind")?.values, ["2", "3"]);

  filters = removeColumnFilter(filters, "KIND");
  assert.equal(filters.length, 1);
  assert.equal(filters[0].column, "Level");
});

test("matchesColumnFilterRow supports values, NULL, text and numeric comparisons", () => {
  const rowA = { kind: "2", level: "100", name: "SuperHero" };
  const rowB = { kind: "10", level: "20", name: "" };
  const rowNull = { kind: null, level: null, name: null };

  const valRule = { column: "kind", values: ["2"], includeNull: true };
  assert.equal(matchesColumnFilterRow(rowA, valRule), true);
  assert.equal(matchesColumnFilterRow(rowB, valRule), false);
  assert.equal(matchesColumnFilterRow(rowNull, valRule), true);

  const numRule = { column: "level", operator: "gt", value: "50" };
  assert.equal(matchesColumnFilterRow(rowA, numRule), true);
  assert.equal(matchesColumnFilterRow(rowB, numRule), false);
  assert.equal(matchesColumnFilterRow(rowNull, numRule), false);

  const containsRule = { column: "name", operator: "contains", value: "hero" };
  assert.equal(matchesColumnFilterRow(rowA, containsRule), true);
  assert.equal(matchesColumnFilterRow(rowB, containsRule), false);

  const emptyRule = { column: "name", operator: "isEmpty" };
  assert.equal(matchesColumnFilterRow(rowB, emptyRule), true);
  assert.equal(matchesColumnFilterRow(rowNull, emptyRule), true);
  assert.equal(matchesColumnFilterRow(rowA, emptyRule), false);
});

test("formatColumnFilterChip produces compact readable labels", () => {
  const t = (key) => ({
    "grid.columnFilter.emptyValue": "(空值)",
    "grid.columnFilter.op.contains": "包含",
    "grid.columnFilter.op.isEmpty": "为空",
  }[key] || key);

  assert.equal(formatColumnFilterChip({ column: "Kind", values: ["2"] }, t), "Kind = 2");
  assert.equal(formatColumnFilterChip({ column: "Kind", values: ["1", "2", "3", "4"] }, t), "Kind ∈ 1, 2 +2");
  assert.equal(formatColumnFilterChip({ column: "Level", operator: "gte", value: "50" }, t), "Level ≥ 50");
  assert.equal(formatColumnFilterChip({ column: "Name", operator: "contains", value: "礼包" }, t), "Name 包含 礼包");
  assert.equal(formatColumnFilterChip({ column: "Note", operator: "isEmpty" }, t), "Note 为空");
});

test("collectLocalDistinctValues sorts by frequency and lifts NULL first", () => {
  const rows = [
    { kind: "B" },
    { kind: "A" },
    { kind: "B" },
    { kind: null },
    { kind: "C" },
  ];
  const res = collectLocalDistinctValues(rows, "kind", { limit: 10 });
  assert.equal(res.truncated, false);
  assert.deepEqual(res.values, [
    { value: null, count: 1 },
    { value: "B", count: 2 },
    { value: "A", count: 1 },
    { value: "C", count: 1 },
  ]);
});
