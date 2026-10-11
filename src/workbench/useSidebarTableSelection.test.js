import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import { useSidebarTableSelection } from "./composables/useSidebarTableSelection.js";

function setup({ active = "" } = {}) {
  const tables = ref(["guild", "hero", "item", "mail", "player"].map((tableName) => ({ tableName })));
  const activeTableName = ref(active);
  return { tables, activeTableName, selection: useSidebarTableSelection({ tables, activeTableName }) };
}

test("a plain click opens the table and selects only it", () => {
  const { selection } = setup();
  assert.equal(selection.click("hero", {}), "open");
  assert.deepEqual(selection.state.names, ["hero"]);
  assert.equal(selection.isMultiple.value, false);
});

test("Ctrl and Shift clicks build a selection without opening", () => {
  const { selection } = setup();
  selection.click("hero", {});
  assert.equal(selection.click("mail", { ctrlKey: true }), "select");
  assert.deepEqual(selection.state.names, ["hero", "mail"]);
  assert.equal(selection.click("player", { shiftKey: true }), "select");
  assert.deepEqual(selection.state.names, ["mail", "player"]);
  assert.equal(selection.isMultiple.value, true);
});

test("Shift+click ranges from the active table before anything was clicked", () => {
  const { selection } = setup({ active: "item" });
  selection.click("guild", { shiftKey: true });
  assert.deepEqual(selection.state.names, ["guild", "hero", "item"]);
});

test("double-clicking a selected row opens the whole selection with that row active", () => {
  const { selection } = setup();
  selection.click("guild", {});
  selection.click("item", { ctrlKey: true });
  selection.click("player", { ctrlKey: true });

  // Browser order: click (detail 1), click (detail 2), dblclick.
  assert.equal(selection.click("item", { detail: 1 }), "open");
  assert.deepEqual(selection.state.names, ["item"]);
  assert.equal(selection.click("item", { detail: 2 }), "ignore");
  assert.deepEqual(selection.doubleClick("item"), { names: ["guild", "item", "player"], activeName: "item" });
  assert.deepEqual(selection.state.names, ["guild", "item", "player"]);
});

test("double-clicking outside a multi-selection opens nothing extra", () => {
  const { selection } = setup();
  selection.click("guild", {});
  selection.click("hero", { ctrlKey: true });
  selection.click("mail", { detail: 1 });
  selection.click("mail", { detail: 2 });
  assert.equal(selection.doubleClick("mail"), null);
  assert.deepEqual(selection.state.names, ["mail"]);
});

test("context actions cover the selection only when the row belongs to it", () => {
  const { selection } = setup();
  selection.click("guild", {});
  selection.click("hero", { shiftKey: true });
  assert.deepEqual(selection.targets("hero"), ["guild", "hero"]);
  assert.deepEqual(selection.targets("mail"), ["mail"]);
  assert.deepEqual(selection.state.names, ["mail"]);
});

test("keyboard movement selects, extends and reaches both ends", () => {
  const { selection } = setup({ active: "hero" });
  assert.equal(selection.move(1), "item");
  assert.deepEqual(selection.state.names, ["item"]);
  assert.equal(selection.move(1, { extend: true }), "mail");
  assert.deepEqual(selection.state.names, ["item", "mail"]);
  assert.equal(selection.move(-Infinity), "guild");
  assert.equal(selection.move(Infinity, { extend: true }), "player");
  assert.deepEqual(selection.state.names, ["guild", "hero", "item", "mail", "player"]);
});

test("keyboard movement starts from the row that has focus", () => {
  const { selection } = setup({ active: "player" });
  selection.click("guild", {});
  selection.clear();
  assert.equal(selection.move(1, { from: "item" }), "mail");
  assert.equal(selection.move(1, { from: "unknown" }), "player");
});

test("the open plan follows the focused row and list order", () => {
  const { selection } = setup();
  selection.click("player", {});
  selection.click("guild", { ctrlKey: true });
  assert.deepEqual(selection.openPlan(), { names: ["guild", "player"], activeName: "guild" });
});

test("select all, clear and pruning after a reload", () => {
  const { tables, selection } = setup();
  selection.selectAll();
  assert.equal(selection.state.names.length, 5);
  tables.value = tables.value.filter((table) => table.tableName !== "hero");
  selection.prune();
  assert.deepEqual(selection.state.names, ["guild", "item", "mail", "player"]);
  selection.clear();
  assert.deepEqual(selection.state.names, []);
  assert.equal(selection.state.focused, "");
});
