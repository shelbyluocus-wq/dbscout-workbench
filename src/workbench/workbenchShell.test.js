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
  assert.match(styles, /\.wb-table-copy\s*\{/);
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

test("sidebar table rows preserve table-name width before showing optional comments", () => {
  const styles = read("./workbench.css");
  const copyRule = styles.match(/\.wb-table-copy\s*\{([^}]*)\}/s)?.[1] || "";
  const commentRule = styles.match(/\.wb-table-comment\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(copyRule, /display:\s*block/);
  assert.match(copyRule, /overflow:\s*hidden/);
  assert.match(copyRule, /text-overflow:\s*ellipsis/);
  assert.match(copyRule, /white-space:\s*nowrap/);
  assert.match(commentRule, /margin-left:\s*7px/);
  assert.doesNotMatch(styles, /\.wb-table-copy\.has-comment\s+\.wb-table-name\s*\{[^}]*max-width:/s);
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

test("sidebar search supports keyboard selection and enter open", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const styles = read("./workbench.css");

  assert.match(sidebar, /selectedSearchIndex/);
  assert.match(sidebar, /function\s+handleTableSearchKeydown/);
  assert.match(sidebar, /ArrowDown/);
  assert.match(sidebar, /ArrowUp/);
  assert.match(sidebar, /Enter/);
  assert.match(sidebar, /@keydown="handleTableSearchKeydown"/);
  assert.match(sidebar, /keyboard-selected/);
  assert.match(sidebar, /aria-selected/);
  assert.match(styles, /\.wb-table-item\.keyboard-selected/);
});

test("workbench suppresses native context menus and keeps refresh menu scoped to table areas", () => {
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
  assert.doesNotMatch(menu, /全部关闭|设为 NULL|set-null/);
});

test("table tab bar context menu can close all open tabs", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const tabs = read("./components/WorkbenchTabs.vue");

  assert.match(tabs, /tab-contextmenu/);
  assert.match(tabs, /@contextmenu\.prevent\.stop="openTabContextMenu/);
  assert.match(orchestrator, /closeAllTableTabs/);
  assert.match(orchestrator, /function\s+closeAllTabsFromMenu/);
  assert.match(orchestrator, /@tab-contextmenu="openTabContextMenu"/);
  assert.match(orchestrator, />全部关闭</);
});

test("data grid exposes its real scroll wrapper to editor and virtual grid", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue");

  assert.match(dataGrid, /grid-ready/);
  assert.match(dataGrid, /emit\(["']grid-ready["'],\s*gridWrapRef\.value\)/);
  assert.match(orchestrator, /function\s+setGridWrapElement/);
  assert.match(orchestrator, /@grid-ready="setGridWrapElement"/);
});

test("table search uses Ctrl+F and input scanning instead of backend filtering", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue");

  assert.match(orchestrator, /import\s+\{\s*useTableSearch\s*\}\s+from\s+["']\.\/composables\/useTableSearch\.js["']/);
  assert.match(orchestrator, /handleTableFindKeydown\(event\)/);
  assert.match(orchestrator, /@keydown="handleWorkbenchKeydown"/);
  assert.match(orchestrator, /@search-input="runTableSearch"/);
  assert.match(orchestrator, /@search-ready="setSearchInputElement"/);
  assert.match(orchestrator, /loadNextPage\(tab\)/);
  assert.match(orchestrator, /maybeLoadMoreRows\(event\)/);
  assert.doesNotMatch(dataGrid, /@keydown\.enter\.prevent="emit\('filter-page'/);
  assert.match(dataGrid, /search-ready/);
  assert.match(dataGrid, /search-input/);
});

test("table search cell selection resolves columns from the searched tab", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const selectCellAtBody = orchestrator.match(/function\s+selectCellAt\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(selectCellAtBody, /tab\?\.columns\?\.\[columnIndex\]/);
  assert.doesNotMatch(selectCellAtBody, /activeColumns\.value\[columnIndex\]/);
});

test("cell highlighting reads the in-table search query without requiring backend filtering", () => {
  const display = read("./utils/cellDisplay.js");

  assert.match(display, /const query = \(tab\?\.searchQuery \?\? tab\?\.filter \?\? ""\)\.trim\(\)/);
  assert.match(display, /tab\.filterMode \|\| "fuzzy"/);
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

test("workbench exposes a persisted theme toggle synchronized with the native window", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const theme = read("./composables/useTheme.js");

  assert.match(orchestrator, /import\s+\{\s*useTheme\s*\}\s+from\s+["']\.\/composables\/useTheme\.js["']/);
  assert.match(orchestrator, /useTheme\(\)/);
  assert.match(orchestrator, /<main[^>]*:data-theme="effectiveTheme"/s);
  assert.match(orchestrator, /class="wb-theme-toggle"/);
  assert.match(orchestrator, /@click\.stop="toggleTheme"/);
  assert.match(orchestrator, /切换为深色模式/);
  assert.match(orchestrator, /切换为浅色模式/);
  assert.match(theme, /getCurrentWindow/);
  assert.match(theme, /\.setTheme\(theme\)/);
});

test("theme palettes style the full workbench and its floating icon control", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.mysql-workbench\[data-theme="light"\]\s*\{[\s\S]*color-scheme:\s*light/);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*color-scheme:\s*dark/);
  for (const token of [
    "--wb-control",
    "--wb-pane-header",
    "--wb-tab-surface",
    "--wb-grid-canvas",
    "--wb-detail-surface",
    "--wb-status-surface",
  ]) {
    assert.match(styles, new RegExp(`${token}:`), `missing theme token: ${token}`);
  }
  assert.match(styles, /\.wb-theme-toggle\s*\{/);
  assert.match(styles, /\.wb-theme-toggle:focus-visible\s*\{/);
  assert.match(styles, /\.wb-grid-wrap\s*\{[^}]*background:\s*var\(--wb-grid-canvas\)/s);
  assert.match(styles, /\.wb-grid-statusbar\s*\{[^}]*background:\s*var\(--wb-status-surface\)/s);
});

test("inspector exposes distinct field, type, key, and remark roles", () => {
  const inspector = read("./components/InspectorPanel.vue");

  assert.match(inspector, /function\s+isSelectedColumn/);
  assert.match(inspector, /class="wb-schema-field-name"/);
  assert.match(inspector, /class="wb-schema-type-line"/);
  assert.match(inspector, /class="wb-schema-field-type"/);
  assert.match(inspector, /class="wb-schema-key-badge"/);
  assert.match(inspector, /class="wb-schema-field-comment"/);
  assert.match(inspector, /:class="\{\s*'is-selected':\s*isSelectedColumn\(column\)\s*\}"/);
  assert.match(inspector, /v-if="columnComment\(column\)"/);
});

test("inspector provides an accessible vertical resize handle for the detail editor", () => {
  const inspector = read("./components/InspectorPanel.vue");

  assert.match(inspector, /import\s+\{\s*useInspectorResize\s*\}\s+from\s+"\.\.\/composables\/useInspectorResize\.js"/);
  assert.match(inspector, /ref="inspectorRef"/);
  assert.match(inspector, /class="wb-inspector-divider"/);
  assert.match(inspector, /role="separator"/);
  assert.match(inspector, /aria-orientation="horizontal"/);
  assert.match(inspector, /tabindex="0"/);
  assert.match(inspector, /@mousedown="onDetailDividerMouseDown"/);
  assert.match(inspector, /@dblclick="resetDetailHeight"/);
  assert.match(inspector, /@keydown="onDetailDividerKeydown"/);
  assert.match(inspector, /class="wb-text-panel"\s+:style="detailPanelStyle"/);
});

test("semantic text tokens keep metadata and support content readable in both themes", () => {
  const styles = read("./workbench.css");

  for (const token of [
    "--wb-font-ui",
    "--wb-identifier-text",
    "--wb-type-text",
    "--wb-remark-text",
    "--wb-database-text",
    "--wb-quiet-text",
  ]) {
    assert.match(styles, new RegExp(`${token}:`), `missing semantic text token: ${token}`);
  }

  assert.match(styles, /font-family:\s*var\(--wb-font-ui\)/);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*--wb-type-text:/);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*--wb-remark-text:/);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*--wb-database-text:/);
  assert.match(styles, /\.wb-schema-field-type\s*\{[^}]*color:\s*var\(--wb-type-text\)/s);
  assert.match(styles, /\.wb-schema-field-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)[^}]*font-size:\s*12px[^}]*line-height:\s*1\.55/s);
  assert.match(styles, /\.wb-schema-key-badge\s*\{[^}]*color:\s*var\(--wb-accent-strong\)/s);
  assert.match(styles, /\.wb-schema-list article\.is-selected\s*\{[^}]*background:\s*var\(--wb-accent-soft\)/s);
  assert.match(styles, /\.wb-database-item\s*\{[^}]*color:\s*var\(--wb-database-text\)/s);
  assert.match(styles, /\.wb-table-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)/s);
  assert.match(styles, /\.wb-tab-title small\s*\{[^}]*color:\s*var\(--wb-type-text\)/s);
  assert.match(styles, /\.wb-sidebar-status-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)/s);
  assert.match(styles, /\.wb-cell-identity-label,[\s\S]*?\.wb-cell-identity-count\s*\{[^}]*color:\s*var\(--wb-secondary-text\)/s);
  assert.match(styles, /\.wb-row-index\s*\{[^}]*color:\s*var\(--wb-quiet-text\)/s);
  assert.match(styles, /\.wb-grid-loading\s*\{[^}]*color:\s*var\(--wb-secondary-text\)/s);
  assert.match(styles, /\.wb-dialog-field\s*\{[^}]*color:\s*var\(--wb-secondary-text\)/s);
});

test("inspector detail divider has a discoverable resize treatment", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-inspector-divider\s*\{[^}]*cursor:\s*row-resize/s);
  assert.match(styles, /\.wb-inspector-divider:hover\s+span,[\s\S]*?\.wb-inspector-divider:focus-visible\s+span\s*\{[^}]*background:\s*var\(--wb-accent\)/s);
  assert.match(styles, /\.wb-text-panel\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.match(styles, /\.wb-detail-editor\s*\{[^}]*flex:\s*1/s);
});

