import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { computed, nextTick, reactive, ref } from "vue";
import { columnIntoViewScrollDelta, useVirtualGrid } from "./composables/useVirtualGrid.js";

const originalResizeObserver = globalThis.ResizeObserver;
const originalConsoleWarn = console.warn;

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  console.warn = originalConsoleWarn;
});

function makeTab(rowCount = 100) {
  return reactive({
    id: "tab-1",
    rows: Array.from({ length: rowCount }, (_, index) => ({ id: String(index + 1) })),
    primaryKeys: ["id"],
  });
}

function stubResizeObserver() {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
}

function makeWrap(clientHeight = 78) {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    clientHeight,
    getBoundingClientRect() {
      return { left: 0, right: 400 };
    },
    querySelector() {
      return null;
    },
  };
}

test("useVirtualGrid can be instantiated outside component setup without lifecycle warnings", () => {
  stubResizeObserver();
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));

  useVirtualGrid(computed(() => makeTab()), {});

  assert.equal(warnings.length, 0);
});

test("programmatic row scrolling updates the virtual window immediately", () => {
  stubResizeObserver();
  const tab = makeTab();
  const virtual = useVirtualGrid(computed(() => tab), {});
  virtual.gridWrapRef.value = makeWrap();

  virtual.scrollRowIntoView(50);

  assert.equal(virtual.gridWrapRef.value.scrollTop > 0, true);
  assert.equal(virtual.virtualRange.value.start <= 50, true);
  assert.equal(virtual.virtualRange.value.end > 50, true);
  assert.equal(virtual.visibleRows.value.some(({ originalIndex }) => originalIndex === 50), true);
});

test("virtual geometry follows the active table row height", () => {
  stubResizeObserver();
  const tab = makeTab(10);
  tab.rowHeight = 40;
  const virtual = useVirtualGrid(computed(() => tab), {});

  assert.equal(virtual.rowHeight.value, 40);
  assert.equal(virtual.virtualRange.value.totalHeight, 400);
});

test("virtual geometry includes visible insert drafts", () => {
  stubResizeObserver();
  const tab = makeTab(10);
  tab.rowHeight = 40;
  tab.insertDrafts = [
    { id: "insert-before-3", anchorIndex: 3, visible: true, draft: {} },
    { id: "insert-at-end", anchorIndex: null, visible: true, draft: {} },
    { id: "hidden", anchorIndex: null, visible: false, draft: {} },
  ];
  const virtual = useVirtualGrid(computed(() => tab), {});

  assert.equal(virtual.virtualRange.value.totalHeight, 12 * 40);
});

test("virtual top spacer accounts for anchored insert drafts before the window", () => {
  stubResizeObserver();
  const tab = makeTab(100);
  tab.insertDrafts = [
    { id: "insert-before-window", anchorIndex: 5, visible: true, draft: {} },
    { id: "insert-in-window", anchorIndex: 45, visible: true, draft: {} },
  ];
  const virtual = useVirtualGrid(computed(() => tab), {});
  virtual.viewportHeight.value = 78;
  virtual.scrollTop.value = 50 * 28;

  const { start, padTop } = virtual.virtualRange.value;
  const insertsBeforeStart = tab.insertDrafts.filter((row) => row.anchorIndex < start).length;
  assert.equal(padTop, (start + insertsBeforeStart) * 28);
});

test("cold wide-grid mount starts with one viewport row plus the bounded buffer", () => {
  stubResizeObserver();
  const tab = makeTab(100);
  const virtual = useVirtualGrid(computed(() => tab), {});

  assert.equal(virtual.viewportHeight.value, 0);
  assert.equal(virtual.visibleRows.value.length, 21);
});

test("resetGridScroll clears the DOM offset and virtual spacer synchronously", () => {
  stubResizeObserver();
  const tab = makeTab(200);
  const virtual = useVirtualGrid(computed(() => tab), {});
  const wrap = makeWrap();
  wrap.scrollTop = 560;
  wrap.scrollLeft = 120;
  virtual.gridWrapRef.value = wrap;
  virtual.scrollTop.value = 560;

  assert.equal(virtual.virtualRange.value.padTop > 0, true);

  virtual.resetGridScroll();

  assert.equal(wrap.scrollTop, 0);
  assert.equal(wrap.scrollLeft, 0);
  assert.equal(virtual.scrollTop.value, 0);
  assert.equal(virtual.virtualRange.value.padTop, 0);
  assert.equal(virtual.visibleRows.value[0]?.originalIndex, 0);
});

