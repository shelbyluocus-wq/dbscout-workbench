import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import {
  createDatabaseHomeController,
  databaseHomeRenameError,
  HOME_SORT_MODES,
} from "./composables/useDatabaseHome.js";

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

test("database home search only includes contiguous table-name matches", () => {
  const home = createController({
    tables: [
      { table_name: "heroprop", table_comment: "exact match" },
      { table_name: "prefix_heroprop_archive", table_comment: "contained match" },
      { table_name: "headprop", table_comment: "typo-similar match" },
      { table_name: "herogemprop", table_comment: "scattered match" },
      { table_name: "unrelated", table_comment: "no match" },
    ],
  });

  home.setQuery("heroprop");
  assert.deepEqual(names(home.filteredTables.value), ["heroprop", "prefix_heroprop_archive"]);
});

test("database home search keeps the active sort order for tables sharing the typed prefix", () => {
  const home = createController({
    tables: [
      { table_name: "act_10", table_comment: "" },
      { table_name: "act_2", table_comment: "" },
      { table_name: "Act_b", table_comment: "" },
      { table_name: "act_a", table_comment: "" },
      { table_name: "zz_act", table_comment: "" },
    ],
    favoriteTableNames: ["act_a"],
  });

  const defaultOrder = names(home.filteredTables.value);
  assert.deepEqual(defaultOrder, ["act_a", "act_2", "act_10", "Act_b", "zz_act"]);

  home.setQuery("act");
  assert.deepEqual(names(home.filteredTables.value), defaultOrder);

  home.setSortMode(HOME_SORT_MODES.nameDesc);
  const descOrder = names(home.filteredTables.value);
  assert.deepEqual(descOrder, ["act_a", "Act_b", "act_10", "act_2", "zz_act"]);
  home.setQuery("");
  assert.deepEqual(names(home.filteredTables.value), ["act_a", "zz_act", "Act_b", "act_10", "act_2"]);
});

test("database home search still lists an exact table-name match first", () => {
  const home = createController({
    tables: [
      { table_name: "account_user", table_comment: "" },
      { table_name: "user_profile", table_comment: "" },
      { table_name: "user", table_comment: "" },
    ],
  });

  home.setQuery("user");
  assert.deepEqual(names(home.filteredTables.value), ["user", "user_profile", "account_user"]);
});