test("virtual grid scroll observers clean up lifecycles", () => {
  const virtual = read("./composables/useVirtualGrid.js");

  assert.match(virtual, /onBeforeUnmount/);
  assert.match(virtual, /resizeObserver\.disconnect\(\)/);
});

test("grid edit mode keeps text metrics stable with a thin single focus ring", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*box-sizing:\s*border-box/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*height:\s*25px/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*line-height:\s*25px/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*font:\s*inherit/s);
  assert.match(styles, /\.wb-grid td input\s*\{[^}]*appearance:\s*none/);
  assert.match(styles, /\.wb-grid td input\s*\{[^}]*vertical-align:\s*top/);
  assert.match(styles, /\.wb-grid td input:focus\s*\{[^}]*outline:\s*none/);
  assert.match(styles, /\.wb-grid td\.editing\s*\{[^}]*outline:\s*1px solid var\(--wb-accent\)/);
  assert.match(styles, /\.wb-grid-wrap:not\(:focus\) \.wb-grid td\.editing\s*\{[^}]*outline:\s*1px solid var\(--wb-accent\)/);
  assert.doesNotMatch(styles, /\.wb-grid td input\s*\{[^}]*height:\s*100%/);
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

test("tauri permits the native titlebar theme synchronization command", () => {
  const capability = JSON.parse(read("../../src-tauri/capabilities/main.json"));

  assert.deepEqual(capability.windows, ["main"]);
  assert.ok(capability.permissions.includes("core:default"));
  assert.ok(capability.permissions.includes("core:window:allow-set-theme"));
});