test("restoreGridScroll restores both tab offsets and the virtual window synchronously", () => {
  stubResizeObserver();
  const tab = makeTab(200);
  const virtual = useVirtualGrid(computed(() => tab), {});
  const wrap = makeWrap();
  virtual.gridWrapRef.value = wrap;

  virtual.restoreGridScroll({ top: 560, left: 120 });

  assert.equal(wrap.scrollTop, 560);
  assert.equal(wrap.scrollLeft, 120);
  assert.equal(virtual.scrollTop.value, 560);
  assert.equal(virtual.virtualRange.value.padTop > 0, true);
});

test("a known table total fixes scroll geometry from the first page", () => {
  stubResizeObserver();
  const tab = makeTab(1000);
  tab.totalRows = 10000;
  tab.totalRowsExact = true;
  const virtual = useVirtualGrid(computed(() => tab), {});
  const wrap = makeWrap(560);
  wrap.scrollTop = 500 * 28;
  virtual.gridWrapRef.value = wrap;
  virtual.scrollTop.value = wrap.scrollTop;
  const firstVisibleId = virtual.visibleRows.value[0]?.row.id;

  assert.equal(virtual.virtualRange.value.totalHeight, 10000 * 28);

  tab.rows = [
    ...tab.rows,
    ...Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 1001) })),
  ];

  assert.equal(wrap.scrollTop, 500 * 28);
  assert.equal(virtual.virtualRange.value.totalHeight, 10000 * 28);
  assert.equal(virtual.visibleRows.value[0]?.row.id, firstVisibleId);
});

test("an exact total can arrive after first content without delaying the first page", () => {
  stubResizeObserver();
  const tab = makeTab(100);
  tab.totalRows = 100;
  tab.totalRowsExact = false;
  const virtual = useVirtualGrid(computed(() => tab), {});

  assert.equal(virtual.virtualRange.value.totalHeight, 100 * 28);

  tab.totalRows = 10000;
  tab.totalRowsExact = true;

  assert.equal(virtual.virtualRange.value.totalHeight, 10000 * 28);
});

test("a bottom window occupies its fixed position in the full table scroll space", () => {
  stubResizeObserver();
  const tab = makeTab(1000);
  tab.rows = Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 9001) }));
  tab.rowWindowOffset = 9000;
  const virtual = useVirtualGrid(computed(() => tab), {});
  virtual.viewportHeight.value = 560;
  virtual.scrollTop.value = 9500 * 28;

  assert.equal(virtual.virtualRange.value.totalHeight, 10000 * 28);
  assert.equal(virtual.virtualRange.value.padTop >= 9000 * 28, true);
  assert.equal(Number(virtual.visibleRows.value[0]?.row.id) >= 9001, true);
});

test("prepending a previous page preserves scrollTop, total height and visible rows", () => {
  stubResizeObserver();
  const tab = makeTab(1000);
  tab.rows = Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 9001) }));
  tab.rowWindowOffset = 9000;
  const virtual = useVirtualGrid(computed(() => tab), {});
  const wrap = makeWrap(560);
  wrap.scrollTop = 9500 * 28;
  virtual.gridWrapRef.value = wrap;
  virtual.scrollTop.value = wrap.scrollTop;
  const firstVisibleId = virtual.visibleRows.value[0]?.row.id;
  const totalHeight = virtual.virtualRange.value.totalHeight;

  tab.rows = [
    ...Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 8001) })),
    ...tab.rows,
  ];
  tab.rowWindowOffset = 8000;

  assert.equal(wrap.scrollTop, 9500 * 28);
  assert.equal(virtual.scrollTop.value, 9500 * 28);
  assert.equal(virtual.virtualRange.value.totalHeight, totalHeight);
  assert.equal(virtual.visibleRows.value[0]?.row.id, firstVisibleId);

  wrap.scrollTop = 9400 * 28;
  virtual.onGridScroll({ target: wrap });
  assert.equal(Number(virtual.visibleRows.value[0]?.row.id) < Number(firstVisibleId), true);
});

