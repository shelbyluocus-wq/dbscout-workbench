import test from "node:test";
import assert from "node:assert/strict";

import { EXCEL_CELL_TEXT_LIMIT, clampCellValue, rowToClampedCells } from "./utils/xlsxLimit.js";

test("EXCEL_CELL_TEXT_LIMIT is the documented Excel per-cell cap", () => {
  assert.equal(EXCEL_CELL_TEXT_LIMIT, 32767);
});

test("clampCellValue truncates strings longer than the Excel limit", () => {
  const oversized = "x".repeat(EXCEL_CELL_TEXT_LIMIT + 100);
  const clamped = clampCellValue(oversized);
  assert.equal(typeof clamped, "string");
  assert.equal(clamped.length, EXCEL_CELL_TEXT_LIMIT);
  assert.equal(clamped, oversized.slice(0, EXCEL_CELL_TEXT_LIMIT));
});

test("clampCellValue leaves strings at or below the limit untouched", () => {
  assert.equal(clampCellValue(""), "");
  assert.equal(clampCellValue("short"), "short");
  const exact = "y".repeat(EXCEL_CELL_TEXT_LIMIT);
  assert.equal(clampCellValue(exact), exact);
  assert.equal(clampCellValue(exact).length, EXCEL_CELL_TEXT_LIMIT);
});

test("clampCellValue passes non-string values through unchanged", () => {
  // Numbers, booleans, null, undefined cannot trip the string-length limit and
  // must not be coerced into strings (SheetJS writes them as typed cells).
  assert.equal(clampCellValue(12345), 12345);
  assert.equal(clampCellValue(0), 0);
  assert.equal(clampCellValue(true), true);
  assert.equal(clampCellValue(false), false);
  assert.equal(clampCellValue(null), null);
  assert.equal(clampCellValue(undefined), undefined);
});

test("rowToClampedCells aligns values to the header and clamps each cell", () => {
  const header = ["id", "payload"];
  const row = {
    id: 7,
    payload: "z".repeat(EXCEL_CELL_TEXT_LIMIT + 50),
    ignored: "not in header",
  };

  const cells = rowToClampedCells(row, header);

  assert.deepEqual(cells.length, 2);
  assert.equal(cells[0], 7); // number preserved
  assert.equal(cells[1].length, EXCEL_CELL_TEXT_LIMIT); // string truncated
});

test("rowToClampedCells treats missing columns as empty string", () => {
  const cells = rowToClampedCells({ id: 1 }, ["id", "missing"]);
  assert.deepEqual(cells, [1, ""]);
});
