import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const visibleTextSnippets = (source) => [
  ...source.matchAll(/>([^<>{}\r\n]*(?:\.\.\.)[^<>{}\r\n]*)</g),
  ...source.matchAll(/\b(?:placeholder|title|aria-label)=["']([^"']*(?:\.\.\.)[^"']*)["']/g),
].map((match) => match[1] || match[0]);

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
  assert.match(styles, /\.wb-grid\s*\{[\s\S]*font-size:\s*13\.5px/);
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
  assert.doesNotMatch(orchestrator, /wb-grid-statusbar/);
  assert.match(orchestrator, /:active-status-label="activeStatusLabel"/);
  assert.match(orchestrator, /:selected-range="focusedSelectedRange"/);
  assert.match(orchestrator, /activeStatusLabel/);
  assert.doesNotMatch(orchestrator, /wb-sidebar-status/);
  assert.match(orchestrator, /class="wb-operation-status-live wb-visually-hidden"/);
  assert.doesNotMatch(orchestrator, /import\s+SelectedCellIdentity/);
  assert.doesNotMatch(orchestrator, /<SelectedCellIdentity\s+class="wb-statusbar-cell"/);
  assert.match(orchestrator, /:selected-cell="focusedSelectedCell"/);
  assert.match(identity, /buildSelectedCellIdentity/);
  assert.match(identity, /wb-cell-identity/);
  assert.match(identity, /:title="identity\.title"/);
  assert.match(tabs, /tab\.database/);
  assert.match(tabs, /tab\.kind/);
  assert.match(tabs, /data-kind/);
  assert.match(tabs, /设计/);
  assert.match(tabs, /previewDragOrder/);
  assert.match(tabs, /previewTabs/);
  assert.match(tabs, /<TransitionGroup\s+name="wb-tab-reorder"/);
  assert.match(tabs, /class="wb-tab-list"/);
  assert.doesNotMatch(tabs, /scrollIntoView/);
  assert.match(tabs, /draggable="true"/);
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
  assert.match(styles, /\.wb-inspector-cell-panel/);
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
  const dataGridTag = pane.match(/<DataGrid\b[\s\S]*?\/>/)?.[0] || "";
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
  assert.match(designEditorTag, /v-else-if="activeDesignTab"/);
  assert.match(designEditorTag, /:source="activeDesignTab"/);
  assert.match(designEditorTag, /:invoke-workbench="invokeWorkbench"/);
  assert.match(designEditorTag, /@applied="emit\('design-applied', \$event\)"/);
  assert.doesNotMatch(orchestrator, /wb-design-placeholder/);
  assert.match(orchestrator, /function\s+handleTableDesignApplied/);
  assert.match(orchestrator, /ensureTableSchema\(tableName,\s*\{\s*connectionId,\s*database\s*\}\)/);
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

test("inspector status does not render a data row count for design tabs", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const inspectorTag = orchestrator.match(/<InspectorPanel[\s\S]*?\/>/)?.[0] || "";
  const inspector = read("./components/InspectorPanel.vue");

  assert.match(orchestrator, /const\s+activeStatusLabel\s*=\s*computed/);
  assert.match(inspectorTag, /:active-status-label="activeStatusLabel"/);
  assert.match(inspector, /\{\{\s*activeStatusLabel\s*\}\}/);
  assert.doesNotMatch(inspector, /rowCountLabel\(activeTab\.totalRows\)/);
  assert.match(orchestrator, /activeDataTab\.value\s*\?\s*rowCountLabel\(activeDataTab\.value\.totalRows\)/);
  assert.match(orchestrator, /activeDesignTab\.value\s*\?\s*["']表设计["']/);
});

test("workbench renders recursive split panes and keeps inspector scoped to the focused pane", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const splitLayout = read("./components/WorkbenchSplitLayout.vue");
  const pane = read("./components/WorkbenchPane.vue");
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
  assert.doesNotMatch(splitLayout, /:can-close="totalPaneCount > 1"/);
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
  assert.match(pane, /wb-pane-more/);
  assert.match(pane, /wb-split-menu/);
  assert.match(pane, /:data-pane-id="pane\.id"/);
  assert.match(pane, /props\.isFocused[\s\S]*splitMenuOpen\.value\s*=\s*false/);
  assert.match(pane, /左右分屏/);
  assert.match(pane, /上下分屏/);
  assert.doesNotMatch(pane, /关闭分屏/);
  assert.doesNotMatch(pane, /emit\('close-pane',\s*pane\.id\)/);

  assert.match(styles, /\.wb-split-layout/);
  assert.match(styles, /\.wb-workbench-pane/);
  assert.match(styles, /\.wb-pane-tabbar/);
  assert.match(styles, /\.wb-pane-actions/);
  assert.match(styles, /\.wb-split-menu/);
  assert.match(styles, /\.wb-split-divider/);
});

test("table design editor exposes SQL preview and explicit ALTER TABLE confirmation", () => {
  const editor = read("./components/TableDesignEditor.vue");
  const saveButton = editor.match(/<button[^>]*class="wb-design-primary"[\s\S]*?>保存<\/button>/)?.[0] || "";
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
  assert.match(commentRule, /font-size:\s*12\.5px/);
  assert.match(commentRule, /line-height:\s*1\.45/);
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
  assert.match(sidebar, /SidebarSearchPanel/);
  assert.doesNotMatch(sidebar, /browserColumnsRef|navTreeStyle|startBrowserResize|wb-browser-split-divider|wb-table-column/);
  assert.doesNotMatch(styles, /\.wb-browser-split-divider|\.wb-table-column/);
});

test("table copy dialog uses a flat table list with target selection in the header", () => {
  const dialog = read("./components/TableCopyDialog.vue");
  const header = dialog.match(/<header[^>]*class="[^"]*wb-dialog-header[^"]*"[\s\S]*?<\/header>/)?.[0] || "";

  assert.doesNotMatch(dialog, /发送表结构/);
  assert.doesNotMatch(dialog, /全部展开|全部折叠/);
  assert.doesNotMatch(dialog, /wb-table-copy-group-header|wb-table-copy-chevron|collapsedGroups|tableGroups/);
  assert.match(dialog, /filteredTables/);
  assert.match(dialog, /visibleRows/);
  assert.match(dialog, /@scroll\.passive="onScroll"/);
  assert.doesNotMatch(dialog, /addEventListener\("scroll"|removeEventListener\("scroll"/);
  assert.match(header, /aria-label="目标数据库"[\s\S]*请选择目标数据库/);
  assert.match(header, /aria-label="关闭发送窗口"/);
});

test("sidebar search panel shows schema and value result groups", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const panel = read("./components/SidebarSearchPanel.vue");
  const styles = read("./workbench.css");

  assert.match(sidebar, /import\s+SidebarSearchPanel\s+from\s+["']\.\/SidebarSearchPanel\.vue["']/);
  assert.match(sidebar, /<SidebarSearchPanel/);
  assert.match(panel, /搜索表、备注、字段；回车搜索值/);
  assert.match(panel, /结构结果/);
  assert.match(panel, /值结果/);
  assert.match(panel, /matchKindLabel/);
  assert.match(panel, /class="wb-search-hit-badge"/);
  assert.match(panel, /class="wb-search-hit-label"/);
  assert.match(panel, /按 Enter 搜索具体值/);
  assert.match(panel, /至少 1 处/);
  assert.match(panel, /search-values/);
  assert.match(panel, /open-schema-result/);
  assert.match(panel, /open-value-result/);
  assert.match(styles, /\.wb-sidebar-search-panel/);
  assert.match(styles, /\.wb-search-result-group/);
  assert.match(styles, /\.wb-search-hit-badge/);
  assert.match(styles, /\.wb-search-hit-label/);
});

test("sidebar search input is not constrained by the result panel height", () => {
  const panel = read("./components/SidebarSearchPanel.vue");

  assert.match(panel, /<label\s+class="wb-table-search"[\s\S]*?<\/label>\s*<section\s+class="wb-sidebar-search-panel"/);
  assert.doesNotMatch(panel, /<section\s+class="wb-sidebar-search-panel">\s*<label\s+class="wb-table-search"/);
});

test("readability copy pass uses explicit actions and localized ellipses", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dataGrid = read("./components/DataGrid.vue");
  const inspector = read("./components/InspectorPanel.vue");
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
  assert.match(inspector, /class="wb-inspector-table-count"/);
  assert.match(inspector, /字段备注/);
  assert.doesNotMatch(inspector, /<strong>字段备注<\/strong>/);
  assert.match(inspector, /<SelectedCellIdentity[\s\S]*class="wb-inspector-cell-identity"/);
  assert.match(inspector, /<section class="wb-text-panel"[\s\S]*<div class="wb-detail-editor"[\s\S]*<section class="wb-inspector-cell-panel"[\s\S]*<SelectedCellIdentity[\s\S]*<\/section>\s*<\/section>/);
  assert.match(connection, /连接服务器/);
  assert.match(orchestrator, /重命名表/);
  assert.match(copyDialog, /发送所选表/);
  assert.match(designEditor, /保存备注/);
  assert.match(designEditor, /执行 ALTER TABLE/);
  assert.match(designEditor, /编辑字段备注/);
  assert.match(rowSelection, /删除选中行/);

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
  assert.match(panel, /moveSidebarSearchSelection/);
  assert.match(panel, /emit\(["']search-values["']\)/);
  assert.match(panel, /emit\(["']open-schema-result["']/);
  assert.match(panel, /emit\(["']open-value-result["']/);
  assert.match(panel, /keyboard-selected/);
  assert.match(panel, /aria-selected/);
  assert.match(styles, /\.wb-search-result\.keyboard-selected/);
});

test("sidebar search opens explicitly selected schema results and hides schema after value search", () => {
  const panel = read("./components/SidebarSearchPanel.vue");
  const state = read("./sidebarSearchState.js");

  assert.match(state, /selectionTouched/);
  assert.match(panel, /const\s+visibleSchemaResults\s*=/);
  assert.match(panel, /const\s+visibleValueResults\s*=/);
  assert.match(panel, /hasFreshValues\.value\s*\|\|\s*props\.searchState\.valueLoading/);
  assert.match(panel, /props\.searchState\.selectionTouched/);
  assert.match(panel, /activateItem\(visibleItems\.value\[selectedIndex\.value\]\)/);
  assert.match(panel, /emit\("search-values"\)/);
  assert.doesNotMatch(panel, /v-if="hasQuery"/);
  assert.match(panel, /v-if="hasQuery && visibleSchemaResults\.length"/);
  assert.match(panel, /v-for="\(\s*result,\s*index\s*\)\s+in\s+visibleSchemaResults"/);
  assert.match(panel, /v-for="\(\s*result,\s*index\s*\)\s+in\s+visibleValueResults"/);
  assert.match(panel, /selectedIndex\s*===\s*index/);
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

test("workbench wires table design entry points from keyboard and context menu", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const menu = read("./components/ContextMenu.vue");

  assert.match(orchestrator, /function\s+openTableDesign\(tableLike/);
  assert.match(orchestrator, /openTableDesignTab\(workspace,\s*\{[\s\S]*connectionId[\s\S]*database[\s\S]*tableName[\s\S]*tableComment[\s\S]*\}\)/);
  assert.match(orchestrator, /statusText\.value\s*=\s*`已打开表设计：\$\{tableName\}`/);
  assert.match(orchestrator, /key\.toLowerCase\(\)\s*===\s*["']d["']/);
  assert.match(orchestrator, /event\.(ctrlKey|metaKey)[\s\S]*event\.(metaKey|ctrlKey)/);
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
  assert.match(menu, /v-if="tableScoped"[\s\S]*>表设计</);
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
  assert.match(menu, /覆盖同步…/);
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
  assert.match(dialog, /<span>源库<\/span>[\s\S]*<select[^>]*:value="sync\.dialog\.sourceDatabase"/);
  assert.match(dialog, /<option\s+v-for="database in sync\.sourceDatabaseOptions\.value"/);
  assert.match(dialog, /<span>目标库<\/span>[\s\S]*<select[^>]*:value="sync\.dialog\.targetDatabase"/);
  assert.match(dialog, /<option\s+v-for="database in sync\.availableTargetDatabases\.value"/);
  assert.match(dialog, /@change="targetChanged"/);
  assert.match(orchestrator, /@target-change="databaseSync\.setTargetDatabase"/);
});

test("database sync dialog uses source table dropdown exclusions", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dialog = read("./components/DatabaseSyncDialog.vue");

  assert.match(dialog, /v-model="sync\.dialog\.selectedExclusionTable"/);
  assert.match(dialog, /<option\s+v-for="tableName in sync\.availableExclusionTables\.value"/);
  assert.doesNotMatch(dialog, /v-model="sync\.dialog\.exclusionInput"/);
  assert.doesNotMatch(dialog, /<textarea[\s\S]*aria-label="排除表"/);
  assert.match(orchestrator, /@add-exclusions="databaseSync\.addSelectedExclusion"/);
});

test("database sync dialog allows direct execution without preview step", () => {
  const dialog = read("./components/DatabaseSyncDialog.vue");

  assert.match(dialog, /executeButtonLabel/);
  assert.match(dialog, /开始覆盖同步/);
  assert.match(dialog, /使用当前配置开始覆盖同步/);
  assert.doesNotMatch(dialog, /先预览后同步/);
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
  assert.match(tabs, /paneId:\s*props\.paneId/);
  assert.match(orchestrator, /closePaneTabs/);
  assert.doesNotMatch(orchestrator, /closeAllTableTabs/);
  assert.match(orchestrator, /function\s+closeAllTabsFromMenu/);
  assert.match(orchestrator, /@tab-contextmenu="openTabContextMenu"/);
  assert.match(orchestrator, />全部关闭</);
});

test("workbench clears stale cell validation errors on refresh and tab close", () => {
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(orchestrator, /import\s+\{\s*createEditState[\s\S]*clearCellErrorsForTable[\s\S]*\}\s+from\s+["']\.\/editState\.js["']/);
  assert.match(orchestrator, /function\s+tabErrorScopeKey\(tab\)/);
  assert.match(orchestrator, /function\s+clearTabCellErrors\(tab\)/);
  assert.match(orchestrator, /async\s+function\s+refreshTabPage\(tab,\s*page\)/);
  assert.match(orchestrator, /const\s+result\s*=\s*await\s+fetchPage\(tab,\s*page\)/);
  assert.match(orchestrator, /if\s*\(result\?\.ok\)\s+clearTabCellErrors\(tab\)/);
  assert.match(orchestrator, /useContextMenu\([\s\S]*onTablePageRefreshed:\s*clearTabCellErrors[\s\S]*\)/);
  assert.match(orchestrator, /function\s+closeTab\(paneIdOrTabId,\s*maybeTabId\)\s*\{[\s\S]*clearTabCellErrors\(tab\)[\s\S]*closePaneTab\(workspace,\s*paneId,\s*tabId\)/);
  assert.match(orchestrator, /function\s+closeAllTabsFromMenu\(\)\s*\{[\s\S]*closePaneTabs\(workspace,\s*paneId\)[\s\S]*closedTabs\.forEach\(clearTabCellErrors\)/);
});

test("data grid exposes its real scroll wrapper to editor and virtual grid", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const dataGrid = read("./components/DataGrid.vue");

  assert.match(dataGrid, /grid-ready/);
  assert.match(dataGrid, /emit\(["']grid-ready["'],\s*gridWrapRef\.value\)/);
  assert.match(pane, /function\s+setGridWrapElement/);
  assert.match(pane, /@grid-ready="setGridWrapElement"/);
});

test("data grid sorts from a hover-revealed column menu instead of header clicks", () => {
  const grid = read("./components/DataGrid.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const menu = read("./components/ColumnSortMenu.vue");
  const styles = read("./workbench.css");

  assert.match(grid, /import\s+ColumnSortMenu\s+from\s+["']\.\/ColumnSortMenu\.vue["']/);
  assert.match(grid, /'apply-sort'/);
  assert.match(grid, /<ColumnSortMenu/);
  assert.match(grid, /@apply-sort="emit\('apply-sort', tab, columnName\(column\), \$event\)"/);
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
  assert.match(triggerRule, /font-size:\s*18px/);
  assert.match(triggerRule, /border:\s*0/);
  assert.match(triggerRule, /border-radius:\s*0/);
  assert.match(triggerRule, /background:\s*transparent/);
  const triggerHoverRule = styles.match(/\.wb-column-sort-trigger:hover,[\s\S]*?\.wb-column-sort\.is-open \.wb-column-sort-trigger\s*\{([^}]*)\}/s)?.[1] || "";
  assert.doesNotMatch(triggerHoverRule, /background:/);
  assert.doesNotMatch(triggerHoverRule, /border-color:/);
});

test("table search uses Ctrl+F and input scanning instead of backend filtering", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const dataGrid = read("./components/DataGrid.vue");

  assert.match(pane, /import\s+\{\s*useTableSearch\s*\}\s+from\s+["']\.\.\/composables\/useTableSearch\.js["']/);
  assert.match(pane, /handleTableFindKeydown\(event\)/);
  assert.match(orchestrator, /@keydown="handleWorkbenchKeydown"/);
  assert.match(pane, /@search-input="runTableSearch"/);
  assert.match(pane, /@search-ready="setSearchInputElement"/);
  assert.match(pane, /props\.loadNextPage\(tab\)/);
  assert.match(pane, /maybeLoadMoreRows\(event\)/);
  assert.doesNotMatch(dataGrid, /@keydown\.enter\.prevent="emit\('filter-page'/);
  assert.match(dataGrid, /search-ready/);
  assert.match(dataGrid, /search-input/);
});

test("table search cell selection resolves columns from the searched tab", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const selectCellAtBody = pane.match(/function\s+selectCellAt\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

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
  assert.match(styles, /\.wb-inspector-cell-panel\s*\{[^}]*background:\s*var\(--wb-status-surface\)/s);
  assert.match(styles, /\.wb-workspace\s*\{[^}]*background:\s*var\(--wb-chrome-surface\)/s);
  assert.match(styles, /\.wb-sidebar\s*\{[^}]*background:\s*var\(--wb-chrome-surface\)/s);
});

test("grid readability uses comfortable density and stronger theme contrast tokens", () => {
  const styles = read("./workbench.css");
  const constants = read("./constants.js");
  const rootRule = styles.match(/:root\s*\{([^}]*)\}/s)?.[1] || "";
  const darkRule = styles.match(/\.mysql-workbench\[data-theme="dark"\]\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(constants, /GRID_ROW_HEIGHT\s*=\s*28/);
  assert.match(styles, /\.wb-grid\s*\{[^}]*font-size:\s*13\.5px/s);
  assert.match(styles, /\.wb-grid th,\s*\.wb-grid td\s*\{[^}]*height:\s*28px/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*height:\s*27px/s);
  assert.match(styles, /\.wb-cell-text,\s*\.wb-grid td input\s*\{[^}]*line-height:\s*27px/s);
  assert.match(rootRule, /--wb-quiet-text:\s*#4f5661/);
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

test("schema search hits highlight table headers and inspector remarks with dedicated navigation", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const pane = read("./components/WorkbenchPane.vue");
  const grid = read("./components/DataGrid.vue");
  const inspector = read("./components/InspectorPanel.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /schemaSearchMatches/);
  assert.match(orchestrator, /openSidebarSchemaResult/);
  assert.match(orchestrator, /setSchemaSearchMatches/);
  assert.match(orchestrator, /@schema-search-next="focusedPaneState\.goToNextSchemaSearchMatch/);
  assert.match(pane, /schemaSearchMatches/);
  assert.match(pane, /goToNextSchemaSearchMatch/);
  assert.match(pane, /goToPreviousSchemaSearchMatch/);
  assert.match(pane, /schema-search-next/);
  assert.match(grid, /schemaSearchSummary/);
  assert.match(grid, /schema-search-match/);
  assert.match(grid, /isSchemaSearchColumn/);
  assert.match(inspector, /schemaSearchQuery/);
  assert.match(inspector, /highlightSearchText/);
  assert.match(inspector, /isSchemaSearchColumn/);
  assert.match(styles, /\.wb-schema-search-nav/);
  assert.match(styles, /\.wb-grid th\.schema-search-match/);
  assert.match(styles, /\.wb-schema-list article\.schema-search-match/);
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
  assert.match(styles, /\.wb-schema-field-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)[^}]*font-size:\s*12\.5px[^}]*line-height:\s*1\.6/s);
  assert.match(styles, /\.wb-schema-key-badge\s*\{[^}]*color:\s*var\(--wb-accent-strong\)/s);
  assert.match(styles, /\.wb-schema-list article\.is-selected\s*\{[^}]*background:\s*var\(--wb-accent-soft\)/s);
  assert.match(styles, /\.wb-database-item\s*\{[^}]*color:\s*var\(--wb-database-text\)/s);
  assert.match(styles, /\.wb-table-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)[^}]*font-size:\s*12\.5px/s);
  assert.match(styles, /\.wb-tab-title small\s*\{[^}]*color:\s*var\(--wb-type-text\)/s);
  assert.match(styles, /\.wb-inspector-table-comment\s*\{[^}]*color:\s*var\(--wb-remark-text\)[^}]*font-size:\s*12\.5px/s);
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
  const pane = read("./components/WorkbenchPane.vue");
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
  assert.match(dataGrid, /getInsertRowKey/);
  assert.doesNotMatch(dataGrid, /insert-commit/);
  assert.doesNotMatch(dataGrid, /insert-save-all/);
  assert.doesNotMatch(dataGrid, /保存新增/);
  assert.match(dataGrid, /v-for="\(insertRow, insertRowIndex\) in isInsertRowVisible\(tab\) \? getInsertRows\(tab\) : \[\]"/);
  assert.match(dataGrid, /tab\.rows\.length \+ insertRowIndex \+ 1/);
  assert.doesNotMatch(dataGrid, /insertRowIndex \+ 1 \}\}\*/);
  assert.match(dataGrid, /:data-row-key="insertRowKey\(tab, insertRow\)"/);
  assert.match(dataGrid, /:data-column-name="columnName\(column\)"/);
  assert.match(dataGrid, /:data-column-index="columnIndex"/);
  assert.match(dataGrid, /getCellRangeClasses\(tab, insertRowKey\(tab, insertRow\), columnName\(column\), tab\.rows\.length \+ insertRowIndex, columnIndex\)/);
  assert.match(dataGrid, /@mousedown\.left="emit\('cell-mousedown', tab, insertRowObject\(insertRow\), columnName\(column\), tab\.rows\.length \+ insertRowIndex, columnIndex, \$event\)"/);
  assert.match(dataGrid, /v-if="editingCell\?\.rowKey === insertRowKey\(tab, insertRow\) && editingCell\?\.column === columnName\(column\)"/);
  assert.match(dataGrid, /highlightInsertCell\(tab, insertRow, column\)/);
  assert.match(dataGrid, /data-insert-row-id/);
  assert.match(dataGrid, /insert-paste/);
  assert.match(dataGrid, /@paste\.prevent\.stop="emit\('insert-paste', tab, insertRow\.id, columnIndex, \$event\)"/);
  assert.match(dataGrid, /insert-row-select/);
  assert.match(dataGrid, /@click\.stop="emit\('insert-row-select', tab, insertRow\.id, \$event\)"/);
  assert.match(dataGrid, /row-select-start/);
  assert.match(dataGrid, /row-select-enter/);
  assert.match(dataGrid, /row-select-end/);
  assert.doesNotMatch(dataGrid, /wb-batch-bar/);
  assert.match(pane, /function\s+selectGridRow/);
  assert.match(pane, /function\s+startGridRowDragSelection/);
  assert.match(pane, /extendRowDragSelection/);
  assert.match(pane, /finishRowDragSelection/);
  assert.match(pane, /function\s+selectGridInsertRow/);
  assert.match(pane, /:selected-insert-row="selectedInsertRow"/);
  assert.match(pane, /:get-insert-rows="getInsertRows"/);
  assert.match(pane, /:get-insert-row-key="getInsertRowKey"/);
  assert.match(pane, /:is-insert-row-visible="isInsertRowVisible"/);
  assert.match(pane, /@insert-row-select="selectGridInsertRow"/);
  assert.match(pane, /@row-select-start="startGridRowDragSelection"/);
  assert.match(pane, /@row-select-enter="extendRowDragSelection"/);
  assert.match(pane, /@row-select-end="finishRowDragSelection"/);
  assert.doesNotMatch(pane, /@insert-commit/);
  assert.match(orchestrator, /@pointerdown\.capture="maybeAutoSaveInsertDrafts"/);
  assert.match(orchestrator, /function\s+maybeAutoSaveInsertDrafts/);
  assert.match(orchestrator, /event\?\.target\?\.closest\?\.\("\.wb-insert-row"\)/);
  assert.match(orchestrator, /hasInsertDrafts\(tab\)/);
  assert.match(orchestrator, /focusedPaneState\.commitInsertRowsAndRefresh/);
  assert.match(orchestrator, /function\s+saveFocusedTextPanel/);
  assert.match(orchestrator, /@save-text-panel="saveFocusedTextPanel"/);
  assert.match(orchestrator, /commitInsertRowsAndRefresh\(tab\)/);
  assert.match(pane, /clearSelection\(\)/);
  assert.match(pane, /handleGridKeydownWithRows/);
  assert.match(pane, /const result = await handleGridKeydown\(event\)/);
  assert.match(pane, /result\?\.insertedRows > 0/);
  assert.match(pane, /refreshTabPage\(tab, tab\.page \|\| 1\)/);
  assert.match(pane, /deleteSelectedRows\(tab\)/);
  assert.match(pane, /@insert-keydown="handleInsertKeydown"/);
  assert.match(pane, /@insert-paste="pasteIntoInsertInput"/);
  assert.doesNotMatch(dataGrid, /@keydown\.enter\.prevent\.stop="emit\('insert-commit'/);
  assert.match(pane, /function\s+matchesInsertedDraft/);
  assert.match(pane, /function\s+selectVisibleInsertedRow/);
  assert.match(styles, /\.wb-grid-row\.row-selected/);
  assert.match(styles, /\.wb-row-header/);
  assert.match(styles, /\.wb-insert-row td\.insert-selected/);
});

test("data grid wires Excel-like drag range selection", () => {
  const pane = read("./components/WorkbenchPane.vue");
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
  assert.match(pane, /@cell-mousedown="startGridRangeSelection"/);
  assert.match(pane, /function\s+startGridRangeSelection/);
  assert.match(pane, /startRangeSelection\(\.\.\.args\)/);
  assert.match(pane, /@cell-enter="extendRangeSelection"/);
  assert.match(pane, /@range-pointer="extendRangeSelectionFromPointer"/);
  assert.match(pane, /@range-end="finishRangeSelection"/);
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

test("sidebar table rows expose F2 as the rename shortcut", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");

  assert.match(sidebar, /"rename-table"/);
  assert.match(sidebar, /function\s+renameSelectedTable/);
  assert.match(sidebar, /event\.key\s*===\s*["']F2["']/);
  assert.match(sidebar, /event\.preventDefault\(\)/);
  assert.match(sidebar, /event\.stopPropagation\(\)/);
  assert.match(sidebar, /@keydown="renameSelectedTable\(\$event,\s*table\)"/);
  assert.match(orchestrator, /function\s+openTableRenameFromSource/);
  assert.match(orchestrator, /@rename-table="openTableRenameFromSource"/);
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
  const pane = read("./components/WorkbenchPane.vue");
  const grid = read("./components/DataGrid.vue");

  assert.match(grid, /hasSearchMatches/);
  assert.match(grid, /search-previous/);
  assert.match(grid, /search-next/);
  assert.match(grid, /@keydown\.enter\.prevent="emit\('search-next'\)"/);
  assert.doesNotMatch(grid, /v-if="hasSearchMatches"/);
  assert.match(grid, /:disabled="!hasSearchMatches"/);
  assert.match(grid, />上一个<\/button>/);
  assert.match(grid, />下一个<\/button>/);
  assert.match(pane, /:has-search-matches="hasSearchMatches"/);
  assert.match(pane, /@search-previous="goToPreviousSearchMatch"/);
  assert.match(pane, /@search-next="goToNextSearchMatch"/);
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

test("sidebar value result activation opens table and runs table search", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const mock = read("./mock/mockBackend.js");

  assert.match(orchestrator, /createSidebarSearchState/);
  assert.match(orchestrator, /clearValueSearchResults/);
  assert.match(orchestrator, /watch\(\s*\r?\n\s*\(\)\s*=>\s*\[selectedConnectionId\.value,\s*selectedDatabase\.value\]/);
  assert.match(orchestrator, /clearValueSearchResults\(sidebarSearch\)/);
  assert.match(orchestrator, /buildSchemaSearchResults/);
  assert.match(orchestrator, /runSidebarValueSearch/);
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
  assert.match(orchestrator, /focusedPaneState\.runTableSearch\?\.\(query\)/);
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
  assert.match(panel, /wb-value-search-progress/);
  assert.match(panel, /role="progressbar"/);
  assert.match(state, /valueProgress/);
  assert.match(state, /updateValueSearchProgress/);
  assert.match(styles, /\.wb-value-search-progress/);
  assert.match(commands, /SEARCH_VALUES_PROGRESS_EVENT/);
  assert.match(commands, /window\.emit\(SEARCH_VALUES_PROGRESS_EVENT/);
});
