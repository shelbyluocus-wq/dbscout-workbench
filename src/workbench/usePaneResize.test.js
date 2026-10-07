import test from "node:test";
import assert from "node:assert/strict";

import { ref } from "vue";
import {
  ACTIVITY_RAIL_WIDTH,
  INSPECTOR_MIN_WIDTH,
  SIDEBAR_TAB_CLEARANCE_PX,
  SIDEBAR_TITLEBAR_COLLAPSED_WIDTH,
  usePaneResize,
} from "./composables/usePaneResize.js";

function installDragGlobals() {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners = new Map();
  globalThis.document = { body: { style: {} } };
  globalThis.window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  return {
    listeners,
    restore() {
      globalThis.document = originalDocument;
      globalThis.window = originalWindow;
    },
  };
}

test("collapsed sidebar titlebar strip keeps the activity rail's width", () => {
  assert.equal(ACTIVITY_RAIL_WIDTH, 40);
  assert.equal(SIDEBAR_TITLEBAR_COLLAPSED_WIDTH, ACTIVITY_RAIL_WIDTH);
  assert.equal(SIDEBAR_TAB_CLEARANCE_PX, SIDEBAR_TITLEBAR_COLLAPSED_WIDTH);
});

test("the activity rail counts against the main area when deciding to yield the inspector", () => {
  const viewportWidth = ref(1420);
  const expanded = usePaneResize({ initialCollapsed: false, viewportWidth });
  // 1420 - (40 rail + 292 sidebar) - 322 inspector = 766, below the 780 comfort width.
  assert.equal(expanded.inspectorCollapsed.value, true);
  viewportWidth.value = 1440;
  assert.equal(expanded.inspectorCollapsed.value, false);

  const collapsed = usePaneResize({ initialCollapsed: true, viewportWidth: ref(1140) });
  // 1140 - 40 rail - 322 inspector = 778: the rail alone still takes room.
  assert.equal(collapsed.inspectorCollapsed.value, true);
});

test("sidebar drag leaves the activity rail and the main area minimum intact", () => {
  const drag = installDragGlobals();
  const pane = { getBoundingClientRect: () => ({ width: 292 }) };
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
        preventDefault() {},
        currentTarget: { getBoundingClientRect: () => ({ left: 330, width: 8 }) },
        target: { closest: () => null },
      },
      "sidebar",
    );
    drag.listeners.get("mousemove")({ clientX: 1280 });
    // 1280 - 40 rail - 16 padding - 8 dividers - 400 main - 322 inspector.
    assert.equal(resize.sidebarWidth.value, 494);
    drag.listeners.get("mouseup")();
  } finally {
    drag.restore();
  }
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
    assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-titlebar-width"], "372px");
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
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-titlebar-width"], "40px");
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-content-width"], "318px");
  resize.sidebarPaneAnimating.value = false;
  resize.sidebarPanePhase.value = null;

  resize.toggleSidebar();
  assert.equal(resize.sidebarPanePhase.value, "expanding");
  assert.equal(resize.sidebarCollapsed.value, false);
  assert.equal(resize.sidebarWidth.value, 318);
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-slot-width"], "318px");
  assert.equal(resize.sidebarLayoutVars.value["--wb-sidebar-titlebar-width"], "358px");
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
