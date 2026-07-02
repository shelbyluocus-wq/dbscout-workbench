import test from "node:test";
import assert from "node:assert/strict";

import { computeTableWindow } from "./useSidebarVirtualTables.js";
import { VIRTUAL_BUFFER } from "../constants.js";

// Fixed geometry shared across cases: 10px rows, 100px viewport, list starts
// 50px down the scroll content.
const BASE = { rowHeight: 10, viewportHeight: 100, listTop: 50 };

test("empty list renders nothing and has zero height", () => {
  const win = computeTableWindow({ ...BASE, scrollTop: 0, total: 0 });
  assert.deepEqual(win, { start: 0, end: 0, padTop: 0, totalHeight: 0 });
});

test("total height always reflects full row count", () => {
  const win = computeTableWindow({ ...BASE, scrollTop: 0, total: 1000 });
  assert.equal(win.totalHeight, 1000 * 10);
});

test("at the top: start clamps to 0, no negative padding", () => {
  const win = computeTableWindow({ ...BASE, scrollTop: 0, total: 1000 });
  assert.equal(win.start, 0);
  assert.equal(win.padTop, 0);
  // viewport (100/10=10) + 1 + buffer*2 rows, no leading buffer removed at top
  assert.equal(win.end, 0 + (10 + 1) + VIRTUAL_BUFFER * 2);
});

test("scroll before the list top behaves like top", () => {
  // scrollTop below listTop => relScroll negative => start 0
  const win = computeTableWindow({ ...BASE, scrollTop: 20, total: 1000 });
  assert.equal(win.start, 0);
  assert.equal(win.padTop, 0);
});

test("mid-scroll windows around the viewport with buffer", () => {
  // relScroll = 550 - 50 = 500 => 50 rows down
  const win = computeTableWindow({ ...BASE, scrollTop: 550, total: 1000 });
  assert.equal(win.start, 50 - VIRTUAL_BUFFER);
  assert.equal(win.padTop, win.start * 10);
  assert.equal(win.end, win.start + (10 + 1) + VIRTUAL_BUFFER * 2);
  assert.ok(win.end <= 1000);
});

test("near the bottom: end clamps to total", () => {
  // relScroll = (50 + 1000*10) - 50 = 10000 => far past the end
  const win = computeTableWindow({ ...BASE, scrollTop: 50 + 1000 * 10, total: 1000 });
  assert.equal(win.end, 1000);
  assert.ok(win.start <= 1000);
  assert.ok(win.start >= 0);
});

test("small list (fits in viewport) renders all rows", () => {
  const win = computeTableWindow({ ...BASE, scrollTop: 0, total: 3 });
  assert.equal(win.start, 0);
  assert.equal(win.end, 3);
  assert.equal(win.totalHeight, 30);
});

test("invalid rowHeight falls back to the default constant", () => {
  const win = computeTableWindow({ ...BASE, rowHeight: 0, scrollTop: 0, total: 4 });
  // default SIDEBAR_TABLE_ROW_HEIGHT = 27
  assert.equal(win.totalHeight, 4 * 27);
});

test("zero viewport still renders at least one row worth of window", () => {
  const win = computeTableWindow({ ...BASE, viewportHeight: 0, scrollTop: 0, total: 100 });
  // visibleCount floored to 1, plus buffers
  assert.equal(win.end, 0 + 1 + VIRTUAL_BUFFER * 2);
});
