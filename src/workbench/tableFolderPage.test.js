import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWorkspaceState, openTableFoldersTab, setTableFolderScope } from "./workspaceState.js";
import { buildWorkspaceSnapshot, parseWorkspaceSnapshot } from "./utils/workspacePersistence.js";
import { computed, ref } from "vue";
import { filterTablesByKeywords, matchTableKeywords, parseSearchKeywords } from "./utils/tableKeywordSearch.js";
import { highlightSearchRanges } from "./utils/searchMatch.js";
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

test("all tables is the default and folder views only contain their own references", () => {
  const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  assert.doesNotMatch(source, /wb-folder-picker|folders\.value\[0\]/);
  assert.match(source, /v-if="!currentFolder"\s+class="wb-folder-check"/);
  const expression = source.match(/const folderRows = computed\(\(\) => ([\s\S]*?)\n\}\)\)\);/)[1] + "\n}))";
  const currentFolder = ref({ tableNames: ["hero", "removed"] });
  const tableByName = ref(new Map([["hero", {}], ["goods", {}]]));
  const tablesLoaded = ref(true);
  const evaluate = new Function("currentFolder", "tableByName", "tablesLoaded", `return ${expression}`);
  const rows = () => evaluate(currentFolder, tableByName, tablesLoaded);
  assert.deepEqual(rows().map((row) => row.name), ["hero", "removed"]);
  assert.equal(rows()[1].missing, true);
  currentFolder.value = { tableNames: [] };
  assert.deepEqual(rows(), []);
  const visible = source.match(/const visibleRows = computed\(\(\) => (.*)\);/)[1];
  const selectRows = new Function("currentFolder", "folderRows", "pickRows", `return ${visible}`);
  assert.deepEqual(selectRows(ref(null), ref([]), ref([{ name: "goods" }])), [{ name: "goods" }]);
  assert.deepEqual(selectRows(currentFolder, ref([]), ref([{ name: "goods" }])), []);
});

test("adding submits only to the chosen folder in the current database", () => {
  const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  const body = source.match(/function submitPicks\(folderId\) \{([\s\S]*?)\n\}/)[1];
  const folders = ref([{ id: "first", tableNames: ["hero"] }, { id: "second", tableNames: [] }]);
  const currentFolder = ref(null);
  const scope = ref({ connectionId: "demo", database: "game" });
  const tables = ref([{ name: "hero" }, { name: "goods" }]);
  const pickSelection = ref(["goods", "stale"]);
  const pickSet = computed(() => new Set(pickSelection.value));
  const calls = [];
  const store = { addTables: (...args) => calls.push(args) };
  const returned = [];
  const submit = new Function("folderId", "folders", "currentFolder", "pickSelection", "tables", "pickSet", "store", "scope", "reportAdded", "selectFolder", body);
  submit("second", folders, currentFolder, pickSelection, tables, pickSet, store, scope, () => {}, (folder) => returned.push(folder.id));
  assert.deepEqual(calls, [["second", ["goods"], scope.value]]);
  assert.deepEqual(returned, ["second"]);
  submit("other-database-folder", folders, currentFolder, pickSelection, tables, pickSet, store, scope, () => {}, () => {});
  currentFolder.value = folders.value[0];
  submit("first", folders, currentFolder, pickSelection, tables, pickSet, store, scope, () => {}, () => {});
  assert.equal(calls.length, 1);
  assert.match(source, /function startAdding\(\) \{[\s\S]*?selectFolder\(null\);\s*addingFolderId\.value = folder\.id;/);
});

test("default all-tables view supports choosing tables before a destination exists", () => {
  const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  const body = source.match(/function togglePick\(row\) \{([\s\S]*?)\n\}/)[1];
  const currentFolder = ref(null);
  const picks = ref([]);
  const pickSet = computed(() => new Set(picks.value));
  const toggle = new Function("row", "currentFolder", "pickSelection", "pickSet", body);
  toggle({ name: "hero", present: true }, currentFolder, picks, pickSet);
  assert.deepEqual(picks.value, ["hero"]);
  toggle({ name: "hero" }, currentFolder, picks, pickSet);
  assert.deepEqual(picks.value, []);
  currentFolder.value = { id: "folder" };
  toggle({ name: "hero" }, currentFolder, picks, pickSet);
  assert.deepEqual(picks.value, []);
});

test("new folder button spans the sidebar row and centers its icon", () => {
  const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  const css = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");
  const rule = css.match(/\.wb-folder-add\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /place-items:\s*center/);
  assert.match(rule, /align-self:\s*stretch/);
  assert.match(rule, /flex:\s*0 0 auto/);
  assert.match(rule, /margin:\s*4px 8px 0/);
  assert.doesNotMatch(rule, /(?:^|;)\s*width:/);
  assert.match(source, /<button[^>]*class="wb-folder-add"[^>]*@click="createFolder"/);
});

test("inline table search uses home keyword matching and ranking without losing membership", () => {
  const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  assert.match(source, /import \{[^}]*filterTablesByKeywords[^}]*\} from "\.\.\/utils\/tableKeywordSearch\.js"/);
  assert.match(source, /class="wb-folder-table" v-html="row.nameHtml"/);
  assert.match(source, /class="wb-folder-comment" v-html="row.commentHtml"/);
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
  const evaluate = new Function("tables", "addingFolder", "pickQuery", "filterTablesByKeywords", "matchTableKeywords", "parseSearchKeywords", "highlightSearchRanges", expression[1]);
  const rows = computed(() => evaluate(tables, currentFolder, pickQuery, filterTablesByKeywords, matchTableKeywords, parseSearchKeywords, highlightSearchRanges));

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
  assert.equal(rows.value.find((row) => row.name === "hero_prop").nameHtml, "<mark>hero</mark>_prop");
  assert.equal(rows.value.find((row) => row.name === "hero_prop").commentHtml, "<mark>配置</mark>");

  tables.value = [{ name: "Hero_<tag>", comment: '配置 <img src="x"> & 文本' }];
  pickQuery.value = "HERO　配置 hero";
  assert.equal(rows.value[0].nameHtml, "<mark>Hero</mark>_&lt;tag&gt;");
  assert.equal(rows.value[0].commentHtml, '<mark>配置</mark> &lt;img src=&quot;x&quot;&gt; &amp; 文本');
  pickQuery.value = "  ";
  assert.equal(rows.value[0].nameHtml, "Hero_&lt;tag&gt;");
  assert.ok(!rows.value[0].commentHtml.includes("<mark>"));
});

