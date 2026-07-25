import test from "node:test";
import assert from "node:assert/strict";

import {
  INSPECTOR_MIN_WIDTH,
  SIDEBAR_TAB_CLEARANCE_PX,
  SIDEBAR_TITLEBAR_COLLAPSED_WIDTH,
  usePaneResize,
} from "./composables/usePaneResize.js";

test("collapsed sidebar tab clearance leaves breathing room after the expand button", () => {
  assert.equal(SIDEBAR_TITLEBAR_COLLAPSED_WIDTH, 32);
  assert.equal(SIDEBAR_TAB_CLEARANCE_PX, SIDEBAR_TITLEBAR_COLLAPSED_WIDTH);
});

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
    const resize = usePaneResize({ initialCollapsed: false });
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

    assert.equal(resize.sidebarWidth.value, 332);
    assert.equal(resize.sidebarSlotStyle.value.width, "332px");
    assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-slot-width"], "332px");
    assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-titlebar-width"], "332px");
    assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-content-width"], "332px");
    assert.equal(pane.style.width, undefined, "sidebar DOM width should be rendered from reactive style only");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test("expand immediately publishes synchronized reveal widths", () => {
  const resize = usePaneResize({ initialCollapsed: false });
  resize.sidebarWidth.value = 318;
  resize.toggleSidebar();
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-slot-width"], "0px");
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-titlebar-width"], "32px");
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-content-width"], "318px");
  resize.sidebarPaneAnimating.value = false;
  resize.sidebarPanePhase.value = null;

  resize.toggleSidebar();
  assert.equal(resize.sidebarPanePhase.value, "expanding");
  assert.equal(resize.sidebarCollapsed.value, false);
  assert.equal(resize.sidebarWidth.value, 318);
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-slot-width"], "318px");
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-titlebar-width"], "318px");
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-content-width"], "318px");
});

test("inspector drag stops before its titlebar controls can collide", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners = new Map();
  const pane = {
    getBoundingClientRect: () => ({ width: 322 }),
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
    const resize = usePaneResize({ initialCollapsed: true });
    resize.workspaceRef.value = {
      clientWidth: 1280,
      classList: { add() {}, remove() {} },
      querySelector: () => pane,
    };

    resize.onDividerMouseDown(
      {
        button: 0,
        preventDefault() {},
        currentTarget: { getBoundingClientRect: () => ({ left: 900, width: 8 }) },
        target: { closest: () => null },
      },
      "inspector",
    );
    listeners.get("mousemove")({ clientX: 1200 });

    assert.equal(INSPECTOR_MIN_WIDTH, 288);
    assert.equal(resize.inspectorWidth.value, INSPECTOR_MIN_WIDTH);
    assert.equal(resize.inspectorStyle.value.width, `${INSPECTOR_MIN_WIDTH}px`);

    listeners.get("mouseup")();
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});
