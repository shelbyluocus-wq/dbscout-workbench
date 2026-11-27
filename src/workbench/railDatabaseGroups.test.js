import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import {
  assignRailGroup,
  createRailGroup,
  dissolveRailGroup,
  moveRailTopLevel,
  moveWithinRailGroup,
  normalizeRailGroups,
  railGroupKey,
  railLayout,
} from "./utils/railDatabaseGroups.js";
import { normalizePinnedDatabases, setPinnedDatabaseRail } from "./utils/pinnedDatabases.js";
import { railDatabaseId } from "./utils/railDatabaseGlyph.js";
import { useRailDatabases } from "./composables/useRailDatabases.js";

const id = (database) => railDatabaseId("c1", database);
const rail = (database, extra = {}) => ({ connectionId: "c1", database, rail: true, ...extra });

function shape(entries, groups) {
  return railLayout(entries, groups).map((item) => (
    item.kind === "group" ? [item.group.name, item.entries.map((entry) => entry.database)] : item.entry.database
  ));
}

test("a group sits at its first member and keeps non-rail favorites in place", () => {
  const groups = [{ id: "rg-aaaa", name: "决胜2" }];
  const entries = [
    rail("a"),
    { connectionId: "c1", database: "fav" },
    rail("b", { railGroup: "rg-aaaa" }),
    rail("c"),
    rail("d", { railGroup: "rg-aaaa" }),
    rail("e", { railGroup: "rg-gone" }),
  ];
  assert.deepEqual(shape(entries, groups), ["a", ["决胜2", ["b", "d"]], "c", "e"]);

  const moved = moveRailTopLevel(entries, groups, railGroupKey("rg-aaaa"), id("a"), "before");
  assert.deepEqual(shape(moved, groups), [["决胜2", ["b", "d"]], "a", "c", "e"]);
  assert.equal(moved[1].database, "fav", "the plain favorite keeps its slot");
  assert.deepEqual(moved.filter((entry) => entry.rail).map((entry) => entry.database), ["b", "d", "a", "c", "e"]);
  assert.equal(moved.find((entry) => entry.database === "e").railGroup, undefined, "unknown groups are cleared on write");
});

test("creating, joining, leaving and dissolving keep members together", () => {
  let entries = [rail("a"), rail("b"), rail("c"), rail("d")];
  let groups = [];
  const created = createRailGroup(entries, groups, id("b"), "配置库");
  ({ entries, groups } = created);
  assert.deepEqual(shape(entries, groups), ["a", ["配置库", ["b"]], "c", "d"]);

  entries = assignRailGroup(entries, groups, id("d"), created.groupId);
  entries = assignRailGroup(entries, groups, id("a"), created.groupId);
  assert.deepEqual(shape(entries, groups), [["配置库", ["b", "d", "a"]], "c"]);

  entries = moveWithinRailGroup(entries, groups, created.groupId, id("a"), id("b"), "before");
  assert.deepEqual(shape(entries, groups), [["配置库", ["a", "b", "d"]], "c"]);

  entries = assignRailGroup(entries, groups, id("b"), "");
  assert.deepEqual(shape(entries, groups), [["配置库", ["a", "d"]], "b", "c"], "a member leaves to just below its group");

  ({ entries, groups } = dissolveRailGroup(entries, groups, created.groupId));
  assert.deepEqual(shape(entries, groups), ["a", "d", "b", "c"]);
  assert.deepEqual(groups, []);
});

test("the last member leaving a group takes the group's place", () => {
  const groups = [{ id: "rg-aaaa", name: "G" }];
  const entries = [rail("a"), rail("b", { railGroup: "rg-aaaa" }), rail("c")];
  assert.deepEqual(shape(assignRailGroup(entries, groups, id("b"), ""), groups), ["a", "b", "c"]);
});

test("group membership survives normalization only while the database is on the rail", () => {
  const [kept, dropped, invalid] = normalizePinnedDatabases([
    rail("a", { railGroup: "rg-aaaa" }),
    { connectionId: "c1", database: "b", railGroup: "rg-aaaa" },
    rail("c", { railGroup: "../x" }),
  ]);
  assert.equal(kept.railGroup, "rg-aaaa");
  assert.equal(dropped.railGroup, undefined);
  assert.equal(invalid.railGroup, undefined);
  assert.equal(setPinnedDatabaseRail("c1", "a", false, [kept])[0].railGroup, undefined);
  assert.deepEqual(normalizeRailGroups([{ id: "rg-aaaa", name: " G " }, { id: "rg-aaaa" }, { id: "bad" }]), [{ id: "rg-aaaa", name: "G" }]);
});

test("the rail composable exposes groups with their members and pins into a group", () => {
  const pinnedDatabases = ref([]);
  const notes = [];
  const shortcuts = useRailDatabases({
    pinnedDatabases,
    connections: ref([{ id: "c1", label: "Server", connected: true }]),
    currentSource: () => ({ connectionId: "c1", database: "b" }),
    databaseLabel: () => "",
    connectionLabel: (connectionId, fallback) => fallback,
    getDatabaseDecoration: () => null,
    translate: (key, params = {}) => `${key}|${JSON.stringify(params)}`,
    notify: (message) => notes.push(message),
    initialGroups: [],
  });
  shortcuts.pin({ connectionId: "c1", database: "a" });
  shortcuts.pin({ connectionId: "c1", database: "b" });
  const groupId = shortcuts.createGroup(shortcuts.items.value[1]);
  assert.ok(groupId);
  shortcuts.pin({ connectionId: "c1", database: "c", groupId });

  const [tile, group] = shortcuts.layout.value;
  assert.equal(tile.kind, "db");
  assert.equal(group.kind, "group");
  assert.deepEqual(group.items.map((item) => item.database), ["b", "c"]);
  assert.equal(group.current, true, "a group holding the current database is current");
  assert.match(group.hint, /^railDatabase\.groupCurrentHint/);
  assert.match(notes.at(-1), /^railDatabase\.pinnedToGroup/);

  assert.equal(shortcuts.renameGroup(groupId, "  决胜  "), true);
  assert.equal(shortcuts.layout.value[1].name, "决胜");
  shortcuts.reorder(group.id, tile.id, { position: "before" });
  assert.deepEqual(shortcuts.layout.value.map((item) => item.kind), ["group", "db"]);

  shortcuts.unpin({ connectionId: "c1", database: "b" });
  shortcuts.unpin({ connectionId: "c1", database: "c" });
  assert.deepEqual(shortcuts.layout.value.map((item) => item.kind), ["db"]);
  assert.deepEqual(shortcuts.groupOptions.value, []);
});
