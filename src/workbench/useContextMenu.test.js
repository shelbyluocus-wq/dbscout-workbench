import test from "node:test";
import assert from "node:assert/strict";

import { useContextMenu } from "./composables/useContextMenu.js";

test("opening a database context menu stores the database target", () => {
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => {},
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
    },
    { value: null },
  );

  menu.openContextMenu(
    { clientX: 8, clientY: 9 },
    { kind: "database", connectionId: "mysql-1", database: "live_game" },
  );

  assert.equal(menu.contextMenu.open, true);
  assert.equal(menu.contextMenu.x, 8);
  assert.equal(menu.contextMenu.y, 9);
  assert.equal(menu.contextMenu.kind, "database");
  assert.equal(menu.contextMenu.connectionId, "mysql-1");
  assert.equal(menu.contextMenu.database, "live_game");
  assert.equal(menu.contextMenu.tableName, "");
});

test("opening a table context menu stores table target kind and source", () => {
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => {},
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
    },
    { value: null },
  );

  menu.openContextMenu(
    { clientX: 2, clientY: 3 },
    { table_name: "hero", connectionId: "mysql-1", database: "dev_game" },
  );

  assert.equal(menu.contextMenu.kind, "table");
  assert.equal(menu.contextMenu.tableName, "hero");
  assert.equal(menu.contextMenu.connectionId, "mysql-1");
  assert.equal(menu.contextMenu.database, "dev_game");
});

test("opening a general context menu clears prior database target state", () => {
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => {},
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
    },
    { value: null },
  );

  menu.openContextMenu(
    { clientX: 8, clientY: 9 },
    { kind: "database", connectionId: "mysql-1", database: "live_game" },
  );
  menu.openContextMenu({ clientX: 4, clientY: 7 });

  assert.equal(menu.contextMenu.kind, "general");
  assert.equal(menu.contextMenu.connectionId, "");
  assert.equal(menu.contextMenu.database, "");
  assert.equal(menu.contextMenu.tableName, "");
});

test("refreshing a table targets its database source and does not refresh a same-named tab from another database", async () => {
  const schemaCalls = [];
  const fetchCalls = [];
  const activeTab = {
    value: {
      tableName: "hero",
      tableKey: "mysql-1\u001fdev_game\u001fhero",
      page: 1,
    },
  };
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => {},
      ensureTableSchema: async (...args) => schemaCalls.push(args),
      fetchPage: async (...args) => fetchCalls.push(args),
    },
    activeTab,
  );

  menu.openContextMenu(
    { clientX: 0, clientY: 0 },
    { table_name: "hero", connectionId: "mysql-1", database: "live_game" },
  );
  await menu.refreshFromContextMenu();

  assert.deepEqual(schemaCalls, [["hero", { connectionId: "mysql-1", database: "live_game" }]]);
  assert.equal(fetchCalls.length, 0);
});

test("refreshing a supplied active table reloads its current page", async () => {
  const schemaCalls = [];
  const fetchCalls = [];
  const activeTab = {
    value: {
      tableName: "hero",
      tableKey: "mysql-1\u001fdev_game\u001fhero",
      connectionId: "mysql-1",
      database: "dev_game",
      page: 3,
    },
  };
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => {},
      ensureTableSchema: async (...args) => schemaCalls.push(args),
      fetchPage: async (...args) => fetchCalls.push(args),
    },
    activeTab,
  );

  menu.openContextMenu({ clientX: 4, clientY: 7 }, activeTab.value);
  await menu.refreshFromContextMenu();

  assert.deepEqual(schemaCalls, [["hero", { connectionId: "mysql-1", database: "dev_game" }]]);
  assert.deepEqual(fetchCalls, [[activeTab.value, 3]]);
});

test("refreshing a general context reloads the object tree", async () => {
  const loadCalls = [];
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => loadCalls.push("load"),
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
    },
    { value: null },
  );

  menu.openContextMenu({ clientX: 4, clientY: 7 });
  await menu.refreshFromContextMenu();

  assert.deepEqual(loadCalls, ["load"]);
});
