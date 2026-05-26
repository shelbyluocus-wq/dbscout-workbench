import test from "node:test";
import assert from "node:assert/strict";

test("an active database branch can be collapsed and expanded without changing selection", async () => {
  const module = await import("./sidebarTreeState.js").catch(() => null);
  assert.ok(module, "sidebar tree expansion state module is required");

  const state = module.createSidebarTreeState();
  const source = ["mysql-main", "game_db", "mysql-main", "game_db"];

  assert.equal(module.isDatabaseExpanded(state, ...source), true);
  assert.equal(module.toggleDatabaseExpansion(state, ...source), true);
  assert.equal(module.isDatabaseExpanded(state, ...source), false);
  assert.equal(module.toggleDatabaseExpansion(state, ...source), true);
  assert.equal(module.isDatabaseExpanded(state, ...source), true);
});

test("collapsing the active connection temporarily hides its selected database branch", async () => {
  const module = await import("./sidebarTreeState.js").catch(() => null);
  assert.ok(module, "sidebar tree expansion state module is required");

  const state = module.createSidebarTreeState();

  assert.equal(module.isConnectionExpanded(state, "mysql-main", "mysql-main"), true);
  assert.equal(module.isDatabaseExpanded(state, "mysql-main", "game_db", "mysql-main", "game_db"), true);
  module.toggleConnectionExpansion(state, "mysql-main", "mysql-main");
  assert.equal(module.isConnectionExpanded(state, "mysql-main", "mysql-main"), false);
  assert.equal(module.isDatabaseExpanded(state, "mysql-main", "game_db", "mysql-main", "game_db"), false);
  module.toggleConnectionExpansion(state, "mysql-main", "mysql-main");
  assert.equal(module.isDatabaseExpanded(state, "mysql-main", "game_db", "mysql-main", "game_db"), true);
});

test("selecting a previously collapsed source branch reveals it again", async () => {
  const module = await import("./sidebarTreeState.js").catch(() => null);
  assert.ok(module, "sidebar tree expansion state module is required");

  const state = module.createSidebarTreeState();
  module.toggleConnectionExpansion(state, "mysql-main", "mysql-main");
  module.toggleDatabaseExpansion(state, "mysql-main", "game_db", "mysql-main", "game_db");

  module.revealConnection(state, "mysql-main");
  module.revealDatabase(state, "mysql-main", "game_db");

  assert.equal(module.isConnectionExpanded(state, "mysql-main", "mysql-main"), true);
  assert.equal(module.isDatabaseExpanded(state, "mysql-main", "game_db", "mysql-main", "game_db"), true);
});
