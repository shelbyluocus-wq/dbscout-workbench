import test from "node:test";
import assert from "node:assert/strict";

import { useContextMenu } from "./composables/useContextMenu.js";

test("opening a connection context menu stores the connection target", () => {
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
    { clientX: 12, clientY: 13 },
    { kind: "connection", connectionId: "mysql-1" },
  );

  assert.equal(menu.contextMenu.kind, "connection");
  assert.equal(menu.contextMenu.connectionId, "mysql-1");
  assert.equal(menu.contextMenu.database, "");
  assert.equal(menu.contextMenu.tableName, "");
});

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

test("refreshing a supplied active table clears stale cell errors after a successful reload", async () => {
  const clearedScopes = [];
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
      ensureTableSchema: async () => {},
      fetchPage: async () => ({ ok: true, tab: activeTab.value }),
    },
    activeTab,
    { onTablePageRefreshed: (tab) => clearedScopes.push(tab.tableKey) },
  );

  menu.openContextMenu({ clientX: 4, clientY: 7 }, activeTab.value);
  await menu.refreshFromContextMenu();

  assert.deepEqual(clearedScopes, ["mysql-1\u001fdev_game\u001fhero"]);
});

test("refreshing a general context reloads database list and object tree", async () => {
  const loadCalls = [];
  const refreshCalls = [];
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => loadCalls.push("load"),
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
      refreshDatabases: async () => {
        refreshCalls.push("refresh");
        return ["edota_3cfg", "test"];
      },
    },
    { value: null },
  );

  menu.openContextMenu({ clientX: 4, clientY: 7 });
  await menu.refreshFromContextMenu();

  assert.deepEqual(refreshCalls, ["refresh"]);
  assert.deepEqual(loadCalls, ["load"]);
});

test("refreshing a connection context reloads database list without reloading tables", async () => {
  const loadCalls = [];
  const refreshCalls = [];
  const statusText = { value: "" };
  const menu = useContextMenu(
    { statusText },
    {
      loadTables: async () => loadCalls.push("load"),
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
      refreshDatabases: async (payload = {}) => {
        refreshCalls.push(payload);
        return ["edota_3cfg"];
      },
    },
    { value: null },
  );

  menu.openContextMenu(
    { clientX: 4, clientY: 7 },
    { kind: "connection", connectionId: "mysql-1" },
  );
  await menu.refreshFromContextMenu();

  assert.deepEqual(refreshCalls, [{ connectionId: "mysql-1" }]);
  assert.deepEqual(loadCalls, []);
  assert.match(statusText.value, /已刷新数据库列表/);
});

test("refreshing a deleted database reports removal after reloading database list", async () => {
  const statusText = { value: "" };
  const menu = useContextMenu(
    { statusText },
    {
      loadTables: async () => assert.fail("should not load tables for removed database"),
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
      refreshDatabases: async () => ["edota_3cfg", "test"],
    },
    { value: null },
  );

  menu.openContextMenu(
    { clientX: 4, clientY: 7 },
    { kind: "database", connectionId: "mysql-1", database: "shopflow_test" },
  );
  await menu.refreshFromContextMenu();

  assert.match(statusText.value, /shopflow_test/);
  assert.match(statusText.value, /已不存在/);
});

test("opening design from a table-scoped context menu preserves source identity and closes", () => {
  const designCalls = [];
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => {},
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
    },
    { value: null },
    { openTableDesign: (source) => designCalls.push(source) },
  );

  menu.openContextMenu(
    { clientX: 4, clientY: 7 },
    {
      table_name: "hero",
      table_comment: "Hero roster",
      connectionId: "mysql-1",
      database: "dev_game",
    },
  );
  menu.openDesignFromContextMenu();

  assert.deepEqual(designCalls, [
    {
      connectionId: "mysql-1",
      database: "dev_game",
      tableName: "hero",
      tableComment: "Hero roster",
    },
  ]);
  assert.equal(menu.contextMenu.open, false);
});

test("opening design from a general context menu is a no-op", () => {
  const designCalls = [];
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => {},
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
    },
    { value: null },
    { openTableDesign: (source) => designCalls.push(source) },
  );

  menu.openContextMenu({ clientX: 4, clientY: 7 });
  menu.openDesignFromContextMenu();

  assert.deepEqual(designCalls, []);
  assert.equal(menu.contextMenu.open, false);
});

test("opening design from context keeps same-name tables scoped to their database", () => {
  const designCalls = [];
  const activeTab = {
    value: {
      tableName: "hero",
      tableKey: "mysql-1dev_gamehero",
      connectionId: "mysql-1",
      database: "dev_game",
      tableComment: "Development heroes",
    },
  };
  const menu = useContextMenu(
    { statusText: { value: "" } },
    {
      loadTables: async () => {},
      ensureTableSchema: async () => {},
      fetchPage: async () => {},
    },
    activeTab,
    { openTableDesign: (source) => designCalls.push(source) },
  );

  menu.openContextMenu(
    { clientX: 4, clientY: 7 },
    {
      tableName: "hero",
      tableComment: "Live heroes",
      connectionId: "mysql-1",
      database: "live_game",
    },
  );
  menu.openDesignFromContextMenu();

  assert.deepEqual(designCalls, [
    {
      connectionId: "mysql-1",
      database: "live_game",
      tableName: "hero",
      tableComment: "Live heroes",
    },
  ]);
});
