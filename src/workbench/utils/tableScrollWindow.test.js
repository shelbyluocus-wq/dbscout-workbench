import test from "node:test";
import assert from "node:assert/strict";

import {
  distanceToTableWindowEnd,
  distanceToTableWindowStart,
  tableScrollRowCount,
  tableWindowEndRow,
  tableWindowEndTop,
  tableWindowOffset,
  tableWindowStartTop,
} from "./tableScrollWindow.js";

test("table scroll window helpers normalize offsets and use fixed row geometry", () => {
  const tab = { rowWindowOffset: 9000 };

  assert.equal(tableWindowOffset(tab), 9000);
  assert.equal(tableWindowStartTop(tab, 28), 252000);
  assert.equal(distanceToTableWindowStart(tab, 254800, 28), 2800);
  assert.equal(distanceToTableWindowStart(tab, 250000, 28), 0);
  assert.equal(tableWindowOffset({ rowWindowOffset: -4 }), 0);
});

test("table scroll helpers reserve known rows and measure the loaded window end", () => {
  const tab = { rowWindowOffset: 0, totalRows: 10000 };

  assert.equal(tableWindowEndRow(tab, 1000), 1000);
  assert.equal(tableScrollRowCount(tab, 1000), 10000);
  assert.equal(tableWindowEndTop(tab, 1000, 28), 28000);
  assert.equal(distanceToTableWindowEnd(tab, 1000, 22400, 560, 28), 5040);
  assert.equal(distanceToTableWindowEnd(tab, 1000, 28000, 560, 28), 0);
  assert.equal(tableScrollRowCount({ rowWindowOffset: 9000, totalRows: 10000 }, 1000), 10000);
});
