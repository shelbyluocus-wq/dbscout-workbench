import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as workspaceState from "./workspaceState.js";
import {
  activateTableTab,
  buildSchemaSearchResults,
  closePaneTab,
  closeAllTableTabs,
  closePaneTabs,
  closeTableObjectTabs,
  closeDatabaseTabs,
  closeConnectionTabs,
  closeTableTab,
  createWorkspaceState,
  filterSchemaTree,
  getActiveTab,
  getFocusedPane,
  getFocusedTab,
  focusPane,
  moveTabBetweenPanes,
  moveTableTab,
  normalizeHomeTabOrder,
  openDatabaseHomeTab,
  openTableTab,
  renameTableTab,
  replaceTabPage,
  appendTabPage,
  updateTabTotalMetadata,
} from "./workspaceState.js";

function openDesignTab(state, table, options) {
  assert.equal(typeof workspaceState.openTableDesignTab, "function", "openTableDesignTab should be exported");
  return workspaceState.openTableDesignTab(state, table, options);
}

test("production table-row consumers use the RowStore boundary", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const violations = [];
  const directRows = /\b(?:tab|targetTab)(?:\?\.|\.)rows\b|props\.tab(?:\?\.|\.)rows\b|active(?:Data)?Tab\.value(?:\?\.|\.)rows\b/g;

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (![".js", ".vue"].includes(extname(entry.name))) continue;
      if (entry.name.endsWith(".test.js") || path === join(root, "rowStore.js")) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(directRows)) {
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        violations.push(`${path.slice(root.length + 1)}:${line}:${match[0]}`);
      }
    }
  }

  visit(root);
  assert.deepEqual(violations, []);
});

test("schema metadata invalidates row identity only when columns or primary keys change", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(state, { tableName: "player" });
  replaceTabPage(state, tab.id, {
    columns: [{ column_name: "id", is_primary_key: true }, { column_name: "name" }],
    primaryKeys: ["id"],
    rows: [{ id: "1", name: "Ada" }],
  });
  const beforeComment = tab.dataVersion;

  workspaceState.applyTableSchemaToDataTab(tab, { table_comment: "updated comment" });
  assert.equal(tab.dataVersion, beforeComment);

  workspaceState.applyTableSchemaToDataTab(tab, {
    columns: [{ column_name: "player_id", is_primary_key: true, oldName: "id" }, { column_name: "name" }],
    primaryKeys: ["player_id"],
  });
  assert.ok(tab.dataVersion > beforeComment);
});

test("openTableTab reuses an existing table tab and makes it active", () => {
  const state = createWorkspaceState({ database: "game" });

  const first = openTableTab(state, { tableName: "items", tableComment: "道具表" });
  const second = openTableTab(state, { tableName: "quests", tableComment: "任务表" });
  const reused = openTableTab(state, { tableName: "items", tableComment: "道具表" });

  assert.equal(first.id, reused.id);
  assert.equal(second.id, "tab-2");
  assert.equal(state.activeTabId, first.id);
  assert.deepEqual(
    state.tabs.map((tab) => ({ id: tab.id, tableName: tab.tableName })),
    [
      { id: "tab-1", tableName: "items" },
      { id: "tab-2", tableName: "quests" },
    ],
  );
});

test("new data tabs initialize RowStore generation immediately", () => {
  const state = createWorkspaceState({ database: "game" });
  const tab = openTableTab(state, { tableName: "items" });

  assert.equal(tab.dataVersion, 0);
  assert.equal(tab.rowStore?.loadedLength, 0);
});

test("openTableTab initializes hit result metadata as normal table state", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });

  const tab = openTableTab(state, { tableName: "hero" });

  assert.equal(tab.hitResultMode, false);
  assert.equal(tab.hitResultSourceTabId, "");
  assert.equal(tab.hitResultSourcePaneId, "");
});

test("openTableTab initializes bounded search result state", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });

  const tab = openTableTab(state, { tableName: "hero" });

  assert.equal(tab.searchResultMode, false);
  assert.equal(tab.searchResultQuery, "");
  assert.equal(tab.searchResultJobId, "");
  assert.deepEqual(tab.searchResultMatches, []);
  assert.deepEqual(tab.searchResultRowKeys, []);
  assert.equal(tab.searchResultComplete, true);
  assert.equal(tab.searchResultDroppedRows, 0);
  assert.equal(tab.searchResultScannedRows, 0);
  assert.equal(tab.normalViewState, null);
  assert.equal(tab.searchRowStore, null);
});

test("openDatabaseHomeTab reuses one homepage tab globally", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });

  const first = openDatabaseHomeTab(state, { readOnly: false });
  const second = openDatabaseHomeTab(state, { readOnly: false });

  assert.equal(first.id, second.id);
  assert.equal(first.kind, "home");
  assert.equal(first.database, "shop");
  assert.equal(first.title, "首页");
  assert.equal(first.tabKey, "home\u001fdemo\u001fshop");
  assert.deepEqual(first.selectedTableNames, []);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeTabId, first.id);
});

test("opening the homepage places it before existing table tabs", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const orders = openTableTab(state, { tableName: "orders" });
  const customers = openTableTab(state, { tableName: "customers" });

  const home = openDatabaseHomeTab(state);

  assert.deepEqual(state.tabs.map((tab) => tab.id), [home.id, orders.id, customers.id]);
  assert.deepEqual(state.panes["pane-1"].tabIds, [home.id, orders.id, customers.id]);
});

test("table reordering cannot place a data tab before the homepage", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const home = openDatabaseHomeTab(state);
  const orders = openTableTab(state, { tableName: "orders" });
  const customers = openTableTab(state, { tableName: "customers" });

  moveTableTab(state, customers.id, home.id, { position: "before" });
  moveTableTab(state, home.id, orders.id, { position: "after" });

  assert.deepEqual(state.tabs.map((tab) => tab.id), [home.id, customers.id, orders.id]);
  assert.deepEqual(state.panes["pane-1"].tabIds, [home.id, customers.id, orders.id]);
});

