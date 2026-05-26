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
