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

function makeTabElement() {
  const attrs = new Map([["draggable", "true"]]);
  const el = {
    classList: { contains: (cls) => cls === "wb-tab" },
    closest: (sel) => (sel === ".wb-tab" ? el : null),
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, value),
  };
  return el;
}

function makeInnerElement(parentTab) {
  return {
    classList: { contains: () => false },
    closest: (sel) => (sel === ".wb-tab" ? parentTab : null),
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

test("dragging on a .wb-tab element keeps tab reorder ahead of window drag", () => {
  const calls = [];
  const startDragMove = () => calls.push("move");

  const { onTabBarMouseDown } = createTabWindowDrag(startDragMove);

  const tabBar = makeTabBar();
  const tabEl = makeTabElement();

  // Simulate mousedown on a .wb-tab element
  const mousedownEvent = {
    target: tabEl,
    clientX: 10,
    clientY: 20,
    button: 0,
  };

  onTabBarMouseDown(mousedownEvent, tabBar);

  assert.equal(tabEl.getAttribute("draggable"), "true", "tab draggable should stay enabled");

  // Simulate mousemove past 4px threshold
  const mousemoveEvent = {
    clientX: 20,
    clientY: 30,
  };
  tabBar.dispatchEvent("mousemove", mousemoveEvent);

  assert.deepEqual(calls, [], "startDragMove should not be called when dragging a .wb-tab");
});

test("dragging on a child inside a .wb-tab keeps tab reorder ahead of window drag", () => {
  const calls = [];
  const startDragMove = () => calls.push("move");

  const { onTabBarMouseDown } = createTabWindowDrag(startDragMove);

  const tabBar = makeTabBar();
  const tabEl = makeTabElement();
  const innerEl = makeInnerElement(tabEl);

  const mousedownEvent = {
    target: innerEl,
    clientX: 10,
    clientY: 20,
    button: 0,
  };

  onTabBarMouseDown(mousedownEvent, tabBar);

  assert.equal(tabEl.getAttribute("draggable"), "true", "tab draggable should stay enabled");

  const mousemoveEvent = {
    clientX: 20,
    clientY: 30,
  };
  tabBar.dispatchEvent("mousemove", mousemoveEvent);

  assert.deepEqual(calls, [], "startDragMove should not be called when dragging inside a .wb-tab");
});

test("clicking a .wb-tab without moving leaves draggable unchanged", () => {
  const calls = [];
  const startDragMove = () => calls.push("move");

  const { onTabBarMouseDown } = createTabWindowDrag(startDragMove);

  const tabBar = makeTabBar();
  const tabEl = makeTabElement();

  const mousedownEvent = {
    target: tabEl,
    clientX: 10,
    clientY: 20,
    button: 0,
  };

  onTabBarMouseDown(mousedownEvent, tabBar);
  assert.equal(tabEl.getAttribute("draggable"), "true", "tab draggable should stay enabled");

  // Release without moving past threshold
  tabBar.dispatchEvent("mouseup", {});

  assert.deepEqual(calls, [], "startDragMove should NOT be called");
  assert.equal(tabEl.getAttribute("draggable"), "true", "tab draggable should remain unchanged on mouseup");
});

test("clicking a .wb-tab-close button does NOT trigger startDragMove", () => {
  const calls = [];
  const startDragMove = () => calls.push("move");

  const { onTabBarMouseDown } = createTabWindowDrag(startDragMove);

  const tabBar = makeTabBar();
  const closeBtn = {
    classList: { contains: () => false },
    closest: (sel) => (sel === ".wb-tab-close" ? closeBtn : null),
  };

  const mousedownEvent = {
    target: closeBtn,
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

  assert.deepEqual(calls, [], "startDragMove should NOT be called on tab close button");
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