test("a short final page still exposes the full upward scroll range", () => {
  stubResizeObserver();
  const tab = makeTab(17);
  tab.rows = Array.from({ length: 17 }, (_, index) => ({ id: String(index + 10001) }));
  tab.rowWindowOffset = 10000;
  const virtual = useVirtualGrid(computed(() => tab), {});
  virtual.viewportHeight.value = 560;
  virtual.scrollTop.value = 10017 * 28 - 560;

  assert.equal(virtual.virtualRange.value.totalHeight, 10017 * 28);
  assert.equal(virtual.visibleRows.value.at(-1)?.row.id, "10017");
});

test("resetGridScroll returns to the first row even when a deep freeze exists", () => {
  stubResizeObserver();
  const tab = makeTab(1000);
  tab.frozenRowStart = 508;
  tab.frozenRowCount = 15;
  const virtual = useVirtualGrid(computed(() => tab), {});
  const wrap = makeWrap(612);
  wrap.scrollTop = 700 * 28;
  virtual.gridWrapRef.value = wrap;
  virtual.scrollTop.value = wrap.scrollTop;

  virtual.resetGridScroll();

  assert.equal(wrap.scrollTop, 0);
  assert.equal(virtual.scrollTop.value, 0);
  assert.equal(virtual.frozenRowsActive.value, false);
  assert.equal(virtual.visibleRows.value[0]?.originalIndex, 0);
});

test("scrollRowIntoView leaves frozen rows in place", () => {
  stubResizeObserver();
  const tab = makeTab(20);
  tab.frozenRowCount = 2;
  const virtual = useVirtualGrid(computed(() => tab), {});
  const wrap = makeWrap();
  wrap.scrollTop = 280;
  virtual.scrollTop.value = 280;
  virtual.gridWrapRef.value = wrap;

  virtual.scrollRowIntoView(1);

  assert.equal(wrap.scrollTop, 280);
  assert.equal(virtual.scrollTop.value, 280);
});

test("visibleRows include stable precomputed row keys", () => {
  stubResizeObserver();
  const tab = makeTab(3);
  const virtual = useVirtualGrid(computed(() => tab), {});

  assert.deepEqual(
    virtual.visibleRows.value.map(({ originalIndex, rowKey }) => ({ originalIndex, rowKey })),
    [
      { originalIndex: 0, rowKey: "id=1" },
      { originalIndex: 1, rowKey: "id=2" },
      { originalIndex: 2, rowKey: "id=3" },
    ],
  );
});

test("search result rows reuse backend-precomputed row keys", () => {
  stubResizeObserver();
  const tab = makeTab(2);
  tab.searchResultMode = true;
  tab.searchResultRowKeys = ["server-key-1", "server-key-2"];
  const virtual = useVirtualGrid(computed(() => tab), {});

  assert.deepEqual(
    virtual.visibleRows.value.map(({ rowKey }) => rowKey),
    ["server-key-1", "server-key-2"],
  );
});

test("virtual range does not duplicate rows when all rows are frozen", () => {
  stubResizeObserver();
  const tab = makeTab(2);
  tab.frozenRowCount = 5;
  const virtual = useVirtualGrid(computed(() => tab), {});

  assert.deepEqual(virtual.visibleRows.value, []);
  assert.equal(virtual.virtualRange.value.start, 2);
  assert.equal(virtual.virtualRange.value.end, 2);
});

test("visibleRows follows the real scroll position when many rows are frozen", () => {
  stubResizeObserver();
  const tab = makeTab(200);
  tab.frozenRowCount = 20;
  const virtual = useVirtualGrid(computed(() => tab), {});

  virtual.viewportHeight.value = 600;
  virtual.scrollTop.value = 2800;

  // 2800px is 100 row-heights. With 20 frozen rows rendered in a separate
  // sticky band, row 120 (0-based) should be mounted for the area below it.
  assert.equal(virtual.visibleRows.value.some(({ originalIndex }) => originalIndex === 120), true);
});

test("freezing at row 524 preserves the viewport and starts the lower pane at row 524", () => {
  stubResizeObserver();
  const tab = makeTab(1000);
  tab.frozenRowStart = 508;
  tab.frozenRowCount = 15;
  const virtual = useVirtualGrid(computed(() => tab), {});

  virtual.viewportHeight.value = 612;
  virtual.scrollTop.value = 508 * 28;

  assert.equal(virtual.scrollTop.value, 508 * 28);
  assert.equal(virtual.frozenRowsActive.value, true);
  assert.equal(virtual.visibleRows.value.some(({ originalIndex }) => originalIndex === 508), false);
  assert.equal(virtual.visibleRows.value.some(({ originalIndex }) => originalIndex === 522), false);
  assert.equal(virtual.visibleRows.value.some(({ originalIndex }) => originalIndex === 523), true);
  assert.equal(virtual.virtualRange.value.totalHeight, 985 * 28);
});