test("moving the homepage to another pane places it first there", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const home = openDatabaseHomeTab(state, {}, { paneId: "pane-1" });
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  const orders = openTableTab(state, { tableName: "orders" }, { paneId: "pane-2" });

  moveTabBetweenPanes(state, home.id, "pane-2", {
    targetTabId: orders.id,
    position: "after",
    activate: true,
  });

  assert.deepEqual(state.panes["pane-1"].tabIds, []);
  assert.deepEqual(state.panes["pane-2"].tabIds, [home.id, orders.id]);
  assert.equal(state.tabs.filter((tab) => tab.kind === "home").length, 1);
});

test("normalizeHomeTabOrder repairs restored order without changing active tabs", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const home = openDatabaseHomeTab(state);
  const orders = openTableTab(state, { tableName: "orders" });
  const customers = openTableTab(state, { tableName: "customers" });
  state.tabs = [orders, customers, home];
  state.panes["pane-1"].tabIds = [orders.id, customers.id, home.id];
  state.panes["pane-1"].activeTabId = customers.id;
  state.activeTabId = customers.id;

  normalizeHomeTabOrder(state);

  assert.deepEqual(state.tabs.map((tab) => tab.id), [home.id, orders.id, customers.id]);
  assert.deepEqual(state.panes["pane-1"].tabIds, [home.id, orders.id, customers.id]);
  assert.equal(state.panes["pane-1"].activeTabId, customers.id);
  assert.equal(state.activeTabId, customers.id);
});

test("openDatabaseHomeTab reuses the one homepage across panes", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };

  const left = openDatabaseHomeTab(state, {}, { paneId: "pane-1" });
  const right = openDatabaseHomeTab(state, {}, { paneId: "pane-2" });
  const reusedRight = openDatabaseHomeTab(state, {}, { paneId: "pane-2" });

  assert.equal(right.id, left.id);
  assert.equal(reusedRight.id, left.id);
  assert.equal(state.tabs.filter((tab) => tab.kind === "home").length, 1);
  assert.deepEqual(state.panes["pane-1"].tabIds, []);
  assert.deepEqual(state.panes["pane-2"].tabIds, [left.id]);
});

test("openDatabaseHomeTab keeps an existing homepage in place when not activating", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  const home = openDatabaseHomeTab(state, {}, { paneId: "pane-1" });
  const rightTable = openTableTab(state, { tableName: "orders" }, { paneId: "pane-2" });

  const ensured = openDatabaseHomeTab(state, {}, { paneId: "pane-2", activate: false });

  assert.equal(ensured.id, home.id);
  assert.deepEqual(state.panes["pane-1"].tabIds, [home.id]);
  assert.deepEqual(state.panes["pane-2"].tabIds, [rightTable.id]);
  assert.equal(state.activeTabId, rightTable.id);
});

test("openDatabaseHomeTab reuses the homepage when switching databases", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const shopHome = openDatabaseHomeTab(state, {}, { paneId: "pane-1" });
  shopHome.selectedTableNames = ["orders"];

  const inventoryHome = openDatabaseHomeTab(
    state,
    { connectionId: "demo", database: "inventory" },
    { paneId: "pane-1" },
  );

  assert.equal(shopHome.id, inventoryHome.id);
  assert.deepEqual(
    state.tabs.map((tab) => [tab.id, tab.database, tab.databaseKey, tab.title]),
    [
      [shopHome.id, "inventory", "demo\u001finventory", "首页"],
    ],
  );
  assert.deepEqual(inventoryHome.selectedTableNames, []);
});

test("openDatabaseHomeTab cleans up duplicate homepage tabs from older state", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const first = openDatabaseHomeTab(state, {}, { paneId: "pane-1" });
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  const staleDuplicate = {
    ...first,
    id: "tab-stale-home",
    database: "legacy",
    databaseKey: "demo\u001flegacy",
    tabKey: "home\u001fdemo\u001flegacy",
  };
  state.tabs.push(staleDuplicate);
  state.panes["pane-2"].tabIds.push(staleDuplicate.id);
  state.panes["pane-2"].activeTabId = staleDuplicate.id;
  state.activeTabId = staleDuplicate.id;
  state.focusedPaneId = "pane-2";

  const restored = openDatabaseHomeTab(state, {}, { paneId: "pane-2" });

  assert.equal(restored.id, staleDuplicate.id);
  assert.deepEqual(state.tabs.map((tab) => [tab.id, tab.kind, tab.database]), [[staleDuplicate.id, "home", "shop"]]);
  assert.deepEqual(state.panes["pane-1"].tabIds, []);
  assert.deepEqual(state.panes["pane-2"].tabIds, [staleDuplicate.id]);
  assert.equal(state.activeTabId, staleDuplicate.id);
});

test("closing table object tabs preserves the database homepage", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const home = openDatabaseHomeTab(state);
  openTableTab(state, { tableName: "orders" });
  openDesignTab(state, { tableName: "orders" });
  openTableTab(state, { tableName: "customers" });

  const closed = closeTableObjectTabs(state, {
    connectionId: "demo",
    database: "shop",
    tableNames: ["orders"],
  });

  assert.deepEqual(closed.map((tab) => tab.kind).sort(), ["data", "design"]);
  assert.deepEqual(
    state.tabs.map((tab) => [tab.kind, tab.tableName || tab.database]),
    [
      ["home", "shop"],
      ["data", "customers"],
    ],
  );
  assert.equal(state.tabs[0].id, home.id);
});

test("database homepage tab is pinned and not closed by tab close actions", () => {
  const state = createWorkspaceState({ connectionId: "demo", database: "shop" });
  const home = openDatabaseHomeTab(state);
  const table = openTableTab(state, { tableName: "orders" });

  const directClose = closePaneTab(state, "pane-1", home.id);
  assert.equal(directClose, null);
  assert.deepEqual(state.panes["pane-1"].tabIds, [home.id, table.id]);
  assert.equal(state.tabs.some((tab) => tab.id === home.id), true);

  const closed = closePaneTabs(state, "pane-1");
  assert.deepEqual(closed.map((tab) => tab.id), [table.id]);
  assert.deepEqual(state.panes["pane-1"].tabIds, [home.id]);
  assert.equal(state.panes["pane-1"].activeTabId, home.id);
  assert.deepEqual(state.tabs.map((tab) => [tab.kind, tab.title]), [["home", "首页"]]);
});

