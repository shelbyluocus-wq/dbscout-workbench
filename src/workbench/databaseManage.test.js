import test from "node:test";
import assert from "node:assert/strict";
import { mockWorkbenchInvoke, resetMockWorkbenchState } from "./mock/mockBackend.js";

test("list_server_charsets returns utf8mb4 with collations", async () => {
  resetMockWorkbenchState();
  const charsets = await mockWorkbenchInvoke("list_server_charsets", { connectionId: "demo" });
  const utf8mb4 = charsets.find((item) => item.charset === "utf8mb4");
  assert.ok(utf8mb4, "utf8mb4 charset should be present");
  assert.ok(Array.isArray(utf8mb4.collations) && utf8mb4.collations.length > 0);
});

test("create_database, get_database_properties, alter_database, and drop_database manage databases safely", async () => {
  resetMockWorkbenchState();

  await assert.rejects(
    mockWorkbenchInvoke("create_database", {
      request: { connectionId: "demo", database: "mysql", charset: "utf8mb4", collation: "utf8mb4_general_ci" },
    }),
    /系统数据库/,
  );

  const created = await mockWorkbenchInvoke("create_database", {
    request: { connectionId: "demo", database: "combat_log", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" },
  });
  assert.equal(created.database, "combat_log");
  assert.ok(created.databases.includes("combat_log"));

  await assert.rejects(
    mockWorkbenchInvoke("create_database", {
      request: { connectionId: "demo", database: "combat_log", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" },
    }),
    /已存在/,
  );

  const props = await mockWorkbenchInvoke("get_database_properties", {
    connectionId: "demo",
    database: "combat_log",
  });
  assert.equal(props.charset, "utf8mb4");
  assert.equal(props.collation, "utf8mb4_unicode_ci");

  await mockWorkbenchInvoke("alter_database", {
    request: { connectionId: "demo", database: "combat_log", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" },
  });
  const updatedProps = await mockWorkbenchInvoke("get_database_properties", {
    connectionId: "demo",
    database: "combat_log",
  });
  assert.equal(updatedProps.collation, "utf8mb4_0900_ai_ci");

  await assert.rejects(
    mockWorkbenchInvoke("drop_database", {
      request: { connectionId: "demo", database: "information_schema", confirmedName: "information_schema" },
    }),
    /系统数据库/,
  );

  await assert.rejects(
    mockWorkbenchInvoke("drop_database", {
      request: { connectionId: "demo", database: "combat_log", confirmedName: "wrong_name" },
    }),
    /不匹配/,
  );

  const dropped = await mockWorkbenchInvoke("drop_database", {
    request: { connectionId: "demo", database: "combat_log", confirmedName: "combat_log" },
  });
  assert.equal(dropped.databases.includes("combat_log"), false);
  const dbs = await mockWorkbenchInvoke("list_databases", { connectionId: "demo" });
  assert.equal(dbs.includes("combat_log"), false);
});

test("show_create_table returns CREATE TABLE DDL with columns and primary key", async () => {
  resetMockWorkbenchState();
  const tables = await mockWorkbenchInvoke("list_tables", { connectionId: "demo", database: "game_db" });
  const firstTable = tables[0].table_name;
  const result = await mockWorkbenchInvoke("show_create_table", {
    connectionId: "demo",
    database: "game_db",
    tableName: firstTable,
  });
  assert.equal(result.tableName, firstTable);
  assert.match(result.ddl, /^CREATE TABLE `game_db`\.`/);
  assert.match(result.ddl, /PRIMARY KEY/);
});

test("truncate_tables clears all rows while keeping the table definition", async () => {
  resetMockWorkbenchState();
  const tables = await mockWorkbenchInvoke("list_tables", { connectionId: "demo", database: "game_db" });
  const targetTable = tables[0].table_name;

  const before = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: targetTable,
  });
  assert.ok(before.rows.length > 0, "fixture table should initially have rows");

  const truncated = await mockWorkbenchInvoke("truncate_tables", {
    request: { connectionId: "demo", database: "game_db", tables: [targetTable] },
  });
  assert.equal(truncated.failed.length, 0);
  assert.equal(truncated.truncated.length, 1);

  const after = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: targetTable,
  });
  assert.equal(after.rows.length, 0);

  const tablesAfter = await mockWorkbenchInvoke("list_tables", { connectionId: "demo", database: "game_db" });
  assert.ok(tablesAfter.some((item) => item.table_name === targetTable));
});

test("copy_tables with structureOnly copies schema into the same database with zero rows", async () => {
  resetMockWorkbenchState();
  const tables = await mockWorkbenchInvoke("list_tables", { connectionId: "demo", database: "game_db" });
  const sourceTable = tables[0].table_name;

  const sourcePage = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: sourceTable,
  });
  assert.ok(sourcePage.rows.length > 0);

  const result = await mockWorkbenchInvoke("copy_tables", {
    request: {
      sourceConnectionId: "demo",
      sourceDatabase: "game_db",
      tableNames: [sourceTable],
      targetConnectionId: "demo",
      targetDatabase: "game_db",
      mode: "copy",
      structureOnly: true,
    },
  });
  assert.equal(result.status, "succeeded");
  const copiedName = result.copied[0].targetName;
  assert.notEqual(copiedName, sourceTable);

  const copiedPage = await mockWorkbenchInvoke("open_table_session", {
    connectionId: "demo",
    database: "game_db",
    tableName: copiedName,
  });
  assert.equal(copiedPage.rows.length, 0);
  assert.ok(copiedPage.columns.length > 0);
});
