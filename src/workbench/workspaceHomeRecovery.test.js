import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isDisconnectedSavedPlaceholder,
  shouldEmitSidebarDatabaseOpen,
  shouldEnsureDatabaseHome,
  shouldRestorePendingStartupSnapshot,
  shouldSkipWorkspacePersist,
} from "./utils/workspaceHomeRecovery.js";

test("detects disconnected saved placeholders by id prefix or connection metadata", () => {
  assert.equal(isDisconnectedSavedPlaceholder("saved-mysql:192.168.1.223:8306:root", []), true);
  assert.equal(
    isDisconnectedSavedPlaceholder("conn-1", [{ id: "conn-1", saved: true, connected: false }]),
    true,
  );
  assert.equal(
    isDisconnectedSavedPlaceholder("mysql-2", [{ id: "mysql-2", saved: true, connected: true }]),
    false,
  );
  assert.equal(isDisconnectedSavedPlaceholder("", []), false);
});

test("skips persisting workspace snapshots when startup landed on an empty disconnected placeholder", () => {
  assert.equal(
    shouldSkipWorkspacePersist({
      connectionId: "saved-mysql:192.168.1.223:8306:root",
      database: "",
      tabs: [],
      connections: [{ id: "saved-mysql:192.168.1.223:8306:root", saved: true, connected: false }],
    }),
    true,
  );
  assert.equal(
    shouldSkipWorkspacePersist({
      connectionId: "mysql-2",
      database: "newsg_4cfg",
      tabs: [],
      connections: [{ id: "mysql-2", saved: true, connected: true }],
    }),
    false,
  );
  assert.equal(
    shouldSkipWorkspacePersist({
      connectionId: "saved-mysql:192.168.1.223:8306:root",
      database: "",
      tabs: [{ id: "tab-1", kind: "sql" }],
      connections: [{ id: "saved-mysql:192.168.1.223:8306:root", saved: true, connected: false }],
    }),
    false,
  );
});

test("ensures a database home tab when connected without a home tab or with an empty focused pane", () => {
  assert.equal(
    shouldEnsureDatabaseHome({
      isFolderWindow: false,
      selectedDatabase: "newsg_4cfg",
      tabs: [],
      focusedPane: { id: "pane-1", tabIds: [] },
    }),
    true,
  );
  assert.equal(
    shouldEnsureDatabaseHome({
      isFolderWindow: false,
      selectedDatabase: "newsg_4cfg",
      tabs: [{ id: "tab-1", kind: "home" }],
      focusedPane: { id: "pane-2", tabIds: [] },
    }),
    true,
  );
  // Split screen: pane-1 owns home, pane-2 holds a table tab — do not create a duplicate home tab.
  assert.equal(
    shouldEnsureDatabaseHome({
      isFolderWindow: false,
      selectedDatabase: "newsg_4cfg",
      tabs: [{ id: "tab-1", kind: "home" }, { id: "tab-2", kind: "data" }],
      focusedPane: { id: "pane-2", tabIds: ["tab-2"] },
    }),
    false,
  );
  // Folder windows never auto-create home tabs.
  assert.equal(
    shouldEnsureDatabaseHome({
      isFolderWindow: true,
      selectedDatabase: "newsg_4cfg",
      tabs: [],
      focusedPane: { id: "pane-1", tabIds: [] },
    }),
    false,
  );
});

test("restores a preserved startup snapshot only when reconnecting to its matching empty source", () => {
  const snapshot = {
    connectionId: "mysql-2",
    database: "newsg_4cfg",
    tabs: [{ id: "tab-1", kind: "home" }, { id: "tab-2", kind: "data", tableName: "unionlogprop" }],
  };
  assert.equal(
    shouldRestorePendingStartupSnapshot(snapshot, {
      connectionId: "mysql-2",
      database: "newsg_4cfg",
      tabs: [],
    }),
    true,
  );
  assert.equal(
    shouldRestorePendingStartupSnapshot(snapshot, {
      connectionId: "mysql-1",
      database: "edota_15cfg",
      tabs: [],
    }),
    false,
  );
  assert.equal(
    shouldRestorePendingStartupSnapshot(snapshot, {
      connectionId: "mysql-2",
      database: "newsg_4cfg",
      tabs: [{ id: "tab-9", kind: "home" }],
    }),
    false,
  );
});

test("clicking an already-selected sidebar database emits open only when the main pane has no active tab", () => {
  assert.equal(shouldEmitSidebarDatabaseOpen({ activeTab: null }), true);
  assert.equal(shouldEmitSidebarDatabaseOpen({ activeTab: undefined }), true);
  assert.equal(shouldEmitSidebarDatabaseOpen({ activeTab: { id: "tab-1", kind: "home" } }), false);
  assert.equal(shouldEmitSidebarDatabaseOpen({ activeTab: { id: "tab-2", kind: "data" } }), false);
});

test("MySqlWorkbench and WorkbenchSidebar wire home-tab recovery on connection selection, dialog submit, and empty-pane database click", () => {
  const orchestrator = readFileSync(new URL("./MySqlWorkbench.vue", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("./components/WorkbenchSidebar.vue", import.meta.url), "utf8");

  assert.match(orchestrator, /@select-connection="selectConnectionWithHome\(\$event\)"/);
  assert.match(orchestrator, /@submit="submitConnDialogWithHome"/);
  assert.match(orchestrator, /shouldSkipWorkspacePersist/);
  assert.match(orchestrator, /restoreDisconnectedSavedConnections/);
  assert.match(orchestrator, /discardPaneHomeTabs\(workspace, targetPaneId\)/);
  assert.match(sidebar, /shouldEmitSidebarDatabaseOpen\(\{\s*activeTab:\s*props\.activeTab\s*\}\)/);
});
