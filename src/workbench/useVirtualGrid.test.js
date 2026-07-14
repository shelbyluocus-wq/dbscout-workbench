import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { computed, reactive, ref } from "vue";
import { useVirtualGrid } from "./composables/useVirtualGrid.js";

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
});

test("useVirtualGrid exposes column scrolling for schema search activation", () => {
  const source = fs.readFileSync(new URL("./composables/useVirtualGrid.js", import.meta.url), "utf8");

  assert.match(source, /function\s+scrollColumnIntoView/);
  assert.match(source, /scrollColumnIntoView,/);
});
