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
    if (command === "list_connections") return [{ id: "demo", label: "Demo", host: "demo", port: 3306, username: "root", database: "game_db", connected: true }];
    if (command === "restore_connection") return ["analytics"];
    if (command === "list_databases") return ["game_db"];
    if (command === "select_database") return {};
    if (command === "list_tables") return [];
    return {};
  };
  const conn = useConnection(workspace, invoke);

  await conn.loadConnections();

  assert.ok(calls.some((call) => call.command === "restore_connection" && call.payload.url === "mysql://root:secret@127.0.0.1:3307"));
  assert.ok(conn.connections.value.some((connection) => connection.host === "127.0.0.1" && connection.connected));
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
