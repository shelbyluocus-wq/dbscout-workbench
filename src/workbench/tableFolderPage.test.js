import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWorkspaceState, openTableFoldersTab } from "./workspaceState.js";
import { buildWorkspaceSnapshot, parseWorkspaceSnapshot } from "./utils/workspacePersistence.js";
import { computed, ref } from "vue";
import { filterTablesByKeywords } from "./utils/tableKeywordSearch.js";
import {
  FOLDER_DRAG_MIME,
  isFolderDropCandidate,
  readFolderDrop,
  TABLE_DRAG_MIME,
  writeFolderDrag,
  writeTableDrag,
} from "./utils/tableDragPayload.js";

function dataTransfer() {
  const data = new Map();
  return {
    effectAllowed: "",
    get types() { return [...data.keys()]; },
    setData(type, value) { data.set(type, String(value)); },
    getData(type) { return data.get(type) || ""; },
  };
}

test("folder picker uses home keyword matching and ranking without losing membership", () => {
  const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  assert.match(source, /import \{ filterTablesByKeywords \} from "\.\.\/utils\/tableKeywordSearch\.js"/);
  const expression = source.match(/const pickRows = computed\(\(\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(expression);
  const tables = ref([
    { name: "misc", comment: "hero 配置" },
    { name: "superhero", comment: "配置" },
    { name: "hero_prop", comment: "配置" },
    { name: "hero", comment: "配置" },
    { name: "hero_log", comment: "日志" },
  ]);
  const currentFolder = ref({ tableNames: ["hero_prop"] });
  const pickQuery = ref("");
  const evaluate = new Function("tables", "currentFolder", "pickQuery", "filterTablesByKeywords", expression[1]);
  const rows = computed(() => evaluate(tables, currentFolder, pickQuery, filterTablesByKeywords));

  for (const query of ["", "  ", "HERO", "hero 配置", "配置　HERO hero", "hero missing"]) {
    pickQuery.value = query;
    const homeTables = tables.value.map(({ name, comment }) => ({ tableName: name, tableComment: comment }));
    assert.deepEqual(rows.value.map((row) => row.name), filterTablesByKeywords(homeTables, query).map((table) => table.tableName), query);
    for (const row of rows.value) assert.equal(row.present, row.name === "hero_prop");
  }

  pickQuery.value = "hero 配置";
  assert.deepEqual(rows.value.map((row) => row.name), ["superhero", "hero_prop", "hero", "misc"]);
  currentFolder.value = { tableNames: ["hero"] };
  assert.deepEqual(rows.value.filter((row) => row.present).map((row) => row.name), ["hero"]);
});

test("each database has one folder page, brought forward when opened again", () => {
  const state = createWorkspaceState();
  const first = openTableFoldersTab(state, { connectionId: "demo", database: "game" });
  assert.equal(first.kind, "folders");
  assert.equal(state.activeTabId, first.id);
  const other = openTableFoldersTab(state, { connectionId: "demo", database: "other" });
  assert.notEqual(other.id, first.id);
  const again = openTableFoldersTab(state, { connectionId: "demo", database: "game", folderId: "fld-1" });
  assert.equal(again.id, first.id);
  assert.equal(again.folderId, "fld-1");
  assert.equal(state.activeTabId, first.id);
  assert.equal(state.tabs.filter((tab) => tab.kind === "folders").length, 2);
  assert.equal(openTableFoldersTab(state, { connectionId: "demo", database: "" }), null);
});

test("the folder page is saved with the workspace, on its folder", () => {
  const state = createWorkspaceState();
  const tab = openTableFoldersTab(state, { connectionId: "demo", database: "game", folderId: "fld-7" });
  const snapshot = parseWorkspaceSnapshot(JSON.parse(JSON.stringify(buildWorkspaceSnapshot({
    connectionId: "demo",
    database: "game",
    tabs: state.tabs,
    activeTabId: tab.id,
    panes: state.panes,
    layout: state.layout,
    focusedPaneId: state.focusedPaneId,
  }))));
  const saved = snapshot.tabs.find((item) => item.id === tab.id);
  assert.equal(saved.kind, "folders");
  assert.equal(saved.folderId, "fld-7");
  assert.equal(saved.database, "game");
});

test("dragged tables and folders carry what a folder needs, and nothing else lands", () => {
  const tables = { dataTransfer: dataTransfer() };
  assert.equal(writeTableDrag(tables, { connectionId: "demo", database: "game", tableNames: ["a", "b", "a", ""] }), true);
  assert.equal(isFolderDropCandidate(tables), true);
  assert.deepEqual(readFolderDrop(tables), { kind: "tables", connectionId: "demo", database: "game", tableNames: ["a", "b"] });
  assert.ok(tables.dataTransfer.types.includes(TABLE_DRAG_MIME));

  const folder = { dataTransfer: dataTransfer() };
  writeFolderDrag(folder, "fld-1");
  assert.ok(folder.dataTransfer.types.includes(FOLDER_DRAG_MIME));
  assert.deepEqual(readFolderDrop(folder), { kind: "folder", folderId: "fld-1" });

  const tabDrag = { dataTransfer: dataTransfer() };
  tabDrag.dataTransfer.setData("application/x-dbscout-tab", "tab-1");
  assert.equal(isFolderDropCandidate(tabDrag), false);
  assert.equal(readFolderDrop(tabDrag), null);
  assert.equal(writeTableDrag({ dataTransfer: dataTransfer() }, { database: "", tableNames: ["a"] }), false);
});
