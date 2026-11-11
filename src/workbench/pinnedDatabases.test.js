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

import {
  movePinnedDatabase,
  setPinnedDatabaseRail,
  setPinnedDatabaseRailAppearance,
} from "./utils/pinnedDatabases.js";
import { railDatabaseId } from "./utils/railDatabaseGlyph.js";

test("rail fields survive normalization while invalid values are dropped or clipped", () => {
  const normalized = normalizePinnedDatabases([
    {
      connectionId: "c1",
      database: "db1",
      rail: true,
      railIcon: "rocket",
      railText: "ignored",
      railColor: "#C2410C",
    },
    { connectionId: "c1", database: "db2", rail: true, railText: " A B " },
    {
      connectionId: "c1",
      database: "db3",
      rail: false,
      railIcon: "dragon",
      railColor: "red",
      railText: "测 试 服",
    },
    { connectionId: "c1", database: "db4", rail: 1 },
  ]);

  assert.deepEqual(normalized, [
    { connectionId: "c1", database: "db1", rail: true, railIcon: "rocket", railColor: "#c2410c" },
    { connectionId: "c1", database: "db2", rail: true, railText: "AB" },
    { connectionId: "c1", database: "db3", railText: "测试" },
    { connectionId: "c1", database: "db4", rail: true },
  ]);
});

test("shortcut edits preserve rail appearance fields", () => {
  let entries = normalizePinnedDatabases([
    { connectionId: "c1", database: "db1", rail: true, railIcon: "rocket", railColor: "#c2410c" },
  ]);
  entries = setPinnedDatabaseShortcut("c1", "db1", "Ctrl+1", entries);
  assert.deepEqual(entries, [
    {
      connectionId: "c1",
      database: "db1",
      rail: true,
      railIcon: "rocket",
      railColor: "#c2410c",
      shortcut: "Ctrl+1",
    },
  ]);
});

test("setPinnedDatabaseRail adds, re-colors and clears the rail flag", () => {
  let entries = setPinnedDatabaseRail("c1", "db1", true, [], { color: "#7C3AED" });
  assert.deepEqual(entries, [
    { connectionId: "c1", database: "db1", rail: true, railColor: "#7c3aed" },
  ]);

  entries = setPinnedDatabaseRail("c1", "db1", true, entries, { color: "#0F766E" });
  assert.equal(entries[0].railColor, "#7c3aed");

  entries = setPinnedDatabaseRail("c1", "db1", true, [{ connectionId: "c1", database: "db1" }], { color: "#0F766E" });
  assert.deepEqual(entries, [
    { connectionId: "c1", database: "db1", rail: true, railColor: "#0f766e" },
  ]);

  entries = setPinnedDatabaseRail("c1", "db1", false, [
    { connectionId: "c1", database: "db1", rail: true, railIcon: "rocket", railColor: "#0f766e" },
  ]);
  assert.deepEqual(entries, [
    { connectionId: "c1", database: "db1", railIcon: "rocket", railColor: "#0f766e" },
  ]);

  const unchanged = [{ connectionId: "c1", database: "db1" }];
  assert.deepEqual(setPinnedDatabaseRail("c1", "missing", false, unchanged), unchanged);
});

test("setPinnedDatabaseRailAppearance keeps icon and text exclusive", () => {
  let entries = normalizePinnedDatabases([
    { connectionId: "c1", database: "db1", rail: true },
  ]);

  entries = setPinnedDatabaseRailAppearance("c1", "db1", { icon: "rocket" }, entries);
  assert.deepEqual(entries[0], { connectionId: "c1", database: "db1", rail: true, railIcon: "rocket" });

  entries = setPinnedDatabaseRailAppearance("c1", "db1", { text: "AB" }, entries);
  assert.deepEqual(entries[0], { connectionId: "c1", database: "db1", rail: true, railText: "AB" });

  entries = setPinnedDatabaseRailAppearance("c1", "db1", { color: "#BE123C" }, entries);
  assert.equal(entries[0].railColor, "#be123c");
  assert.equal(entries[0].railText, "AB");

  entries = setPinnedDatabaseRailAppearance("c1", "db1", { icon: "star", text: "ZZ" }, entries);
  assert.deepEqual(entries[0].railIcon, "star");
  assert.equal(entries[0].railText, undefined);

  entries = setPinnedDatabaseRailAppearance("c1", "db1", { icon: "", text: "", color: "" }, entries);
  assert.deepEqual(entries[0], { connectionId: "c1", database: "db1", rail: true });

  const untouched = [{ connectionId: "c1", database: "db1", rail: true }];
  assert.deepEqual(
    setPinnedDatabaseRailAppearance("c1", "missing", { icon: "rocket" }, untouched),
    untouched,
  );
});

test("movePinnedDatabase reorders entries by their rail ids", () => {
  const entries = normalizePinnedDatabases([
    { connectionId: "c1", database: "one", rail: true },
    { connectionId: "c1", database: "two" },
    { connectionId: "c2", database: "three", rail: true },
  ]);

  const moved = movePinnedDatabase(
    railDatabaseId("c1", "one"),
    railDatabaseId("c2", "three"),
    "after",
    entries,
  );
  assert.deepEqual(moved.map((entry) => entry.database), ["two", "three", "one"]);

  const back = movePinnedDatabase(
    railDatabaseId("c1", "one"),
    railDatabaseId("c1", "two"),
    "before",
    moved,
  );
  assert.deepEqual(back.map((entry) => entry.database), ["one", "two", "three"]);
});
