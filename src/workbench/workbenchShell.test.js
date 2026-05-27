import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

function readAllComponents() {
  const dir = fileURLToPath(new URL("./components", import.meta.url));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".vue"));
  return files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
}

test("main.js mounts the MySQL workbench as the first screen", () => {
  const main = read("../main.js");

  assert.match(main, /import\s+MySqlWorkbench\s+from\s+["']\.\/workbench\/MySqlWorkbench\.vue["']/);
  assert.match(main, /import\s+["']\.\/workbench\/workbench\.css["']/);
  assert.match(main, /createApp\(MySqlWorkbench\)\.mount\("#app"\)/);
});

test("composables and mock modules use the Rust workbench commands", () => {
  const all = [
    read("./composables/useConnection.js"),
    read("./composables/useTableSession.js"),
    read("./composables/useGridEditor.js"),
    read("./composables/useImportWizard.js"),
    read("./composables/useRowSelection.js"),
    read("./mock/mockBackend.js"),
  ].join("\n");

  for (const command of [
    "list_connections",
    "list_databases",
    "list_tables",
    "get_table_schema",
    "open_table_session",
    "fetch_table_page",
    "update_cell",
    "insert_row",
    "delete_rows",
    "search_data",
  ]) {
    assert.match(all, new RegExp(`["']${command}["']`), `missing command: ${command}`);
  }
  assert.match(all, /mockWorkbenchInvoke/);
  assert.match(all, /game_db/);
});

test("workbench components render polished desktop database chrome", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const allComponents = readAllComponents();
  const styles = read("./workbench.css");
  const all = [orchestrator, allComponents].join("\n");

  for (const className of [
    "wb-navigation-pane",
    "wb-object-tabs",
    "wb-table-toolbar",
    "wb-info-pane",
  ]) {
    assert.match(all, new RegExp(`class=["'][^"']*${className}`), `missing class: ${className}`);
  }

  assert.match(all, /备注/);
  assert.match(styles, /--wb-accent/);
  assert.match(styles, /--wb-glass/);
  assert.match(styles, /backdrop-filter/);
  assert.match(styles, /@supports/);
  assert.match(styles, /\.wb-grid\s*\{[\s\S]*font-size:\s*12px/);
  assert.match(styles, /\.wb-table-toolbar/);
  assert.match(styles, /\.wb-row-index/);
});

test("workbench follows Navicat-like table interactions with composables", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const allComponents = readAllComponents();
  const styles = read("./workbench.css");
  const all = [orchestrator, allComponents].join("\n");

  assert.doesNotMatch(all, /wb-tool-button/);
  assert.match(all, /@contextmenu\.prevent/);
  assert.match(all, /class="wb-context-menu"/);
  assert.match(all, /refreshFromContextMenu/);
  assert.match(all, /commitInsertRow/);
  assert.match(all, /commitInsertAndRefresh/);
  assert.match(all, /class="wb-insert-row"/);
  assert.match(all, /wb-connection-node/);
  assert.match(all, /wb-source-tree/);
  assert.match(all, /wb-connection-add/);
  assert.match(styles, /\.wb-context-menu/);
  assert.match(styles, /\.wb-insert-row/);
  assert.match(styles, /\.wb-connection-node/);
  assert.match(styles, /\.wb-detail-editor/);
  assert.match(styles, /\.wb-detail-highlights/);
  assert.doesNotMatch(all, /wb-detail-preview/);
  assert.match(styles, /\.wb-token-keyword/);
});

test("navigation and tabs expose each table database source", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const tabs = read("./components/WorkbenchTabs.vue");
  const grid = read("./components/DataGrid.vue");
  const identity = read("./components/SelectedCellIdentity.vue");
  const styles = read("./workbench.css");

  assert.match(sidebar, /wb-source-tree/);
  assert.match(sidebar, /wb-database-item/);
  assert.match(sidebar, /wb-table-item/);
  assert.match(sidebar, /wb-table-comment/);
  assert.match(sidebar, /activeTab/);
  assert.match(sidebar, /has-comment/);
  assert.doesNotMatch(sidebar, /wb-sidebar-status/);
  assert.match(sidebar, /aria-current/);
  assert.match(orchestrator, /:active-tab="activeTab"/);
  assert.match(orchestrator, /wb-grid-statusbar/);
  assert.match(orchestrator, /wb-sidebar-status/);
  assert.match(orchestrator, /activeTab\.database/);
  assert.match(orchestrator, /activeTab\.tableComment/);
  assert.match(orchestrator, /activeTab\.totalRows/);
  assert.match(orchestrator, /wb-sidebar-status-comment/);
  assert.match(orchestrator, /import\s+SelectedCellIdentity/);
  assert.match(orchestrator, /<SelectedCellIdentity/);
  assert.match(orchestrator, /:selected-cell="selectedCell"/);
  assert.match(orchestrator, /:selected-range="selectedRange"/);
  assert.match(identity, /buildSelectedCellIdentity/);
  assert.match(identity, /wb-cell-identity/);
  assert.match(identity, /:title="identity\.title"/);
  assert.match(tabs, /tab\.database/);
  assert.doesNotMatch(grid, /wb-object-heading|tabDisplayName/);
  assert.match(styles, /\.wb-source-tree/);
  assert.match(styles, /\.wb-table-copy\.has-comment\s+\.wb-table-name/);
  assert.match(styles, /\.wb-table-comment/);
  assert.match(styles, /\.wb-grid-statusbar/);
  assert.match(styles, /\.wb-sidebar-status/);
  assert.match(styles, /\.wb-sidebar-status-comment/);
  assert.match(styles, /\.wb-cell-identity/);
  assert.match(styles, /\.wb-cell-identity-key/);
  const identityRule = styles.match(/\.wb-cell-identity\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(identityRule, /overflow:\s*hidden/);
  assert.match(styles, /\.wb-cell-identity-key\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.doesNotMatch(styles, /\.wb-sidebar-status\s*\{[^}]*transition:/);
});

test("sidebar uses a compact connection database table tree without an internal split pane", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const styles = read("./workbench.css");

  assert.match(sidebar, /sidebarTreeState/);
  assert.match(sidebar, /toggleConnectionExpansion/);
  assert.match(sidebar, /toggleDatabaseExpansion/);
  assert.match(sidebar, /isConnectionExpanded/);
  assert.match(sidebar, /isDatabaseExpanded/);
  assert.match(sidebar, /:aria-expanded="isConnectionExpanded/);
  assert.match(sidebar, /:aria-expanded="isDatabaseExpanded/);
  assert.match(sidebar, /class="wb-source-tree"/);
  assert.match(sidebar, /class="wb-database-branch"/);
  assert.match(sidebar, /class="wb-table-branch"/);
  assert.match(sidebar, /placeholder="搜索表"/);
  assert.doesNotMatch(sidebar, /browserColumnsRef|navTreeStyle|startBrowserResize|wb-browser-split-divider|wb-table-column/);
  assert.doesNotMatch(styles, /\.wb-browser-split-divider|\.wb-table-column/);
});

test("workbench suppresses native context menus and exposes only refresh", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const grid = read("./components/DataGrid.vue");
  const inspector = read("./components/InspectorPanel.vue");
  const menu = read("./components/ContextMenu.vue");

  assert.match(orchestrator, /@contextmenu\.prevent="openGeneralContextMenu"/);
  assert.match(orchestrator, /function\s+openGeneralContextMenu/);
  assert.match(orchestrator, /function\s+openActiveTableContextMenu/);
  assert.match(orchestrator, /@contextmenu="openActiveTableContextMenu"/);
  assert.doesNotMatch(orchestrator, /@set-null|setCellToNull/);
  assert.match(sidebar, /@contextmenu\.prevent\.stop="emit\('contextmenu', \$event\)"/);
  assert.doesNotMatch(sidebar, /@contextmenu\.stop(?:\s|=)/);
  assert.match(grid, /@contextmenu\.prevent\.stop="emit\('contextmenu', \$event\)"/);
  assert.match(inspector, /@contextmenu\.prevent\.stop="emit\(["']contextmenu["'], \$event\)"/);
  assert.match(menu, />刷新</);
  assert.doesNotMatch(menu, /设为 NULL|set-null/);
});

test("data grid exposes its real scroll wrapper to editor and virtual grid", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue");

  assert.match(dataGrid, /grid-ready/);
  assert.match(dataGrid, /emit\(["']grid-ready["'],\s*gridWrapRef\.value\)/);
  assert.match(orchestrator, /function\s+setGridWrapElement/);
  assert.match(orchestrator, /@grid-ready="setGridWrapElement"/);
});

test("scrollable panes keep thin native interactive scrollbars", () => {
  const allComponents = readAllComponents();
  const orchestrator = read("./MySqlWorkbench.vue");
  const styles = read("./workbench.css");

  assert.doesNotMatch(allComponents, /wb-grid-scroll-indicator/);
  assert.match(styles, /--wb-scrollbar-size:\s*6px/);
  assert.match(styles, /\.mysql-workbench \*\s*\{[\s\S]*scrollbar-width:\s*thin/);
  assert.match(styles, /\.mysql-workbench \*::\-webkit-scrollbar/);
  assert.doesNotMatch(styles, /\.wb-scrollbar-indicator|\.wb-hide-scrollbar/);
  assert.doesNotMatch(orchestrator, /usePersistentScrollbars/);
  assert.doesNotMatch(styles, /\.wb-grid-wrap\s*\{[\s\S]*scrollbar-width:\s*none/);
  assert.doesNotMatch(styles, /\.wb-grid-wrap::-webkit-scrollbar\s*\{[\s\S]*display:\s*none/);
});

test("virtual grid scroll observers clean up lifecycles", () => {
  const virtual = read("./composables/useVirtualGrid.js");

  assert.match(virtual, /onBeforeUnmount/);
  assert.match(virtual, /resizeObserver\.disconnect\(\)/);
});

test("grid edit mode keeps text metrics stable with a thin single focus ring", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-grid td input\s*\{[^}]*height:\s*100%/);
  assert.match(styles, /\.wb-grid td input\s*\{[^}]*font:\s*inherit/);
  assert.match(styles, /\.wb-grid td input\s*\{[^}]*line-height:\s*25px/);
  assert.match(styles, /\.wb-grid td input:focus\s*\{[^}]*outline:\s*none/);
  assert.match(styles, /\.wb-grid td\.editing\s*\{[^}]*outline:\s*1px solid var\(--wb-accent\)/);
  assert.match(styles, /\.wb-grid-wrap:not\(:focus\) \.wb-grid td\.editing\s*\{[^}]*outline:\s*1px solid var\(--wb-accent\)/);
  assert.doesNotMatch(styles, /\.wb-grid td\.selected input\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--wb-accent\)/);
  assert.doesNotMatch(styles, /\.wb-grid td input:focus\s*\{[^}]*outline:\s*2px solid var\(--wb-accent\)/);
});

test("data grid uses row headers and insert-row keyboard wiring", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue");
  const styles = read("./workbench.css");

  assert.doesNotMatch(dataGrid, /type="checkbox"/);
  assert.doesNotMatch(dataGrid, /wb-select-all/);
  assert.match(dataGrid, /wb-row-index-corner/);
  assert.match(dataGrid, /wb-row-header/);
  assert.match(dataGrid, /originalIndex \+ 1/);
  assert.match(dataGrid, /row-selected/);
  assert.match(dataGrid, /insert-keydown/);
  assert.match(dataGrid, /selectedInsertCell/);
  assert.doesNotMatch(dataGrid, /wb-batch-bar/);
  assert.match(orchestrator, /function\s+selectGridRow/);
  assert.match(orchestrator, /clearSelection\(\)/);
  assert.match(orchestrator, /handleGridKeydownWithRows/);
  assert.match(orchestrator, /deleteSelectedRows\(tab\)/);
  assert.match(orchestrator, /@insert-keydown="handleInsertKeydown"/);
  assert.match(orchestrator, /@insert-commit="commitInsertAndRefresh"/);
  assert.match(styles, /\.wb-grid-row\.row-selected/);
  assert.match(styles, /\.wb-row-header/);
  assert.match(styles, /\.wb-insert-row td\.insert-selected/);
});

test("data grid wires Excel-like drag range selection", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue");
  const styles = read("./workbench.css");

  assert.match(dataGrid, /cell-mousedown/);
  assert.match(dataGrid, /@mousedown\.left/);
  assert.match(dataGrid, /cell-enter/);
  assert.match(dataGrid, /@mouseenter/);
  assert.match(dataGrid, /range-pointer/);
  assert.match(dataGrid, /window\.addEventListener\(['"]mousemove['"],\s*continueRangeSelection\)/);
  assert.match(dataGrid, /range-end/);
  assert.doesNotMatch(dataGrid, /@mouseleave="emit\('range-end'\)"/);
  assert.match(dataGrid, /@keydown\.enter\.prevent\.stop/);
  assert.match(dataGrid, /@keydown\.tab\.prevent\.stop/);
  assert.match(orchestrator, /@cell-mousedown="startGridRangeSelection"/);
  assert.match(orchestrator, /function\s+startGridRangeSelection/);
  assert.match(orchestrator, /startRangeSelection\(\.\.\.args\)/);
  assert.match(orchestrator, /@cell-enter="extendRangeSelection"/);
  assert.match(orchestrator, /@range-pointer="extendRangeSelectionFromPointer"/);
  assert.match(orchestrator, /@range-end="finishRangeSelection"/);
  assert.match(styles, /\.wb-grid td\.selected:not\(\.range-selected\)/);
  assert.match(styles, /\.wb-grid td\.range-selected/);
  assert.match(styles, /\.wb-grid td\.range-top/);
  assert.match(styles, /\.wb-grid td\.range-bottom/);
  assert.match(styles, /\.wb-grid td\.range-left/);
  assert.match(styles, /\.wb-grid td\.range-right/);
  const rangeSelectedRule = styles.match(/\.wb-grid td\.range-selected\s*\{([^}]*)\}/s)?.[1] || "";
  assert.doesNotMatch(rangeSelectedRule, /border-color/);
  assert.match(rangeSelectedRule, /position:\s*relative/);
  assert.doesNotMatch(rangeSelectedRule, /box-shadow/);
  assert.match(styles, /\.wb-grid td\.selected \.wb-cell-text\s*\{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.wb-grid td\.range-anchor \.wb-cell-text\s*\{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.wb-grid td\.range-top::before\s*\{[^}]*right:\s*-1px/s);
  assert.match(styles, /\.wb-grid td\.range-bottom::before\s*\{[^}]*right:\s*-1px/s);
  assert.match(styles, /\.wb-grid td\.range-left::after\s*\{[^}]*bottom:\s*-1px/s);
  assert.match(styles, /\.wb-grid td\.range-right::after\s*\{[^}]*bottom:\s*-1px/s);
  assert.match(styles, /\.wb-grid td\.range-top\.range-bottom::before/);
  assert.match(styles, /\.wb-grid td\.range-left\.range-right::after/);
});

test("tauri main window is configured as a normal database workbench window", () => {
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  const main = config.app.windows.find((window) => window.label === "main");

  assert.ok(main.width >= 1200);
  assert.ok(main.height >= 760);
  assert.equal(main.decorations, true);
  assert.equal(main.resizable, true);
  assert.equal(main.alwaysOnTop, false);
  assert.equal(main.skipTaskbar, false);
  assert.equal(main.transparent, false);
  assert.equal(main.center, true);
  assert.ok(main.minWidth >= 1120);
  assert.ok(main.minHeight >= 720);
});
