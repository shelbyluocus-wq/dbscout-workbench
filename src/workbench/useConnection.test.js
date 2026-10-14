import test from "node:test";
import assert from "node:assert/strict";
import { reactive, watch } from "vue";
import { createWorkspaceState, openDatabaseHomeTab, buildSchemaSearchResults } from "./workspaceState.js";
import { useConnection } from "./composables/useConnection.js";

function installLocalStorage(initial = {}) {
  const store = { ...initial };
  globalThis.localStorage = {
    getItem(key) {
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
  };
  return store;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushUntil(predicate, maxTurns = 200) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    await flushAsync();
    if (predicate()) return;
  }
  assert.fail("condition was not met before async flush limit");
}

function tableNames(list) {
  return list.map((table) => table.table_name || table.tableName);
}

test("schema search covers all 280 tables while a cold foreground open bypasses background loading", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const pending = deferred();
  const batches = [];
  const tables = Array.from({ length: 280 }, (_, i) => ({ table_name: `table_${i}` }));
  const schema = (name) => ({ table_name: name, columns: [{ column_name: "OpenCond", column_comment: "conditionplatprop" }] });
  const conn = useConnection(workspace, async (command, payload = {}) => {
    if (command === "select_database") return { tables };
    if (command === "get_table_schemas") {
      batches.push(payload.tableNames);
      if (batches.length === 1) await pending.promise;
      return payload.tableNames.map(schema);
    }
    return {};
  });
  try {
    await conn.selectDatabase({ connectionId: "mysql-5", database: "newsg_4cfg" });
    assert.equal(conn.busy.value, false);
    await conn.ensureTableSchema("table_279");
    assert.equal(workspace.schema[279].columns[0].column_comment, "conditionplatprop");
    pending.resolve();
    await flushUntil(() => workspace.schema.every((table) => table.schemaLoaded));
    assert.equal(buildSchemaSearchResults(workspace.schema, "conditionplatprop", { includedKinds: ["columnComment"] }).length, 280);
    assert.ok(batches.every((batch) => batch.length <= 80));
  } finally {
    pending.resolve();
    conn.dispose();
  }
});

test("late background and ordinary schema responses cannot restore a comment saved by a forced refresh", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const pending = deferred();
  const schema = (comment) => ({ table_name: "shopprop", columns: [{ column_name: "OpenCond", column_comment: comment }] });
  const conn = useConnection(workspace, async (command, payload = {}) => {
    if (command === "select_database") return { tables: [{ table_name: "shopprop" }] };
    if (command === "get_table_schemas") return payload.force ? [schema("conditionopencondprop")] : pending.promise;
    return {};
  });
  try {
    await conn.selectDatabase({ connectionId: "mysql-5", database: "newsg_4cfg" });
    const ordinary = conn.ensureTableSchema("shopprop");
    await flushAsync();
    await conn.ensureTableSchema("shopprop", { force: true });
    pending.resolve([schema("conditionplatprop")]);
    const late = await ordinary;
    await flushAsync();
    assert.equal(workspace.schema[0].columns[0].column_comment, "conditionopencondprop");
    assert.equal(late.columns[0].column_comment, "conditionopencondprop");
  } finally {
    pending.resolve([]);
    conn.dispose();
  }
});

test("switching databases stops the remaining background schema batches", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const oldBatch = deferred();
  const calls = [];
  const conn = useConnection(workspace, async (command, payload = {}) => {
    if (command === "select_database") return {
      tables: Array.from({ length: payload.database === "old" ? 280 : 1 }, (_, i) => ({ table_name: `table_${i}` })),
    };
    if (command === "get_table_schemas") {
      calls.push(payload);
      if (payload.database === "old") return oldBatch.promise;
      return payload.tableNames.map((table_name) => ({ table_name, columns: [{ column_name: "fresh" }] }));
    }
    return {};
  });
  try {
    await conn.selectDatabase({ connectionId: "mysql-5", database: "old" });
    await flushAsync();
    await conn.selectDatabase({ connectionId: "mysql-5", database: "new" });
    oldBatch.resolve(calls[0].tableNames.map((table_name) => ({ table_name, columns: [{ column_name: "old" }] })));
    await flushUntil(() => workspace.schema[0]?.schemaLoaded);
    assert.equal(calls.filter((call) => call.database === "old").length, 1);
    assert.equal(workspace.schema.length, 1);
    assert.equal(workspace.schema[0].columns[0].column_name, "fresh");
  } finally {
    oldBatch.resolve([]);
    conn.dispose();
  }
});

test("restores saved MySQL connections after restart", async () => {
  installLocalStorage({
    dbscout_connections: JSON.stringify([
      {
        host: "127.0.0.1",
        port: "3307",
        username: "root",
        password: "secret",
      },
    ]),
  });
  const calls = [];
  const workspace = createWorkspaceState();
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_connections") {
      const restored = calls.some((call) => call.command === "restore_connection");
      return restored
        ? [
            { id: "demo", label: "Demo", host: "demo", port: 3306, username: "root", database: "game_db", connected: true },
            { id: "mysql-1", label: "MySQL 1", host: "configured", port: 3306, username: "mysql", database: null, connected: true },
          ]
        : [{ id: "demo", label: "Demo", host: "demo", port: 3306, username: "root", database: "game_db", connected: true }];
    }
    if (command === "restore_connection") return ["analytics"];
    if (command === "list_databases") return payload.connectionId === "mysql-1" ? ["analytics"] : ["game_db"];
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return {};
  };
  const conn = useConnection(workspace, invoke);

  await conn.loadConnections();

  assert.ok(calls.some((call) => call.command === "restore_connection" && call.payload.url === "mysql://root:secret@127.0.0.1:3307"));
  assert.ok(conn.connections.value.some((connection) => connection.host === "127.0.0.1" && connection.connected));
  assert.equal(conn.selectedConnectionId.value, "mysql-1");
  assert.equal(conn.selectedDatabase.value, "analytics");
  assert.ok(calls.some((call) => call.command === "select_database" && call.payload.connectionId === "mysql-1" && call.payload.database === "analytics"));
});

