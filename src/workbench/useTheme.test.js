import test from "node:test";
import assert from "node:assert/strict";

import {
  THEME_STORAGE_KEY,
  createThemeController,
} from "./composables/useTheme.js";

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
  };
}

function createMediaQuery(matches = false) {
  const listeners = new Set();
  return {
    matches,
    addEventListener(type, listener) {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "change") listeners.delete(listener);
    },
    change(nextMatches) {
      this.matches = nextMatches;
      for (const listener of listeners) listener({ matches: nextMatches });
    },
  };
}

test("uses the operating system theme and tracks changes before a manual choice", () => {
  const storage = createStorage();
  const mediaQuery = createMediaQuery(true);
  const appliedThemes = [];
  const theme = createThemeController({
    storage,
    mediaQuery,
    applyNativeTheme: (value) => appliedThemes.push(value),
  });

  theme.start();
  assert.equal(theme.effectiveTheme.value, "dark");
  assert.deepEqual(appliedThemes, ["dark"]);

  mediaQuery.change(false);
  assert.equal(theme.effectiveTheme.value, "light");
  assert.deepEqual(appliedThemes, ["dark", "light"]);

  theme.stop();
});

test("a saved manual preference overrides the operating system theme", () => {
  const storage = createStorage({ [THEME_STORAGE_KEY]: "dark" });
  const mediaQuery = createMediaQuery(false);
  const appliedThemes = [];
  const theme = createThemeController({
    storage,
    mediaQuery,
    applyNativeTheme: (value) => appliedThemes.push(value),
  });

  theme.start();
  mediaQuery.change(false);

  assert.equal(theme.effectiveTheme.value, "dark");
  assert.deepEqual(appliedThemes, ["dark"]);

  theme.stop();
});

test("toggleTheme persists the manual choice and no longer follows system changes", () => {
  const storage = createStorage();
  const mediaQuery = createMediaQuery(false);
  const appliedThemes = [];
  const theme = createThemeController({
    storage,
    mediaQuery,
    applyNativeTheme: (value) => appliedThemes.push(value),
  });

  theme.start();
  theme.toggleTheme();
  mediaQuery.change(false);

  assert.equal(theme.effectiveTheme.value, "dark");
  assert.equal(storage.store[THEME_STORAGE_KEY], "dark");
  assert.deepEqual(appliedThemes, ["light", "dark"]);

  theme.stop();
});

test("unknown stored values fall back to the operating system theme", () => {
  const storage = createStorage({ [THEME_STORAGE_KEY]: "sepia" });
  const theme = createThemeController({
    storage,
    mediaQuery: createMediaQuery(true),
    applyNativeTheme() {},
  });

  theme.start();
  assert.equal(theme.effectiveTheme.value, "dark");
  theme.stop();
});
