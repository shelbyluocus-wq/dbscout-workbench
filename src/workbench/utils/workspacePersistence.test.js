import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  loadWorkspaceSnapshot,
  clearWorkspaceSnapshot,
  parseWorkspaceSnapshot,
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

test("workspace snapshots keep only valid manual column widths for each tab", () => {
  const snapshot = buildWorkspaceSnapshot({
    tabs: [{
      id: "tab-1",
      tableName: "items",
      columnWidthState: {
        widths: { id: 40, name: 1800, description: 220 },
        manual: { id: true, name: true },
      },
    }, {
      id: "tab-2",
      tableName: "players",
      columnWidthState: { widths: { id: 91 }, manual: { id: true } },
    }],
  });
  assert.deepEqual(snapshot.tabs[0].manualColumnWidths, { id: 40, name: 1800 });
  assert.deepEqual(snapshot.tabs[1].manualColumnWidths, { id: 91 });
  snapshot.tabs[0].manualColumnWidths.invalid = 1;
  const restored = parseWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.tabs[0].manualColumnWidths, { id: 40, name: 1800 });
  assert.deepEqual(restored.tabs[1].manualColumnWidths, { id: 91 });
});

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
    panes: {
      "pane-1": { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" },
    },
    layout: { type: "pane", paneId: "pane-1" },
    focusedPaneId: "pane-1",
  });

  assert.equal(snapshot.version, 4);
  assert.equal(snapshot.connectionId, "conn-1");
  assert.equal(snapshot.database, "game");
  assert.equal(snapshot.activeTabId, "tab-1");
  assert.equal(snapshot.focusedPaneId, "pane-1");
  assert.deepEqual(snapshot.layout, { type: "pane", paneId: "pane-1" });
  assert.deepEqual(snapshot.panes, {
    "pane-1": { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" },
  });
  assert.equal(snapshot.tabs.length, 1);
  assert.equal(snapshot.tabs[0].tableName, "items");
  assert.equal(snapshot.tabs[0].kind, "data");
  assert.equal(snapshot.tabs[0].filter, "sword");
  assert.equal(snapshot.tabs[0].rows, undefined);
  assert.equal(snapshot.tabs[0].columns, undefined);
  assert.equal(snapshot.tabs[0].selectedRowKeys, undefined);
});

test("SQL drafts persist without transient results", () => {
  const snapshot = buildWorkspaceSnapshot({
    tabs: [{
      id: "tab-sql",
      kind: "sql",
      connectionId: "conn-1",
      database: "game",
      title: "排查订单",
      sql: "SELECT * FROM orders",
      savedSql: "",
      dirty: true,
      limit: 5000,
      timeoutSeconds: 30,
      autoCommit: false,
      editorRatio: 0.6,
      resultSets: [{ rows: [{ id: 1 }] }],
    }],
    activeTabId: "tab-sql",
  });
  assert.equal(snapshot.tabs[0].kind, "sql");
  assert.equal(snapshot.tabs[0].sql, "SELECT * FROM orders");
  assert.equal(snapshot.tabs[0].limit, 5000);
  assert.equal(snapshot.tabs[0].resultSets, undefined);
});

test("SQL library and document identity survive workspace persistence", () => {
  installLocalStorage();
  const snapshot = buildWorkspaceSnapshot({
    tabs: [
      { id: "sql-library", kind: "sql-library", title: "SQL 查询" },
      { id: "sql-editor", kind: "sql", documentId: "doc-7", title: "查询 7", sql: "SELECT 7", dirty: true },
    ],
    activeTabId: "sql-library",
  });
  saveWorkspaceSnapshot(snapshot);

  const loaded = loadWorkspaceSnapshot();
  assert.deepEqual(loaded.tabs.map((tab) => tab.kind), ["sql-library", "sql"]);
  assert.equal(loaded.tabs[1].documentId, "doc-7");
  cleanupLocalStorage();
});