test("the folder page switches databases without creating indistinguishable tabs", () => {
  const state = createWorkspaceState();
  const first = openTableFoldersTab(state, { connectionId: "demo", database: "game" });
  assert.equal(first.kind, "folders");
  assert.equal(state.activeTabId, first.id);
  const other = openTableFoldersTab(state, { connectionId: "demo", database: "other" });
  assert.equal(other.id, first.id);
  assert.equal(other.database, "other");
  const again = openTableFoldersTab(state, { connectionId: "demo", database: "game", folderId: "fld-1" });
  assert.equal(again.id, first.id);
  assert.equal(again.folderId, "fld-1");
  assert.equal(openTableFoldersTab(state, { connectionId: "demo", database: "game" }).folderId, "");
  assert.equal(state.activeTabId, first.id);
  assert.equal(state.tabs.filter((tab) => tab.kind === "folders").length, 1);
  assert.equal(openTableFoldersTab(state, { connectionId: "demo", database: "" }), null);
});

test("switching databases remembers each scope's folder, including same-named databases", () => {
  const state = createWorkspaceState();
  const tab = openTableFoldersTab(state, { connectionId: "first", database: "game", folderId: "items" });
  setTableFolderScope(tab, { connectionId: "second", database: "game" });
  assert.equal(tab.folderId, "");
  tab.folderId = "heroes";
  setTableFolderScope(tab, { connectionId: "first", database: "game" });
  assert.equal(tab.folderId, "items");
  setTableFolderScope(tab, { connectionId: "second", database: "game" });
  assert.equal(tab.folderId, "heroes");
});

test("folder database switch appears above favorites and its tab has no database subtitle", () => {
  const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  const tabs = readFileSync(new URL("./components/WorkbenchTabs.vue", import.meta.url), "utf8");
  assert.ok(source.indexOf('class="wb-folder-database"') < source.indexOf('class="wb-folder-list"'));
  // No tab carries a database subtitle any more: pills name the page and the
  // title bar names the database.
  assert.doesNotMatch(tabs, /hasTabSubtitle|wb-tab-line-secondary/);
});

test("a slow folder list cannot overwrite a newer database's list or loading state", async () => {
  const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  const body = source.match(/async function loadTables\(\) \{([\s\S]*?)\n\}/)[1];
  const scope = ref({ connectionId: "demo", database: "first" });
  const scopeKey = computed(() => JSON.stringify(scope.value));
  const pending = [];
  const context = { loadTables: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
  const tables = ref([]);
  const loaded = ref(false);
  const loading = ref(false);
  const errors = [];
  const load = new Function("context", "scope", "scopeKey", "tables", "tablesLoaded", "tablesLoading", "notify", `let tableLoadVersion = 0; return async function () {${body}}`)(context, scope, scopeKey, tables, loaded, loading, (...args) => errors.push(args));
  const first = load();
  scope.value = { connectionId: "demo", database: "second" };
  const second = load();
  pending[0].resolve([{ name: "old" }]);
  await first;
  assert.deepEqual(tables.value, []);
  assert.equal(loading.value, true);
  pending[1].resolve([{ name: "new" }]);
  await second;
  assert.deepEqual(tables.value, [{ name: "new" }]);
  assert.equal(loading.value, false);
  assert.equal(loaded.value, true);
  const stale = load();
  scope.value = { connectionId: "demo", database: "first" };
  const latest = load();
  pending[3].resolve([]);
  await latest;
  pending[2].reject(new Error("old request failed"));
  await stale;
  assert.deepEqual(tables.value, []);
  assert.deepEqual(errors, []);
});

test("missing tables are reported only after a successful list, including an empty database", () => {
  const source = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  const expression = source.match(/missing: (.*),/)[1];
  const isMissing = new Function("tablesLoaded", "tableByName", "name", `return ${expression}`);
  assert.equal(isMissing(ref(false), ref(new Map()), "goodsprop"), false);
  assert.equal(isMissing(ref(true), ref(new Map()), "goodsprop"), true);
  assert.equal(isMissing(ref(true), ref(new Map([["goodsprop", {}]])), "goodsprop"), false);
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