test("restores saved ClickHouse connections with their database kind", async () => {
  installLocalStorage({
    dbscout_connections: JSON.stringify([
      {
        kind: "clickhouse",
        host: "127.0.0.1",
        port: "8123",
        username: "default",
        password: "secret",
        url: "http://default:secret@127.0.0.1:8123",
      },
    ]),
  });
  const calls = [];
  const workspace = createWorkspaceState();
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_connections") {
      const restored = calls.some((call) => call.command === "restore_connection");
      return restored
        ? [
            { id: "clickhouse-1", kind: "clickhouse", label: "ClickHouse 1", host: "configured", port: 8123, username: "clickhouse", database: null, connected: true, readOnly: true },
          ]
        : [];
    }
    if (command === "restore_connection") return ["analytics"];
    if (command === "list_databases") return ["analytics"];
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return {};
  };
  const conn = useConnection(workspace, invoke);

  await conn.loadConnections();

  assert.ok(calls.some((call) => call.command === "restore_connection" && call.payload.kind === "clickhouse" && call.payload.url === "http://default:secret@127.0.0.1:8123"));
  assert.ok(conn.connections.value.some((connection) => connection.kind === "clickhouse" && connection.host === "127.0.0.1" && connection.readOnly));
  assert.equal(conn.selectedConnectionId.value, "clickhouse-1");
  assert.equal(conn.selectedDatabase.value, "analytics");
});

test("restores saved MongoDB connections without treating them as MySQL", async () => {
  installLocalStorage({
    dbscout_connections: JSON.stringify([
      {
        kind: "mongodb",
        host: "127.0.0.1",
        port: "27017",
        username: "",
        password: "",
        url: "mongodb://127.0.0.1:27017",
      },
    ]),
  });
  const calls = [];
  const workspace = createWorkspaceState();
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_connections") {
      const restored = calls.some((call) => call.command === "restore_connection");
      return restored
        ? [
            { id: "mongodb-1", kind: "mongodb", label: "MongoDB 1", host: "configured", port: 27017, username: "", database: null, connected: true, readOnly: false },
          ]
        : [];
    }
    if (command === "restore_connection") return ["game_db"];
    if (command === "list_databases") return ["game_db"];
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return {};
  };
  const conn = useConnection(workspace, invoke);

  await conn.loadConnections();

  assert.ok(calls.some((call) => call.command === "restore_connection" && call.payload.kind === "mongodb" && call.payload.url === "mongodb://127.0.0.1:27017"));
  assert.ok(conn.connections.value.some((connection) => connection.kind === "mongodb" && connection.host === "127.0.0.1" && !connection.readOnly));
  assert.equal(conn.connectionCapability("mongodb-1", "gridEdit"), true);
  assert.equal(conn.connectionCapability("mongodb-1", "sqlConsole"), false);
  assert.equal(conn.selectedConnectionId.value, "mongodb-1");
  assert.equal(conn.selectedDatabase.value, "game_db");
});

test("loadConnections keeps an empty connection state when the backend has no connections", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const calls = [];
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_connections") return [];
    assert.fail(`unexpected command: ${command}`);
  };
  const conn = useConnection(workspace, invoke);

  await conn.loadConnections();

  assert.deepEqual(conn.connections.value, []);
  assert.equal(conn.selectedConnectionId.value, "");
  assert.equal(conn.selectedDatabase.value, "");
  assert.deepEqual(conn.databases.value, []);
  assert.match(conn.statusText.value, /新建数据库连接/);
  assert.deepEqual(calls, [{ command: "list_connections", payload: {} }]);
});

test("does not expose the default database list while restoring the startup connection", async () => {
  installLocalStorage({
    dbscout_workspace: JSON.stringify({ connectionId: "mysql-1", database: "analytics", tabs: [], activeTabId: "" }),
  });
  const workspace = createWorkspaceState();
  const observedDatabaseLists = [];
  const invoke = async (command, payload = {}) => {
    if (command === "list_connections") {
      return [
        { id: "demo", label: "Demo", host: "demo", port: 3306, username: "root", database: "game_db", connected: true },
        { id: "mysql-1", label: "MySQL 1", host: "configured", port: 3306, username: "mysql", database: null, connected: true },
      ];
    }
    if (command === "list_databases") return payload.connectionId === "mysql-1" ? ["analytics"] : ["game_db"];
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return {};
  };
  const conn = useConnection(workspace, invoke);
  const stopWatching = watch(
    () => conn.databases.value.map(String).join(""),
    () => observedDatabaseLists.push([...conn.databases.value]),
    { flush: "sync" },
  );

  await conn.loadConnections();
  stopWatching();

  assert.deepEqual(observedDatabaseLists, [["analytics"]]);
});

test("restores multiple saved MySQL connections", async () => {
  installLocalStorage({
    dbscout_connections: JSON.stringify([
      { host: "127.0.0.1", port: "3307", username: "root", password: "a" },
      { host: "127.0.0.1", port: "3308", username: "report", password: "b" },
    ]),
  });
  const calls = [];
  const workspace = createWorkspaceState();
  const restoredUrls = [];
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_connections") {
      return [
        { id: "demo", label: "Demo", host: "demo", port: 3306, username: "root", database: "game_db", connected: true },
        ...restoredUrls.map((url, index) => ({ id: `mysql-${index + 1}`, label: `MySQL ${index + 1}`, host: "configured", port: 3306, username: "mysql", database: null, connected: true, url })),
      ];
    }
    if (command === "restore_connection") {
      restoredUrls.push(payload.url);
      return ["game_db"];
    }
    if (command === "list_databases") return ["game_db"];
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return {};
  };
  const conn = useConnection(workspace, invoke);

  await conn.loadConnections();

  assert.equal(calls.filter((call) => call.command === "restore_connection").length, 2);
  assert.equal(conn.connections.value.filter((connection) => connection.host === "127.0.0.1").length, 2);
});

test("selecting a saved disconnected connection asks for password when restore fails", async () => {
  installLocalStorage({
    dbscout_connections: JSON.stringify([{ host: "127.0.0.1", port: "3309", username: "root" }]),
  });
  const workspace = createWorkspaceState();
  const invoke = async (command) => {
    if (command === "restore_connection") throw new Error("missing password");
    return [];
  };
  const conn = useConnection(workspace, invoke);
  conn.connections.value = [{ id: "saved-127.0.0.1:3309:root", label: "root@127.0.0.1:3309", host: "127.0.0.1", port: "3309", username: "root", connected: false, saved: true }];

  await conn.selectConnection("saved-127.0.0.1:3309:root");

  assert.equal(conn.connDialog.open, true);
  assert.equal(conn.connDialog.host, "127.0.0.1");
  assert.match(conn.connDialog.error, /重新输入密码/);
});

