import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultHomeColumnLayout,
  fittedFillWidth,
  formatDataSize,
  homeColumnDefinition,
  homeGridTemplateColumns,
  homeTableWidthCss,
  loadHomeColumnLayout,
  moveHomeColumn,
  normalizeHomeColumnLayout,
} from "./homeColumnLayout.js";

test("homepage columns default to name size modified comment", () => {
  assert.deepEqual(defaultHomeColumnLayout().map((column) => column.key), ["name", "size", "modified", "comment"]);
});

test("homepage column layout validates widths and restores missing columns", () => {
  const layout = normalizeHomeColumnLayout([{ key: "comment", width: 9999 }, { key: "name", width: 20 }]);
  assert.deepEqual(layout.map((column) => column.key), ["comment", "name", "size", "modified"]);
  assert.equal(layout[0].width, 520);
  assert.equal(layout[1].width, 160);
  assert.deepEqual(loadHomeColumnLayout({ getItem: () => "broken" }), defaultHomeColumnLayout());
});

test("homepage columns reorder without dropping metadata", () => {
  const moved = moveHomeColumn(defaultHomeColumnLayout(), "comment", "name", "before");
  assert.deepEqual(moved.map((column) => column.key), ["comment", "name", "size", "modified"]);
});

test("homepage layout removes the retired field-count column from saved preferences", () => {
  const layout = normalizeHomeColumnLayout([
    { key: "name", width: 240 },
    { key: "fields", width: 92 },
    { key: "comment", width: 280 },
  ]);

  assert.deepEqual(layout.map((column) => column.key), ["name", "comment", "size", "modified"]);
});

test("data size formatting covers raw bytes through terabytes", () => {
  assert.equal(formatDataSize(null), "—");
  assert.equal(formatDataSize(512), "512 B");
  assert.equal(formatDataSize(1536), "1.50 KB");
  assert.equal(formatDataSize(1024 ** 3), "1.00 GB");
});

test("numeric home columns align to the end and the comment column fills spare width", () => {
  assert.equal(homeColumnDefinition("size").align, "end");
  assert.equal(homeColumnDefinition("name").align, "start");
  const sized = [
    { key: "name", width: 240 },
    { key: "comment", width: 300 },
    { key: "size", width: 116 },
  ];
  assert.equal(homeGridTemplateColumns(sized), "240px minmax(300px, 1fr) 116px");
  assert.equal(homeTableWidthCss(sized), "max(100%, 656px)");
});

test("an automatic fill column shrinks to fit the pane but keeps its minimum", () => {
  assert.equal(fittedFillWidth({ preferred: 420, minWidth: 180, available: 900, otherColumnsWidth: 532 }), 368);
  assert.equal(fittedFillWidth({ preferred: 300, minWidth: 180, available: 1400, otherColumnsWidth: 532 }), 300);
  assert.equal(fittedFillWidth({ preferred: 420, minWidth: 180, available: 600, otherColumnsWidth: 532 }), 180);
  assert.equal(fittedFillWidth({ preferred: 420, minWidth: 180, available: 0, otherColumnsWidth: 532 }), 420);
});
