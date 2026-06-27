import test from "node:test";
import assert from "node:assert/strict";

import { createCellHighlightController } from "./composables/useCellHighlight.js";

function createStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem(key) {
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    },
  };
}

function createRoot() {
  const styles = {};
  return {
    styles,
    style: {
      setProperty(name, value) {
        styles[name] = value;
      },
      removeProperty(name) {
        delete styles[name];
      },
    },
  };
}

test("cell highlight color writes a user override token that dark theme can inherit", () => {
  const storage = createStorage();
  const root = createRoot();
  const highlight = createCellHighlightController({ storage, root });

  highlight.setColor("#ff3366");

  assert.equal(root.styles["--wb-cell-highlight-custom"], "#ff3366");
  assert.equal(root.styles["--wb-cell-highlight"], undefined);

  highlight.clear();

  assert.equal(root.styles["--wb-cell-highlight-custom"], undefined);
});