test("database home search matches several keywords and ranks word starts within the active sort", () => {
  const home = createController({
    tables: [
      { table_name: "superuser_prop", table_comment: "" },
      { table_name: "prop_user", table_comment: "" },
      { table_name: "user_prop", table_comment: "" },
      { table_name: "user_skill", table_comment: "道具" },
      { table_name: "user_hero", table_comment: "" },
    ],
  });

  home.setQuery("user prop");
  assert.deepEqual(names(home.filteredTables.value), ["prop_user", "user_prop", "superuser_prop"]);

  home.setQuery("user 道具");
  assert.deepEqual(names(home.filteredTables.value), ["user_skill"]);

  home.setSortMode(HOME_SORT_MODES.nameDesc);
  home.setQuery("user");
  assert.deepEqual(names(home.filteredTables.value), ["user_skill", "user_prop", "user_hero", "prop_user", "superuser_prop"]);
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

test("database home mutation refresh preserves the active search and sort for pasted tables", () => {
  const tableRef = ref([
    { table_name: "B表", table_comment: "" },
    { table_name: "A表", table_comment: "" },
  ]);
  const home = createController({ tables: tableRef });
  home.setQuery("A");
  home.setSortMode(HOME_SORT_MODES.original);
  home.selectTable("B表", {});
  home.startRename();
  const staleAttempt = home.beginRenameSubmit();

  tableRef.value = [
    { table_name: "B表", table_comment: "" },
    { table_name: "A表", table_comment: "" },
    { table_name: "A表_copy1", table_comment: "" },
  ];
  home.resetForMutationRefresh();
  home.setSelection(["A表_copy1"]);

  assert.equal(home.query.value, "A");
  assert.equal(home.sortMode.value, HOME_SORT_MODES.original);
  assert.deepEqual(names(home.filteredTables.value), ["A表", "A表_copy1"]);
  assert.deepEqual(home.selectedNames.value, ["A表_copy1"]);
  assert.equal(home.focusedName.value, "A表_copy1");
  assert.equal(home.renamingName.value, "");
  assert.equal(home.failRename("迟到的失败", staleAttempt), false);
});

test("database home keeps field counts truthful while schemas load", () => {
  const home = createController({
    tables: [
      { table_name: "known_from_list", table_comment: "", column_count: 7, columns: [] },
      { table_name: "known_camel", table_comment: "", columnCount: 3, columns: [] },
      { table_name: "loading_placeholder", table_comment: "", columns: [], schemaLoaded: false },
      { table_name: "real_empty_table", table_comment: "", columns: [], schemaLoaded: true },
      { table_name: "loaded_schema", table_comment: "", columns: [{ column_name: "id" }, { column_name: "name" }] },
    ],
  });

  const counts = new Map(home.tables.value.map((table) => [table.tableName, table.columnCount]));

  assert.equal(counts.get("known_from_list"), 7);
  assert.equal(counts.get("known_camel"), 3);
  assert.equal(counts.get("loading_placeholder"), null);
  assert.equal(counts.get("real_empty_table"), 0);
  assert.equal(counts.get("loaded_schema"), 2);
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

test("database home supports table-header sort toggles", () => {
  const home = createController();

  assert.equal(home.sortState.value.column, "name");
  assert.equal(home.sortState.value.direction, "asc");

  home.sortByColumn("name");
  assert.equal(home.sortMode.value, HOME_SORT_MODES.nameDesc);
  assert.equal(home.sortState.value.column, "name");
  assert.equal(home.sortState.value.direction, "desc");

  home.sortByColumn("name");
  assert.equal(home.sortMode.value, HOME_SORT_MODES.nameAsc);
  assert.equal(home.sortState.value.column, "name");
  assert.equal(home.sortState.value.direction, "asc");

  home.sortByColumn("comment");
  assert.equal(home.sortMode.value, HOME_SORT_MODES.commentFirst);
  assert.equal(home.sortState.value.column, "comment");
  assert.equal(home.sortState.value.direction, "asc");

  home.sortByColumn("fields");
  assert.equal(home.sortMode.value, HOME_SORT_MODES.fieldsDesc);
  assert.deepEqual(names(home.filteredTables.value), ["player", "hero", "orders", "audit_log"]);

  home.sortByColumn("fields");
  assert.equal(home.sortMode.value, HOME_SORT_MODES.fieldsAsc);
  assert.deepEqual(names(home.filteredTables.value), ["audit_log", "hero", "orders", "player"]);
});

test("database home keeps favorites first while preserving the active sort within each group", () => {
  const favorites = ref(["orders"]);
  const home = createController({ favoriteTableNames: favorites });

  assert.deepEqual(names(home.filteredTables.value), ["orders", "audit_log", "hero", "player"]);

  home.setSortMode(HOME_SORT_MODES.nameDesc);
  assert.deepEqual(names(home.filteredTables.value), ["orders", "player", "hero", "audit_log"]);

  favorites.value = ["orders", "hero"];
  assert.deepEqual(names(home.filteredTables.value), ["orders", "hero", "player", "audit_log"]);

  home.setSortMode(HOME_SORT_MODES.fieldsDesc);
  assert.deepEqual(names(home.filteredTables.value), ["hero", "orders", "player", "audit_log"]);
});

test("database home sorts size and modified metadata with unknown values last", () => {
  const home = createController({
    tables: [
      { table_name: "unknown", data_size_bytes: null, modified_at: null },
      { table_name: "small", data_size_bytes: 1024, modified_at: "2026-07-01 10:00:00" },
      { table_name: "large", data_size_bytes: 4096, modified_at: "2026-07-03 10:00:00" },
    ],
  });

  home.sortByColumn("size");
  assert.deepEqual(names(home.filteredTables.value), ["large", "small", "unknown"]);
  home.sortByColumn("size");
  assert.deepEqual(names(home.filteredTables.value), ["small", "large", "unknown"]);

  home.sortByColumn("modified");
  assert.deepEqual(names(home.filteredTables.value), ["large", "small", "unknown"]);
  home.sortByColumn("modified");
  assert.deepEqual(names(home.filteredTables.value), ["small", "large", "unknown"]);
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

test("database home Ctrl+Shift click adds a range to the existing selection", () => {
  const home = createController();

  home.selectTable("audit_log", {});
  home.selectTable("orders", { ctrlKey: true });
  home.selectTable("player", { ctrlKey: true, shiftKey: true });
  assert.deepEqual(home.selectedNames.value, ["audit_log", "orders", "player"]);
  assert.equal(home.anchorName.value, "orders");
});

test("database home keyboard paging and Home/End move within the filtered order", () => {
  const home = createController();

  assert.equal(home.moveSelection(Infinity), "player");
  assert.deepEqual(home.selectedNames.value, ["player"]);
  assert.equal(home.moveSelection(-Infinity, { shiftKey: true }), "audit_log");
  assert.deepEqual(home.selectedNames.value, ["audit_log", "hero", "orders", "player"]);
  assert.equal(home.moveSelection(2), "orders");
  assert.deepEqual(home.selectedNames.value, ["orders"]);
  assert.equal(home.moveSelection(-10), "audit_log");
});

test("database home Ctrl+A selection covers every filtered table beyond the virtual window", () => {
  const manyTables = Array.from({ length: 160 }, (_, index) => ({
    table_name: index % 2 === 0 ? `vip_${index}` : `regular_${index}`,
    table_comment: "",
  }));
  const home = createController({ tables: manyTables });

  home.setQuery("vip");
  home.selectAllFiltered();

  assert.equal(home.selectedNames.value.length, 80);
  assert.ok(home.selectedNames.value.every((name) => name.startsWith("vip_")));
});

test("database home arrow navigation selects and extends within filtered order", () => {
  const home = createController();

  assert.equal(home.moveSelection(1), "audit_log");
  assert.deepEqual(home.selectedNames.value, ["audit_log"]);
  assert.equal(home.moveSelection(1), "hero");
  assert.deepEqual(home.selectedNames.value, ["hero"]);

  assert.equal(home.moveSelection(1, { shiftKey: true }), "orders");
  assert.deepEqual(home.selectedNames.value, ["hero", "orders"]);
  assert.equal(home.moveSelection(-1, { shiftKey: true }), "hero");
  assert.deepEqual(home.selectedNames.value, ["hero"]);

  home.clearSelection();
  home.focusedName.value = "";
  assert.equal(home.moveSelection(-1), "player");
  assert.deepEqual(home.selectedNames.value, ["player"]);

  home.setQuery("order");
  assert.equal(home.moveSelection(1), "orders");
  assert.deepEqual(home.selectedNames.value, ["orders"]);
});

test("database home replaces selection from a drag box result", () => {
  const home = createController();

  home.selectTable("orders", {});
  home.setSelection(["hero", "", "missing", "player", "hero"]);

  assert.deepEqual(home.selectedNames.value, ["hero", "player"]);
  assert.equal(home.anchorName.value, "hero");

  home.setSelection([]);
  assert.deepEqual(home.selectedNames.value, []);
  assert.equal(home.anchorName.value, "");
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

test("database home keeps duplicate rename feedback actionable", () => {
  const home = createController();
  home.selectTable("orders", {});
  home.startRename();

  const message = databaseHomeRenameError("duplicate", "player");
  home.failRename(message);
  assert.equal(home.renameError.value, "表名“player”已存在，请换一个名称");
  assert.equal(home.renamePending.value, false);
  assert.equal(home.renamingName.value, "orders");
  assert.equal(home.renameDraft.value, "orders");

  home.updateRenameDraft("player_archive");
  assert.equal(home.renameError.value, "");
  assert.equal(home.renameDraft.value, "player_archive");

  const attempt = home.beginRenameSubmit();
  assert.equal(home.renamePending.value, true);
  assert.equal(home.completeRename(attempt), true);
  assert.equal(home.renamingName.value, "");
  assert.equal(databaseHomeRenameError("request", "player", new Error("Table already exists")), message);
});

test("database home refresh reset matches a newly opened homepage", () => {
  const home = createController();
  home.setQuery("play");
  home.setSortMode(HOME_SORT_MODES.fieldsDesc);
  home.selectTable("orders", {});
  home.startRename();
  home.updateRenameDraft("player");
  const staleAttempt = home.beginRenameSubmit();

  home.resetForRefresh();

  assert.equal(home.query.value, "");
  assert.equal(home.sortMode.value, HOME_SORT_MODES.nameAsc);
  assert.deepEqual(home.selectedNames.value, []);
  assert.equal(home.anchorName.value, "");
  assert.equal(home.renamingName.value, "");
  assert.equal(home.renameDraft.value, "");
  assert.equal(home.renameError.value, "");
  assert.equal(home.renamePending.value, false);
  assert.equal(home.failRename("迟到的失败", staleAttempt), false);
  assert.equal(home.renameError.value, "");
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

test("database home can keep document editing while blocking table copy and rename", () => {
  const clipboard = ref({
    type: "dbscout.tableObjects",
    connectionId: "demo-mongo",
    database: "game_db",
    tables: ["players"],
  });
  const home = createController({
    readOnly: false,
    allowRenameDrop: false,
    allowTableCopy: false,
    clipboard,
  });
  home.selectTable("orders", {});

  assert.equal(home.canWrite.value, true);
  assert.equal(home.canCopy.value, false);
  assert.equal(home.canPaste.value, false);
  assert.equal(home.canRename.value, false);
  assert.equal(home.canDelete.value, false);
});
