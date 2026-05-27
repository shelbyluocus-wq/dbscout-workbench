import test from "node:test";
import assert from "node:assert/strict";

import { useInspectorResize } from "./composables/useInspectorResize.js";

function withPointerEnvironment(run) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners = new Map();

  globalThis.document = {
    body: { style: {} },
  };
  globalThis.window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };

  try {
    run({ listeners, bodyStyle: globalThis.document.body.style });
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
}

test("dragging the inspector divider upward grows the detail panel and clears drag styling", () => {
  withPointerEnvironment(({ listeners, bodyStyle }) => {
    const resize = useInspectorResize();
    resize.inspectorRef.value = {
      getBoundingClientRect: () => ({ height: 640 }),
    };

    resize.onDetailDividerMouseDown({
      button: 0,
      clientY: 300,
      preventDefault() {},
    });

    assert.equal(resize.isDetailResizing.value, true);
    assert.equal(bodyStyle.cursor, "row-resize");

    listeners.get("mousemove")({ clientY: 240 });

    assert.equal(resize.detailPanelStyle.value.height, "272px");

    listeners.get("mouseup")();

    assert.equal(resize.isDetailResizing.value, false);
    assert.equal(bodyStyle.cursor, "");
    assert.equal(listeners.has("mousemove"), false);
    assert.equal(listeners.has("mouseup"), false);
  });
});

test("reset and keyboard resize keep the detail editor within a usable vertical range", () => {
  const resize = useInspectorResize();
  resize.inspectorRef.value = {
    getBoundingClientRect: () => ({ height: 430 }),
  };

  const event = {
    key: "ArrowUp",
    shiftKey: false,
    preventDefault() {},
  };
  for (let i = 0; i < 30; i += 1) resize.onDetailDividerKeydown(event);

  assert.equal(resize.detailPanelStyle.value.height, "272px");

  resize.onDetailDividerKeydown({ ...event, key: "ArrowDown" });
  assert.equal(resize.detailPanelStyle.value.height, "260px");

  resize.resetDetailHeight();
  assert.equal(resize.detailPanelStyle.value.height, "212px");
});
