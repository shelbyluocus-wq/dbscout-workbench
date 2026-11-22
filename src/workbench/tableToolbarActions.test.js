import { readLocalizedContractSource } from "./test-support/localizedContractSource.js";
import test from "node:test";
import assert from "node:assert/strict";

const read = (path) => readLocalizedContractSource(new URL(path, import.meta.url), "utf8");

test("data table toolbar exposes direct actions and dropdown choices", () => {
  const grid = read("./components/DataGrid.vue");
  const home = read("./components/DatabaseHome.vue");
  const styles = read("./workbench.css");

  assert.match(grid, /ToolbarSplitButton/);
  assert.match(grid, /label="导出"[\s\S]*?@primary="emit\('export'\)"/);
  assert.match(grid, /createTableImportToolbarActions/);
  assert.match(grid, /:label="importActions\.primary\.label"[\s\S]*?@primary="emit\(resolveTableImportToolbarEvent\(importActions\.primary\.id\)\)"/);
  assert.match(grid, /label="分屏"[\s\S]*?@primary="emit\('split-pane', 'right'\)"/);
  assert.match(grid, /批量导出/);
  assert.match(grid, /左右分屏/);
  assert.match(grid, /上下分屏/);
  assert.doesNotMatch(grid, /wb-split-more-btn/);
  assert.match(grid, /wb-table-toolbar-actions wb-toolbar-action-group/);
  assert.match(home, /wb-toolbar-action-group wb-dbhome-action-group/);
  assert.match(styles, /\.wb-toolbar-action-group\s*\{/);
});

test("freeze leads the table action group with direct and menu actions", () => {
  const grid = read("./components/DataGrid.vue");

  assert.match(
    grid,
    /wb-table-toolbar-actions wb-toolbar-action-group[\s\S]*?label="冻结"[\s\S]*?label="导出"/,
  );
  assert.match(grid, /label="冻结"[\s\S]*?@primary="applyDefaultFreeze"/);
  assert.match(grid, /label="冻结"[\s\S]*?icon="freeze"/);
  assert.match(grid, /冻结到当前单元格/);
  assert.match(grid, /冻结到当前行/);
  assert.match(grid, /冻结到当前列/);
  assert.match(grid, /冻结首行/);
  assert.match(grid, /冻结首列/);
  assert.match(grid, /取消冻结/);
});

test("freeze choices use the shared menu icon vocabulary", () => {
  const grid = read("./components/DataGrid.vue");
  const component = read("./components/ToolbarSplitButton.vue");
  const icons = read("./components/ToolbarActionIcon.vue");

  for (const icon of ["freeze-cell", "freeze-row", "freeze-column", "unfreeze"]) {
    assert.match(grid, new RegExp(`icon: "${icon}"`));
    assert.match(icons, new RegExp(`"?${icon}"?:`));
  }
  assert.match(component, /ToolbarActionIcon/);
});

test("homepage and table actions use the same icon component and visual tokens", () => {
  const home = read("./components/DatabaseHome.vue");
  const component = read("./components/ToolbarSplitButton.vue");
  const icons = read("./components/ToolbarActionIcon.vue");
  const styles = read("./workbench.css");

  assert.match(home, /<ToolbarActionIcon name="export"/);
  assert.match(home, /<ToolbarActionIcon name="import"/);
  assert.match(component, /<ToolbarActionIcon v-if="icon" :name="icon"/);
  assert.match(icons, /export:\s*ArrowDownToLine/);
  assert.match(icons, /import:\s*ArrowUpFromLine/);
  assert.match(icons, /"split-right":\s*PanelLeft/);
  assert.match(styles, /\.wb-toolbar-action-icon svg\s*\{[^}]*stroke-width:\s*1\.45/s);
  assert.match(styles, /\.wb-toolbar-action-group > \.wb-toolbar-action-button,[\s\S]*?\.wb-toolbar-action-group > \.wb-toolbar-split-button\s*\{[^}]*color:\s*var\(--wb-text\)/s);
  assert.match(styles, /\.wb-toolbar-action-group span\s*\{[^}]*color:\s*inherit[^}]*font-size:\s*inherit/s);
  assert.match(styles, /\.wb-toolbar-action-group \.wb-toolbar-split-button-main\s*\{[^}]*min-width:\s*70px[^}]*padding:\s*0 9px/s);
  assert.match(styles, /\.wb-toolbar-action-group \.wb-toolbar-split-button-caret\s*\{[^}]*width:\s*26px[^}]*min-width:\s*26px/s);
});