test("createWorkspaceState initializes a single focused table pane", () => {
  const state = createWorkspaceState();

  assert.equal(state.focusedPaneId, "pane-1");
  assert.deepEqual(state.layout, { type: "pane", paneId: "pane-1" });
  assert.deepEqual(getFocusedPane(state), {
    id: "pane-1",
    tabIds: [],
    activeTabId: "",
  });
  assert.equal(getFocusedTab(state), null);
});

test("openTableTab reuses same-source tabs only within the target pane", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  state.layout = {
    type: "split",
    id: "split-1",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "pane", paneId: "pane-1" },
    second: { type: "pane", paneId: "pane-2" },
  };

  const left = openTableTab(state, { tableName: "items" }, { paneId: "pane-1" });
  const reusedLeft = openTableTab(state, { tableName: "items" }, { paneId: "pane-1" });
  const right = openTableTab(state, { tableName: "items" }, { paneId: "pane-2" });

  assert.equal(reusedLeft.id, left.id);
  assert.notEqual(right.id, left.id);
  assert.equal(left.tableKey, right.tableKey);
  assert.deepEqual(state.panes["pane-1"].tabIds, [left.id]);
  assert.deepEqual(state.panes["pane-2"].tabIds, [right.id]);
  assert.equal(state.panes["pane-2"].activeTabId, right.id);
  assert.equal(state.activeTabId, right.id);
});

test("focusPane updates the global active tab to the pane active tab", () => {
  const state = createWorkspaceState();
  const left = openTableTab(state, { tableName: "items" }, { paneId: "pane-1" });
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  const right = openTableTab(state, { tableName: "quests" }, { paneId: "pane-2" });

  focusPane(state, "pane-1");
  assert.equal(state.focusedPaneId, "pane-1");
  assert.equal(state.activeTabId, left.id);
  assert.equal(getFocusedTab(state).id, left.id);

  focusPane(state, "pane-2");
  assert.equal(state.activeTabId, right.id);
  assert.equal(getFocusedTab(state).id, right.id);
});

test("moveTabBetweenPanes transfers ownership and updates active tabs", () => {
  const state = createWorkspaceState();
  const first = openTableTab(state, { tableName: "items" }, { paneId: "pane-1" });
  const second = openTableTab(state, { tableName: "quests" }, { paneId: "pane-1" });
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };

  const moved = moveTabBetweenPanes(state, second.id, "pane-2");

  assert.equal(moved.id, second.id);
  assert.deepEqual(state.panes["pane-1"].tabIds, [first.id]);
  assert.deepEqual(state.panes["pane-2"].tabIds, [second.id]);
  assert.equal(state.panes["pane-1"].activeTabId, first.id);
  assert.equal(state.panes["pane-2"].activeTabId, second.id);
  assert.equal(state.focusedPaneId, "pane-2");
  assert.equal(state.activeTabId, second.id);
});

test("closePaneTab activates the nearest remaining tab in the same pane", () => {
  const state = createWorkspaceState();
  const first = openTableTab(state, { tableName: "items" }, { paneId: "pane-1" });
  const second = openTableTab(state, { tableName: "quests" }, { paneId: "pane-1" });

  const closed = closePaneTab(state, "pane-1", second.id);

  assert.equal(closed.id, second.id);
  assert.deepEqual(state.panes["pane-1"].tabIds, [first.id]);
  assert.equal(state.panes["pane-1"].activeTabId, first.id);
  assert.equal(state.activeTabId, first.id);
});

test("openTableTab can stage a new table without activating it", () => {
  const state = createWorkspaceState();
  const first = openTableTab(state, { tableName: "items" });
  const staged = openTableTab(state, { tableName: "quests" }, { activate: false });

  assert.equal(state.tabs.length, 2);
  assert.equal(staged.tableName, "quests");
  assert.equal(state.activeTabId, first.id);
});

test("data and design tabs for the same table coexist with shared source identity", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });

  const dataTab = openTableTab(state, { tableName: "items", tableComment: "道具表" });
  const designTab = openDesignTab(state, { tableName: "items", tableComment: "道具表" });

  assert.equal(dataTab.kind, "data");
  assert.equal(designTab.kind, "design");
  assert.equal(dataTab.tableKey, "mysql-1gameitems");
  assert.equal(designTab.tableKey, dataTab.tableKey);
  assert.notEqual(designTab.tabKey, dataTab.tabKey);
  assert.equal(state.tabs.length, 2);
  assert.deepEqual(
    state.tabs.map((tab) => [tab.kind, tab.tableName]),
    [
      ["data", "items"],
      ["design", "items"],
    ],
  );
});

test("openTableTab reuses only data tabs when a design tab exists", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });

  const designTab = openDesignTab(state, { tableName: "items" });
  const dataTab = openTableTab(state, { tableName: "items" });
  const reusedDataTab = openTableTab(state, { tableName: "items" });

  assert.equal(reusedDataTab.id, dataTab.id);
  assert.notEqual(dataTab.id, designTab.id);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeTabId, dataTab.id);
});

test("openTableDesignTab reuses design tabs without replacing same-source data tabs", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });

  const dataTab = openTableTab(state, { tableName: "items" });
  const firstDesignTab = openDesignTab(state, { tableName: "items", tableComment: "道具表" });
  const reusedDesignTab = openDesignTab(state, { tableName: "items", tableComment: "道具表" });

  assert.equal(reusedDesignTab.id, firstDesignTab.id);
  assert.notEqual(reusedDesignTab.id, dataTab.id);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeTabId, firstDesignTab.id);
  assert.deepEqual(
    Object.keys(firstDesignTab).filter((key) => ["kind", "connectionId", "database", "tableName", "tableKey", "tabKey", "tableComment", "loading", "saving", "error", "design", "draft", "dirty", "preview"].includes(key)).sort(),
    ["connectionId", "database", "design", "dirty", "draft", "error", "kind", "loading", "preview", "saving", "tabKey", "tableComment", "tableKey", "tableName"].sort(),
  );
});

