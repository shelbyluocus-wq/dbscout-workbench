import test from "node:test";
import assert from "node:assert/strict";

import {
  createTableFolderStore,
  favoritesFolderId,
  LEGACY_TABLE_FAVORITES_STORAGE_KEY,
  loadTableFolders,
  TABLE_FOLDERS_STORAGE_KEY,
} from "./composables/tableFolderStore.js";

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

function clock() {
  let time = 1000;
  return () => (time += 1);
}

test("favorites persist independently for each connection and database", () => {
  const storage = createStorage();
  const store = createTableFolderStore({ storage });

  assert.equal(store.toggleFavorite("conn-a", "game", "orders"), true);
  assert.equal(store.toggleFavorite("conn-a", "game", "player"), true);
  assert.equal(store.toggleFavorite("conn-b", "game", "orders"), true);
  assert.deepEqual(store.favoriteNames("conn-a", "game"), ["orders", "player"]);
  assert.deepEqual(store.favoriteNames("conn-b", "game"), ["orders"]);

  const restored = createTableFolderStore({ storage });
  assert.equal(restored.isFavorite("conn-a", "game", "player"), true);
  assert.equal(restored.isFavorite("conn-a", "other", "player"), false);
  assert.equal(store.toggleFavorite("conn-a", "game", "player"), false);
  assert.deepEqual(store.favoriteNames("conn-a", "game"), ["orders"]);
});

test("favorites from earlier versions become each database's favorites folder", () => {
  const storage = createStorage({
    [LEGACY_TABLE_FAVORITES_STORAGE_KEY]: JSON.stringify({
      version: 1,
      entries: [{ connectionId: "demo", database: "game", tableNames: ["heroprop", "itemprop"] }],
    }),
  });
  const store = createTableFolderStore({ storage });
  const [favorites] = store.foldersFor("demo", "game");
  assert.equal(favorites.kind, "favorites");
  assert.equal(favorites.id, favoritesFolderId("demo", "game"));
  assert.deepEqual(favorites.tableNames, ["heroprop", "itemprop"]);

  // Once folders are written, the old list is no longer read.
  store.toggleFavorite("demo", "game", "itemprop");
  assert.deepEqual(createTableFolderStore({ storage }).favoriteNames("demo", "game"), ["heroprop"]);
});

test("every database lists its favorites folder first, even when empty", () => {
  const store = createTableFolderStore({ storage: createStorage(), now: clock() });
  store.createFolder({ connectionId: "demo", database: "game", name: "Heroes" });
  store.createFolder({ connectionId: "demo", database: "game", name: "Items" });
  store.createFolder({ connectionId: "demo", database: "other", name: "Elsewhere" });

  const listed = store.foldersFor("demo", "game");
  assert.deepEqual(listed.map((folder) => folder.kind), ["favorites", "folder", "folder"]);
  assert.deepEqual(listed.slice(1).map((folder) => folder.name), ["Heroes", "Items"]);
  assert.deepEqual(store.foldersFor("demo", ""), []);
});

test("folder names are required, unique per database and at most 40 characters", () => {
  const store = createTableFolderStore({ storage: createStorage(), now: clock() });
  assert.equal(store.createFolder({ connectionId: "demo", database: "game", name: "  " }).error, "empty");
  assert.equal(store.createFolder({ connectionId: "demo", database: "game", name: "x".repeat(41) }).error, "tooLong");
  const heroes = store.createFolder({ connectionId: "demo", database: "game", name: "Heroes" }).folder;
  assert.equal(store.createFolder({ connectionId: "demo", database: "game", name: "heroes" }).error, "duplicate");
  assert.equal(store.createFolder({ connectionId: "demo", database: "other", name: "Heroes" }).ok, true);
  assert.equal(store.suggestName("demo", "game", "Heroes"), "Heroes 2");

  const items = store.createFolder({ connectionId: "demo", database: "game", name: "Items" }).folder;
  assert.equal(store.renameFolder(items.id, "HEROES").error, "duplicate");
  assert.equal(store.renameFolder(heroes.id, "HEROES").ok, true);
  assert.equal(store.getFolder(heroes.id).name, "HEROES");
});

test("tables are added once, removed by name and kept in insertion order", () => {
  const store = createTableFolderStore({ storage: createStorage(), now: clock() });
  const folder = store.createFolder({ connectionId: "demo", database: "game", name: "Heroes" }).folder;
  assert.deepEqual(store.addTables(folder.id, ["heroprop", "skillprop", "heroprop"]), { added: 2, skipped: 0 });
  assert.deepEqual(store.addTables(folder.id, ["skillprop", "equipprop"]), { added: 1, skipped: 1 });
  assert.deepEqual(store.getFolder(folder.id).tableNames, ["heroprop", "skillprop", "equipprop"]);
  assert.equal(store.removeTables(folder.id, ["skillprop", "missing"]), 1);
  assert.deepEqual(store.getFolder(folder.id).tableNames, ["heroprop", "equipprop"]);
});

