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

test("cell highlight stores independent colors for light and dark themes", () => {
  const storage = createStorage();
  const root = createRoot();
  let theme = "dark";
  const highlight = createCellHighlightController({ storage, root, getTheme: () => theme });

  highlight.setColor("#111111");
  assert.equal(highlight.color.value, "#111111");
  assert.equal(root.styles["--wb-cell-highlight-custom"], "#111111");
  assert.equal(storage.store.dbscout_cell_highlight_color_dark, "#111111");
  assert.equal(storage.store.dbscout_cell_highlight_color_light, undefined);

  theme = "light";
  highlight.syncTheme();
  assert.equal(highlight.color.value, "");
  assert.equal(root.styles["--wb-cell-highlight-custom"], undefined);

  highlight.setColor("#eeeeee");
  assert.equal(highlight.color.value, "#eeeeee");
  assert.equal(root.styles["--wb-cell-highlight-custom"], "#eeeeee");
  assert.equal(storage.store.dbscout_cell_highlight_color_light, "#eeeeee");
  assert.equal(storage.store.dbscout_cell_highlight_color_dark, "#111111");

  theme = "dark";
  highlight.syncTheme();
  assert.equal(highlight.color.value, "#111111");
  assert.equal(root.styles["--wb-cell-highlight-custom"], "#111111");
});

test("clearing a cell highlight removes only the active theme color", () => {
  const storage = createStorage({
    dbscout_cell_highlight_color_light: "#eeeeee",
    dbscout_cell_highlight_color_dark: "#111111",
  });
  const root = createRoot();
  let theme = "light";
  const highlight = createCellHighlightController({ storage, root, getTheme: () => theme });

  highlight.syncTheme();
  assert.equal(highlight.color.value, "#eeeeee");

  highlight.clear();
  assert.equal(highlight.color.value, "");
  assert.equal(root.styles["--wb-cell-highlight-custom"], undefined);
  assert.equal(storage.store.dbscout_cell_highlight_color_light, undefined);
  assert.equal(storage.store.dbscout_cell_highlight_color_dark, "#111111");

  theme = "dark";
  highlight.syncTheme();
  assert.equal(highlight.color.value, "#111111");
  assert.equal(root.styles["--wb-cell-highlight-custom"], "#111111");
});

test("legacy shared highlight color migrates only to the active theme", () => {
  const storage = createStorage({
    dbscout_cell_highlight_color: "#4477aa",
  });
  const root = createRoot();
  let theme = "dark";
  const highlight = createCellHighlightController({ storage, root, getTheme: () => theme });

  highlight.syncTheme();
  assert.equal(highlight.color.value, "#4477aa");
  assert.equal(root.styles["--wb-cell-highlight-custom"], "#4477aa");
  assert.equal(storage.store.dbscout_cell_highlight_color, undefined);
  assert.equal(storage.store.dbscout_cell_highlight_color_dark, "#4477aa");
  assert.equal(storage.store.dbscout_cell_highlight_color_light, undefined);

  theme = "light";
  highlight.syncTheme();
  assert.equal(highlight.color.value, "");
  assert.equal(root.styles["--wb-cell-highlight-custom"], undefined);
});