test("openTableDesignTab keeps same-named tables from different databases distinct", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "dev_game" });

  const devDesignTab = openDesignTab(state, {
    connectionId: "mysql-1",
    database: "dev_game",
    tableName: "hero",
  });
  const liveDesignTab = openDesignTab(state, {
    connectionId: "mysql-1",
    database: "live_game",
    tableName: "hero",
  });
  const reusedLiveDesignTab = openDesignTab(state, {
    connectionId: "mysql-1",
    database: "live_game",
    tableName: "hero",
  });

  assert.notEqual(devDesignTab.id, liveDesignTab.id);
  assert.equal(reusedLiveDesignTab.id, liveDesignTab.id);
  assert.deepEqual(
    state.tabs.map((tab) => [tab.kind, tab.connectionId, tab.database, tab.tableName]),
    [
      ["design", "mysql-1", "dev_game", "hero"],
      ["design", "mysql-1", "live_game", "hero"],
    ],
  );
});

test("openTableTab keeps same-named tables from different databases in separate tabs", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "dev_game" });

  const devTab = openTableTab(state, {
    connectionId: "mysql-1",
    database: "dev_game",
    tableName: "hero",
  });
  const liveTab = openTableTab(state, {
    connectionId: "mysql-1",
    database: "live_game",
    tableName: "hero",
  });
  const reusedLiveTab = openTableTab(state, {
    connectionId: "mysql-1",
    database: "live_game",
    tableName: "hero",
  });

  assert.notEqual(devTab.id, liveTab.id);
  assert.equal(reusedLiveTab.id, liveTab.id);
  assert.deepEqual(
    state.tabs.map((tab) => [tab.connectionId, tab.database, tab.tableName]),
    [
      ["mysql-1", "dev_game", "hero"],
      ["mysql-1", "live_game", "hero"],
    ],
  );
});

test("findTableDataTabs returns only data tabs for the same source identity", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "dev_game" });
  const devData = openTableTab(state, {
    connectionId: "mysql-1",
    database: "dev_game",
    tableName: "hero",
  });
  const liveData = openTableTab(state, {
    connectionId: "mysql-1",
    database: "live_game",
    tableName: "hero",
  });
  const otherConnectionData = openTableTab(state, {
    connectionId: "mysql-2",
    database: "dev_game",
    tableName: "hero",
  });
  const designTab = openDesignTab(state, {
    connectionId: "mysql-1",
    database: "dev_game",
    tableName: "hero",
  });

  assert.equal(typeof workspaceState.findTableDataTabs, "function", "findTableDataTabs should be exported");
  assert.deepEqual(
    workspaceState.findTableDataTabs(state, {
      connectionId: "mysql-1",
      database: "dev_game",
      tableName: "hero",
      tableKey: devData.tableKey,
    }).map((tab) => tab.id),
    [devData.id],
  );
  assert.notEqual(liveData.tableKey, devData.tableKey);
  assert.notEqual(otherConnectionData.tableKey, devData.tableKey);
  assert.equal(designTab.tableKey, devData.tableKey);
});

test("applyTableSchemaToDataTab replaces schema metadata and clears stale selections", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(state, { tableName: "items", tableComment: "旧备注" });
  tab.columns = [{ column_name: "id", is_primary_key: true }];
  tab.primaryKeys = ["id"];
  tab.selectedRowKeys.add("id=1");

  assert.equal(typeof workspaceState.applyTableSchemaToDataTab, "function", "applyTableSchemaToDataTab should be exported");
  workspaceState.applyTableSchemaToDataTab(tab, {
    table_comment: "新备注",
    columns: [
      { column_name: "code", is_primary_key: false },
      { column_name: "label", is_primary_key: false },
    ],
  });

  assert.equal(tab.tableComment, "新备注");
  assert.deepEqual(tab.columns.map((column) => column.column_name), ["code", "label"]);
  assert.deepEqual(tab.primaryKeys, []);
  assert.equal(tab.selectedRowKeys.size, 0);
});

test("applyTableSchemaToDataTab migrates renamed column state before refresh", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(state, { tableName: "player" });
  tab.columns = [
    { column_name: "id", is_primary_key: true },
    { column_name: "username", is_primary_key: false },
    { column_name: "nickname", is_primary_key: false },
  ];
  tab.primaryKeys = ["id"];
  tab.rows = [{ id: "1", username: "alice", nickname: "Ali" }];
  tab.sort = { columnName: "username", descending: true };

  workspaceState.applyTableSchemaToDataTab(tab, {
    columns: [
      { column_name: "id", is_primary_key: true },
      { column_name: "login_name", is_primary_key: false },
      { column_name: "nickname", is_primary_key: false },
    ],
  });

  assert.deepEqual(tab.primaryKeys, ["id"]);
  assert.deepEqual(tab.sort, { columnName: "login_name", descending: true });
  assert.deepEqual(tab.rows, [{ id: "1", login_name: "alice", nickname: "Ali" }]);
});

test("markTableDataTabSchemaStale clears stale rows and session while applying safe schema metadata", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(state, { tableName: "items", tableComment: "旧备注" });
  tab.sessionId = "old-session";
  tab.columns = [{ column_name: "id", is_primary_key: true }];
  tab.primaryKeys = ["id"];
  tab.rows = [{ id: 1, old_name: "Potion" }];
  tab.totalRows = 25;
  tab.page = 3;
  tab.pageSize = 50;
  tab.loading = true;
  tab.loadingMore = true;
  tab.fullyLoaded = false;
  tab.selectedRowKeys.add("id=1");

  assert.equal(typeof workspaceState.markTableDataTabSchemaStale, "function", "markTableDataTabSchemaStale should be exported");
  workspaceState.markTableDataTabSchemaStale(tab, {
    table_comment: "新备注",
    columns: [
      { column_name: "code", is_primary_key: true },
      { column_name: "label", is_primary_key: false },
    ],
  });

  assert.equal(tab.tableComment, "新备注");
  assert.deepEqual(tab.columns.map((column) => column.column_name), ["code", "label"]);
  assert.deepEqual(tab.primaryKeys, ["code"]);
  assert.deepEqual(tab.rows, []);
  assert.equal(tab.totalRows, 0);
  assert.equal(tab.page, 1);
  assert.equal(tab.pageSize, 50);
  assert.equal(tab.sessionId, "");
  assert.equal(tab.loading, false);
  assert.equal(tab.loadingMore, false);
  assert.equal(tab.fullyLoaded, true);
  assert.equal(tab.selectedRowKeys.size, 0);
});