test("table search mode is a single setting control inside the search field", () => {
  const grid = read("./components/DataGrid.vue");
  const component = read("./components/ToolbarSplitButton.vue");
  const styles = read("./workbench.css");

  assert.match(grid, /wb-table-search-field[\s\S]*?wb-search-mode-control/);
  assert.match(grid, /menu-label="搜索匹配方式"/);
  assert.match(grid, /filter-continuous/);
  assert.match(grid, /primary-opens-menu[\s\S]*?single-trigger/);
  assert.match(component, /singleTrigger/);
  assert.match(component, /class="wb-toolbar-menu-button"/);
  assert.match(styles, /\.wb-table-search-field \.wb-search-mode-control\.wb-toolbar-split-button/);
  assert.match(styles, /\.wb-table-toolbar \.wb-search-mode-control \.wb-toolbar-menu-button\s*\{[^}]*font-size:\s*var\(--wb-fs-body\)/s);
});

test("table and homepage toolbars progressively collapse in narrow split panes", () => {
  const grid = read("./components/DataGrid.vue");
  const home = read("./components/DatabaseHome.vue");
  const component = read("./components/ToolbarSplitButton.vue");
  const icons = read("./components/ToolbarActionIcon.vue");
  const styles = read("./workbench.css");

  assert.match(grid, /class="wb-toolbar-compact-overflow wb-table-toolbar-overflow"/);
  assert.equal((grid.match(/class="wb-table-toolbar-secondary"/g) || []).length, 2, "freeze and split yield first");
  assert.match(grid, /class="wb-table-toolbar-more"[\s\S]*?:items="secondaryActionItems"/);
  assert.match(grid, /:items="compactActionItems"/);
  assert.match(grid, /id: "export-current"/);
  assert.match(grid, /\.\.\.importActions\.value\.compactItems/);
  assert.match(home, /class="wb-toolbar-compact-overflow wb-dbhome-overflow"/);
  assert.match(home, /:items="compactActionItems"/);
  assert.match(component, /<ToolbarActionIcon v-if="icon" :name="icon" \/>/);
  assert.match(icons, /more:\s*Ellipsis/);
  assert.match(grid, /<header ref="tableToolbarRef" class="wb-table-toolbar">/);
  assert.match(grid, /useToolbarFit\(tableToolbarRef, \{\s*maxLevel: 3,/);
  assert.match(styles, /\.wb-table-toolbar\[data-fit="3"\] \.wb-table-toolbar-actions\s*\{[^}]*display:\s*none/);
  assert.match(styles, /\.wb-table-toolbar\[data-fit="3"\] \.wb-table-toolbar-overflow\s*\{[^}]*display:\s*inline-flex/);
  assert.match(home, /<div ref="homeToolbarRef" class="wb-dbhome-toolbar"/);
  assert.match(home, /useToolbarFit\(homeToolbarRef, \{\s*maxLevel: 3,/);
  assert.match(styles, /\.wb-dbhome-toolbar\[data-fit="3"\] \.wb-dbhome-action-group\s*\{[^}]*display:\s*none/);
  assert.match(styles, /\.wb-dbhome-toolbar\[data-fit="3"\] \.wb-dbhome-overflow\s*\{[^}]*display:\s*inline-flex/);
  assert.match(styles, /\.wb-dbhome-toolbar:is\(\[data-fit="2"\], \[data-fit="3"\]\) \.wb-dbhome-close-pane span\s*\{[^}]*display:\s*none/);
  assert.match(styles, /\[data-fit-measuring\] \*\s*\{[^}]*transition:\s*none/);
  assert.match(styles, /\.wb-dbhome-action-button > \.wb-toolbar-action-label/);
  assert.doesNotMatch(styles, /\.wb-dbhome-action-button > span/);
});

test("toolbar dropdowns share one accessible floating menu component", () => {
  const component = read("./components/ToolbarSplitButton.vue");
  const styles = read("./workbench.css");

  assert.match(component, /<Teleport to="body">/);
  assert.match(component, /role="menu"/);
  assert.match(component, /aria-haspopup="menu"/);
  assert.match(component, /aria-expanded/);
  assert.match(component, /:aria-label="resolvedMenuLabel"/);
  assert.match(component, /Escape/);
  assert.match(styles, /\.wb-toolbar-split-button/);
  assert.match(styles, /\.wb-toolbar-action-menu/);
  assert.match(
    styles,
    /\.wb-toolbar-action-menu\s*\{[^}]*background:\s*var\(--wb-surface\)/s,
    "toolbar dropdowns should stay nearly opaque over dense table content",
  );
  assert.match(
    styles,
    /\.wb-toolbar-split-button\s*\{[^}]*color:\s*var\(--wb-text\)/s,
    "toolbar action labels should use the primary readable text color",
  );
  assert.match(
    styles,
    /\.wb-toolbar-action-menu-item\s*\{[^}]*color:\s*var\(--wb-text\)/s,
    "dropdown action labels should use the primary readable text color",
  );
  assert.match(
    styles,
    /\.wb-table-toolbar \.wb-table-search-field-input::placeholder\s*\{[^}]*color:\s*var\(--wb-text\)[^}]*font-weight:\s*500[^}]*opacity:\s*1/s,
    "table search placeholder should remain legible in the dark theme",
  );
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("direct toolbar actions close an open menu before running", () => {
  const component = read("./components/ToolbarSplitButton.vue");
  const handler = component.match(/function onMainClick\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(handler, /emit\("close"\);\s*emit\("primary"\);/);
});

test("workbench pane wires table actions and preserves non-data fallback menu", () => {
  const pane = read("./components/WorkbenchPane.vue");

  assert.match(pane, /@export="triggerExport"/);
  assert.match(pane, /@import="triggerImport"/);
  assert.match(pane, /@batch-export="batchExportFromMenu"/);
  assert.match(pane, /@batch-import="batchImportFromMenu"/);
  assert.match(pane, /@split-pane="splitPaneFromToolbar"/);
  assert.match(pane, /v-else-if="activeDesignTab"[\s\S]*?wb-split-more-btn/);
  assert.match(pane, /v-else[\s\S]*?wb-pane-empty-actions[\s\S]*?wb-split-more-btn/);
});

test("relation filter chip truncates cleanly so primary toolbar actions stay visible", () => {
  const styles = read("./workbench.css");
  assert.match(styles, /\.wb-relation-chip\s*\{[^}]*flex:\s*0 1 auto[^}]*max-width:\s*210px/s);
  assert.match(styles, /\.wb-relation-chip \.wb-sort-chip-label\s*\{[^}]*text-overflow:\s*ellipsis/s);
});

test("table search exposes a visible clickable clear button when a query is present", () => {
  const grid = read("./components/DataGrid.vue");
  const styles = read("./workbench.css");
  assert.match(grid, /class="wb-table-search-clear"[\s\S]*?@click="clearTableSearch"/);
  assert.match(
    styles,
    /\.wb-table-toolbar \.wb-table-search-clear\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/s,
  );
});

test("column sort/filter menu blocks header pointerdown selection and left-aligns when space permits", () => {
  const menu = read("./components/ColumnSortMenu.vue");
  assert.match(menu, /class="wb-column-sort"[\s\S]*?@pointerdown\.stop/);
  assert.match(menu, /triggerRect\.left\s*\+\s*menuWidth\s*<=\s*viewportWidth\s*-\s*margin/);
});

test("sidebar locale badge stays on one line and home table names ellipsis cleanly before badges", () => {
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const tableList = read("./components/DatabaseTableList.vue");
  const styles = read("./workbench.css");
  assert.match(sidebar, /'has-locale-pill':\s*sidebarLocaleMeta\(entry\.table\)\?\.kind\s*===\s*'base'/);
  assert.match(styles, /\.wb-table-item\.has-locale-pill\s*\{[^}]*grid-template-columns:\s*var\(--wb-tree-icon-width\) minmax\(0, 1fr\) auto/s);
  assert.match(tableList, /class="wb-dbhome-object-name-text"/);
  assert.match(styles, /\.wb-dbhome-object-name-text\s*\{[^}]*display:\s*block[^}]*text-overflow:\s*ellipsis/s);
});

test("find and replace column scope select preserves the dropdown chevron", () => {
  const styles = read("./workbench.css");
  const match = styles.match(/(?:\r?\n){2}\.wb-find-replace-body \.wb-replace-field select\s*\{([^}]*)\}/s);
  assert.ok(match, "expected standalone find-replace select rule");
  assert.match(match[1], /background-color:\s*var\(--wb-surface\)/);
  assert.doesNotMatch(match[1], /(^|[\s;])background\s*:/);
  assert.match(match[1], /padding:\s*0 30px 0 8px/);
});