test("submitConnDialog deduplicates saved localStorage entries", async () => {
  const store = installLocalStorage({
    dbscout_connections: JSON.stringify([{ host: "127.0.0.1", port: "3307", username: "root", password: "old" }]),
  });
  const workspace = createWorkspaceState();
  const invoke = async (command) => {
    if (command === "add_connection") return ["game_db"];
    if (command === "list_connections") return [{ id: "mysql-1", label: "MySQL 1", connected: true }];
    return [];
  };
  const conn = useConnection(workspace, invoke);
  conn.connDialog.host = "127.0.0.1";
  conn.connDialog.port = "3307";
  conn.connDialog.username = "root";
  conn.connDialog.password = "new";

  await conn.submitConnDialog();

  const saved = JSON.parse(store.dbscout_connections);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].password, "new");
});

test("successful saved-connection restore replaces its placeholder with the runtime connection", async () => {
  installLocalStorage({
    dbscout_connections: JSON.stringify([{ kind: "mysql", host: "127.0.0.1", port: "3309", username: "root", password: "secret" }]),
  });
  const workspace = createWorkspaceState();
  const calls = [];
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "restore_connection") return ["analytics"];
    if (command === "list_connections") return [{ id: "mysql-1", kind: "mysql", label: "MySQL 1", host: "configured", port: 3306, username: "mysql", connected: true }];
    if (command === "list_databases") return ["analytics"];
    if (command === "select_database") return { tables: [] };
    return [];
  };
  const conn = useConnection(workspace, invoke);
  conn.connections.value = [{ id: "saved-mysql:127.0.0.1:3309:root", kind: "mysql", label: "root@127.0.0.1:3309", host: "127.0.0.1", port: "3309", username: "root", connected: false, saved: true }];

  await conn.selectConnection("saved-mysql:127.0.0.1:3309:root");

  assert.deepEqual(conn.connections.value.map((connection) => connection.id), ["mysql-1"]);
  assert.equal(conn.connections.value[0].host, "127.0.0.1");
  assert.equal(conn.selectedConnectionId.value, "mysql-1");
});

test("saved placeholder binds to an already restored runtime connection without reconnecting", async () => {
  installLocalStorage({
    dbscout_connections: JSON.stringify([{ kind: "mysql", host: "127.0.0.1", port: "3309", username: "root", password: "secret" }]),
  });
  const workspace = createWorkspaceState();
  const calls = [];
  const invoke = async (command) => {
    calls.push(command);
    if (command === "list_databases") return ["analytics"];
    if (command === "select_database") return { tables: [] };
    return [];
  };
  const conn = useConnection(workspace, invoke);
  const placeholderId = "saved-mysql:127.0.0.1:3309:root";
  conn.connections.value = [
    { id: "mysql-1", kind: "mysql", label: "root@127.0.0.1:3309", host: "127.0.0.1", port: "3309", username: "root", connected: true },
    { id: placeholderId, kind: "mysql", label: "root@127.0.0.1:3309", host: "127.0.0.1", port: "3309", username: "root", connected: false, saved: true },
  ];

  await conn.selectConnection(placeholderId);

  assert.equal(calls.includes("restore_connection"), false);
  assert.deepEqual(conn.connections.value.map((connection) => connection.id), ["mysql-1"]);
  assert.equal(conn.selectedConnectionId.value, "mysql-1");
});

test("concurrent saved-connection selections share one restore request", async () => {
  installLocalStorage({
    dbscout_connections: JSON.stringify([{ kind: "mysql", host: "127.0.0.1", port: "3309", username: "root", password: "secret" }]),
  });
  const workspace = createWorkspaceState();
  const restoreGate = deferred();
  let restoreCount = 0;
  const invoke = async (command) => {
    if (command === "restore_connection") {
      restoreCount += 1;
      return restoreGate.promise;
    }
    if (command === "list_connections") return [{ id: "mysql-1", kind: "mysql", label: "MySQL 1", host: "configured", port: 3306, username: "mysql", connected: true }];
    if (command === "list_databases") return ["analytics"];
    if (command === "select_database") return { tables: [] };
    return [];
  };
  const conn = useConnection(workspace, invoke);
  const placeholder = { id: "saved-mysql:127.0.0.1:3309:root", kind: "mysql", label: "root@127.0.0.1:3309", host: "127.0.0.1", port: "3309", username: "root", connected: false, saved: true };
  conn.connections.value = [placeholder];

  const first = conn.selectConnection(placeholder.id);
  const second = conn.selectConnection(placeholder.id);
  await flushUntil(() => restoreCount === 1);
  restoreGate.resolve(["analytics"]);
  await Promise.all([first, second]);

  assert.equal(restoreCount, 1);
  assert.deepEqual(conn.connections.value.map((connection) => connection.id), ["mysql-1"]);
});

test("testConnDialog calls backend without saving connection", async () => {
  const store = installLocalStorage();
  const workspace = createWorkspaceState();
  const calls = [];
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "test_connection") return null;
    return [];
  };
  const conn = useConnection(workspace, invoke);
  conn.connDialog.host = "127.0.0.1";
  conn.connDialog.port = "3306";
  conn.connDialog.username = "root";
  conn.connDialog.password = "secret";

  await conn.testConnDialog();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    command: "test_connection",
    payload: { kind: "mysql", url: "mysql://root:secret@127.0.0.1:3306" },
  });
  assert.equal(conn.connDialog.testPassed, true);
  assert.equal(conn.connDialog.error, "");
  assert.equal(JSON.parse(store.dbscout_connections || "[]").length, 0);
});

test("testConnDialog rejects empty password without calling backend", async () => {
  const workspace = createWorkspaceState();
  const calls = [];
  const invoke = async (command) => {
    calls.push(command);
    return null;
  };
  const conn = useConnection(workspace, invoke);
  conn.connDialog.host = "127.0.0.1";
  conn.connDialog.port = "3306";
  conn.connDialog.username = "root";
  conn.connDialog.password = "";

  await conn.testConnDialog();

  assert.equal(calls.length, 0);
  assert.equal(conn.connDialog.error, "请输入密码后再测试连接");
  assert.equal(conn.connTestBusy.value, false);
});

test("testConnDialog resets success state when connection fields change", async () => {
  const workspace = createWorkspaceState();
  const invoke = async (command) => {
    if (command === "test_connection") return null;
    return [];
  };
  const conn = useConnection(workspace, invoke);
  conn.connDialog.host = "127.0.0.1";
  conn.connDialog.port = "3306";
  conn.connDialog.username = "root";
  conn.connDialog.password = "secret";

  await conn.testConnDialog();
  assert.equal(conn.connDialog.testPassed, true);

  conn.onConnDialogFieldChange();
  assert.equal(conn.connDialog.testPassed, false);
});

