import test from "node:test";
import assert from "node:assert/strict";

import {
  createTableFavoriteStore,
  loadTableFavoriteEntries,
  TABLE_FAVORITES_STORAGE_KEY,
} from "./composables/tableFavoriteStore.js";

function createStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    getItem(key) {
      return values[key] ?? null;
    },
    setItem(key, value) {
      values[key] = String(value);
    },
  };
}

test("table favorites persist independently for each connection and database", () => {
  const storage = createStorage();
  const store = createTableFavoriteStore({ storage });

  assert.equal(store.toggleFavorite("conn-a", "game", "orders"), true);
  assert.equal(store.toggleFavorite("conn-a", "game", "player"), true);
  assert.equal(store.toggleFavorite("conn-b", "game", "orders"), true);
  assert.deepEqual(store.favoriteNames("conn-a", "game"), ["orders", "player"]);
  assert.deepEqual(store.favoriteNames("conn-b", "game"), ["orders"]);

  const restored = createTableFavoriteStore({ storage });
  assert.equal(restored.isFavorite("conn-a", "game", "player"), true);
  assert.equal(restored.isFavorite("conn-a", "other", "player"), false);
});

test("table favorites toggle off and follow successful table renames", () => {
  const storage = createStorage();
  const store = createTableFavoriteStore({ storage });

  store.toggleFavorite("demo", "game", "orders");
  assert.equal(store.renameFavorite("demo", "game", "orders", "orders_archive"), true);
  assert.deepEqual(store.favoriteNames("demo", "game"), ["orders_archive"]);
  assert.equal(store.toggleFavorite("demo", "game", "orders_archive"), false);
  assert.deepEqual(store.favoriteNames("demo", "game"), []);
});

test("table favorites ignore malformed stored preferences", () => {
  const storage = createStorage({ [TABLE_FAVORITES_STORAGE_KEY]: "not-json" });
  assert.deepEqual(loadTableFavoriteEntries(storage), []);
});