test("moveTableTab reorders tabs and keeps the active tab selected", () => {
  const state = createWorkspaceState();
  const first = openTableTab(state, { tableName: "items" });
  const second = openTableTab(state, { tableName: "quests" });
  const third = openTableTab(state, { tableName: "npc" });
  state.activeTabId = second.id;

  moveTableTab(state, first.id, third.id, { position: "after" });

  assert.deepEqual(state.tabs.map((tab) => tab.id), [second.id, third.id, first.id]);
  assert.equal(state.activeTabId, second.id);
});

test("mixed data and design tabs close, reorder, activate, and resolve active tab by id", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const itemsData = openTableTab(state, { tableName: "items" });
  const itemsDesign = openDesignTab(state, { tableName: "items" });
  const questsData = openTableTab(state, { tableName: "quests" });

  moveTableTab(state, itemsDesign.id, questsData.id, { position: "after" });
  assert.deepEqual(state.tabs.map((tab) => [tab.kind, tab.tableName]), [
    ["data", "items"],
    ["data", "quests"],
    ["design", "items"],
  ]);

  activateTableTab(state, itemsDesign.id);
  assert.equal(getActiveTab(state).id, itemsDesign.id);

  closeTableTab(state, itemsDesign.id);
  assert.equal(state.activeTabId, questsData.id);
  assert.deepEqual(state.tabs.map((tab) => [tab.kind, tab.tableName]), [
    ["data", "items"],
    ["data", "quests"],
  ]);
});

test("closeTableTab activates the nearest remaining tab", () => {
  const state = createWorkspaceState();
  const first = openTableTab(state, { tableName: "items" });
  const second = openTableTab(state, { tableName: "quests" });
  const third = openTableTab(state, { tableName: "npc" });

  closeTableTab(state, second.id);
  assert.equal(state.activeTabId, third.id);

  closeTableTab(state, third.id);
  assert.equal(state.activeTabId, first.id);
});

test("closeAllTableTabs removes every tab and clears active tab", () => {
  const state = createWorkspaceState();
  openTableTab(state, { tableName: "items" });
  openTableTab(state, { tableName: "quests" });

  closeAllTableTabs(state);

  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, "");

  closeAllTableTabs(state);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.activeTabId, "");
});

test("closePaneTabs removes only tabs in the selected pane", () => {
  const state = createWorkspaceState();
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  state.layout = {
    type: "split",
    id: "split-1",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "pane", paneId: "pane-1" },
    second: { type: "pane", paneId: "pane-2" },
  };
  const leftFirst = openTableTab(state, { tableName: "items" }, { paneId: "pane-1" });
  const leftSecond = openTableTab(state, { tableName: "quests" }, { paneId: "pane-1" });
  const right = openTableTab(state, { tableName: "hero" }, { paneId: "pane-2" });

  const closed = closePaneTabs(state, "pane-1");

  assert.deepEqual(closed.map((tab) => tab.id), [leftFirst.id, leftSecond.id]);
  assert.deepEqual(state.tabs.map((tab) => tab.id), [right.id]);
  assert.deepEqual(state.panes["pane-1"].tabIds, []);
  assert.equal(state.panes["pane-1"].activeTabId, "");
  assert.deepEqual(state.panes["pane-2"].tabIds, [right.id]);
  assert.equal(state.panes["pane-2"].activeTabId, right.id);
  assert.equal(state.focusedPaneId, "pane-1");
  assert.equal(state.activeTabId, "");
});

test("closeDatabaseTabs removes only tabs for the selected database target", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "dev_game" });
  const devHero = openTableTab(state, { connectionId: "mysql-1", database: "dev_game", tableName: "hero" });
  openTableTab(state, { connectionId: "mysql-1", database: "dev_game", tableName: "item" });
  const liveHero = openTableTab(state, { connectionId: "mysql-1", database: "live_game", tableName: "hero" });
  state.activeTabId = devHero.id;

  const closed = closeDatabaseTabs(state, { connectionId: "mysql-1", database: "dev_game" });

  assert.deepEqual(closed.map((tab) => tab.tableName), ["hero", "item"]);
  assert.deepEqual(state.tabs.map((tab) => [tab.connectionId, tab.database, tab.tableName]), [
    ["mysql-1", "live_game", "hero"],
  ]);
  assert.equal(state.activeTabId, liveHero.id);
});

test("closePaneTab can discard an inactive provisional tab without changing focus", () => {
  const state = createWorkspaceState();
  const pane1 = state.panes[state.focusedPaneId];
  state.panes["pane-2"] = { id: "pane-2", tabIds: [], activeTabId: "" };
  const pane2 = state.panes["pane-2"];
  const current = openTableTab(state, { tableName: "current" }, { paneId: pane1.id, activate: true });
  const pending = openTableTab(state, { tableName: "pending" }, { paneId: pane2.id, activate: false });
  const originalFocusedPaneId = state.focusedPaneId;
  const originalActiveTabId = state.activeTabId;

  closePaneTab(state, pane2.id, pending.id, { focusOwner: false });

  assert.equal(state.focusedPaneId, originalFocusedPaneId);
  assert.equal(state.activeTabId, originalActiveTabId);
  assert.equal(state.tabs.some((tab) => tab.id === pending.id), false);
  assert.equal(state.tabs.some((tab) => tab.id === current.id), true);
});