test("testConnDialog surfaces friendly Chinese errors", async () => {
  const workspace = createWorkspaceState();
  const invoke = async (command) => {
    if (command === "test_connection") throw new Error("Access denied for user 'root'@'localhost'");
    return [];
  };
  const conn = useConnection(workspace, invoke);
  conn.connDialog.host = "127.0.0.1";
  conn.connDialog.port = "3306";
  conn.connDialog.username = "root";
  conn.connDialog.password = "wrong";

  await conn.testConnDialog();

  assert.equal(conn.connDialog.testPassed, false);
  assert.equal(conn.connDialog.error, "认证失败：用户名或密码错误");
});

test("submitConnDialog can add and persist a ClickHouse read-only connection", async () => {
  const store = installLocalStorage();
  const workspace = createWorkspaceState();
  const calls = [];
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "add_connection") return ["analytics"];
    if (command === "list_connections") {
      return [{ id: "clickhouse-1", kind: "clickhouse", label: "ClickHouse 1", connected: true, readOnly: true }];
    }
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return [];
  };
  const conn = useConnection(workspace, invoke);
  conn.connDialog.kind = "clickhouse";
  conn.connDialog.host = "ch.local";
  conn.connDialog.port = "8123";
  conn.connDialog.username = "default";
  conn.connDialog.password = "secret";

  await conn.submitConnDialog();

  assert.deepEqual(calls.find((call) => call.command === "add_connection"), {
    command: "add_connection",
    payload: { kind: "clickhouse", url: "http://default:secret@ch.local:8123" },
  });
  const saved = JSON.parse(store.dbscout_connections);
  assert.equal(saved[0].kind, "clickhouse");
  assert.equal(saved[0].url, "http://default:secret@ch.local:8123");
  assert.equal(conn.connections.value[0].readOnly, true);
});

test("submitConnDialog can add a MongoDB connection without username or password", async () => {
  const store = installLocalStorage();
  const workspace = createWorkspaceState();
  const calls = [];
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "add_connection") return ["game_db"];
    if (command === "list_connections") {
      return [{ id: "mongodb-1", kind: "mongodb", label: "MongoDB 1", connected: true, readOnly: false }];
    }
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return [];
  };
  const conn = useConnection(workspace, invoke);
  conn.connDialog.kind = "mongodb";
  conn.connDialog.host = "127.0.0.1";
  conn.connDialog.port = "27017";
  conn.connDialog.username = "";
  conn.connDialog.password = "";

  await conn.submitConnDialog();

  assert.deepEqual(calls.find((call) => call.command === "add_connection"), {
    command: "add_connection",
    payload: { kind: "mongodb", url: "mongodb://127.0.0.1:27017" },
  });
  const saved = JSON.parse(store.dbscout_connections);
  assert.equal(saved[0].kind, "mongodb");
  assert.equal(saved[0].url, "mongodb://127.0.0.1:27017");
  assert.equal(conn.connections.value[0].kind, "mongodb");
  assert.equal(conn.connections.value[0].readOnly, false);
  assert.match(conn.statusText.value, /已连接 MongoDB/);
});

test("applyConnConfigImport fills the dialog and submit prefers imported database", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const calls = [];
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "add_connection") return ["analytics", "edota_3cfg"];
    if (command === "list_connections") return [{ id: "mysql-1", label: "MySQL 1", connected: true }];
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return [];
  };
  const conn = useConnection(workspace, invoke);

  conn.applyConnConfigImport({
    kind: "mysql",
    host: "192.168.1.223",
    port: "8306",
    username: "root",
    password: "secret",
    database: "edota_3cfg",
  });

  assert.equal(conn.connDialog.open, true);
  assert.equal(conn.connDialog.host, "192.168.1.223");
  assert.equal(conn.connDialog.port, "8306");
  assert.equal(conn.connDialog.username, "root");
  assert.equal(conn.connDialog.password, "secret");
  assert.equal(conn.connDialog.importedDatabase, "edota_3cfg");
  assert.equal(conn.connDialog.error, "");

  await conn.submitConnDialog();

  assert.deepEqual(calls.find((call) => call.command === "select_database"), {
    command: "select_database",
    payload: { connectionId: "mysql-1", database: "edota_3cfg" },
  });
});

test("applyConnConfigImport defaults kind-specific blank fields", () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const conn = useConnection(workspace, async () => []);

  conn.applyConnConfigImport({
    kind: "clickhouse",
    host: "analytics.local",
  });

  assert.equal(conn.connDialog.kind, "clickhouse");
  assert.equal(conn.connDialog.host, "analytics.local");
  assert.equal(conn.connDialog.port, "8123");
  assert.equal(conn.connDialog.username, "default");
});

test("reorders MySQL connections and persists the preferred order", () => {
  const store = installLocalStorage();
  const workspace = createWorkspaceState();
  const conn = useConnection(workspace, async () => []);
  conn.connections.value = [
    { id: "demo", label: "Demo" },
    { id: "mysql-1", label: "First" },
    { id: "mysql-2", label: "Second" },
  ];

  conn.reorderConnections("mysql-2", "demo");

  assert.deepEqual(conn.connections.value.map((connection) => connection.id), ["mysql-2", "demo", "mysql-1"]);
  assert.deepEqual(JSON.parse(store.dbscout_connection_order), ["mysql-2", "demo", "mysql-1"]);

  conn.reorderConnections("mysql-2", "mysql-1", { position: "after" });

  assert.deepEqual(conn.connections.value.map((connection) => connection.id), ["demo", "mysql-1", "mysql-2"]);
  assert.deepEqual(JSON.parse(store.dbscout_connection_order), ["demo", "mysql-1", "mysql-2"]);
});

test("refreshDatabases reloads database list and drops removed databases from stored order", async () => {
  const store = installLocalStorage();
  store.dbscout_database_order = JSON.stringify({
    "mysql-1": ["shopflow_test", "edota_3cfg", "test"],
  });
  const workspace = createWorkspaceState();
  const conn = useConnection(workspace, async (command) => {
    if (command === "list_databases") return ["edota_3cfg", "test"];
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return {};
  });
  conn.selectedConnectionId.value = "mysql-1";
  conn.selectedDatabase.value = "shopflow_test";
  conn.databases.value = ["shopflow_test", "edota_3cfg", "test"];

  const refreshed = await conn.refreshDatabases({ connectionId: "mysql-1" });

  assert.deepEqual(refreshed, ["edota_3cfg", "test"]);
  assert.deepEqual(conn.databases.value, ["edota_3cfg", "test"]);
  assert.equal(conn.selectedDatabase.value, "edota_3cfg");
  assert.deepEqual(JSON.parse(store.dbscout_database_order), {
    "mysql-1": ["edota_3cfg", "test"],
  });
});