test("a deep frozen pane releases while scrolling up and reactivates after its boundary", () => {
  stubResizeObserver();
  const tab = makeTab(1000);
  tab.frozenRowStart = 508;
  tab.frozenRowCount = 15;
  const virtual = useVirtualGrid(computed(() => tab), {});
  const wrap = makeWrap(612);
  virtual.gridWrapRef.value = wrap;

  wrap.scrollTop = 600 * 28;
  virtual.onGridScroll({ target: wrap });

  assert.equal(virtual.frozenRowsActive.value, true);
  assert.equal(virtual.visibleRows.value.some(({ originalIndex }) => originalIndex === 508), false);
  assert.equal(virtual.virtualRange.value.totalHeight, 985 * 28);

  wrap.scrollTop = 507 * 28;
  virtual.onGridScroll({ target: wrap });

  assert.equal(wrap.scrollTop, 507 * 28);
  assert.equal(virtual.scrollTop.value, 507 * 28);
  assert.equal(virtual.frozenRowsActive.value, false);
  assert.equal(virtual.visibleRows.value.some(({ originalIndex }) => originalIndex === 508), true);
  assert.equal(virtual.virtualRange.value.totalHeight, 1000 * 28);

  wrap.scrollTop = 0;

  virtual.onGridScroll({ target: wrap });

  assert.equal(wrap.scrollTop, 0);
  assert.equal(virtual.scrollTop.value, 0);
  assert.equal(virtual.visibleRows.value[0]?.originalIndex, 0);
});

test("virtual range clamps stale scroll positions when the active tab shrinks", () => {
  stubResizeObserver();
  const bigTab = makeTab(500);
  const smallTab = makeTab(3);
  const activeTab = ref(bigTab);
  const virtual = useVirtualGrid(computed(() => activeTab.value), {});

  virtual.viewportHeight.value = 78;
  virtual.scrollTop.value = 500 * 28;
  activeTab.value = smallTab;

  assert.deepEqual(
    virtual.visibleRows.value.map(({ originalIndex }) => originalIndex),
    [0, 1, 2],
  );
  assert.equal(virtual.virtualRange.value.start, 0);
  assert.equal(virtual.virtualRange.value.end, 3);
});

test("activeColumnMeta normalizes column names once for the active tab", () => {
  stubResizeObserver();
  const tab = reactive({
    id: "tab-1",
    rows: [],
    columns: [
      { column_name: "id", column_comment: "ID" },
      { columnName: "nickname", column_comment: "Name" },
    ],
    primaryKeys: ["id"],
  });
  const virtual = useVirtualGrid(computed(() => tab), {});

  assert.deepEqual(
    virtual.activeColumnMeta.value.map(({ name, column }) => ({ name, column })),
    [
      { name: "id", column: tab.columns[0] },
      { name: "nickname", column: tab.columns[1] },
    ],
  );
});

test("programmatic row scrolling leaves header clearance below the focused row", () => {
  stubResizeObserver();
  const tab = makeTab(500);
  const virtual = useVirtualGrid(computed(() => tab), {});
  virtual.gridWrapRef.value = makeWrap(1099);

  virtual.scrollRowIntoView(498);

  const rowBottom = (498 + 1) * 28;
  assert.equal(rowBottom <= virtual.gridWrapRef.value.scrollTop + virtual.gridWrapRef.value.clientHeight - 28, true);
  const renderedBottom = 28 + 32 + rowBottom - virtual.gridWrapRef.value.scrollTop;
  assert.equal(renderedBottom <= virtual.gridWrapRef.value.clientHeight - 28, true);
});

test("programmatic row scrolling keeps the focused row above the first/last-row buttons", () => {
  stubResizeObserver();
  const tab = makeTab(500);
  const virtual = useVirtualGrid(computed(() => tab), {});
  virtual.gridWrapRef.value = makeWrap(1099);

  virtual.scrollRowIntoView(498);

  const headerHeight = 28 + 32;
  const overlayClearance = 14 + 36 + 28;
  const rowBottom = (498 + 1) * 28;
  const renderedBottom = headerHeight + rowBottom - virtual.gridWrapRef.value.scrollTop;
  assert.equal(renderedBottom <= virtual.gridWrapRef.value.clientHeight - overlayClearance, true);
});

