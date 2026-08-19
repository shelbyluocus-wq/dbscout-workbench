import test from "node:test";
import assert from "node:assert/strict";
import { effectScope, nextTick, reactive, watchEffect } from "vue";

import {
  AUTOFIT_LONG_VALUE_PREVIEW_WIDTH,
  ROW_INDEX_WIDTH,
} from "./constants.js";
import { useColumnResize } from "./composables/useColumnResize.js";
import { useFreezePanes } from "./composables/useFreezePanes.js";
import { calculateColumnWidths } from "./utils/columnWidth.js";

const columns = [
  { column_name: "id", column_type: "int" },
  { column_name: "name", column_type: "varchar(64)" },
  { column_name: "note", column_type: "text" },
];

function gridWrapWithColumnSpace(px) {
  return { clientWidth: ROW_INDEX_WIDTH + px };
}

function tableTab(id = "tab-1", extra = {}) {
  return { id, ...extra };
}

function widthsOf(resize, tab, targetColumns = columns) {
  return Object.fromEntries(targetColumns.map((column) => [
    column.column_name,
    resize.getColumnWidth(tab, column.column_name),
  ]));
}

test("empty tables use compact type-aware widths instead of filling the viewport", () => {
  const resize = useColumnResize();
  const tab = tableTab();
  const emptyColumns = columns.slice(0, 2);

  resize.autoFitColumns(gridWrapWithColumnSpace(1000), tab, emptyColumns, []);

  assert.deepEqual(widthsOf(resize, tab, emptyColumns), { id: 88, name: 120 });
});

test("auto columns keep the same width when the viewport changes", () => {
  const resize = useColumnResize();
  const tab = tableTab();
  const rows = [{ id: 1, name: "Alpha Name", note: "x".repeat(200) }];

  resize.autoFitColumns(gridWrapWithColumnSpace(400), tab, columns, rows);
  const narrow = widthsOf(resize, tab);
  resize.setColumnWidth(tab, "name", 180);
  resize.markManual(tab, "name");
  resize.autoFitColumns(gridWrapWithColumnSpace(1600), tab, columns, rows);
  const wide = widthsOf(resize, tab);

  assert.equal(narrow.id, wide.id);
  assert.equal(wide.name, 180);
  assert.equal(narrow.note, wide.note);
  assert.equal(wide.note, AUTOFIT_LONG_VALUE_PREVIEW_WIDTH);
  assert.equal(resize.isManuallySet(tab, "name"), true);
});

test("column widths ignore leftover viewport space", () => {
  const sampleColumns = [
    { column_name: "id", column_type: "int" },
    { column_name: "note", column_type: "text" },
  ];
  const rows = [{ id: 1, note: "x".repeat(200) }];

  const narrow = calculateColumnWidths({ availableWidth: 280, columns: sampleColumns, rows });
  const wide = calculateColumnWidths({ availableWidth: 1600, columns: sampleColumns, rows });

  assert.deepEqual(narrow, wide);
  assert.equal(wide.note, AUTOFIT_LONG_VALUE_PREVIEW_WIDTH);
});

test("resetColumnWidth returns a manual column to adaptive sizing", () => {
  const resize = useColumnResize();
  const tab = tableTab();
  const rows = [{ id: 1, name: "Alpha Name", note: "x".repeat(200) }];

  resize.setColumnWidth(tab, "name", 240);
  resize.markManual(tab, "name");
  resize.autoFitColumns(gridWrapWithColumnSpace(700), tab, columns, rows);
  assert.equal(resize.getColumnWidth(tab, "name"), 240);

  resize.resetColumnWidth(tab, "name");
  resize.autoFitColumns(gridWrapWithColumnSpace(700), tab, columns, rows);

  assert.equal(resize.isManuallySet(tab, "name"), false);
  assert.ok(resize.getColumnWidth(tab, "name") < 240);
});

test("tab-owned width state survives a DataGrid composable remount", () => {
  const tab = tableTab();
  const firstGrid = useColumnResize();
  firstGrid.setColumnWidth(tab, "name", 176);
  firstGrid.markManual(tab, "name");

  const remountedGrid = useColumnResize();

  assert.equal(remountedGrid.getColumnWidth(tab, "name"), 176);
  assert.equal(remountedGrid.isManuallySet(tab, "name"), true);
});

