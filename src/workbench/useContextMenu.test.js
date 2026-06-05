import test from "node:test";
import assert from "node:assert/strict";

import { useContextMenu } from "./composables/useContextMenu.js";

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
