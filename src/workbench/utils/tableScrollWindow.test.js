import test from "node:test";
import assert from "node:assert/strict";

import {
  distanceToTableWindowStart,
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
