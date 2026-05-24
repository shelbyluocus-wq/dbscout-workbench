import test from "node:test";
import assert from "node:assert/strict";

import {
  closeTableTab,
  createWorkspaceState,
  filterSchemaTree,
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

test("createWorkspaceState has dataSearchResults instead of quickSearchResults", () => {
  const state = createWorkspaceState({ database: "game" });
  assert.equal("quickSearchResults" in state, false);
  assert.equal("quickSearchQuery" in state, false);
  assert.ok(Array.isArray(state.dataSearchResults));
  assert.equal(state.dataSearchLoading, false);
});
