import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  addPinnedDatabase,
  normalizePinnedDatabases,
  readPinnedDatabases,
  removePinnedDatabase,
  removePinnedDatabasesForConnection,
  setPinnedDatabaseShortcut,
} from "./utils/pinnedDatabases.js";

let store;

beforeEach(() => {
  store = {};
  globalThis.localStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
  };
});

test("pinned database storage keeps legacy entries and removes duplicates", () => {
  const normalized = normalizePinnedDatabases([
    { connectionId: "mysql-a", database: "orders" },
    { connectionId: "mysql-a", database: "orders", shortcut: "Ctrl+1" },
    { connectionId: "clickhouse-a", database: "events", shortcut: "Alt+2" },
    { connectionId: "mysql-a", database: "" },
  ]);

  assert.deepEqual(normalized, [
    { connectionId: "mysql-a", database: "orders" },
    { connectionId: "clickhouse-a", database: "events", shortcut: "Alt+2" },
  ]);
});

test("favorites can be added, rebound, cleared, and removed without disturbing order", () => {
  let entries = addPinnedDatabase("mysql-a", "orders", []);
  entries = addPinnedDatabase("clickhouse-a", "events", entries);
  entries = addPinnedDatabase("mysql-a", "orders", entries);
  assert.deepEqual(entries.map((entry) => entry.database), ["orders", "events"]);

  entries = setPinnedDatabaseShortcut("clickhouse-a", "events", "Ctrl+Shift+2", entries);
  assert.equal(entries[1].shortcut, "Ctrl+Shift+2");
  assert.deepEqual(readPinnedDatabases(), entries);

  entries = setPinnedDatabaseShortcut("clickhouse-a", "events", "", entries);
  assert.deepEqual(entries[1], { connectionId: "clickhouse-a", database: "events" });

  entries = removePinnedDatabase("mysql-a", "orders", entries);
  assert.deepEqual(entries, [{ connectionId: "clickhouse-a", database: "events" }]);
});

test("removing a connection clears all of its favorite databases", () => {
  const entries = [
    { connectionId: "mysql-a", database: "orders", shortcut: "Ctrl+1" },
    { connectionId: "mysql-a", database: "billing" },
    { connectionId: "clickhouse-a", database: "events" },
  ];

  assert.deepEqual(removePinnedDatabasesForConnection("mysql-a", entries), [
    { connectionId: "clickhouse-a", database: "events" },
  ]);
});