test("closeConnectionTabs removes tabs across all databases for a connection", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "dev_game" });
  const devHero = openTableTab(state, { connectionId: "mysql-1", database: "dev_game", tableName: "hero" });
  const liveHero = openTableTab(state, { connectionId: "mysql-1", database: "live_game", tableName: "hero" });
  const other = openTableTab(state, { connectionId: "mysql-2", database: "live_game", tableName: "hero" });
  state.activeTabId = devHero.id;

  const closed = closeConnectionTabs(state, { connectionId: "mysql-1" });

  assert.deepEqual(
    closed.map((tab) => [tab.connectionId, tab.database, tab.tableName]),
    [
      ["mysql-1", "dev_game", "hero"],
      ["mysql-1", "live_game", "hero"],
    ],
  );
  assert.deepEqual(state.tabs.map((tab) => tab.id), [other.id]);
  assert.equal(state.activeTabId, other.id);
});

test("replaceTabPage stores paged rows without mutating other tabs", () => {
  const state = createWorkspaceState();
  const first = openTableTab(state, { tableName: "items" });
  const second = openTableTab(state, { tableName: "quests" });

  replaceTabPage(state, first.id, {
    sessionId: "session-items",
    rows: [{ id: "1", name: "Potion" }],
    columns: [{ column_name: "id" }, { column_name: "name" }],
    totalRows: 1,
    page: 1,
    pageSize: 100,
  });

  assert.equal(state.tabs.find((tab) => tab.id === first.id).sessionId, "session-items");
  assert.equal(state.tabs.find((tab) => tab.id === second.id).rows.length, 0);
});

test("replaceTabPage marks zero-row results as fully loaded", () => {
  const state = createWorkspaceState();
  const tab = openTableTab(state, { tableName: "empty_table" });

  const updated = replaceTabPage(state, tab.id, {
    sessionId: "session-empty",
    rows: [],
    columns: [{ column_name: "id" }],
    totalRows: 0,
    page: 1,
    pageSize: 100,
  });

  assert.equal(updated.fullyLoaded, true);
});

test("replaceTabPage preserves unknown total metadata and keeps more rows available", () => {
  const state = createWorkspaceState();
  const tab = openTableTab(state, { tableName: "large_table" });
  const previousVersion = tab.rowKeyCacheVersion;

  const updated = replaceTabPage(state, tab.id, {
    sessionId: "session-large",
    rows: Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 1) })),
    columns: [{ column_name: "id" }],
    totalRows: 1000,
    totalRowsExact: false,
    hasMore: true,
    page: 1,
    pageSize: 1000,
  });

  assert.equal(updated.totalRows, 1000);
  assert.equal(updated.totalRowsExact, false);
  assert.equal(updated.hasMore, true);
  assert.equal(updated.fullyLoaded, false);
  assert.equal(updated.rowKeyCacheVersion, previousVersion + 1);
});

test("updateTabTotalMetadata refreshes exact row count without replacing rendered rows", () => {
  const state = createWorkspaceState();
  const tab = openTableTab(state, { tableName: "large_table" });
  replaceTabPage(state, tab.id, {
    sessionId: "session-large",
    rows: [{ id: "1" }, { id: "2" }],
    columns: [{ column_name: "id" }],
    totalRows: 2,
    totalRowsExact: false,
    hasMore: true,
    page: 1,
    pageSize: 2,
  });
  tab.totalRowsLoading = true;
  const previousRows = tab.rows;
  const previousColumns = tab.columns;
  const previousVersion = tab.rowKeyCacheVersion;

  const updated = updateTabTotalMetadata(state, tab.id, {
    totalRows: 12345,
    totalRowsExact: true,
    hasMore: true,
  });

  assert.equal(updated.totalRows, 12345);
  assert.equal(updated.totalRowsExact, true);
  assert.equal(updated.hasMore, true);
  assert.equal(updated.fullyLoaded, false);
  assert.equal(updated.totalRowsLoading, false);
  assert.equal(updated.totalRowsError, "");
  assert.equal(updated.rows, previousRows);
  assert.equal(updated.columns, previousColumns);
  assert.equal(updated.rowKeyCacheVersion, previousVersion);
});

test("appendTabPage stops loading when an unknown-total page reports no more rows", () => {
  const state = createWorkspaceState();
  const tab = openTableTab(state, { tableName: "large_table" });
  replaceTabPage(state, tab.id, {
    sessionId: "session-large",
    rows: [{ id: "1" }],
    columns: [{ column_name: "id" }],
    totalRows: 1,
    totalRowsExact: false,
    hasMore: true,
    page: 1,
    pageSize: 1,
  });
  const previousVersion = tab.rowKeyCacheVersion;

  const updated = appendTabPage(state, tab.id, {
    sessionId: "session-large",
    rows: [{ id: "2" }],
    totalRows: 2,
    totalRowsExact: false,
    hasMore: false,
    page: 2,
    pageSize: 1,
  });

  assert.deepEqual(updated.rows, [{ id: "1" }, { id: "2" }]);
  assert.equal(updated.totalRows, 2);
  assert.equal(updated.totalRowsExact, false);
  assert.equal(updated.hasMore, false);
  assert.equal(updated.fullyLoaded, true);
  assert.equal(updated.rowKeyCacheVersion, previousVersion + 1);
});

test("appendTabPage does not downgrade an exact total when a fast appended page omits counting", () => {
  const state = createWorkspaceState();
  const tab = openTableTab(state, { tableName: "large_table" });
  replaceTabPage(state, tab.id, {
    sessionId: "session-large",
    rows: [{ id: "1" }],
    columns: [{ column_name: "id" }],
    totalRows: 5000,
    totalRowsExact: true,
    hasMore: true,
    page: 1,
    pageSize: 1,
  });

  const updated = appendTabPage(state, tab.id, {
    sessionId: "session-large",
    rows: [{ id: "2" }],
    totalRows: 2,
    totalRowsExact: false,
    hasMore: true,
    page: 2,
    pageSize: 1,
  });

  assert.deepEqual(updated.rows, [{ id: "1" }, { id: "2" }]);
  assert.equal(updated.totalRows, 5000);
  assert.equal(updated.totalRowsExact, true);
  assert.equal(updated.hasMore, true);
  assert.equal(updated.fullyLoaded, false);
});

