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

test("column reorder tracking starts from a plain header press and ignores modifier or handle clicks", () => {
  const reorder = useColumnReorder({
    getFrozenCount: () => 0,
    getGridWrap: () => ({
      scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 0, right: 400, top: 0, bottom: 200 }),
      querySelectorAll: () => [],
    }),
    onCommit() {},
  });

  assert.equal(reorder.onHeaderPointerDown(pointerEvent({ ctrlKey: true }), 0, "id", 82), false);
  assert.equal(reorder.onHeaderPointerDown(pointerEvent({
    target: { closest: (selector) => selector.includes(".wb-col-resize") ? {} : null },
  }), 0, "id", 82), false);
  assert.equal(reorder.onHeaderPointerDown(pointerEvent(), 0, "id", 82), true);
  assert.equal(reorder.dragging.value, false);
  reorder.cancel();
});
