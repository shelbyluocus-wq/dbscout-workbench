import test from "node:test";
import assert from "node:assert/strict";
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