test("appending 100 pages preserves dense storage identity and advances one generation per page", () => {
  const state = createWorkspaceState();
  const tab = openTableTab(state, { tableName: "large_table" });
  replaceTabPage(state, tab.id, {
    rows: [{ id: "0" }],
    page: 1,
    pageSize: 1,
    hasMore: true,
  });
  const originalRows = tab.rows;
  const initialGeneration = tab.dataVersion;

  for (let page = 2; page <= 101; page += 1) {
    appendTabPage(state, tab.id, {
      rows: [{ id: String(page - 1) }],
      page,
      pageSize: 1,
      hasMore: page < 101,
    });
  }

  assert.equal(tab.rows, originalRows);
  assert.equal(tab.rows.length, 101);
  assert.equal(tab.dataVersion, initialGeneration + 100);
});

test("filterSchemaTree keeps matching tables and matching columns", () => {
  const tree = [
    {
      tableName: "items",
      tableComment: "道具配置",
      columns: [
        { column_name: "id", column_comment: "主键" },
        { column_name: "display_name", column_comment: "展示名称" },
      ],
    },
    {
      tableName: "quests",
      tableComment: "任务配置",
      columns: [{ column_name: "reward_item", column_comment: "奖励道具" }],
    },
  ];

  assert.deepEqual(
    filterSchemaTree(tree, "奖励").map((table) => ({
      tableName: table.tableName,
      columns: table.columns.map((column) => column.column_name),
    })),
    [{ tableName: "quests", columns: ["reward_item"] }],
  );

  assert.deepEqual(
    filterSchemaTree(tree, "items").map((table) => table.tableName),
    ["items"],
  );
});

test("filterSchemaTree handles similar table names and long remarks", () => {
  const tree = [
    {
      tableName: "user",
      tableComment: "相似表名测试：user，备注里也提到 users/order/orders，用于验证搜索和备注换行。",
      columns: [{ column_name: "remark", column_comment: "很长的字段备注，用于验证右侧备注面板可以自动换行展示" }],
    },
    {
      tableName: "users",
      tableComment: "相似表名测试：users，只比 user 多一个 s。",
      columns: [{ column_name: "name", column_comment: "名称字段" }],
    },
    {
      tableName: "ui_edge_case_values",
      tableComment: "UI边界测试表：包含超长备注、嵌套JSON、TypeScript函数",
      columns: [{ column_name: "ts_function", column_comment: "TypeScript函数文本" }],
    },
  ];

  assert.deepEqual(filterSchemaTree(tree, "users").map((table) => table.tableName), ["users", "user"]);
  assert.deepEqual(filterSchemaTree(tree, "USERS").map((table) => table.tableName), ["users", "user"]);
  assert.deepEqual(filterSchemaTree(tree, "TypeScript").map((table) => table.tableName), ["ui_edge_case_values"]);
  assert.deepEqual(filterSchemaTree(tree, "自动换行").map((table) => table.tableName), ["user"]);
});

test("filterSchemaTree ranks table-name matches before comment and column matches", () => {
  const tree = [
    { tableName: "audit_log", tableComment: "mentions user_profile and customer_id", columns: [{ column_name: "note", column_comment: "customer_id" }] },
    { tableName: "user_profile", tableComment: "profile table", columns: [{ column_name: "name", column_comment: "" }] },
    { tableName: "user_profiles", tableComment: "profiles table", columns: [{ column_name: "name", column_comment: "" }] },
    { tableName: "column_hit", tableComment: "", columns: [{ column_name: "customer_id", column_comment: "" }] },
  ];

  assert.deepEqual(filterSchemaTree(tree, "user_profile").map((table) => table.tableName), ["user_profile", "user_profiles", "audit_log"]);
  assert.deepEqual(filterSchemaTree(tree, "profile").map((table) => table.tableName), ["user_profile", "user_profiles", "audit_log"]);
  assert.deepEqual(filterSchemaTree(tree, "customer_id").map((table) => table.tableName), ["column_hit", "audit_log"]);
});

test("filterSchemaTree supports subsequence fuzzy matches while keeping continuous matches first", () => {
  const tree = [
    { tableName: "hrp_config", tableComment: "", columns: [{ column_name: "name", column_comment: "" }] },
    { tableName: "heroprop", tableComment: "", columns: [{ column_name: "name", column_comment: "" }] },
    { tableName: "settings", tableComment: "Hero reward package", columns: [{ column_name: "note", column_comment: "" }] },
    { tableName: "columns", tableComment: "", columns: [{ column_name: "hero_power", column_comment: "" }] },
  ];

  assert.deepEqual(filterSchemaTree(tree, "hrp").map((table) => table.tableName), [
    "hrp_config",
    "heroprop",
    "columns",
    "settings",
  ]);
});

test("filterSchemaTree keeps table-name subsequence matches ahead of exact field-name matches", () => {
  const tree = [
    { tableName: "field_hit", tableComment: "", columns: [{ column_name: "hrp", column_comment: "" }] },
    { tableName: "heroprop", tableComment: "", columns: [{ column_name: "name", column_comment: "" }] },
  ];

  assert.deepEqual(filterSchemaTree(tree, "hrp").map((table) => table.tableName), [
    "heroprop",
    "field_hit",
  ]);
});

test("filterSchemaTree ranks typo-similar table names before scattered table-name matches", () => {
  const tree = [
    { tableName: "actthemedrawencmodelprop", tableComment: "", columns: [{ column_name: "name", column_comment: "" }] },
    { tableName: "heroprop", tableComment: "", columns: [{ column_name: "name", column_comment: "" }] },
  ];

  assert.deepEqual(filterSchemaTree(tree, "heropop").map((table) => table.tableName), [
    "heroprop",
    "actthemedrawencmodelprop",
  ]);
});

test("buildSchemaSearchResults exposes subsequence field comment matches", () => {
  const tree = [
    {
      tableName: "item",
      tableComment: "",
      columns: [{ column_name: "note", column_comment: "Hero reward package" }],
    },
  ];

  const [result] = buildSchemaSearchResults(tree, "hrp");

  assert.equal(result.matchKind, "columnComment");
  assert.deepEqual(result.visibleColumns.map((column) => column.column_name), ["note"]);
});

