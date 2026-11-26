import test from "node:test";
import assert from "node:assert/strict";
import {
  areAllConnectionsCollapsed,
  collapseAllConnections,
  createSidebarTreeState,
  expandAllConnections,
  isConnectionExpanded,
  isDatabaseExpanded,
  revealConnection,
  revealDatabase,
  settleDatabaseExpansion,
  toggleConnectionExpansion,
  toggleDatabaseExpansion,
} from "./sidebarTreeState.js";

const source = ["mysql-main", "game_db", "mysql-main", "game_db"];

test("database table lists start collapsed and open only on request", () => {
  const state = createSidebarTreeState();

  assert.equal(isDatabaseExpanded(state, ...source), false);
  assert.equal(toggleDatabaseExpansion(state, ...source), true);
  assert.equal(isDatabaseExpanded(state, ...source), true);
  assert.equal(toggleDatabaseExpansion(state, ...source), true);
  assert.equal(isDatabaseExpanded(state, ...source), false);
});

test("only the selected database can be toggled", () => {
  const state = createSidebarTreeState();

  assert.equal(toggleDatabaseExpansion(state, "mysql-main", "other_db", "mysql-main", "game_db"), false);
  assert.equal(isDatabaseExpanded(state, "mysql-main", "other_db", "mysql-main", "game_db"), false);
});

test("collapsing the active connection temporarily hides its opened database branch", () => {
  const state = createSidebarTreeState();
  revealDatabase(state, "mysql-main", "game_db");

  assert.equal(isConnectionExpanded(state, "mysql-main", "mysql-main"), true);
  assert.equal(isDatabaseExpanded(state, ...source), true);
  toggleConnectionExpansion(state, "mysql-main", "mysql-main");
  assert.equal(isConnectionExpanded(state, "mysql-main", "mysql-main"), false);
  assert.equal(isDatabaseExpanded(state, ...source), false);
  toggleConnectionExpansion(state, "mysql-main", "mysql-main");
  assert.equal(isDatabaseExpanded(state, ...source), true);
});

test("clicking a database opens it and keeps it open once it becomes selected", () => {
  const state = createSidebarTreeState();
  revealConnection(state, "mysql-main");
  revealDatabase(state, "mysql-main", "game_db");

  settleDatabaseExpansion(state, "mysql-main", "game_db");
  assert.equal(isDatabaseExpanded(state, ...source), true);
});

test("switching to another database's tab never unfolds a table list, even on the way back", () => {
  const state = createSidebarTreeState();
  revealDatabase(state, "mysql-main", "game_db");

  settleDatabaseExpansion(state, "mysql-main", "log_db");
  assert.equal(isDatabaseExpanded(state, "mysql-main", "log_db", "mysql-main", "log_db"), false);

  settleDatabaseExpansion(state, "mysql-main", "game_db");
  assert.equal(isDatabaseExpanded(state, ...source), false);
});

test("staying on the same database keeps a manually opened branch", () => {
  const state = createSidebarTreeState();
  toggleDatabaseExpansion(state, ...source);

  settleDatabaseExpansion(state, "mysql-main", "game_db");
  assert.equal(isDatabaseExpanded(state, ...source), true);
});

test("multiple MySQL connections can expand and collapse independently", () => {
  const state = createSidebarTreeState();
  const ids = ["mysql-1", "mysql-2", "mysql-3"];

  assert.equal(isConnectionExpanded(state, "mysql-1", "mysql-1"), true);
  assert.equal(isConnectionExpanded(state, "mysql-2", "mysql-1"), false);
  assert.equal(areAllConnectionsCollapsed(state, ids, "mysql-1"), false);

  assert.equal(toggleConnectionExpansion(state, "mysql-2", "mysql-1"), true);
  assert.equal(isConnectionExpanded(state, "mysql-1", "mysql-1"), true);
  assert.equal(isConnectionExpanded(state, "mysql-2", "mysql-1"), true);

  collapseAllConnections(state, ids);
  assert.equal(areAllConnectionsCollapsed(state, ids, "mysql-1"), true);
  assert.equal(ids.every((id) => !isConnectionExpanded(state, id, "mysql-1")), true);

  expandAllConnections(state, ids);
  assert.equal(areAllConnectionsCollapsed(state, ids, "mysql-1"), false);
  assert.equal(ids.every((id) => isConnectionExpanded(state, id, "mysql-1")), true);
});

test("cross-server database open survives transient empty selectedDatabase and can cancel mid-flight", () => {
  const state = createSidebarTreeState();
  revealConnection(state, "mysql-2");
  revealDatabase(state, "mysql-2", "newsg_4cfg");

  // Transient state while selectConnection awaits list_databases on mysql-2:
  settleDatabaseExpansion(state, "mysql-2", "");
  assert.equal(isDatabaseExpanded(state, "mysql-2", "newsg_4cfg", "mysql-2", ""), true);

  // User clicks again mid-flight to collapse before select_database finishes:
  assert.equal(toggleDatabaseExpansion(state, "mysql-2", "newsg_4cfg", "mysql-2", ""), true);
  assert.equal(isDatabaseExpanded(state, "mysql-2", "newsg_4cfg", "mysql-2", ""), false);

  // Late completion of select_database does not re-open the cancelled branch:
  settleDatabaseExpansion(state, "mysql-2", "newsg_4cfg");
  assert.equal(isDatabaseExpanded(state, "mysql-2", "newsg_4cfg", "mysql-2", "newsg_4cfg"), false);
});
