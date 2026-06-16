import test from "node:test";
import assert from "node:assert/strict";

// We import the factory function (no Vue runtime dependency)
const { createTabWindowDrag } = await import("./useTabWindowDrag.js");

function makeTabBar() {
  return {
    addEventListener(type, handler) {
      this._handlers = this._handlers || {};
      this._handlers[type] = handler;
    },
    removeEventListener() {},
    dispatchEvent(type, event) {
      this._handlers?.[type]?.(event);
    },
  };
}

test("dragging on tab-bar background triggers startDragMove", () => {
  const calls = [];
  const startDragMove = () => calls.push("move");

  const { onTabBarMouseDown } = createTabWindowDrag(startDragMove);

  const tabBar = makeTabBar();

  // Simulate mousedown on the tab-bar background (target has no .wb-tab ancestor)
  const mousedownEvent = {
    target: tabBar,
    clientX: 10,
    clientY: 20,
    button: 0,
  };

  onTabBarMouseDown(mousedownEvent, tabBar);

  // Simulate mousemove past 4px threshold
  const mousemoveEvent = {
    clientX: 16,
    clientY: 22,
  };
  tabBar.dispatchEvent("mousemove", mousemoveEvent);

  assert.deepEqual(calls, ["move"], "startDragMove should be called after threshold");
});

test("dragging on a .wb-tab element does NOT trigger startDragMove", () => {
  const calls = [];
  const startDragMove = () => calls.push("move");

  const { onTabBarMouseDown } = createTabWindowDrag(startDragMove);

  const tabBar = makeTabBar();
  const tabEl = { classList: { contains: (cls) => cls === "wb-tab" } };

  // Simulate mousedown on a .wb-tab element
  const mousedownEvent = {
    target: tabEl,
    clientX: 10,
    clientY: 20,
    button: 0,
  };

  onTabBarMouseDown(mousedownEvent, tabBar);

  // Simulate mousemove past 4px threshold
  const mousemoveEvent = {
    clientX: 20,
    clientY: 30,
  };
  tabBar.dispatchEvent("mousemove", mousemoveEvent);

  assert.deepEqual(calls, [], "startDragMove should NOT be called when clicking a .wb-tab");
});

test("mousemove below threshold does NOT trigger startDragMove", () => {
  const calls = [];
  const startDragMove = () => calls.push("move");

  const { onTabBarMouseDown } = createTabWindowDrag(startDragMove);

  const tabBar = makeTabBar();

  const mousedownEvent = {
    target: tabBar,
    clientX: 10,
    clientY: 20,
    button: 0,
  };

  onTabBarMouseDown(mousedownEvent, tabBar);

  // Simulate mousemove below 4px threshold
  const mousemoveEvent = {
    clientX: 12,
    clientY: 21,
  };
  tabBar.dispatchEvent("mousemove", mousemoveEvent);

  assert.deepEqual(calls, [], "startDragMove should NOT be called below threshold");
});

test("non-left button mousedown does NOT trigger startDragMove", () => {
  const calls = [];
  const startDragMove = () => calls.push("move");

  const { onTabBarMouseDown } = createTabWindowDrag(startDragMove);

  const tabBar = makeTabBar();

  const mousedownEvent = {
    target: tabBar,
    clientX: 10,
    clientY: 20,
    button: 2, // right click
  };

  onTabBarMouseDown(mousedownEvent, tabBar);

  const mousemoveEvent = {
    clientX: 20,
    clientY: 30,
  };
  tabBar.dispatchEvent("mousemove", mousemoveEvent);

  assert.deepEqual(calls, [], "startDragMove should NOT be called on right-click");
});

test("closest .wb-tab ancestor prevents drag", () => {
  const calls = [];
  const startDragMove = () => calls.push("move");

  const { onTabBarMouseDown } = createTabWindowDrag(startDragMove);

  const tabBar = makeTabBar();
  const tabEl = { classList: { contains: (cls) => cls === "wb-tab" } };
  const innerEl = {
    classList: { contains: () => false },
    closest: (sel) => (sel === ".wb-tab" ? tabEl : null),
  };

  const mousedownEvent = {
    target: innerEl,
    clientX: 10,
    clientY: 20,
    button: 0,
  };

  onTabBarMouseDown(mousedownEvent, tabBar);

  const mousemoveEvent = {
    clientX: 20,
    clientY: 30,
  };
  tabBar.dispatchEvent("mousemove", mousemoveEvent);

  assert.deepEqual(calls, [], "startDragMove should NOT be called when target is inside a .wb-tab");
});