test("reorders databases per selected MySQL connection and persists the preferred order", () => {
  const store = installLocalStorage();
  const workspace = createWorkspaceState();
  const conn = useConnection(workspace, async () => []);
  conn.selectedConnectionId.value = "mysql-1";
  conn.databases.value = ["game_db", "analytics", "logs"];

  conn.reorderDatabases("logs", "analytics");

  assert.deepEqual(conn.databases.value, ["game_db", "logs", "analytics"]);
  assert.deepEqual(JSON.parse(store.dbscout_database_order), {
    "mysql-1": ["game_db", "logs", "analytics"],
  });

  conn.reorderDatabases("game_db", "analytics", { position: "after" });

  assert.deepEqual(conn.databases.value, ["logs", "analytics", "game_db"]);
  assert.deepEqual(JSON.parse(store.dbscout_database_order), {
    "mysql-1": ["logs", "analytics", "game_db"],
  });
});

test("selects a database for the requested connection", async () => {
  installLocalStorage();
  const calls = [];
  const workspace = createWorkspaceState();
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_tables") return [];
    return {};
  };
  const conn = useConnection(workspace, invoke);

  await conn.selectDatabase({ connectionId: "mysql-second", database: "analytics" });

  assert.deepEqual(calls[0], {
    command: "select_database",
    payload: { connectionId: "mysql-second", database: "analytics" },
  });
  assert.deepEqual(calls[1], {
    command: "list_tables",
    payload: { connectionId: "mysql-second", database: "analytics" },
  });
  assert.equal(conn.selectedConnectionId.value, "mysql-second");
  assert.equal(conn.selectedDatabase.value, "analytics");
  assert.equal(workspace.database, "analytics");
});

test("selecting a connection can go directly to a requested database", async () => {
  installLocalStorage();
  const calls = [];
  const workspace = createWorkspaceState();
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_databases") return ["default_db", "analytics"];
    if (command === "select_database") return { tables: [] };
    return {};
  };
  const conn = useConnection(workspace, invoke);
  conn.connections.value = [{ id: "mysql-second", label: "Second", connected: true }];

  await conn.selectConnection("mysql-second", { preferredDatabase: "analytics" });

  assert.equal(conn.selectedDatabase.value, "analytics");
  assert.deepEqual(
    calls.filter((call) => call.command === "select_database"),
    [{ command: "select_database", payload: { connectionId: "mysql-second", database: "analytics" } }],
  );
});

test("selecting a connection ignores a restored database that no longer exists", async () => {
  installLocalStorage();
  const calls = [];
  const workspace = createWorkspaceState();
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_databases") return ["newsgcfg"];
    if (command === "select_database") return { tables: [] };
    return {};
  };
  const conn = useConnection(workspace, invoke);
  conn.connections.value = [{
    id: "mysql-main",
    label: "Main",
    connected: true,
    database: "edota_15cfg",
  }];

  await conn.selectConnection("mysql-main");

  assert.equal(conn.selectedDatabase.value, "newsgcfg");
  assert.deepEqual(
    calls.filter((call) => call.command === "select_database"),
    [{ command: "select_database", payload: { connectionId: "mysql-main", database: "newsgcfg" } }],
  );
});

test("switching MySQL connections retargets an existing homepage for the same database name", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState({ connectionId: "mysql-old", database: "game" });
  const home = openDatabaseHomeTab(workspace);
  home.query = "old search";
  home.selectedTableNames = ["old_table"];
  const conn = useConnection(workspace, async (command) => {
    if (command === "select_database") {
      return {
        tables: [{ table_name: "new_table", columns: [{ column_name: "id" }], schemaLoaded: true }],
      };
    }
    return {};
  });
  conn.selectedConnectionId.value = "mysql-old";
  conn.selectedDatabase.value = "game";

  await conn.selectDatabase({ connectionId: "mysql-new", database: "game" });

  assert.equal(home.connectionId, "mysql-new");
  assert.equal(home.databaseKey, "mysql-new\u001fgame");
  assert.equal(home.tabKey, "home\u001fmysql-new\u001fgame");
  assert.equal(home.query, "");
  assert.deepEqual(home.selectedTableNames, []);
  assert.deepEqual(tableNames(workspace.schema), ["new_table"]);
});

test("select_database owns the table list without an immediate list_tables duplicate", async () => {
  installLocalStorage();
  const calls = [];
  const workspace = createWorkspaceState();
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "select_database") {
      return {
        tableCount: 2,
        columnCount: 0,
        tables: [{ table_name: "hero" }, { table_name: "item" }],
      };
    }
    if (command === "list_tables") throw new Error("duplicate table list");
    if (command === "get_table_schemas") {
      return payload.tableNames.map((tableName) => ({ table_name: tableName, columns: [] }));
    }
    return {};
  };
  const conn = useConnection(workspace, invoke);

  await conn.selectDatabase({ connectionId: "mysql-1", database: "game" });
  await flushAsync();

  assert.deepEqual(tableNames(workspace.tables), ["hero", "item"]);
  assert.equal(calls.filter((call) => call.command === "select_database").length, 1);
  assert.equal(calls.filter((call) => call.command === "list_tables").length, 0);
  assert.equal(calls.filter((call) => call.command === "get_table_schemas").length, 1);
});

test("select_database keeps complete schemas supplied with the table list", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const columns = [{ column_name: "id" }, { column_name: "display_name" }];
  const calls = [];
  const conn = useConnection(workspace, async (command) => {
    calls.push(command);
    if (command === "select_database") {
      return {
        tableCount: 1,
        columnCount: columns.length,
        tables: [{ table_name: "hero", columns, schemaLoaded: true }],
      };
    }
    if (command === "get_table_schemas") return [];
    return {};
  });

  await conn.selectDatabase({ connectionId: "mysql-1", database: "game" });

  assert.equal(workspace.schema[0].schemaLoaded, true);
  assert.deepEqual(workspace.schema[0].columns, columns);
  assert.equal(calls.includes("get_table_schemas"), false);
});

