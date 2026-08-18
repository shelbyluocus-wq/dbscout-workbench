import test from "node:test";
import assert from "node:assert/strict";
import { useColumnReorder } from "./composables/useColumnReorder.js";

function pointerEvent(overrides = {}) {
  return {
    button: 0,
    pointerId: 1,
    clientX: 80,
    clientY: 20,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: { closest: () => null },
    ...overrides,
  };
}

function idleReorder() {
  return useColumnReorder({
    getFrozenCount: () => 0,
    getGridWrap: () => ({
      scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 0, right: 400, top: 0, bottom: 200 }),
      querySelectorAll: () => [],
    }),
    onCommit() {},
  });
}

test("idle column reorder state stays selectable and does not occupy the grid", () => {
  const reorder = idleReorder();
  assert.equal(reorder.dragging, false);
  assert.equal(reorder.drop, null);
  assert.equal(reorder.ghost, null);
  assert.equal(Boolean(reorder.dragging && reorder.drop && !reorder.drop?.allowed), false);
  assert.equal(Boolean(reorder.ghost), false);
});

test("column reorder tracking starts from a plain header press and ignores modifier or handle clicks", () => {
  const reorder = idleReorder();

  assert.equal(reorder.onHeaderPointerDown(pointerEvent({ ctrlKey: true }), 0, "id", 82), false);
  assert.equal(reorder.onHeaderPointerDown(pointerEvent({
    target: { closest: (selector) => selector.includes(".wb-col-resize") ? {} : null },
  }), 0, "id", 82), false);
  assert.equal(reorder.onHeaderPointerDown(pointerEvent(), 0, "id", 82), true);
  assert.equal(reorder.dragging, false);
  reorder.cancel();
});

test("dragging a header past the threshold commits the new field order", () => {
  const listeners = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };

  try {
    const headers = [
      {
        dataset: { columnIndex: "0", columnName: "id" },
        getBoundingClientRect: () => ({ left: 0, right: 80, top: 0, bottom: 28, width: 80, height: 28 }),
      },
      {
        dataset: { columnIndex: "1", columnName: "name" },
        getBoundingClientRect: () => ({ left: 80, right: 180, top: 0, bottom: 28, width: 100, height: 28 }),
      },
    ];
    let committed = null;
    const reorder = useColumnReorder({
      getFrozenCount: () => 0,
      getGridWrap: () => ({
        scrollLeft: 0,
        getBoundingClientRect: () => ({ left: 0, right: 400, top: 0, bottom: 200 }),
        querySelectorAll: () => headers,
      }),
      onCommit(payload) {
        committed = payload;
      },
    });

    assert.equal(reorder.onHeaderPointerDown(pointerEvent({ clientX: 40, clientY: 14 }), 0, "id", 80), true);
    listeners.get("pointermove")({ pointerId: 1, clientX: 150, clientY: 14 });
    assert.equal(reorder.dragging, true);
    assert.equal(reorder.drop?.allowed, true);
    assert.equal(reorder.ghost?.label, "id");
    listeners.get("pointerup")({ pointerId: 1, clientX: 150, clientY: 14 });
    assert.deepEqual(committed, { sourceName: "id", targetName: "name", position: "after" });
    assert.equal(reorder.dragging, false);
    assert.equal(reorder.ghost, null);
  } finally {
    globalThis.window = previousWindow;
  }
});
