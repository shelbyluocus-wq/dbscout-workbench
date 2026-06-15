import test from "node:test";
import assert from "node:assert/strict";
import { reactive, watch } from "vue";
import { createWorkspaceState } from "./workspaceState.js";
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
  assert.match(conn.statusText.value, /新建 MySQL 连接/);
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

test("shows table names before background schemas finish and merges schemas once they complete", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const schemaRequests = [];
  const invoke = async (command, payload = {}) => {
    if (command === "select_database") return {};
    if (command === "list_tables") {
      return [
        { table_name: "accounts", table_comment: "Accounts" },
        { table_name: "orders", table_comment: "Orders" },
        { table_name: "events", table_comment: "Events" },
      ];
    }
    if (command === "get_table_schema") {
      const pending = deferred();
      schemaRequests.push({ payload, pending });
      return pending.promise;
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
    assert.equal(schemaRequests.length, 3);

    schemaRequests[1].pending.resolve({ table_name: "orders", table_comment: "Orders", columns: [{ column_name: "id" }] });
    await flushAsync();

    assert.deepEqual(workspace.schema.map((table) => [tableNames([table])[0], table.columns.length]), [
      ["accounts", 0],
      ["orders", 0],
      ["events", 0],
    ]);

    for (const request of schemaRequests) {
      request.pending.resolve({ table_name: request.payload.tableName, columns: [{ column_name: "id" }] });
    }
    await flushUntil(() => workspace.schema.every((table) => table.columns.length === 1));

    assert.deepEqual(workspace.schema.map((table) => [tableNames([table])[0], table.columns.length]), [
      ["accounts", 1],
      ["orders", 1],
      ["events", 1],
    ]);
  } finally {
    for (const request of schemaRequests) {
      request.pending.resolve({ table_name: request.payload.tableName, columns: [] });
    }
    await selecting;
  }
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
    if (command === "get_table_schema") {
      return {
        table_name: payload.tableName,
        table_comment: `Loaded ${payload.tableName}`,
        columns: [{ column_name: "id", is_primary_key: true }],
      };
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
    if (command === "get_table_schema") {
      if (payload.tableName === "broken") throw new Error("schema unavailable");
      return { table_name: "healthy", table_comment: "Healthy", columns: [{ column_name: "id" }] };
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
    if (command === "get_table_schema") {
      return { table_name: payload.tableName, columns: [{ column_name: "stale_id" }] };
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