test("explicit schema consumers coalesce through the shared metadata coordinator", async () => {
  installLocalStorage();
  const calls = [];
  const pending = deferred();
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "get_table_schemas") return pending.promise;
    return {};
  };
  const conn = useConnection(workspace, invoke);

  const first = conn.ensureTableSchema("hero", { connectionId: "mysql-1", database: "game" });
  const second = conn.ensureTableSchema("hero", { connectionId: "mysql-1", database: "game" });
  await flushAsync();

  assert.equal(calls.filter((call) => call.command === "get_table_schemas").length, 1);
  pending.resolve([{ table_name: "hero", columns: [{ column_name: "id" }] }]);
  const [firstSchema, secondSchema] = await Promise.all([first, second]);
  assert.strictEqual(firstSchema, secondSchema);
});

test("shows table names before background schemas finish and merges schemas once they complete", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const schemaRequest = deferred();
  const schemaRequests = [];
  const invoke = async (command, payload = {}) => {
    if (command === "select_database") return {};
    if (command === "list_tables") {
      return [
        { table_name: "accounts", table_comment: "Accounts", data_size_bytes: 1024, modified_at: "2026-07-11 10:00:00" },
        { table_name: "orders", table_comment: "Orders", data_size_bytes: 2048, modified_at: "2026-07-12 10:00:00" },
        { table_name: "events", table_comment: "Events", data_size_bytes: 4096, modified_at: null },
      ];
    }
    if (command === "get_table_schemas") {
      schemaRequests.push(payload);
      return schemaRequest.promise;
    }
    return {};
  };
  const conn = useConnection(workspace, invoke);
  const selecting = conn.selectDatabase({ connectionId: "mysql-main", database: "app" });

  try {
    await flushAsync();

    assert.deepEqual(tableNames(workspace.schema), ["accounts", "orders", "events"]);
    assert.deepEqual(workspace.schema.map((table) => table.columns), [[], [], []]);
    assert.equal(conn.busy.value, false);
    assert.equal(schemaRequests.length, 1);
    assert.deepEqual(schemaRequests[0].tableNames, ["accounts", "orders", "events"]);

    schemaRequest.resolve(
      schemaRequests[0].tableNames.map((tableName) => ({
        table_name: tableName,
        columns: [{ column_name: "id" }],
      })),
    );
    await flushUntil(() => workspace.schema.every((table) => table.columns.length === 1));

    assert.deepEqual(workspace.schema.map((table) => [tableNames([table])[0], table.columns.length]), [
      ["accounts", 1],
      ["orders", 1],
      ["events", 1],
    ]);
    assert.deepEqual(workspace.schema.map((table) => [table.data_size_bytes, table.modified_at]), [
      [1024, "2026-07-11 10:00:00"],
      [2048, "2026-07-12 10:00:00"],
      [4096, null],
    ]);
  } finally {
    schemaRequest.resolve([]);
    await selecting;
  }
});

test("silent modified-time refresh preserves loaded schema and ignores other table metadata", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState({ connectionId: "mysql-main", database: "app" });
  const columns = [{ column_name: "id", is_primary_key: true }];
  workspace.tables = [{
    table_name: "accounts",
    table_comment: "Current comment",
    data_size_bytes: 1024,
    modified_at: "2026-07-15 10:00:00",
  }];
  workspace.schema = [{
    ...workspace.tables[0],
    columns,
    schemaLoaded: true,
  }];
  const invoke = async (command, payload = {}) => {
    assert.equal(command, "list_tables");
    assert.equal(payload.priority, "background");
    return [{
      table_name: "accounts",
      table_comment: "External comment",
      data_size_bytes: 4096,
      modified_at: "2026-07-15 10:01:00",
    }];
  };
  const conn = useConnection(workspace, invoke);
  conn.selectedConnectionId.value = "mysql-main";
  conn.selectedDatabase.value = "app";

  const result = await conn.refreshTableModifiedTimes();

  assert.deepEqual(result, { updatedCount: 1, stale: false });
  assert.equal(workspace.schema[0].modified_at, "2026-07-15 10:01:00");
  assert.equal(workspace.tables[0].modified_at, "2026-07-15 10:01:00");
  assert.equal(workspace.schema[0].table_comment, "Current comment");
  assert.equal(workspace.schema[0].data_size_bytes, 1024);
  assert.strictEqual(workspace.schema[0].columns, columns);
  assert.equal(workspace.schema[0].schemaLoaded, true);
  assert.equal(conn.busy.value, false);
  assert.equal(conn.statusText.value, "");
});

test("silent modified-time refresh drops a response after the active database changes", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState({ connectionId: "mysql-main", database: "first" });
  workspace.tables = [{ table_name: "accounts", modified_at: "2026-07-15 10:00:00" }];
  workspace.schema = [{ ...workspace.tables[0], columns: [] }];
  const pending = deferred();
  const conn = useConnection(workspace, async (command) => {
    if (command === "list_tables") return pending.promise;
    return {};
  });
  conn.selectedConnectionId.value = "mysql-main";
  conn.selectedDatabase.value = "first";

  const refresh = conn.refreshTableModifiedTimes();
  workspace.database = "second";
  conn.selectedDatabase.value = "second";
  pending.resolve([{ table_name: "accounts", modified_at: "2026-07-15 10:02:00" }]);

  assert.deepEqual(await refresh, { updatedCount: 0, stale: true });
  assert.equal(workspace.schema[0].modified_at, "2026-07-15 10:00:00");
});

test("selecting a large database does not republish the visible schema for every background table schema", async () => {
  installLocalStorage();
  const workspace = reactive(createWorkspaceState());
  const tableCount = 80;
  const tables = Array.from({ length: tableCount }, (_, index) => ({
    table_name: `table_${String(index + 1).padStart(3, "0")}`,
    table_comment: `Table ${index + 1}`,
  }));
  const invoke = async (command, payload = {}) => {
    if (command === "select_database") return {};
    if (command === "list_tables") return tables;
    if (command === "get_table_schemas") {
      return payload.tableNames.map((tableName) => ({
        table_name: tableName,
        table_comment: `Loaded ${tableName}`,
        columns: [{ column_name: "id", is_primary_key: true }],
      }));
    }
    return {};
  };
  const conn = useConnection(workspace, invoke);
  let visibleSchemaUpdates = 0;
  const stopWatching = watch(
    () => workspace.schema.map((table) => `${table.table_name}:${(table.columns || []).length}`).join("|"),
    () => {
      visibleSchemaUpdates += 1;
    },
    { flush: "sync" },
  );

  try {
    await conn.selectDatabase({ connectionId: "mysql-main", database: "large_app" });
    await flushUntil(() => workspace.schema.every((table) => (table.columns || []).length === 1));
  } finally {
    stopWatching();
  }

  assert.equal(workspace.schema.length, tableCount);
  assert.ok(
    visibleSchemaUpdates <= 2,
    `expected one table-list publish plus one background merge, got ${visibleSchemaUpdates} visible schema updates`,
  );
});

