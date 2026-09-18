import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSelectionStats,
  formatStatNumber,
  parseNumericCellValue,
} from "./selectionStats.js";

test("parseNumericCellValue accepts plain numbers and numeric strings", () => {
  assert.equal(parseNumericCellValue(12), 12);
  assert.equal(parseNumericCellValue(-3.5), -3.5);
  assert.equal(parseNumericCellValue("  8  "), 8);
  assert.equal(parseNumericCellValue(".5"), 0.5);
  assert.equal(parseNumericCellValue("1e3"), 1000);
});

test("parseNumericCellValue rejects empty, text, and NULL-like values", () => {
  assert.equal(parseNumericCellValue(null), null);
  assert.equal(parseNumericCellValue(undefined), null);
  assert.equal(parseNumericCellValue(""), null);
  assert.equal(parseNumericCellValue("   "), null);
  assert.equal(parseNumericCellValue("NULL"), null);
  assert.equal(parseNumericCellValue("12px"), null);
  assert.equal(parseNumericCellValue(true), null);
  assert.equal(parseNumericCellValue(Number.NaN), null);
});

test("formatStatNumber keeps integers clean and avoids float noise", () => {
  assert.equal(formatStatNumber(60), "60");
  assert.equal(formatStatNumber(0.1 + 0.2), "0.3");
  assert.equal(formatStatNumber(-0), "0");
});

test("buildSelectionStats returns null when nothing is selected", () => {
  assert.equal(buildSelectionStats([]), null);
  assert.equal(buildSelectionStats(null), null);
});

test("buildSelectionStats shows count only when the selection has no numbers", () => {
  const stats = buildSelectionStats(["奥尔夫", "", "NULL", null]);

  assert.equal(stats.count, 4);
  assert.equal(stats.numericCount, 0);
  assert.equal(stats.sum, 0);
  assert.equal(stats.average, null);
  assert.deepEqual(stats.items, [
    { key: "count", label: "计数", text: "4" },
  ]);
});

test("buildSelectionStats reports average, count, and sum like a spreadsheet status bar", () => {
  const stats = buildSelectionStats([10, "20", "", "备注", 30]);

  assert.equal(stats.count, 5);
  assert.equal(stats.numericCount, 3);
  assert.equal(stats.sum, 60);
  assert.equal(stats.average, 20);
  assert.deepEqual(stats.items, [
    { key: "average", label: "平均值", text: "20" },
    { key: "count", label: "计数", text: "5" },
    { key: "sum", label: "求和", text: "60" },
  ]);
});
