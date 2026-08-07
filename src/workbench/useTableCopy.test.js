import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import { useTableCopy } from "./composables/useTableCopy.js";

function connections() {
  return ref([
    { id: "mysql-source", kind: "mysql", label: "生产库", connected: true },
    { id: "mysql-target", kind: "mysql", label: "归档库", connected: true },
    { id: "clickhouse-readonly", kind: "clickhouse", label: "分析库", connected: true },
    { id: "mysql-offline", kind: "mysql", label: "离线库", connected: false },
  ]);
}

test("table copy loads databases per target connection and sends explicit source and target ids", async () => {
  const calls = [];
  const invokeWorkbench = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "list_tables") {
      return [
        { table_name: "orders", table_comment: "订单" },
        { table_name: "players", table_comment: "玩家" },
      ];
    }
    if (command === "list_databases") {
      return payload.connectionId === "mysql-source"
        ? ["game_db", "source_archive"]
        : ["warehouse", "history"];
    }
    if (command === "copy_tables") {
      return {
        status: "succeeded",
        copied: [{ originalName: "orders", targetName: "orders", rowCount: 42 }],
        warnings: [],
      };
    }
    throw new Error(`unexpected command: ${command}`);
  };
  const copy = useTableCopy({ connections: connections(), invokeWorkbench });

  await copy.open({
    connectionId: "mysql-source",
    database: "game_db",
    tableName: "orders",
  });

  assert.equal(copy.dialog.targetConnectionId, "mysql-source");
  assert.deepEqual(copy.targetDatabaseOptions.value, ["source_archive"]);
  assert.deepEqual(
    copy.targetConnectionOptions.value.map((connection) => connection.id),
    ["mysql-source", "mysql-target"],
    "read-only and disconnected connections must not be offered as targets",
  );

  await copy.setTargetConnection("mysql-target");
  assert.deepEqual(copy.targetDatabaseOptions.value, ["warehouse", "history"]);
  copy.dialog.targetDatabase = "warehouse";
  const result = await copy.execute();

  assert.equal(result.status, "succeeded");
  assert.equal(copy.dialog.status, "succeeded");
  const request = calls.find((call) => call.command === "copy_tables")?.payload?.request;
  assert.deepEqual(request, {
    sourceConnectionId: "mysql-source",
    sourceDatabase: "game_db",
    tableNames: ["orders"],
    targetConnectionId: "mysql-target",
    targetDatabase: "warehouse",
    mode: "copy",
  });
});

test("table copy preselects home-page selections and sends overwrite mode", async () => {
  const calls = [];
  const invokeWorkbench = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "list_tables") {
      return [
        { table_name: "orders", table_comment: "订单" },
        { table_name: "players", table_comment: "玩家" },
      ];
    }
    if (command === "list_databases") return ["game_db", "warehouse"];
    if (command === "copy_tables") return { status: "succeeded", copied: [], warnings: [] };
    throw new Error(`unexpected command: ${command}`);
  };
  const copy = useTableCopy({ connections: connections(), invokeWorkbench });

  await copy.open({
    connectionId: "mysql-source",
    database: "game_db",
    tableNames: ["orders", "players"],
  });

  assert.deepEqual([...copy.selectedTableNames], ["orders", "players"]);
  assert.equal(copy.dialog.mode, "copy", "每次打开都重置为创建副本模式");

  copy.dialog.targetDatabase = "warehouse";
  copy.dialog.mode = "overwrite";
  await copy.execute();

  const request = calls.find((call) => call.command === "copy_tables")?.payload?.request;
  assert.equal(request.mode, "overwrite");
  assert.deepEqual(request.tableNames, ["orders", "players"]);
});

test("stale target database requests cannot replace the latest connection options", async () => {
  const resolvers = new Map();
  const invokeWorkbench = async (command, payload) => {
    if (command === "list_tables") return [{ table_name: "orders" }];
    if (command === "list_databases") {
      return await new Promise((resolve) => resolvers.set(payload.connectionId, resolve));
    }
    return null;
  };
  const copy = useTableCopy({ connections: connections(), invokeWorkbench });
  const opened = copy.open({
    connectionId: "mysql-source",
    database: "game_db",
    tableName: "orders",
  });
  resolvers.get("mysql-source")(["game_db", "source_archive"]);
  await opened;

  const first = copy.setTargetConnection("mysql-target");
  const second = copy.setTargetConnection("mysql-source");
  resolvers.get("mysql-source")(["game_db", "latest_archive"]);
  await second;
  resolvers.get("mysql-target")(["stale_target"]);
  await first;

  assert.equal(copy.dialog.targetConnectionId, "mysql-source");
  assert.deepEqual(copy.targetDatabaseOptions.value, ["latest_archive"]);
});
