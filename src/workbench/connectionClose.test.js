import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceState } from "./workspaceState.js";
import { SOURCE_SELECTION, useConnection } from "./composables/useConnection.js";

function installLocalStorage(store) {
  globalThis.localStorage = {
    getItem: (key) => (Object.hasOwn(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
  };
  return store;
}

// A backend that allocates runtime ids by count, keeps closed connections
// registered, and refuses to list a closed one, like the Rust runtime.
function backend() {
  const runtime = [];
  const calls = [];
  const byUrl = (url) => runtime.find((item) => item.url === url);
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_connections") {
      return runtime.map(({ url: _url, ...item }) => ({ ...item, connected: !item.closed }));
    }
    if (command === "restore_connection" || command === "register_connection") {
      let entry = byUrl(payload.url);
      const registering = command === "register_connection";
      if (!entry) {
        entry = { id: `mysql-${runtime.length + 1}`, label: "MySQL", host: "configured", port: 3306, username: "mysql", url: payload.url, closed: registering };
        runtime.push(entry);
      }
      if (registering) return entry.id;
      entry.closed = false;
      return ["analytics", "billing"];
    }
    if (command === "close_connection") {
      runtime.find((item) => item.id === payload.connectionId).closed = true;
      return null;
    }
    if (command === "open_connection") {
      runtime.find((item) => item.id === payload.connectionId).closed = false;
      return ["analytics", "billing"];
    }
    if (command === "list_databases") {
      if (runtime.find((item) => item.id === payload.connectionId)?.closed) throw new Error("连接不存在");
      return ["analytics", "billing"];
    }
    if (command === "select_database") return { tables: [] };
    return {};
  };
  return { runtime, calls, invoke };
}

const SAVED = JSON.stringify([
  { host: "10.0.0.1", port: "3306", username: "root", password: "a" },
  { host: "10.0.0.2", port: "3306", username: "root", password: "b" },
]);

test("a closed connection stays in the tree, stops background listings and switches the selection away", async () => {
  const store = installLocalStorage({
    dbscout_connections: SAVED,
    dbscout_workspace: JSON.stringify({ version: 2, connectionId: "mysql-1", database: "analytics", tabs: [] }),
  });
  const { calls, invoke } = backend();
  const conn = useConnection(createWorkspaceState(), invoke);
  await conn.loadConnections();
  await conn.whenConnectionsRestored();
  assert.equal(conn.selectedConnectionId.value, "mysql-1");

  assert.equal(await conn.closeConnection("mysql-1", { fallback: { connectionId: "mysql-2", database: "billing" } }), true);

  const closed = conn.connections.value.find((item) => item.id === "mysql-1");
  assert.equal(closed.closed, true);
  assert.equal(closed.connected, false);
  assert.equal(conn.selectedConnectionId.value, "mysql-2");
  assert.equal(conn.selectedDatabase.value, "billing");
  assert.deepEqual(JSON.parse(store.dbscout_closed_connections), ["mysql:10.0.0.1:3306:root"]);

  const before = calls.length;
  assert.deepEqual(await conn.fetchDatabasesForConnection("mysql-1"), []);
  await conn.fetchAllConnectionsDatabases();
  await conn.restoreDisconnectedSavedConnections();
  assert.equal(
    calls.slice(before).some((call) => call.payload.connectionId === "mysql-1" || call.command === "restore_connection"),
    false,
    "nothing reconnects the closed connection behind the user's back",
  );
});

test("after a restart a closed connection only reserves its id and opens under it on request", async () => {
  const store = installLocalStorage({
    dbscout_connections: SAVED,
    dbscout_closed_connections: JSON.stringify(["mysql:10.0.0.1:3306:root"]),
    dbscout_workspace: JSON.stringify({ version: 2, connectionId: "mysql-1", database: "analytics", tabs: [] }),
  });
  const { calls, invoke } = backend();
  const conn = useConnection(createWorkspaceState(), invoke);
  await conn.loadConnections();
  await conn.whenConnectionsRestored();

  const restored = calls.filter((call) => call.command === "restore_connection").map((call) => call.payload.url);
  assert.equal(restored.length, 1);
  assert.match(restored[0], /10\.0\.0\.2/);
  const registered = calls.filter((call) => call.command === "register_connection");
  assert.equal(registered.length, 1);
  assert.match(registered[0].payload.url, /10\.0\.0\.1/);

  const first = conn.connections.value.find((item) => item.id === "mysql-1");
  assert.equal(first.host, "10.0.0.1", "the reserved id keeps its place ahead of the next server");
  assert.equal(first.closed, true);
  assert.equal(conn.selectedConnectionId.value, "mysql-2", "startup skips the closed last-used connection");

  assert.equal(await conn.selectConnection("mysql-1"), SOURCE_SELECTION.selected);
  assert.equal(calls.filter((call) => call.command === "open_connection").length, 1);
  assert.equal(first.closed, false);
  assert.equal(first.connected, true);
  assert.equal(conn.selectedConnectionId.value, "mysql-1");
  assert.equal(conn.selectedDatabase.value, "analytics");
  assert.deepEqual(JSON.parse(store.dbscout_closed_connections), []);
});

test("closing the only open connection leaves no selection, and a failed open keeps it closed", async () => {
  installLocalStorage({ dbscout_connections: JSON.stringify([{ host: "10.0.0.1", port: "3306", username: "root", password: "a" }]) });
  const { invoke } = backend();
  let refuse = false;
  const conn = useConnection(createWorkspaceState(), async (command, payload) => {
    if (command === "open_connection" && refuse) throw new Error("连接 MySQL 失败");
    return invoke(command, payload);
  });
  await conn.loadConnections();
  await conn.whenConnectionsRestored();

  await conn.closeConnection("mysql-1");
  assert.equal(conn.selectedConnectionId.value, "");
  assert.equal(conn.selectedDatabase.value, "");

  refuse = true;
  const result = await conn.openConnection("mysql-1");
  assert.equal(result.ok, false);
  assert.equal(conn.connections.value[0].closed, true);
  assert.match(conn.databaseFetchErrors["mysql-1"].message, /连接 MySQL 失败/);
  assert.equal(conn.loadingConnectionIds.has("mysql-1"), false);
});