test("selecting a very large database loads all schemas in bounded batches", async () => {
  installLocalStorage();
  const workspace = reactive(createWorkspaceState());
  const tableCount = 240;
  const tables = Array.from({ length: tableCount }, (_, index) => ({
    table_name: `wide_table_${String(index + 1).padStart(3, "0")}`,
    table_comment: `Wide table ${index + 1}`,
  }));
  const schemaCalls = [];
  const batchSizes = [];
  const invoke = async (command, payload = {}) => {
    if (command === "select_database") return {};
    if (command === "list_tables") return tables;
    if (command === "get_table_schemas") {
      batchSizes.push(payload.tableNames.length);
      schemaCalls.push(...payload.tableNames);
      return payload.tableNames.map((tableName) => ({
        table_name: tableName,
        table_comment: `Loaded ${tableName}`,
        columns: [{ column_name: "id", is_primary_key: true }],
      }));
    }
    return {};
  };
  const conn = useConnection(workspace, invoke);

  await conn.selectDatabase({ connectionId: "mysql-main", database: "very_large_app" });
  await flushUntil(() => workspace.schema.every((table) => table.schemaLoaded));

  assert.equal(workspace.schema.length, tableCount);
  assert.equal(new Set(schemaCalls).size, tableCount);
  assert.deepEqual(batchSizes, [80, 80, 80]);
  conn.dispose();
});

test("ignores stale table loads when databases are switched quickly", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const listTables = new Map([
    ["first", deferred()],
    ["second", deferred()],
  ]);
  const invoke = async (command, payload = {}) => {
    if (command === "select_database") return {};
    if (command === "list_tables") return listTables.get(payload.database).promise;
    if (command === "get_table_schema") return { table_name: payload.tableName, columns: [{ column_name: "id" }] };
    return {};
  };
  const conn = useConnection(workspace, invoke);

  const first = conn.selectDatabase({ connectionId: "mysql-main", database: "first" });
  await flushAsync();
  const second = conn.selectDatabase({ connectionId: "mysql-main", database: "second" });
  listTables.get("second").resolve([{ table_name: "second_table", table_comment: "Second" }]);
  await second;
  listTables.get("first").resolve([{ table_name: "first_table", table_comment: "First" }]);
  await first;
  await flushAsync();

  assert.equal(conn.selectedDatabase.value, "second");
  assert.equal(workspace.database, "second");
  assert.deepEqual(tableNames(workspace.schema), ["second_table"]);
});

test("keeps the last selected connection when an earlier database list resolves later", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState({ connectionId: "mysql-old", database: "old" });
  workspace.schema = [{ table_name: "old_table", columns: [] }];
  const pendingDatabases = new Map([
    ["mysql-first", deferred()],
    ["mysql-second", deferred()],
  ]);
  const invoke = async (command, payload = {}) => {
    if (command === "list_databases") return pendingDatabases.get(payload.connectionId).promise;
    if (command === "select_database") return {};
    if (command === "list_tables") return [{ table_name: `${payload.database}_table` }];
    if (command === "get_table_schema") return { table_name: payload.tableName, columns: [] };
    return {};
  };
  const conn = useConnection(workspace, invoke);
  conn.connections.value = [
    { id: "mysql-first", label: "First", connected: true },
    { id: "mysql-second", label: "Second", connected: true },
  ];

  const first = conn.selectConnection("mysql-first");
  await flushAsync();
  assert.deepEqual(conn.databases.value, []);
  assert.deepEqual(tableNames(workspace.schema), []);

  const second = conn.selectConnection("mysql-second");
  pendingDatabases.get("mysql-second").resolve(["second"]);
  await second;
  pendingDatabases.get("mysql-first").resolve(["first"]);
  await first;

  assert.equal(conn.selectedConnectionId.value, "mysql-second");
  assert.equal(conn.selectedDatabase.value, "second");
  assert.equal(workspace.database, "second");
  assert.deepEqual(tableNames(workspace.schema), ["second_table"]);
});

test("restores the prior visible source when selecting a database fails", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState({ connectionId: "mysql-main", database: "old" });
  workspace.tables = [{ table_name: "old_table" }];
  workspace.schema = [{ table_name: "old_table", columns: [] }];
  const invoke = async (command) => {
    if (command === "select_database") throw new Error("no access");
    return {};
  };
  const conn = useConnection(workspace, invoke);
  conn.selectedConnectionId.value = "mysql-main";
  conn.selectedDatabase.value = "old";

  await conn.selectDatabase({ connectionId: "mysql-main", database: "new" });

  assert.equal(conn.selectedDatabase.value, "old");
  assert.equal(workspace.database, "old");
  assert.deepEqual(tableNames(workspace.schema), ["old_table"]);
});

test("keeps table placeholders when background schema loading fails", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const invoke = async (command, payload = {}) => {
    if (command === "select_database") return {};
    if (command === "list_tables") {
      return [
        { table_name: "healthy", table_comment: "Healthy" },
        { table_name: "broken", table_comment: "Broken" },
      ];
    }
    if (command === "get_table_schemas") {
      return payload.tableNames.includes("healthy")
        ? [{ table_name: "healthy", table_comment: "Healthy", columns: [{ column_name: "id" }] }]
        : [];
    }
    return {};
  };
  const conn = useConnection(workspace, invoke);

  await conn.selectDatabase({ connectionId: "mysql-main", database: "app" });
  await flushAsync();

  assert.deepEqual(tableNames(workspace.schema), ["healthy", "broken"]);
  assert.deepEqual(workspace.schema.map((table) => table.columns.length), [1, 0]);
});

test("does not let stale explicit schema refresh mutate the active tree", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState({ connectionId: "mysql-main", database: "current" });
  workspace.schema = [{ table_name: "current_table", columns: [] }];
  const invoke = async (command, payload = {}) => {
    if (command === "get_table_schemas") {
      return payload.tableNames.map((tableName) => ({
        table_name: tableName,
        columns: [{ column_name: "stale_id" }],
      }));
    }
    return {};
  };
  const conn = useConnection(workspace, invoke);
  conn.selectedConnectionId.value = "mysql-main";
  conn.selectedDatabase.value = "current";

  const schema = await conn.ensureTableSchema("old_table", { connectionId: "mysql-main", database: "old" });

  assert.deepEqual(schema.columns, [{ column_name: "stale_id" }]);
  assert.deepEqual(tableNames(workspace.schema), ["current_table"]);
});

