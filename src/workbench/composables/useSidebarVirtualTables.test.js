import test from "node:test";
import assert from "node:assert/strict";
import { nextTick, ref, shallowRef } from "vue";

import {
  computeTableWindow,
  measureStickyTopInset,
  resolveListElement,
  useSidebarVirtualTables,
} from "./useSidebarVirtualTables.js";
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

test("stale scroll from a longer database still renders the switched database", () => {
  const win = computeTableWindow({
    ...BASE,
    scrollTop: 50 + 1000 * 10,
    total: 224,
  });

  assert.equal(win.end, 224);
  assert.ok(win.start < win.end, "the virtual window must contain visible tables");
  assert.ok(win.padTop < win.totalHeight);
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

test("resolves Vue template refs from v-for arrays to a DOM-like element", () => {
  const first = { querySelector: () => null, getBoundingClientRect: () => ({ top: 8 }) };

  assert.equal(resolveListElement([first]), first);
  assert.equal(resolveListElement([[first]]), first);
  assert.equal(resolveListElement([]), null);
});

test("measures the real sticky search inset inside the table viewport", () => {
  const header = { getBoundingClientRect: () => ({ top: 12, bottom: 48 }) };
  const container = {
    clientHeight: 180,
    getBoundingClientRect: () => ({ top: 12, bottom: 192 }),
    querySelector: (selector) => (selector === ".wb-table-search-wrap" ? header : null),
  };

  assert.equal(measureStickyTopInset(container, ".wb-table-search-wrap"), 36);
  assert.equal(measureStickyTopInset(container, ".missing"), 0);
});

test("active-table reveal scrolls only the dedicated table viewport", () => {
  const calls = [];
  const header = { getBoundingClientRect: () => ({ top: 0, bottom: 36 }) };
  const firstRow = { getBoundingClientRect: () => ({ height: 27 }) };
  const container = {
    scrollTop: 200,
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    querySelector: (selector) => (selector === ".wb-table-search-wrap" ? header : null),
    addEventListener() {},
    removeEventListener() {},
    scrollTo(options) {
      calls.push(options);
    },
  };
  const list = {
    getBoundingClientRect: () => ({ top: 40 - container.scrollTop }),
    querySelector: (selector) => (selector === ".wb-table-item" ? firstRow : null),
  };
  const controller = useSidebarVirtualTables({
    scrollContainerRef: shallowRef([container]),
    listElRef: shallowRef([list]),
    tables: ref(Array.from({ length: 40 }, (_, index) => ({ tableName: `table_${index}` }))),
    stickyHeaderSelector: ".wb-table-search-wrap",
  });

  controller.scrollTableIntoView(20, { margin: 10, smooth: false });

  assert.equal(controller.scrollContainer(), container);
  assert.equal(controller.stickyTopInset.value, 36);
  assert.equal(controller.viewportHeight.value, 164);
  assert.deepEqual(calls, [{ top: 417, behavior: "auto" }]);

  calls.length = 0;
  container.scrollTop = 600;
  controller.scrollTableIntoView(0, { margin: 10, smooth: false });
  assert.deepEqual(calls, [{ top: 0, behavior: "auto" }]);
  controller.dispose();
});

test("attaches scrolling when a v-for template-ref array is populated in place", async () => {
  const listeners = new Map();
  const container = {
    scrollTop: 0,
    clientHeight: 180,
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 180 }),
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
  };
  const scrollContainerRef = ref([]);
  const controller = useSidebarVirtualTables({
    scrollContainerRef,
    listElRef: shallowRef(null),
    tables: ref(Array.from({ length: 940 }, (_, index) => ({ tableName: `table_${index}` }))),
  });

  scrollContainerRef.value.push(container);
  await nextTick();

  assert.equal(typeof listeners.get("scroll"), "function");
  container.scrollTop = 540;
  container.clientHeight = 360;
  listeners.get("scroll")();
  assert.equal(controller.scrollTop.value, 540);
  assert.equal(controller.viewportHeight.value, 360);
  controller.dispose();
});