test("autoFitColumns triggers the rendered table to pick up computed widths", async () => {
  const resize = useColumnResize();
  const tab = reactive(tableTab());
  const rendered = [];
  const scope = effectScope();

  scope.run(() => {
    watchEffect(() => {
      rendered.push(columns.map((column) => resize.getColumnWidth(tab, column.column_name)));
    });
  });

  resize.autoFitColumns(gridWrapWithColumnSpace(400), tab, columns, [{ id: 1, name: "Alpha", note: "memo" }]);
  await nextTick();
  scope.stop();

  assert.ok(rendered.at(-1).every((width) => Number.isFinite(width) && width > 0));
});

test("all-NULL samples fall back to field types", () => {
  const resize = useColumnResize();
  const tab = tableTab();
  const typedColumns = [
    { column_name: "id", column_type: "int" },
    { column_name: "created_at", column_type: "datetime" },
    { column_name: "payload", column_type: "json" },
  ];

  resize.autoFitColumns(
    gridWrapWithColumnSpace(500),
    tab,
    typedColumns,
    [{ id: null, created_at: null, payload: null }],
  );

  const widths = widthsOf(resize, tab, typedColumns);
  assert.equal(widths.id, 88);
  assert.equal(widths.created_at, 164);
  assert.ok(widths.payload >= 150 && widths.payload <= AUTOFIT_LONG_VALUE_PREVIEW_WIDTH);
});

test("ClickHouse empty values use the same type-aware width policy", () => {
  const widths = calculateColumnWidths({
    availableWidth: 100,
    columns: [
      { column_name: "event_id", column_type: "UInt64" },
      { column_name: "occurred_at", column_type: "DateTime64(3)" },
      { column_name: "attributes", column_type: "Nullable(Map(String, String))" },
    ],
    rows: [{ event_id: null, occurred_at: null, attributes: null }],
  });

  assert.deepEqual(widths, { event_id: 112, occurred_at: 164, attributes: 160 });
});

test("very long sampled values stay within the useful preview cap", () => {
  const resize = useColumnResize();
  const tab = tableTab();
  const contentColumns = [
    { column_name: "id", column_type: "int" },
    { column_name: "script_blob", column_type: "text" },
  ];
  const sampledRows = [{
    id: 1,
    script_blob: "function calculateReward(playerState, battleContext, seasonalModifiers) { return JSON.stringify({ playerState, battleContext, seasonalModifiers }); }",
  }];

  resize.autoFitColumns(gridWrapWithColumnSpace(700), tab, contentColumns, sampledRows);

  assert.equal(resize.getColumnWidth(tab, "id"), 70);
  assert.equal(resize.getColumnWidth(tab, "script_blob"), AUTOFIT_LONG_VALUE_PREVIEW_WIDTH);
});

test("frozen columns are counted once and retain their exact stored geometry", () => {
  const resize = useColumnResize();
  const plainTab = tableTab("plain");
  const frozenTab = tableTab("frozen", { frozenColumnCount: 1 });
  const rows = [{ id: 1, name: "Alpha Name", note: "short memo" }];

  resize.autoFitColumns(gridWrapWithColumnSpace(420), plainTab, columns, rows);
  resize.autoFitColumns(gridWrapWithColumnSpace(420), frozenTab, columns, rows);

  assert.deepEqual(widthsOf(resize, frozenTab), widthsOf(resize, plainTab));
  const freezePanes = useFreezePanes();
  const columnMeta = columns.map((column, columnIndex) => ({
    column,
    columnIndex,
    name: column.column_name,
  }));
  assert.equal(
    freezePanes.frozenColumnsWidth(frozenTab, columnMeta),
    resize.getColumnWidth(frozenTab, "id"),
  );
});

test("header measurement can follow the active UI font", () => {
  const measured = calculateColumnWidths({
    availableWidth: 70,
    columns: [{ column_name: "中文字段名称" }],
    rows: [],
    headerMeasureText: (text) => Array.from(text).length * 13,
  });

  assert.equal(measured["中文字段名称"], 116);
});
