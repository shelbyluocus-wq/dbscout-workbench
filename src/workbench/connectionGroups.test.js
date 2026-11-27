import test from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTION_GROUPS_STORAGE_KEY,
  buildConnectionTree,
  createConnectionGroupStore,
  loadConnectionGroups,
} from "./composables/connectionGroupStore.js";
import { connectionIdentityKey, savedConnectionKey } from "./utils/connectionIdentity.js";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (Object.hasOwn(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
  };
}

test("connection identity follows the saved address, not the runtime id", () => {
  const runtime = { id: "mysql-3", saved: true, kind: "mysql", host: "10.0.0.1", port: "3306", username: "root" };
  const placeholder = { ...runtime, id: "saved-mysql:10.0.0.1:3306:root" };
  assert.equal(connectionIdentityKey(runtime), "saved:mysql:10.0.0.1:3306:root");
  assert.equal(connectionIdentityKey(placeholder), connectionIdentityKey(runtime));
  assert.equal(connectionIdentityKey({ id: "mysql-env", host: "configured" }), "id:mysql-env");
  assert.equal(savedConnectionKey({ kind: "clickhouse", host: "ch", port: 8123 }), "clickhouse:ch:8123:default");
});

test("groups come first in their own order, then ungrouped connections in connection order", () => {
  const store = createConnectionGroupStore({ storage: memoryStorage() });
  const ops = store.createGroup("运维", { memberKeys: ["c"] }).group;
  const games = store.createGroup("游戏", { memberKeys: ["a"] }).group;
  store.assign("d", games.id);
  store.moveGroup(games.id, ops.id, "before");

  const tree = buildConnectionTree(
    ["a", "b", "c", "d", "e"].map((id) => ({ id })),
    { ...store.state.value, identityOf: (connection) => connection.id },
  );
  assert.deepEqual(tree.groups.map((group) => [group.name, group.connections.map((c) => c.id)]), [
    ["游戏", ["a", "d"]],
    ["运维", ["c"]],
  ]);
  assert.deepEqual(tree.ungrouped.map((c) => c.id), ["b", "e"]);
});

test("names are required, unique ignoring case and suggested with a number", () => {
  const store = createConnectionGroupStore({ storage: memoryStorage() });
  assert.equal(store.createGroup("  ").error, "empty");
  assert.equal(store.createGroup("x".repeat(41)).error, "tooLong");
  const first = store.createGroup("Live").group;
  assert.equal(store.createGroup("live").error, "duplicate");
  assert.equal(store.suggestName("Live"), "Live 2");
  assert.equal(store.renameGroup(first.id, "LIVE").ok, true, "a group may change its own case");
  assert.equal(store.getGroup(first.id).name, "LIVE");
});

test("deleting a group returns its connections to the top level and state persists", () => {
  const storage = memoryStorage();
  const store = createConnectionGroupStore({ storage });
  const group = store.createGroup("A", { memberKeys: ["x", "y"] }).group;
  store.setCollapsed(group.id, true);
  assert.equal(store.groupOf("x"), group.id);
  assert.deepEqual(loadConnectionGroups(storage).groups, [{ id: group.id, name: "A", collapsed: true }]);

  store.assign("y", "");
  assert.equal(store.groupOf("y"), "");
  assert.equal(store.deleteGroup(group.id), true);
  assert.equal(store.groupOf("x"), "");
  assert.deepEqual(JSON.parse(storage.data[CONNECTION_GROUPS_STORAGE_KEY]), { version: 1, groups: [], members: {} });
});

test("stored members pointing at unknown groups are dropped", () => {
  const storage = memoryStorage({
    [CONNECTION_GROUPS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      groups: [{ id: "g1", name: "One" }, { id: "g1", name: "Dup" }, { id: "g2", name: "" }],
      members: { a: "g1", b: "missing" },
    }),
  });
  assert.deepEqual(loadConnectionGroups(storage), {
    groups: [{ id: "g1", name: "One", collapsed: false }],
    members: { a: "g1" },
  });
});
