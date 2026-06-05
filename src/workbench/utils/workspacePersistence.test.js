import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  loadWorkspaceSnapshot,
  clearWorkspaceSnapshot,
} from "./workspacePersistence.js";

function installLocalStorage(initial = {}) {
  const store = { ...initial };
  globalThis.localStorage = {
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
  return store;
}

function cleanupLocalStorage() {
  delete globalThis.localStorage;
}

test("buildWorkspaceSnapshot extracts serializable fields from workspace state", () => {
  const snapshot = buildWorkspaceSnapshot({
    connectionId: "conn-1",
    database: "game",
    tabs: [
      {
        id: "tab-1",
        connectionId: "conn-1",
        database: "game",
        tableName: "items",
        tableComment: "道具表",
        filter: "sword",
        filterMode: "fuzzy",
        kind: "data",
        sort: { columnName: "id", descending: true },
        // Transient data that should be excluded:
        rows: [{ id: 1 }],
        columns: [{ name: "id" }],
        loading: false,
        selectedRowKeys: new Set(),
      },
    ],
    activeTabId: "tab-1",
  });

  assert.equal(snapshot.connectionId, "conn-1");
  assert.equal(snapshot.database, "game");
  assert.equal(snapshot.activeTabId, "tab-1");
  assert.equal(snapshot.tabs.length, 1);
  assert.equal(snapshot.tabs[0].tableName, "items");
  assert.equal(snapshot.tabs[0].kind, "data");
  assert.equal(snapshot.tabs[0].filter, "sword");
  assert.equal(snapshot.tabs[0].rows, undefined);
  assert.equal(snapshot.tabs[0].columns, undefined);
  assert.equal(snapshot.tabs[0].selectedRowKeys, undefined);
});

test("saveWorkspaceSnapshot and loadWorkspaceSnapshot round-trip correctly", () => {
  installLocalStorage();
  clearWorkspaceSnapshot();
  const snapshot = buildWorkspaceSnapshot({
    connectionId: "conn-2",
    database: "shop",
    tabs: [
      { id: "tab-3", kind: "data", tableName: "products", tableComment: "", connectionId: "conn-2", database: "shop" },
      { id: "tab-4", kind: "design", tableName: "orders", tableComment: "", connectionId: "conn-2", database: "shop" },
    ],
    activeTabId: "tab-4",
  });
  saveWorkspaceSnapshot(snapshot);

  const loaded = loadWorkspaceSnapshot();
  assert.deepEqual(loaded, {
    connectionId: "conn-2",
    database: "shop",
    tabs: [
      { id: "tab-3", kind: "data", tableName: "products", tableComment: "", connectionId: "conn-2", database: "shop", filter: "", filterMode: "fuzzy", sort: null },
      { id: "tab-4", kind: "design", tableName: "orders", tableComment: "", connectionId: "conn-2", database: "shop", filter: "", filterMode: "fuzzy", sort: null },
    ],
    activeTabId: "tab-4",
  });

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("loadWorkspaceSnapshot returns null when nothing is saved", () => {
  installLocalStorage();
  clearWorkspaceSnapshot();
  assert.equal(loadWorkspaceSnapshot(), null);
  cleanupLocalStorage();
});

test("loadWorkspaceSnapshot returns null for corrupt JSON", () => {
  installLocalStorage();
  localStorage.setItem("dbscout_workspace", "not-json{{{");
  assert.equal(loadWorkspaceSnapshot(), null);
  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("loadWorkspaceSnapshot filters out tabs without tableName", () => {
  installLocalStorage();
  saveWorkspaceSnapshot({
    connectionId: "c1",
    database: "db1",
    tabs: [
      { id: "tab-1", tableName: "valid" },
      { id: "tab-2" },
      { id: "tab-3", tableName: "" },
    ],
    activeTabId: "tab-1",
  });

  const loaded = loadWorkspaceSnapshot();
  assert.equal(loaded.tabs.length, 1);
  assert.equal(loaded.tabs[0].tableName, "valid");

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("loadWorkspaceSnapshot defaults missing tab kind to data", () => {
  installLocalStorage();
  saveWorkspaceSnapshot({
    connectionId: "c1",
    database: "db1",
    tabs: [{ id: "tab-1", tableName: "legacy_table", connectionId: "c1", database: "db1" }],
    activeTabId: "tab-1",
  });

  const loaded = loadWorkspaceSnapshot();
  assert.equal(loaded.tabs[0].kind, "data");

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("buildWorkspaceSnapshot persists design tab kind without design transient state", () => {
  const snapshot = buildWorkspaceSnapshot({
    connectionId: "conn-3",
    database: "game",
    tabs: [
      {
        id: "tab-9",
        kind: "design",
        connectionId: "conn-3",
        database: "game",
        tableName: "items",
        tableComment: "道具表",
        loading: true,
        saving: true,
        error: "failed",
        design: { columns: [{ name: "id" }] },
        draft: { columns: [{ name: "name" }] },
        dirty: true,
        preview: "ALTER TABLE items",
      },
    ],
    activeTabId: "tab-9",
  });

  assert.equal(snapshot.tabs[0].kind, "design");
  assert.equal(snapshot.tabs[0].design, undefined);
  assert.equal(snapshot.tabs[0].draft, undefined);
  assert.equal(snapshot.tabs[0].loading, undefined);
  assert.equal(snapshot.tabs[0].saving, undefined);
  assert.equal(snapshot.tabs[0].error, undefined);
  assert.equal(snapshot.tabs[0].dirty, undefined);
  assert.equal(snapshot.tabs[0].preview, undefined);
});

test("buildWorkspaceSnapshot handles empty/missing tabs gracefully", () => {
  const snapshot = buildWorkspaceSnapshot({
    connectionId: "",
    database: "",
    tabs: [],
    activeTabId: "",
  });
  assert.equal(snapshot.tabs.length, 0);
});
