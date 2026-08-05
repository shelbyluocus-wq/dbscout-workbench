import test from "node:test";
import assert from "node:assert/strict";
import { effectScope, nextTick, watchEffect } from "vue";

import {
  AUTOFIT_LONG_VALUE_PREVIEW_WIDTH,
  AUTOFIT_SHORT_VALUE_MAX_EXTRA_WIDTH,
  ROW_INDEX_WIDTH,
} from "./constants.js";
import { useColumnResize } from "./composables/useColumnResize.js";

const columns = [
  { column_name: "id" },
  { column_name: "name" },
  { column_name: "note" },
];

function gridWrapWithColumnSpace(px) {
  return { clientWidth: ROW_INDEX_WIDTH + px };
}

test("autoFitColumns fills the first table view before manual resizing", () => {
  const resize = useColumnResize();

  resize.autoFitColumns(gridWrapWithColumnSpace(300), "tab-1", columns);

  assert.equal(resize.getColumnWidth("tab-1", "id"), 100);
  assert.equal(resize.getColumnWidth("tab-1", "name"), 100);
  assert.equal(resize.getColumnWidth("tab-1", "note"), 100);
});

test("autoFitColumns preserves existing column widths after one column is resized manually", () => {
  const resize = useColumnResize();

  resize.autoFitColumns(gridWrapWithColumnSpace(300), "tab-1", columns);
  resize.setColumnWidth("tab-1", "name", 160);
  resize.markManual("tab-1", "name");
  resize.autoFitColumns(gridWrapWithColumnSpace(300), "tab-1", columns);

  assert.equal(resize.getColumnWidth("tab-1", "id"), 100);
  assert.equal(resize.getColumnWidth("tab-1", "name"), 160);
  assert.equal(resize.getColumnWidth("tab-1", "note"), 100);
});

test("autoFitColumns triggers the first rendered table to pick up computed widths", async () => {
  const resize = useColumnResize();
  const rendered = [];
  const scope = effectScope();

  scope.run(() => {
    watchEffect(() => {
      rendered.push(columns.map((column) => resize.getColumnWidth("tab-1", column.column_name)));
    });
  });

  resize.autoFitColumns(gridWrapWithColumnSpace(300), "tab-1", columns);
  await nextTick();
  scope.stop();

  assert.deepEqual(rendered.at(-1), [100, 100, 100]);
});

test("autoFitColumns keeps short sampled identifier columns compact", () => {
  const resize = useColumnResize();
  const sampledRows = [
    { id: 1, name: "Iron Sword", note: "starter item" },
    { id: 25, name: "Silver Bow", note: "quest reward" },
    { id: 308, name: "Crystal Shield", note: "rare drop" },
  ];

  resize.autoFitColumns(gridWrapWithColumnSpace(600), "tab-1", columns, sampledRows);

  assert.equal(resize.getColumnWidth("tab-1", "id"), 70);
  assert.ok(resize.getColumnWidth("tab-1", "name") > resize.getColumnWidth("tab-1", "id"));
  assert.ok(resize.getColumnWidth("tab-1", "note") > resize.getColumnWidth("tab-1", "id"));
});

test("autoFitColumns caps a very long sampled value at a useful preview width", () => {
  const resize = useColumnResize();
  const contentColumns = [
    { column_name: "id" },
    { column_name: "script_blob" },
  ];
  const sampledRows = [
    {
      id: 1,
      script_blob: "function calculateReward(playerState, battleContext, seasonalModifiers) { return JSON.stringify({ playerState, battleContext, seasonalModifiers }); }",
    },
  ];

  resize.autoFitColumns(gridWrapWithColumnSpace(700), "tab-1", contentColumns, sampledRows);

  assert.equal(resize.getColumnWidth("tab-1", "id"), 70);
  assert.equal(resize.getColumnWidth("tab-1", "script_blob"), AUTOFIT_LONG_VALUE_PREVIEW_WIDTH);
});

test("autoFitColumns does not pour mixed-table slack into the only short text column", () => {
  const resize = useColumnResize();
  const mixedColumns = [
    { column_name: "ID" },
    { column_name: "Name" },
    { column_name: "LvlMax" },
    { column_name: "AddAttrFunc" },
    { column_name: "LvlUpCostFunc" },
    { column_name: "LvlUpNeedPFunc" },
    { column_name: "LvlUpNeedMainFunc" },
    { column_name: "LvlScore" },
  ];
  const longFunction = "function (Lvl) { var Target = Math.max(1, Lvl); return Target * 100; }";
  const sampledRows = [{
    ID: 1,
    Name: "法阵核心",
    LvlMax: 100,
    AddAttrFunc: longFunction,
    LvlUpCostFunc: longFunction,
    LvlUpNeedPFunc: longFunction,
    LvlUpNeedMainFunc: longFunction,
    LvlScore: 100,
  }];

  resize.autoFitColumns(gridWrapWithColumnSpace(1250), "tab-1", mixedColumns, sampledRows);

  const nameWidth = resize.getColumnWidth("tab-1", "Name");
  const functionWidths = mixedColumns
    .filter((column) => column.column_name.endsWith("Func"))
    .map((column) => resize.getColumnWidth("tab-1", column.column_name));
  const totalWidth = mixedColumns.reduce((total, column) => {
    return total + resize.getColumnWidth("tab-1", column.column_name);
  }, 0);

  assert.equal(nameWidth, 78 + AUTOFIT_SHORT_VALUE_MAX_EXTRA_WIDTH);
  assert.ok(functionWidths.every((width) => width > nameWidth));
  assert.ok(totalWidth >= 1248 && totalWidth <= 1252);
});