test("programmatic row scrolling avoids an overlapping cell detail panel", async () => {
  stubResizeObserver();
  const tab = makeTab(100);
  const virtual = useVirtualGrid(computed(() => tab), {});
  const detailPanel = {
    getBoundingClientRect() {
      return { top: 300, bottom: 520, left: 0, right: 400 };
    },
  };
  virtual.gridWrapRef.value = {
    ...makeWrap(500),
    getBoundingClientRect() {
      return { top: 0, bottom: 500, left: 0, right: 400 };
    },
    closest() {
      return { querySelector: () => detailPanel };
    },
  };

  virtual.scrollRowIntoView(15);
  await nextTick();

  const rowBottom = (15 + 1) * 28;
  assert.equal(rowBottom <= virtual.gridWrapRef.value.scrollTop + 300 - 28, true);
});

test("useVirtualGrid exposes column scrolling for schema search activation", () => {
  const source = fs.readFileSync(new URL("./composables/useVirtualGrid.js", import.meta.url), "utf8");

  assert.match(source, /function\s+scrollColumnIntoView/);
  assert.match(source, /columnIntoViewScrollDelta/);
  assert.match(source, /scrollColumnIntoView,/);
  assert.match(source, /GRID_BOUNDARY_OVERLAY_CLEARANCE/);
});

test("columnIntoViewScrollDelta keeps wide columns pinned to the field-name edge", () => {
  assert.equal(columnIntoViewScrollDelta(80, 200, 38, 400), 0);
  assert.equal(columnIntoViewScrollDelta(10, 80, 38, 400), -28);
  assert.equal(columnIntoViewScrollDelta(360, 430, 38, 400), 30);
  // A 600px autofit column in a 362px viewport must not align its right edge,
  // or the left-aligned field name (e.g. Dsc) disappears and only the remark tail remains.
  assert.equal(columnIntoViewScrollDelta(120, 720, 38, 400), 82);
  // Center alignment places normal columns in the middle of the visible area
  // while still pinning oversized columns to the left boundary.
  assert.equal(columnIntoViewScrollDelta(1430, 1520, 0, 987, { align: "center" }), 981.5);
  assert.equal(columnIntoViewScrollDelta(120, 720, 38, 400, { align: "center" }), 82);
});

test("scrollColumnIntoView centers jumped columns and reconciles DOM offset drift", async () => {
  stubResizeObserver();
  const columns = Array.from({ length: 16 }, (_, index) => ({ column_name: `col_${index}` }));
  const widths = Object.fromEntries(columns.map((column, index) => [column.column_name, index === 4 || index === 5 ? 220 : 100]));
  const tab = reactive({
    id: "tab-jump",
    columns,
    rows: [Object.fromEntries(columns.map((column) => [column.column_name, "5"]))],
    primaryKeys: ["col_0"],
    columnWidthState: { widths, manual: {}, availableWidth: 987 },
  });
  const virtual = useVirtualGrid(computed(() => tab), {});
  // Simulate rendered table cells drifting +40px wider than estimated offsets
  // (e.g. auto table layout / borders / padding on preceding wide columns).
  const DOM_DRIFT_PX = 40;
  const maxScrollLeft = 2400;
  const wrap = {
    _scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 1025,
    clientHeight: 400,
    get scrollLeft() {
      return this._scrollLeft;
    },
    set scrollLeft(value) {
      this._scrollLeft = Math.max(0, Math.min(maxScrollLeft, value));
    },
    getBoundingClientRect() {
      return { left: 0, right: 1025, top: 0, bottom: 400 };
    },
    querySelector(selector) {
      if (selector.includes("wb-row-index")) {
        return { getBoundingClientRect: () => ({ left: 0, right: 38 }) };
      }
      if (selector.includes('data-column-index="11"')) {
        const estimatedLeft = virtual.columnWindow.value.offsets[11];
        const estimatedRight = virtual.columnWindow.value.offsets[12];
        return {
          getBoundingClientRect: () => ({
            left: 38 + estimatedLeft + DOM_DRIFT_PX - wrap.scrollLeft,
            right: 38 + estimatedRight + DOM_DRIFT_PX - wrap.scrollLeft,
          }),
        };
      }
      return null;
    },
  };
  virtual.gridWrapRef.value = wrap;
  virtual.viewportWidth.value = 1025;

  virtual.scrollCellIntoView(0, 11, { alignColumn: "center" });
  await nextTick();
  await nextTick();

  const finalCellRect = wrap.querySelector('td[data-column-index="11"]').getBoundingClientRect();
  const visibleCenter = 38 + (1025 - 38) / 2;
  const cellCenter = (finalCellRect.left + finalCellRect.right) / 2;
  assert.ok(finalCellRect.left >= 38, "jumped cell clears row-index gutter");
  assert.ok(finalCellRect.right <= 1025, "jumped cell is fully inside the right edge");
  assert.ok(Math.abs(cellCenter - visibleCenter) <= 2, `expected centered cell (~${visibleCenter}), got ${cellCenter}`);
});

