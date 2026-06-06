import test from "node:test";
import assert from "node:assert/strict";

import * as workspaceState from "./workspaceState.js";
import {
  activateTableTab,
  buildSchemaSearchResults,
  closeAllTableTabs,
  closeDatabaseTabs,
  closeTableTab,
  createWorkspaceState,
  filterSchemaTree,
  getActiveTab,
  moveTableTab,
  openTableTab,
  replaceTabPage,
} from "./workspaceState.js";

function openDesignTab(state, table, options) {
  assert.equal(typeof workspaceState.openTableDesignTab, "function", "openTableDesignTab should be exported");
  return workspaceState.openTableDesignTab(state, table, options);
}

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

test("createWorkspaceState has dataSearchResults instead of quickSearchResults", () => {
  const state = createWorkspaceState({ database: "game" });
  assert.equal("quickSearchResults" in state, false);
  assert.equal("quickSearchQuery" in state, false);
  assert.ok(Array.isArray(state.dataSearchResults));
  assert.equal(state.dataSearchLoading, false);
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
