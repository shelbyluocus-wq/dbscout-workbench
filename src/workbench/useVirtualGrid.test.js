import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { computed, reactive } from "vue";
import { useVirtualGrid } from "./composables/useVirtualGrid.js";

const originalResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
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

test("programmatic row scrolling leaves header clearance below the focused row", () => {
  stubResizeObserver();
  const tab = makeTab(500);
  const virtual = useVirtualGrid(computed(() => tab), {});
  virtual.gridWrapRef.value = makeWrap(1099);

  virtual.scrollRowIntoView(498);

  const rowBottom = (498 + 1) * 26;
  assert.equal(rowBottom <= virtual.gridWrapRef.value.scrollTop + virtual.gridWrapRef.value.clientHeight - 28, true);
});