test("adding a folder copies the tables it holds now, within one database only", () => {
  const store = createTableFolderStore({ storage: createStorage(), now: clock() });
  const scope = { connectionId: "demo", database: "game" };
  const heroes = store.createFolder({ ...scope, name: "Heroes", tableNames: ["heroprop", "skillprop"] }).folder;
  const release = store.createFolder({ ...scope, name: "Release", tableNames: ["skillprop"] }).folder;
  const foreign = store.createFolder({ connectionId: "demo", database: "other", name: "Other", tableNames: ["x"] }).folder;

  assert.deepEqual(store.importFolder(release.id, heroes.id), { ok: true, added: 1, skipped: 1 });
  assert.deepEqual(store.getFolder(release.id).tableNames, ["skillprop", "heroprop"]);

  // Later changes to the source are not followed.
  store.addTables(heroes.id, ["mountprop"]);
  assert.deepEqual(store.getFolder(release.id).tableNames, ["skillprop", "heroprop"]);

  assert.equal(store.importFolder(release.id, foreign.id).ok, false);
  assert.equal(store.importFolder(release.id, release.id).ok, false);

  // Favorites take part like any other folder, even before they exist.
  const favoritesId = favoritesFolderId(scope.connectionId, scope.database);
  assert.deepEqual(store.importFolder(favoritesId, heroes.id, scope), { ok: true, added: 3, skipped: 0 });
  assert.deepEqual(store.favoriteNames("demo", "game"), ["heroprop", "skillprop", "mountprop"]);
});

test("a renamed table keeps its place in every folder of its database", () => {
  const store = createTableFolderStore({ storage: createStorage(), now: clock() });
  store.toggleFavorite("demo", "game", "orders");
  const folder = store.createFolder({ connectionId: "demo", database: "game", name: "A", tableNames: ["x", "orders"] }).folder;
  const other = store.createFolder({ connectionId: "demo", database: "other", name: "B", tableNames: ["orders"] }).folder;

  assert.equal(store.renameTable("demo", "game", "orders", "orders_archive"), true);
  assert.deepEqual(store.favoriteNames("demo", "game"), ["orders_archive"]);
  assert.deepEqual(store.getFolder(folder.id).tableNames, ["x", "orders_archive"]);
  assert.deepEqual(store.getFolder(other.id).tableNames, ["orders"]);
});

test("only user folders can be deleted; favorites stay", () => {
  const store = createTableFolderStore({ storage: createStorage(), now: clock() });
  store.toggleFavorite("demo", "game", "orders");
  const folder = store.createFolder({ connectionId: "demo", database: "game", name: "A" }).folder;
  assert.equal(store.deleteFolder(favoritesFolderId("demo", "game")), false);
  assert.equal(store.deleteFolder(folder.id), true);
  assert.deepEqual(store.foldersFor("demo", "game").map((item) => item.kind), ["favorites"]);
});

test("folder ids stay safe as window labels whatever the scope holds", () => {
  assert.match(favoritesFolderId("conn/with spaces", "数据库-1"), /^fav-[0-9a-f]{8}$/);
  const store = createTableFolderStore({ storage: createStorage() });
  const folder = store.createFolder({ connectionId: "a b", database: "c/d", name: "E" }).folder;
  assert.match(folder.id, /^[A-Za-z0-9_-]+$/);
});

test("malformed stored folders are ignored", () => {
  assert.deepEqual(loadTableFolders(createStorage({ [TABLE_FOLDERS_STORAGE_KEY]: "not-json" })), []);
  const storage = createStorage({
    [TABLE_FOLDERS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      folders: [
        { id: "fld-1", kind: "folder", name: "", connectionId: "demo", database: "game", tableNames: ["a"] },
        { id: "bad id!", kind: "folder", name: "X", connectionId: "demo", database: "game", tableNames: ["a"] },
        { id: "fld-2", kind: "folder", name: "Kept", connectionId: "demo", database: "game", tableNames: ["a", "", "a"] },
      ],
    }),
  });
  assert.deepEqual(loadTableFolders(storage).map((folder) => [folder.id, folder.tableNames]), [["fld-2", ["a"]]]);
});

test("scopes list databases that hold folders or favorites", () => {
  const store = createTableFolderStore({ storage: createStorage(), now: clock() });
  store.toggleFavorite("demo", "game", "orders");
  store.toggleFavorite("demo", "empty", "x");
  store.toggleFavorite("demo", "empty", "x");
  store.createFolder({ connectionId: "live", database: "game", name: "A" });
  assert.deepEqual(store.scopes(), [
    { connectionId: "demo", database: "game" },
    { connectionId: "live", database: "game" },
  ]);
});
