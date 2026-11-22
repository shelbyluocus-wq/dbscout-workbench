import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSelectionStats,
  createSelectionStatsScan,
  indexOptimisticValuesForTable,
  statsFromTotals,
  formatStatNumber,
  parseNumericCellValue,
} from "./selectionStats.js";
import { createVisualRowModel } from "./visualRows.js";
import { gridSelectionActualBounds, gridSelectionToggleMap, isGridCellSelected, createGridSelection } from "./gridCellSelection.js";

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
  assert.equal(formatStatNumber(130558 / 565, { maxDecimals: 4 }), "231.0761");
  assert.equal(formatStatNumber(10 / 3, { maxDecimals: 4 }), "3.3333");
  assert.equal(formatStatNumber(1e-8, { maxDecimals: 4 }), "1e-8");
});

test("buildSelectionStats caps long repeating averages to 4 decimals and keeps fullText", () => {
  const stats = buildSelectionStats([1, 2, 2]);
  assert.equal(stats.items[0].key, "average");
  assert.equal(stats.items[0].text, "1.6667");
  assert.equal(stats.items[0].fullText, "1.66666666667");
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


const COLUMNS = ["id", "score", "name"];
const ROWS = Array.from({ length: 40 }, (_, index) => ({ id: String(index + 1), score: String((index % 7) * 1.5), name: `n${index}` }));
const INSERT_ROWS = [{ id: "ins-1", anchorIndex: 3, draft: { id: "", score: "100", name: "draft" } }];

function model() {
  return createVisualRowModel({
    dataRowCount: ROWS.length,
    dataRowAt: (index) => ROWS[index],
    insertRows: INSERT_ROWS,
    makeInsertRow: (row) => ({ ...row.draft }),
  });
}

function rowKeyOf(entry) {
  return entry.type === "insert" ? `__insert__:${entry.insertRow.id}` : `id=${entry.row.id}`;
}

// Reference: the previous per-cell algorithm (row key and lookup per cell).
function referenceStats(range, { overrides = [], optimistic = new Map(), tableName = "t" } = {}) {
  const bounds = gridSelectionActualBounds(range);
  const toggleKeys = new Set(gridSelectionToggleMap(range).keys());
  const visual = model();
  const values = [];
  for (let rowIndex = bounds.top; rowIndex <= bounds.bottom; rowIndex += 1) {
    const entry = visual.at(rowIndex);
    if (!entry) continue;
    for (let columnIndex = bounds.left; columnIndex <= bounds.right; columnIndex += 1) {
      if (!isGridCellSelected(range, rowIndex, columnIndex, toggleKeys)) continue;
      const column = COLUMNS[columnIndex];
      if (!column) continue;
      const rowKey = rowKeyOf(entry);
      const override = overrides.find((item) => item.rowKey === rowKey && item.column === column);
      if (override) values.push(override.value);
      else if (entry.type === "insert") values.push(entry.insertRow?.draft?.[column] ?? "");
      else {
        const key = [tableName, rowKey, column].join("\u001f");
        const pending = optimistic.has(key) ? optimistic.get(key) : null;
        values.push(pending != null ? pending : entry.row?.[column]);
      }
    }
  }
  return buildSelectionStats(values);
}

function scanStats(range, { overrides = [], optimistic = new Map(), tableName = "t", chunk = Infinity } = {}) {
  const toggles = gridSelectionToggleMap(range);
  const toggleKeys = toggles.size ? new Set(toggles.keys()) : null;
  let keyBuilds = 0;
  const scan = createSelectionStatsScan({
    bounds: gridSelectionActualBounds(range),
    isSelected: toggleKeys ? (r, c) => isGridCellSelected(range, r, c, toggleKeys) : null,
    model: model(),
    columns: COLUMNS,
    rowKeyOf: (entry) => { keyBuilds += 1; return rowKeyOf(entry); },
    overrides,
    optimistic: indexOptimisticValuesForTable(optimistic, tableName),
  });
  while (!scan.step(chunk));
  return { stats: scan.result(), keyBuilds };
}

test("selection scan matches the per-cell reference for contiguous ranges and insert rows", () => {
  const range = createGridSelection("tab", { rowIndex: 0, columnIndex: 0 }, { rowIndex: 40, columnIndex: 2 });
  const { stats, keyBuilds } = scanStats(range);
  assert.deepEqual(stats, referenceStats(range));
  assert.equal(keyBuilds, 0, "no row keys are needed without overrides or pending values");
});

test("selection scan matches the reference with toggled cells, drafts, and pending values", () => {
  const range = createGridSelection("tab", { rowIndex: 2, columnIndex: 1 }, { rowIndex: 30, columnIndex: 2 }, {
    toggledCells: [{ rowIndex: 5, columnIndex: 1 }, { rowIndex: 35, columnIndex: 0 }],
  });
  const overrides = [
    { rowKey: "id=8", column: "score", value: "999" },
    { rowKey: "id=8", column: "score", value: "1" },
    { rowKey: "__insert__:ins-1", column: "score", value: "7" },
  ];
  const optimistic = new Map([
    [["t", "id=10", "score"].join("\u001f"), "50"],
    [["t", "id=11", "score"].join("\u001f"), null],
    [["other", "id=12", "score"].join("\u001f"), "1000"],
  ]);
  const expected = referenceStats(range, { overrides, optimistic });
  const { stats, keyBuilds } = scanStats(range, { overrides, optimistic, chunk: 3 });
  assert.deepEqual(stats, expected);
  const bounds = gridSelectionActualBounds(range);
  assert.ok(keyBuilds <= bounds.bottom - bounds.top + 1, "row keys are built at most once per row");
});

test("statsFromTotals returns null for an empty selection", () => {
  assert.equal(statsFromTotals(0, 0, 0), null);
});
