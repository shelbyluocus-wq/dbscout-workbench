import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import { createDatabaseHomeController, HOME_SORT_MODES } from "./composables/useDatabaseHome.js";

const tables = [
  { table_name: "orders", table_comment: "订单主表", columns: [{ column_name: "id" }] },
  { table_name: "player", table_comment: "玩家账号表", columns: [{ column_name: "id" }, { column_name: "username" }] },
  { table_name: "audit_log", table_comment: "", columns: [] },
  { table_name: "hero", table_comment: "英雄配置表", columns: [{ column_name: "id" }] },
];

function names(list) {
  return list.map((table) => table.tableName);
}

function createController(options = {}) {
  return createDatabaseHomeController({
    connectionId: "demo",
    database: "game_db",
    tables,
    recentTableNames: ["hero", "orders"],
    ...options,
  });
}

test("database home filters by table name and comment", () => {
  const home = createController();

  home.setQuery("玩家");
  assert.deepEqual(names(home.filteredTables.value), ["player"]);

  home.setQuery("audit");
  assert.deepEqual(names(home.filteredTables.value), ["audit_log"]);
});

test("database home reacts when the table list is replaced after refresh", () => {
  const tableRef = ref([{ table_name: "orders", table_comment: "" }]);
  const home = createController({ tables: tableRef });

  assert.deepEqual(names(home.filteredTables.value), ["orders"]);

  tableRef.value = [
    { table_name: "orders", table_comment: "" },
    { table_name: "player", table_comment: "玩家账号表" },
  ];

  assert.deepEqual(names(home.filteredTables.value), ["orders", "player"]);
});

test("database home recent sort reacts when recent table names change", () => {
  const recent = ref(["orders"]);
  const home = createController({ recentTableNames: recent });

  home.setSortMode(HOME_SORT_MODES.recent);
  assert.equal(names(home.filteredTables.value)[0], "orders");

  recent.value = ["player"];
  assert.equal(names(home.filteredTables.value)[0], "player");
});

test("database home supports all table sort modes", () => {
  const home = createController();

  home.setSortMode(HOME_SORT_MODES.nameAsc);
  assert.deepEqual(names(home.filteredTables.value), ["audit_log", "hero", "orders", "player"]);

  home.setSortMode(HOME_SORT_MODES.nameDesc);
  assert.deepEqual(names(home.filteredTables.value), ["player", "orders", "hero", "audit_log"]);

  home.setSortMode(HOME_SORT_MODES.commentFirst);
  assert.deepEqual(names(home.filteredTables.value), ["hero", "orders", "player", "audit_log"]);

  home.setSortMode(HOME_SORT_MODES.recent);
  assert.deepEqual(names(home.filteredTables.value), ["hero", "orders", "audit_log", "player"]);

  home.setSortMode(HOME_SORT_MODES.original);
  assert.deepEqual(names(home.filteredTables.value), ["orders", "player", "audit_log", "hero"]);
});

test("database home selection supports plain, ctrl, and shift clicks", () => {
  const home = createController();

  home.selectTable("orders", {});
  assert.deepEqual(home.selectedNames.value, ["orders"]);

  home.selectTable("hero", { ctrlKey: true });
  assert.deepEqual(home.selectedNames.value, ["orders", "hero"]);

  home.selectTable("player", {});
  home.selectTable("hero", { shiftKey: true });
  assert.deepEqual(home.selectedNames.value, ["hero", "orders", "player"]);
});

test("database home rename only starts for a single selected table", () => {
  const home = createController();

  home.selectTable("orders", {});
  assert.equal(home.startRename(), true);
  assert.equal(home.renamingName.value, "orders");
  assert.equal(home.renameDraft.value, "orders");

  home.selectTable("hero", { ctrlKey: true });
  assert.equal(home.startRename(), false);
});

test("database home validates inline rename drafts", () => {
  const home = createController();

  assert.deepEqual(home.validateRenameDraft("orders", "orders"), { ok: false, reason: "unchanged" });
  assert.deepEqual(home.validateRenameDraft("orders", " "), { ok: false, reason: "empty" });
  assert.deepEqual(home.validateRenameDraft("orders", "player"), { ok: false, reason: "duplicate" });
  assert.deepEqual(home.validateRenameDraft("orders", "bad/name"), { ok: false, reason: "invalid" });
  assert.deepEqual(home.validateRenameDraft("orders", "orders_archive"), { ok: true, value: "orders_archive" });
});

test("database home copies table object references to app clipboard", () => {
  const home = createController();

  home.selectTable("orders", {});
  home.selectTable("hero", { ctrlKey: true });
  const payload = home.copySelection();

  assert.deepEqual(payload, {
    type: "dbscout.tableObjects",
    connectionId: "demo",
    database: "game_db",
    tables: ["orders", "hero"],
  });
  assert.deepEqual(home.clipboard.value, payload);
});

test("database home disables write actions for read-only connections", () => {
  const clipboard = ref({
    type: "dbscout.tableObjects",
    connectionId: "demo",
    database: "game_db",
    tables: ["player"],
  });
  const home = createController({ readOnly: true, clipboard });
  home.selectTable("orders", {});

  assert.equal(home.canWrite.value, false);
  assert.equal(home.canCopy.value, false);
  assert.equal(home.canPaste.value, false);
  assert.equal(home.canRename.value, false);
  assert.equal(home.canDelete.value, false);
  assert.equal(home.copySelection(), null);
});
