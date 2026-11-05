import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTableFolderSnapshot,
  isTableFolderWindowRole,
  MAIN_WINDOW_ROLE,
  resolveWindowRole,
  tableFolderWindowLabel,
} from "./utils/windowRole.js";
import { loadWorkspaceSnapshot, parseWorkspaceSnapshot } from "./utils/workspacePersistence.js";

const injected = {
  kind: "tableFolder",
  folderId: "fld-1",
  folderName: "Heroes",
  connectionId: "demo",
  database: "game",
  tableNames: ["heroprop", "", "skillprop", "heroprop"],
};

test("the desktop app's injected folder makes this a folder window", () => {
  const role = resolveWindowRole({ global: { __DBSCOUT_WINDOW__: injected, location: { search: "" } } });
  assert.equal(isTableFolderWindowRole(role), true);
  assert.deepEqual([...role.tableNames], ["heroprop", "skillprop"]);
  assert.equal(tableFolderWindowLabel(role.folderId), "table-folder-fld-1");
});

test("the browser preview reads the folder named in the address", () => {
  const folders = { "fld-2": { name: "Items", connectionId: "demo", database: "game", tableNames: ["itemprop"] } };
  const role = resolveWindowRole({
    global: { location: { search: "?tableFolder=fld-2" } },
    resolveFolder: (id) => folders[id] || null,
  });
  assert.equal(role.folderName, "Items");
  assert.deepEqual([...role.tableNames], ["itemprop"]);
  // Unknown folders and plain pages are the main window.
  assert.equal(resolveWindowRole({ global: { location: { search: "?tableFolder=nope" } }, resolveFolder: () => null }), MAIN_WINDOW_ROLE);
  assert.equal(resolveWindowRole({ global: { location: { search: "" } } }), MAIN_WINDOW_ROLE);
  assert.equal(resolveWindowRole({ global: { __DBSCOUT_WINDOW__: { ...injected, folderId: "../main" }, location: { search: "" } } }), MAIN_WINDOW_ROLE);
});

test("a folder window starts with the folder's tables, the first one shown", () => {
  const role = resolveWindowRole({ global: { __DBSCOUT_WINDOW__: injected, location: { search: "" } } });
  const snapshot = parseWorkspaceSnapshot(buildTableFolderSnapshot(role));
  assert.equal(snapshot.connectionId, "demo");
  assert.equal(snapshot.database, "game");
  assert.deepEqual(snapshot.tabs.map((tab) => [tab.kind, tab.tableName, tab.database]), [
    ["data", "heroprop", "game"],
    ["data", "skillprop", "game"],
  ]);
  assert.equal(snapshot.activeTabId, snapshot.tabs[0].id);
  assert.deepEqual(snapshot.panes["pane-1"].tabIds, snapshot.tabs.map((tab) => tab.id));
});

test("without an override the main window's saved workspace is read as before", () => {
  // No localStorage in node: the main window simply has nothing saved.
  assert.equal(loadWorkspaceSnapshot(), null);
});