test("visibleConnections hides demo connections when a real connection exists", () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const conn = useConnection(workspace, async () => []);
  conn.connections.value = [
    { id: "demo", label: "Demo", host: "demo", connected: true },
    { id: "mysql-1", label: "Prod", host: "127.0.0.1", connected: true },
  ];

  assert.deepEqual(
    conn.visibleConnections.value.map((connection) => connection.id),
    ["mysql-1"],
  );
});

test("removeConnection removes runtime and saved connection metadata", async () => {
  const store = installLocalStorage({
    dbscout_connections: JSON.stringify([
      {
        kind: "mysql",
        host: "127.0.0.1",
        port: "3307",
        username: "root",
        password: "secret",
        url: "mysql://root:secret@127.0.0.1:3307",
      },
    ]),
    dbscout_connection_order: JSON.stringify(["demo", "mysql-1"]),
  });
  const calls = [];
  const workspace = createWorkspaceState({ connectionId: "mysql-1", database: "analytics" });
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "remove_connection") return {};
    if (command === "list_databases") return ["analytics"];
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return {};
  };
  const conn = useConnection(workspace, invoke);
  conn.connections.value = [
    { id: "demo", label: "Demo", host: "demo", connected: true, database: "game_db" },
    {
      id: "mysql-1",
      label: "root@127.0.0.1:3307",
      host: "127.0.0.1",
      port: "3307",
      username: "root",
      connected: true,
      saved: true,
      database: "analytics",
    },
  ];
  conn.selectedConnectionId.value = "mysql-1";
  conn.selectedDatabase.value = "analytics";

  const removed = await conn.removeConnection("mysql-1");

  assert.equal(removed, true);
  assert.deepEqual(calls[0], { command: "remove_connection", payload: { connectionId: "mysql-1" } });
  assert.deepEqual(conn.connections.value.map((connection) => connection.id), ["demo"]);
  assert.equal(conn.selectedConnectionId.value, "demo");
  assert.deepEqual(JSON.parse(store.dbscout_connections), []);
  assert.deepEqual(JSON.parse(store.dbscout_connection_order), ["demo"]);
});

function twoSavedServersHarness({ slowSecond }) {
  installLocalStorage({
    dbscout_connections: JSON.stringify([
      { host: "10.0.0.1", port: "3306", username: "root", password: "a" },
      { host: "10.0.0.2", port: "3306", username: "root", password: "b" },
    ]),
    dbscout_workspace: JSON.stringify({ version: 2, connectionId: "mysql-1", database: "analytics", tabs: [] }),
  });
  const calls = [];
  const runtime = [];
  const workspace = createWorkspaceState();
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_connections") return runtime.map((item) => ({ ...item }));
    if (command === "restore_connection") {
      if (payload.url.includes("10.0.0.2")) await slowSecond.promise;
      // Runtime ids follow restore completion order, like the backend.
      runtime.push({ id: `mysql-${runtime.length + 1}`, label: "MySQL", host: "configured", port: 3306, username: "mysql", connected: true });
      return ["analytics", "billing"];
    }
    if (command === "list_databases") return ["analytics", "billing"];
    if (command === "select_database") return { tables: [] };
    if (command === "add_connection") {
      runtime.push({ id: `mysql-${runtime.length + 1}`, label: "MySQL", host: "configured", port: 3306, username: "mysql", connected: true });
      return ["fresh"];
    }
    return {};
  };
  return { calls, runtime, workspace, invoke };
}

test("startup proceeds once the last-used connection is ready while later ones restore in order", async () => {
  const slowSecond = deferred();
  const { calls, runtime, workspace, invoke } = twoSavedServersHarness({ slowSecond });
  const conn = useConnection(workspace, invoke);

  await conn.loadConnections();

  assert.equal(conn.selectedConnectionId.value, "mysql-1");
  assert.equal(conn.selectedDatabase.value, "analytics");
  assert.deepEqual(runtime.map((item) => item.id), ["mysql-1"], "the slow second server has not blocked startup");
  const restores = calls.filter((call) => call.command === "restore_connection").map((call) => call.payload.url);
  assert.equal(restores.length, 2);
  assert.ok(restores[0].includes("10.0.0.1") && restores[1].includes("10.0.0.2"), "restores keep saved order");
  assert.equal(calls.filter((call) => call.command === "list_databases").length, 0, "restore's database list is reused");

  slowSecond.resolve();
  await conn.whenConnectionsRestored();
  assert.deepEqual(runtime.map((item) => item.id), ["mysql-1", "mysql-2"]);
  assert.ok(conn.connections.value.some((item) => item.id === "mysql-2" && item.connected));
});

test("adding a connection waits for background restoration so runtime ids keep their order", async () => {
  const slowSecond = deferred();
  const { calls, runtime, workspace, invoke } = twoSavedServersHarness({ slowSecond });
  const conn = useConnection(workspace, invoke);
  await conn.loadConnections();

  Object.assign(conn.connDialog, { kind: "mysql", host: "10.0.0.3", port: "3306", username: "root", password: "c" });
  const adding = conn.submitConnDialog();
  await flushAsync();
  assert.equal(calls.some((call) => call.command === "add_connection"), false);

  slowSecond.resolve();
  await adding;
  assert.deepEqual(runtime.map((item) => item.id), ["mysql-1", "mysql-2", "mysql-3"]);
  const order = calls.map((call) => call.command);
  assert.ok(order.lastIndexOf("restore_connection") < order.indexOf("add_connection"));
});

test("status writes are journaled so repeats and same-tick overwrites stay visible", () => {
  installLocalStorage();
  const conn = useConnection(createWorkspaceState(), async () => ({}));
  conn.drainStatusJournal();

  conn.statusText.value = "剪贴板为空，未修改数据";
  conn.statusText.value = "剪贴板为空，未修改数据";
  conn.setStatus("读取分页失败：timeout", { error: true });
  conn.statusText.value = "已打开表：hero";

  assert.deepEqual(conn.drainStatusJournal(), [
    { text: "剪贴板为空，未修改数据", explicitError: false },
    { text: "剪贴板为空，未修改数据", explicitError: false },
    { text: "读取分页失败：timeout", explicitError: true },
    { text: "已打开表：hero", explicitError: false },
  ]);
  assert.deepEqual(conn.drainStatusJournal(), []);
  assert.equal(conn.statusText.value, "已打开表：hero");
  assert.equal(conn.statusRevision.value >= 4, true);
});
