import test from "node:test";
import assert from "node:assert/strict";

import { usePaneResize } from "./composables/usePaneResize.js";

test("dragging the sidebar publishes its live width for aligned companion surfaces", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners = new Map();
  const pane = {
    style: {},
    getBoundingClientRect: () => ({ width: 292 }),
  };

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
    const resize = usePaneResize();
    resize.workspaceRef.value = {
      clientWidth: 1280,
      classList: { add() {}, remove() {} },
      querySelector: () => pane,
    };

    resize.onDividerMouseDown(
      {
        button: 0,
        clientX: 100,
        preventDefault() {},
        currentTarget: { getBoundingClientRect: () => ({ left: 96, width: 8 }) },
        target: { closest: () => null },
      },
      "sidebar",
    );
    listeners.get("mousemove")({ clientX: 140 });

    assert.equal(resize.sidebarStyle.value.width, "332px");
    assert.equal(pane.style.width, undefined, "sidebar DOM width should be rendered from reactive style only");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});
