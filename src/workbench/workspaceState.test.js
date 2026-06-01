import test from "node:test";
import assert from "node:assert/strict";

import {
  closeAllTableTabs,
  closeTableTab,
  createWorkspaceState,
  filterSchemaTree,
  moveTableTab,
  openTableTab,
  replaceTabPage,
} from "./workspaceState.js";

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