test("createWorkspaceState no longer carries legacy global data search state", () => {
  const state = createWorkspaceState({ database: "game" });
  assert.equal("quickSearchResults" in state, false);
  assert.equal("quickSearchQuery" in state, false);
  assert.equal("dataSearchResults" in state, false);
  assert.equal("dataSearchLoading" in state, false);
});

test("buildSchemaSearchResults exposes table comment matches", () => {
  const tree = [
    { tableName: "player", tableComment: "玩家账号表", columns: [] },
    { tableName: "item", tableComment: "道具配置", columns: [] },
  ];

  const results = buildSchemaSearchResults(tree, "账号");

  assert.equal(results.length, 1);
  assert.equal(results[0].table.tableName, "player");
  assert.equal(results[0].matchKind, "tableComment");
  assert.equal(results[0].matchedColumns.length, 0);
});

test("buildSchemaSearchResults exposes column name and comment matches", () => {
  const tree = [
    {
      tableName: "player",
      tableComment: "玩家账号表",
      columns: [
        { column_name: "nickname", column_comment: "昵称" },
        { column_name: "last_login_at", column_comment: "最后登录时间" },
      ],
    },
  ];

  assert.deepEqual(
    buildSchemaSearchResults(tree, "login").map((result) => ({
      tableName: result.table.tableName,
      matchKind: result.matchKind,
      columns: result.matchedColumns.map((column) => column.column_name),
    })),
    [{ tableName: "player", matchKind: "columnName", columns: ["last_login_at"] }],
  );

  assert.deepEqual(
    buildSchemaSearchResults(tree, "昵称").map((result) => ({
      tableName: result.table.tableName,
      matchKind: result.matchKind,
      columns: result.matchedColumns.map((column) => column.column_name),
    })),
    [{ tableName: "player", matchKind: "columnComment", columns: ["nickname"] }],
  );
});

test("buildSchemaSearchResults caps visible column matches and reports overflow", () => {
  const table = {
    tableName: "wide_table",
    tableComment: "",
    columns: [
      { column_name: "match_a", column_comment: "" },
      { column_name: "match_b", column_comment: "" },
      { column_name: "match_c", column_comment: "" },
      { column_name: "match_d", column_comment: "" },
    ],
  };

  const [result] = buildSchemaSearchResults([table], "match");

  assert.deepEqual(result.visibleColumns.map((column) => column.column_name), ["match_a", "match_b", "match_c"]);
  assert.equal(result.hiddenColumnCount, 1);
});

test("renameTableTab updates data tab tableName, tableKey and tabKey", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = openTableTab(state, { tableName: "player", tableComment: "玩家表" });
  const oldTabKey = tab.tabKey;

  const updated = renameTableTab(state, {
    connectionId: "mysql-1",
    database: "game",
    oldName: "player",
    newName: "player_v2",
  });

  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, tab.id);
  assert.equal(tab.tableName, "player_v2");
  assert.equal(tab.tableKey, "mysql-1gameplayer_v2");
  assert.notEqual(tab.tabKey, oldTabKey);
  assert.ok(tab.tabKey.includes("player_v2"));
});

test("renameTableTab updates design tab tableName, tableKey and tabKey", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const tab = workspaceState.openTableDesignTab(state, { tableName: "player" });
  const oldTabKey = tab.tabKey;

  const updated = renameTableTab(state, {
    connectionId: "mysql-1",
    database: "game",
    oldName: "player",
    newName: "player_v2",
  });

  assert.equal(updated.length, 1);
  assert.equal(tab.tableName, "player_v2");
  assert.equal(tab.tableKey, "mysql-1gameplayer_v2");
  assert.notEqual(tab.tabKey, oldTabKey);
});

test("renameTableTab updates all tabs referencing the old table name", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const dataTab = openTableTab(state, { tableName: "player" });
  const designTab = workspaceState.openTableDesignTab(state, { tableName: "player" });
  const otherTab = openTableTab(state, { tableName: "quests" });

  const updated = renameTableTab(state, {
    connectionId: "mysql-1",
    database: "game",
    oldName: "player",
    newName: "player_v2",
  });

  assert.equal(updated.length, 2);
  assert.equal(dataTab.tableName, "player_v2");
  assert.equal(designTab.tableName, "player_v2");
  // Unrelated tab should not be touched
  assert.equal(otherTab.tableName, "quests");
});

test("renameTableTab ignores tabs from other databases or connections", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const sameDb = openTableTab(state, { connectionId: "mysql-1", database: "game", tableName: "player" });
  const otherDb = openTableTab(state, { connectionId: "mysql-1", database: "analytics", tableName: "player" });
  const otherConn = openTableTab(state, { connectionId: "mysql-2", database: "game", tableName: "player" });

  const updated = renameTableTab(state, {
    connectionId: "mysql-1",
    database: "game",
    oldName: "player",
    newName: "player_v2",
  });

  assert.equal(updated.length, 1);
  assert.equal(sameDb.tableName, "player_v2");
  assert.equal(otherDb.tableName, "player");
  assert.equal(otherConn.tableName, "player");
});

test("renameTableTab returns empty array when no tabs match", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  openTableTab(state, { tableName: "quests" });

  const updated = renameTableTab(state, {
    connectionId: "mysql-1",
    database: "game",
    oldName: "nonexistent",
    newName: "renamed",
  });

  assert.deepEqual(updated, []);
});

test("renameTableTab returns empty array for same old and new name", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  openTableTab(state, { tableName: "player" });

  const updated = renameTableTab(state, {
    connectionId: "mysql-1",
    database: "game",
    oldName: "player",
    newName: "player",
  });

  assert.deepEqual(updated, []);
});

test("renameTableTab preserves tab identity after rename so openTableTab finds the renamed tab", () => {
  const state = createWorkspaceState({ connectionId: "mysql-1", database: "game" });
  const original = openTableTab(state, { tableName: "player" });

  renameTableTab(state, {
    connectionId: "mysql-1",
    database: "game",
    oldName: "player",
    newName: "player_v2",
  });

  // openTableTab with the new name should reuse the renamed tab
  const reopened = openTableTab(state, { tableName: "player_v2" });
  assert.equal(reopened.id, original.id);
  assert.equal(reopened.tableName, "player_v2");
});
