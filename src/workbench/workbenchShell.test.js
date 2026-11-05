import { readLocalizedContractSource } from "./test-support/localizedContractSource.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (p) => readLocalizedContractSource(new URL(p, import.meta.url), "utf8");
const visibleTextSnippets = (source) => [
  ...source.matchAll(/>([^<>{}\r\n]*(?:\.\.\.)[^<>{}\r\n]*)</g),
  ...source.matchAll(/\b(?:placeholder|title|aria-label)=["']([^"']*(?:\.\.\.)[^"']*)["']/g),
].map((match) => match[1] || match[0]);
const DARK_THEME_SELECTOR = '.mysql-workbench[data-theme="dark"], .wb-floating-themed[data-theme="dark"]';

function cssRuleBody(css, selector) {
  const escaped = selector
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  return css.match(new RegExp(`(?:^|\\r?\\n)${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1] || "";
}

function readAllComponents() {
  const dir = fileURLToPath(new URL("./components", import.meta.url));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".vue"));
  return files.map((f) => readLocalizedContractSource(path.join(dir, f), "utf8")).join("\n");
}

test("narrow layouts leave inspector visibility under the pane toggle's control", () => {
  const styles = read("./workbench.css");
  const narrowLayout = styles.slice(styles.indexOf("@media (max-width: 1119px)"), styles.indexOf("@media (max-width: 760px)"));
  assert.ok(narrowLayout.length > 0);
  assert.doesNotMatch(narrowLayout, /\.wb-(?:inspector|pane-divider--right)[^{]*\{[^}]*display:\s*none/s);
});

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
    "get_table_schemas",
    "open_table_session",
    "fetch_table_page",
    "fetch_table_count",
    "cancel_table_count",
    "update_cell",
    "update_cells",
    "insert_row",
    "delete_rows",
    "agent_start_session",
    "agent_send",
    "agent_abort",
  ]) {
    assert.match(all, new RegExp(`["']${command}["']`), `missing command: ${command}`);
  }
  assert.match(all, /mockWorkbenchInvoke/);
  assert.match(all, /game_db/);
  assert.doesNotMatch(all, /["']search_data["']/);
});

test("legacy search_data frontend path has no production caller", () => {
  const productionSources = [
    read("./MySqlWorkbench.vue"),
    read("./workspaceState.js"),
    read("./composables/useConnection.js"),
    read("./composables/useTableSession.js"),
    read("./composables/useGridEditor.js"),
    read("./composables/useImportWizard.js"),
    read("./composables/useRowSelection.js"),
    read("./mock/mockBackend.js"),
  ].join("\n");

  assert.doesNotMatch(productionSources, /useDataSearch/);
  assert.doesNotMatch(productionSources, /["']search_data["']/);
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
  assert.match(styles, /\.wb-grid\s*\{[\s\S]*font-size:\s*var\(--wb-fs-body\)/);
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
  assert.match(orchestrator, /<WorkbenchActivityRail\b/);
  assert.doesNotMatch(all, /wb-connection-add/);
  assert.match(styles, /\.wb-context-menu/);
  assert.doesNotMatch(styles, /\.wb-connection-add/);
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
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
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
  assert.doesNotMatch(orchestrator, /wb-grid-statusbar/);
  assert.doesNotMatch(orchestrator, /:active-status-label=/);
  assert.match(orchestrator, /:selected-range="focusedSelectedRange"/);
  assert.doesNotMatch(orchestrator, /activeStatusLabel/);
  assert.doesNotMatch(orchestrator, /wb-sidebar-status/);
  assert.match(orchestrator, /class="wb-operation-status-live wb-visually-hidden"/);
  assert.doesNotMatch(orchestrator, /import\s+SelectedCellIdentity/);
  assert.doesNotMatch(orchestrator, /<SelectedCellIdentity\s+class="wb-statusbar-cell"/);
  assert.match(orchestrator, /:selected-cell="focusedSelectedCell"/);
  assert.match(identity, /buildSelectedCellIdentity/);
  assert.match(identity, /wb-cell-identity/);
  assert.match(identity, /:title="identity\.title"/);
  assert.match(tabs, /tab\.database/);
  assert.match(tabs, /formatTableTabTitle\(tab, databaseLabel\(tab\.connectionId, tab\.database\)\)/);
  assert.match(tabs, /hasTabSubtitle/);
  assert.match(tabs, /wb-tab-title-stack/);
  assert.match(tabs, /wb-tab-line-secondary/);
  assert.match(tabs, /wb-tab-db/);
  assert.match(tabs, /tabDatabaseIcon\(tab\)/);
  assert.match(tabs, /tabDatabaseDecorationStyle\(tab\)/);
  assert.match(styles, /\.wb-tab-title-stack\s*\{/);
  assert.match(styles, /\.wb-tab-line-secondary\s*\{/);
  assert.match(styles, /\.wb-tab-db\s*\{/);
  assert.match(tabs, /tab\.kind/);
  assert.match(tabs, /data-kind/);
  assert.match(tabs, /设计/);
  assert.match(tabs, /previewDragOrder/);
  assert.match(tabs, /previewTabs/);
  assert.match(tabs, /<div ref="tabListRef" class="wb-tab-list"/);
  assert.match(tabs, /class="wb-tab-list"/);
  assert.doesNotMatch(tabs, /scrollIntoView/);
  assert.match(tabs, /:draggable="!tab\.opening && tabKind\(tab\) !== 'home'"/);
  assert.match(tabs, /type="button"\s+class="wb-tab-close"/);
  assert.match(tabs, /@mousedown\.stop/);
  assert.match(tabs, /@dragstart\.prevent\.stop/);
  assert.match(tabs, /reorder-tab/);
  assert.match(tabs, /copy-tab-name/);
  assert.match(tabs, /@dblclick\.stop="copyTabName\(tab,\s*\$event\)"/);
  assert.match(orchestrator, /function\s+copyTextToClipboard/);
  assert.match(orchestrator, /function\s+copyTabName/);
  assert.match(orchestrator, /已复制表名/);
  assert.match(orchestrator, /@copy-tab-name="copyTabName"/);
  assert.match(styles, /\.wb-save-reminder\.is-tab-copy\s*\{/);
  assert.match(styles, /\.wb-tab-reorder-move/);
  assert.match(styles, /\.wb-tab-list/);
  assert.match(styles, /\.wb-tab-close:hover/);
  assert.doesNotMatch(grid, /wb-object-heading|tabDisplayName/);
  assert.match(styles, /\.wb-source-tree/);
  assert.match(styles, /\.wb-table-copy\s*\{/);
  assert.match(styles, /\.wb-table-comment/);
  assert.doesNotMatch(styles, /\.wb-grid-statusbar/);
  assert.match(styles, /\.wb-inspector-table-status/);
  assert.match(styles, /\.wb-inspector-table-comment/);
  assert.doesNotMatch(styles, /\.wb-inspector-cell-panel/);
  assert.match(styles, /\.wb-cell-identity/);
  assert.doesNotMatch(styles, /\.wb-statusbar-cell/);
  assert.match(styles, /\.wb-cell-identity-key/);
  const identityRule = styles.match(/\.wb-cell-identity\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(identityRule, /overflow:\s*hidden/);
  assert.match(styles, /\.wb-cell-identity-key\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.doesNotMatch(styles, /\.wb-inspector-table-status\s*\{[^}]*transition:/);
});

test("workbench keeps design tabs out of data-grid rendering paths", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const dataGridTag = pane.match(/<DataGrid\b[\s\S]*?>/)?.[0] || "";
  const designEditorTag = pane.match(/<TableDesignEditor\b[\s\S]*?\/>/)?.[0] || "";

  assert.match(orchestrator, /import\s+TableDesignEditor\s+from\s+["']\.\/components\/TableDesignEditor\.vue["']/);
  assert.match(orchestrator, /const\s+activeDataTab\s*=\s*computed/);
  assert.match(orchestrator, /const\s+activeDesignTab\s*=\s*computed/);
  assert.match(pane, /useVirtualGrid\(activeDataTab,\s*props\.editState\)/);
  assert.match(pane, /useGridEditor\([\s\S]*activeDataTab[\s\S]*gridWrapRef/s);
  assert.match(pane, /useTableSearch\(activeDataTab,/);
  assert.match(dataGridTag, /v-if="activeDataTab"/);
  assert.match(dataGridTag, /:tab="activeDataTab"/);
  assert.doesNotMatch(dataGridTag, /activeTab/);
  assert.match(pane, /v-else-if="activeDesignTab" class="wb-pane-content-with-actions"/);
  assert.match(designEditorTag, /:source="activeDesignTab"/);
  assert.match(designEditorTag, /:invoke-workbench="invokeWorkbench"/);
  assert.match(designEditorTag, /:is-focused="isFocused"/);
  assert.match(designEditorTag, /@applied="emit\('design-applied', \$event\)"/);
  assert.doesNotMatch(orchestrator, /wb-design-placeholder/);
  assert.match(orchestrator, /function\s+handleTableDesignApplied/);
  assert.match(orchestrator, /ensureTableSchema\(item\.tableName,\s*\{\s*connectionId,\s*database\s*\}\)/);
  assert.match(orchestrator, /ensureTableSchema:\s*conn\.ensureTableSchema/);
  assert.match(orchestrator, /findTableDataTabs\(workspace,/);
  assert.match(orchestrator, /workspace\.tabs/);
  assert.match(orchestrator, /refreshTabPage\(tab,\s*1\)/);
  assert.match(orchestrator, /applyTableSchemaToDataTab\(tab,\s*schema\)/);
  assert.match(orchestrator, /markTableDataTabSchemaStale\(tab,\s*schema\)/);
  assert.match(orchestrator, /const\s+refreshErrors\s*=\s*\[\]/);
  assert.match(orchestrator, /refreshErrors\.push\(/);
  assert.match(orchestrator, /if \(refreshErrors\.length > 0\)/);
  assert.doesNotMatch(orchestrator, /markTableDataTabSchemaStale\(tab,\s*schema\);\s*\r?\n\s*throw error;/);
  const refreshLoop = orchestrator.match(/for \(const tab of affectedTabs\) \{[\s\S]*?\n    \}/)?.[0] || "";
  assert.match(refreshLoop, /const\s+refreshResult\s*=\s*await\s+refreshTabPage\(tab,\s*1\)/);
  assert.match(refreshLoop, /refreshResult\?\.ok/);
  assert.match(refreshLoop, /refreshResult\?\.stale/);
  assert.match(refreshLoop, /!refreshResult\?\.ok\s*&&\s*!refreshResult\?\.stale/);
  assert.match(refreshLoop, /markTableDataTabSchemaStale\(tab,\s*schema\)[\s\S]*refreshErrors\.push\(refreshResult\?\.error/);
  assert.match(refreshLoop, /applyTableSchemaToDataTab\(tab,\s*schema\)[\s\S]*refreshTabPage\(tab,\s*1\)/);
  assert.doesNotMatch(refreshLoop, /refreshTabPage\(tab,\s*1\)[\s\S]*applyTableSchemaToDataTab\(tab,\s*schema\)/);
  assert.match(orchestrator, /tableKey/);
  assert.match(orchestrator, /表设计已保存/);
  assert.doesNotMatch(orchestrator, /function\s+handleTableDesignApplied\s*\([^)]*\)\s*\{\s*const\s+tableName\s*=\s*source\?\.tableName\s*\|\|\s*activeDesignTab\.value\?\.tableName\s*\|\|\s*["']{2};\s*statusText\.value\s*=\s*`表设计已保存：\$\{tableName\}`;\s*\}/);
  assert.match(orchestrator, /<InspectorPanel[\s\S]*:active-tab="focusedInspectorTab"/);
  assert.doesNotMatch(orchestrator, /<SelectedCellIdentity[\s\S]*:tab="activeDataTab"/);
});

test("inspector status does not render a data row count", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const inspectorTag = orchestrator.match(/<InspectorPanel[\s\S]*?\/>/)?.[0] || "";
  const inspector = read("./components/InspectorPanel.vue");
  const styles = read("./workbench.css");

  assert.doesNotMatch(orchestrator, /activeStatusLabel/);
  assert.doesNotMatch(orchestrator, /function\s+rowCountLabel/);
  assert.doesNotMatch(inspectorTag, /active-status-label/);
  assert.doesNotMatch(inspector, /activeStatusLabel/);
  assert.doesNotMatch(inspector, /wb-inspector-table-count/);
  assert.match(styles, /\.wb-inspector-table-comment\s*\{[^}]*white-space:\s*normal/s);
  assert.match(styles, /\.wb-inspector-table-comment\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.doesNotMatch(styles, /\.wb-inspector-table-comment\s*\{[^}]*white-space:\s*nowrap/s);
});

test("workbench renders recursive split panes and keeps inspector scoped to the focused pane", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const splitLayout = read("./components/WorkbenchSplitLayout.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const tabs = read("./components/WorkbenchTabs.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /import\s+WorkbenchSplitLayout\s+from\s+["']\.\/components\/WorkbenchSplitLayout\.vue["']/);
  assert.match(orchestrator, /getFocusedTab\(workspace\)/);
  assert.match(orchestrator, /focusedPaneState/);
  assert.match(orchestrator, /handlePaneStateChange/);
  assert.match(orchestrator, /splitPaneInLayout/);
  assert.match(orchestrator, /closePaneInLayout/);
  assert.match(orchestrator, /resizeSplitInLayout/);
  assert.match(orchestrator, /@state-change="handlePaneStateChange"/);
  assert.match(orchestrator, /<WorkbenchSplitLayout/);
  assert.match(orchestrator, /:layout="workspace\.layout"/);
  assert.match(orchestrator, /:focused-pane-id="workspace\.focusedPaneId"/);
  assert.match(orchestrator, /@split-pane="splitPane"/);
  assert.match(orchestrator, /@close-pane="closePane"/);
  assert.match(orchestrator, /@resize-split="resizeSplit"/);
  assert.match(orchestrator, /<InspectorPanel[\s\S]*:active-tab="focusedInspectorTab"/);
  assert.doesNotMatch(orchestrator, /<SelectedCellIdentity[\s\S]*:tab="activeDataTab"/);
  assert.match(orchestrator, /openTable\(table,\s*\{\s*paneId:\s*workspace\.focusedPaneId/);

  assert.match(splitLayout, /name:\s*["']WorkbenchSplitLayout["']/);
  assert.match(splitLayout, /WorkbenchPane/);
  assert.match(splitLayout, /layout\?\.type === ["']split["']/);
  assert.match(splitLayout, /totalPaneCount/);
  assert.match(splitLayout, /:root-pane-count="totalPaneCount"/);
  assert.match(splitLayout, /:root-pane-count="totalPaneCount"/);
  assert.match(pane, /:can-close-pane="rootPaneCount > 1"/);
  assert.match(pane, /@close-pane="emit\('close-pane', pane\.id\)"/);
  assert.match(orchestrator, /discardPaneHomeTabs\(workspace, paneId\)[\s\S]*closePaneInLayout\(workspace, paneId\)/);
  assert.match(tabs, /v-else-if="canClosePane && tabKind\(tab\) === 'home'"/);
  assert.match(tabs, /aria-label="关闭当前分屏"/);
  assert.match(styles, /\.wb-tab\[data-kind="home"\]\.can-close-pane\s*\{/);
  assert.match(splitLayout, /function\s+nodeKey/);
  assert.match(splitLayout, /:key="nodeKey\(layout\.first\)"/);
  assert.match(splitLayout, /:key="nodeKey\(layout\.second\)"/);
  assert.match(splitLayout, /:key="nodeKey\(layout\)"/);
  assert.match(splitLayout, /wb-split-layout/);
  assert.match(splitLayout, /wb-split-divider/);
  assert.match(splitLayout, /resize-split/);

  assert.match(pane, /useVirtualGrid\(activeDataTab,\s*props\.editState\)/);
  assert.match(pane, /useGridEditor\(/);
  assert.match(pane, /useTableSearch\(activeDataTab/);
  assert.match(pane, /useRowSelection/);
  assert.match(pane, /splitMenuOpen/);
  assert.match(pane, /splitMenuAnchor/);
  assert.match(pane, /splitMenuPosition/);
  assert.match(pane, /wb-split-more-btn/);
  assert.match(pane, /openSplitMenuFromToolbar/);
  assert.match(pane, /wb-split-menu/);
  assert.match(pane, /<Teleport\s+defer\s+to="\.mysql-workbench">[\s\S]*class="wb-split-menu is-floating"/);
  assert.match(pane, /:data-pane-id="pane\.id"/);
  assert.match(pane, /左右分屏/);
  assert.match(pane, /上下分屏/);
  assert.match(pane, /批量导出/);
  assert.match(pane, /批量导入/);
  assert.match(pane, /activeDataTab\.value \|\| activeDesignTab\.value/);
  assert.match(orchestrator, /BatchExportDialog/);
  assert.match(orchestrator, /BatchImportDialog/);
  assert.match(orchestrator, /loadBatchImportFiles/);
  assert.match(orchestrator, /batchTransfer\.batchImport\.mode === "separate"/);
  assert.doesNotMatch(pane, /关闭分屏/);
  assert.match(pane, /emit\('close-pane',\s*pane\.id\)/);

  assert.match(styles, /\.wb-split-layout/);
  assert.match(styles, /\.wb-workbench-pane/);
  assert.match(styles, /\.wb-pane-tabbar/);
  assert.match(styles, /\.wb-pane-content-with-actions/);
  assert.match(styles, /\.wb-pane-empty-actions/);
  assert.match(styles, /\.wb-split-menu/);
  assert.match(styles, /\.wb-split-menu\.is-floating\s*\{[^}]*position:\s*fixed/s);
  assert.match(styles, /\.wb-split-divider/);
});

test("provisional table opens are visible but remain non-interactive until ready", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const splitLayout = read("./components/WorkbenchSplitLayout.vue");
  const tabs = read("./components/WorkbenchTabs.vue");
  const styles = read("./workbench.css");

  assert.match(splitLayout, /visibleTabsForPane\(props\.tabs,\s*pane\)/);
  assert.match(splitLayout, /publishedActiveTabForPane\(props\.tabs,\s*pane\)/);
  assert.match(tabs, /["']is-opening["']:\s*tab\.opening\s*===\s*true/);
  assert.match(tabs, /:aria-disabled="tab\.opening\s*\?\s*'true'\s*:\s*'false'"/);
  assert.match(tabs, />正在打开<\/small>/);
  assert.match(orchestrator, /adjacentPublishedTabId\(workspace\.tabs,\s*pane,\s*direction\)/);
  assert.match(orchestrator, /void\s+activateTab\(pane\.id,\s*nextTabId\)/);
  assert.match(orchestrator, /pendingTableOpenCount/);
  assert.match(orchestrator, /cancelPendingTableActivation\(paneId\)/);
  assert.match(orchestrator, /'is-opening-table':\s*pendingTableOpenCount\s*>\s*0/);
  assert.match(styles, /\.mysql-workbench\.is-opening-table,\s*\.mysql-workbench\.is-opening-table \*\s*\{[\s\S]*?cursor:\s*progress\s*!important/);
});

test("database homepage is wired as the current database table management tab", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const splitLayout = read("./components/WorkbenchSplitLayout.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const tabs = read("./components/WorkbenchTabs.vue");
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");
  const pasteHomeFlow = orchestrator.slice(
    orchestrator.indexOf("async function pasteHomeTables"),
    orchestrator.indexOf("async function renameHomeTable"),
  );
  const clearHomepageSelection = home.match(/function\s+clearSelection\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  const beginHomepageBoxSelection = tableList.match(/function\s+beginBoxSelection\(event\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(pane, /import\s+DatabaseHome\s+from\s+["']\.\/DatabaseHome\.vue["']/);
  assert.match(pane, /const\s+activeHomeTab\s*=\s*computed/);
  assert.match(pane, /const\s+databaseHomeRef\s*=\s*ref\(null\)/);
  assert.match(pane, /<DatabaseHome\b/);
  assert.match(pane, /ref="databaseHomeRef"/);
  assert.match(pane, /:key="activeHomeTab\.tabKey\s*\|\|\s*activeHomeTab\.id"/);
  assert.match(pane, /:tables="homeTables"/);
  assert.match(pane, /@visible-tables="emit\('home-visible-tables'/);
  assert.match(pane, /@paste-tables="[^"]*paste-home-tables/);
  assert.match(pane, /@delete-tables="[^"]*delete-home-tables/);
  assert.match(pane, /@send-tables="[^"]*send-home-tables/);
  assert.match(pane, /@batch-export="[^"]*batch-export/);
  assert.match(pane, /@batch-import="[^"]*batch-import/);
  assert.match(pane, /@refresh="[^"]*refresh-home/);
  assert.match(tableList, /@keydown="handleRowKeydown\(table, \$event\)"/);
  assert.match(tableList, /function handleRowKeydown\(table, event\)\s*\{[\s\S]*?key === "F2"[\s\S]*?handleRowRename\(table\)[\s\S]*?key === "Enter"[\s\S]*?handleRowOpen\(table\)[\s\S]*?isDeleteCommandKey\(event\)\) handleRowDelete\(table\)[\s\S]*?event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(tableList, /:ref="setRenameInput"/);
  assert.match(tableList, /@blur="submitRename"/);
  assert.match(tableList, /:aria-invalid="renameError/);
  assert.match(tableList, /class="wb-dbhome-rename-error"/);
  assert.match(tableList, /正在重命名…/);
  assert.match(tableList, /function\s+cancelRename/);
  assert.match(tableList, /renameSubmissionHandled/);
  assert.match(home, /result\.reason\s*===\s*["']unchanged["']/);
  assert.match(home, /onSuccess:\s*\(\)\s*=>/);
  assert.match(home, /onError:\s*\(error\)\s*=>/);
  assert.match(orchestrator, /source\.onError\?\.\(error\)/);
  assert.match(home, /function\s+refreshHome\(\)[\s\S]*controller\.resetForRefresh\(\)/);
  assert.match(home, /function\s+completeTablePaste[\s\S]*controller\.resetForMutationRefresh\(\)[\s\S]*controller\.setSelection\(pastedNames\)/);
  assert.match(home, /nextTick\(\(\)\s*=>\s*tableListRef\.value\?\.scrollTableIntoView\?\.\(pastedNames\[0\]\)\)/);
  assert.match(home, /onSuccess:\s*completeTablePaste/);
  assert.doesNotMatch(pasteHomeFlow, /home\.query\s*=/);
  assert.doesNotMatch(pasteHomeFlow, /home\.sortMode\s*=/);
  assert.match(home, /tableListRef\.value\?\.resetView\?\.\(\)/);
  assert.match(home, /@click="refreshHome"/);
  assert.match(tableList, /defineExpose\(\{\s*focusList,\s*pageRowCount,\s*resetView,\s*rowElement,\s*scrollTableIntoView\s*\}\)/);
  assert.match(orchestrator, /async\s+function\s+refreshHome[\s\S]*tab\.error\s*=\s*""/);
  assert.match(home, /defineExpose\(\{[\s\S]*copySelection[\s\S]*pasteTables[\s\S]*\}\)/);
  assert.match(pane, /function\s+copyHomeSelection/);
  assert.match(pane, /function\s+pasteHomeTables/);
  assert.match(pane, /copyHomeSelection,/);
  assert.match(pane, /pasteHomeTables,/);
  assert.match(clearHomepageSelection, /controller\.clearSelection\(\)/);
  assert.doesNotMatch(clearHomepageSelection, /controller\.cancelRename\(\)/);
  assert.match(beginHomepageBoxSelection, /if\s*\(props\.renamingName\)\s*\{[\s\S]*renameInputRef\.value\?\.blur\?\.\(\);[\s\S]*return;[\s\S]*\}/);
  assert.match(tableList, /class="wb-dbhome-table-header"/);
  assert.match(tableList, /class="wb-dbhome-header-cell/);
  assert.match(tableList, /@pointerdown\.stop\.prevent="beginColumnResize/);
  assert.match(tableList, /@click="handleHeaderClick/);
  assert.match(tableList, /suppressHeaderClick/);
  assert.match(tableList, /boxSelectedNames/);
  assert.match(tableList, /updateBoxSelectionPreview/);
  assert.match(tableList, /'is-box-selected':\s*boxSelectedSet\.has\(tableName\(table\)\)/);
  assert.match(tableList, /:aria-selected="renderedSelectedSet\.has\(tableName\(table\)\) \? 'true' : 'false'"/);
  assert.match(tableList, /class="wb-dbhome-object-name-button"/);
  assert.match(tableList, /class="wb-dbhome-object-comment-text"/);
  assert.match(tableList, /class="wb-dbhome-object-name-button"[\s\S]*role="option"/);
  assert.match(tableList, /"visible-tables"/);
  assert.match(tableList, /visibleRows\.value\.map/);
  assert.match(home, /tableSourceContext/);
  assert.match(home, /@visible-tables="emit\('visible-tables', \{ \.\.\.tableSourceContext, tableNames: \$event \}\)"/);
  assert.doesNotMatch(tableList, /<button[^>]*class="wb-dbhome-object-row"/);
  assert.match(tableList, /wb-dbhome-selection-box/);
  assert.doesNotMatch(home, /props\.tab\.statusText\s*=\s*statusText\.value/);

  assert.match(splitLayout, /@open-home-table=/);
  assert.match(splitLayout, /@home-visible-tables=/);
  assert.match(splitLayout, /@paste-home-tables=/);
  assert.match(splitLayout, /@delete-home-tables=/);
  assert.match(splitLayout, /@send-home-tables="emit\('send-home-tables', \$event\)"/);
  assert.match(orchestrator, /@send-home-tables="sendHomeTables"/);
  assert.match(orchestrator, /function\s+sendHomeTables\(source = \{\}\)[\s\S]*tableCopy\.open\(\{[\s\S]*tableNames,[\s\S]*\}\)/);
  assert.match(home, /function\s+sendSelection\(\)[\s\S]*emit\("send-tables", \{[\s\S]*tableNames: \[\.\.\.menu\.selectedNames\]/);
  assert.match(home, /@click="sendSelection"><Send :size="14" class="wb-context-icon"[^>]*\/>发送到…/);
  assert.match(home, /function\s+editTableComment\(/);
  assert.match(home, /emit\("edit-table-comment", tablePayload\(name\)\)/);
  assert.match(home, /@click="editTableComment\(menu\.tableName\)"[\s\S]*?t\('home\.editTableComment'\)/);
  assert.match(pane, /@edit-table-comment="emit\('edit-home-table-comment'/);
  assert.match(splitLayout, /@edit-home-table-comment="emit\('edit-home-table-comment'/);
  assert.match(orchestrator, /function\s+openHomeTableCommentEdit/);
  assert.match(orchestrator, /@edit-home-table-comment="openHomeTableCommentEdit"/);
  assert.match(splitLayout, /@batch-export=/);
  assert.match(splitLayout, /@batch-import=/);

  assert.match(tabs, /tabKind\(tab\) === ['"]home['"]/);
  assert.match(tabs, /if\s*\(tabKind\(tab\) === ["']home["']\)\s*return ["']首页["']/);
  assert.match(tabs, /function\s+canCloseTab/);
  assert.match(tabs, /v-if="canCloseTab\(tab\)"/);

  assert.match(orchestrator, /openDatabaseHomeTab/);
  assert.match(orchestrator, /closeTableObjectTabs/);
  assert.match(orchestrator, /homeTableClipboard/);
  assert.match(orchestrator, /databaseLabel,/);
  assert.match(orchestrator, /:database-label="databaseLabel"/);
  assert.match(orchestrator, /function\s+openCurrentDatabaseHome/);
  assert.match(orchestrator, /function\s+ensureCurrentDatabaseHome/);
  assert.match(orchestrator, /function\s+loadVisibleHomeTableCounts/);
  assert.match(orchestrator, /payload\?\.tableNames/);
  assert.match(orchestrator, /payload\?\.connectionId/);
  assert.match(orchestrator, /payload\?\.database/);
  assert.match(orchestrator, /ensureTableSchema\(item\.tableName,\s*\{\s*connectionId,\s*database\s*\}\)/);
  assert.match(orchestrator, /ensureTableSchema:\s*conn\.ensureTableSchema/);
  assert.match(orchestrator, /const\s+activate\s*=\s*!workspace\.activeTabId/);
  assert.match(orchestrator, /await\s+ensureCurrentDatabaseHome\(\)/);
  assert.match(orchestrator, /await\s+openDatabaseHomeTarget\(event\)/);
  assert.match(orchestrator, /async function openDatabaseHomeTarget/);
  assert.match(orchestrator, /targetDatabase\s*!==\s*String\(selectedDatabase\.value\)[\s\S]*?await selectDatabase\(\{ connectionId: targetConnectionId, database: targetDatabase \}\)/);
  assert.match(orchestrator, /const openedHome = openCurrentDatabaseHome\(\{ paneId: targetPaneId, activate: true \}\)/);
  assert.match(orchestrator, /function\s+pasteHomeTables/);
  assert.match(orchestrator, /invokeWorkbench\(["']copy_tables["']/);
  assert.match(orchestrator, /function\s+copyHomeTables[\s\S]*showWorkbenchReminder\("success", message\)/);
  assert.match(orchestrator, /function\s+pasteHomeTables[\s\S]*onSuccess\?\.\(createdNames\)[\s\S]*showWorkbenchReminder\("success", `已粘贴/);
  assert.match(
    orchestrator,
    /function\s+pasteHomeTables[\s\S]*?sourceConnectionId:\s*source\.connectionId,[\s\S]*?targetConnectionId,[\s\S]*?targetDatabase,/,
  );
  assert.match(orchestrator, /function\s+handleGlobalHomeClipboardKeydown/);
  assert.match(orchestrator, /activeTab\.value\?\.kind\s*!==\s*["']home["']/);
  assert.match(orchestrator, /isEditableShortcutTarget\(event\.target\)/);
  assert.match(orchestrator, /focusedPaneState\.copyHomeSelection\?\.\(\)/);
  assert.match(orchestrator, /focusedPaneState\.pasteHomeTables\?\.\(\)/);
  assert.match(orchestrator, /if\s*\(handleGlobalHomeClipboardKeydown\(event\)\)\s*return/);
  assert.match(orchestrator, /function\s+deleteHomeTables/);
  assert.match(
    orchestrator,
    /invokeWorkbench\(["']drop_tables["'],\s*\{\s*request:\s*\{[\s\S]*?connectionId:\s*source\.connectionId,[\s\S]*?database:\s*source\.database,[\s\S]*?tables:\s*batch\s*[,}]/,
  );
});

test("homepage blank-area context menu does not bubble to the workbench menu", () => {
  const tableList = read("./components/DatabaseTableList.vue");

  assert.match(tableList, /@contextmenu\.prevent\.stop="emit\('blank-contextmenu', \$event\)"/);
});

test("homepage table paste waits for the requested database to become committed", () => {
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(orchestrator, /createHomeTablePasteCoordinator/);
  assert.match(
    orchestrator,
    /const\s+selectDatabaseWithHome\s*=\s*async\s*\(event\)\s*=>\s*\{[\s\S]*?openDatabaseHomeTarget\(event\)/,
  );
  assert.match(
    orchestrator,
    /async function openDatabaseHomeTarget[\s\S]*?homeTablePasteCoordinator\.trackNavigation/,
  );
  assert.match(
    orchestrator,
    /async function pasteHomeTables[\s\S]*?homeTablePasteCoordinator\.runWhenReady/,
  );
  assert.match(orchestrator, /目标数据库尚未就绪，未执行粘贴/);
});

test("homepage object shortcuts preserve native clipboard behavior in editable fields", () => {
  const home = read("./components/DatabaseHome.vue");
  const handleKeydown = home.match(/function\s+handleHomeKeydown\(event\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(home, /function\s+isEditableTypeaheadTarget\(target\)/);
  assert.match(handleKeydown, /if\s*\(isEditableTypeaheadTarget\(event\.target\)\)\s*return;/);
  // Rename, search and other inputs keep their own Delete, F2 and Enter keys.
  assert.match(home, /function isHomeListCommandTarget\(target\)\s*\{[\s\S]*?closest\?\.\("button, input, textarea, select, a"\)/);
});

test("focused panes republish their current shortcut handlers after a split-pane focus change", () => {
  const pane = read("./components/WorkbenchPane.vue");

  assert.match(
    pane,
    /watch\(\s*\(\)\s*=>\s*props\.isFocused,\s*\(focused\)\s*=>\s*\{[\s\S]*?if\s*\(focused\)\s*emitPaneState\(\)/
  );
});

test("table design editor exposes SQL preview and explicit ALTER TABLE confirmation", () => {
  const editor = read("./components/TableDesignEditor.vue");
  const saveButton = editor.match(/<button[^>]*class="wb-design-primary"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  const confirmButton = editor.match(/<button[^>]*class="wb-design-danger"[\s\S]*?>执行 ALTER TABLE<\/button>/)?.[0] || "";

  assert.match(editor, /useTableDesign/);
  assert.match(editor, /previewDesign/);
  assert.match(editor, /applyDesign/);
  assert.match(editor, /function\s+handleSave/);
  assert.match(editor, /function\s+handleConfirmApply/);
  assert.match(editor, /SQL\s*预览/);
  assert.match(editor, /执行 ALTER TABLE/);
  assert.match(saveButton, /@click="handleSave"/);
  assert.doesNotMatch(saveButton, /@click="handlePreview"/);
  assert.match(confirmButton, /@click="handleConfirmApply"/);
  assert.doesNotMatch(confirmButton, /@click="handleSave"/);
  assert.match(editor, /wb-design-grid/);
  assert.match(editor, /defaultMode/);
  assert.match(editor, /tableComment/);
  assert.match(editor, /正在检查字段数据/);
  assert.match(editor, /取消字段检查/);
  assert.match(editor, /严格模式下检查现有字段值/);
  assert.match(editor, /发现无法转换的字段值/);
});

test("table design uses numbered key icons instead of primary-key checkboxes", () => {
  const editor = read("./components/TableDesignEditor.vue");
  const primaryKeyCell = editor.match(/<!-- 主键 -->[\s\S]*?<\/td>/)?.[0] || "";

  assert.match(editor, /import\s*\{[^}]*KeyRound[^}]*\}\s*from\s*["']lucide-vue-next["']/);
  assert.match(primaryKeyCell, /class="wb-design-primary-key-toggle"/);
  assert.match(primaryKeyCell, /<KeyRound\s+v-if="column\.primaryKey"/);
  assert.match(primaryKeyCell, /<Plus\s+v-else\s+class="wb-design-primary-key-add"/);
  assert.match(primaryKeyCell, /:aria-pressed="column\.primaryKey"/);
  assert.match(primaryKeyCell, /column\.primaryKeyOrdinal/);
  assert.match(primaryKeyCell, /@click="togglePrimaryKey\(column\)"/);
  assert.doesNotMatch(primaryKeyCell, /type="checkbox"/);
});

test("table design copies selected fields and pastes them as new columns", () => {
  const editor = read("./components/TableDesignEditor.vue");
  const styles = read("./workbench.css");

  assert.match(editor, /snapshotColumns/);
  assert.match(editor, /pasteColumns/);
  assert.match(editor, /function\s+copySelectedColumns/);
  assert.match(editor, /function\s+pasteCopiedColumns/);
  assert.match(editor, /hasEditableTextSelection/);
  assert.match(editor, /function\s+shouldHandleClipboardShortcut/);
  assert.match(editor, /document\.addEventListener\("copy",\s*onCopy,\s*true\)/);
  assert.match(editor, /document\.addEventListener\("paste",\s*onPaste,\s*true\)/);
  assert.match(editor, /key === "c"/);
  assert.match(editor, /key === "v"/);
  assert.match(editor, /wb-design-select-cell/);
  assert.match(editor, /is-selected/);
  assert.match(editor, /serializeTableDesignColumns/);
  assert.match(editor, /resolveTableDesignClipboard/);
  assert.match(editor, /if\s*\(hasEditableTextSelection\([^)]*\)\)\s*return/);
  assert.match(editor, /function\s+clearRowSelection/);
  assert.match(editor, /watch\(sourceKey,\s*\(\)\s*=>\s*\{[\s\S]*clearRowSelection\(\)/);
  assert.match(editor, /editorRef\.value\?\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(editor, /class="wb-design-toast-layer"/);
  assert.match(editor, /class="wb-save-reminder is-success"/);
  assert.doesNotMatch(editor, /wb-design-success/);
  assert.doesNotMatch(editor, /@copy="onCopy"/);
  assert.doesNotMatch(editor, /@paste="onPaste"/);
  assert.match(styles, /\.wb-design-toast-layer\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.wb-design-toast-layer\s*\{[^}]*pointer-events:\s*none/s);
  assert.doesNotMatch(styles, /\.wb-design-success\s*\{/);
});

test("table design row reordering starts only from the drag handle", () => {
  const editor = read("./components/TableDesignEditor.vue");
  const fieldRowTag = editor.match(/<tr\s+v-for="\(column, index\) in draft\.columns"[\s\S]*?>/)?.[0] || "";
  const dragHandleTag = editor.match(/<span\s+class="wb-design-drag-handle"[\s\S]*?>/)?.[0] || "";

  assert.doesNotMatch(fieldRowTag, /draggable=/);
  assert.doesNotMatch(fieldRowTag, /@dragstart=/);
  assert.match(fieldRowTag, /@dragover="onDragOver\(index, \$event\)"/);
  assert.match(dragHandleTag, /draggable="true"/);
  assert.match(dragHandleTag, /@dragstart\.stop="onDragStart\(index, \$event\)"/);
  assert.match(dragHandleTag, /@dragend="onDragEnd"/);
});

test("connection dialog exposes MySQL, ClickHouse, and MongoDB connection kinds", () => {
  const dialog = read("./components/ConnectionDialog.vue");
  const connection = read("./composables/useConnection.js");
  const kinds = read("./utils/connectionKinds.js");

  assert.match(dialog, /v-model="dialog\.kind"/);
  assert.match(dialog, /MySQL/);
  assert.match(dialog, /ClickHouse/);
  assert.match(dialog, /MongoDB/);
  assert.match(connection, /buildConnectionUrl/);
  assert.match(kinds, /kind:\s*["']clickhouse["']/);
  assert.match(kinds, /kind:\s*["']mongodb["']/);
  assert.match(connection, /readOnly/);
});

test("sidebar table rows preserve table-name width before showing optional comments", () => {
  const styles = read("./workbench.css");
  const copyRule = styles.match(/\.wb-table-copy\s*\{([^}]*)\}/s)?.[1] || "";
  const commentRule = styles.match(/(?:^|\r?\n)\.wb-table-comment\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(copyRule, /display:\s*block/);
  assert.match(copyRule, /overflow:\s*hidden/);
  assert.match(copyRule, /text-overflow:\s*ellipsis/);
  assert.match(copyRule, /white-space:\s*nowrap/);
  assert.match(commentRule, /margin-left:\s*7px/);
  assert.match(commentRule, /font-size:\s*var\(--wb-fs-body\)/);
  assert.match(commentRule, /line-height:\s*1\.45/);
  assert.doesNotMatch(styles, /\.wb-table-copy\.has-comment\s+\.wb-table-name\s*\{[^}]*max-width:/s);
});

test("sidebar table rows prevent accidental text selection without disabling the whole tree", () => {
  const styles = read("./workbench.css");
  const tableItemRule = cssRuleBody(styles, ".wb-table-item");
  const sourceTreeRule = cssRuleBody(styles, ".wb-source-tree");

  assert.match(tableItemRule, /user-select:\s*none/);
  assert.doesNotMatch(sourceTreeRule, /user-select:\s*none/);
});

test("sidebar table branch sizes dynamically and animates database switches", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const styles = read("./workbench.css");
  const sourceTreeRule = cssRuleBody(styles, ".wb-source-tree");
  const tableBranchMotionRule = cssRuleBody(
    styles,
    ".wb-table-branch.wb-branch-enter-active, .wb-table-branch.wb-branch-leave-active",
  );
  const tableBranchCollapsedRule = cssRuleBody(
    styles,
    ".wb-table-branch.wb-branch-enter-from, .wb-table-branch.wb-branch-leave-to",
  );
  const tableScrollRule = cssRuleBody(styles, ".wb-table-scroll");

  assert.match(sidebar, /computeTableBranchMinHeight/);
  assert.match(sidebar, /--wb-tree-table-min-h.*tableBranchMinHeight/);
  assert.match(sourceTreeRule, /--wb-tree-table-min-h:\s*600px/);
  assert.match(styles, /--wb-tree-table-min-h,\s*600px/);
  assert.doesNotMatch(
    styles,
    /\.wb-source-database\.is-expanded\s*\{[^}]*min-height:\s*calc\(var\(--wb-tree-database-h/s,
  );
  assert.match(tableBranchMotionRule, /min-height:\s*var\(--wb-tree-table-min-h/);
  assert.match(tableBranchMotionRule, /transition:[^}]*min-height/s);
  assert.match(tableBranchCollapsedRule, /min-height:\s*0/);
  assert.match(tableScrollRule, /flex:\s*1 1 0/);
  assert.match(tableScrollRule, /height:\s*0/);
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
  assert.match(sidebar, /:ref="setTableScrollElement"/);
  assert.match(sidebar, /:ref="setTableListElement"/);
  assert.match(sidebar, /class="wb-branch-inner wb-table-scroll"/);
  assert.match(sidebar, /scrollContainerRef:\s*tableScrollRef/);
  assert.match(sidebar, /revealSelectedDatabase/);
  assert.match(sidebar, /SidebarSearchPanel/);
  assert.match(styles, /\.wb-table-scroll\s*\{/);
  assert.doesNotMatch(sidebar, /browserColumnsRef|navTreeStyle|startBrowserResize|wb-browser-split-divider|wb-table-column/);
  assert.doesNotMatch(styles, /\.wb-browser-split-divider|\.wb-table-column/);
});

test("table copy dialog uses a flat table list with target selection in the header", () => {
  const dialog = read("./components/TableCopyDialog.vue");
  const selectionPanel = read("./components/TableCopySelectionPanel.vue");
  const header = dialog.match(/<header[^>]*class="[^"]*wb-dialog-header[^"]*"[\s\S]*?<\/header>/)?.[0] || "";

  assert.doesNotMatch(dialog, /发送表结构/);
  assert.doesNotMatch(dialog, /全部展开|全部折叠/);
  assert.doesNotMatch(dialog, /wb-table-copy-group-header|wb-table-copy-chevron|collapsedGroups|tableGroups/);
  assert.match(dialog, /filteredTables/);
  assert.match(dialog, /visibleRows/);
  assert.match(dialog, /@scroll\.passive="onScroll"/);
  assert.doesNotMatch(dialog, /addEventListener\("scroll"|removeEventListener\("scroll"/);
  assert.match(header, /<h2>发送表<\/h2>/);
  assert.match(header, /aria-label="关闭发送窗口"/);
  assert.match(dialog, /aria-label="目标连接"/);
  assert.match(dialog, /aria-label="目标数据库"[\s\S]*请选择目标数据库/);
  assert.doesNotMatch(dialog, /wb-table-copy-connection-field/);
  assert.match(dialog, /rowCount/);
  assert.match(dialog, /resultWarnings/);
  assert.match(dialog, /TableCopySelectionPanel/);
  assert.match(dialog, /:tables="selectedTables"/);
  assert.match(dialog, /:indeterminate="selectionIsPartial"/);
  assert.match(dialog, /CONFIRM_TABLE_PREVIEW_LIMIT/);
  assert.match(dialog, /confirmationTableNames\(\)/);
  assert.match(dialog, /role="radiogroup" aria-label="发送模式"/);
  assert.match(dialog, /value="overwrite"/);
  assert.match(dialog, /覆盖发送所选表/);
  assert.match(dialog, /danger: isOverwriteMode\.value/);
  assert.match(selectionPanel, /aria-label="当前已选择的表"/);
  assert.match(selectionPanel, /visibleRows/);
  assert.match(selectionPanel, /@scroll\.passive="onScroll"/);
  assert.match(selectionPanel, /@click="emit\('remove', table\.name\)"/);
});

test("batch transfer dialogs expose workbook and per-table Excel modes", () => {
  const exportDialog = read("./components/BatchExportDialog.vue");
  const importDialog = read("./components/BatchImportDialog.vue");
  const transfer = read("./composables/useBatchTransfer.js");
  const mock = read("./mock/mockBackend.js");
  const commands = read("../../src-tauri/src/commands.rs");
  const lib = read("../../src-tauri/src/lib.rs");

  assert.match(exportDialog, /role="radiogroup" aria-label="[^"]*导出模式"/);
  assert.match(exportDialog, /setBatchExportMode/);
  assert.match(exportDialog, /batch\.mode === "separate"/);
  assert.match(importDialog, /role="radiogroup" aria-label="[^"]*导入模式"/);
  assert.match(importDialog, /setBatchImportMode/);
  assert.match(importDialog, /:multiple="batch\.mode === 'separate'"/);
  assert.match(importDialog, /filePrompt/);
  assert.match(transfer, /save_export_files/);
  assert.match(transfer, /loadBatchImportFiles/);
  assert.match(mock, /command === "save_export_files"/);
  assert.match(commands, /pub async fn save_export_files/);
  assert.match(lib, /commands::save_export_files/);
});

test("batch import dialog exposes error log export only when errors exist", () => {
  const dialog = read("./components/BatchImportDialog.vue");

  assert.match(dialog, /v-if="batch\.progress\.errors\.length"[^>]*>[\s\S]*?导出错误日志/);
  assert.match(dialog, /:disabled="isBusy"[^>]*@click="transfer\.exportBatchImportErrors\(\)"/);
});

test("batch import dialog exposes cancellable import states", () => {
  const dialog = read("./components/BatchImportDialog.vue");

  assert.match(dialog, /transfer\.cancelBatchImport\(\)/);
  assert.match(dialog, /取消导入/);
  assert.match(dialog, /正在取消…/);
});

test("batch import exposes a cancellable read-only change comparison", () => {
  const dialog = read("./components/BatchImportDialog.vue");
  const comparison = read("./components/BatchImportComparison.vue");
  const diffGrid = read("./components/BatchImportDiffGrid.vue");
  const transfer = read("./composables/useBatchTransfer.js");
  const types = read("../../src-tauri/src/types.rs");

  assert.match(dialog, /BatchImportComparison/);
  assert.match(dialog, /transfer\.compareBatchImportChanges\(\)/);
  assert.match(dialog, /transfer\.cancelBatchImportComparison\(\)/);
  assert.match(dialog, /对比变化/);
  assert.match(comparison, /预计新增/);
  assert.match(comparison, /对比已取消，仅显示已完成部分/);
  assert.match(comparison, /BatchImportDiffGrid/);
  assert.match(diffGrid, /row\.after/);
  assert.match(diffGrid, /row\.before/);
  assert.match(diffGrid, /formatValue/);
  assert.match(comparison, /role="tablist" aria-label="变化类型"/);
  assert.match(transfer, /previewOnly:\s*true/);
  assert.match(types, /pub preview_only:\s*bool/);
});

test("table comparison supports complete rows, primary-key visibility, fullscreen, and shared column widths", () => {
  const batchDialog = read("./components/BatchImportDialog.vue");
  const importDialog = read("./components/ImportWizardDialog.vue");
  const comparison = read("./components/BatchImportComparison.vue");
  const diffGrid = read("./components/BatchImportDiffGrid.vue");
  const styles = read("./workbench.css");
  const fullRows = read("./composables/useBatchComparisonFullRows.js");
  const types = read("../../src-tauri/src/types.rs");

  assert.match(comparison, /全部行/);
  assert.match(comparison, /只看差别/);
  assert.match(comparison, /显示主键/);
  assert.match(comparison, /<Teleport to="body"/);
  assert.match(comparison, /fullscreen-change/);
  assert.match(comparison, /toggleTableFullscreen/);
  assert.match(comparison, /全屏查看此表/);
  assert.match(comparison, /返回全部表/);
  assert.match(comparison, /is-table-stage/);
  assert.match(comparison, /wb-batch-diff-section-expand/);
  assert.match(styles, /\.wb-batch-comparison\.is-table-stage\s*\{/s);
  assert.match(styles, /\.wb-table-stage-bar\s*\{/s);
  assert.match(styles, /\.wb-batch-diff-section-expand\s*\{/s);
  assert.match(comparison, /inject\(["']theme["']/);
  assert.match(comparison, /wb-floating-themed/);
  assert.match(comparison, /:data-theme="isFullscreen \? theme : undefined"/);
  assert.match(styles, /\.wb-batch-comparison\.is-fullscreen\s*\{[^}]*background:\s*var\(--wb-dialog-surface\)/s);
  assert.match(styles, /\.wb-batch-comparison\.is-fullscreen\s*\{[^}]*color:\s*var\(--wb-text\)/s);
  assert.match(styles, /\.wb-batch-comparison\.is-fullscreen,\s*\n\.wb-batch-comparison\.is-table-stage\s*\{[^}]*top:\s*var\(--wb-titlebar-height\)/s);
  assert.match(comparison, /wb-table-stage-bar" data-tauri-drag-region/);
  assert.match(comparison, /:data-tauri-drag-region="isFullscreen \|\| undefined"/);
  assert.match(styles, /\.wb-batch-comparison\.is-table-stage \.wb-table-stage-bar[\s\S]*-webkit-app-region:\s*drag/);
  assert.match(styles, /\.wb-batch-comparison\.is-table-stage \.wb-table-stage-bar :is\([\s\S]*-webkit-app-region:\s*no-drag/);
  assert.match(batchDialog, /@fullscreen-change="comparisonFullscreen = \$event"/);
  assert.match(importDialog, /@fullscreen-change="comparisonFullscreen = \$event"/);
  assert.match(diffGrid, /showPrimaryKeys/);
  assert.match(diffGrid, /dbscout_batch_compare_widths_v1/);
  assert.match(diffGrid, /beginColumnResize/);
  assert.match(diffGrid, /autoFitColumn/);
  assert.match(diffGrid, /setPaneRef/);
  assert.match(diffGrid, /wb-batch-diff-status/);
  assert.match(fullRows, /open_table_session/);
  assert.match(fullRows, /fetch_table_page/);
  assert.match(types, /pub row_statuses:\s*Vec<String>/);
});

test("batch import dialog can be dragged to resize the window", () => {
  const dialog = read("./components/BatchImportDialog.vue");
  const styles = read("./workbench.css");
  const frame = read("./utils/batchImportDialogFrame.js");

  assert.match(dialog, /wb-batch-import-resize/);
  assert.match(dialog, /startResize\(\$event, handle\.edges\)/);
  assert.match(dialog, /is-user-sized/);
  assert.match(dialog, /resizeDialogFrame/);
  assert.match(frame, /export function resizeDialogFrame/);
  assert.match(styles, /\.wb-batch-import-resize\.is-e,\s*\n\.wb-batch-import-resize\.is-w\s*\{[^}]*cursor:\s*ew-resize/s);
  assert.match(styles, /\.wb-batch-import-resize\.is-n,\s*\n\.wb-batch-import-resize\.is-s\s*\{[^}]*cursor:\s*ns-resize/s);
  assert.match(styles, /\.wb-batch-import-resize\.is-se\s*\{[^}]*cursor:\s*nwse-resize/s);
  assert.match(styles, /\.wb-batch-import-dialog\.is-user-sized\.is-comparison-mode \.wb-batch-comparison\s*\{[^}]*min-height:\s*0/s);
});

test("batch import dialog can be dragged by its title to a new place", () => {
  const dialog = read("./components/BatchImportDialog.vue");
  const styles = read("./workbench.css");
  const frame = read("./utils/batchImportDialogFrame.js");

  assert.match(dialog, /@pointerdown="startMove"/);
  assert.match(dialog, /moveDialogFrame/);
  assert.match(dialog, /centerDialogFrame/);
  assert.match(frame, /export function moveDialogFrame/);
  assert.match(frame, /export function centerDialogFrame/);
  assert.match(styles, /\.wb-batch-import-dialog \.wb-dialog-header\s*\{[^}]*cursor:\s*grab/s);
  assert.match(styles, /\.wb-batch-import-dialog\.is-moving \.wb-dialog-header\s*\{[^}]*cursor:\s*grabbing/s);
});

test("table comparison panes can be dragged to resize left, right, and the detail band", () => {
  const comparison = read("./components/BatchImportComparison.vue");
  const diffGrid = read("./components/BatchImportDiffGrid.vue");
  const styles = read("./workbench.css");
  const split = read("./utils/comparisonPaneSplit.js");

  assert.match(comparison, /onTableNavResizerPointerDown/);
  assert.match(comparison, /wb-batch-comparison-table-resizer/);
  assert.match(comparison, /调整目标表列表宽度/);
  assert.match(comparison, /tableNavBodyStyle/);
  assert.match(diffGrid, /onPaneResizerPointerDown/);
  assert.match(diffGrid, /onDetailResizerMouseDown/);
  assert.match(diffGrid, /wb-batch-diff-pane-resizer/);
  assert.match(diffGrid, /wb-batch-diff-split-host/);
  assert.match(diffGrid, /调整左右对照栏宽度/);
  assert.match(diffGrid, /调整详情区高度/);
  assert.match(diffGrid, /splitGridStyle/);
  assert.match(split, /dbscout_batch_compare_pane_ratio_v1/);
  assert.match(split, /dbscout_batch_compare_detail_height_v1/);
  assert.match(split, /dbscout_batch_compare_table_nav_width_v1/);
  assert.match(styles, /\.wb-batch-comparison-table-resizer\s*\{[^}]*cursor:\s*col-resize/s);
  assert.match(styles, /\.wb-batch-diff-pane-resizer\s*\{[^}]*cursor:\s*col-resize/s);
  assert.match(styles, /\.wb-batch-diff-detail-resizer\s*\{[^}]*cursor:\s*row-resize/s);
  assert.match(styles, /\.wb-batch-diff-split-host\s*\{[^}]*position:\s*relative/s);
});

test("table comparison cells can be moved with arrow keys", () => {
  const diffGrid = read("./components/BatchImportDiffGrid.vue");
  const nav = read("./utils/comparisonCellNavigation.js");

  assert.match(diffGrid, /moveComparisonCell/);
  assert.match(diffGrid, /shouldHandleComparisonCellNavigation/);
  assert.match(diffGrid, /comparisonArrowDelta/);
  assert.match(diffGrid, /window\.addEventListener\("keydown",\s*onComparisonKeydown/);
  assert.match(diffGrid, /点击单元格或按方向键/);
  assert.match(nav, /export function moveComparisonCell/);
  assert.match(nav, /status !== ["']error["']/);
});

test("arrow-key comparison does not draw a window-edge focus ring", () => {
  const styles = read("./workbench.css");
  assert.match(
    styles,
    /html,\s*body,\s*#app\s*\{[^}]*outline:\s*none/s,
    "viewport shells must not show the UA focus ring",
  );
  assert.match(
    styles,
    /\.wb-dialog-overlay\s*\{[^}]*outline:\s*none/s,
    "the full-window overlay must not show the UA focus ring",
  );
  assert.match(
    styles,
    /\.wb-dialog\s*\{[^}]*outline:\s*none/s,
    "dialog focus traps must not show the UA focus ring",
  );
  assert.match(
    styles,
    /\.wb-batch-diff-main\s*\{[^}]*outline:\s*none/s,
    "comparison scroll panes must not show the UA focus ring",
  );
});

test("table comparison search mirrors the regular table search controls and navigation", () => {
  const comparison = read("./components/BatchImportComparison.vue");
  const diffGrid = read("./components/BatchImportDiffGrid.vue");
  const css = read("./workbench.css");
  const search = read("./composables/useBatchComparisonSearch.js");

  assert.match(comparison, /:placeholder="isTableStage \? '搜索此表' : '搜索当前表'"/);
  assert.match(comparison, /精确/);
  assert.match(comparison, /连续/);
  assert.match(comparison, /模糊/);
  assert.match(comparison, /aria-label="上一个匹配"/);
  assert.match(comparison, /aria-label="下一个匹配"/);
  assert.match(comparison, /searchHitSummary\.label/);
  assert.match(comparison, /ensureCurrentSearchScopeComplete/);
  assert.match(comparison, /menu-class="wb-batch-comparison-search-menu"/);
  assert.match(css, /\.wb-toolbar-action-menu\.wb-batch-comparison-search-menu\s*\{[^}]*z-index:\s*520/s);
  assert.match(comparison, /function onSearchShortcut[\s\S]*?stopImmediatePropagation\(\)/);
  assert.match(diffGrid, /activeSearchMatch/);
  assert.match(diffGrid, /highlightSearchText/);
  assert.match(diffGrid, /scrollToSearchMatch/);
  assert.match(search, /matchSearchText/);
  assert.match(search, /showPrimaryKeys/);
});

test("batch import comparison view does not repeat the leftover import result summary", () => {
  const dialog = read("./components/BatchImportDialog.vue");
  const styles = read("./workbench.css");
  const hideChrome = styles.match(
    /\.wb-dialog\.is-comparison-mode \.wb-batch-mode-switch,[\s\S]*?\{[^}]*\}/,
  )?.[0] || "";

  assert.match(dialog, /wb-batch-import-summary/);
  assert.match(hideChrome, /\.wb-dialog\.is-comparison-mode \.wb-batch-import-summary/);
  assert.match(hideChrome, /display:\s*none/);
});

test("batch import always uses guarded full-table sync without a mode toggle", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dialog = read("./components/BatchImportDialog.vue");
  const comparison = read("./components/BatchImportComparison.vue");
  const diffGrid = read("./components/BatchImportDiffGrid.vue");
  const transfer = read("./composables/useBatchTransfer.js");

  assert.doesNotMatch(dialog, /同步为 Excel 完整内容/);
  assert.doesNotMatch(dialog, /setBatchImportDeleteMissingRows|deleteMissingRows/);
  assert.match(dialog, /开始同步/);
  assert.match(comparison, /预计删除/);
  assert.match(diffGrid, /row\.status === ["']deleted["']/);
  assert.doesNotMatch(transfer, /setBatchImportDeleteMissingRows|deleteMissingRows/);
  assert.doesNotMatch(transfer, /invokeWorkbench\("import_rows"/);
  assert.match(transfer, /invokeWorkbench\("replace_table_rows"/);
  assert.match(transfer, /requireXlsxBackup:\s*true/);
  assert.match(orchestrator, /title:\s*"覆盖同步导入"/);
  assert.match(orchestrator, /danger:\s*true/);
});

test("import wizard assumes the first row is the header without a redundant toggle", () => {
  const dialog = read("./components/ImportWizardDialog.vue");
  const stepTwo = dialog.match(/<!-- Step 2:[\s\S]*?<!-- Step 3:/)?.[0] || "";

  assert.ok(stepTwo, "Expected import wizard preview step to exist");
  assert.doesNotMatch(stepTwo, /type="checkbox"/);
  assert.doesNotMatch(stepTwo, /v-model="wizard\.headerRow"/);
  assert.doesNotMatch(stepTwo, /首行作为列标题/);
  assert.match(stepTwo, /<thead>/);
  assert.doesNotMatch(stepTwo, /<thead\s+v-if="wizard\.headerRow"/);
  assert.match(stepTwo, /wizard\.rawRows\.slice\(1,\s*21\)/);
});

test("import wizard renders row-level failure reasons", () => {
  const dialog = read("./components/ImportWizardDialog.vue");

  assert.match(dialog, /class="wb-import-error-details"/);
  assert.match(dialog, /wizard\.progress\.errors\.slice\(0,\s*8\)/);
  assert.match(dialog, /error\.row/);
  assert.match(dialog, /error\.columnName/);
  assert.match(dialog, /function\s+importErrorText\(error\)/);
  assert.match(dialog, /importErrorText\(error\)/);
  assert.match(dialog, /wizard\.progress\.errors\.length\s*>\s*8/);
});

test("import wizard makes whole-table replacement explicit and reports its outcome", () => {
  const dialog = read("./components/ImportWizardDialog.vue");

  assert.match(dialog, /整表覆盖：目标表中不在该文件里的数据将被删除/);
  assert.match(dialog, /wizard\.progress\.inserted/);
  assert.match(dialog, /wizard\.progress\.updated/);
  assert.match(dialog, /wizard\.progress\.deleted/);
  assert.match(dialog, /wizard\.progress\.unchanged/);
  assert.match(dialog, /正在原子覆盖/);
});

test("sidebar search panel shows schema and value result groups", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const panel = read("./components/SidebarSearchPanel.vue");
  const styles = read("./workbench.css");

  assert.match(sidebar, /import\s+SidebarSearchPanel\s+from\s+["']\.\/SidebarSearchPanel\.vue["']/);
  assert.match(sidebar, /<SidebarSearchPanel/);
  assert.match(panel, /搜索表、备注、字段；Ctrl\+Enter 搜索值/);
  assert.match(panel, /autocomplete="off"/);
  assert.match(panel, /aria-label="搜索历史"/);
  assert.match(panel, /wb-sidebar-search-history-delete/);
  assert.match(panel, /sidebarSearchHistory/);
  assert.doesNotMatch(panel, /清空历史/);
  assert.doesNotMatch(panel, /最近 \{\{ historyItems\.length \}\} 条/);
  assert.match(panel, /wb-table-search-clear/);
  assert.match(panel, /clearQuery/);
  assert.match(panel, /has-query/);
  assert.match(styles, /\.wb-sidebar-search-history/);
  assert.match(panel, /结构结果/);
  assert.match(panel, /值结果/);
  assert.match(panel, /matchKindLabel/);
  assert.match(panel, /import\s+SearchHitBadge\s+from\s+["']\.\/SearchHitBadge\.vue["']/);
  assert.match(panel, /<SearchHitBadge\s+:kind="result\.matchKind"/);
  assert.match(panel, /<SearchHitBadge\s+kind="value"/);
  assert.match(panel, /按 Ctrl\+Enter 搜索具体值/);
  assert.match(panel, /至少 1 处/);
  assert.match(panel, /search-values/);
  assert.match(panel, /cancel-search-values/);
  assert.match(panel, /open-schema-result/);
  assert.match(panel, /open-value-result/);
  assert.match(styles, /\.wb-sidebar-search-panel/);
  assert.match(styles, /\.wb-search-result-group/);
  assert.match(styles, /\.wb-search-hit-badge/);
  assert.match(styles, /\.wb-search-hit-label/);
});

test("sidebar search input is not constrained by the result panel height", () => {
  const panel = read("./components/SidebarSearchPanel.vue");

  assert.match(panel, /<div\s+class="wb-table-search-wrap"[\s\S]*?<label\s+class="wb-table-search"[\s\S]*?<\/label>[\s\S]*?<\/div>\s*<section\s+class="wb-sidebar-search-panel"/);
  assert.doesNotMatch(panel, /<section\s+class="wb-sidebar-search-panel">\s*<div\s+class="wb-table-search-wrap"/);
});

test("readability copy pass uses explicit actions and localized ellipses", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const inspector = read("./components/InspectorPanel.vue");
  const cellDetail = read("./components/CellDetailPanel.vue");
  const connection = read("./components/ConnectionDialog.vue");
  const contextMenu = read("./components/ContextMenu.vue");
  const copyDialog = read("./components/TableCopyDialog.vue");
  const designEditor = read("./components/TableDesignEditor.vue");
  const sidebarPanel = read("./components/SidebarSearchPanel.vue");
  const updateDialog = read("./components/UpdateDialog.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const rowSelection = read("./composables/useRowSelection.js");

  assert.match(inspector, /class="wb-inspector-table-status"/);
  assert.match(inspector, /class="wb-inspector-table-source"/);
  assert.match(inspector, /class="wb-inspector-table-comment"/);
  assert.doesNotMatch(inspector, /class="wb-inspector-table-count"/);
  assert.match(inspector, /字段备注/);
  assert.doesNotMatch(inspector, /<strong>字段备注<\/strong>/);
  // The inspector no longer shows the current-cell identity chip. Selection
  // stats (average / count / sum) live on the cell-detail title bar instead.
  assert.doesNotMatch(inspector, /SelectedCellIdentity/);
  assert.doesNotMatch(inspector, /wb-inspector-cell-panel/);
  assert.doesNotMatch(cellDetail, /wb-inspector-cell-panel/);
  assert.doesNotMatch(cellDetail, /SelectedCellIdentity/);
  assert.match(cellDetail, /selectionStats/);
  assert.match(cellDetail, /class="wb-cell-detail-stats"/);
  const selectionStats = read("./utils/selectionStats.js");
  assert.match(selectionStats, /label: "平均值"/);
  assert.match(selectionStats, /label: "计数"/);
  assert.match(selectionStats, /label: "求和"/);
  assert.match(connection, /连接服务器/);
  assert.match(orchestrator, /重命名表/);
  assert.match(copyDialog, /发送所选表/);
  assert.match(designEditor, /保存备注/);
  assert.match(designEditor, /执行 ALTER TABLE/);
  assert.match(designEditor, /编辑字段备注/);
  assert.match(dataGrid, /class="wb-field-comment-text"[\s\S]*--wb-field-comment-lines/);
  assert.match(rowSelection, /grid\.deleteSelectedRowsTitle/);

  const legacyEllipsisCopy = /(搜索值|加载中|重命名中|连接中|覆盖同步|发送到|正在检查|正在加载|搜索表名|Markdown 格式)[^"'<>]*\.\.\./;
  for (const source of [orchestrator, dataGrid, contextMenu, copyDialog, designEditor, sidebarPanel, updateDialog, pane]) {
    assert.deepEqual(visibleTextSnippets(source), []);
    assert.doesNotMatch(source, legacyEllipsisCopy);
  }
  assert.doesNotMatch(designEditor, /⚠️|🚫|📋|📤|⛶|&#9974;/);
  assert.doesNotMatch(copyDialog, /⚠/);
  assert.doesNotMatch(orchestrator, />确认</);
  assert.doesNotMatch(designEditor, />确定</);
});

test("sidebar search panel keeps legacy filtered table inputs compatible", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");

  assert.match(sidebar, /createSidebarSearchState/);
  assert.match(sidebar, /filteredTables:\s*\{\s*type:\s*Array,\s*default:\s*\(\)\s*=>\s*\[\]\s*\}/);
  assert.match(sidebar, /sidebarSearchState:\s*\{\s*type:\s*Object,\s*default:\s*null\s*\}/);
  assert.match(sidebar, /const\s+fallbackSearchState\s*=\s*reactive\(createSidebarSearchState\(\)\)/);
  assert.match(sidebar, /const\s+effectiveSearchState\s*=\s*computed\(\(\)\s*=>\s*props\.sidebarSearchState\s*\|\|\s*fallbackSearchState\)/);
  assert.match(sidebar, /const\s+effectiveSchemaSearchResults\s*=\s*computed/);
  assert.match(sidebar, /props\.schemaSearchResults\.length\s*>\s*0/);
  assert.match(sidebar, /props\.filteredTables\.map\(\(table,\s*index\)\s*=>/);
  assert.match(sidebar, /table\.tableName\s*\|\|\s*table\.table_name\s*\|\|\s*index/);
  assert.match(sidebar, /key:\s*`table:\$\{props\.selectedConnectionId\}:\$\{props\.selectedDatabase\}:\$\{name\}:\$\{index\}`/);
  assert.match(sidebar, /visibleColumns:\s*\[\]/);
  assert.match(sidebar, /matchedColumns:\s*\[\]/);
  assert.match(sidebar, /hiddenColumnCount:\s*0/);
  assert.match(sidebar, /matchKind:\s*"none"/);
  assert.match(sidebar, /:connection-id="selectedConnectionId"/);
  assert.match(sidebar, /:database="database"/);
  assert.match(sidebar, /:schema-results="effectiveSchemaSearchResults"/);
  assert.match(sidebar, /:search-state="effectiveSearchState"/);
  assert.match(sidebar, /effectiveSchemaSearchResults\.value\.map\(\(result\)\s*=>\s*result\.table\)/);
  assert.match(sidebar, /function\s+openSchemaSearchResult\(result\)/);
  const openSchemaSearchResultBody =
    sidebar.match(/function\s+openSchemaSearchResult\(result\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(openSchemaSearchResultBody, /emit\(["']open-schema-result["'],\s*result\)/);
  assert.doesNotMatch(openSchemaSearchResultBody, /openSelectedTable/);
  assert.match(sidebar, /@open-schema-result="openSchemaSearchResult"/);
});

test("sidebar search supports keyboard selection and enter behavior", () => {
  const panel = read("./components/SidebarSearchPanel.vue");
  const styles = read("./workbench.css");

  assert.match(panel, /function\s+handleKeydown/);
  assert.match(panel, /ArrowDown/);
  assert.match(panel, /ArrowUp/);
  assert.match(panel, /Enter/);
  assert.match(panel, /ctrlKey/);
  assert.match(panel, /Escape/);
  assert.match(panel, /valueLoading/);
  assert.match(panel, /emit\(["']cancel-search-values["']\)/);
  assert.match(panel, /moveSidebarSearchSelection/);
  assert.match(panel, /emit\(["']search-values["']\)/);
  assert.match(panel, /activateItem/);
  assert.match(panel, /emit\(["']open-schema-result["']/);
  assert.match(panel, /emit\(["']open-value-result["']/);
  assert.match(panel, /keyboard-selected/);
  assert.match(panel, /aria-selected/);
  assert.match(styles, /\.wb-search-result\.keyboard-selected/);
});

test("sidebar search opens selected schema results on Enter and hides schema after value search", () => {
  const panel = read("./components/SidebarSearchPanel.vue");
  const state = read("./sidebarSearchState.js");

  assert.match(state, /selectionTouched/);
  assert.match(panel, /const\s+visibleSchemaResults\s*=/);
  assert.match(panel, /const\s+visibleValueResults\s*=/);
  assert.match(panel, /hasFreshValues\.value\s*\|\|\s*props\.searchState\.valueLoading/);
  assert.match(panel, /activateItem\(item\)/);
  assert.match(panel, /event\.ctrlKey/);
  assert.match(panel, /emit\("search-values"\)/);
  assert.match(panel, /v-if="hasQuery"\s*\n\s*type="button"\s*\n\s*class="wb-table-search-clear"/);
  assert.match(panel, /v-if="hasQuery && visibleSchemaResults\.length"/);
  assert.match(panel, /v-for="\(\s*result,\s*index\s*\)\s+in\s+visibleSchemaResults"/);
  assert.match(panel, /v-for="\(\s*result,\s*index\s*\)\s+in\s+visibleValueResults"/);
  assert.match(panel, /selectedIndex\s*===\s*index/);
});

test("workbench suppresses native context menus and keeps refresh menu scoped to table areas", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const inspector = read("./components/InspectorPanel.vue");
  const menu = read("./components/ContextMenu.vue");
  const tabs = read("./components/WorkbenchTabs.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /@contextmenu\.prevent="openGeneralContextMenu"/);
  assert.match(orchestrator, /function\s+openGeneralContextMenu/);
  assert.match(orchestrator, /function\s+openActiveTableContextMenu/);
  assert.match(orchestrator, /@contextmenu="openInspectorContextMenu"/);
  // "设为 NULL" is intentionally wired back via the context menu (#5), so the
  // orchestrator references setCellToNull / @set-null.
  assert.match(orchestrator, /@set-null|setCellToNull/);
  assert.match(sidebar, /@contextmenu\.prevent\.stop="emit\('contextmenu', \$event\)"/);
  assert.doesNotMatch(sidebar, /@contextmenu\.stop(?:\s|=)/);
  assert.match(grid, /@contextmenu\.prevent\.stop="emit\('contextmenu', \$event\)"/);
  assert.match(inspector, /@contextmenu\.prevent\.stop="emit\(["']contextmenu["'], \$event, selectedTextWithin\(inspectorRef\)\)"/);
  assert.match(tabs, /@contextmenu\.prevent\.stop="openTabContextMenu"/);
  assert.match(styles, /\.wb-titlebar-tabs[\s\S]*-webkit-app-region:\s*drag/);
  assert.match(styles, /\.wb-tab,[\s\S]*\.wb-tab \*[\s\S]*-webkit-app-region:\s*no-drag/);
  assert.match(menu, />刷新</);
  // "设为 NULL" context action is provided for nullable non-PK cells (#5);
  // "全部关闭" must not appear.
  assert.match(menu, /设为 NULL/);
  assert.match(menu, /canSetNull && surface === 'grid' && kind !== 'grid-row'/);
  assert.match(orchestrator, /contextMenu\.surface === "grid"[\s\S]*contextMenu\.anchorIndex[\s\S]*contextMenu\.targetColumnIndex/);
  assert.doesNotMatch(menu, /全部关闭/);
});

test("context menu limits freeze and table actions to the surface that was right-clicked", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const menu = read("./components/ContextMenu.vue");

  assert.match(orchestrator, /openContextMenu\(event,\s*table,\s*\{\s*surface:\s*["']sidebar["'],\s*tableNames:\s*table\?\.selectedTableNames\s*\}\)/);
  assert.match(orchestrator, /function\s+openInspectorContextMenu\(event,\s*selectedText\s*=\s*["']{2}\)[\s\S]*openContextMenu\(event,\s*focusedInspectorTab\.value,\s*\{[\s\S]*surface:\s*["']inspector["'][\s\S]*clipboardActions/);
  assert.match(orchestrator, /openContextMenu\(event,\s*targetTab,\s*\{[\s\S]*?surface:\s*["']grid["'][\s\S]*?clipboardActions/);
  assert.match(orchestrator, /@contextmenu="openInspectorContextMenu"/);
  assert.match(orchestrator, /:surface="contextMenu\.surface"/);

  assert.match(menu, /surface:\s*\{\s*type:\s*String,\s*default:\s*["']general["']\s*\}/);
  assert.match(menu, /showFreezeActions[\s\S]*props\.surface\s*===\s*["']grid["'][\s\S]*props\.kind\s*===\s*["']grid-row["']/);
  assert.match(menu, /showTableActions[\s\S]*props\.tableScoped[\s\S]*["']inspector["'][\s\S]*["']detail["'][\s\S]*includes\(props\.surface\)/);
  assert.match(menu, /<template\s+v-if="showFreezeActions">/);
  assert.match(menu, /v-if="showTableActions"[\s\S]*>表设计</);
});

test("inspector selected text exposes a copy action in the context menu", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const inspector = read("./components/InspectorPanel.vue");
  const menu = read("./components/ContextMenu.vue");

  assert.match(inspector, /function\s+selectedTextWithin\(element\)/);
  assert.match(inspector, /selection\.getRangeAt\(0\)\.intersectsNode\(element\)/);
  assert.match(inspector, /emit\('contextmenu',\s*\$event,\s*selectedTextWithin\(inspectorRef\)\)/);
  assert.match(orchestrator, /function\s+openInspectorContextMenu\(event,\s*selectedText\s*=\s*["']{2}\)/);
  assert.match(orchestrator, /const\s+hasSelectedText\s*=\s*Boolean\(text\.trim\(\)\)/);
  assert.match(orchestrator, /clipboardActions:\s*hasSelectedText[\s\S]*canCopy:\s*true[\s\S]*copy:\s*\(\)\s*=>\s*copyTextToClipboard\(text\)/);
  assert.match(menu, /<template\s+v-if="showClipboardActions">[\s\S]*>复制<kbd class="wb-context-shortcut" aria-hidden="true">\{\{ shortcutHints\.copy \}\}<\/kbd><\/button>/);
});

test("workbench wires table design entry points from keyboard and context menu", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const menu = read("./components/ContextMenu.vue");

  assert.match(orchestrator, /function\s+openTableDesign\(tableLike/);
  assert.match(orchestrator, /openTableDesignTab\(workspace,\s*\{[\s\S]*connectionId[\s\S]*database[\s\S]*tableName[\s\S]*tableComment[\s\S]*\}\)/);
  assert.match(orchestrator, /statusText\.value\s*=\s*`已打开表设计：\$\{tableName\}`/);
  assert.match(orchestrator, /matchesBinding\(["']openDesign["'], event\)/);
  assert.match(orchestrator, /resolveHomeDesignTargets/);
  assert.match(orchestrator, /activeDataTab\.value/);
  assert.match(orchestrator, /target\.isContentEditable/);
  assert.match(orchestrator, /closest\?\.\(["']input, textarea, select["']\)/);
  assert.match(orchestrator, /event\.preventDefault\(\)/);
  assert.match(orchestrator, /event\.stopPropagation\(\)/);
  assert.match(orchestrator, /handleTableFindKeydown\(event\)/);
  assert.match(orchestrator, /handleUndoKeydown\(event\)/);
  assert.match(orchestrator, /openDesignFromContextMenu/);
  assert.match(orchestrator, /@open-design="openDesignFromContextMenu"/);
  assert.match(orchestrator, /:table-scoped="contextMenu\.tableScoped"/);
  assert.match(menu, /defineEmits\(\[[^\]]*["']open-design["']/);
  assert.match(menu, /tableScoped/);
  assert.match(menu, /v-if="showTableActions"[\s\S]*>表设计</);
});

test("database and table context menus share overwrite sync and send actions", () => {
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
  assert.match(menu, /const\s+showTransferActions\s*=\s*computed\(\(\)\s*=>\s*showTableActions\.value\s*\|\|\s*props\.kind\s*===\s*["']database["']\)/);
  assert.match(menu, /<button\s+v-if="showTransferActions"[\s\S]*?@click="emit\('send-table'\)"[\s\S]*?发送到…/);
  assert.match(menu, /<button\s+v-if="showTransferActions"[\s\S]*?@click="emitSyncDatabase"[\s\S]*?覆盖同步…/);
  assert.match(menu, /sync-database/);
  assert.match(menu, /名称与标记…<\/button>[\s\S]*>刷新<kbd v-if="shortcutHints\.refresh"[^>]*>[^<]*<\/kbd><\/button>[\s\S]*<!-- 危险操作放最后 -->/);
  assert.match(orchestrator, /import\s+DatabaseSyncDialog\s+from\s+["']\.\/components\/DatabaseSyncDialog\.vue["']/);
  assert.match(orchestrator, /import\s+\{\s*useDatabaseSync\s*\}\s+from\s+["']\.\/composables\/useDatabaseSync\.js["']/);
  assert.match(orchestrator, /closeDatabaseTabs/);
  assert.match(orchestrator, /const\s+databaseSync\s*=\s*useDatabaseSync/);
  assert.match(orchestrator, /@sync-database="openDatabaseSync"/);
  assert.match(orchestrator, /@send-table="openTableCopyFromContext"/);
  assert.match(orchestrator, /<DatabaseSyncDialog/);
  assert.match(styles, /\.wb-database-sync-dialog/);
});

test("database sync dialog renders and wires source and target selectors", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dialog = read("./components/DatabaseSyncDialog.vue");

  assert.match(dialog, /target-change/);
  assert.match(dialog, /function\s+targetChanged/);
  assert.match(dialog, />源库<\/span>[\s\S]*<select[^>]*:value="sync\.dialog\.sourceDatabase"/);
  assert.match(dialog, /<option\s+v-for="database in sync\.sourceDatabaseOptions\.value"/);
  assert.match(dialog, />目标库（将被覆盖）<\/span>[\s\S]*<select[^>]*:value="sync\.dialog\.targetDatabase"/);
  assert.match(dialog, /<option\s+v-for="database in sync\.availableTargetDatabases\.value"/);
  assert.match(dialog, /@change="targetChanged"/);
  assert.match(orchestrator, /@target-change="databaseSync\.setTargetDatabase"/);
});

test("database sync dialog excludes tables from a searchable live-filtered list", () => {
  const dialog = read("./components/DatabaseSyncDialog.vue");

  assert.match(dialog, /v-model="searchQuery"/);
  assert.match(dialog, /aria-label="搜索可排除的源库表"/);
  assert.match(dialog, /v-for="row in visibleRows"/);
  assert.match(dialog, /@change="toggleTable\(row\.name\)"/);
  assert.match(dialog, /table\.name\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(dialog, /sync\.removeExcludedTable\(tableName\)/);
  assert.match(dialog, /SyncExclusionTemplates/);
  assert.doesNotMatch(dialog, /v-model="sync\.dialog\.selectedExclusionTable"/);
  assert.doesNotMatch(dialog, />添加排除<\/button>/);
  assert.doesNotMatch(dialog, /v-model="sync\.dialog\.exclusionInput"/);
  assert.doesNotMatch(dialog, /<textarea[\s\S]*aria-label="排除表"/);
});

test("database sync dialog allows direct execution without preview step", () => {
  const dialog = read("./components/DatabaseSyncDialog.vue");

  assert.match(dialog, /开始覆盖同步/);
  assert.match(dialog, /使用当前配置开始覆盖同步/);
  assert.doesNotMatch(dialog, /先预览后同步/);
});

test("database sync starts only after the confirmation overlay has closed", () => {
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(orchestrator, /const\s+confirmed\s*=\s*await\s+confirmDialogConfirm\(/);
  assert.match(orchestrator, /if\s*\(!confirmed\)\s*return;[\s\S]*?await\s+nextTick\(\);[\s\S]*?await\s+databaseSync\.execute\(\)/);
  assert.match(orchestrator, /databaseSyncConfirmationPending/);
  assert.match(orchestrator, /if\s*\(databaseSyncConfirmationPending\s*\|\|\s*!databaseSync\.canExecute\.value\)\s*return/);
});

test("database sync dialog exposes a real backend stop action while running", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dialog = read("./components/DatabaseSyncDialog.vue");
  const composable = read("./composables/useDatabaseSync.js");

  assert.match(dialog, /停止同步/);
  assert.match(dialog, /正在停止/);
  assert.match(dialog, /emit\('cancel'\)/);
  assert.match(orchestrator, /@cancel="databaseSync\.cancel"/);
  assert.match(composable, /invokeWorkbench\("cancel_database_sync",\s*\{\s*jobId\s*\}\)/);
});

test("database sync dialog renders restore result details for restored and manual recovery states", () => {
  const dialog = read("./components/DatabaseSyncDialog.vue");

  assert.match(dialog, /restoreResult/);
  assert.match(dialog, /failed-restored/);
  assert.match(dialog, /restore-failed/);
  assert.match(dialog, /failed-restore-failed/);
  assert.match(dialog, /failedRestored/);
  assert.match(dialog, /failedRestoreFailed/);
  assert.match(dialog, /已从本地安全快照恢复目标库/);
  assert.match(dialog, /需要手动恢复/);
  assert.match(dialog, /backupSnapshotPath|backup_snapshot_path/);
  assert.match(dialog, /本地安全快照/);
  assert.match(dialog, /覆盖同步完成，已确认目标库与源库的基础表结构和数据完全相同/);
  assert.match(dialog, /所有未排除表与源库一致/);
  assert.match(dialog, /v-if="syncSnapshotPath"> 本地安全快照已保存/);
  assert.match(dialog, /快照路径/);
  assert.match(dialog, /sync\.dialog\.status === 'succeeded' && !restoreResult/);
});

test("database sync dialog keeps every long-running stage visibly active", () => {
  const dialog = read("./components/DatabaseSyncDialog.vue");

  assert.match(dialog, /stageLabel/);
  assert.match(dialog, /currentTable/);
  assert.match(dialog, /completedRows/);
  assert.match(dialog, /totalRows/);
  assert.match(dialog, /elapsed/);
  assert.match(dialog, /最近更新/);
  assert.match(dialog, /is-indeterminate/);
  assert.match(dialog, /wb-database-sync-activity/);
  assert.match(dialog, /verify:\s*["']逐表一致性校验["']/);
  assert.match(dialog, /repair:\s*["']自动修复差异表["']/);
});

test("database sync lifecycle cleans progress listeners before unmount", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const composable = read("./composables/useDatabaseSync.js");

  assert.match(composable, /function\s+dispose/);
  assert.match(composable, /unlistenProgress\?\./);
  assert.match(orchestrator, /onBeforeUnmount/);
  assert.match(orchestrator, /databaseSync\.dispose\(\)/);
});

test("backup center opens change logs with all connections selected", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const openHandler = orchestrator.match(
    /async function openBackupCenter\(\)\s*\{([\s\S]*?)\n\}/,
  )?.[1] || "";

  assert.match(
    openHandler,
    /backupCenter\.setFilters\(\{\s*connectionId:\s*"",\s*database:\s*"",\s*tableName:\s*""\s*\}\)/,
  );
  assert.doesNotMatch(openHandler, /selectedConnectionId|selectedDatabase/);
});

test("backup center settings use scoped number steppers and close after saved feedback", () => {
  const shell = read("./components/BackupCenterDialog.vue");
  const settings = read("./components/BackupSettingsPanel.vue");
  const snapshots = read("./components/BackupSnapshotsPanel.vue");
  const dialog = [shell, settings, snapshots].join("\n");
  const styles = read("./workbench.css");
  const composable = read("./composables/useBackupCenter.js");
  const mock = read("./mock/mockBackend.js");
  const commands = read("../../src-tauri/src/commands.rs");
  const lib = read("../../src-tauri/src/lib.rs");
  const types = read("../../src-tauri/src/types.rs");

  assert.match(settings, /import\s+BackupNumberInput\s+from\s+["']\.\/BackupNumberInput\.vue["']/);
  assert.doesNotMatch(dialog, /import\s+ConfirmDialog\s+from\s+["']\.\/ConfirmDialog\.vue["']/);
  assert.match(dialog, /import\s+\{\s*useConfirm\s*\}\s+from\s+["']\.\.\/composables\/useConfirm\.js["']/);
  assert.match(dialog, /await\s+props\.backup\.saveConfig\(\{\s*\.\.\.draftConfig\.value\s*\}\)/);
  assert.match(settings, /await\s+alert\(\{[\s\S]*title:\s*t\("backup\.alert\.savedTitle"\)[\s\S]*message:\s*t\("backup\.alert\.saved"\)[\s\S]*emit\("close"\)/);
  assert.match(shell, /<BackupSettingsPanel[\s\S]*?@close="emit\('close'\)"/);
  assert.match(dialog, /props\.backup\.loadAuditLogs\(\)/);
  assert.match(dialog, /props\.backup\.loadSnapshots\(\)/);
  assert.match(dialog, /await\s+alert\(\{/);
  // Refresh is silent on success; only a failure interrupts with a dialog.
  assert.doesNotMatch(dialog, /"刷新完成"/);
  assert.match(shell, /if \(!ok && !silent\)[\s\S]*?title:\s*t\("backup\.refreshFailedTitle"\)/);
  assert.match(dialog, /await\s+props\.backup\.pruneSnapshots\(\)/);
  assert.match(dialog, /deletedCount/);
  assert.match(dialog, /wb-backup-snapshot-toolbar/);
  assert.match(dialog, /resolvedStorageDir/);
  assert.match(dialog, /openBackupPath/);
  assert.match(dialog, /onOpenSnapshotFolder\(snapshot\)/);
  assert.match(dialog, /onOpenStorageDir/);
  assert.match(dialog, /draftConfig\.value\s*=\s*\{\s*\.\.\.draftConfig\.value,\s*storageDir:\s*dir,\s*resolvedStorageDir:\s*dir\s*\}/);
  // Refreshed config (e.g. after toggling a database) keeps unsaved edits.
  assert.match(settings, /const edits = previous \? editedFields\(draftConfig\.value, previous\) : \{\};/);
  assert.doesNotMatch(dialog, /^\s*config\.value\s*=/m);
  assert.match(snapshots, /\/>打开资源管理器<\/button>/);
  assert.match(settings, /\/>打开<\/button>/);
  assert.match(composable, /async function openBackupPath/);
  assert.match(composable, /invokeWorkbench\(["']open_backup_path["'],\s*\{\s*path:\s*normalized\s*\}/);
  assert.match(mock, /command === ["']open_backup_path["']/);
  assert.match(commands, /pub async fn open_backup_path/);
  assert.match(lib, /commands::open_backup_path/);
  assert.match(types, /resolved_storage_dir:\s*String/);
  assert.match(dialog, /aria-label="快照按连接筛选"/);
  assert.match(dialog, /aria-label="快照按数据库筛选"/);
  assert.match(dialog, /@change="onConnectionFilterChange"/);
  assert.match(dialog, /@change="onDatabaseFilterChange"/);
  assert.match(shell, /@connection-change="onConnectionFilterChange"/);
  assert.match(shell, /@database-change="onDatabaseFilterChange"/);
  assert.match(dialog, /createSnapshotFromFilters/);
  assert.doesNotMatch(dialog, /wb-backup-config-layout/);
  assert.doesNotMatch(dialog, /wb-backup-config-main/);
  assert.doesNotMatch(dialog, /wb-backup-config-side/);
  assert.doesNotMatch(dialog, /<ConfirmDialog/);
  assert.match(dialog, /<BackupNumberInput\s+v-model="draftConfig\.intervalMinutes"/);
  assert.match(dialog, /<BackupNumberInput\s+v-model="draftConfig\.largeTableThreshold"/);
  assert.match(dialog, /<BackupNumberInput\s+v-model="draftConfig\.maxPerDb"/);
  assert.match(dialog, /<BackupNumberInput\s+v-model="draftConfig\.auditRetentionDays"/);
  assert.doesNotMatch(dialog, /<input\s+v-model\.number="config\.(intervalMinutes|largeTableThreshold|maxPerDb|auditRetentionDays)"/);
  assert.match(styles, /\.wb-backup-number-control:not\(:hover\):not\(:focus-within\) > \.wb-backup-number-stepper/);
  assert.match(styles, /\.wb-backup-number-stepper\s*\{[^}]*right:\s*3px/s);
  assert.match(styles, /\.wb-backup-number-control\s*\{[^}]*width:\s*96px/s);
  assert.match(styles, /\.wb-backup-config-input\s*\{[^}]*gap:\s*10px/s);
  assert.match(styles, /\.wb-backup-config-field > \.wb-backup-config-input\s*\{[^}]*justify-self:\s*start/s);
  assert.match(styles, /\.wb-backup-config-field > \.wb-backup-config-input\s*\{[^}]*text-align:\s*left/s);
  assert.match(styles, /\.wb-backup-snapshot-toolbar\s*\{/);
  assert.match(styles, /\.wb-backup-row-actions\s*\{[^}]*gap:\s*10px/s);
  assert.match(styles, /\.wb-backup-row-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(styles, /\.wb-backup-storage-control\s*\{[^}]*gap:\s*10px/s);
  assert.match(styles, /\.wb-backup-storage-control\s*\{[^}]*flex:\s*1\s+1\s+auto/s);
  assert.match(styles, /\.wb-backup-storage-path\s*\{[^}]*flex:\s*1\s+1\s+auto/s);
  assert.match(styles, /\.wb-backup-storage-path\s*\{[^}]*border:\s*1px\s+solid\s+var\(--wb-border-strong\)/s);
  assert.match(styles, /\.wb-backup-storage-path\s*\{[^}]*color:\s*var\(--wb-text\)/s);
  assert.doesNotMatch(styles, /\.wb-backup-config-layout\s*\{/);
  assert.doesNotMatch(styles, /\.wb-backup-config-main\s*\{/);
  assert.doesNotMatch(styles, /\.wb-backup-config-side\s*\{/);
});

test("table tab bar context menu can close all open tabs", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const tabs = read("./components/WorkbenchTabs.vue");
  const refreshTabs = orchestrator.match(/async function refreshTabsFromMenu\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  const refreshDataTab = orchestrator.match(/async function refreshDataTab\(tab\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(tabs, /tab-contextmenu/);
  assert.match(tabs, /@contextmenu\.prevent\.stop="openTabContextMenu/);
  assert.match(tabs, /paneId:\s*props\.paneId/);
  assert.match(orchestrator, /closePaneTabs/);
  assert.doesNotMatch(orchestrator, /closeAllTableTabs/);
  assert.match(orchestrator, /function\s+refreshTabsFromMenu/);
  assert.match(refreshTabs, /await refreshDataTab\(tab\)/);
  assert.match(refreshTabs, /focusedPaneState\.refreshHomeView\?\.\(\)/);
  assert.match(refreshDataTab, /refreshTabPage\(tab,\s*1,\s*\{\s*refreshSchema:\s*true\s*\}\)/);
  assert.doesNotMatch(refreshDataTab, /refreshTabPage\(tab,\s*tab\.page\s*\|\|\s*1\)/);
  assert.match(orchestrator, /function\s+closeAllTabsFromMenu/);
  assert.match(orchestrator, /@tab-contextmenu="openTabContextMenu"/);
  assert.match(orchestrator, /<ListX[^>]*\/>全部关闭</);
});

test("tab bar closes tabs with a middle click and offers close and close-others", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const tabs = read("./components/WorkbenchTabs.vue");
  const closeOthers = orchestrator.match(/async function closeOtherTabsFromMenu\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(tabs, /@mousedown\.middle\.prevent/);
  assert.match(tabs, /@auxclick="closeTabFromMiddleClick\(tab, \$event\)"/);
  assert.match(tabs, /function closeTabFromMiddleClick\(tab, event\)\s*\{[\s\S]*?event\?\.button !== 1 \|\| !canCloseTab\(tab\)[\s\S]*?emit\("close-tab", tab\.id\)/);
  assert.match(orchestrator, /@click="closeTabFromMenu"/);
  assert.match(orchestrator, /@click="closeOtherTabsFromMenu"/);
  assert.match(closeOthers, /guardTabDepartures\(tabsToClose\)/);
  assert.match(closeOthers, /closePaneTabsRelative\(workspace, paneId, tabId, direction\)/);
  assert.match(orchestrator, /class="wb-context-menu wb-tab-context-menu"[\s\S]*?role="menu"[\s\S]*?@keydown="handleTabContextMenuKeydown"/);
});

test("tab close discard guard keeps drafts whose insert request is still saving", () => {
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(orchestrator, /isDraftSaving:\s*\(tab,\s*rowId\)\s*=>\s*isInsertRowSaving\(tab,\s*rowId\)/);
  assert.match(orchestrator, /if\s*\(!insertGuard\.proceed\s*&&\s*insertGuard\.blockedTab\)\s*\{[\s\S]*新增行正在保存，完成后再关闭标签[\s\S]*return false/);
});

test("workbench clears stale cell validation errors on refresh and tab close", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");

  assert.match(orchestrator, /import\s+\{\s*createEditState[\s\S]*clearCellErrorsForTable[\s\S]*\}\s+from\s+["']\.\/editState\.js["']/);
  assert.match(orchestrator, /function\s+tabErrorScopeKey\(tab\)/);
  assert.match(orchestrator, /function\s+clearTabCellErrors\(tab\)/);
  assert.match(orchestrator, /async\s+function\s+refreshTabPage\(tab,\s*page,\s*options\s*=\s*\{\}\)/);
  assert.match(orchestrator, /const\s+result\s*=\s*await\s+fetchPage\(tab,\s*page,\s*\{\s*refreshSchema:\s*options\.refreshSchema === true,/);
  // Refreshes of rows changed in place keep the loaded window (see fetchPage).
  assert.match(orchestrator, /inPlace:\s*options\.inPlace === true/);
  assert.match(orchestrator, /focusedPaneState\.prepareInsertDraftsForRefresh\?\.\(tab\)/);
  assert.match(orchestrator, /if\s*\(ready === false\)\s*return\s*\{\s*ok:\s*false,\s*cancelled:\s*true\s*\}/);
  assert.match(orchestrator, /if\s*\(result\?\.ok\)\s*\{[\s\S]*clearTabCellErrors\(tab\)[\s\S]*focusedPaneState\.clearInsertDraftsAfterRefresh\?\.\(tab\)[\s\S]*clearInsertDraft\(tab\)[\s\S]*clearSelection\(\{ clearInsertDrafts: true \}\)/);
  assert.match(orchestrator, /useContextMenu\([\s\S]*onTablePageRefreshed:\s*resumeSearchAfterTableRefresh[\s\S]*\)/);
  assert.match(pane, /resumeCurrentSearchResults/);
  assert.match(orchestrator, /onTablePageRefreshed:[\s\S]*resumeCurrentSearchResults/);
  assert.match(orchestrator, /function\s+closeTab\(paneIdOrTabId,\s*maybeTabId\)\s*\{[\s\S]*clearTabCellErrors\(tab\)[\s\S]*closePaneTab\(workspace,\s*paneId,\s*tabId\)/);
  assert.match(orchestrator, /function\s+closeAllTabsFromMenu\(\)\s*\{[\s\S]*closePaneTabs\(workspace,\s*paneId\)[\s\S]*closedTabs\.forEach\(clearTabCellErrors\)/);
});

test("data grid exposes its real scroll wrapper to editor and virtual grid", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const dataGrid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");

  assert.match(dataGrid, /grid-ready/);
  assert.match(dataGrid, /emit\(["']grid-ready["'],\s*gridWrapRef\.value\)/);
  assert.match(pane, /function\s+setGridWrapElement/);
  assert.match(pane, /@grid-ready="setGridWrapElement"/);
});

test("data grid sorts from a hover-revealed column menu instead of header clicks", () => {
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const menu = read("./components/ColumnSortMenu.vue");
  const styles = read("./workbench.css");

  assert.match(grid, /import\s+ColumnSortMenu\s+from\s+["']\.\/ColumnSortMenu\.vue["']/);
  assert.match(grid, /'apply-sort'/);
  assert.match(grid, /<ColumnSortMenu/);
  assert.match(grid, /@apply-sort="emit\('apply-sort', tab, columnMeta\.name, \$event\)"/);
  assert.doesNotMatch(grid, /@click="onHeaderClick\(tab,\s*columnName\(column\)\)"/);
  assert.doesNotMatch(grid, /function\s+onHeaderClick/);
  assert.match(pane, /applySort:\s*\{\s*type:\s*Function,\s*required:\s*true\s*\}/);
  assert.match(pane, /function\s+applyGridSort/);
  assert.match(pane, /props\.applySort\(tab,\s*col,\s*direction\)/);
  assert.match(pane, /@apply-sort="applyGridSort"/);
  assert.match(menu, /升序排序/);
  assert.match(menu, /降序排序/);
  assert.match(menu, /移除排序/);
  assert.match(styles, /\.wb-column-sort-trigger/);
  assert.match(styles, /\.wb-grid th:hover \.wb-column-sort-trigger/);
  assert.match(styles, /\.wb-column-sort-trigger\.is-sorted/);
  assert.match(styles, /\.wb-column-sort-menu/);
  const triggerRule = styles.match(/\.wb-column-sort-trigger\s*\{([^}]*)\}/s)?.[1] || "";
  // Vector icons (not a font glyph) and revealed with its header or when sorted.
  assert.match(menu, /<ChevronDown/);
  assert.match(menu, /<ArrowUp v-if="isSorted && !sort\?\.descending"/);
  assert.doesNotMatch(menu, /▾/);
  assert.match(triggerRule, /opacity:\s*0;/);
  assert.match(triggerRule, /border:\s*0/);
  assert.match(triggerRule, /border-radius:\s*0/);
  assert.match(triggerRule, /background:\s*transparent/);
  assert.match(triggerRule, /box-shadow:\s*none/);
  const triggerStateRule = styles.match(/\.wb-column-sort-trigger:hover,[\s\S]*?\.wb-column-sort\.is-open \.wb-column-sort-trigger\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(triggerStateRule, /background:\s*transparent/);
  assert.match(triggerStateRule, /border:\s*0/);
  assert.match(triggerStateRule, /box-shadow:\s*none/);
  assert.match(styles, /\.mysql-workbench\[data-theme="light"\] \.wb-column-sort-trigger:hover,[\s\S]*?background:\s*transparent/s);
});

test("column sort menu escapes clipped grid headers", () => {
  const menu = read("./components/ColumnSortMenu.vue");
  const styles = read("./workbench.css");

  assert.match(menu, /<Teleport\s+to="body">/);
  assert.match(menu, /:style="menuStyle"/);
  assert.match(menu, /class="wb-column-sort-menu wb-floating-themed"/);
  assert.match(styles, /\.wb-column-sort-menu\s*\{[^}]*position:\s*fixed/s);
});

test("table search completes normal rows automatically and keeps explicit result pages isolated", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const splitLayout = read("./components/WorkbenchSplitLayout.vue");
  const tableSession = read("./composables/useTableSession.js");
  const tableSearch = read("./composables/useTableSearch.js");
  const dataGrid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");

  assert.match(pane, /import\s+\{\s*useTableSearch\s*\}\s+from\s+["']\.\.\/composables\/useTableSearch\.js["']/);
  assert.match(pane, /handleTableFindKeydown\(event\)/);
  assert.match(orchestrator, /@keydown="handleWorkbenchKeydown"/);
  assert.match(pane, /@search-input="runTableSearch"/);
  assert.match(pane, /@search-ready="setSearchInputElement"/);
  assert.match(pane, /loadSearchResultPage:\s*props\.loadSearchResultPage/);
  assert.match(pane, /loadNextPage:\s*props\.loadNextPage/);
  assert.match(splitLayout, /loadSearchResultPage/);
  assert.match(orchestrator, /loadSearchResultPage/);
  assert.match(tableSession, /function\s+loadSearchResultPage/);
  assert.match(tableSession, /searchResultMode\s*=\s*true/);
  assert.match(tableSession, /invokeWorkbench\("begin_table_search"/);
  assert.match(tableSession, /invokeWorkbench\("next_table_search_page"/);
  assert.match(tableSession, /invokeWorkbench\("cancel_table_search"/);
  assert.match(tableSession, /const\s+SEARCH_RESULT_BUFFER_ROWS\s*=\s*500/);
  assert.match(tableSession, /tab\.normalViewState\s*=\s*\{/);
  assert.match(tableSession, /tab\.searchRowStore\s*=\s*markRaw\(new DenseRowStore/);
  assert.match(tableSearch, /loadNextSearchResultPage/);
  assert.match(tableSearch, /\bloadNextPage\b/);
  assert.match(tableSearch, /async\s+function\s+executeOrdinarySearch/);
  assert.match(tableSearch, /while\s*\([\s\S]*?!tab\.fullyLoaded[\s\S]*?loadNextOrdinaryPage\(tab\)/);
  assert.match(tableSearch, /options\.preferBackendResultPage[\s\S]*?executeBackendSearch[\s\S]*?executeOrdinarySearch/);
  assert.match(pane, /async\s+function\s+applyGridSort/);
  assert.match(pane, /await\s+props\.applySort\(tab,\s*col,\s*direction\)/);
  assert.match(pane, /await\s+resumeCurrentSearchResults\(\{\s*select:\s*true\s*\}\)/);
  assert.doesNotMatch(dataGrid, /@keydown\.enter\.prevent="emit\('filter-page'/);
  assert.match(dataGrid, /search-ready/);
  assert.match(dataGrid, /search-input/);
  assert.doesNotMatch(dataGrid, /v-model="tab\.filter"/);
  assert.match(dataGrid, /:value="searchInputValue"/);
  assert.match(dataGrid, /@input="onTableSearchInput"/);
});

test("grid scroll schedules paging outside the event and keeps both directions fixed", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const dataGrid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const virtualGrid = read("./composables/useVirtualGrid.js");
  const styles = read("./workbench.css");

  assert.match(dataGrid, /@scroll\.passive="onGridWrapScroll"/);
  assert.doesNotMatch(dataGrid, /@wheel/);
  assert.match(pane, /let\s+loadMoreFrame\s*=\s*0/);
  assert.match(pane, /const\s+PAGE_PREFETCH_ROWS\s*=\s*200/);
  assert.match(pane, /const\s+PAGE_PREFETCH_VIEWPORTS\s*=\s*4/);
  assert.match(pane, /requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*maybeLoadMoreRows\(target,\s*\{\s*loadPrevious\s*\}\)/);
  assert.match(pane, /props\.loadNextPage\(tab\)/);
  assert.match(pane, /nextPageLoadPending/);
  assert.match(pane, /previousPageLoadPending/);
  assert.match(pane, /distanceToTableWindowEnd\([\s\S]*?tabRowCount\(tab\)[\s\S]*?target\.scrollTop[\s\S]*?target\.clientHeight/);
  assert.match(pane, /distanceToTableWindowStart\(tab,\s*target\.scrollTop,\s*rowHeight\.value\)/);
  assert.doesNotMatch(pane, /target\.scrollHeight\s*-\s*target\.scrollTop\s*-\s*target\.clientHeight/);
  assert.doesNotMatch(pane, /offsetGridScroll|handleGridWheel|@wheel=/);
  assert.match(dataGrid, /v-else-if="!tab\.fullyLoaded && loadedRowCount > 0"\s+aria-hidden="true"\s+class="wb-grid-loadmore-row"/);
  assert.match(virtualGrid, /const\s+loadedEnd\s*=\s*loadedStart\s*\+\s*loadedTotal/);
  assert.match(virtualGrid, /const\s+total\s*=\s*tableScrollRowCount\(activeTab\.value,\s*loadedTotal\)/);
  assert.doesNotMatch(virtualGrid, /maintainScrollAnchor|GRID_SCROLL_RECONCILE/);
  assert.match(styles, /\.wb-grid-wrap\s*\{[^}]*overscroll-behavior:\s*none/s);
  assert.doesNotMatch(pane, /@scroll="onGridScroll\(\$event\);\s*maybeLoadMoreRows\(\$event\)"/);
  assert.match(orchestrator, /let\s+loadMoreFrame\s*=\s*0/);
  assert.match(orchestrator, /requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*maybeLoadMoreRows\(target\)/);
  assert.match(orchestrator, /loadNextPage\(tab\)/);
});

test("ordinary grid cells skip HTML parsing and search highlighting when no query is active", () => {
  const dataGrid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");

  assert.match(dataGrid, /import\s+\{[^}]*displayCellValue[^}]*\}\s+from\s+["']\.\.\/utils\/cellDisplay\.js["']/s);
  assert.match(dataGrid, /const\s+hasActiveCellSearch\s*=\s*computed/);
  assert.match(dataGrid, /'search-match':\s*hasActiveCellSearch\s*&&\s*isSearchMatch/);
  assert.match(dataGrid, /v-else-if="hasActiveCellSearch"[^>]*v-html="highlightHtml/);
  assert.match(dataGrid, /v-else[^>]*class="wb-cell-text"[^>]*>\{\{\s*displayText/);
});

test("visible grid rows and columns reuse prepared geometry instead of recomputing it per cell", () => {
  const dataGrid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const row = read("./components/GridDataRow.vue");
  assert.match(dataGrid, /const\s+visibleRowsWithVisualIndex\s*=\s*computed/);
  assert.match(dataGrid, /const\s+renderCellColumns\s*=\s*computed/);
  assert.match(dataGrid, /<GridDataRow/);
  assert.match(row, /v-for="columnMeta in columns"/);
  assert.match(row, /rangeClasses\?\./);
  assert.doesNotMatch(row, /getCellRangeClasses/);
  assert.match(row, /columnMeta\.cellStyle/);
  assert.doesNotMatch(row, /dataRowVisualIndex/);
});

test("Ctrl+F is captured globally and opens the find tab of the find/replace dialog", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const home = read("./components/DatabaseHome.vue");

  assert.match(orchestrator, /document\.addEventListener\("keydown",\s*handleGlobalShortcutKeydown,\s*true\)/);
  assert.match(orchestrator, /function\s+isNativeFindKeydown\(event\)/);
  assert.match(orchestrator, /shortcutHelper\.matchesBinding\("searchTable",\s*event\)/);
  assert.match(
    orchestrator,
    /matchesBinding\("searchTable",\s*event\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?openFindReplaceDialog\("find"\)/
  );
  // 没有打开的数据表时（如数据库主页）回退到聚焦当前页面的搜索框。
  assert.match(orchestrator, /else\s+focusFocusedSearch\(\);/);
  assert.match(
    orchestrator,
    /function\s+focusFocusedSearch\(\)[\s\S]*?focusedPaneState\.focusCurrentSearch\?\.\(\)/
  );

  assert.match(home, /const\s+searchInputRef\s*=\s*ref\(null\)/);
  assert.match(home, /function\s+focusSearch/);
  assert.match(home, /ref="searchInputRef"/);
  assert.match(home, /defineExpose\(\{[\s\S]*focusSearch[\s\S]*\}\)/);
  assert.match(pane, /function\s+focusCurrentSearch/);
  assert.match(pane, /activeHomeTab\.value[\s\S]*databaseHomeRef\.value\?\.focusSearch/);
  assert.match(pane, /focusTableSearch/);
  assert.match(pane, /focusCurrentSearch,\s*\n/);
});

test("Ctrl+H opens the replace tab of the find/replace dialog routed through the focused pane", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const dialog = read("./components/FindReplaceDialog.vue");
  const shortcuts = read("./composables/useShortcuts.js");

  assert.match(shortcuts, /replaceInTable:\s*"Ctrl\+H"/);
  assert.match(shortcuts, /searchTable:\s*"Ctrl\+F"/);
  assert.match(shortcuts, /replaceInTable:\s*"替换"/);
  assert.match(orchestrator, /function\s+handleReplaceInTableKeydown\(event\)/);
  assert.match(orchestrator, /shortcutHelper\.matchesBinding\("replaceInTable",\s*event\)/);
  assert.match(orchestrator, /if\s*\(handleReplaceInTableKeydown\(event\)\)\s*return;/);
  assert.match(orchestrator, /<FindReplaceDialog[\s\S]*?:pane-state="focusedPaneState"/);
  assert.match(orchestrator, /<FindReplaceDialog[\s\S]*?:initial-tab="findReplaceTab"/);
  assert.match(pane, /function\s+replaceCellsInSelection/);
  assert.match(pane, /function\s+listSelectionMatches/);
  assert.match(pane, /function\s+locateListMatch/);
  assert.match(pane, /function\s+replaceListMatch/);
  assert.match(pane, /replaceCellsInSelection,\s*\n/);
  assert.match(dialog, /gridSelectionCount/);
  assert.match(dialog, /replace_in_table/);
  assert.match(dialog, /find_in_table/);
  assert.match(dialog, /listSelectionMatches/);
  assert.match(dialog, /locateListMatch/);
  assert.match(dialog, /replaceListMatch/);
});

test("find and replace stays non-modal, anchors resize at the top-left, and follows the active table", () => {
  const dialog = read("./components/FindReplaceDialog.vue");
  const styles = read("./workbench.css");

  assert.doesNotMatch(dialog, /aria-modal="true"/);
  assert.doesNotMatch(dialog, /@click\.self=/);
  assert.match(styles, /\.wb-dialog-overlay\.wb-find-replace-overlay\s*\{[^}]*background:\s*transparent;[^}]*pointer-events:\s*none;/s);
  assert.match(styles, /\.wb-find-replace-dialog\s*\{[^}]*position:\s*absolute;[^}]*box-shadow:\s*none;[^}]*pointer-events:\s*auto;/s);
  assert.match(dialog, /const\s+anchorLeft\s*=\s*Math\.round\(startRect\?\.left/);
  assert.match(dialog, /const\s+anchorTop\s*=\s*Math\.round\(startRect\?\.top/);
  assert.doesNotMatch(dialog, /transform:\s*`translate/);
  assert.match(dialog, /function\s+measureNaturalDialogHeight\(\)/);
  assert.match(dialog, /dialog\.style\.height\s*=\s*"auto"/);
  assert.match(dialog, /dialog\.classList\.add\("is-measuring-minimum"\)/);
  assert.match(dialog, /const\s+minimumHeight\s*=\s*Math\.min\(measureNaturalDialogHeight\(\)\s*\|\|\s*startHeight,\s*maximumHeight\)/);
  assert.match(dialog, /dialogHeight\.value\s*=\s*clamp\([\s\S]*?minimumHeight,[\s\S]*?maximumHeight/);
  assert.match(dialog, /watch\(\[activeTab,\s*listExpanded,\s*\(\)\s*=>\s*feedback\.value\.text\][\s\S]*?nextTick\(ensureDialogFitsContent\)/);
  assert.doesNotMatch(dialog, /MIN_DIALOG_HEIGHT/);
  assert.match(styles, /\.wb-find-replace-dialog\.is-measuring-minimum\s+\.wb-find-results\s*\{[^}]*flex:\s*0 0 120px;[^}]*max-height:\s*120px;/s);
  assert.match(dialog, /const\s+activeTableIdentity\s*=\s*computed/);
  assert.match(dialog, /watch\(activeTableIdentity,[\s\S]*?scheduleListRefresh\(\)/);
  assert.match(dialog, /tableIdentity\s*!==\s*activeTableIdentity\.value/);
});

test("find navigation flushes the pending whole-table search before Enter or button navigation", () => {
  const dialog = read("./components/FindReplaceDialog.vue");

  assert.match(dialog, /const\s+listCompletedSeq\s*=\s*ref\(0\)/);
  assert.match(dialog, /const\s+canRequestNavigation\s*=\s*computed\([\s\S]*?Boolean\(findText\.value\)/);
  assert.match(dialog, /const\s+canNavigate\s*=\s*computed\([\s\S]*?listCompletedSeq\.value\s*!==\s*listSeq[\s\S]*?matches\.value\.length\s*>\s*0/);
  assert.match(dialog, /scheduleListRefresh,\s*\n\s*\{\s*immediate:\s*true,\s*flush:\s*"sync"\s*\}/);
  assert.match(dialog, /async function\s+refreshListNow\(\)[\s\S]*?clearTimeout\(listTimer\)[\s\S]*?await\s+startTableList\(seq\)/);
  assert.match(dialog, /async function\s+goToNext\(\)[\s\S]*?await\s+refreshListNow\(\)[\s\S]*?jumpToMatch/);
  assert.match(dialog, /async function\s+goToPrevious\(\)[\s\S]*?await\s+refreshListNow\(\)[\s\S]*?jumpToMatch/);
  assert.match(dialog, /@keydown\.enter\.exact\.prevent="goToNext"/);
  assert.match(dialog, /@keydown\.shift\.enter\.prevent="goToPrevious"/);
});

test("find and replace docks beside the grid, keeps the match uncovered, and has one primary action", () => {
  const dialog = read("./components/FindReplaceDialog.vue");

  assert.match(dialog, /function\s+gridCornerPositions\(height\)/);
  assert.match(dialog, /\.wb-workbench-pane\.is-focused \.wb-grid-shell/);
  assert.match(dialog, /const docked = gridCornerPositions\(/);
  assert.match(dialog, /await props\.paneState\.locateListMatch\?\.\(match\);\s*await keepActiveMatchVisible\(\);/);
  assert.match(dialog, /aria-activedescendant/);
  assert.match(dialog, /class="wb-find-input-row"[\s\S]*?class="wb-find-nav-button"[\s\S]*?class="wb-find-nav-button"/);
  assert.equal((dialog.match(/class="wb-dialog-primary/g) || []).length, 1);
  assert.doesNotMatch(dialog, /<button type="button" :disabled="isBusy" @click="emit\('close'\)">/);
});

test("table search cell selection resolves columns from the searched tab", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const selectCellAtBody = pane.match(/function\s+selectCellAt\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(selectCellAtBody, /tab\?\.columns\?\.\[columnIndex\]/);
  assert.match(selectCellAtBody, /scrollCellIntoView\(rowIndex,\s*columnIndex\)/);
  assert.match(selectCellAtBody, /focusGrid:\s*false/);
  assert.doesNotMatch(selectCellAtBody, /activeColumns\.value\[columnIndex\]/);
});

test("table search keeps the active match visible when the detail panel shrinks the grid", () => {
  const pane = read("./components/WorkbenchPane.vue");

  assert.match(pane, /watch\(\s*viewportHeight/);
  assert.match(pane, /activeSearchQuery\.value/);
  assert.match(pane, /currentSearchPosition\(\)/);
  assert.match(pane, /scrollCellIntoView\(position\.rowIndex,\s*position\.columnIndex\)/);
});

test("cell highlighting reads the in-table search query without requiring backend filtering", () => {
  const display = read("./utils/cellDisplay.js");

  assert.match(display, /const query = \(tab\?\.searchQuery \?\? tab\?\.filter \?\? ""\)\.trim\(\)/);
  assert.match(display, /normalizeTableFilterMode\(tab\.filterMode\)/);
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
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const theme = read("./composables/useTheme.js");

  assert.match(orchestrator, /import\s+\{\s*useTheme\s*\}\s+from\s+["']\.\/composables\/useTheme\.js["']/);
  assert.match(orchestrator, /useTheme\(\)/);
  assert.match(orchestrator, /<main[\s\S]*?:data-theme="effectiveTheme"/);
  assert.match(orchestrator, /:is-dark="isDark"/);
  // The settings control is a 3-option segment (light / dark / system) that
  // emits the explicit choice instead of toggling.
  assert.match(orchestrator, /@set-theme="setThemePreference"/);
  assert.doesNotMatch(orchestrator, /class="wb-theme-toggle"/);
  // The settings trigger is the gear pinned at the bottom of the activity rail;
  // the sidebar only owns the teleported settings sheet.
  assert.doesNotMatch(sidebar, /wb-sidebar-settings-trigger|wb-sidebar-settings-icon/);
  assert.doesNotMatch(sidebar, /settings(-white)?\.png/);
  assert.match(sidebar, /class="wb-sidebar-settings-sheet wb-floating-themed"/);
  assert.match(sidebar, /const currentTheme = computed\(\(\) => \(props\.isDark \? "dark" : "light"\)\)/);
  assert.match(sidebar, /useCellHighlight\(\{[\s\S]*getTheme:\s*\(\) => currentTheme\.value,[\s\S]*themeRef:\s*currentTheme,[\s\S]*\}\)/);
  assert.doesNotMatch(sidebar, /<header[\s\S]*设置/);
  assert.doesNotMatch(sidebar, /<strong>设置<\/strong>/);
  assert.match(sidebar, /class="wb-sidebar-theme-segment"/);
  assert.match(sidebar, /class="wb-sidebar-settings-label"[\s\S]*外观/);
  assert.doesNotMatch(sidebar, /M4 7h7/);
  assert.doesNotMatch(sidebar, /M19\.4 15a7\.8/);
  assert.match(sidebar, /emit\(["']set-theme["'], nextTheme\)/);
  assert.match(sidebar, />浅色<\/button>/);
  assert.match(sidebar, />深色<\/button>/);
  assert.match(theme, /getCurrentWindow/);
  assert.match(theme, /\.setTheme\(theme\)/);
  assert.doesNotMatch(theme, /set_window_chrome_theme/);
});

test("workbench renders a platform-adaptive draggable titlebar on the chrome surface", () => {
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
  assert.match(orchestrator, /isMacOSPlatform/);
  assert.match(orchestrator, /usesNativeMacWindowControls\s*=\s*isTauriRuntime\(\)\s*&&\s*isMacOSPlatform\(\)/);
  assert.match(orchestrator, /'is-native-macos':\s*usesNativeMacWindowControls/);
  assert.match(orchestrator, /@dblclick\.self="handleTitlebarDoubleClick"/);
  assert.match(orchestrator, /v-if="!usesNativeMacWindowControls"[\s\S]*class="wb-titlebar-controls"/);
  assert.match(styles, /\.wb-titlebar\s*\{[^}]*background:\s*var\(--wb-chrome-surface\)/s);
  assert.match(styles, /\.wb-titlebar-controls\s*\{/);
  assert.match(styles, /\.wb-titlebar-button\.is-close:hover\s*\{/);
  assert.match(styles, /\.mysql-workbench\.is-native-macos\s*\{[^}]*--wb-macos-traffic-light-clearance:\s*76px/s);
  assert.match(styles, /\.mysql-workbench\.is-native-macos \.wb-titlebar-sidebar:not\(\.is-collapsed\)\s*\{[^}]*padding-left:\s*var\(--wb-macos-traffic-light-clearance\)/s);
  assert.match(styles, /\.mysql-workbench\.is-native-macos \.wb-titlebar-sidebar\.is-collapsed\s*\{[^}]*left:\s*var\(--wb-macos-traffic-light-clearance\)/s);
});

test("workbench rail can pin the window with a customizable F8 shortcut", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pin = read("./composables/useWindowPin.js");
  const shortcuts = read("./composables/useShortcuts.js");
  const styles = read("./workbench.css");

  assert.match(read("./composables/useActivityRail.js"), /id: "pinWindow", icon: Pin/);
  assert.match(orchestrator, /import\s+\{\s*useWindowPin\s*\}\s+from\s+["']\.\/composables\/useWindowPin\.js["']/);
  assert.match(orchestrator, /const\s+windowPin\s*=\s*useWindowPin\(\)/);
  assert.match(orchestrator, /shortcutHelper\.matchesBinding\("pinWindow", event\)/);
  assert.match(orchestrator, /pressed: windowPin\.pinned\.value/);
  assert.match(orchestrator, /pinWindow: toggleWindowPin/);
  assert.match(orchestrator, /"已钉住：窗口将保持在最上层"/);
  assert.match(orchestrator, /"已解除钉住：窗口恢复正常层级"/);
  assert.match(pin, /\.setAlwaysOnTop\(nextPinned\)/);
  assert.match(pin, /\.isAlwaysOnTop\(\)/);
  assert.match(shortcuts, /pinWindow:\s*"F8"/);
  assert.match(shortcuts, /pinWindow:\s*"钉住窗口"/);
  assert.match(styles, /\.wb-activity-rail-btn\.is-pinned,[\s\S]*?color:\s*var\(--wb-accent-strong\)/);
});

test("workbench titlebar hosts database controls and inspector collapse", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /id="wb-topbar-sidebar-actions"/);
  assert.match(orchestrator, /id="wb-topbar-tabs"/);
  assert.match(orchestrator, /class="wb-titlebar-inspector-controls"/);
  assert.match(orchestrator, /sidebarCollapsed \? '展开数据库栏' : '收起数据库栏'/);
  assert.match(orchestrator, /inspectorCollapsed \? '展开备注栏' : '收起备注栏'/);
  assert.match(orchestrator, /INSPECTOR_TITLEBAR_COLLAPSED_WIDTH\s*=\s*32/);
  assert.match(orchestrator, /INSPECTOR_MIN_WIDTH/);
  assert.match(orchestrator, /const inspectorTitlebarStyle = computed/);
  assert.match(orchestrator, /inspectorCollapsed\.value\s*\?\s*`\$\{INSPECTOR_TITLEBAR_COLLAPSED_WIDTH\}px`\s*:\s*`\$\{Math\.max\(inspectorWidth\.value, INSPECTOR_MIN_WIDTH\)\}px`/s);
  assert.match(orchestrator, /:style="sidebarLayoutVars"/);
  assert.doesNotMatch(orchestrator, /useQuickOpenClearance|quickOpenClearanceVars|quickOpenEntryRef/);
  assert.match(orchestrator, /:style="inspectorTitlebarStyle"/);
  assert.match(orchestrator, /'is-inspector-collapsed': inspectorCollapsed/);
  assert.match(orchestrator, /'is-collapsed': sidebarCollapsed && !sidebarPaneAnimating/);
  assert.match(orchestrator, /'is-retracted': sidebarCollapsed/);
  assert.match(orchestrator, /:class="\{\s*'is-collapsed': inspectorCollapsed\s*\}"/);

  assert.match(sidebar, /<Teleport[^>]*to="#wb-topbar-sidebar-actions"/);
  assert.match(sidebar, /toggleCollapseAll/);
  // Feature entries live in the always-visible activity rail, not the sidebar header.
  assert.doesNotMatch(sidebar, /open-connection|open-backup-center|open-table-transfer/);
  assert.doesNotMatch(sidebar, /class="wb-sidebar-title"/);
  assert.doesNotMatch(sidebar, /class="wb-sidebar-count"/);
  assert.doesNotMatch(sidebar, />数据库<\/strong>/);

  assert.doesNotMatch(orchestrator, /import\s+WorkbenchTopbarTabs\s+from\s+["']\.\/components\/WorkbenchTopbarTabs\.vue["']/);
  assert.match(orchestrator, /<div[\s\S]*?class="wb-titlebar-tabs"[\s\S]*?id="wb-topbar-tabs"[\s\S]*?<\/div>/);
  assert.doesNotMatch(pane, /<Teleport\s+defer\s+to="#wb-topbar-tabs"/);
  assert.match(pane, /import\s+WorkbenchTabs\s+from\s+["']\.\/WorkbenchTabs\.vue["']/);
  assert.match(pane, /class="wb-pane-tabbar"/);

  assert.match(styles, /\.wb-titlebar\s*\{[^}]*display:\s*flex/s);
  assert.match(styles, /\.wb-titlebar\s*\{[^}]*position:\s*relative/s);
  assert.match(styles, /\.wb-titlebar-sidebar\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(styles, /\.wb-titlebar-sidebar\.is-retracted \.wb-sidebar-actions\s*\{[^}]*max-width:\s*0/s);
  assert.match(styles, /--wb-pane-collapse-duration:\s*0\.28s/);
  assert.match(orchestrator, /sidebarLayoutVars/);
  assert.match(orchestrator, /onSidebarLayoutTransitionEnd/);
  assert.match(orchestrator, /provide\("suspendGridAutoFit", sidebarPaneAnimating\)/);
  assert.match(styles, /@property --wb-sidebar-slot-width/);
  assert.match(styles, /@property --wb-sidebar-content-width/);
  assert.match(styles, /\.wb-sidebar-slot\s*\{[^}]*width:\s*var\(--wb-sidebar-slot-width\)/s);
  assert.match(styles, /\.wb-sidebar-slot\s*\{[^}]*transition:\s*width var\(--wb-pane-collapse-duration\)/s);
  assert.match(orchestrator, /'is-pane-animating': sidebarPaneAnimating/);
  assert.match(orchestrator, /'is-expanding': sidebarPanePhase === 'expanding'/);
  assert.match(styles, /\.wb-sidebar\s*\{[^}]*width:\s*var\(--wb-sidebar-content-width\)/s);
  assert.doesNotMatch(styles, /@keyframes wb-sidebar-push-flash/);
  assert.doesNotMatch(styles, /filter:\s*brightness/);
  assert.doesNotMatch(styles, /\.wb-sidebar\.is-expanding\s*\{[^}]*min-width:\s*var\(--wb-sidebar-titlebar-width\)/s);
  assert.match(styles, /\.wb-sidebar\.is-pane-animating:not\(\.is-expanding\) \.wb-source-tree/s);
  assert.match(styles, /\.wb-sidebar\.is-pane-animating\.is-expanding \.wb-source-tree/s);
  assert.match(orchestrator, /'is-collapsed': sidebarCollapsed && !sidebarPaneAnimating/);
  assert.match(styles, /\.wb-titlebar-sidebar\.is-collapsed\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.wb-pane-tabbar\.is-left-edge-pane \.wb-object-tabs\s*\{[^}]*transform:\s*translateX\(var\(--wb-sidebar-tab-offset\)\)/s);
  assert.match(styles, /\.wb-pane-tabbar\.is-right-edge-pane \.wb-object-tabs\s*\{[^}]*margin-right:\s*var\(--wb-titlebar-tab-right-clearance\)/s);
  assert.match(styles, /\.wb-pane-tabbar\.is-left-edge-pane\.is-right-edge-pane \.wb-object-tabs\s*\{[^}]*margin-right:\s*calc\(var\(--wb-sidebar-tab-offset\) \+ var\(--wb-titlebar-tab-right-clearance\)\)/s);
  assert.match(styles, /--wb-sidebar-tab-clearance:\s*var\(--wb-activity-rail-width\)/);
  assert.match(styles, /\.mysql-workbench\s*\{[^}]*--wb-sidebar-tab-offset:\s*max\(0px, calc\(var\(--wb-sidebar-tab-clearance\) - var\(--wb-activity-rail-width\) - var\(--wb-sidebar-slot-width\)\)\)/s);
  assert.doesNotMatch(styles, /wb-quick-open-entry/);
  assert.match(styles, /\.mysql-workbench\s*\{[^}]*--wb-titlebar-tab-right-clearance:\s*0px/s);
  assert.match(styles, /\.mysql-workbench\.is-inspector-collapsed\s*\{[^}]*--wb-titlebar-tab-right-clearance:\s*var\(--wb-titlebar-collapsed-controls-clearance\)/s);
  assert.match(styles, /\.wb-titlebar-sidebar\.is-retracted \.wb-sidebar-actions\s*\{[^}]*max-width:\s*0/s);
  assert.match(styles, /\.wb-titlebar-tabs\s*\{/);
  assert.match(styles, /\.wb-titlebar-inspector-controls\.is-collapsed\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.wb-titlebar-inspector-controls\.is-collapsed\s*\{[^}]*right:\s*var\(--wb-titlebar-inspector-toggle-right\)/s);
  assert.match(styles, /\.wb-titlebar-inspector-controls\.is-collapsed\s*\{[^}]*justify-content:\s*center/s);
  assert.match(styles, /\.wb-pane-tabbar\s*\{/);
  assert.match(styles, /\.wb-workbench-pane\s*>\s*\.wb-pane-tabbar\s*\{/);
  assert.doesNotMatch(styles, /\.wb-topbar-pane-tabs\s*\{/);
  assert.match(styles, /\.wb-sidebar\.is-collapsed,[\s\S]*?\.wb-inspector\.is-collapsed\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(styles, /\.wb-source-tree\s*\{[^}]*padding:\s*0 6px 8px/s);
  assert.match(styles, /\.wb-sidebar-settings-sheet\s*\{[^}]*position:\s*fixed/s);
});

test("split panes render independent tabbars at the top of each pane", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const styles = read("./workbench.css");

  assert.doesNotMatch(orchestrator, /<WorkbenchTopbarTabs/);
  assert.match(orchestrator, /<div[\s\S]*?class="wb-titlebar-tabs"[\s\S]*?id="wb-topbar-tabs"[\s\S]*?<\/div>/);
  assert.match(pane, /import\s+WorkbenchTabs\s+from\s+["']\.\/WorkbenchTabs\.vue["']/);
  assert.doesNotMatch(pane, /<Teleport\s+defer\s+to="#wb-topbar-tabs"/);
  assert.doesNotMatch(pane, /v-show="isFocused"/);
  assert.match(pane, /<header\s+class="wb-pane-tabbar"/);
  assert.match(pane, /<WorkbenchTabs/);
  assert.match(pane, /:tabs="tabs"/);
  assert.match(pane, /:active-tab-id="pane\.activeTabId"/);
  assert.match(pane, /@activate-tab="activateTab"/);
  assert.match(pane, /@reorder-tab="reorderTab"/);
  assert.match(pane, /<DataGrid\b[\s\S]*?v-if="activeDataTab"/);
  assert.doesNotMatch(pane, /<template #toolbar-tabs>/);
  assert.doesNotMatch(pane, /class="wb-toolbar-tabbar"/);
  assert.match(pane, /@split-pane="splitPaneFromToolbar"/);
  assert.match(pane, /function\s+openSplitMenuFromToolbar/);
  assert.match(pane, /function\s+splitPaneFromToolbar/);
  assert.match(pane, /class="wb-split-more-btn"/);
  assert.doesNotMatch(grid, /<slot name="toolbar-tabs"><\/slot>/);
  assert.match(grid, /ToolbarSplitButton/);
  assert.match(grid, /'split-pane'/);
  assert.match(grid, /emit\('split-pane', 'right'\)/);
  assert.doesNotMatch(grid, /wb-split-more-btn/);
  assert.match(styles, /\.wb-pane-tabbar\s*\{/);
  assert.match(styles, /\.wb-pane-tabbar\s+\.wb-object-tabs\s*\{/);
  assert.match(styles, /\.wb-workbench-pane\s*>\s*\.wb-pane-tabbar\s*\{/);
  assert.doesNotMatch(styles, /\.wb-topbar-pane-tabs\s*\{/);
  assert.doesNotMatch(styles, /\.wb-toolbar-tabbar\s*\{/);
  assert.match(styles, /\.wb-split-more-btn/);
});

test("table actions are direct in data tabs while non-data panes keep fallback choices", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const menuMatch = pane.match(/<menu[\s\S]*?class="wb-split-menu is-floating"[\s\S]*?<\/menu>/);
  assert.ok(menuMatch, "split options menu should render in WorkbenchPane");
  const menu = menuMatch[0];

  assert.match(pane, /function\s+exportFromMenu/);
  assert.match(pane, /function\s+importFromMenu/);
  assert.match(menu, /@click="exportFromMenu"/);
  assert.match(menu, /@click="importFromMenu"/);
  assert.match(menu, /:disabled="busy \|\| !activeDataTab"/);
  assert.match(menu, /:disabled="busy \|\| !activeDataTab\?\.sessionId \|\| !canImportActive"/);
  assert.match(menu, /@click="splitPaneFromMenu\('right'\)"/);
  assert.match(menu, /@click="splitPaneFromMenu\('down'\)"/);
  assert.match(
    menu,
    /@click="exportFromMenu"[\s\S]*@click="importFromMenu"[\s\S]*@click="splitPaneFromMenu\('right'\)"[\s\S]*@click="splitPaneFromMenu\('down'\)"/,
  );
  assert.match(grid, /label="导出"[\s\S]*?@primary="emit\('export'\)"/);
  assert.match(grid, /:label="importActions\.primary\.label"[\s\S]*?@primary="emit\(resolveTableImportToolbarEvent\(importActions\.primary\.id\)\)"/);
  assert.match(grid, /label="分屏"[\s\S]*?@primary="emit\('split-pane', 'right'\)"/);
  assert.match(grid, /批量导出/);
  assert.doesNotMatch(grid, /title="更多选项"/);
  assert.match(pane, /title="更多选项"/);
  assert.match(pane, /aria-label="更多选项"/);
});

test("theme palettes style the full workbench and its sidebar settings control", () => {
  const styles = read("./workbench.css");
  const darkRule = cssRuleBody(styles, DARK_THEME_SELECTOR);

  assert.match(styles, /\.mysql-workbench\[data-theme="light"\]\s*\{[\s\S]*color-scheme:\s*light/);
  assert.match(darkRule, /color-scheme:\s*dark/);
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
  assert.doesNotMatch(styles, /\.wb-sidebar-settings-trigger|\.wb-sidebar-settings-icon|\.wb-sidebar-settings-dock/);
  assert.match(styles, /\.wb-sidebar-settings-sheet\s*\{/);
  assert.match(styles, /\.wb-sidebar-theme-segment\s*\{/);
  assert.match(styles, /\.wb-sidebar-settings-label\s*\{[^}]*font-size:\s*var\(--wb-fs-body\)/s);
  assert.match(styles, /\.wb-sidebar-settings-label svg\s*\{[^}]*width:\s*17px/s);
  assert.match(styles, /\.wb-sidebar-theme-segment button\s*\{[^}]*font-size:\s*var\(--wb-fs-body\)/s);
  assert.doesNotMatch(styles, /\.wb-sidebar-settings-dock\s*\{/);
  assert.match(styles, /\.wb-sidebar\s*\{[^}]*position:\s*relative/s);
  assert.match(styles, /\.wb-grid-shell\s*\{[^}]*background:\s*var\(--wb-workspace-mist-canvas\)/s);
  assert.match(styles, /\.wb-grid-wrap\s*\{[^}]*background:\s*var\(--wb-workspace-mist-canvas\)/s);
  assert.match(styles, /\.wb-grid-wrap\s*\{[^}]*overflow-anchor:\s*none/s);
  assert.match(styles, /\.wb-cell-identity\.is-panel\s*\{[^}]*background:[^}]*var\(--wb-glass-strong\)/s);
  assert.match(styles, /\.wb-workspace\s*\{[^}]*background:\s*var\(--wb-chrome-surface\)/s);
  assert.match(styles, /\.wb-sidebar\s*\{[^}]*background:\s*var\(--wb-chrome-surface\)/s);
});

test("grid readability uses comfortable density and stronger theme contrast tokens", () => {
  const styles = read("./workbench.css");
  const constants = read("./constants.js");
  const rootRule = styles.match(/:root\s*\{([^}]*)\}/s)?.[1] || "";
  const darkRule = cssRuleBody(styles, DARK_THEME_SELECTOR);

  assert.match(constants, /GRID_ROW_HEIGHT\s*=\s*28/);
  assert.match(styles, /\.wb-grid\s*\{[^}]*font-size:\s*var\(--wb-fs-body\)/s);
  assert.match(styles, /\.wb-grid th,\s*\.wb-grid td\s*\{[^}]*height:\s*var\(--wb-grid-row-height,\s*28px\)/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*height:\s*var\(--wb-grid-cell-height,\s*27px\)/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*line-height:\s*var\(--wb-grid-cell-height,\s*27px\)/s);
  assert.match(rootRule, /--wb-quiet-text:\s*#4f5661/);
  assert.match(rootRule, /--wb-grid-row:\s*#f9f9f7/);
  assert.match(rootRule, /--wb-mark-surface:\s*rgba\(255,\s*196,\s*0,\s*0\.55\)/);
  assert.match(darkRule, /--wb-grid-row:\s*#0f0f11/);
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

test("operation feedback messages remain available to assistive tech", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /class="wb-operation-status-live wb-visually-hidden"/);
  assert.match(orchestrator, /role="status"/);
  assert.match(orchestrator, /aria-live="polite"/);
  assert.match(orchestrator, /\{\{\s*statusText\s*\}\}/);
  assert.doesNotMatch(orchestrator, /<footer class="wb-grid-statusbar"/);
  assert.match(styles, /\.wb-operation-status-live\.is-error\s*\{/);
});

test("cell save feedback floats beside the saved cell", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const editor = read("./composables/useGridEditor.js");
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
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
  assert.match(grid, /:data-column-name="columnMeta\.name"/);
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
  assert.match(inspector, /function\s+columnRemark\(column\)\s*\{\s*return columnComment\(column\);\s*\}/s);
  assert.doesNotMatch(inspector, /startSchemaListDrag/);
  assert.doesNotMatch(inspector, /schemaListDrag/);
  assert.doesNotMatch(inspector, /is-dragging/);
  assert.match(inspector, /:class="\{\s*'is-selected':\s*isSelectedColumn\(column\)\s*\}"/);
  assert.match(inspector, /v-if="columnRemark\(column\)"/);
});

test("inspector remark list keeps text selectable without triggering field navigation", () => {
  const inspector = read("./components/InspectorPanel.vue");
  const styles = read("./workbench.css");
  const schemaListRule = styles.match(/\.wb-schema-list\s*\{([^}]*)\}/s)?.[1] || "";
  const schemaCopyRule = styles.match(/\.wb-schema-field-copy\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(schemaListRule, /overflow:\s*auto/);
  assert.doesNotMatch(schemaListRule, /user-select:\s*none/);
  assert.doesNotMatch(schemaListRule, /cursor:\s*grab/);
  assert.doesNotMatch(styles, /\.wb-schema-list\.is-dragging/);
  assert.doesNotMatch(styles, /\.wb-schema-list\.is-dragging\s*\{[^}]*cursor:\s*grabbing/s);
  assert.match(schemaCopyRule, /user-select:\s*text/);
  assert.match(schemaCopyRule, /cursor:\s*text/);
  assert.match(inspector, /function\s+hasTextSelectionWithin\(element\)/);
  assert.match(inspector, /selection\.getRangeAt\(0\)\.intersectsNode\(element\)/);
  assert.match(inspector, /event\?\.detail\s*>\s*0\s*&&\s*hasTextSelectionWithin\(event\.currentTarget\)/);
});

test("inspector scrolls the selected field remark into the visible list", () => {
  const inspector = read("./components/InspectorPanel.vue");

  assert.match(inspector, /function\s+scrollSelectedColumnIntoView/);
  assert.match(inspector, /data-schema-column/);
  assert.doesNotMatch(inspector, /has-current-cell/);
  assert.match(inspector, /watch\(\s*\(\)\s*=>\s*\[selectedCellKey\.value,\s*props\.activeColumns\.length\]/s);
  assert.match(inspector, /nextTick\(scrollSelectedColumnIntoView\)/);
  assert.match(inspector, /selectedColumn\.getBoundingClientRect\(\)/);
  assert.match(inspector, /visibleTargetScrollDelta/);
  assert.doesNotMatch(inspector, /wb-inspector-cell-panel/);
  assert.doesNotMatch(inspector, /occluderTop:\s*currentCellChip\?\.getBoundingClientRect\(\)\.top/);
  assert.match(inspector, /schemaListRef\.value\.scrollTop\s*\+=/);
});

test("inspector field remarks select the matching cell on the current visual row", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const inspector = read("./components/InspectorPanel.vue");
  const styles = read("./workbench.css");

  assert.match(inspector, /defineEmits\(\[\s*"contextmenu",\s*"select-column",\s*"schema-search",\s*"schema-search-previous",\s*"schema-search-next",\s*"open-relation",\s*"open-relations-review",\s*"open-table",\s*\]\)/);
  assert.match(inspector, /<article[\s\S]*class="wb-schema-column"/);
  assert.match(inspector, /role="button"/);
  assert.match(inspector, /tabindex="0"/);
  assert.doesNotMatch(inspector, /:disabled="!hasCurrentCell"/);
  assert.match(inspector, /@click="selectColumn\(column,\s*\$event\)"/);
  assert.match(inspector, /@keydown\.enter\.prevent="selectColumn\(column\)"/);
  assert.match(inspector, /@keydown\.space\.prevent="selectColumn\(column\)"/);
  assert.match(inspector, /emit\("select-column",\s*columnName\(column\)\)/);
  assert.match(orchestrator, /selectCurrentRowColumn:\s*null/);
  assert.match(orchestrator, /@select-column="focusedPaneState\.selectCurrentRowColumn\?\.\(\$event\)"/);
  assert.match(pane, /function\s+selectCurrentRowColumn\(targetColumn\)/);
  assert.match(pane, /isInsertRowKey\(cell\.rowKey\)/);
  assert.match(pane, /visualRows\.visualIndexOfInsert\(insertRow\.id\)/);
  assert.match(pane, /visualRows\.visualIndexOfData\(dataRowIndex\)/);
  assert.match(pane, /visualRowIndex\s*=\s*0/);
  assert.match(pane, /selectGridFieldComment\(tab,/);
  assert.match(pane, /selectVisualCellAt\(tab,\s*visualRowIndex,\s*columnIndex\)/);
  assert.match(pane, /selectCurrentRowColumn,\s*\n\s*selectInsertCell/);
  assert.match(styles, /\.wb-schema-column\s*\{[^}]*cursor:\s*pointer/s);
  assert.match(styles, /\.wb-schema-column:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--wb-accent\)/s);
  assert.doesNotMatch(styles, /\.wb-schema-column:disabled/);
});

test("data grid does not refit field widths when the window is resized", () => {
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const observer = grid.match(/resizeObserver = new ResizeObserver\(\(\) => \{[\s\S]*?\}\);/);

  assert.ok(observer, "expected a grid ResizeObserver");
  assert.doesNotMatch(observer[0], /autoFitDebounced|autoFitColumns|performAutoFit/);
});

test("data grid column headers can be dragged to reorder fields without leaving the freeze band", () => {
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const menu = read("./components/ContextMenu.vue");
  const orchestrator = read("./MySqlWorkbench.vue");
  const styles = read("./workbench.css");

  assert.match(grid, /useColumnReorder/);
  assert.match(grid, /columnReorderSurfaceState/);
  assert.match(grid, /@pointerdown\.left="onColumnHeaderPointerDown\(tab, columnMeta, \$event\)"/);
  assert.match(grid, /emit\("reorder-columns"/);
  assert.match(grid, /wb-column-drop-line/);
  assert.match(grid, /wb-column-drag-ghost/);
  assert.match(grid, /columnReorderSurface\.reordering/);
  assert.match(grid, /columnReorderSurface\.forbidden/);
  assert.doesNotMatch(grid, /is-reordering-columns': columnReorder\.dragging/);
  assert.match(pane, /function\s+reorderGridColumns/);
  assert.match(pane, /@reorder-columns="reorderGridColumns"/);
  assert.match(pane, /resetGridColumnOrder/);
  assert.match(menu, /恢复默认列顺序/);
  assert.match(menu, /reset-column-order/);
  assert.match(orchestrator, /canResetColumnOrder/);
  assert.match(orchestrator, /fromColumnHeader/);
  assert.match(orchestrator, /@reset-column-order="onResetColumnOrder"/);
  assert.match(styles, /\.wb-grid th:not\(\.wb-row-index\)\s*\{[^}]*cursor:\s*grab/s);
  assert.match(styles, /\.is-column-drop-forbidden/);
  assert.doesNotMatch(grid, /is-forbidden/);
  assert.doesNotMatch(styles, /\.wb-column-drop-line\.is-forbidden/);
});

test("schema search hits highlight table headers and inspector remarks with dedicated navigation", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const inspector = read("./components/InspectorPanel.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /schemaSearchMatches/);
  assert.match(orchestrator, /openSidebarSchemaResult/);
  assert.match(orchestrator, /setSchemaSearchMatches/);
  assert.match(orchestrator, /@schema-search="focusedPaneState\.applyColumnSearch/);
  assert.match(orchestrator, /@schema-search-next="focusedPaneState\.goToNextSchemaSearchMatch/);
  assert.match(pane, /schemaSearchMatches/);
  assert.match(pane, /applyColumnSearch/);
  assert.match(pane, /applyTabColumnSearch/);
  assert.match(pane, /goToNextSchemaSearchMatch/);
  assert.match(pane, /goToPreviousSchemaSearchMatch/);
  assert.match(pane, /schema-search-next/);
  assert.match(grid, /schemaSearchSummary/);
  assert.doesNotMatch(grid, /wb-column-search-field/);
  assert.doesNotMatch(grid, /字段名或备注/);
  assert.match(grid, /schema-search-match/);
  assert.match(grid, /isSchemaSearchColumn/);
  assert.match(inspector, /schemaSearchQuery/);
  assert.match(inspector, /搜索字段名或备注/);
  assert.match(inspector, /displayedColumns/);
  assert.match(inspector, /highlightSearchText/);
  assert.match(inspector, /isSchemaSearchColumn/);
  assert.match(styles, /\.wb-schema-search-nav/);
  assert.doesNotMatch(styles, /\.wb-column-search-field/);
  assert.match(styles, /\.wb-inspector-search/);
  assert.match(styles, /\.wb-grid th\.schema-search-match/);
  assert.match(styles, /\.wb-schema-column\.schema-search-match/);
});

test("schema search navigation buttons move the local pane match", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const nextHandler = pane.match(/function\s+handleSchemaSearchNext\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const previousHandler = pane.match(/function\s+handleSchemaSearchPrevious\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(nextHandler, /goToNextSchemaSearchMatch\(\)/);
  assert.match(previousHandler, /goToPreviousSchemaSearchMatch\(\)/);
  assert.doesNotMatch(nextHandler, /emit\("schema-search-next"\)/);
  assert.doesNotMatch(previousHandler, /emit\("schema-search-previous"\)/);
});

test("cell detail panel is a collapsible pane with a persistent title bar", () => {
  const cellDetail = read("./components/CellDetailPanel.vue");
  const visibility = read("./cellDetailVisibility.js");

  // Collapse state, persistence and the auto-expand rule live in the state
  // module; the component only consumes it.
  assert.match(cellDetail, /createCellDetailVisibility/);
  assert.match(cellDetail, /notifySelectedText/);
  assert.match(visibility, /CELL_DETAIL_AUTO_EXPAND_LENGTH\s*=\s*80/);
  assert.match(visibility, /dbscout_cell_detail_collapsed/);
  assert.match(visibility, /dbscout_cell_detail_json_pretty/);
  assert.match(visibility, /value\.length\s*>\s*CELL_DETAIL_AUTO_EXPAND_LENGTH/);
  assert.match(visibility, /value\.includes\("\\n"\)/);
  assert.match(visibility, /state\.collapsed\s*&&\s*shouldAutoExpandCellDetail\(text\)/);

  // Slim title bar (label + chevron toggle) is rendered in both states; the
  // collapsed bar expands on click anywhere, the expanded bar only via the
  // chevron. Selected-cell stats replace the static title when a range exists.
  const pane = read("./components/WorkbenchPane.vue");
  assert.match(pane, /createSelectionStatsScan/);
  assert.match(pane, /:selection-stats="selectionStats"/);
  assert.match(cellDetail, /class="wb-cell-detail-header"/);
  assert.match(cellDetail, /class="wb-cell-detail-title">单元格内容<\/span>/);
  assert.match(cellDetail, /class="wb-cell-detail-stats"/);
  assert.match(cellDetail, /v-for="item in selectionStats\.items"/);
  assert.match(cellDetail, /class="wb-cell-detail-format"/);
  assert.match(cellDetail, /v-if="showJsonFormatToggle"/);
  assert.match(cellDetail, /:aria-pressed="String\(jsonPretty\)"/);
  assert.match(cellDetail, /@click\.stop="setJsonPretty\(true\)"/);
  assert.match(cellDetail, />原始</);
  assert.match(cellDetail, /class="wb-cell-detail-toggle"/);
  assert.match(cellDetail, /<ChevronUp\s+v-if="isPanelCollapsed"/);
  assert.match(cellDetail, /<ChevronDown\s+v-else/);
  assert.match(cellDetail, /@click\.stop="togglePanel"/);
  assert.match(cellDetail, /@click="onHeaderClick"/);
  assert.match(cellDetail, /if \(isPanelCollapsed\.value\) expandPanel\(\)/);

  // The editor region animates away below the title bar (height 0 + hidden
  // from AT/tab order), giving the grid its space back smoothly.
  assert.match(cellDetail, /class="wb-cell-detail-content"\s*:style="contentStyle"\s*:aria-hidden="isPanelCollapsed"/);
  assert.match(cellDetail, /\{ height: "0px", opacity: "0" \}/);
  assert.match(cellDetail, /:tabindex="isPanelCollapsed \? -1 : 0"/);

  // The resize handle stays available while expanded and can still collapse
  // the panel by dragging it to the floor.
  assert.match(cellDetail, /ref="rootRef"/);
  assert.match(cellDetail, /const\s+COLLAPSE_SNAP_THRESHOLD\s*=\s*24/);
  assert.match(cellDetail, /class="wb-cell-detail-handle"/);
  assert.match(cellDetail, /role="separator"/);
  assert.match(cellDetail, /aria-orientation="horizontal"/);
  assert.match(cellDetail, /@mousedown="onDividerMouseDown"/);
  assert.match(cellDetail, /@keydown="onDividerKeydown"/);
  assert.match(cellDetail, /class="wb-cell-detail-body"\s*:style="detailPanelStyle"/);
  assert.match(cellDetail, /if \(detailHeight\.value <= COLLAPSE_SNAP_THRESHOLD\) \{[\s\S]*?collapsePanel\(\)/);
  assert.match(cellDetail, /const\s+COMPACT_HEIGHT\s*=\s*72/);
  assert.match(cellDetail, /isCompact/);
  assert.match(cellDetail, /'is-compact':\s*isCompact/);
  assert.match(cellDetail, /@dblclick="detailHeight = clampDetailHeight\(DETAIL_DEFAULT_HEIGHT\)"/);
  assert.match(cellDetail, /event\.key === "Home"/);
});

test("semantic text tokens keep metadata and support content readable in both themes", () => {
  const styles = read("./workbench.css");
  const rootRule = styles.match(/:root\s*\{([^}]*)\}/s)?.[1] || "";
  const darkRule = cssRuleBody(styles, DARK_THEME_SELECTOR);

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
  assert.match(darkRule, /--wb-type-text:/);
  assert.match(darkRule, /--wb-remark-text:/);
  assert.match(rootRule, /--wb-field-comment-text:\s*var\(--wb-field-comment-custom,\s*var\(--wb-remark-text\)\)/);
  assert.match(darkRule, /--wb-field-comment-text:\s*var\(--wb-field-comment-custom,\s*var\(--wb-remark-text\)\)/);
  assert.match(darkRule, /--wb-database-text:/);
  assert.match(rootRule, /--wb-database-text:\s*#1a1c20/);
  assert.match(darkRule, /--wb-database-text:\s*#e2e4e8/);
  assert.match(styles, /\.wb-schema-field-type\s*\{[^}]*color:\s*var\(--wb-type-text\)/s);
  assert.match(styles, /\.wb-schema-field-comment\s*\{[^}]*color:\s*var\(--wb-field-comment-text\)[^}]*font-size:\s*var\(--wb-fs-body\)[^}]*line-height:\s*1\.6/s);
  assert.match(styles, /\.wb-schema-key-badge\s*\{[^}]*color:\s*var\(--wb-accent-strong\)/s);
  assert.match(styles, /\.wb-schema-column\.is-selected\s*\{[^}]*background:\s*var\(--wb-accent-soft\)/s);
  assert.match(styles, /\.wb-database-item\s*\{[^}]*color:\s*var\(--wb-database-text\)/s);
  assert.match(styles, /\.wb-database-item\s*\{[^}]*font-size:\s*var\(--wb-fs-body\)/s);
  assert.match(styles, /\.wb-database-item \.wb-tree-label\s*\{[^}]*align-items:\s*center/s);
  assert.match(styles, /\.wb-database-item \.wb-tree-label\s*\{[^}]*line-height:\s*16px/s);
  assert.match(styles, /\.wb-table-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)[^}]*font-size:\s*var\(--wb-fs-body\)/s);
  assert.match(styles, /\.wb-tab-title small\s*\{[^}]*color:\s*var\(--wb-type-text\)/s);
  assert.match(styles, /\.wb-inspector-table-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)[^}]*font-size:\s*var\(--wb-fs-body\)/s);
  assert.match(styles, /\.wb-cell-identity-label,[\s\S]*?\.wb-cell-identity-count\s*\{[^}]*color:\s*var\(--wb-quiet-text\)/s);
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

// 详情编辑器是“透明 textarea 叠高亮 pre”的结构：光标位置按 textarea 的字体
// 度量绘制，因此高亮 token 只能改颜色。token 一旦加 font-weight/font-style，
// 字形变宽而光标不变，表现为点行尾字符光标落在前一字符前、按方向键右直接
// 跳行（详见 wb-token-* 规则旁的注释）。
test("detail highlight tokens only recolor text so caret stays aligned", () => {
  const styles = read("./workbench.css");

  for (const token of ["key", "function", "string", "number", "literal", "keyword", "comment"]) {
    const rule = styles.match(new RegExp(`\\.wb-token-${token}[^{]*\\{([^}]*)\\}`, "s"))?.[1] || "";
    assert.ok(rule, `missing .wb-token-${token} rule`);
    assert.match(rule, /color:/, `.wb-token-${token} must recolor text`);
    assert.doesNotMatch(rule, /font-weight/, `.wb-token-${token} must not change font-weight`);
    assert.doesNotMatch(rule, /font-style/, `.wb-token-${token} must not change font-style`);
    assert.doesNotMatch(rule, /letter-spacing/, `.wb-token-${token} must not change letter-spacing`);
  }
});

test("virtual grid scroll observers clean up lifecycles", () => {
  const virtual = read("./composables/useVirtualGrid.js");

  assert.match(virtual, /onBeforeUnmount/);
  assert.match(virtual, /resizeObserver\.disconnect\(\)/);
});

test("grid edit mode keeps text metrics stable with a thin single focus ring", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*box-sizing:\s*border-box/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*height:\s*var\(--wb-grid-cell-height,\s*27px\)/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*line-height:\s*var\(--wb-grid-cell-height,\s*27px\)/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*font:\s*inherit/s);
  assert.match(styles, /\.wb-grid td input\s*\{[^}]*appearance:\s*none/);
  assert.match(styles, /\.wb-grid td input\s*\{[^}]*vertical-align:\s*top/);
  assert.match(styles, /\.wb-grid td input:focus\s*\{[^}]*outline:\s*none/);
  assert.match(styles, /\.wb-grid td\.editing\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--wb-accent\)/);
  assert.match(styles, /\.wb-grid td\.editing\s*\{[^}]*border-right-color:\s*transparent/);
  assert.match(styles, /\.wb-grid td\.editing\s*\{[^}]*max-height:\s*var\(--wb-grid-row-height,\s*28px\)/);
  assert.match(styles, /\.wb-grid td\.editing\s*\{[^}]*overflow:\s*hidden/);
  assert.doesNotMatch(styles, /\.wb-grid td\.editing input\s*\{[^}]*height:\s*28px/);
  assert.match(styles, /\.wb-grid-wrap:not\(:focus-within\) \.wb-grid td\.editing:not\(\.selected\),\s*\.wb-grid-wrap:not\(:focus-within\) \.wb-grid td\.selected\.editing\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--wb-accent\)/);
  assert.match(styles, /\.wb-grid td\.selected\.editing\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--wb-accent\)/);
  assert.doesNotMatch(styles, /\.wb-grid td\.selected\.editing\s*\{[^}]*outline:\s*2px solid var\(--wb-accent-strong\)/);
  assert.match(styles, /\.wb-grid td\.editing\.range-top::before,\s*\.wb-grid td\.editing\.range-bottom::before\s*\{[^}]*height:\s*1px/);
  assert.match(styles, /\.wb-grid td\.editing\.range-left::after,\s*\.wb-grid td\.editing\.range-right::after\s*\{[^}]*width:\s*1px/);
  assert.match(styles, /\.wb-grid td\.editing\.range-top\.range-bottom::before\s*\{[^}]*top \/ 100% 1px no-repeat/);
  assert.match(styles, /\.wb-grid td\.editing\.range-left\.range-right::after\s*\{[^}]*left \/ 1px 100% no-repeat/);
  assert.match(styles, /\.wb-grid td\.editing input,\s*\.wb-grid td\.selected\.editing input\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--wb-accent\)/);
  assert.match(styles, /\.wb-grid td\.selected:not\(\.range-selected\)\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--wb-accent\)/);
  assert.doesNotMatch(styles, /\.wb-grid td input\s*\{[^}]*height:\s*100%/);
  assert.doesNotMatch(styles, /\.wb-grid td\.selected input\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--wb-accent\)/);
  assert.doesNotMatch(styles, /\.wb-grid td input:focus\s*\{[^}]*outline:\s*2px solid var\(--wb-accent\)/);
});

test("data grid uses row headers and insert-row keyboard wiring", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const split = read("./components/WorkbenchSplitLayout.vue");
  const dataGrid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const styles = read("./workbench.css");
  const frozenRowsTemplate = dataGrid.match(/<template v-if="frozenRowCount > 0">[\s\S]*?<\/template>/)?.[0] || "";

  assert.doesNotMatch(dataGrid, /type="checkbox"/);
  assert.doesNotMatch(dataGrid, /wb-select-all/);
  assert.match(dataGrid, /wb-row-index-corner/);
  assert.match(dataGrid, /wb-row-header/);
  assert.match(dataGrid, /'is-row-selecting':\s*isRowDragging/);
  assert.match(styles, /\.wb-grid-wrap\.is-row-selecting\s+\.wb-row-resize-handle\s*\{[^}]*cursor:\s*default;[^}]*pointer-events:\s*none;/s);
  assert.match(dataGrid, /:frozen-style="frozenRowStyles\[frozenIndex\]"/);
  // 行号使用视觉行号（含 anchored 草稿位移），不再用原始 originalIndex + 1
  assert.doesNotMatch(dataGrid, />\{\{ originalIndex \+ 1 \}\}</);
  assert.match(frozenRowsTemplate, /rowModel\(row, rowKey, originalIndex, dataRowVisualIndex\(originalIndex\)/);
  assert.match(dataGrid, /:data-visual-row-index="visualIndex"/);
  assert.doesNotMatch(frozenRowsTemplate, /:data-visual-row-index="originalIndex"/);
  assert.match(dataGrid, /row-selected/);
  assert.match(dataGrid, /:data-row-key="rowKey"[\s\S]*'row-selected':\s*rowSelected[\s\S]*'search-match':\s*hasActiveCellSearch\s*&&\s*isSearchMatch/);
  assert.match(dataGrid, /insert-keydown/);
  assert.match(dataGrid, /selectedInsertCell/);
  assert.match(dataGrid, /selectedInsertRow/);
  assert.match(dataGrid, /isInsertRowVisible/);
  assert.match(dataGrid, /getInsertRows/);
  assert.match(dataGrid, /getVisibleInsertRows/);
  assert.match(dataGrid, /insertAwareVisualRowIndex/);
  assert.match(dataGrid, /getInsertRowKey/);
  assert.doesNotMatch(dataGrid, /insert-commit/);
  assert.doesNotMatch(dataGrid, /insert-save-all/);
  assert.match(dataGrid, /function\s+anchoredInsertVisualIndex\(originalIndex,\s*insertRowIndex\)/);
  assert.match(dataGrid, /function\s+dataRowVisualIndex\(originalIndex\)/);
  assert.match(dataGrid, /anchoredInsertVisualIndex\(originalIndex,\s*insertRowIndex\)/);
  assert.doesNotMatch(dataGrid, /v-for="insertRow in isInsertRowVisible\(tab\) \? anchoredInsertRowsAt\(originalIndex\) : \[\]"/);
  assert.doesNotMatch(dataGrid, /emit\('cell-dblclick', tab, insertRowObject\(insertRow\), columnName\(column\), originalIndex, columnIndex\)/);
  assert.match(dataGrid, /保存新增行/);
  assert.match(dataGrid, /取消新增行/);
  assert.match(pane, /@save-insert-row="saveInsertDraftRow"/);
  assert.match(pane, /@cancel-insert-row="cancelInsertDraftRow"/);
  assert.match(dataGrid, /v-for="\(insertRow, insertRowIndex\) in trailingInsertRows"/);
  assert.doesNotMatch(dataGrid, /v-for="\(insertRow, insertRowIndex\) in isInsertRowVisible\(tab\) \? trailingInsertRows : \[\]"/);
  assert.match(dataGrid, /trailingInsertVisualIndex\(insertRowIndex\) \+ 1/);
  assert.doesNotMatch(dataGrid, /tab\.rows\.length \+ insertRowIndex \+ 1/);
  assert.doesNotMatch(dataGrid, /insertRowIndex \+ 1 \}\}\*/);
  assert.match(dataGrid, /:data-row-key="insertRowKey\(tab, insertRow\)"/);
  assert.match(dataGrid, /:data-column-name="columnMeta\.name"/);
  assert.match(dataGrid, /:data-column-index="columnMeta\.columnIndex"/);
  assert.match(dataGrid, /cellRangeClasses\(tab, insertRowKey\(tab, insertRow\), columnMeta\.name, trailingInsertVisualIndex\(insertRowIndex\), columnMeta\.columnIndex\)/);
  assert.match(dataGrid, /@mousedown\.left="onCellRangeStart\(tab, insertRowObject\(insertRow\), columnMeta\.name, trailingInsertVisualIndex\(insertRowIndex\), columnMeta\.columnIndex, \$event\)"/);
  assert.match(dataGrid, /function insertCellEditing\(insertRow, column\)/);
  assert.match(dataGrid, /editingCell\?\.rowKey === insertRowKey\(props\.tab, insertRow\)/);
  assert.match(dataGrid, /insertEditorVisible\(insertRow, columnMeta\.name\)/);
  assert.match(dataGrid, /data-ime-editor/);
  assert.match(dataGrid, /onCellEditorKeydown/);
  assert.match(dataGrid, /insertRowCellValueByName\(tab, insertRow, columnMeta\.name\)/);
  assert.match(dataGrid, /is-unsaved/);
  assert.match(dataGrid, /title="新增未保存"/);
  assert.match(dataGrid, /data-insert-row-id/);
  assert.match(dataGrid, /onCellEditorKeydown/);
  assert.match(read("./utils/imeInput.js"), /isImeKeyEvent\(event\)/);
  assert.match(read("./utils/imeInput.js"), /event\.key === "Escape"/);
  assert.match(read("./utils/imeInput.js"), /event\.key === "Tab"/);
  assert.match(dataGrid, /@paste="emit\('paste', \$event\)"/);
  assert.match(pane, /@paste="handleGridPaste"/);
  assert.match(pane, /event\.clipboardData\?\.getData\("text\/plain"\)/);
  assert.match(pane, /pasteShortcut && !editingCell\.value/);
  assert.doesNotMatch(dataGrid, /@paste\.prevent\.stop="emit\('insert-paste'/);
  assert.match(dataGrid, /@paste="emit\('insert-paste', tab, insertRow\.id, columnMeta\.columnIndex, \$event\)"/);
  assert.match(dataGrid, /insert-row-select/);
  assert.match(dataGrid, /@click\.stop="emit\('insert-row-select', tab, insertRow\.id, \$event\)"/);
  assert.match(dataGrid, /@contextmenu\.prevent\.stop="emit\('row-contextmenu', \$event, row, originalIndex\)"/);
  assert.match(dataGrid, /@contextmenu\.prevent\.stop="emit\('row-contextmenu', \$event, tab, insertRowObject\(insertRow\), anchoredInsertVisualIndex\(originalIndex, insertRowIndex\)\)"/);
  assert.match(dataGrid, /@contextmenu\.prevent\.stop="emit\('row-contextmenu', \$event, tab, insertRowObject\(insertRow\), trailingInsertVisualIndex\(insertRowIndex\)\)"/);
  assert.match(dataGrid, /row-select-start/);
  assert.match(dataGrid, /row-select-pointer/);
  assert.match(dataGrid, /row-select-end/);
  assert.doesNotMatch(dataGrid, /wb-batch-bar/);
  assert.match(pane, /function\s+selectGridRow/);
  assert.match(pane, /function\s+startGridRowDragSelection/);
  assert.match(pane, /extendRowDragSelectionFromPointer/);
  assert.match(pane, /finishRowDragSelection/);
  assert.match(pane, /function\s+selectGridInsertRow/);
  assert.match(pane, /:selected-insert-row="selectedInsertRow"/);
  assert.match(pane, /:get-insert-rows="getInsertRows"/);
  assert.match(dataGrid, /emit\('insert-first-row', tab\)/);
  assert.match(pane, /@insert-first-row="insertDraftBelow"/);
  assert.match(dataGrid, /@click\.stop="emit\('append-row', tab\)"/);
  assert.match(pane, /@append-row="insertDraftBelow"/);
  const trailingInsertRowsPosition = dataGrid.indexOf('v-for="(insertRow, insertRowIndex) in trailingInsertRows"');
  const appendRowPosition = dataGrid.indexOf('class="wb-grid-append-row"');
  const loadingMorePosition = dataGrid.indexOf('v-if="tab.loadingMore"');
  assert.ok(trailingInsertRowsPosition < appendRowPosition, "末尾新增草稿应显示在新增入口上方");
  assert.ok(appendRowPosition < loadingMorePosition, "加载中状态应显示在新增入口下方");
  assert.doesNotMatch(dataGrid, /loadedRangeLabel|m_ff9c1fbf5115/);
  assert.match(dataGrid, /v-else-if="!tab\.fullyLoaded && loadedRowCount > 0" aria-hidden="true"/);
  assert.match(styles, /\.wb-grid-append-action\s*\{[^}]*min-height:\s*var\(--wb-grid-row-height,\s*28px\)/s);
  assert.match(styles, /\.wb-grid-append-action:hover,\s*\.wb-grid-append-action:focus-visible\s*\{[^}]*background:\s*var\(--wb-accent-soft\)/s);
  assert.match(pane, /:get-visible-insert-rows="getVisibleInsertRows"/);
  assert.match(pane, /:get-insert-row-key="getInsertRowKey"/);
  assert.match(pane, /:is-insert-row-visible="isInsertRowVisible"/);
  assert.match(pane, /:insert-aware-visual-row-index="insertAwareVisualRowIndex"/);
  assert.match(pane, /@insert-row-select="selectGridInsertRow"/);
  assert.match(pane, /@row-select-start="startGridRowDragSelection"/);
  assert.match(pane, /@row-select-pointer="extendGridRowDragSelection"/);
  assert.match(pane, /@row-select-end="finishRowDragSelection"/);
  assert.match(pane, /@row-contextmenu="openRowContextMenu"/);
  assert.match(pane, /function\s+deleteGridRow\(tab,\s*row\)/);
  assert.match(pane, /row\?\.__insertRowId[\s\S]*removeInsertDraftRow\(tab,\s*row\.__insertRowId\)/);
  assert.match(pane, /emit\("row-contextmenu", event, tab, row, originalIndex,[\s\S]*?canInsertCopiedRows: canInsertCopiedRows\(tab\)[\s\S]*?pasteCopiedRowsAbove/);
  assert.match(pane, /if \(!isTauriRuntime\(\)\) return createCopiedRowsAbove\(tab, target\)/);
  const paneEditorState = pane.match(/const\s+\{[\s\S]*?\}\s*=\s*editor;/)?.[0] || "";
  assert.match(paneEditorState, /insertDraftAbove/);
  assert.match(paneEditorState, /insertDraftBelow/);
  assert.match(paneEditorState, /insertDraftsAbove/);
  assert.match(paneEditorState, /insertDraftsBelow/);
  assert.match(pane, /deleteRow/);
  assert.match(pane, /insertDraftAbove,\s*\n\s*insertDraftBelow,\s*\n\s*insertDraftsAbove,\s*\n\s*insertDraftsBelow,/);
  assert.match(split, /["']row-contextmenu["']/);
  assert.match(split, /@row-contextmenu="\(\.\.\.args\) => emit\('row-contextmenu', \.\.\.args\)"/);
  assert.match(orchestrator, /@row-contextmenu="openActiveRowContextMenu"/);
  assert.match(orchestrator, /function\s+deleteGridRow\(tab,\s*row\)/);
  assert.match(orchestrator, /row\?\.__insertRowId[\s\S]*removeInsertDraftRow\(tab,\s*row\.__insertRowId\)/);
  assert.match(orchestrator, /openRowContextMenu\(event, tab, row, originalIndex, rowActions \|\| fallback\)/);
  assert.match(orchestrator, /selectedRowCount:\s*tab\?\.selectedRowKeys\?\.size \|\| 0/);
  assert.match(orchestrator, /contextMenuDeleteLabel = computed\(\(\)\s*=>\s*\{[\s\S]*?删除 \$\{count\} 行[\s\S]*?\}\)/);
  assert.match(orchestrator, /:delete-label="contextMenuDeleteLabel"/);
  assert.match(orchestrator, /selectedCount > 1 && rowInSelection/);
  assert.match(orchestrator, /contextMenu\.rowActions\?\.deleteSelectedRows/);
  assert.match(orchestrator, /removeSelected\(tab\)/);
  assert.match(orchestrator, /contextMenu\.rowTab \|\| activeDataTab\.value/);
  assert.match(orchestrator, /contextMenu\.rowActions\?\.\[actionName\]/);
  assert.match(orchestrator, /contextMenu\.rowActions\?\.deleteRow/);
  assert.match(orchestrator, /focusedPaneState\[actionName\]/);
  assert.match(orchestrator, /contextMenu\.rowActions\?\.pasteCopiedRowsAbove/);
  assert.match(orchestrator, /focusedPaneState\.pasteCopiedRowsAbove/);
  assert.match(orchestrator, /function\s+pasteCopiedRowsAboveFallback[\s\S]*?if \(!isTauriRuntime\(\)\) return insertCopiedRowsAbove\(tab, target\)/);
  assert.match(orchestrator, /focusedPaneState\.deleteRow/);
  assert.match(orchestrator, /@grid-row-insert-below="onGridRowInsertBelow"/);
  assert.doesNotMatch(orchestrator, /grid-row-insert-multiple/);
  assert.match(orchestrator, /@grid-row-paste-above="onGridRowPasteAbove"/);
  assert.match(orchestrator, /insert\(tab, target, count\)/);
  assert.doesNotMatch(pane, /@insert-commit/);
  assert.doesNotMatch(orchestrator, /@pointerdown\.capture="maybeAutoSaveInsertDrafts"/);
  assert.doesNotMatch(orchestrator, /function\s+maybeAutoSaveInsertDrafts/);
  assert.doesNotMatch(pane, /function\s+maybeAutoSaveInsertDrafts/);
  assert.doesNotMatch(orchestrator, /hasInsertDrafts\(tab\)/);
  assert.match(orchestrator, /focusedPaneState\.commitInsertRowsAndRefresh/);
  // The detail editor save path now lives on the WorkbenchPane (CellDetailPanel
  // below the table) rather than the orchestrator's InspectorPanel bridge (#2/#3).
  assert.match(pane, /@save-text-panel="handleSaveTextPanel"/);
  assert.match(pane, /@commit-detail-draft="handleCommitDetailDraft"/);
  assert.match(pane, /async function refreshAfterInsertSave\(tab, draftSnapshot = null, \{ reselect = true \} = \{\}\)/);
  assert.match(pane, /props\.fetchPage\(tab, tab\.page \|\| 1, \{ skipInsertDraftCheck: true, inPlace: true \}\)/);
  assert.match(pane, /async function saveInsertDraftRow\(tab, rowId\) \{[\s\S]*?insertDraftSnapshotOf\(tab, rowId\)/);
  assert.match(orchestrator, /commitInsertRowsAndRefresh\(tab\)/);
  assert.match(pane, /clearSelection\(\)/);
  assert.match(pane, /handleGridKeydownWithRows/);
  assert.match(pane, /const result = await handleGridKeydown\(event\)/);
  assert.match(pane, /result\?\.insertedRows > 0 && !result\?\.failedRowId/);
  assert.match(orchestrator, /result\?\.insertedRows > 0 && !result\?\.failedRowId/);
  assert.match(pane, /refreshTabPage\(tab, tab\.page \|\| 1, \{ inPlace: true \}\)/);
  assert.match(pane, /async\s+function\s+prepareInsertDraftsForRefresh\(tab,\s*\{ excludeInsertRowIds = \[\] \} = \{\}\)/);
  assert.match(pane, /const confirmed = await confirmDialog\(\{[\s\S]*?insertDraftRefreshPrompt\(drafts\.length\)/);
  assert.match(pane, /新增行保存失败：\$\{result\.failedReason \|\| statusText\.value \|\| "请检查新增行输入"\}/);
  assert.match(pane, /if\s*\(result\?\.failedRowId\)\s*return;\s*\n\s*if\s*\(result\?\.insertedRows > 0\)/);
  assert.match(pane, /deleteSelectedRows\(tab\)/);
  assert.match(pane, /@insert-keydown="handleInsertKeydown"/);
  assert.match(pane, /@insert-paste="pasteIntoInsertInput"/);
  assert.match(pane, /clearInsertDraft\(tab\)/);
  assert.match(pane, /clearSelection\(\{ clearInsertDrafts: true \}\)/);
  assert.match(orchestrator, /clearInsertDraft\(tab\)/);
  assert.match(orchestrator, /clearSelection\(\{ clearInsertDrafts: true \}\)/);
  assert.doesNotMatch(dataGrid, /@keydown\.enter\.prevent\.stop="emit\('insert-commit'/);
  assert.match(pane, /function\s+matchesInsertedDraft/);
  assert.match(pane, /function\s+selectVisibleInsertedRow/);
  assert.match(styles, /\.wb-grid-row\.row-selected/);
  assert.match(cssRuleBody(styles, ".wb-grid td.search-match:not(.selected):not(.range-selected):not(.row-selected)"), /background:\s*var\(--wb-search-cell-surface\)/);
  assert.doesNotMatch(styles, /\.wb-grid td\.search-match:not\(\.selected\):not\(\.range-selected\)\s*\{/);
  assert.match(cssRuleBody(styles, ".wb-grid td.col-active:not(.selected):not(.error):not(.row-selected)"), /background:/);
  assert.match(styles, /\.wb-row-header/);
  assert.match(styles, /\.wb-insert-row td\.insert-selected/);
});

test("data grid wires Excel-like drag range selection", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const dataGrid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const styles = read("./workbench.css");

  assert.match(dataGrid, /cell-mousedown/);
  assert.match(dataGrid, /@mousedown\.left/);
  assert.match(dataGrid, /cell-enter/);
  assert.match(dataGrid, /@mouseenter/);
  assert.match(dataGrid, /range-pointer/);
  assert.match(dataGrid, /window\.addEventListener\(['"]mousemove['"],\s*continueRangeSelection\)/);
  assert.match(dataGrid, /range-end/);
  assert.match(dataGrid, /const isCellDragging = ref\(false\)/);
  assert.match(dataGrid, /function\s+onCellRangeStart[\s\S]*?event\.target\?\.closest\?\.\("input, textarea, select, \[contenteditable='true'\]"\)[\s\S]*?isCellDragging\.value = true;[\s\S]*?emit\('cell-mousedown'/);
  assert.match(dataGrid, /function\s+continueRangeSelection\(event\)\s*\{\s*if \(!isCellDragging\.value\) return;/);
  assert.doesNotMatch(dataGrid, /function\s+continueRangeSelection\(event\)\s*\{\s*if \(!props\.isSelectingRange\) return;/);
  assert.match(dataGrid, /function\s+endRangeSelection\(\)\s*\{\s*if \(!isCellDragging\.value\) return;\s*isCellDragging\.value = false;\s*emit\('range-end'\);/);
  assert.match(dataGrid, /'is-selecting-range': isSelectingRange \|\| isCellDragging/);
  assert.equal((dataGrid.match(/@mousedown\.left="onCellRangeStart\(/g) || []).length, 2);
  assert.equal((dataGrid.match(/@mouseup="endRangeSelection"/g) || []).length, 3);
  assert.doesNotMatch(dataGrid, /@mouseleave="emit\('range-end'\)"/);
  assert.match(dataGrid, /onCellEditorKeydown/);
  assert.match(read("./utils/imeInput.js"), /event\.key === "Enter"/);
  assert.match(read("./utils/imeInput.js"), /event\.key === "Tab"/);
  assert.equal((dataGrid.match(/@blur="emit\('cell-blur'\)"\s*\n\s*@dblclick\.stop/g) || []).length, 3);
  assert.match(pane, /@cell-mousedown="startGridRangeSelection"/);
  assert.match(pane, /function\s+startGridRangeSelection/);
  assert.match(pane, /startRangeSelection\(\.\.\.args\)/);
  assert.match(pane, /@cell-enter="extendRangeSelection"/);
  assert.match(pane, /@range-pointer="extendRangeSelectionFromPointer"/);
  assert.match(pane, /@range-end="finishRangeSelection"/);
  assert.match(dataGrid, /function\s+isRowInSelectedRange/);
  assert.match(dataGrid, /'row-range-active':\s*isRowInSelectedRange/);
  assert.match(styles, /\.wb-grid td\.selected:not\(\.range-selected\)/);
  assert.match(styles, /\.wb-grid-row\.row-range-active td/);
  assert.match(styles, /\.wb-grid td\.range-selected/);
  assert.match(styles, /\.wb-grid td\.range-top/);
  assert.match(styles, /\.wb-grid td\.range-bottom/);
  assert.match(styles, /\.wb-grid td\.range-left/);
  assert.match(styles, /\.wb-grid td\.range-right/);
  const rangeSelectedRule = styles.match(/\.wb-grid td\.range-selected\s*\{([^}]*)\}/s)?.[1] || "";
  assert.doesNotMatch(rangeSelectedRule, /border-color/);
  assert.match(rangeSelectedRule, /position:\s*relative/);
  assert.doesNotMatch(rangeSelectedRule, /box-shadow/);
  assert.match(styles, /\.wb-grid td\.range-top::before[\s\S]*?background:\s*var\(--wb-accent\)/);
  assert.match(styles, /\.wb-grid td\.range-selected \.wb-cell-text\s*\{[^}]*background:\s*var\(--wb-accent-soft\)/s);
  assert.match(styles, /\.wb-grid td\.selected \.wb-cell-text\s*\{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.wb-grid td\.range-anchor \.wb-cell-text\s*\{[^}]*background:\s*transparent/s);
  assert.match(styles, /\.wb-grid td\.range-top::before\s*\{[^}]*right:\s*-1px/s);
  assert.match(styles, /\.wb-grid td\.range-bottom::before\s*\{[^}]*right:\s*-1px/s);
  assert.match(styles, /\.wb-grid td\.range-left::after\s*\{[^}]*bottom:\s*-1px/s);
  assert.match(styles, /\.wb-grid td\.range-right::after\s*\{[^}]*bottom:\s*-1px/s);
  assert.match(styles, /\.wb-grid td\.range-top\.range-bottom::before/);
  assert.match(styles, /\.wb-grid td\.range-left\.range-right::after/);
});

test("data grid shows a fill handle overlay outside clipped cells", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const dataGrid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const styles = read("./workbench.css");

  assert.match(dataGrid, /class="wb-fill-handle"/);
  assert.match(dataGrid, /fill-start/);
  assert.match(dataGrid, /fill-pointer/);
  assert.match(dataGrid, /fill-end/);
  assert.match(dataGrid, /function\s+onFillHandleMouseDown/);
  assert.match(dataGrid, /@mousedown\.left\.stop\.prevent="onFillHandleMouseDown"/);
  assert.match(pane, /:show-fill-handle="showFillHandle"/);
  assert.match(pane, /@fill-start="startFillDrag"/);
  assert.match(pane, /@fill-option="applyFillOption"/);
  assert.match(styles, /\.wb-fill-handle\s*\{/);
  assert.match(cssRuleBody(styles, ".wb-fill-handle"), /background:\s*var\(--wb-accent\)/);
  assert.match(cssRuleBody(styles, ".wb-fill-handle"), /width:\s*var\(--wb-fill-handle-size\)/);
  assert.match(cssRuleBody(styles, ".wb-fill-handle"), /border:\s*0/);
  assert.match(cssRuleBody(styles, ".wb-fill-handle"), /appearance:\s*none/);
  assert.match(cssRuleBody(styles, ".wb-fill-handle"), /cursor:\s*var\(--wb-fill-cursor-light\)/);
  assert.match(cssRuleBody(styles, ".wb-fill-overlay"), /position:\s*absolute/);
  assert.match(dataGrid, /填充序列/);
  assert.match(dataGrid, /复制单元格/);
});

test("design debug exposes fill handle geometry only in debug mode", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const dialog = read("./components/DesignDebugDialog.vue");
  const styles = read("./workbench.css");

  assert.match(sidebar, /const isDev = import\.meta\.env\.DEV/);
  assert.match(sidebar, /<DesignDebugDialog[\s\S]*v-if="isDev"/);
  assert.match(dialog, /wb-design-debug-fill-pad/);
  assert.match(dialog, /fillHandleDeltaFromKey/);
  assert.match(dialog, /nudgeFill\('x', -1\)/);
  assert.match(styles, /\.wb-design-debug-fill-pad\s*\{/);
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

test("sidebar table rows expose F2 as the rename shortcut", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const listKeydown = sidebar.match(/function\s+handleTableListKeydown\(event\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(sidebar, /"rename-table"/);
  assert.match(listKeydown, /key === "F2" && plain[\s\S]*?emit\("rename-table", tablePayload\(table\)\)/);
  assert.match(listKeydown, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(sidebar, /class="wb-table-vlist"[\s\S]*?@keydown="handleTableListKeydown"/);
  assert.match(orchestrator, /function\s+openTableRenameFromSource/);
  assert.match(orchestrator, /@rename-table="openTableRenameFromSource"/);
});

test("sidebar connection and database rows rename with F2 and connections remove with Delete", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");

  assert.match(sidebar, /@keydown="handleConnectionKeydown\(\$event, connection\.id\)"/);
  assert.match(sidebar, /@keydown="handleDatabaseKeydown\(\$event, connection\.id, database\)"/);
  assert.match(sidebar, /function handleConnectionKeydown\(event, connectionId\)\s*\{[\s\S]*?emit\("rename-connection", \{ connectionId \}\)[\s\S]*?isDeleteCommandKey\(event\)[\s\S]*?emit\("remove-connection", \{ connectionId \}\)/);
  assert.match(sidebar, /function handleDatabaseKeydown\(event, connectionId, database\)\s*\{[\s\S]*?emit\("rename-database", \{ connectionId, database \}\)/);
  assert.match(orchestrator, /@remove-connection="confirmRemoveConnection"/);
  assert.match(orchestrator, /async function confirmRemoveConnection\(\{ connectionId = "" \} = \{\}\)\s*\{[\s\S]*?danger: true[\s\S]*?if \(!confirmed\) return;/);
});

test("sidebar Ctrl/Shift selection drives multi-open, delete and the context menu", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const menu = read("./components/ContextMenu.vue");

  assert.match(sidebar, /useSidebarTableSelection\(\{ tables: filteredTables, activeTableName \}\)/);
  assert.match(sidebar, /@click="onTableClick\(entry\.table, \$event\)"/);
  assert.match(sidebar, /@dblclick="onTableDoubleClick\(entry\.table\)"/);
  assert.match(sidebar, /'is-selected': tableSelection\.isMultiple\.value && tableSelection\.selectedSet\.value\.has\(entry\.table\.tableName\)/);
  assert.match(sidebar, /emit\("delete-tables", \{[\s\S]*?origin: "sidebar"/);
  assert.match(sidebar, /emit\("open-tables", \{ tables, activeName \}\)/);
  assert.match(orchestrator, /@open-tables="openTablesFromSidebar"/);
  assert.match(orchestrator, /@delete-tables="deleteHomeTables"/);
  assert.match(orchestrator, /async function openTablesFromSidebar\([\s\S]*?confirmOpeningTables\(tables\.length/);
  assert.match(orchestrator, /openTable\(table, \{ paneId, activate: tableName === activeName \}\)/);
  assert.match(menu, /v-if="showSidebarTableActions"[^>]*@click="emit\('open-tables'\)"/);
  assert.match(menu, /v-if="showSidebarTableActions"[^>]*class="danger"[^>]*:disabled="!canDeleteTables"[^>]*@click="emit\('delete-tables'\)"/);
  assert.match(orchestrator, /@open-tables="openTablesFromContextMenu"/);
  assert.match(orchestrator, /@delete-tables="deleteTablesFromContextMenu"/);
});

test("Ctrl+P opens the Quick Open palette from anywhere (sidebar collapsed or not)", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");

  // The orchestrator registers a capture-phase listener that cancels the native
  // print dialog and routes Ctrl+P to the Quick Open palette.
  assert.match(orchestrator, /document\.addEventListener\("keydown",\s*handleGlobalShortcutKeydown,\s*true\)/);
  assert.match(orchestrator, /shortcutHelper\.matchesBinding\("searchDatabase",\s*event\)/);

  // Ctrl+P must always cancel the native print dialog AND open the Quick Open
  // palette from anywhere — including while focus is inside an editable element
  // (cell editor, AI input, the search box itself, …). preventDefault must
  // therefore run first, and there must be NO isEditableShortcutTarget guard
  // between it and the open call, otherwise Ctrl+P while typing in any input
  // would silently no-op. The handler goes through openQuickOpenFromAnywhere
  // so it can first commit an in-progress cell edit (with skipRefocus) —
  // otherwise the editor's blur-triggered finishEditing steals focus back to
  // the grid and the user has to press Ctrl+P twice. Editing state lives
  // per-pane, so it is reached via focusedPaneState, not the top-level editor.
  assert.match(
    orchestrator,
    /if \(shortcutHelper\.matchesBinding\("searchDatabase",\s*event\)\)\s*\{[\s\S]*?event\.preventDefault\(\);[\s\S]*?openQuickOpenFromAnywhere\(\);[\s\S]*?return;[\s\S]*?\}/
  );
  assert.match(
    orchestrator,
    /function openQuickOpenFromAnywhere\(\)\s*\{[\s\S]*?focusedPaneState\.isEditing[\s\S]*?commitEditingWithoutRefocus[\s\S]*?quickOpenVisible\.value\s*=\s*true/
  );

  // The Quick Open palette is mounted in the orchestrator template and wired
  // to the current connection/database/schema so it works even when the
  // sidebar is collapsed (the whole point of the feature).
  assert.match(orchestrator, /<QuickOpenPalette[\s\S]*?:database="selectedDatabase"[\s\S]*?:schema="schemaSearchSource"[\s\S]*?@open-table="openQuickOpenTable"/);
  assert.match(orchestrator, /import QuickOpenPalette from "\.\/components\/QuickOpenPalette\.vue"/);

  // The sidebar's own focusSearch path (v-for ref array normalization) is kept
  // intact for the inline sidebar search box; Ctrl+P no longer relies on it,
  // but clicking the sidebar search box still does.
  assert.match(sidebar, /v-for="database in previewDatabases"[\s\S]*ref="searchPanelRef"/);
  assert.match(sidebar, /Array\.isArray\(searchPanelRef\.value\)\s*\?\s*searchPanelRef\.value\s*:\s*\[searchPanelRef\.value\]/);
  assert.match(sidebar, /panel\.focusSearch\(\)/);
});

test("Quick Open lives on the activity rail and keeps its keyboard shortcut", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const rail = read("./components/WorkbenchActivityRailButton.vue");
  const railModel = read("./composables/useActivityRail.js");

  // The titlebar entry is gone; the rail action opens the same palette.
  assert.doesNotMatch(orchestrator, /wb-quick-open-entry|quickOpenEntryTitle|quickOpenShortcutLabel/);
  assert.match(orchestrator, /quickOpen:\s*openQuickOpenFromAnywhere/);
  assert.match(railModel, /id:\s*"quickOpen"[\s\S]*?shortcutAction:\s*"searchDatabase"/);
  // The rail tooltip renders the platform-formatted binding, not a hardcoded keycap.
  assert.match(railModel, /formatShortcutForPlatform/);
  assert.match(rail, /<kbd v-if="item\.shortcutLabel">\{\{ item\.shortcutLabel \}\}<\/kbd>/);
  assert.doesNotMatch(rail, /<kbd>Ctrl\+P<\/kbd>/);
});

test("Quick Open value field searches on Enter and keeps Ctrl+Enter compatibility", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const palette = read("./components/QuickOpenPalette.vue");
  const kindFilter = read("./components/QuickOpenKindFilter.vue");
  const styles = read("./workbench.css");

  assert.match(palette, /valueSearchState/);
  assert.match(palette, /event\.key === ["']Enter["'] && !event\.isComposing && !event\.repeat/);
  assert.match(palette, /enterkeyhint="search"/);
  assert.match(palette, /aria-keyshortcuts="Enter Control\+Enter Meta\+Enter"/);
  assert.match(palette, /emit\(["']search-values["'],\s*\{[\s\S]*?includedTables:/);
  assert.match(palette, /emit\(["']open-value-result["']/);
  assert.match(palette, /valueSearchProgressPercent/);
  assert.match(palette, /matchMode = ref\(["']fuzzy["']\)/);
  assert.match(palette, /const schema = toRaw\(props\.schema\)/);
  assert.match(palette, /const query = props\.query\.trim\(\)/);
  assert.match(palette, /schema\.slice\(offset, offset \+ QUICK_OPEN_SEARCH_CHUNK_SIZE\)/);
  assert.match(palette, /buildSchemaSearchResults\([\s\S]*?query,\s*\{[\s\S]*?mode:\s*searchTextMode\.value,[\s\S]*?includedKinds:\s*scopeIncludedKinds\.value,[\s\S]*?matchedColumnLimit:\s*3/);
  assert.match(palette, /:aria-busy="searchRunning \? 'true' : 'false'"/);
  const rebuildResults = palette.match(/async function rebuildResults\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(rebuildResults, /searchRunning\.value = true;\s*results\.value = \[\]/);
  assert.match(rebuildResults, /if \(token !== resultBuildToken\) return;\s*renderedQuery\.value = query;\s*results\.value = nextResults\.sort\(compareSchemaResults\)/);
  assert.match(palette, /:aria-disabled="searchRunning \? 'true' : null"/);
  assert.match(palette, /@click="searchRunning && \$event\.preventDefault\(\)"/);
  assert.doesNotMatch(palette, /class="wb-quick-open-item-copy"[^>]*:disabled="searchRunning"/);
  assert.match(palette, />模糊<\/button>/);
  assert.match(palette, />连续<\/button>/);
  assert.match(palette, /import QuickOpenKindFilter from ["']\.\/QuickOpenKindFilter\.vue["']/);
  assert.match(palette, /<QuickOpenKindFilter v-model="scopeMatchKind" :theme="theme" \/>/);
  assert.doesNotMatch(palette, /<select[^>]*v-model="scopeMatchKind"/);
  assert.match(kindFilter, /aria-haspopup="listbox"/);
  assert.match(kindFilter, /role="listbox"/);
  assert.match(kindFilter, /role="option"/);
  assert.match(kindFilter, /emit\("update:modelValue", value\)/);
  assert.match(palette, /v-model="scopeMatchKind"/);
  assert.match(palette, /highlightSearchRanges/);
  assert.match(palette, /<kbd>Ctrl\+Enter<\/kbd> 搜值/);
  assert.match(cssRuleBody(styles, ".wb-quick-open-value-hint"), /font-size/);
  assert.match(cssRuleBody(styles, ".wb-quick-open-value-error"), /color:\s*var\(--wb-danger\)/);
  assert.match(orchestrator, /const quickOpenValueSearch = reactive\(createSidebarSearchState\(\)\)/);
  assert.match(orchestrator, /const quickOpenSchemaSearchResults = computed/);
  assert.match(orchestrator, /async function runQuickOpenValueSearch\(\{\s*query:\s*requestedQuery\s*=\s*["']["'],\s*includedTables\s*=\s*\[\]\s*\}\s*=\s*\{\}\)/);
  assert.match(orchestrator, /beginValueSearch\(quickOpenValueSearch,\s*query\)/);
  assert.match(orchestrator, /priorityTables:\s*uniqueSchemaSearchPriorityTables\(quickOpenSchemaSearchResults\.value\)/);
  assert.match(orchestrator, /@search-values="runQuickOpenValueSearch"/);
  assert.match(orchestrator, /@open-value-result="openQuickOpenValueResult"/);
});

test("Ctrl+W, Ctrl+Tab, and Ctrl+Shift+Tab manage table tabs like Excel", () => {
  const orchestrator = read("./MySqlWorkbench.vue");

  // All three shortcuts are wired into the document-level capture handler so
  // they cancel native browser/tab shortcuts and route to the workspace state.
  assert.match(orchestrator, /function\s+handleCloseTabKeydown\s*\(/);
  assert.match(orchestrator, /function\s+handleCycleTabKeydown\s*\(/);
  assert.match(
    orchestrator,
    /function\s+handleGlobalShortcutKeydown\s*\([^)]*\)\s*\{[\s\S]*?if\s*\(handleCloseTabKeydown\(event\)\)\s*return;[\s\S]*?if\s*\(handleCycleTabKeydown\(event\)\)\s*return;/
  );

  // Ctrl+W closes the active tab in the focused pane, but only when focus is
  // not inside an editable element (consistent with other workspace shortcuts).
  assert.match(orchestrator, /matchesBinding\("closeTab",\s*event\)/);
  assert.match(orchestrator, /if\s*\(isEditableShortcutTarget\(event\.target\)\)\s*return\s+false;[\s\S]*?closeTab\(tab\.id\)/);

  // Ctrl+D must stay available after Ctrl+W closes table design. That close
  // drops keyboard focus onto the document, outside the workbench bubble listener.
  assert.match(orchestrator, /function\s+handleOpenDesignShortcut\s*\(event\)/);
  assert.match(
    orchestrator,
    /function\s+handleGlobalShortcutKeydown\s*\([^)]*\)\s*\{[\s\S]*?if\s*\(handleCloseTabKeydown\(event\)\)\s*return;[\s\S]*?if\s*\(handleOpenDesignShortcut\(event\)\)\s*return;/,
  );
  assert.match(orchestrator, /focusedPaneState\.handleOpenDesignKeydown\(event\) === true/);
  assert.match(read("./components/WorkbenchPane.vue"), /function\s+reclaimDataGridFocus\(tabId\)/);
  assert.match(read("./components/WorkbenchPane.vue"), /isStrandedKeyboardFocus\(globalThis\.document\?\.activeElement\)/);
  assert.match(read("./components/WorkbenchPane.vue"), /gridWrapRef\.value\?\.focus\(\{ preventScroll: true \}\)/);

  // Ctrl+Tab / Ctrl+Shift+Tab cycle only published tabs in the focused pane.
  assert.match(orchestrator, /matchesBinding\("nextTab",\s*event\)/);
  assert.match(orchestrator, /matchesBinding\("previousTab",\s*event\)/);
  assert.match(orchestrator, /adjacentPublishedTabId\(workspace\.tabs,\s*pane,\s*direction\)/);
  assert.match(orchestrator, /void\s+activateTab\(pane\.id,\s*nextTabId\)/);
});

test("Ctrl+digit and Ctrl+Backquote switch published tabs in the focused pane", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const tabs = read("./components/WorkbenchTabs.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const splitLayout = read("./components/WorkbenchSplitLayout.vue");

  assert.match(orchestrator, /import\s*\{[^}]*isTabShortcutEvent[^}]*\}\s*from\s*["']\.\/utils\/tabShortcutHints\.js["']/);
  assert.match(orchestrator, /useTabShortcutHints\(/);
  assert.match(
    orchestrator,
    /function\s+handleGlobalShortcutKeydown\s*\([^)]*\)\s*\{[\s\S]*?if\s*\(handleCycleTabKeydown\(event\)\)\s*return;[\s\S]*?if\s*\(handleTabShortcutKeydown\(event\)\)\s*return;/,
  );
  assert.match(orchestrator, /function\s+handleTabShortcutKeydown\s*\(/);
  assert.match(orchestrator, /openCurrentDatabaseHome\(\{\s*paneId:\s*pane\.id,\s*activate:\s*true\s*\}\)/);
  assert.match(orchestrator, /resolveTabShortcutEvent\(event,\s*visibleTabsForPane\(workspace\.tabs,\s*pane\)\)/);
  assert.match(orchestrator, /preventDialogShortcutDefault[\s\S]*isTabShortcutEvent\(event\)/);
  assert.match(orchestrator, /dialogLayerManager\.hasActiveModalLayer\(\)[\s\S]*?hideTabShortcutHints\(\)/);
  assert.match(orchestrator, /:show-shortcut-hints="tabShortcutHintsVisible"/);

  assert.match(splitLayout, /showShortcutHints:\s*\{\s*type:\s*Boolean/);
  assert.match(splitLayout, /:show-shortcut-hints="showShortcutHints"/);
  assert.match(pane, /:show-shortcut-hints="isFocused && showShortcutHints"/);
  assert.match(tabs, /assignTabShortcutHints\(/);
  assert.match(tabs, /formatShortcutForPlatform\(/);
  assert.match(tabs, /class="wb-tab-shortcut-badge"/);
});

test("shortcut settings dialog does not overflow and protects overlay clicks", () => {
  const dialog = read("./components/ShortcutSettingsDialog.vue");
  const styles = read("./workbench.css");

  // The dialog is Teleported to body so it is not clipped by the sidebar's
  // `contain: paint` and the overlay truly covers the full viewport.
  assert.match(dialog, /<Teleport\s+to="body">\s*<div[\s\S]*?v-if="open"[\s\S]*?class="[^"]*\bwb-shortcut-dialog-overlay\b[^"]*"/);

  // A stray click outside the dialog cannot discard an in-progress shortcut capture.
  assert.doesNotMatch(dialog, /@click\.self="close"/);
  assert.match(dialog, /useEscClose\(\(\) => props\.open, close, null, \{ dialogRef \}\)/);
  // Escape closes the dialog when not capturing a new shortcut.
  assert.match(dialog, /if\s*\(event\.key\s*===\s*["']Escape["']\)\s*\{[\s\S]*?if\s*\(listeningAction\.value\)\s*\{[\s\S]*?cancelRebind\(\);[\s\S]*?\}\s*else\s*\{[\s\S]*?close\(\);/);

  // Stacked row layout: label on its own line and a body row for combo + actions.
  assert.match(dialog, /class="wb-shortcut-row-body"/);
  assert.match(dialog, /class="wb-shortcut-row-label"/);

  // Dialog width is capped and rows stack vertically so long labels never force
  // horizontal overflow.
  assert.match(styles, /\.wb-shortcut-dialog\s*\{[\s\S]*?width:\s*min\(520px,\s*calc\(100vw\s+-\s*32px\)\)/);
  assert.match(styles, /\.wb-shortcut-row\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.match(styles, /\.wb-shortcut-row-label\s*\{[\s\S]*?overflow-wrap:\s*break-word/);
});

test("shortcut settings dialog inherits the active theme after teleporting to body", () => {
  const dialog = read("./components/ShortcutSettingsDialog.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");

  assert.match(dialog, /theme:\s*\{\s*type:\s*String,\s*default:\s*["']light["']\s*\}/);
  assert.match(dialog, /class="wb-shortcut-dialog-overlay wb-floating-themed"/);
  assert.match(dialog, /:data-theme="theme"/);
  assert.match(sidebar, /<ShortcutSettingsDialog[\s\S]*?:theme="currentTheme"/);
});

test("teleported themed surfaces reuse the workbench scrollbar palette", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-floating-themed \*\s*\{[^}]*scrollbar-color:\s*var\(--wb-scrollbar-thumb\)\s+var\(--wb-scrollbar-track\)/s);
  assert.match(styles, /\.wb-floating-themed \*::-webkit-scrollbar\s*\{[^}]*width:\s*var\(--wb-scrollbar-size\)/s);
  assert.match(styles, /\.wb-floating-themed \*::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--wb-scrollbar-thumb\)/s);
});

test("shortcut settings completion action uses the themed primary control palette", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-shortcut-dialog-primary\s*\{[^}]*background:\s*var\(--wb-accent-control\)/s);
  assert.match(styles, /\.wb-shortcut-dialog-primary\s*\{[^}]*color:\s*var\(--wb-accent-control-text\)/s);
  assert.match(styles, /\.wb-shortcut-dialog-primary:hover:not\(:disabled\),\s*\.wb-shortcut-dialog-primary:focus-visible\s*\{[^}]*background:\s*var\(--wb-accent-control-hover\)/s);
});

test("tauri main window uses custom web chrome by default", () => {
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

test("tauri macOS window uses native traffic lights over the integrated titlebar", () => {
  const baseConfig = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  const macConfig = JSON.parse(read("../../src-tauri/tauri.macos.conf.json"));
  const baseMain = baseConfig.app.windows.find((window) => window.label === "main");
  const macMain = macConfig.app.windows.find((window) => window.label === "main");

  assert.ok(macMain);
  assert.equal(macMain.decorations, true);
  assert.equal(macMain.titleBarStyle, "Overlay");
  assert.equal(macMain.hiddenTitle, true);
  assert.deepEqual(macMain.trafficLightPosition, { x: 13, y: 22 });
  assert.equal(macMain.maximized, false);
  assert.equal(macMain.transparent, true);
  assert.equal(baseConfig.app.macOSPrivateApi, true);
  for (const key of [
    "label",
    "title",
    "width",
    "height",
    "minWidth",
    "minHeight",
    "shadow",
    "resizable",
    "alwaysOnTop",
    "skipTaskbar",
    "dragDropEnabled",
    "visible",
    "center",
  ]) {
    assert.equal(macMain[key], baseMain[key], `macOS override drifted for ${key}`);
  }
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
  assert.ok(capability.permissions.includes("core:window:allow-is-always-on-top"));
  assert.ok(capability.permissions.includes("core:window:allow-set-always-on-top"));
  assert.ok(capability.permissions.includes("core:window:allow-close"));
  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
});

test("tauri updater uses the local SVN update directory flow", () => {
  const pkg = JSON.parse(read("../../package.json"));
  const cargo = read("../../src-tauri/Cargo.toml");
  const lib = read("../../src-tauri/src/lib.rs");
  const svnUpdater = read("../../src-tauri/src/svn_updater.rs");
  const svnClient = read("../../src-tauri/src/svn_client.rs");
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  const capability = JSON.parse(read("../../src-tauri/capabilities/main.json"));

  assert.equal(pkg.dependencies["@tauri-apps/plugin-updater"], undefined);
  assert.ok(pkg.dependencies["@tauri-apps/plugin-process"]);
  assert.doesNotMatch(cargo, /tauri-plugin-updater/);
  assert.match(cargo, /tauri-plugin-process/);
  assert.match(lib, /tauri_plugin_process::init\(\)/);
  assert.match(lib, /mod svn_updater;/);
  assert.match(lib, /commands::svn_update_check/);
  assert.match(lib, /svn_updater::spawn_background_checks/);
  assert.match(svnUpdater, /Duration::from_secs\(60 \* 60\)/);
  assert.match(svnUpdater, /SvnClient::for_working_copy\(app, directory\)\.await\?/);
  assert.match(svnUpdater, /run_svn_command\(&mut svn, "cleanup", directory\)\.await\?;\s*run_svn_command\(&mut svn, "update", directory\)\.await/);
  assert.match(svnClient, /#\[cfg\(target_os = "windows"\)\]\s*command\.creation_flags\(0x0800_0000\)/);
  assert.match(svnUpdater, /REQUIRED_DIRECTORY_NAME:\s*&str\s*=\s*"navicat"/);
  assert.match(svnUpdater, /"\/opt\/homebrew\/bin\/svn"/);
  assert.match(svnUpdater, /find_on_path\("svn"\)\.or_else\(find_svn_in_standard_locations\)/);
  assert.match(svnUpdater, /TortoiseSVN/);
  assert.match(svnUpdater, /pick_windows_svn_exe\(/);
  assert.match(svnUpdater, /find_tortoise_svn\(\)/);
  assert.match(svnUpdater, /resource_dir\.join\("svn"\)\.join\("svn\.exe"\)/);
  assert.equal(config.bundle?.resources?.["resources/svn/"], "svn/");
  assert.equal(config.bundle.createUpdaterArtifacts, undefined);
  assert.equal(config.plugins?.updater, undefined);
  assert.doesNotMatch(JSON.stringify(config), /gitee\.com/i);
  assert.ok(!capability.permissions.includes("updater:default"));
  assert.ok(capability.permissions.includes("process:default"));
});

test("workbench exposes an in-app updater entry and dialog", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dialog = read("./components/UpdateDialog.vue");
  const notice = read("./components/UpdateNotice.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /import\s+UpdateDialog\s+from\s+["']\.\/components\/UpdateDialog\.vue["']/);
  assert.match(orchestrator, /import\s+\{\s*useUpdater\s*\}\s+from\s+["']\.\/composables\/useUpdater\.js["']/);
  assert.match(orchestrator, /const\s+updater\s*=\s*useUpdater\(\)/);
  assert.match(orchestrator, /update: openUpdateDialog/);
  assert.match(orchestrator, /@select="selectActivityRailEntry"/);
  assert.match(orchestrator, /<UpdateDialog/);
  assert.match(orchestrator, /<UpdateNotice/);
  assert.match(orchestrator, /updater\.startBackgroundListener\(\)/);
  assert.match(orchestrator, /updater\.checkForUpdates\(\{ silent: true \}\)/);
  assert.match(orchestrator, /updater\.stopBackgroundListener\(\)/);
  assert.match(orchestrator, /@pick-directory="updater\.pickUpdateDirectory"/);

  assert.match(dialog, /defineProps/);
  assert.match(dialog, /currentVersion/);
  assert.match(dialog, /availableUpdate/);
  assert.match(dialog, /downloadPercent/);
  assert.match(dialog, /downloadAndInstall/);
  assert.match(dialog, /SVN 更新目录/);
  assert.match(dialog, /安装更新/);
  assert.match(dialog, /unavailable/);
  assert.match(dialog, /立即重启/);
  assert.doesNotMatch(dialog, /Gitee/);
  assert.match(styles, /\.wb-dialog-header\s*\{[\s\S]*?justify-content:\s*space-between;/);

  assert.match(notice, /发现新版本/);
  assert.match(notice, /查看更新/);
  assert.match(notice, /关闭更新提醒/);
  assert.match(notice, /wb-update-notice-notes/);
  assert.match(notice, /update\.value\?\.body/);

  assert.match(styles, /\.wb-update-button/);
  assert.match(styles, /\.wb-update-dialog/);
  assert.match(styles, /\.wb-update-notice/);
  assert.match(styles, /\.wb-update-notice-notes/);
  assert.match(styles, /\.wb-update-progress/);
  assert.match(styles, /wb-update-pulse/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("legacy assistant modules remain isolated from the shipped workbench", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const panel = read("./components/AgentPanel.vue");
  const header = read("./components/AgentHeader.vue");
  const settings = read("./components/AgentSettings.vue");
  const message = read("./components/AgentMessage.vue");
  const approval = read("./components/AgentApprovalCard.vue");
  const composer = read("./components/AgentComposer.vue");
  const runtimeCard = read("./components/AgentRuntimeCard.vue");
  const startup = read("./components/AgentStartupCard.vue");
  const onboarding = read("./components/AgentOnboarding.vue");
  const projectPicker = read("./components/AgentProjectPicker.vue");
  const agentUi = [panel, header, settings, message, approval, composer, runtimeCard, startup, onboarding, projectPicker].join("\n");
  const composable = read("./composables/useAgent.js");
  const mock = read("./mock/mockBackend.js");
  const styles = read("./workbench.css");
  const lib = read("../../src-tauri/src/lib.rs");
  const commands = read("../../src-tauri/src/commands.rs");

  assert.doesNotMatch(orchestrator, /AgentPanel|useAgent\b|useAgentProjects|toggleAiAssistant|ensureRuntime|agentRuntimeUpdate/);
  assert.match(orchestrator, /useExternalMcp\(invokeWorkbench\)/);
  assert.match(orchestrator, /<InspectorPanel/);
  assert.match(orchestrator, /<BlackcatMcpDialog/);

  assert.match(panel, /import\s+AgentHeader\s+from\s+["']\.\/AgentHeader\.vue["']/);
  assert.match(panel, /import\s+AgentSettings\s+from\s+["']\.\/AgentSettings\.vue["']/);
  assert.match(panel, /import\s+AgentMessage\s+from\s+["']\.\/AgentMessage\.vue["']/);
  assert.match(panel, /projects:\s*\{\s*type:\s*Object,\s*default:\s*null\s*\}/);
  assert.match(panel, /:projects="projects"/);
  assert.match(panel, /import\s+AgentPlanCard\s+from\s+["']\.\/AgentPlanCard\.vue["']/);
  assert.match(panel, /import\s+AgentApprovalCard\s+from\s+["']\.\/AgentApprovalCard\.vue["']/);
  assert.match(panel, /import\s+AgentComposer\s+from\s+["']\.\/AgentComposer\.vue["']/);
  assert.match(panel, /import\s+AgentRuntimeCard\s+from\s+["']\.\/AgentRuntimeCard\.vue["']/);
  assert.match(panel, /<AgentRuntimeCard/);
  assert.match(panel, /@open-update="emit\('open-update'\)"/);
  assert.match(panel, /import\s+AgentStartupCard\s+from\s+["']\.\/AgentStartupCard\.vue["']/);
  assert.match(header, /import\s+AgentProjectPicker\s+from\s+["']\.\/AgentProjectPicker\.vue["']/);
  assert.match(header, /projects:\s*\{\s*type:\s*Object,\s*default:\s*null\s*\}/);
  assert.match(header, /<AgentProjectPicker\s+:projects="projects"\s+:disabled="isBusy"\s*\/>/);
  assert.doesNotMatch(header, /Database Agent|tableSource|autoApproveWrites|wb-ai-brand|databaseProfileStatus|wb-ai-profile-status|数据库理解/);
  const headerTag = panel.match(/<AgentHeader[\s\S]*?\/>/)?.[0] || "";
  const composerTag = panel.match(/<AgentComposer[\s\S]*?\/>/)?.[0] || "";
  assert.doesNotMatch(headerTag, /:table-source="tableSource"|:auto-approve-writes/);
  assert.match(panel, /@new-session="startNewSessionWithNotice"/);
  assert.match(panel, /const\s+sessionNotice\s*=\s*ref\(["']["']\)/);
  assert.match(panel, /function\s+startNewSessionWithNotice\(\)/);
  assert.match(panel, /assistant\.startNewSession\(\)/);
  assert.match(panel, /已打开新会话/);
  assert.match(panel, /class="wb-ai-toast"/);
  assert.match(panel, /role="status"/);
  assert.match(composerTag, /:table-source="tableSource"/);
  assert.match(projectPicker, /projects:\s*\{\s*type:\s*Object,\s*default:\s*null\s*\}/);
  assert.match(projectPicker, /disabled:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/);
  assert.match(projectPicker, /未接入项目文件夹/);
  assert.match(projectPicker, /添加项目后，Agent 可只读查看项目文件/);
  assert.match(projectPicker, /项目：/);
  assert.match(projectPicker, /项目不可用/);
  assert.match(projectPicker, /Agent 完成后可切换项目/);
  assert.match(projectPicker, /只读/);
  assert.match(projectPicker, /addProjectFromDirectory/);
  assert.match(projectPicker, /selectProject/);
  assert.match(projectPicker, /removeProject/);
  assert.match(projectPicker, /stopPropagation/);
  assert.match(projectPicker, /const\s+menuRef\s*=\s*ref\(null\)/);
  assert.match(projectPicker, /<Teleport\s+defer\s+to="\.mysql-workbench">[\s\S]*class="wb-ai-project-menu"/);
  assert.match(projectPicker, /menuRef\.value\?\.contains\?\.\(event\.target\)/);
  const projectToggleOpen = projectPicker.match(/function\s+toggleOpen\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(projectToggleOpen, /open\.value\s*=\s*!open\.value/);
  assert.doesNotMatch(projectToggleOpen, /addProject/);
  assert.match(projectPicker, /document\.addEventListener\(["']pointerdown["']/);
  assert.match(projectPicker, /document\.removeEventListener\(["']pointerdown["']/);
  assert.match(projectPicker, /document\.addEventListener\(["']keydown["']/);
  assert.match(projectPicker, /onBeforeUnmount/);
  assert.match(panel, /startupProgress/);
  assert.match(panel, /pendingPlans/);
  assert.match(panel, /approvePlan/);
  assert.match(panel, /denyPlan/);
  assert.match(panel, /v-if="assistant\.pendingPlans\.value\.length"/);
  assert.match(panel, /v-if="assistant\.pendingApprovals\.value\.length"/);
  assert.match(startup, /wb-ai-startup-card/);
  assert.match(startup, /role="progressbar"/);
  assert.match(startup, /stageLabel/);

  assert.match(agentUi, /Database Agent/);
  assert.match(agentUi, /API Key/);
  assert.match(agentUi, /v-model="assistant\.apiKey\.value"/);
  assert.match(agentUi, /Base URL/);
  assert.match(agentUi, /v-model="assistant\.apiUrl\.value"/);
  assert.match(agentUi, /v-model="assistant\.model\.value"/);
  assert.match(onboarding, /未检测到可用的本机 Claude Code 配置/);
  assert.match(onboarding, /使用本机 Claude Code 重试/);
  assert.doesNotMatch(onboarding, /\/login/);
  assert.match(agentUi, /settingsOpen/);
  assert.match(agentUi, /class="wb-ai-icon-button"/);
  assert.match(agentUi, /class="wb-ai-config-panel"/);
  assert.match(agentUi, /class="wb-ai-tool-status"/);
  assert.match(agentUi, /class="wb-ai-cell-identity"/);
  assert.doesNotMatch(panel, /:database-profile-status/);
  assert.doesNotMatch(agentUi, /databaseProfileStatus|wb-ai-profile-status|数据库理解/);
  assert.match(agentUi, /assistant\.startNewSession\(\)/);
  assert.match(agentUi, /v-if="settingsOpen"/);
  assert.doesNotMatch(agentUi, /activeStatusLabel|statusLabel/);
  assert.doesNotMatch(agentUi, /wb-ai-status-pill/);
  assert.doesNotMatch(agentUi, /<section class="wb-ai-service-panel"/);
  assert.match(agentUi, /@submit\.prevent="submit"/);
  assert.match(composer, /wb-ai-composer-send/);
  assert.match(composer, /tableSource:\s*\{\s*type:\s*String,\s*default:\s*\(\)\s*=>\s*t\("agent\.currentDatabase"\)\s*\}/);
  assert.match(composer, /wb-ai-composer-context/);
  assert.match(composer, /当前上下文/);
  assert.match(composer, /\{\{\s*tableSource\s*\}\}/);
  assert.match(composer, /assistant\.isBusy\.value/);
  assert.match(composer, /emit\(["']abort["']\)/);
  assert.match(composer, /aria-label="发送消息"/);
  assert.match(composer, /aria-label="停止生成"/);
  assert.match(agentUi, /toolResults/);
  assert.match(message, /wb-ai-message-actions/);
  assert.match(message, /copy-message/);
  assert.match(message, /copy-message-markdown/);
  assert.match(message, /regenerate/);
  assert.match(message, /formatElapsed/);
  assert.match(message, /markdownToPlainText/);
  assert.match(message, /contextLabel/);
  assert.match(message, /projectLabel/);
  assert.match(message, /mcp__dbscout-db__/);
  assert.match(message, /mcp__dbscout-project__/);
  assert.match(message, /toolSummaryLabel/);
  assert.match(message, /INTERNAL_AGENT_TOOL_NAMES/);
  assert.match(message, /get_database_profile/);
  assert.match(message, /refresh_database_profile/);
  assert.match(message, /search_database_profile/);
  assert.match(message, /filter\(\(use\) => !isInternalAgentTool\(use\?\.name\)\)/);
  assert.match(message, /details[\s\S]*class="wb-ai-tool-steps"/);
  assert.match(message, /evidenceReferences/);
  assert.match(message, /wb-ai-evidence-chip/);
  assert.match(message, /open-reference/);
  assert.match(message, /focus_cell/);
  assert.match(panel, /showScrollToBottom/);
  assert.match(panel, /wb-ai-scroll-bottom/);
  assert.match(panel, /@open-reference="openReference"/);
  assert.match(panel, /copyMessageText/);
  assert.match(panel, /copyMessageMarkdown/);
  assert.match(panel, /assistant\.regenerate/);
  assert.match(composable, /agent_start_session/);
  assert.match(composable, /agent_send/);
  assert.match(composable, /async function prewarm/);
  assert.match(composable, /async function ensureRuntime/);
  assert.match(composable, /agent_runtime_status/);
  assert.match(composable, /agent_runtime_check/);
  assert.match(composable, /agent_runtime_install/);
  assert.match(composable, /startPromise/);
  assert.match(composable, /async function sendText\(text, context, options = \{\}\)/);
  assert.match(composable, /invokeWorkbench\(["']agent_send["'], \{ text, context \}\)/);
  assert.match(composable, /const context = buildAgentContext\(activeTab\);/);
  assert.match(composable, /await sendText\(text, context, \{ clearDraft: true \}\)/);
  assert.match(composable, /pendingWorkbenchActions/);
  assert.match(composable, /case ["']workbench_action["']/);
  assert.match(composable, /markWorkbenchActionHandled/);
  assert.match(orchestrator, /agent\.pendingWorkbenchActions\.value/);
  assert.match(orchestrator, /agentWorkbenchActionProcessing/);
  assert.match(orchestrator, /processNextAgentWorkbenchAction/);
  assert.match(orchestrator, /openAgentTableAction/);
  assert.match(orchestrator, /focusedPaneState\.selectCellAt/);
  assert.match(orchestrator, /agent\.markWorkbenchActionHandled\(action\.requestId\)/);
  assert.match(composable, /apiKey/);
  assert.match(composable, /apiUrl/);
  assert.match(composable, /DEFAULT_AGENT_MODEL/);
  assert.match(composable, /startNewSession/);
  assert.match(composable, /startupProgress/);
  assert.match(composable, /databaseProfileStatus/);
  assert.match(composable, /startup_progress/);
  assert.match(mock, /command === ["']agent_start_session["']/);
  assert.match(mock, /command === ["']agent_send["']/);
  assert.match(mock, /command === ["']agent_runtime_status["']/);
  assert.match(mock, /get_database_profile/);
  assert.match(mock, /find_related_tables/);
  assert.match(mock, /rowCountEstimate/);
  assert.match(mock, /indexes/);
  assert.match(mock, /sensitive/);
  assert.match(styles, /\.wb-ai-entry-button/);
  assert.match(styles, /\.wb-ai-panel\s*\{[^}]*position:\s*relative/s);
  assert.match(styles, /\.wb-ai-shell-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(styles, /@container\s*\(max-width:\s*260px\)\s*\{[\s\S]*\.wb-ai-project-copy small,[\s\S]*\.wb-ai-project-readonly,[\s\S]*\.wb-ai-project-chevron\s*\{[^}]*display:\s*none/s);
  assert.equal((styles.match(/\.wb-ai-shell-header\s*\{\s*gap:\s*4px/g) || []).length, 1);
  assert.match(styles, /\.wb-ai-toast\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.wb-ai-composer-context\s*\{[^}]*min-width:\s*0/s);
  assert.match(styles, /\.wb-ai-composer/);
  assert.match(styles, /\.wb-ai-icon-button/);
  assert.match(styles, /\.wb-ai-tool-status/);
  assert.match(styles, /\.wb-ai-message-actions/);
  assert.match(styles, /\.wb-ai-message-action/);
  assert.match(styles, /\.wb-ai-context-label/);
  assert.doesNotMatch(styles, /\.wb-ai-profile-status/);
  assert.match(styles, /\.wb-ai-project-picker/);
  assert.match(styles, /\.wb-ai-project-trigger/);
  assert.match(styles, /\.wb-ai-project-menu/);
  assert.match(styles, /\.wb-ai-project-readonly/);
  assert.match(styles, /\.wb-ai-project-picker\.is-unavailable/);
  assert.match(styles, /\.wb-ai-scroll-bottom/);
  assert.match(styles, /\.wb-ai-composer-send/);
  assert.match(styles, /\.wb-ai-cell-panel/);
  assert.match(styles, /\.wb-ai-startup-card/);
  assert.match(styles, /\.wb-ai-startup-progress/);
  assert.match(styles, /\.wb-ai-startup-progress-fill/);
  assert.match(styles, /\.wb-ai-runtime-card/);
  assert.match(styles, /\.wb-ai-runtime-progress/);
  assert.match(styles, /\.wb-ai-config-panel,\s*\n\.wb-ai-history-panel\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.wb-ai-config-panel,\s*\n\.wb-ai-history-panel\s*\{[^}]*top:\s*62px/s);
  assert.match(styles, /\.wb-ai-config-panel,\s*\n\.wb-ai-history-panel\s*\{[^}]*right:\s*8px/s);
  assert.match(styles, /\.wb-ai-config-panel,\s*\n\.wb-ai-history-panel\s*\{[^}]*left:\s*8px/s);
  assert.doesNotMatch(styles, /\.wb-ai-status-pill/);
  assert.doesNotMatch(styles, /\.wb-ai-service-panel/);
  assert.doesNotMatch(lib, /commands::agent_/);
  assert.match(commands, /pub async fn agent_start_session/);
  assert.match(commands, /pub async fn agent_runtime_status/);
  assert.match(commands, /pub async fn agent_runtime_check/);
  assert.match(commands, /pub async fn agent_runtime_install/);
  assert.match(commands, /AgentSidecar/);
  assert.match(commands, /start_session/);
  assert.doesNotMatch(commands, /guard\.take\(\)[\s\S]*prev\.shutdown\(\)/);
});

test("titlebar keeps native drag on empty tab-strip space while tabs stay interactive", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const tabs = read("./components/WorkbenchTabs.vue");
  const styles = read("./workbench.css");

  // Header relies on Tauri's native drag region; the old manual pointerdown
  // handler has been removed to avoid duplicate drag initiation and cursor flicker.
  assert.match(orchestrator, /<header[\s\S]*?data-tauri-drag-region/);
  assert.doesNotMatch(orchestrator, /@pointerdown="startWindowDrag"/);
  assert.doesNotMatch(orchestrator, /function startWindowDrag\(event\)/);

  // Every stacked empty-space layer must opt into native dragging because
  // Tauri's drag-region attribute does not inherit through child elements.
  assert.doesNotMatch(orchestrator, /class="wb-titlebar-tabs"[^>]*data-tauri-drag-region="false"/);
  assert.doesNotMatch(tabs, /useTabWindowDrag|startDragging|@mousedown="onTabBarMouseDown/);
  assert.match(orchestrator, /class="wb-titlebar-sidebar"[\s\S]*?data-tauri-drag-region/);
  assert.match(orchestrator, /class="wb-titlebar-inspector-controls"[\s\S]*?data-tauri-drag-region/);
  assert.match(pane, /class="wb-pane-tabbar"[^>]*data-tauri-drag-region/);
  assert.match(tabs, /class="wb-object-tabs wb-tabs"[^>]*data-tauri-drag-region/);
  assert.match(tabs, /class="wb-tab-list"[^>]*data-tauri-drag-region/);
  assert.match(styles, /\.wb-titlebar\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(styles, /\.wb-titlebar-tabs\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(styles, /\.wb-pane-tabbar[\s\S]*-webkit-app-region:\s*drag/);
  assert.match(styles, /\.wb-tab,[\s\S]*\.wb-tab \*[\s\S]*-webkit-app-region:\s*no-drag/);
  assert.doesNotMatch(styles, /\.wb-titlebar-sidebar,[\s\S]*?\.wb-titlebar-inspector-controls\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  assert.match(styles, /\.wb-titlebar\s+(?:button|\[role="button"\])/);
});

test("database list queries stay lightweight and do not join column metadata", () => {
  const db = read("../../src-tauri/src/db.rs");
  const clickhouse = read("../../src-tauri/src/clickhouse.rs");

  const mysqlListTables = db.match(/fn list_tables_sql\(\)[\s\S]*?\{([\s\S]*?)\n\}/)?.[1] || "";
  const clickhouseListTables = clickhouse.match(/pub async fn list_tables[\s\S]*?let sql = format!\(([\s\S]*?)\);\s*\n\s*let value/s)?.[1] || "";

  assert.match(mysqlListTables, /information_schema\.TABLES/);
  assert.doesNotMatch(mysqlListTables, /information_schema\.COLUMNS|JOIN|COLUMN_COUNT/i);
  assert.match(clickhouseListTables, /system\.tables/);
  assert.doesNotMatch(clickhouseListTables, /system\.columns|JOIN|column_count/i);
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
  assert.match(styles, /\.mysql-workbench\[data-theme="light"\]\s+\.wb-table-toolbar input\s*\{[^}]*cursor:\s*var\(--wb-text-cursor-light\),\s*text/s);
  assert.doesNotMatch(styles, /\.mysql-workbench\[data-theme="light"\]\s+\.wb-detail-input\s*\{[^}]*cursor:/s);
  assert.match(styles, /--wb-accent-control-hover:\s*#2d3748/);
  assert.match(styles, /--wb-accent-control-text:\s*#ffffff/);
  assert.match(styles, /\.wb-toolbar-split-button\.is-active\s*\{[^}]*color:\s*var\(--wb-accent-strong\)/s);
});

test("root surfaces keep resize gaps on the active theme background", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /--wb-root-background-light:/);
  assert.match(styles, /--wb-root-background-dark:/);
  assert.match(styles, /html,\s*body,\s*#app\s*\{[^}]*background:\s*var\(--wb-root-background,\s*var\(--wb-root-background-light\)\)/s);
  assert.match(styles, /html\[data-wb-theme="light"\]\s*\{[^}]*--wb-root-background:\s*var\(--wb-root-background-light\)/s);
  assert.match(styles, /html\[data-wb-theme="dark"\]\s*\{[^}]*--wb-root-background:\s*var\(--wb-root-background-dark\)/s);
});

test("table search toolbar keeps previous and next navigation as compact icons", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const styles = read("./workbench.css");

  assert.match(grid, /hasSearchMatches/);
  assert.match(grid, /search-previous/);
  assert.match(grid, /search-next/);
  assert.match(grid, /searchHitSummary/);
  assert.match(grid, /wb-search-hit-count/);
  assert.match(grid, /\{\{\s*searchHitSummary\.label\s*\}\}/);
  assert.match(styles, /\.wb-search-hit-count/);
  assert.match(grid, /@keydown\.enter\.prevent="emit\('search-next'\)"/);
  // 上一个/下一个 icon 内嵌于搜索框右侧，仅在有命中时显示
  assert.match(grid, /v-if="hasSearchMatches"[\s\S]*?search-previous/);
  assert.match(grid, /wb-search-nav-icon[\s\S]*?aria-label="上一个匹配"/);
  assert.match(grid, /wb-search-nav-icon[\s\S]*?aria-label="下一个匹配"/);
  // 精确/连续/模糊位于搜索框内部，并使用单一设置下拉；表操作单独成组
  assert.match(grid, /ToolbarSplitButton/);
  assert.match(grid, /filter-fuzzy/);
  assert.match(grid, /filter-continuous/);
  assert.match(grid, /filter-exact/);
  assert.match(grid, /wb-table-search-field[\s\S]*?wb-search-mode-control/);
  assert.match(grid, /primary-opens-menu[\s\S]*?single-trigger/);
  assert.match(grid, /toggleToolbarMenu\('filter'\)/);
  assert.match(grid, /wb-table-toolbar-actions wb-toolbar-action-group/);
  assert.match(styles, /\.wb-toolbar-action-menu/);
  assert.doesNotMatch(grid, /wb-filter-mode-segment/);
  assert.doesNotMatch(grid, /wb-search-nav-btn/);
  assert.match(pane, /:has-search-matches="hasSearchMatches"/);
  assert.match(pane, /:search-hit-summary="searchHitSummary"/);
  assert.match(pane, /@search-previous="goToPreviousSearchMatch"/);
  assert.match(pane, /@search-next="goToNextSearchMatch"/);
});

test("table search split and hit-result pane state stay explicitly separated", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const tableSession = read("./composables/useTableSession.js");
  const tableSearch = read("./composables/useTableSearch.js");

  assert.match(tableSession, /function\s+usesBackendFilter/);
  assert.match(tableSession, /tab\?\.hitResultMode\s*===\s*true/);
  assert.match(tableSession, /includeFilter:\s*usesBackendFilter\(tab\)/);
  assert.match(tableSession, /const\s+initialHitResultMode\s*=\s*initialState\s*\?\s*Boolean\(initialState\.hitResultMode\)\s*:\s*false/);
  assert.match(tableSession, /hitResultMode:\s*initialHitResultMode/);
  assert.match(tableSearch, /refreshCurrentSearchMatches/);
  assert.match(pane, /refreshCurrentSearchMatches/);
  assert.match(pane, /searchMatches\.value\.length/);
  assert.match(pane, /activeSearchQuery/);
  assert.match(pane, /refreshCurrentSearchMatches\?\.\(\)/);
  assert.match(orchestrator, /hitResultMode:\s*false/);
  assert.match(orchestrator, /hitResultMode:\s*true/);
  assert.match(orchestrator, /function\s+toggleHitResultPane/);
  assert.match(orchestrator, /function\s+findMatchingHitResult/);
  assert.match(orchestrator, /function\s+hitResultContext/);
  assert.match(orchestrator, /@toggle-hit-result-pane="toggleHitResultPane"/);
});

test("successful undo and redo synchronize the selected grid cell with the detail panel", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const gridEditor = read("./composables/useGridEditor.js");
  const undo = read("./composables/useUndo.js");

  assert.match(pane, /onHistoryApplied:\s*syncSelectionAfterHistory/);
  assert.match(pane, /captureHistoryView:\s*captureHistoryViewState/);
  assert.match(pane, /:identity-remap="detailIdentityRemap"/);
  assert.match(gridEditor, /function\s+syncSelectionAfterHistory/);
  assert.match(gridEditor, /textDraftRevision/);
  assert.match(gridEditor, /syncSelectedTextDraft\(tab\)/);
  assert.match(undo, /await\s+onHistoryApplied\(/);
  assert.match(pane, /onCellCommitted:\s*\(event\)\s*=>\s*emit\("cell-committed",\s*event\)/);
  assert.match(orchestrator, /onCellCommitted:\s*syncCommittedCellToSiblingTabs/);
  assert.match(orchestrator, /applyCommittedCellToTab\(tab,\s*\{\s*rowKey,\s*column,\s*oldValue,\s*newValue\s*\}\)/);
});

test("context menu exposes a toggleable hit-result pane entry only for matching searched tables", () => {
  const contextMenu = read("./components/ContextMenu.vue");
  const useContextMenu = read("./composables/useContextMenu.js");
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(contextMenu, /canToggleHitResultPane/);
  assert.match(contextMenu, /hitResultPaneOpen/);
  assert.match(contextMenu, /toggle-hit-result-pane/);
  assert.match(contextMenu, /hitResultPaneOpen\s*\?/);
  assert.match(useContextMenu, /canToggleHitResultPane/);
  assert.match(useContextMenu, /hitResultPaneOpen/);
  assert.match(orchestrator, /:can-toggle-hit-result-pane="contextMenu\.canToggleHitResultPane"/);
  assert.match(orchestrator, /:hit-result-pane-open="contextMenu\.hitResultPaneOpen"/);
  assert.match(orchestrator, /const canToggle = Boolean\(context && matchesMenuSource\)/);
  assert.doesNotMatch(orchestrator, /const hasHits = Number\(focusedPaneState\.searchMatchCount/);
  assert.match(orchestrator, /contextMenu\.hitResultPaneOpen\s*=/);
  const sidebarContextMenuBody = orchestrator.match(/function\s+openSidebarContextMenu\(event,\s*table\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(sidebarContextMenuBody, /configureHitResultContextMenu/);
});

test("sidebar value result activation opens a normal table and locates the first ordinary search hit", () => {
  const orchestrator = read("./MySqlWorkbench.vue");

  const sidebarBody = orchestrator.match(/async function openSidebarValueResult\(result\) \{[\s\S]*?\n\}/)?.[0] || "";
  const quickOpenBody = orchestrator.match(/async function openQuickOpenValueResult\(result\) \{[\s\S]*?\n\}/)?.[0] || "";
  const valueResultBody =
    orchestrator.match(/async function openValueResult\(result,\s*query\) \{[\s\S]*?\n\}\r?\n\r?\nasync function activateTab/)?.[0] || "";
  assert.match(sidebarBody, /openValueResult\(result,\s*query\)/);
  assert.match(quickOpenBody, /openValueResult\(result,\s*query\)/);
  assert.match(valueResultBody, /openTable\(/);
  assert.match(valueResultBody, /tab\.filterMode\s*=\s*["']continuous["']/);
  assert.match(valueResultBody, /runSearch\(query\)/);
  assert.doesNotMatch(valueResultBody, /preferBackendResultPage/);
  assert.doesNotMatch(valueResultBody, /loadSearchResultPage\(tab,\s*query\)/);
  assert.doesNotMatch(valueResultBody, /hitResultMode:\s*true/);
});

test("performance instrumentation uses the shared development-only utility", () => {
  const perf = read("./utils/performanceMarks.js");
  const bridge = read("./utils/tauriBridge.js");
  const connection = read("./composables/useConnection.js");
  const tableSession = read("./composables/useTableSession.js");
  const grid = read("./components/DataGrid.vue") + read("./components/GridDataRow.vue");
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(perf, /\[dbscout:perf\]/);
  assert.match(perf, /import\.meta\.env\?\.DEV/);
  assert.match(bridge, /measureAsync/);
  assert.match(connection, /markPerf/);
  assert.match(tableSession, /markPerf/);
  assert.match(grid, /sampleNextFrame/);
  assert.match(orchestrator, /workbench\.mounted/);
});

test("sidebar value result activation opens table and runs ordinary page search", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const mock = read("./mock/mockBackend.js");

  assert.match(orchestrator, /createSidebarSearchState/);
  assert.match(orchestrator, /clearValueSearchResults/);
  assert.match(orchestrator, /watch\(\s*\r?\n\s*\(\)\s*=>\s*\[selectedConnectionId\.value,\s*selectedDatabase\.value\]/);
  assert.match(orchestrator, /clearValueSearchResults\(sidebarSearch\)/);
  assert.match(orchestrator, /buildSchemaSearchResults/);
  assert.match(orchestrator, /runSidebarValueSearch/);
  assert.match(orchestrator, /cancelSidebarValueSearch/);
  assert.match(orchestrator, /cancelValueSearch/);
  assert.match(orchestrator, /@cancel-search-values="cancelSidebarValueSearch"/);
  assert.match(orchestrator, /invokeWorkbench\(["']search_values["']/);
  assert.match(orchestrator, /searchConnectionId/);
  assert.match(orchestrator, /searchDatabase/);
  assert.match(orchestrator, /selectedConnectionId\.value\s*===\s*searchConnectionId/);
  assert.match(orchestrator, /selectedDatabase\.value\s*===\s*searchDatabase/);
  assert.match(orchestrator, /if\s*\(!sourceStillSelected\(\)\)\s*return;\s*\r?\n\s*if\s*\(finishValueSearch/);
  assert.match(orchestrator, /connectionId:\s*searchConnectionId/);
  assert.match(orchestrator, /database:\s*searchDatabase/);
  assert.match(orchestrator, /openSidebarValueResult/);
  assert.match(orchestrator, /openSidebarSchemaResult/);
  assert.match(orchestrator, /const runSearch = focusedPaneState\.activeDataTab\?\.id === tab\.id/);
  assert.match(orchestrator, /await runSearch\(query\)/);
  assert.doesNotMatch(orchestrator, /preferBackendResultPage:\s*true/);
  assert.doesNotMatch(orchestrator, /loadSearchResultPage\(tab,\s*query\)/);
  assert.match(orchestrator, /connectionId:\s*result\.connectionId\s*\|\|\s*selectedConnectionId\.value/);
  assert.match(orchestrator, /database:\s*result\.database\s*\|\|\s*selectedDatabase\.value/);
  assert.match(orchestrator, /focusedPaneState\.scrollColumnIntoView\?\./);
  assert.match(orchestrator, /@search-values="runSidebarValueSearch"/);
  assert.match(orchestrator, /@open-schema-result="openSidebarSchemaResult"/);
  assert.match(orchestrator, /@open-value-result="openSidebarValueResult"/);
  assert.match(mock, /command === ["']search_values["']/);
  assert.doesNotMatch(orchestrator, /invokeWorkbench\(["']search_data["']/);
});

test("sidebar value search requests a broad result window", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const commands = read("../../src-tauri/src/commands.rs");

  assert.match(orchestrator, /limit:\s*1500/);
  assert.match(commands, /SEARCH_VALUES_TABLE_SCAN_LIMIT:\s*usize\s*=\s*1500/);
  assert.match(commands, /request\.limit\.unwrap_or\(1500\)\.clamp\(1,\s*1500\)/);
});

test("value result previews highlight contiguous matches only", () => {
  const sidebar = read("./components/SidebarSearchPanel.vue");
  const quickOpen = read("./components/QuickOpenPalette.vue");

  assert.match(sidebar, /highlightValue\(value\)[\s\S]*?highlightSearchText\(value,\s*props\.query,\s*\{\s*mode:\s*["']contains["']\s*\}\)/);
  assert.match(sidebar, /highlightValue\(result\.previewValue\)/);
  assert.match(quickOpen, /highlightValue\(value\)[\s\S]*?highlightSearchText\(value,\s*valueQuery\.value\s*\|\|\s*props\.valueSearchState\?\.valueSearchedQuery\s*\|\|\s*["']["'],\s*\{\s*mode:\s*["']contains["']\s*\}\)/);
  assert.match(quickOpen, /highlightValue\(result\.previewValue\)/);
});

test("sidebar value search shows backend progress while scanning", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const panel = read("./components/SidebarSearchPanel.vue");
  const state = read("./sidebarSearchState.js");
  const styles = read("./workbench.css");
  const commands = read("../../src-tauri/src/commands.rs");

  assert.match(orchestrator, /SEARCH_VALUES_PROGRESS_EVENT/);
  assert.match(orchestrator, /search-values-progress/);
  assert.match(orchestrator, /ensureValueSearchProgressListener/);
  assert.match(orchestrator, /updateValueSearchProgress\(sidebarSearch/);
  assert.match(orchestrator, /jobId:\s*sidebarSearch\.valueSearchJobId/);
  assert.match(orchestrator, /unlistenValueSearchProgress\?\./);
  assert.match(panel, /valueSearchProgressPercent/);
  assert.match(panel, /按 Esc 取消/);
  assert.match(state, /cancelValueSearch/);
  assert.match(panel, /wb-value-search-progress/);
  assert.match(panel, /role="progressbar"/);
  assert.match(state, /valueProgress/);
  assert.match(state, /updateValueSearchProgress/);
  assert.match(styles, /\.wb-value-search-progress/);
  assert.match(commands, /SEARCH_VALUES_PROGRESS_EVENT/);
  assert.match(commands, /window\.emit\(SEARCH_VALUES_PROGRESS_EVENT/);
});

test("table transfer failure banner stays inside the dialog", () => {
  const dialog = read("./components/TableTransferDialog.vue");
  assert.match(dialog, /wb-table-transfer-error/);
  assert.match(
    dialog,
    /\.wb-table-transfer-dialog\s*\{[^}]*max-height:\s*calc\(100vh\s*-\s*48px\)/s,
  );
  assert.match(
    dialog,
    /\.wb-table-transfer-error\s*\{[^}]*max-height:[^}]*overflow:\s*auto/s,
  );
});

test("table transfer dialog lets users add, rename and delete their own templates", () => {
  const dialog = read("./components/TableTransferDialog.vue");
  // A new template is named in place, where its tab is about to appear.
  assert.match(dialog, /class="wb-table-transfer-add"[\s\S]*?@click="startAddTemplate"/);
  assert.match(dialog, /@dblclick="startRenameTemplate\(item\)"/);
  // Every template can be renamed; only user templates offer delete, and
  // nothing else acts on a template while a name is typed.
  assert.match(dialog, /v-if="!nameEdit\.mode" class="wb-table-transfer-template-actions"/);
  assert.match(dialog, /v-if="!activeTemplate\.builtIn"[\s\S]{0,160}?class="is-danger"/);
  // Switching windows (e.g. to copy a name) must not save a half-typed name.
  assert.match(dialog, /function onNameBlur\(\) \{[\s\S]*?if \(!document\.hasFocus\(\)\) return;/);
  // Chinese input methods confirm candidates with Enter; that must not commit the name.
  assert.match(dialog, /event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(dialog, /deleteTemplateMessage[\s\S]*?danger: true[\s\S]*?props\.transfer\.deleteTemplate\(template\.id\)/);
});

test("startup update check waits until the workspace is usable and idle", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const mounted = orchestrator.match(/onMounted\(async \(\) => \{[\s\S]*?\n\}\);/)?.[0] || "";
  assert.ok(mounted, "onMounted block should exist");
  assert.doesNotMatch(mounted.split("persistenceReady = true")[0], /checkForUpdates/);
  assert.match(mounted, /persistenceReady = true;[\s\S]*scheduleDeferredUpdateCheck\(\)/);
  assert.match(orchestrator, /function scheduleIdleStartupWork\([^)]*\) \{[\s\S]*?requestIdleCallback/);
  assert.match(orchestrator, /function scheduleDeferredUpdateCheck\(\) \{[\s\S]*?scheduleIdleStartupWork\(/);
});

test("SQL text edits are coalesced instead of serializing the workspace per keystroke", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  assert.match(orchestrator, /import \{ createCoalescedTask \} from "\.\/utils\/coalescedTask\.js"/);
  // The structural persistence signature no longer stringifies SQL text.
  assert.doesNotMatch(orchestrator, /tab\?\.kind === "sql" \? tab\.sql : undefined/);
  assert.match(orchestrator, /workspace\.tabs\.map\(\(tab\) => \(tab\?\.kind === "sql" \? tab\.sql : null\)\)[\s\S]*?workspacePersistence\.schedule\(\)/);
  assert.match(orchestrator, /workspacePersistence\.flush\(\{ force: true \}\)/);
  // Pending text is written before the window hides, unloads, or unmounts.
  assert.match(orchestrator, /addEventListener\("visibilitychange", flushWorkspacePersistenceWhenHidden\)/);
  assert.match(orchestrator, /addEventListener\("pagehide", flushWorkspacePersistence\)/);
  assert.match(orchestrator, /onBeforeUnmount\(\(\) => \{\s*flushWorkspacePersistence\(\);/);
  assert.match(orchestrator, /async function openSqlDocument\([^)]*\)[^{]*\{\s*flushWorkspacePersistence\(\);/);
});

test("activating a tab shows it before syncing the sidebar database in the background", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const body = orchestrator.match(/async function activateTab\([^)]*\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(body, "activateTab should exist");
  const activated = body.indexOf("activateTableTab(workspace, tabId)");
  const synced = body.indexOf("void tabSourceSync.syncToTab(tab)");
  assert.ok(activated > 0 && synced > activated, "the tab activates before the sidebar sync starts");
  assert.doesNotMatch(body, /await\s+select(Connection|Database)\(/);
  assert.match(orchestrator, /createTabSourceSync\(\{[\s\S]*selectConnection,[\s\S]*selectDatabase,/);
});

test("restored table tabs are deferred shells that load visible tabs first", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const restore = orchestrator.match(/async function restoreSavedTabs\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(restore, "restoreSavedTabs should exist");
  assert.doesNotMatch(restore, /await openTable\(/);
  assert.match(restore, /savedTableTabMatchesSource\(savedTab/);
  assert.match(restore, /restoredTab\.deferredLoad = true/);
  assert.match(restore, /applySavedTableTabState\(restoredTab, savedTab\)/);
  assert.match(restore, /void loadVisibleDeferredTabs\(\)/);
  assert.match(orchestrator, /scheduleIdleStartupWork\(\(\) => \{ void preloadDeferredTabs\(\); \}/);
});