test("scrollColumnIntoView re-centers after next-frame auto-fit widens earlier columns", async () => {
  stubResizeObserver();
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const columns = Array.from({ length: 14 }, (_, index) => ({ column_name: `col_${index}` }));
    const tab = reactive({
      id: "tab-autofit",
      columns,
      rows: [Object.fromEntries(columns.map((column) => [column.column_name, "5"]))],
      primaryKeys: ["col_0"],
      columnWidthState: { widths: {}, manual: {}, availableWidth: 0 },
    });
    const virtual = useVirtualGrid(computed(() => tab), {});
    const wrap = {
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 1025,
      clientHeight: 400,
      getBoundingClientRect: () => ({ left: 0, right: 1025, top: 0, bottom: 400 }),
      querySelector(selector) {
        if (selector.includes("wb-row-index")) {
          return { getBoundingClientRect: () => ({ left: 0, right: 38 }) };
        }
        if (selector.includes('data-column-index="11"')) {
          const left = virtual.columnWindow.value.offsets[11];
          const right = virtual.columnWindow.value.offsets[12];
          return {
            getBoundingClientRect: () => ({
              left: 38 + left - wrap.scrollLeft,
              right: 38 + right - wrap.scrollLeft,
            }),
          };
        }
        return null;
      },
    };
    virtual.gridWrapRef.value = wrap;
    virtual.viewportWidth.value = 1025;

    virtual.scrollColumnIntoView(11, "td", { align: "center" });
    await nextTick();
    // Simulate DataGrid auto-fit widening long-description columns before the
    // animation frame settles.
    for (const column of columns) {
      tab.columnWidthState.widths[column.column_name] = column.column_name === "col_4" || column.column_name === "col_5" ? 240 : 100;
    }
    while (rafQueue.length) rafQueue.shift()();
    await nextTick();

    const finalCellRect = wrap.querySelector('td[data-column-index="11"]').getBoundingClientRect();
    const visibleCenter = 38 + (1025 - 38) / 2;
    const cellCenter = (finalCellRect.left + finalCellRect.right) / 2;
    assert.ok(Math.abs(cellCenter - visibleCenter) <= 2, `expected post-autofit centered cell (~${visibleCenter}), got ${cellCenter}`);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  }
});

test("scrollColumnIntoView stops reconciling if the user scrolls horizontally", async () => {
  stubResizeObserver();
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const columns = Array.from({ length: 14 }, (_, index) => ({ column_name: `col_${index}` }));
    const widths = Object.fromEntries(columns.map((column) => [column.column_name, 120]));
    const tab = reactive({
      id: "tab-manual-scroll",
      columns,
      rows: [Object.fromEntries(columns.map((column) => [column.column_name, "5"]))],
      primaryKeys: ["col_0"],
      columnWidthState: { widths, manual: {}, availableWidth: 987 },
    });
    const virtual = useVirtualGrid(computed(() => tab), {});
    const wrap = {
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 1025,
      clientHeight: 400,
      getBoundingClientRect: () => ({ left: 0, right: 1025, top: 0, bottom: 400 }),
      querySelector: () => null,
    };
    virtual.gridWrapRef.value = wrap;
    virtual.viewportWidth.value = 1025;

    virtual.scrollColumnIntoView(11, "td", { align: "center" });
    await nextTick();
    // User manually scrolls away before the next animation frame.
    wrap.scrollLeft = 120;
    virtual.onGridScroll({ target: wrap });
    while (rafQueue.length) rafQueue.shift()();
    await nextTick();

    assert.equal(wrap.scrollLeft, 120);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  }
});