test("buildWorkspaceSnapshot excludes provisional opening tabs", () => {
  const snapshot = buildWorkspaceSnapshot({
    tabs: [
      { id: "tab-ready", kind: "data", tableName: "ready" },
      { id: "tab-opening", kind: "data", tableName: "opening", opening: true },
    ],
    activeTabId: "tab-ready",
    panes: {
      "pane-1": {
        id: "pane-1",
        tabIds: ["tab-ready", "tab-opening"],
        activeTabId: "tab-ready",
      },
    },
  });

  assert.deepEqual(snapshot.tabs.map((tab) => tab.id), ["tab-ready"]);
  assert.deepEqual(snapshot.panes["pane-1"].tabIds, ["tab-ready"]);
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
    panes: {
      "pane-1": { id: "pane-1", tabIds: ["tab-3"], activeTabId: "tab-3" },
      "pane-2": { id: "pane-2", tabIds: ["tab-4"], activeTabId: "tab-4" },
    },
    layout: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.62,
      first: { type: "pane", paneId: "pane-1" },
      second: { type: "pane", paneId: "pane-2" },
    },
    focusedPaneId: "pane-2",
  });
  saveWorkspaceSnapshot(snapshot);

  const loaded = loadWorkspaceSnapshot();
  assert.deepEqual(loaded, {
    version: 4,
    connectionId: "conn-2",
    database: "shop",
    tabs: [
      { id: "tab-3", kind: "data", tableName: "products", tableComment: "", connectionId: "conn-2", database: "shop", filter: "", filterMode: "continuous", sort: null, frozenRowStart: 0, frozenRowCount: 0, frozenColumnCount: 0, columnOrder: [], fieldCommentsExpanded: true, rowHeight: 28, fieldCommentHeight: 32, query: "", sortMode: "nameAsc", selectedTableNames: [], focusedTableName: "", readOnly: false },
      { id: "tab-4", kind: "design", tableName: "orders", tableComment: "", connectionId: "conn-2", database: "shop", filter: "", filterMode: "continuous", sort: null, frozenRowStart: 0, frozenRowCount: 0, frozenColumnCount: 0, columnOrder: [], fieldCommentsExpanded: true, rowHeight: 28, fieldCommentHeight: 32, query: "", sortMode: "nameAsc", selectedTableNames: [], focusedTableName: "", readOnly: false },
    ],
    activeTabId: "tab-4",
    panes: {
      "pane-1": { id: "pane-1", tabIds: ["tab-3"], activeTabId: "tab-3" },
      "pane-2": { id: "pane-2", tabIds: ["tab-4"], activeTabId: "tab-4" },
    },
    layout: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.62,
      first: { type: "pane", paneId: "pane-1" },
      second: { type: "pane", paneId: "pane-2" },
    },
    focusedPaneId: "pane-2",
  });

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("workspace snapshot preserves pane-local home state and field comment expansion", () => {
  installLocalStorage();
  const snapshot = buildWorkspaceSnapshot({
    connectionId: "demo",
    database: "shop",
    tabs: [
      { id: "home-left", kind: "home", connectionId: "demo", database: "shop", query: "vip", sortMode: "sizeDesc", selectedTableNames: ["vip_users"], focusedTableName: "vip_users" },
      { id: "table-left", kind: "data", connectionId: "demo", database: "shop", tableName: "vip_users", fieldCommentsExpanded: false, rowHeight: 42, fieldCommentHeight: 48 },
      { id: "home-right", kind: "home", connectionId: "demo", database: "shop", query: "orders", sortMode: "modifiedDesc", selectedTableNames: ["orders"], focusedTableName: "orders" },
    ],
    activeTabId: "home-right",
    panes: {
      "pane-1": { id: "pane-1", tabIds: ["home-left", "table-left"], activeTabId: "table-left" },
      "pane-2": { id: "pane-2", tabIds: ["home-right"], activeTabId: "home-right" },
    },
    layout: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: "pane-1" },
      second: { type: "pane", paneId: "pane-2" },
    },
    focusedPaneId: "pane-2",
  });
  saveWorkspaceSnapshot(snapshot);

  const loaded = loadWorkspaceSnapshot();
  assert.equal(loaded.version, 4);
  assert.deepEqual(loaded.tabs.filter((tab) => tab.kind === "home").map((tab) => ({
    id: tab.id,
    query: tab.query,
    sortMode: tab.sortMode,
    selectedTableNames: tab.selectedTableNames,
    focusedTableName: tab.focusedTableName,
  })), [
    { id: "home-left", query: "vip", sortMode: "sizeDesc", selectedTableNames: ["vip_users"], focusedTableName: "vip_users" },
    { id: "home-right", query: "orders", sortMode: "modifiedDesc", selectedTableNames: ["orders"], focusedTableName: "orders" },
  ]);
  assert.equal(loaded.tabs.find((tab) => tab.id === "table-left").fieldCommentsExpanded, false);
  assert.equal(loaded.tabs.find((tab) => tab.id === "table-left").rowHeight, 42);
  assert.equal(loaded.tabs.find((tab) => tab.id === "table-left").fieldCommentHeight, 48);
  assert.deepEqual(loaded.panes["pane-1"].tabIds, ["home-left", "table-left"]);
  assert.deepEqual(loaded.panes["pane-2"].tabIds, ["home-right"]);

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
  assert.equal(loaded.version, 4);
  assert.deepEqual(loaded.panes, {
    "pane-1": { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" },
  });
  assert.deepEqual(loaded.layout, { type: "pane", paneId: "pane-1" });
  assert.equal(loaded.focusedPaneId, "pane-1");

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("loadWorkspaceSnapshot migrates legacy snapshots into one pane", () => {
  installLocalStorage();
  localStorage.setItem("dbscout_workspace", JSON.stringify({
    connectionId: "legacy-conn",
    database: "legacy_db",
    tabs: [
      { id: "tab-1", tableName: "items", connectionId: "legacy-conn", database: "legacy_db" },
      { id: "tab-2", tableName: "quests", connectionId: "legacy-conn", database: "legacy_db" },
    ],
    activeTabId: "tab-2",
  }));

  const loaded = loadWorkspaceSnapshot();

  assert.equal(loaded.version, 4);
  assert.deepEqual(loaded.layout, { type: "pane", paneId: "pane-1" });
  assert.deepEqual(loaded.panes, {
    "pane-1": { id: "pane-1", tabIds: ["tab-1", "tab-2"], activeTabId: "tab-2" },
  });
  assert.equal(loaded.focusedPaneId, "pane-1");

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("loadWorkspaceSnapshot keeps v2 fallback layout inside saved panes", () => {
  installLocalStorage();
  localStorage.setItem("dbscout_workspace", JSON.stringify({
    version: 2,
    connectionId: "conn-1",
    database: "game",
    tabs: [
      { id: "tab-1", tableName: "items", connectionId: "conn-1", database: "game" },
    ],
    activeTabId: "tab-1",
    panes: {
      "pane-9": { id: "pane-9", tabIds: ["tab-1"], activeTabId: "tab-1" },
    },
    layout: { type: "pane", paneId: "missing-pane" },
    focusedPaneId: "missing-pane",
  }));

  const loaded = loadWorkspaceSnapshot();

  assert.deepEqual(loaded.layout, { type: "pane", paneId: "pane-9" });
  assert.equal(loaded.focusedPaneId, "pane-9");

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

test("buildWorkspaceSnapshot persists the frozen row anchor and counts", () => {
  installLocalStorage();
  clearWorkspaceSnapshot();
  const snapshot = buildWorkspaceSnapshot({
    connectionId: "conn-f",
    database: "db-f",
    tabs: [
      {
        id: "tab-f1",
        kind: "data",
        tableName: "frozen_table",
        connectionId: "conn-f",
        database: "db-f",
        frozenRowStart: 523,
        frozenRowCount: 3,
        frozenColumnCount: 2,
      },
    ],
    activeTabId: "tab-f1",
  });
  assert.equal(snapshot.tabs[0].frozenRowStart, 523);
  assert.equal(snapshot.tabs[0].frozenRowCount, 3);
  assert.equal(snapshot.tabs[0].frozenColumnCount, 2);
  saveWorkspaceSnapshot(snapshot);

  const loaded = loadWorkspaceSnapshot();
  assert.equal(loaded.tabs[0].frozenRowStart, 523);
  assert.equal(loaded.tabs[0].frozenRowCount, 3);
  assert.equal(loaded.tabs[0].frozenColumnCount, 2);

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("loadWorkspaceSnapshot defaults missing freeze fields to 0 (backward compat)", () => {
  installLocalStorage();
  // Simulate a legacy v2 snapshot written before freeze panes existed.
  localStorage.setItem("dbscout_workspace", JSON.stringify({
    version: 2,
    connectionId: "c1",
    database: "d1",
    tabs: [
      { id: "t1", tableName: "legacy", connectionId: "c1", database: "d1", filter: "", filterMode: "fuzzy", sort: null },
    ],
    activeTabId: "t1",
    panes: { "pane-1": { id: "pane-1", tabIds: ["t1"], activeTabId: "t1" } },
    layout: { type: "pane", paneId: "pane-1" },
    focusedPaneId: "pane-1",
  }));

  const loaded = loadWorkspaceSnapshot();
  assert.equal(loaded.tabs[0].frozenRowStart, 0);
  assert.equal(loaded.tabs[0].frozenRowCount, 0);
  assert.equal(loaded.tabs[0].frozenColumnCount, 0);
  assert.deepEqual(loaded.tabs[0].columnOrder, []);

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("buildWorkspaceSnapshot persists a custom column order", () => {
  installLocalStorage();
  clearWorkspaceSnapshot();
  const snapshot = buildWorkspaceSnapshot({
    connectionId: "conn-c",
    database: "db-c",
    tabs: [
      {
        id: "tab-c1",
        kind: "data",
        tableName: "hero",
        connectionId: "conn-c",
        database: "db-c",
        columnOrder: ["guild", "id", "name"],
      },
    ],
    activeTabId: "tab-c1",
  });
  assert.deepEqual(snapshot.tabs[0].columnOrder, ["guild", "id", "name"]);
  saveWorkspaceSnapshot(snapshot);

  const loaded = loadWorkspaceSnapshot();
  assert.deepEqual(loaded.tabs[0].columnOrder, ["guild", "id", "name"]);

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("relation tabs keep their filter and origin across a save and load", () => {
  installLocalStorage();
  clearWorkspaceSnapshot();
  const snapshot = buildWorkspaceSnapshot({
    connectionId: "conn-r",
    database: "game_config",
    tabs: [
      {
        id: "tab-r1",
        kind: "data",
        tableName: "item",
        connectionId: "conn-r",
        database: "game_config",
        filter: "fire",
        relationFilter: { column: "id", kind: "LISTCONTAINS", values: [" 1001 ", "1002", "1001"] },
        relationOrigin: {
          direction: "outgoing",
          sourceTable: "activity",
          sourceColumn: "reward_pool",
          targetTable: "item",
          targetColumn: "id",
        },
      },
      {
        id: "tab-r2",
        kind: "data",
        tableName: "hero",
        connectionId: "conn-r",
        database: "game_config",
        relationFilter: { column: "", values: ["1"] },
        relationOrigin: { direction: "incoming", sourceTable: "a", sourceColumn: "b", targetTable: "c", targetColumn: "d" },
      },
    ],
    activeTabId: "tab-r1",
  });
  assert.deepEqual(snapshot.tabs[0].relationFilter, {
    column: "id",
    kind: "listContains",
    values: ["1001", "1002"],
    itemKey: "ID",
  });
  assert.equal(Object.hasOwn(snapshot.tabs[1], "relationFilter"), false);
  assert.equal(Object.hasOwn(snapshot.tabs[1], "relationOrigin"), false);
  saveWorkspaceSnapshot(snapshot);

  const loaded = loadWorkspaceSnapshot();
  assert.deepEqual(loaded.tabs[0].relationFilter, snapshot.tabs[0].relationFilter);
  assert.deepEqual(loaded.tabs[0].relationOrigin, {
    direction: "outgoing",
    sourceTable: "activity",
    sourceColumn: "reward_pool",
    targetTable: "item",
    targetColumn: "id",
  });
  assert.equal(loaded.tabs[0].filter, "fire");
  assert.equal(Object.hasOwn(loaded.tabs[1], "relationFilter"), false);

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});

test("loadWorkspaceSnapshot drops malformed relation fields", () => {
  installLocalStorage();
  localStorage.setItem("dbscout_workspace", JSON.stringify({
    version: 4,
    tabs: [
      {
        id: "t1",
        kind: "data",
        tableName: "item",
        relationFilter: { column: "id", values: [] },
        relationOrigin: { direction: "outgoing", sourceTable: "a", sourceColumn: "b", targetTable: "c", targetColumn: "d" },
      },
      { id: "t2", kind: "data", tableName: "hero", relationFilter: "id=1", relationOrigin: 7 },
      {
        id: "t3",
        kind: "data",
        tableName: "skill",
        relationFilter: { column: "id", values: [5] },
        relationOrigin: { sourceTable: "hero" },
      },
    ],
    activeTabId: "t1",
  }));

  const loaded = loadWorkspaceSnapshot();
  assert.equal(Object.hasOwn(loaded.tabs[0], "relationFilter"), false);
  assert.equal(Object.hasOwn(loaded.tabs[0], "relationOrigin"), false);
  assert.equal(Object.hasOwn(loaded.tabs[1], "relationFilter"), false);
  assert.deepEqual(loaded.tabs[2].relationFilter, { column: "id", kind: "equals", values: ["5"] });
  assert.equal(Object.hasOwn(loaded.tabs[2], "relationOrigin"), false);

  clearWorkspaceSnapshot();
  cleanupLocalStorage();
});
