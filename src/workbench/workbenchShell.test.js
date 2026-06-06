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
  assert.match(styles, /\.wb-grid\s*\{[\s\S]*font-size:\s*13px/);
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
  assert.match(all, /commitInsertRows/);
  assert.match(all, /commitInsertRowsAndRefresh/);
  assert.match(all, /class="wb-insert-row"/);
  assert.match(all, /wb-connection-node/);
  assert.match(all, /wb-source-tree/);
  assert.match(all, /wb-connection-add/);
  assert.match(styles, /\.wb-context-menu/);
  assert.match(styles, /\.wb-connection-add\s*\{[^}]*line-height:\s*1;/s);
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
  assert.match(orchestrator, /<SelectedCellIdentity\s+class="wb-statusbar-cell"/);
  assert.match(orchestrator, /:selected-cell="selectedCell"/);
  assert.match(orchestrator, /:selected-range="selectedRange"/);
  assert.match(identity, /buildSelectedCellIdentity/);
  assert.match(identity, /wb-cell-identity/);
  assert.match(identity, /:title="identity\.title"/);
  assert.match(tabs, /tab\.database/);
  assert.match(tabs, /previewDragOrder/);
  assert.match(tabs, /previewTabs/);
  assert.match(tabs, /<TransitionGroup\s+name="wb-tab-reorder"/);
  assert.match(tabs, /class="wb-tab-list"/);
  assert.match(tabs, /draggable="true"/);
  assert.match(tabs, /type="button"\s+class="wb-tab-close"/);
  assert.match(tabs, /@mousedown\.stop/);
  assert.match(tabs, /@dragstart\.prevent\.stop/);
  assert.match(tabs, /reorder-tab/);
  assert.match(styles, /\.wb-tab-reorder-move/);
  assert.match(styles, /\.wb-tab-list/);
  assert.match(styles, /\.wb-tab-close:hover/);
  assert.doesNotMatch(grid, /wb-object-heading|tabDisplayName/);
  assert.match(styles, /\.wb-source-tree/);
  assert.match(styles, /\.wb-table-copy\s*\{/);
  assert.match(styles, /\.wb-table-comment/);
  assert.match(styles, /\.wb-grid-statusbar/);
  assert.match(styles, /\.wb-sidebar-status/);
  assert.match(styles, /\.wb-sidebar-status-comment/);
  assert.match(styles, /\.wb-cell-identity/);
  assert.match(styles, /\.wb-statusbar-cell/);
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

test("database context menu opens overwrite sync dialog wiring", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const menu = read("./components/ContextMenu.vue");
  const styles = read("./workbench.css");

  assert.match(sidebar, /kind:\s*["']database["']/);
  assert.match(sidebar, /connectionId:\s*connection\.id/);
  assert.match(sidebar, /database\s*\}/);
  assert.match(sidebar, /@contextmenu\.prevent\.stop/);
  assert.match(menu, /kind/);
  assert.match(menu, /connectionId/);
  assert.match(menu, /database/);
  assert.match(menu, /覆盖同步\.\.\./);
  assert.match(menu, /sync-database/);
  assert.match(orchestrator, /import\s+DatabaseSyncDialog\s+from\s+["']\.\/components\/DatabaseSyncDialog\.vue["']/);
  assert.match(orchestrator, /import\s+\{\s*useDatabaseSync\s*\}\s+from\s+["']\.\/composables\/useDatabaseSync\.js["']/);
  assert.match(orchestrator, /closeDatabaseTabs/);
  assert.match(orchestrator, /const\s+databaseSync\s*=\s*useDatabaseSync/);
  assert.match(orchestrator, /@sync-database="openDatabaseSync"/);
  assert.match(orchestrator, /<DatabaseSyncDialog/);
  assert.match(styles, /\.wb-database-sync-dialog/);
});

test("database sync dialog renders and wires source and target selectors", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dialog = read("./components/DatabaseSyncDialog.vue");

  assert.match(dialog, /target-change/);
  assert.match(dialog, /function\s+targetChanged/);
  assert.match(dialog, /<span>目标库<\/span>[\s\S]*<select[^>]*:value="sync\.dialog\.targetDatabase"/);
  assert.match(dialog, /<option\s+v-for="database in sync\.targetDatabaseOptions\.value"/);
  assert.match(dialog, /@change="targetChanged"/);
  assert.match(dialog, /<span>源库<\/span>[\s\S]*<select[^>]*:value="sync\.dialog\.sourceDatabase"/);
  assert.match(orchestrator, /@target-change="databaseSync\.setTargetDatabase"/);
});

test("database sync dialog renders restore result details for restored and manual recovery states", () => {
  const dialog = read("./components/DatabaseSyncDialog.vue");

  assert.match(dialog, /restoreResult/);
  assert.match(dialog, /failed-restored/);
  assert.match(dialog, /restore-failed/);
  assert.match(dialog, /failed-restore-failed/);
  assert.match(dialog, /failedRestored/);
  assert.match(dialog, /failedRestoreFailed/);
  assert.match(dialog, /已从备份恢复目标库/);
  assert.match(dialog, /需要手动恢复/);
  assert.match(dialog, /backupDatabase|backup_database/);
  assert.match(dialog, /sync\.dialog\.status === 'succeeded' && !restoreResult/);
});

test("database sync lifecycle cleans progress listeners before unmount", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const composable = read("./composables/useDatabaseSync.js");

  assert.match(composable, /function\s+dispose/);
  assert.match(composable, /unlistenProgress\?\./);
  assert.match(orchestrator, /onBeforeUnmount/);
  assert.match(orchestrator, /databaseSync\.dispose\(\)/);
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
  assert.match(selectCellAtBody, /scrollCellIntoView\(rowIndex,\s*columnIndex\)/);
  assert.match(selectCellAtBody, /focusGrid:\s*false/);
  assert.doesNotMatch(selectCellAtBody, /activeColumns\.value\[columnIndex\]/);
});

test("cell highlighting reads the in-table search query without requiring backend filtering", () => {
  const display = read("./utils/cellDisplay.js");

  assert.match(display, /const query = \(tab\?\.searchQuery \?\? tab\?\.filter \?\? ""\)\.trim\(\)/);
  assert.match(display, /tab\.filterMode \|\| "fuzzy"/);
});

test("scrollable panes keep thicker native interactive scrollbars", () => {
  const allComponents = readAllComponents();
  const orchestrator = read("./MySqlWorkbench.vue");
  const styles = read("./workbench.css");

  assert.doesNotMatch(allComponents, /wb-grid-scroll-indicator/);
  assert.match(styles, /--wb-scrollbar-size:\s*10px/);
  assert.match(styles, /\.mysql-workbench \*\s*\{[\s\S]*scrollbar-width:\s*auto/);
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
  assert.doesNotMatch(theme, /set_window_chrome_theme/);
});

test("workbench renders a custom draggable titlebar on the chrome surface", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /class="wb-titlebar"/);
  assert.match(orchestrator, /data-tauri-drag-region/);
  assert.doesNotMatch(orchestrator, /wb-titlebar-brand|wb-titlebar-mark|wb-titlebar-title/);
  assert.doesNotMatch(orchestrator, />DB Scout Workbench</);
  assert.doesNotMatch(styles, /\.wb-titlebar-brand|\.wb-titlebar-mark|\.wb-titlebar-title/);
  assert.match(orchestrator, /minimizeWindow/);
  assert.match(orchestrator, /toggleMaximizeWindow/);
  assert.match(orchestrator, /closeWindow/);
  assert.match(styles, /\.wb-titlebar\s*\{[^}]*background:\s*var\(--wb-chrome-surface\)/s);
  assert.match(styles, /\.wb-titlebar-controls\s*\{/);
  assert.match(styles, /\.wb-titlebar-button\.is-close:hover\s*\{/);
});

test("theme palettes style the full workbench and its floating icon control", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.mysql-workbench\[data-theme="light"\]\s*\{[\s\S]*color-scheme:\s*light/);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*color-scheme:\s*dark/);
  for (const token of [
    "--wb-control",
    "--wb-chrome-surface",
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
  assert.match(styles, /\.wb-workspace\s*\{[^}]*background:\s*var\(--wb-chrome-surface\)/s);
  assert.match(styles, /\.wb-sidebar\s*\{[^}]*background:\s*var\(--wb-chrome-surface\)/s);
});

test("grid readability uses comfortable density and stronger theme contrast tokens", () => {
  const styles = read("./workbench.css");
  const constants = read("./constants.js");
  const rootRule = styles.match(/:root\s*\{([^}]*)\}/s)?.[1] || "";
  const darkRule = styles.match(/\.mysql-workbench\[data-theme="dark"\]\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(constants, /GRID_ROW_HEIGHT\s*=\s*28/);
  assert.match(styles, /\.wb-grid\s*\{[^}]*font-size:\s*13px/s);
  assert.match(styles, /\.wb-grid th,\s*\.wb-grid td\s*\{[^}]*height:\s*28px/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*height:\s*27px/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*line-height:\s*27px/s);
  assert.match(rootRule, /--wb-quiet-text:\s*#6b6f76/);
  assert.match(rootRule, /--wb-grid-row:\s*#ffffff/);
  assert.match(rootRule, /--wb-mark-surface:\s*rgba\(255,\s*196,\s*0,\s*0\.55\)/);
  assert.match(darkRule, /--wb-grid-row:\s*#1a1a1c/);
  assert.match(darkRule, /--wb-line:\s*rgba\(255,\s*255,\s*255,\s*0\.06\)/);
  assert.match(darkRule, /--wb-mark-surface:\s*rgba\(221,\s*171,\s*45,\s*0\.5\)/);
});

test("text inputs keep visible text cursors across theme switches", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.mysql-workbench input,\s*\.mysql-workbench textarea\s*\{[^}]*cursor:\s*text/s);
  assert.match(styles, /\.mysql-workbench input,\s*\.mysql-workbench textarea\s*\{[^}]*caret-color:\s*var\(--wb-text\)/s);
  assert.match(styles, /\.mysql-workbench\[data-theme="light"\]\s+input,\s*\.mysql-workbench\[data-theme="light"\]\s+textarea\s*\{[^}]*color-scheme:\s*light/s);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s+input,\s*\.mysql-workbench\[data-theme="dark"\]\s+textarea\s*\{[^}]*color-scheme:\s*dark/s);
});

test("status bar renders operation feedback messages", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /class="wb-operation-status"/);
  assert.match(orchestrator, /role="status"/);
  assert.match(orchestrator, /aria-live="polite"/);
  assert.match(orchestrator, /\{\{\s*statusText\s*\}\}/);
  assert.match(orchestrator, /<SelectedCellIdentity[\s\S]*<section\s+class="wb-operation-status"/);
  assert.match(styles, /\.wb-operation-status\s*\{/);
  assert.match(styles, /\.wb-operation-status\.is-error\s*\{/);
});

test("cell save feedback floats beside the saved cell", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const editor = read("./composables/useGridEditor.js");
  const grid = read("./components/DataGrid.vue");
  const styles = read("./workbench.css");

  assert.match(editor, /onSaveFeedback/);
  assert.match(editor, /kind:\s*"success"/);
  assert.match(editor, /kind:\s*"error"/);
  assert.match(orchestrator, /const\s+saveReminders\s*=\s*ref\(\[\]\)/);
  assert.match(orchestrator, /function\s+showSaveReminder/);
  assert.match(orchestrator, /querySelector\(`td\[data-row-key="\$\{cssEscape\(rowKey\)\}"\]\[data-column-name="\$\{cssEscape\(column\)\}"\]`\)/);
  assert.match(orchestrator, /class="wb-save-reminder-layer"/);
  assert.match(orchestrator, /v-for="reminder in saveReminders"/);
  assert.match(orchestrator, /class="wb-save-reminder"/);
  assert.match(grid, /:data-row-key="rowKey"/);
  assert.match(grid, /:data-column-name="columnName\(column\)"/);
  assert.match(styles, /\.wb-save-reminder-layer\s*\{/);
  assert.match(styles, /\.wb-save-reminder\.is-success\s*\{/);
  assert.match(styles, /\.wb-save-reminder\.is-error\s*\{/);
  assert.match(styles, /@keyframes\s+wb-save-reminder-float/);
});

test("inspector exposes distinct field, type, key, and remark roles", () => {
  const inspector = read("./components/InspectorPanel.vue");

  assert.match(inspector, /function\s+isSelectedColumn/);
  assert.match(inspector, /class="wb-schema-field-name"/);
  assert.match(inspector, /class="wb-schema-type-line"/);
  assert.match(inspector, /class="wb-schema-field-type"/);
  assert.match(inspector, /class="wb-schema-field-length"/);
  assert.match(inspector, /columnLength\(column\)/);
  assert.match(inspector, /class="wb-schema-key-badge"/);
  assert.match(inspector, /class="wb-schema-field-comment"/);
  assert.match(inspector, /columnRemark\(column\)/);
  assert.doesNotMatch(inspector, /startSchemaListDrag/);
  assert.doesNotMatch(inspector, /schemaListDrag/);
  assert.doesNotMatch(inspector, /is-dragging/);
  assert.match(inspector, /:class="\{\s*'is-selected':\s*isSelectedColumn\(column\)\s*\}"/);
  assert.match(inspector, /v-if="columnRemark\(column\)"/);
});

test("inspector remark list remains selectable without drag scrolling", () => {
  const styles = read("./workbench.css");
  const schemaListRule = styles.match(/\.wb-schema-list\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(schemaListRule, /overflow:\s*auto/);
  assert.doesNotMatch(schemaListRule, /user-select:\s*none/);
  assert.doesNotMatch(schemaListRule, /cursor:\s*grab/);
  assert.doesNotMatch(styles, /\.wb-schema-list\.is-dragging/);
  assert.doesNotMatch(styles, /\.wb-schema-list\.is-dragging\s*\{[^}]*cursor:\s*grabbing/s);
});

test("inspector scrolls the selected field remark into the visible list", () => {
  const inspector = read("./components/InspectorPanel.vue");

  assert.match(inspector, /function\s+scrollSelectedColumnIntoView/);
  assert.match(inspector, /data-schema-column/);
  assert.match(inspector, /watch\(\s*\(\)\s*=>\s*\[selectedCellKey\.value,\s*props\.activeColumns\.length\]/s);
  assert.match(inspector, /nextTick\(scrollSelectedColumnIntoView\)/);
  assert.match(inspector, /selectedColumn\.getBoundingClientRect\(\)/);
  assert.match(inspector, /schemaListRef\.value\.scrollTop\s*\+=/);
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
  const rootRule = styles.match(/:root\s*\{([^}]*)\}/s)?.[1] || "";
  const darkRule = styles.match(/\.mysql-workbench\[data-theme="dark"\]\s*\{([^}]*)\}/s)?.[1] || "";

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

  assert.match(styles, /--wb-font-ui:\s*"Microsoft YaHei UI",\s*"Microsoft YaHei"/);
  assert.match(styles, /font-family:\s*var\(--wb-font-ui\)/);
  assert.match(styles, /\.wb-detail-highlights,\s*\.wb-detail-input\s*\{[^}]*font-family:\s*var\(--wb-font-ui\)/s);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*--wb-type-text:/);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*--wb-remark-text:/);
  assert.match(styles, /\.mysql-workbench\[data-theme="dark"\]\s*\{[\s\S]*--wb-database-text:/);
  assert.match(rootRule, /--wb-database-text:\s*#1a1c20/);
  assert.match(darkRule, /--wb-database-text:\s*#e2e4e8/);
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
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*height:\s*27px/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*line-height:\s*27px/s);
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
  assert.match(dataGrid, /selectedInsertRow/);
  assert.match(dataGrid, /isInsertRowVisible/);
  assert.match(dataGrid, /getInsertRows/);
  assert.doesNotMatch(dataGrid, /insert-commit/);
  assert.doesNotMatch(dataGrid, /insert-save-all/);
  assert.doesNotMatch(dataGrid, /保存新增/);
  assert.match(dataGrid, /v-for="\(insertRow, insertRowIndex\) in isInsertRowVisible\(tab\) \? getInsertRows\(tab\) : \[\]"/);
  assert.match(dataGrid, /tab\.rows\.length \+ insertRowIndex \+ 1/);
  assert.doesNotMatch(dataGrid, /insertRowIndex \+ 1 \}\}\*/);
  assert.match(dataGrid, /data-insert-row-id/);
  assert.match(dataGrid, /insert-paste/);
  assert.match(dataGrid, /@paste\.prevent\.stop="emit\('insert-paste', tab, insertRow\.id, columnIndex, \$event\)"/);
  assert.match(dataGrid, /insert-row-select/);
  assert.match(dataGrid, /@click\.stop="emit\('insert-row-select', tab, insertRow\.id, \$event\)"/);
  assert.match(dataGrid, /row-select-start/);
  assert.match(dataGrid, /row-select-enter/);
  assert.match(dataGrid, /row-select-end/);
  assert.doesNotMatch(dataGrid, /wb-batch-bar/);
  assert.match(orchestrator, /function\s+selectGridRow/);
  assert.match(orchestrator, /function\s+startGridRowDragSelection/);
  assert.match(orchestrator, /function\s+extendGridRowDragSelection/);
  assert.match(orchestrator, /function\s+finishGridRowDragSelection/);
  assert.match(orchestrator, /function\s+selectGridInsertRow/);
  assert.match(orchestrator, /:selected-insert-row="selectedInsertRow"/);
  assert.match(orchestrator, /:get-insert-rows="getInsertRows"/);
  assert.match(orchestrator, /:is-insert-row-visible="isInsertRowVisible"/);
  assert.match(orchestrator, /@insert-row-select="selectGridInsertRow"/);
  assert.match(orchestrator, /@row-select-start="startGridRowDragSelection"/);
  assert.match(orchestrator, /@row-select-enter="extendGridRowDragSelection"/);
  assert.match(orchestrator, /@row-select-end="finishGridRowDragSelection"/);
  assert.doesNotMatch(orchestrator, /@insert-commit/);
  assert.match(orchestrator, /@pointerdown\.capture="maybeAutoSaveInsertDrafts"/);
  assert.match(orchestrator, /function\s+maybeAutoSaveInsertDrafts/);
  assert.match(orchestrator, /event\?\.target\?\.closest\?\.\("\.wb-insert-row"\)/);
  assert.match(orchestrator, /hasInsertDrafts\(tab\)/);
  assert.match(orchestrator, /commitInsertRowsAndRefresh\(tab\)/);
  assert.match(orchestrator, /clearSelection\(\)/);
  assert.match(orchestrator, /handleGridKeydownWithRows/);
  assert.match(orchestrator, /const result = await handleGridKeydown\(event\)/);
  assert.match(orchestrator, /result\?\.insertedRows > 0/);
  assert.match(orchestrator, /fetchPage\(tab, tab\.page \|\| 1\)/);
  assert.match(orchestrator, /deleteSelectedRows\(tab\)/);
  assert.match(orchestrator, /@insert-keydown="handleInsertKeydown"/);
  assert.match(orchestrator, /@insert-paste="pasteIntoInsertInput"/);
  assert.doesNotMatch(dataGrid, /@keydown\.enter\.prevent\.stop="emit\('insert-commit'/);
  assert.match(orchestrator, /function\s+matchesInsertedDraft/);
  assert.match(orchestrator, /function\s+selectVisibleInsertedRow/);
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

test("sidebar connection and database nodes support drag reorder", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const styles = read("./workbench.css");

  assert.match(sidebar, /reorder-connections/);
  assert.match(sidebar, /reorder-databases/);
  assert.match(sidebar, /draggable="true"/);
  assert.match(sidebar, /@dragstart\.stop/);
  assert.match(sidebar, /@dragover\.prevent\.stop/);
  assert.match(sidebar, /@drop\.prevent\.stop/);
  assert.match(sidebar, /dragState\.kind !== 'connection'/);
  assert.match(sidebar, /dragState\.kind !== 'database'/);
  assert.match(sidebar, /previewDragOrder/);
  assert.match(sidebar, /resolvePreviewDropTarget/);
  assert.match(sidebar, /previewConnections/);
  assert.match(sidebar, /previewDatabases/);
  assert.match(sidebar, /setDragImage/);
  assert.match(sidebar, /cloneNode\(true\)/);
  assert.match(sidebar, /getBoundingClientRect/);
  assert.match(sidebar, /wb-sidebar-drag-image/);
  assert.match(styles, /\.wb-sidebar-drag-image/);
  assert.match(sidebar, /TransitionGroup/);
  assert.match(sidebar, /name="wb-tree-reorder"/);
  assert.match(sidebar, /is-drag-preview-target/);
  assert.match(orchestrator, /reorderConnections/);
  assert.match(orchestrator, /reorderDatabases/);
  assert.match(orchestrator, /@reorder-connections="reorderConnections"/);
  assert.match(orchestrator, /@reorder-databases="reorderDatabases"/);
  assert.match(styles, /\.wb-tree-row\.is-drag-over/);
  assert.match(styles, /\.wb-tree-row\.is-dragging-source/);
  assert.match(styles, /\.wb-tree-row\.is-dragging-source\s*>\s*\*/);
  assert.match(styles, /\.wb-tree-reorder-move/);
  assert.match(styles, /\.wb-tree-row\.is-drag-preview-target/);
  assert.match(styles, /\.wb-source-connection\.is-drop-before\s*>\s*\.wb-tree-row::before/);
  assert.match(styles, /\.wb-source-connection\.is-drop-after\s*>\s*\.wb-tree-row::before/);
  assert.match(styles, /\.wb-source-database\.is-drop-before\s*>\s*\.wb-tree-row::before/);
  assert.match(styles, /\.wb-source-database\.is-drop-after\s*>\s*\.wb-tree-row::before/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("tauri main window uses custom web chrome for an integrated titlebar", () => {
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  const main = config.app.windows.find((window) => window.label === "main");

  assert.ok(main.width >= 1200);
  assert.ok(main.height >= 760);
  assert.equal(main.decorations, false);
  assert.equal(main.resizable, true);
  assert.equal(main.alwaysOnTop, false);
  assert.equal(main.skipTaskbar, false);
  assert.equal(main.transparent, false);
  assert.equal(main.center, true);
  assert.equal(main.maximized, true);
  assert.equal(main.dragDropEnabled, false);
  assert.ok(main.minWidth >= 1120);
  assert.ok(main.minHeight >= 720);
});

test("windows release binary uses the GUI subsystem instead of opening a console", () => {
  const main = read("../../src-tauri/src/main.rs");

  assert.match(main, /cfg_attr\(\s*all\(\s*not\(debug_assertions\),\s*target_os\s*=\s*"windows"\s*\),\s*windows_subsystem\s*=\s*"windows"\s*\)/);
});

test("tauri permits custom titlebar window controls", () => {
  const capability = JSON.parse(read("../../src-tauri/capabilities/main.json"));

  assert.deepEqual(capability.windows, ["main"]);
  assert.ok(capability.permissions.includes("core:default"));
  assert.ok(capability.permissions.includes("core:window:allow-set-theme"));
  assert.ok(capability.permissions.includes("core:window:allow-minimize"));
  assert.ok(capability.permissions.includes("core:window:allow-maximize"));
  assert.ok(capability.permissions.includes("core:window:allow-unmaximize"));
  assert.ok(capability.permissions.includes("core:window:allow-is-maximized"));
  assert.ok(capability.permissions.includes("core:window:allow-close"));
  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
});

test("tauri updater is configured for the free Gitee release feed", () => {
  const pkg = JSON.parse(read("../../package.json"));
  const cargo = read("../../src-tauri/Cargo.toml");
  const lib = read("../../src-tauri/src/lib.rs");
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  const capability = JSON.parse(read("../../src-tauri/capabilities/main.json"));

  assert.ok(pkg.dependencies["@tauri-apps/plugin-updater"]);
  assert.ok(pkg.dependencies["@tauri-apps/plugin-process"]);
  assert.match(cargo, /tauri-plugin-updater/);
  assert.match(cargo, /tauri-plugin-process/);
  assert.match(lib, /tauri_plugin_process::init\(\)/);
  assert.match(lib, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);

  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(
    config.plugins.updater.endpoints[0],
    "https://gitee.com/shelbylouis/dbscout-workbench-release/raw/master/latest.json",
  );
  assert.equal(
    config.plugins.updater.pubkey,
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJDQzAzRjhFMjY5M0RDQkYKUldTLzNKTW1qai9Bdk8yVGZzMGxlRGh3QS81SkhRdC9vMUtuN2FTV0lBUHpaR21nVHpGQ3lJTi8K",
  );
  assert.equal(config.plugins.updater.windows.installMode, "passive");
  assert.ok(capability.permissions.includes("updater:default"));
  assert.ok(capability.permissions.includes("process:default"));
});

test("workbench exposes an in-app updater entry and dialog", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dialog = read("./components/UpdateDialog.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /import\s+UpdateDialog\s+from\s+["']\.\/components\/UpdateDialog\.vue["']/);
  assert.match(orchestrator, /import\s+\{\s*useUpdater\s*\}\s+from\s+["']\.\/composables\/useUpdater\.js["']/);
  assert.match(orchestrator, /const\s+updater\s*=\s*useUpdater\(\)/);
  assert.match(orchestrator, /class="wb-update-button"/);
  assert.match(orchestrator, /@click\.stop="openUpdateDialog"/);
  assert.match(orchestrator, /closest\?\.\(["']\.wb-titlebar-controls,\s*\.wb-update-button["']\)/);
  assert.match(orchestrator, /<UpdateDialog/);
  assert.match(orchestrator, /void updater\.checkForUpdates\(\)/);

  assert.match(dialog, /defineProps/);
  assert.match(dialog, /currentVersion/);
  assert.match(dialog, /availableUpdate/);
  assert.match(dialog, /downloadPercent/);
  assert.match(dialog, /downloadAndInstall/);
  assert.match(dialog, /unavailable/);
  assert.match(dialog, /立即重启/);

  assert.match(styles, /\.wb-update-button/);
  assert.match(styles, /\.wb-update-dialog/);
  assert.match(styles, /\.wb-update-progress/);
  assert.match(styles, /wb-update-pulse/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("grid can leave blank canvas when resized columns no longer fill the viewport", () => {
  const styles = read("./workbench.css");
  const gridRule = styles.match(/\.wb-grid\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(gridRule, /width:\s*max-content/);
  assert.doesNotMatch(gridRule, /min-width:\s*100%/);
});

test("light theme keeps text carets and filter-mode hover legible", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.mysql-workbench\[data-theme="light"\] input,\s*\.mysql-workbench\[data-theme="light"\] textarea\s*\{[^}]*caret-color:\s*#1a1c20/s);
  assert.match(styles, /\.mysql-workbench\[data-theme="light"\] \.wb-detail-editor\.has-highlight \.wb-detail-input\s*\{[^}]*caret-color:\s*#1a1c20/s);
  assert.match(styles, /\.mysql-workbench\[data-theme="light"\]\s+\.wb-table-toolbar input,\s*\.mysql-workbench\[data-theme="light"\]\s+\.wb-detail-input\s*\{[^}]*cursor:\s*var\(--wb-text-cursor-light\),\s*text/s);
  assert.match(styles, /--wb-accent-control-hover:\s*#2d3748/);
  assert.match(styles, /--wb-accent-control-text:\s*#ffffff/);
  assert.match(styles, /\.wb-filter-mode-btn:hover:not\(:disabled\),\s*\.wb-filter-mode-btn:focus-visible\s*\{[^}]*background:\s*var\(--wb-accent-control-hover\)/s);
});

test("root surfaces keep resize gaps on the active theme background", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /--wb-root-background-light:/);
  assert.match(styles, /--wb-root-background-dark:/);
  assert.match(styles, /html,\s*body,\s*#app\s*\{[^}]*background:\s*var\(--wb-root-background,\s*var\(--wb-root-background-light\)\)/s);
  assert.match(styles, /html\[data-wb-theme="light"\]\s*\{[^}]*--wb-root-background:\s*var\(--wb-root-background-light\)/s);
  assert.match(styles, /html\[data-wb-theme="dark"\]\s*\{[^}]*--wb-root-background:\s*var\(--wb-root-background-dark\)/s);
});

test("table search toolbar keeps previous and next navigation visible", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const grid = read("./components/DataGrid.vue");

  assert.match(grid, /hasSearchMatches/);
  assert.match(grid, /search-previous/);
  assert.match(grid, /search-next/);
  assert.match(grid, /@keydown\.enter\.prevent="emit\('search-next'\)"/);
  assert.doesNotMatch(grid, /v-if="hasSearchMatches"/);
  assert.match(grid, /:disabled="!hasSearchMatches"/);
  assert.match(grid, />上一个<\/button>/);
  assert.match(grid, />下一个<\/button>/);
  assert.match(orchestrator, /:has-search-matches="hasSearchMatches"/);
  assert.match(orchestrator, /@search-previous="goToPreviousSearchMatch"/);
  assert.match(orchestrator, /@search-next="goToNextSearchMatch"/);
});

test("performance instrumentation uses the shared development-only utility", () => {
  const perf = read("./utils/performanceMarks.js");
  const bridge = read("./utils/tauriBridge.js");
  const connection = read("./composables/useConnection.js");
  const tableSession = read("./composables/useTableSession.js");
  const grid = read("./components/DataGrid.vue");
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(perf, /\[dbscout:perf\]/);
  assert.match(perf, /import\.meta\.env\?\.DEV/);
  assert.match(bridge, /measureAsync/);
  assert.match(connection, /markPerf/);
  assert.match(tableSession, /markPerf/);
  assert.match(grid, /sampleNextFrame/);
  assert.match(orchestrator, /workbench\.mounted/);
});
