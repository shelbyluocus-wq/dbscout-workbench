import test from "node:test";
import assert from "node:assert/strict";

import {
  INSPECTOR_VISIBILITY_KEY,
  inspectorSurfaceFor,
  isInspectorSpaceTight,
  readInspectorPrefs,
  resolveInspectorCollapsed,
  writeInspectorPrefs,
} from "./inspectorVisibility.js";
import { usePaneResize } from "./composables/usePaneResize.js";
import { ref } from "vue";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("inspector surface follows the active page kind and AI mode", () => {
  assert.equal(inspectorSurfaceFor({ tabKind: "data" }), "data");
  assert.equal(inspectorSurfaceFor({ tabKind: undefined }), "data");
  assert.equal(inspectorSurfaceFor({ tabKind: "home" }), "home");
  assert.equal(inspectorSurfaceFor({ tabKind: "sql" }), "aux");
  assert.equal(inspectorSurfaceFor({ tabKind: "design" }), "aux");
  assert.equal(inspectorSurfaceFor({ mode: "ai", tabKind: "home" }), "ai");
});

test("table data and home keep the inspector open while SQL and design default to collapsed", () => {
  assert.equal(resolveInspectorCollapsed({ surface: "data" }), false);
  assert.equal(resolveInspectorCollapsed({ surface: "home" }), false);
  assert.equal(resolveInspectorCollapsed({ surface: "aux" }), true);
  assert.equal(resolveInspectorCollapsed({ surface: "ai" }), false);
  assert.equal(resolveInspectorCollapsed({ surface: "aux", prefs: { aux: false } }), false);
  assert.equal(resolveInspectorCollapsed({ surface: "data", prefs: { data: true } }), true);
});

test("tight space collapses the inspector first unless the user reopened it", () => {
  assert.equal(resolveInspectorCollapsed({ surface: "data", tight: true }), true);
  assert.equal(resolveInspectorCollapsed({ surface: "data", tight: true, tightOverrides: { data: false } }), false);
  assert.equal(resolveInspectorCollapsed({ surface: "aux", tight: true, tightOverrides: { data: false } }), true);
});

test("space is tight when the main area would drop below the comfort width", () => {
  assert.equal(isInspectorSpaceTight({ viewportWidth: 1440, sidebarSpace: 292, inspectorWidth: 322 }), false);
  assert.equal(isInspectorSpaceTight({ viewportWidth: 1280, sidebarSpace: 292, inspectorWidth: 322 }), true);
  assert.equal(isInspectorSpaceTight({ viewportWidth: 1280, sidebarSpace: 32, inspectorWidth: 322 }), false);
  assert.equal(isInspectorSpaceTight({ viewportWidth: 0, sidebarSpace: 292, inspectorWidth: 322 }), false);
});

test("inspector preferences persist per surface and ignore malformed storage", () => {
  const storage = memoryStorage();
  writeInspectorPrefs({ aux: false, data: true }, storage);
  assert.deepEqual(readInspectorPrefs(storage), { data: true, aux: false });
  assert.deepEqual(readInspectorPrefs(memoryStorage({ [INSPECTOR_VISIBILITY_KEY]: "not json" })), {});
  assert.deepEqual(readInspectorPrefs(memoryStorage({ [INSPECTOR_VISIBILITY_KEY]: '{"data":"yes"}' })), {});
});

test("pane resize remembers manual inspector toggles per page kind", () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const viewportWidth = ref(1600);
    const resize = usePaneResize({ initialCollapsed: false, viewportWidth });
    assert.equal(resize.inspectorCollapsed.value, false);

    resize.inspectorSurface.value = "aux";
    assert.equal(resize.inspectorCollapsed.value, true);
    resize.toggleInspector();
    assert.equal(resize.inspectorCollapsed.value, false);

    resize.inspectorSurface.value = "data";
    resize.toggleInspector();
    assert.equal(resize.inspectorCollapsed.value, true);
    resize.inspectorSurface.value = "aux";
    assert.equal(resize.inspectorCollapsed.value, false);

    assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(INSPECTOR_VISIBILITY_KEY)), { aux: false, data: true });
  } finally {
    globalThis.localStorage = original;
  }
});

test("pane resize yields the inspector in a narrow window and honours a manual reopen", () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const viewportWidth = ref(1280);
    const resize = usePaneResize({ initialCollapsed: false, viewportWidth });
    assert.equal(resize.inspectorCollapsed.value, true);

    resize.expandInspector();
    assert.equal(resize.inspectorCollapsed.value, false);

    viewportWidth.value = 1600;
    assert.equal(resize.inspectorCollapsed.value, false);
  } finally {
    globalThis.localStorage = original;
  }
});
