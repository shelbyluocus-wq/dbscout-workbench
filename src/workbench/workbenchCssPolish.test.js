import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, "workbench.css"), "utf8");
const orchestratorVue = readFileSync(join(__dirname, "MySqlWorkbench.vue"), "utf8");
const paneVue = readFileSync(join(__dirname, "components", "WorkbenchPane.vue"), "utf8");
const splitLayoutVue = readFileSync(join(__dirname, "components", "WorkbenchSplitLayout.vue"), "utf8");
const tabsVue = readFileSync(join(__dirname, "components", "WorkbenchTabs.vue"), "utf8");
const dataGridVue = readFileSync(join(__dirname, "components", "DataGrid.vue"), "utf8");
const toolbarSplitButtonVue = readFileSync(join(__dirname, "components", "ToolbarSplitButton.vue"), "utf8");
const quickOpenPaletteVue = readFileSync(join(__dirname, "components", "QuickOpenPalette.vue"), "utf8");
const quickOpenKindFilterVue = readFileSync(join(__dirname, "components", "QuickOpenKindFilter.vue"), "utf8");
const sidebarSearchPanelVue = readFileSync(join(__dirname, "components", "SidebarSearchPanel.vue"), "utf8");
const confirmDialogVue = readFileSync(join(__dirname, "components", "ConfirmDialog.vue"), "utf8");
const tableCopyDialogVue = readFileSync(join(__dirname, "components", "TableCopyDialog.vue"), "utf8");
const tableCopySelectionPanelVue = readFileSync(join(__dirname, "components", "TableCopySelectionPanel.vue"), "utf8");
const batchExportDialogVue = readFileSync(join(__dirname, "components", "BatchExportDialog.vue"), "utf8");
const databaseDisplayDialogVue = readFileSync(join(__dirname, "components", "DatabaseDisplayDialog.vue"), "utf8");
const databaseColorPickerVue = readFileSync(join(__dirname, "components", "DatabaseColorPicker.vue"), "utf8");
const databaseHomeVue = readFileSync(join(__dirname, "components", "DatabaseHome.vue"), "utf8");
const databaseTableListVue = readFileSync(join(__dirname, "components", "DatabaseTableList.vue"), "utf8");

function ruleBodies(selector) {
  const bodies = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rulePattern.exec(css))) {
    const selectorText = match[1].replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = selectorText.split(",").map((part) => part.trim()).filter(Boolean);
    if (selectors.includes(selector)) bodies.push(match[2]);
  }
  assert.ok(bodies.length > 0, `Expected ${selector} rule to exist`);
  return bodies;
}

function ruleBody(selector) {
  return ruleBodies(selector).join("\n");
}

test("workspace frame is chrome while panes and inspector form the canvas", () => {
  const mainRule = ruleBody(".wb-main");
  // wb-main 自身即外框：与侧栏同一 chrome 调，不再描边/投影
  assert.match(mainRule, /background:\s*var\(--wb-chrome-surface\)/);
  assert.match(mainRule, /border:\s*none/);
  assert.match(mainRule, /border-radius:\s*0/);
  assert.match(mainRule, /box-shadow:\s*none/);
  assert.match(ruleBody(".wb-titlebar-inspector-controls"), /background:\s*var\(--wb-chrome-surface\)/);
  // 页签条属外框：chrome 底，活动页签以画布色向下流入内容区
  assert.match(ruleBody(".wb-pane-tabbar"), /background:\s*var\(--wb-chrome-surface\)/);
  // 检查器属区域 2（画布）
  const inspectorRule = ruleBody(".wb-inspector");
  assert.match(inspectorRule, /background:\s*var\(--wb-workspace-mist\)/);
  assert.match(inspectorRule, /border:\s*none/);
  assert.match(inspectorRule, /border-radius:\s*0/);
  assert.match(inspectorRule, /box-shadow:\s*none/);
});



test("titlebar avoids standalone vertical divider lines", () => {
  assert.doesNotMatch(orchestratorVue, /wb-titlebar-divider/);
  assert.doesNotMatch(css, /\.wb-titlebar-divider\s*\{/);
  assert.match(ruleBody(".wb-titlebar-tabs"), /box-shadow\s*:\s*none/);
  assert.match(ruleBody(".wb-titlebar-inspector-controls"), /box-shadow\s*:\s*none/);
});

test("titlebar action icons are larger while their controls stay vertically centered", () => {
  assert.match(ruleBody(".wb-header-btn"), /display\s*:\s*grid/);
  assert.match(ruleBody(".wb-header-btn"), /place-items\s*:\s*center/);
  assert.match(ruleBody(".wb-titlebar .wb-header-btn svg"), /width\s*:\s*16px/);
  assert.match(ruleBody(".wb-titlebar .wb-header-btn svg"), /height\s*:\s*16px/);
  assert.match(ruleBody(".wb-ai-entry-button"), /place-items\s*:\s*center/);
  assert.match(ruleBody(".wb-ai-entry-icon"), /width\s*:\s*18px/);
  assert.match(ruleBody(".wb-ai-entry-icon"), /height\s*:\s*18px/);
  assert.match(ruleBody(".wb-pin-entry-button"), /place-items\s*:\s*center/);
  assert.match(ruleBody(".wb-update-button"), /place-items\s*:\s*center/);
  assert.match(ruleBody(".wb-update-dot"), /width\s*:\s*10px/);
  assert.match(ruleBody(".wb-update-dot"), /height\s*:\s*10px/);
});

test("canvas outline masks darker pane content outside its smooth top-left corner", () => {
  const rootRule = ruleBody(":root");
  const titlebarTabsRule = ruleBody(".wb-titlebar-tabs");
  const mainRule = ruleBody(".wb-main");
  const cornerMaskRule = ruleBody(".wb-main::before");
  const outlineRule = ruleBody(".wb-main::after");
  const topEdgeTabbarRule = ruleBody(".wb-pane-tabbar.is-top-edge-pane");

  assert.match(rootRule, /--wb-workspace-corner-radius\s*:\s*12px/);
  assert.match(titlebarTabsRule, /background\s*:\s*var\(--wb-chrome-surface\)/);
  assert.match(mainRule, /position:\s*relative/);
  assert.match(cornerMaskRule, /top:\s*calc\(var\(--wb-titlebar-height\) - 1px\)/);
  assert.match(cornerMaskRule, /width:\s*var\(--wb-workspace-corner-radius\)/);
  assert.match(cornerMaskRule, /height:\s*var\(--wb-workspace-corner-radius\)/);
  assert.match(cornerMaskRule, /radial-gradient\(/);
  assert.match(cornerMaskRule, /var\(--wb-chrome-surface\)/);
  assert.match(cornerMaskRule, /pointer-events:\s*none/);
  assert.match(outlineRule, /inset:\s*calc\(var\(--wb-titlebar-height\) - 1px\) 0 0/);
  assert.match(outlineRule, /border-top:\s*1px solid var\(--wb-workspace-mist-border\)/);
  assert.match(outlineRule, /border-left:\s*1px solid var\(--wb-workspace-mist-border\)/);
  assert.match(outlineRule, /border-top-left-radius:\s*var\(--wb-workspace-corner-radius\)/);
  assert.match(outlineRule, /pointer-events:\s*none/);
  assert.match(topEdgeTabbarRule, /border-bottom-color:\s*transparent/);
  assert.doesNotMatch(css, /\.wb-workbench-pane:has\([^}]*radial-gradient\(/s);
  // Top-edge metadata keeps split-pane borders from adding another line beneath
  // the single main canvas outline.
  assert.match(paneVue, /topEdge:\s*\{\s*type:\s*Boolean,\s*default:\s*true\s*\}/);
  assert.match(paneVue, /'is-top-edge-pane':\s*topEdge/);
  assert.match(splitLayoutVue, /:top-edge="topEdge"/);
  assert.match(splitLayoutVue, /:top-edge="layout\.direction === 'vertical' \? false : topEdge"/);
});

test("focused split pane uses its active tab instead of a full pane outline", () => {
  const focusedPaneRule = ruleBody(".wb-workbench-pane.is-focused");
  const focusedPaneTabbarRule = ruleBody(".wb-pane-tabbar.is-focused-pane");
  const focusedActiveTabRule = ruleBody(".wb-pane-tabbar.is-focused-pane .wb-tab.active");
  const unfocusedActiveTabRule = ruleBody(".wb-pane-tabbar:not(.is-focused-pane) .wb-tab.active");

  assert.match(focusedPaneRule, /box-shadow\s*:\s*none/);
  assert.match(focusedPaneTabbarRule, /background\s*:/);
  assert.match(focusedActiveTabRule, /inset 0 2px 0 var\(--wb-accent\)/);
  assert.match(unfocusedActiveTabRule, /inset 0 1px 0 var\(--wb-tab-active-border\)/);
});

test("split resize handles keep a quiet persistent divider with a wider invisible hit target", () => {
  assert.match(splitLayoutVue, /'is-resizing':\s*draggingSplit\?\.id\s*===\s*layout\.id/);
  assert.match(splitLayoutVue, /MIN_HORIZONTAL_PANE_SIZE\s*=\s*280/);
  assert.match(splitLayoutVue, /MIN_VERTICAL_PANE_SIZE\s*=\s*160/);
  assert.match(splitLayoutVue, /tabindex="0"/);
  assert.match(splitLayoutVue, /resizeWithKeyboard/);
  assert.match(ruleBody(".wb-split-layout"), /background\s*:\s*transparent/);
  assert.match(ruleBody(".wb-split-divider"), /background\s*:\s*transparent/);
  const splitDividerRule = ruleBody(".wb-split-divider");
  const splitDividerMarkerRule = ruleBody(".wb-split-divider::before");
  assert.match(splitDividerRule, /flex\s*:\s*0 0 7px/);
  assert.match(splitDividerMarkerRule, /background\s*:\s*var\(--wb-split-line\)/);
  assert.match(splitDividerMarkerRule, /opacity\s*:\s*1/);
  const horizontalDividerMarkerRule = ruleBody(".wb-split-layout.is-horizontal > .wb-split-divider::before");
  assert.match(horizontalDividerMarkerRule, /inset\s*:\s*var\(--wb-titlebar-height\) auto 0 50%/);
  assert.match(horizontalDividerMarkerRule, /width\s*:\s*1px/);
  assert.match(ruleBody(".wb-split-layout.is-vertical > .wb-split-divider::before"), /height\s*:\s*1px/);
  assert.match(ruleBody(".wb-split-layout.is-horizontal > .wb-split-child"), /min-width\s*:\s*min\(280px, 45%\)/);
  assert.match(ruleBody(".wb-split-layout.is-vertical > .wb-split-child"), /min-height\s*:\s*min\(160px, 45%\)/);
  assert.match(ruleBody(".wb-split-divider:hover::before"), /background\s*:\s*color-mix/);
  assert.match(ruleBody(".wb-split-layout.is-resizing > .wb-split-divider::before"), /background\s*:\s*color-mix/);
});

test("keyboard focus states are explicit for polish-critical controls", () => {
  for (const selector of [
    ".wb-tab:focus-visible",
    ".wb-tab-close:focus-visible",
    ".wb-pane-toggle:focus-visible",
    ".wb-split-more-btn:focus-visible",
    ".wb-context-menu button:focus-visible",
  ]) {
    const body = ruleBody(selector);
    assert.match(body, /outline\s*:/, `${selector} should define an outline`);
    assert.match(body, /outline-offset\s*:/, `${selector} should define an outline offset`);
  }
});

test("confirmation dialogs stay above modal workflows", () => {
  assert.match(confirmDialogVue, /class="wb-dialog-overlay wb-confirm-dialog-overlay"/);
  assert.match(ruleBody(".wb-dialog-overlay"), /z-index\s*:\s*200/);
  assert.match(ruleBody(".wb-confirm-dialog-overlay"), /z-index\s*:\s*210/);
});

test("Quick Open type filter uses a visible in-app menu with reduced-motion support", () => {
  assert.match(quickOpenKindFilterVue, /<Teleport to="body">/);
  assert.match(quickOpenKindFilterVue, /class="wb-quick-open-kind-filter-menu wb-floating-themed"/);
  assert.match(ruleBody(".wb-quick-open-kind-filter-trigger"), /color:\s*var\(--wb-text\)/);
  assert.match(ruleBody(".wb-quick-open-kind-filter-menu"), /position:\s*fixed/);
  assert.match(ruleBody(".wb-quick-open-kind-filter-menu"), /z-index:\s*82/);
  assert.match(ruleBody(".wb-quick-open-kind-filter-option.is-selected"), /background:\s*var\(--wb-accent-soft\)/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.wb-quick-open-kind-filter-caret\s*\{[\s\S]*?transition:\s*none/,
  );
});

test("Quick Open presents schema search as a distinct primary field", () => {
  assert.match(quickOpenPaletteVue, /import \{ Search \} from "lucide-vue-next"/);
  assert.match(quickOpenPaletteVue, /class="wb-quick-open-search-field"[\s\S]*?<Search class="wb-quick-open-search-icon"/);

  const fieldRule = ruleBody(".wb-quick-open-search-field");
  assert.match(fieldRule, /flex:\s*1 1 260px/);
  assert.match(fieldRule, /border:\s*1px solid var\(--wb-border-strong\)/);
  assert.match(fieldRule, /background:\s*var\(--wb-field-surface\)/);

  const focusRule = ruleBody(".wb-quick-open-search-field:focus-within");
  assert.match(focusRule, /border-color:\s*var\(--wb-accent\)/);
  assert.match(focusRule, /outline:\s*2px solid var\(--wb-accent\)/);
});

test("Quick Open value search reads as a complete secondary action", () => {
  assert.match(quickOpenPaletteVue, /class="wb-quick-open-value-field"[\s\S]*?class="wb-quick-open-value-search-icon"/);
  assert.match(quickOpenPaletteVue, /class="wb-quick-open-value-submit"[\s\S]*?:aria-busy=/);
  assert.match(quickOpenPaletteVue, /v-if="valueSearchScopeEmpty" class="wb-quick-open-value-error"/);

  const fieldRule = ruleBody(".wb-quick-open-value-field");
  assert.match(fieldRule, /height:\s*34px/);
  assert.match(fieldRule, /border:\s*1px solid var\(--wb-border-strong\)/);
  assert.match(fieldRule, /background:\s*var\(--wb-field-surface\)/);

  const focusRule = ruleBody(".wb-quick-open-value-field:focus-within");
  assert.match(focusRule, /outline:\s*2px solid var\(--wb-accent\)/);

  const submitRule = ruleBody(".wb-quick-open-value-submit");
  assert.match(submitRule, /background:\s*var\(--wb-accent-control\)/);
  assert.match(submitRule, /color:\s*var\(--wb-accent-control-text\)/);
  assert.match(ruleBody(".wb-quick-open-value-submit.is-loading:disabled"), /cursor:\s*progress/);
});

test("checkboxes use click cursors without inheriting text-field focus boxes", () => {
  assert.match(ruleBody('input[type="checkbox"]'), /cursor\s*:\s*pointer/);
  assert.match(ruleBody('label:has(input[type="checkbox"])'), /cursor\s*:\s*pointer/);
  assert.match(ruleBody('input[type="checkbox"]:focus'), /outline\s*:\s*none/);
  assert.match(ruleBody('label:has(input[type="checkbox"]:focus-visible)'), /color\s*:\s*var\(--wb-accent-strong\)/);
  assert.match(ruleBody('input[type="checkbox"]:disabled'), /cursor\s*:\s*not-allowed/);
});

test("open table chrome shrinks tabs without adding a horizontal scrollbar", () => {
  const tabStripRule = ruleBody(".wb-object-tabs");
  const tabListRule = ruleBody(".wb-tab-list");
  const tabRule = ruleBody(".wb-tab");

  assert.match(tabStripRule, /overflow-x\s*:\s*hidden/);
  assert.match(tabListRule, /flex\s*:\s*1\s+1\s+auto/);
  assert.match(tabListRule, /min-width\s*:\s*0/);
  assert.match(tabListRule, /padding-inline\s*:\s*var\(--wb-tab-curve-size\)/);
  assert.match(tabRule, /display\s*:\s*inline-flex/);
  assert.match(tabRule, /flex\s*:\s*1\s+1\s+112px/);
  assert.match(tabRule, /min-width\s*:\s*32px/);
  assert.match(tabRule, /max-width\s*:\s*176px/);
  assert.match(tabRule, /position\s*:\s*relative/);
  assert.match(tabRule, /padding\s*:\s*0 28px 0 10px/);
  assert.doesNotMatch(ruleBody(".wb-tab-title"), /text-align\s*:\s*center/);
  assert.match(tabRule, /overflow\s*:\s*hidden/);
  assert.match(tabRule, /container-type\s*:\s*inline-size/);
  assert.match(css, /@container\s*\(max-width:\s*132px\)/);
  assert.match(css, /@container\s*\(max-width:\s*88px\)/);
  assert.match(ruleBody(".wb-tab-title"), /flex\s*:\s*1\s+1\s+auto/);
});

test("homepage tab aligns with the grid row-number column", () => {
  const rootRule = ruleBody(":root");
  const paneTabStripRule = ruleBody(".wb-pane-tabbar .wb-object-tabs");
  const paneTabListRule = ruleBody(".wb-pane-tabbar .wb-tab-list");
  const homeTabRule = ruleBody('.wb-tab[data-kind="home"]');
  const rowIndexRule = ruleBody(".wb-row-index");

  assert.match(rootRule, /--wb-row-index-width\s*:\s*38px/);
  assert.match(paneTabStripRule, /padding\s*:\s*4px 0 0\s*;/);
  assert.match(paneTabListRule, /padding-left\s*:\s*0/);
  assert.match(homeTabRule, /flex\s*:\s*0 0 64px/);
  assert.match(homeTabRule, /min-width\s*:\s*64px/);
  assert.match(rowIndexRule, /width\s*:\s*var\(--wb-row-index-width\)/);
});

test("database homepage batch actions use a clear quiet grouped treatment", () => {
  const groupRule = ruleBody(".wb-toolbar-action-group");
  const buttonRule = ruleBody(".wb-dbhome-action-button");
  const hoverRule = ruleBody(".wb-toolbar-action-group > .wb-toolbar-action-button:hover:not(:disabled)");
  const activeRule = ruleBody(".wb-toolbar-action-group > .wb-toolbar-action-button:active:not(:disabled)");

  assert.match(groupRule, /background\s*:\s*var\(--wb-control\)/);
  assert.match(groupRule, /border-radius\s*:\s*6px/);
  assert.doesNotMatch(groupRule, /background\s*:\s*var\(--wb-accent-control\)/);
  assert.match(buttonRule, /transition\s*:/);
  assert.match(buttonRule, /min-width 0\.22s cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  assert.match(hoverRule, /background\s*:\s*var\(--wb-accent-soft\)/);
  assert.match(activeRule, /background\s*:\s*color-mix\(/);
  assert.match(
    css,
    /\.wb-dbhome-action-button > \.wb-toolbar-action-label[\s\S]*?max-width 0\.22s cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.wb-dbhome-action-button[\s\S]*?transition:\s*none/,
  );
});

test("open table tabs connect the active document to its pane", () => {
  const rootRule = ruleBody(":root");
  const darkRule = ruleBody('.mysql-workbench[data-theme="dark"]');
  const mainOutlineRule = ruleBody(".wb-main::after");
  const objectTabsRule = ruleBody(".wb-object-tabs");
  const paneObjectTabsRule = ruleBody(".wb-pane-tabbar .wb-object-tabs");
  const topEdgeTabbarRule = ruleBody(".wb-pane-tabbar.is-top-edge-pane");
  const topEdgeObjectTabsRule = ruleBody(".wb-pane-tabbar.is-top-edge-pane .wb-object-tabs");
  const singlePaneObjectTabsRule = ruleBody(".wb-pane-tabbar.is-left-edge-pane.is-right-edge-pane .wb-object-tabs");
  const paneTabListRule = ruleBody(".wb-pane-tabbar .wb-tab-list");
  const tabRule = ruleBody(".wb-tab");
  const activeRule = ruleBody(".wb-tab.active");
  const homeRule = ruleBody('.wb-tab[data-kind="home"]');
  const activeBeforeRule = ruleBody(".wb-tab.active::before");
  const activeAfterRule = ruleBody(".wb-tab.active::after");
  const titleRule = ruleBody(".wb-tab-title");

  assert.match(rootRule, /--wb-tab-border\s*:/);
  assert.match(rootRule, /--wb-tab-active-border\s*:/);
  assert.match(rootRule, /--wb-tab-curve-size\s*:\s*14px/);
  assert.match(darkRule, /--wb-tab-border\s*:/);
  assert.match(darkRule, /--wb-tab-active-border\s*:/);
  assert.match(mainOutlineRule, /z-index\s*:\s*31/);
  assert.match(mainOutlineRule, /border-top\s*:\s*1px solid var\(--wb-workspace-mist-border\)/);
  assert.match(mainOutlineRule, /border-top-left-radius\s*:\s*var\(--wb-workspace-corner-radius\)/);
  assert.match(objectTabsRule, /align-items\s*:\s*center/);
  assert.match(paneObjectTabsRule, /align-items\s*:\s*center/);
  assert.match(topEdgeTabbarRule, /z-index\s*:\s*32/);
  assert.match(topEdgeTabbarRule, /border-bottom-color\s*:\s*transparent/);
  assert.match(topEdgeTabbarRule, /background\s*:\s*var\(--wb-chrome-surface\)/);
  assert.match(topEdgeTabbarRule, /background-clip\s*:\s*padding-box/);
  assert.doesNotMatch(topEdgeTabbarRule, /linear-gradient/);
  assert.match(topEdgeObjectTabsRule, /background\s*:\s*transparent/);
  assert.doesNotMatch(topEdgeObjectTabsRule, /linear-gradient/);
  assert.match(paneTabListRule, /align-items\s*:\s*flex-end/);
  assert.match(tabRule, /height\s*:\s*36px/);
  assert.match(tabRule, /min-height\s*:\s*36px/);
  assert.match(tabRule, /border\s*:\s*1px solid transparent/);
  assert.match(tabRule, /--wb-active-tab-surface\s*:\s*var\(--wb-workspace-mist-raised\)/);
  assert.match(homeRule, /--wb-active-tab-surface\s*:\s*var\(--wb-chrome-surface\)/);
  assert.match(tabRule, /border-radius\s*:\s*8px 8px 0 0/);
  assert.match(titleRule, /font-size\s*:\s*13px/);
  assert.match(activeRule, /border-color\s*:\s*var\(--wb-tab-active-border\)/);
  assert.match(activeRule, /border-bottom-color\s*:\s*var\(--wb-active-tab-surface\)/);
  assert.match(activeRule, /background\s*:\s*var\(--wb-active-tab-surface\)/);
  assert.match(activeRule, /inset 0 2px 0 var\(--wb-accent\)/);
  assert.match(activeRule, /overflow\s*:\s*visible/);
  assert.match(activeBeforeRule, /border-bottom-right-radius\s*:\s*var\(--wb-tab-curve-size\)/);
  assert.match(activeBeforeRule, /box-shadow\s*:\s*6px 6px 0 6px var\(--wb-active-tab-surface\)/);
  assert.match(activeAfterRule, /border-bottom-left-radius\s*:\s*var\(--wb-tab-curve-size\)/);
  assert.match(activeAfterRule, /box-shadow\s*:\s*-6px 6px 0 6px var\(--wb-active-tab-surface\)/);
});

test("open table tabs keep table names visible when the strip is crowded", () => {
  assert.doesNotMatch(css, /@container\s*\(max-width:\s*72px\)\s*\{[\s\S]*?\.wb-tab-title\s*\{[\s\S]*?display\s*:\s*none/);
});

test("open table close buttons have a comfortable pointer hit target", () => {
  const closeRule = css.match(/(?:^|\r?\n)\.wb-tab-close\s*\{([^}]*)\}/s)?.[1] || "";
  const compactMediaRule = css.match(/@media\s*\(max-width:\s*760px\)\s*\{([\s\S]*?)\.wb-tree-row/)?.[1] || "";

  assert.ok(closeRule, "Expected .wb-tab-close rule to exist");
  assert.match(closeRule, /position\s*:\s*absolute/);
  assert.match(closeRule, /top\s*:\s*50%/);
  assert.match(closeRule, /right\s*:\s*0/);
  assert.match(closeRule, /transform\s*:\s*translateY\(-50%\)/);
  assert.match(closeRule, /width\s*:\s*32px/);
  assert.match(closeRule, /height\s*:\s*32px/);
  assert.match(closeRule, /min-height\s*:\s*32px/);
  assert.match(closeRule, /padding\s*:\s*0/);
  assert.match(closeRule, /z-index\s*:\s*1/);
  assert.doesNotMatch(compactMediaRule, /\.wb-tab-close/);
});

test("open table close hover feedback keeps the glyph visible", () => {
  const closeRule = css.match(/(?:^|\r?\n)\.wb-tab-close\s*\{([^}]*)\}/s)?.[1] || "";
  const markRule = ruleBody(".wb-tab-close-mark");
  const markBeforeRule = ruleBody(".wb-tab-close-mark::before");
  const markAfterRule = ruleBody(".wb-tab-close-mark::after");
  const hoverMarkRule = ruleBody(".wb-tab-close:hover .wb-tab-close-mark");

  assert.match(tabsVue, /class="wb-tab-close-mark"/);
  assert.match(tabsVue, /aria-hidden="true"/);
  assert.doesNotMatch(tabsVue, /class="wb-tab-close-mark"[^>]*>\s*×\s*<\/span>/);
  assert.match(closeRule, /background\s*:\s*transparent/);
  assert.match(closeRule, /box-shadow\s*:\s*none/);
  assert.doesNotMatch(css, /\.wb-tab-close::before/);
  assert.match(markRule, /position\s*:\s*relative/);
  assert.match(markRule, /width\s*:\s*20px/);
  assert.match(markRule, /height\s*:\s*20px/);
  assert.match(markRule, /color\s*:\s*var\(--wb-tab-close-text\)/);
  assert.match(markBeforeRule, /top\s*:\s*50%/);
  assert.match(markBeforeRule, /left\s*:\s*50%/);
  assert.match(markBeforeRule, /width\s*:\s*10px/);
  assert.match(markBeforeRule, /height\s*:\s*1\.5px/);
  assert.match(markBeforeRule, /background\s*:\s*currentColor/);
  assert.match(markBeforeRule, /transform\s*:\s*translate\(-50%, -50%\) rotate\(45deg\)/);
  assert.match(markAfterRule, /transform\s*:\s*translate\(-50%, -50%\) rotate\(-45deg\)/);
  assert.match(hoverMarkRule, /background\s*:\s*var\(--wb-tab-close-hover\)/);
  assert.match(hoverMarkRule, /box-shadow\s*:\s*inset 0 0 0 1px var\(--wb-tab-close-border\)/);
  assert.match(hoverMarkRule, /color\s*:\s*var\(--wb-tab-close-text-hover\)/);
});

test("open table chrome avoids competing horizontal divider lines", () => {
  const tabStripRule = ruleBody(".wb-object-tabs");
  const tabListRule = ruleBody(".wb-tab-list");
  const tabRule = ruleBody(".wb-tab");
  const activeTabRule = ruleBody(".wb-tab.active");
  const paneHeaderRule = ruleBody(".wb-pane-header");
  const toolbarRule = ruleBody(".wb-table-toolbar");

  assert.match(tabStripRule, /overflow-x\s*:\s*hidden/);
  assert.match(tabStripRule, /background\s*:\s*var\(--wb-chrome-surface\)/);
  assert.match(tabListRule, /flex\s*:\s*1\s+1\s+auto/);
  assert.match(tabListRule, /min-width\s*:\s*0/);
  assert.match(tabRule, /display\s*:\s*inline-flex/);
  assert.match(tabRule, /flex\s*:\s*1\s+1\s+112px/);
  assert.match(tabRule, /min-width\s*:\s*32px/);
  assert.match(tabRule, /max-width\s*:\s*176px/);
  assert.match(tabRule, /border-radius\s*:\s*8px 8px 0 0/);
  assert.match(activeTabRule, /border-bottom-color\s*:\s*var\(--wb-active-tab-surface\)/);
  assert.match(activeTabRule, /inset 0 2px 0 var\(--wb-accent\)/);
  assert.doesNotMatch(tabStripRule, /border-bottom\s*:/);
  assert.doesNotMatch(paneHeaderRule, /border-bottom\s*:/);
  assert.doesNotMatch(toolbarRule, /border-bottom\s*:/);
});

test("current-cell chip anchors to the right pane, identical for notes and agent", () => {
  const textPanelRule = ruleBody(".wb-text-panel");
  const detailEditorRule = ruleBody(".wb-detail-editor");
  const inspectorRule = ruleBody(".wb-inspector");
  const cellPanelRule = ruleBody(".wb-inspector-cell-panel");
  const schemaReserveRule = ruleBody(
    ".wb-inspector.has-current-cell .wb-schema-list",
  );
  const aiCellPanelRule = ruleBody(".wb-ai-cell-panel");
  const cellIdentityRule = ruleBody(".wb-cell-identity.is-panel");

  assert.match(textPanelRule, /position\s*:\s*relative/);
  assert.match(textPanelRule, /padding\s*:\s*8px/);
  assert.match(detailEditorRule, /flex\s*:\s*1/);
  assert.match(detailEditorRule, /min-height\s*:\s*0/);
  // The chip is absolutely positioned inside the inspector pane, so the pane
  // must establish a positioning context.
  assert.match(inspectorRule, /position\s*:\s*relative/);
  assert.match(cellPanelRule, /position\s*:\s*absolute/);
  assert.match(cellPanelRule, /left\s*:\s*16px/);
  assert.match(cellPanelRule, /bottom\s*:\s*12px/);
  assert.match(cellPanelRule, /right\s*:\s*20px/);
  assert.doesNotMatch(cellPanelRule, /background\s*:\s*var\(--wb-status-surface\)/);
  assert.doesNotMatch(cellPanelRule, /border-radius\s*:\s*10px/);
  assert.match(cellIdentityRule, /border-radius\s*:\s*12px/);
  // Frosted-glass surface: glass token + accent-tinted top highlight.
  assert.match(cellIdentityRule, /var\(--wb-glass-strong\)/);
  assert.match(cellIdentityRule, /linear-gradient\(180deg,\s*color-mix\(in srgb, var\(--wb-text\) 6%, transparent\)/);
  assert.match(cellIdentityRule, /backdrop-filter\s*:\s*blur\(20px\) saturate\(1\.4\)/);
  // Layered shadow: inset highlight + near contact + floating cast.
  assert.match(cellIdentityRule, /var\(--wb-control-inset\)/);
  assert.match(cellIdentityRule, /var\(--wb-floating-shadow\)/);
  assert.match(cellIdentityRule, /min-height\s*:\s*34px/);
  // Primary-key value rendered as an accent-tinted pill for visual hierarchy.
  const keyRule = ruleBody(".wb-cell-identity-key");
  assert.match(keyRule, /background\s*:\s*var\(--wb-accent-soft\)/);
  assert.match(keyRule, /border-radius\s*:\s*8px/);
  assert.match(keyRule, /padding\s*:\s*1px 8px/);
  // Dividers fade at the ends so the chip reads as a single composed row.
  const dividerRule = ruleBody(".wb-cell-identity-divider");
  assert.match(dividerRule, /linear-gradient\(\s*180deg,\s*transparent/);
  // The notes list reserves room so the floating chip never hides a field.
  assert.match(schemaReserveRule, /padding-bottom\s*:\s*54px/);
  // The full-width positioning wrapper must stay visually inert; backdrop blur
  // on this transparent box creates the gray rectangle visible beside the chip.
  const backdropSupportRule = css.match(
    /@supports\s+\(\(backdrop-filter:\s*blur\(16px\)\)\s+or\s+\(-webkit-backdrop-filter:\s*blur\(16px\)\)\)\s*\{([\s\S]*?)\n\}/,
  )?.[1] || "";
  assert.doesNotMatch(backdropSupportRule, /\.wb-inspector-cell-panel\b/);

  // In the agent panel the chip participates in the bottom composer layout, so
  // it cannot cover the tail of a long answer while the user is chatting.
  assert.match(aiCellPanelRule, /flex\s*:\s*0 0 auto/);
  assert.match(aiCellPanelRule, /margin\s*:\s*0 20px 8px 16px/);
  assert.doesNotMatch(aiCellPanelRule, /position\s*:\s*absolute/);
});

test("teleported floating workbench surfaces do not inherit the full shell layout", () => {
  assert.match(quickOpenPaletteVue, /class="wb-quick-open-overlay wb-floating-themed"/);
  assert.match(quickOpenPaletteVue, /class="wb-quick-open-db-dropdown wb-floating-themed"/);
  assert.match(toolbarSplitButtonVue, /class="wb-toolbar-action-menu wb-floating-themed"/);
  assert.doesNotMatch(quickOpenPaletteVue, /wb-quick-open-overlay mysql-workbench/);
  assert.doesNotMatch(quickOpenPaletteVue, /wb-quick-open-db-dropdown mysql-workbench/);
  assert.doesNotMatch(toolbarSplitButtonVue, /wb-toolbar-action-menu mysql-workbench/);

  const floatingDarkRule = ruleBody('.wb-floating-themed[data-theme="dark"]');
  assert.match(floatingDarkRule, /--wb-surface:/);
  assert.match(floatingDarkRule, /--wb-quick-open-overlay:/);

  const overlayRule = ruleBody(".wb-quick-open-overlay");
  assert.match(overlayRule, /position\s*:\s*fixed/);
  assert.match(overlayRule, /display\s*:\s*flex/);
  assert.doesNotMatch(overlayRule, /display\s*:\s*grid/);
  assert.doesNotMatch(overlayRule, /height\s*:\s*100vh/);
  assert.doesNotMatch(overlayRule, /min-height\s*:\s*720px/);

  const dropdownRule = ruleBody(".wb-quick-open-db-dropdown");
  assert.match(dropdownRule, /position\s*:\s*fixed/);
  assert.doesNotMatch(dropdownRule, /height\s*:\s*100vh/);
  assert.doesNotMatch(dropdownRule, /min-height\s*:\s*720px/);
});

test("dialog close button centers its glyph within the hit target", () => {
  const closeRule = ruleBody(".wb-dialog-close");

  assert.match(closeRule, /display\s*:\s*(inline-)?grid/);
  assert.match(closeRule, /place-items\s*:\s*center/);
  assert.match(closeRule, /width\s*:\s*28px/);
  assert.match(closeRule, /height\s*:\s*28px/);
  assert.match(closeRule, /min-height\s*:\s*28px/);
  assert.match(closeRule, /line-height\s*:\s*1/);
  assert.match(closeRule, /padding\s*:\s*0/);
});

test("dialog action labels stay horizontal and readable", () => {
  const actionButtonRule = ruleBody(".wb-dialog-actions button");

  assert.match(actionButtonRule, /white-space\s*:\s*nowrap/);
});

test("import wizard preview field headers are left aligned", () => {
  const importPreviewHeaderRule = ruleBody(".wb-import-preview th");

  assert.match(importPreviewHeaderRule, /text-align\s*:\s*left/);
});

test("import wizard preview table remains horizontally scrollable", () => {
  const importPreviewWrapRule = ruleBody(".wb-import-preview-wrap");
  const importPreviewTableRule = ruleBody(".wb-import-preview");
  const importPreviewCellRule = ruleBody(".wb-import-preview td");

  assert.match(importPreviewWrapRule, /overflow\s*:\s*auto/);
  assert.match(importPreviewTableRule, /min-width\s*:\s*max-content/);
  assert.doesNotMatch(importPreviewCellRule, /max-width\s*:\s*160px/);
  assert.match(importPreviewCellRule, /white-space\s*:\s*nowrap/);
});

test("table copy dialog rows are flat and the viewport fills dialog space", () => {
  const contentRule = ruleBody(".wb-table-copy-content");
  const viewportRule = css.match(/(?:^|\r?\n)\.wb-table-copy-viewport\s*\{([^}]*)\}/s)?.[1] || "";
  const rowRule = css.match(/(?:^|\r?\n)\.wb-table-copy-row\s*\{([^}]*)\}/s)?.[1] || "";
  const selectionListRule = ruleBody(".wb-table-copy-selection-list");
  const selectionRowRule = ruleBody(".wb-table-copy-selection-row");

  assert.ok(viewportRule, "Expected .wb-table-copy-viewport rule to exist");
  assert.ok(rowRule, "Expected .wb-table-copy-row rule to exist");
  assert.match(contentRule, /grid-template-columns\s*:\s*minmax\(0, 1fr\) 264px/);
  assert.match(viewportRule, /flex\s*:\s*1 1 auto/);
  assert.doesNotMatch(viewportRule, /max-height\s*:\s*380px/);
  assert.match(rowRule, /padding\s*:\s*0 18px/);
  assert.doesNotMatch(rowRule, /padding\s*:\s*0 18px 0 36px/);
  assert.match(selectionListRule, /flex\s*:\s*1 1 auto/);
  assert.match(selectionListRule, /overflow-y\s*:\s*auto/);
  assert.match(selectionRowRule, /height\s*:\s*30px/);
  assert.match(tableCopySelectionPanelVue, /visibleRows/);
  assert.match(tableCopySelectionPanelVue, /@scroll\.passive="onScroll"/);
  assert.doesNotMatch(css, /\.wb-table-copy-group-header|\.wb-table-copy-chevron|\.wb-table-copy-group-checkbox/);
});

test("database homepage uses a compact resizable table surface with selection canvas", () => {
  const homeRule = ruleBody(".wb-database-home");
  const toolbarRule = ruleBody(".wb-dbhome-toolbar");
  const actionRule = ruleBody(".wb-dbhome-action-button");
  const tableSurfaceRule = ruleBody(".wb-dbhome-table-surface");
  const tableHeaderRule = ruleBody(".wb-dbhome-table-header");
  const headerCellRule = ruleBody(".wb-dbhome-header-cell");
  const listRule = ruleBody(".wb-dbhome-object-list");
  const virtualRule = ruleBody(".wb-dbhome-virtual");
  const rowRule = ruleBody(".wb-dbhome-object-row");
  const nameRule = ruleBody(".wb-dbhome-object-name");
  const nameButtonRule = ruleBody(".wb-dbhome-object-name-button");
  const selectedNameButtonRule = ruleBody(".wb-dbhome-object-row.is-selected .wb-dbhome-object-name-button");
  const selectionRule = ruleBody(".wb-dbhome-selection-box");

  assert.match(homeRule, /display\s*:\s*grid/);
  assert.match(homeRule, /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/);
  assert.match(homeRule, /grid-template-rows\s*:\s*auto auto minmax\(0,\s*1fr\)/);
  assert.match(homeRule, /min-width\s*:\s*0/);
  assert.match(toolbarRule, /min-height\s*:\s*40px/);
  assert.match(actionRule, /padding\s*:\s*0 10px/);
  assert.match(tableSurfaceRule, /overflow-x\s*:\s*auto/);
  assert.match(tableSurfaceRule, /overflow-y\s*:\s*scroll/);
  assert.match(tableSurfaceRule, /scrollbar-gutter\s*:\s*stable/);
  assert.match(tableSurfaceRule, /padding\s*:\s*0/);
  assert.match(tableSurfaceRule, /cursor\s*:\s*default/);
  assert.match(tableHeaderRule, /position\s*:\s*sticky/);
  assert.match(tableHeaderRule, /width\s*:\s*max-content/);
  assert.doesNotMatch(tableHeaderRule, /border\s*:\s*1px/);
  assert.match(tableHeaderRule, /background\s*:\s*color-mix\(in srgb,\s*var\(--wb-grid-canvas\)\s*92%,\s*var\(--wb-surface\)\)/);
  assert.doesNotMatch(tableHeaderRule, /background\s*:\s*var\(--wb-grid-header\)/);
  assert.match(headerCellRule, /resize\s*:\s*none/);
  assert.doesNotMatch(headerCellRule, /border-right\s*:\s*1px/);
  assert.match(headerCellRule, /padding\s*:\s*0 22px 0 10px/);
  assert.match(listRule, /overflow\s*:\s*visible/);
  assert.doesNotMatch(listRule, /border\s*:\s*1px/);
  assert.match(listRule, /background\s*:\s*transparent/);
  assert.match(virtualRule, /width\s*:\s*max-content/);
  assert.match(rowRule, /height\s*:\s*30px/);
  assert.match(rowRule, /border-radius\s*:\s*0/);
  assert.match(rowRule, /background\s*:\s*transparent/);
  assert.doesNotMatch(ruleBody(".wb-dbhome-object-row.is-selected"), /background\s*:\s*var\(--wb-row-selected\)/);
  assert.match(nameRule, /overflow\s*:\s*hidden/);
  assert.match(nameButtonRule, /width\s*:\s*100%/);
  assert.match(selectedNameButtonRule, /box-shadow\s*:/);
  assert.match(ruleBody(".wb-dbhome-object-row.is-box-selected .wb-dbhome-object-name-button"), /box-shadow\s*:/);
  assert.match(selectionRule, /position\s*:\s*fixed/);
  assert.match(selectionRule, /border\s*:\s*1px solid var\(--wb-accent\)/);
  assert.doesNotMatch(css, /\.wb-dbhome-status/);
  assert.doesNotMatch(css, /\.wb-database-home[\s\S]*?\.wb-card/);
});

test("sidebar table search remains visible while scrolling table lists", () => {
  const sourceTreeRule = ruleBody(".wb-source-tree");
  const connectionListRule = ruleBody(".wb-source-connection-list");
  const tableScrollRule = ruleBody(".wb-table-scroll");
  const connectionRule = ruleBody(".wb-connection-node");
  const databaseRule = ruleBody(".wb-database-item");
  const expandedConnectionRule = ruleBody(".wb-source-connection.is-expanded");
  const expandedDatabaseRule = ruleBody(".wb-source-database.is-expanded");
  const tableBranchRule = ruleBody(".wb-table-branch");
  const tableSearchWrapRule = ruleBody(".wb-table-search-wrap");
  const tableSearchRule = ruleBody(".wb-table-search");
  const searchPanelRule = ruleBody(".wb-sidebar-search-panel");

  assert.match(sourceTreeRule, /overflow-y\s*:\s*auto/);
  assert.match(sourceTreeRule, /overscroll-behavior\s*:\s*contain/);
  assert.match(connectionListRule, /min-height\s*:\s*min-content/);
  assert.match(tableScrollRule, /overflow-y\s*:\s*auto/);
  assert.match(tableScrollRule, /overscroll-behavior\s*:\s*contain/);
  assert.doesNotMatch(connectionRule, /position\s*:\s*sticky/);
  assert.doesNotMatch(databaseRule, /position\s*:\s*sticky/);
  assert.match(expandedConnectionRule, /flex\s*:\s*0 0 auto/);
  assert.doesNotMatch(expandedConnectionRule, /flex\s*:\s*1 1 auto/);
  assert.match(expandedConnectionRule, /min-height\s*:\s*min-content/);
  assert.doesNotMatch(expandedDatabaseRule, /min-height\s*:\s*calc\(/);
  assert.match(tableBranchRule, /flex\s*:\s*1 1 auto/);
  assert.match(tableBranchRule, /min-height\s*:\s*var\(--wb-tree-table-min-h/);
  assert.match(tableBranchRule, /overflow\s*:\s*hidden/);
  assert.match(tableBranchRule, /contain\s*:\s*size/);
  assert.doesNotMatch(searchPanelRule, /position\s*:\s*sticky/);
  assert.match(tableSearchWrapRule, /position\s*:\s*sticky/);
  assert.match(tableSearchWrapRule, /top\s*:\s*0/);
  assert.match(tableSearchWrapRule, /z-index\s*:/);
  assert.match(tableSearchWrapRule, /background\s*:\s*var\(--wb-chrome-surface\)/);
  const searchHistoryRule = ruleBody(".wb-sidebar-search-history");
  assert.match(searchHistoryRule, /position\s*:\s*absolute/);
  const tableSearchInputRule = ruleBody(".wb-table-search input");
  const tableSearchHasQueryRule = ruleBody(".wb-table-search.has-query input");
  const tableSearchClearRule = ruleBody(".wb-table-search-clear");
  const tableSearchIconRule = ruleBody(".wb-table-search-icon");
  const tableSearchFocusRule = ruleBody(".wb-table-search:focus-within input");
  const tableSearchFilledRule = ruleBody(".wb-table-search.has-query input");
  assert.match(tableSearchInputRule, /font-size\s*:\s*12px/);
  assert.match(tableSearchInputRule, /line-height\s*:\s*1\.45/);
  assert.match(tableSearchInputRule, /height\s*:\s*28px/);
  assert.match(tableSearchInputRule, /padding\s*:\s*0 9px 0 30px/);
  assert.match(tableSearchInputRule, /border-color\s*:\s*color-mix\(in srgb,\s*var\(--wb-accent\)\s*24%,\s*var\(--wb-border-strong\)\)/);
  assert.match(tableSearchInputRule, /background\s*:\s*color-mix\(in srgb,\s*var\(--wb-field-surface\)\s*54%,\s*var\(--wb-control-hover\)\)/);
  assert.match(tableSearchRule, /display\s*:\s*grid/);
  assert.match(tableSearchHasQueryRule, /padding-right\s*:\s*28px/);
  assert.match(tableSearchIconRule, /grid-area\s*:\s*1\s*\/\s*1/);
  assert.match(tableSearchIconRule, /pointer-events\s*:\s*none/);
  assert.match(tableSearchFocusRule, /border-color\s*:\s*var\(--wb-accent\)/);
  assert.match(tableSearchFilledRule, /background\s*:\s*var\(--wb-control-hover\)/);
  assert.match(tableSearchClearRule, /width\s*:\s*16px/);
  assert.match(tableSearchClearRule, /height\s*:\s*16px/);
  assert.match(tableSearchClearRule, /min-height\s*:\s*16px/);
  assert.match(tableSearchClearRule, /grid-area\s*:\s*1\s*\/\s*1/);
  assert.match(tableSearchClearRule, /opacity\s*:\s*0/);
  assert.match(sidebarSearchPanelVue, /class="wb-table-search-icon"/);
  assert.match(css, /\.wb-table-search\.has-query:hover \.wb-table-search-clear/);
});

test("table toolbar stays readable in split panes without wrapping controls", () => {
  const toolbarRule = ruleBody(".wb-table-toolbar");
  const inputRule = ruleBody(".wb-table-toolbar input");
  const actionsRule = ruleBody(".wb-table-toolbar-actions");
  const splitButtonRule = ruleBody(".wb-toolbar-split-button");
  const splitButtonMainRule = ruleBody(".wb-toolbar-split-button-main");
  const splitButtonCaretRule = ruleBody(".wb-toolbar-split-button-caret");
  const navInlineRule = ruleBody(".wb-search-nav-inline");
  const navIconRule = ruleBody(".wb-search-nav-icon");

  assert.match(toolbarRule, /overflow-x\s*:\s*auto/);
  assert.match(toolbarRule, /flex-wrap\s*:\s*nowrap/);
  assert.match(toolbarRule, /scrollbar-width\s*:\s*thin/);
  assert.match(toolbarRule, /container-type\s*:\s*inline-size/);
  assert.match(inputRule, /flex\s*:\s*1 0 168px/);
  assert.match(inputRule, /min-width\s*:\s*168px/);
  assert.match(actionsRule, /display\s*:\s*inline-flex/);
  assert.match(actionsRule, /flex\s*:\s*0 0 auto/);
  assert.match(actionsRule, /position\s*:\s*sticky/);
  assert.match(actionsRule, /right\s*:\s*0/);
  assert.match(splitButtonRule, /height\s*:\s*28px/);
  assert.match(splitButtonRule, /flex\s*:\s*0 0 auto/);
  assert.match(splitButtonMainRule, /min-width\s*:\s*42px/);
  assert.match(splitButtonCaretRule, /width\s*:\s*24px/);
  assert.match(splitButtonCaretRule, /min-width\s*:\s*24px/);
  assert.match(navInlineRule, /display\s*:\s*inline-flex/);
  assert.match(navIconRule, /display\s*:\s*inline-flex/);
  assert.match(navIconRule, /width\s*:\s*24px/);
  assert.match(toolbarSplitButtonVue, /class="wb-toolbar-action-label"/);
  assert.match(css, /@container \(max-width: 680px\)[\s\S]*?\.wb-table-toolbar-actions \.wb-toolbar-action-label\s*\{[^}]*display:\s*none/s);
  assert.match(css, /@container \(max-width: 520px\)[\s\S]*?\.wb-table-search-field\s*\{[^}]*min-width:\s*136px/s);
  assert.match(navIconRule, /height\s*:\s*24px/);
});

test("agent markdown tables render as scrollable data tables in narrow panels", () => {
  const messageRule = ruleBody(".wb-ai-message-content.wb-md");
  const userMessageRule = ruleBody(".wb-ai-message.is-user .wb-ai-message-content.wb-md");
  const tableWrapRule = ruleBody(".wb-md-table-wrap");
  const tableRule = ruleBody(".wb-md-table");
  const tableCellRule = ruleBody(".wb-md-table th");
  const tableBodyCellRule = ruleBody(".wb-md-table td");
  const rightAlignRule = ruleBody(".wb-md-cell-align-right");
  const centerAlignRule = ruleBody(".wb-md-cell-align-center");
  const aiTableWrapRule = ruleBody(".wb-ai-panel .wb-md-table-wrap");

  assert.match(messageRule, /max-width\s*:\s*100%/);
  assert.match(messageRule, /white-space\s*:\s*normal/);
  assert.match(messageRule, /overflow-wrap\s*:\s*normal/);
  assert.match(userMessageRule, /overflow-wrap\s*:\s*anywhere/);
  assert.match(tableWrapRule, /overflow-x\s*:\s*auto/);
  assert.match(tableWrapRule, /max-width\s*:\s*100%/);
  assert.match(tableRule, /min-width\s*:\s*max-content/);
  assert.match(tableRule, /border-collapse\s*:\s*separate/);
  assert.match(tableRule, /table-layout\s*:\s*auto/);
  assert.match(tableCellRule, /white-space\s*:\s*nowrap/);
  assert.match(tableCellRule, /text-align\s*:\s*left/);
  assert.match(tableBodyCellRule, /max-width\s*:\s*26ch/);
  assert.match(tableBodyCellRule, /overflow-wrap\s*:\s*normal/);
  assert.match(rightAlignRule, /text-align\s*:\s*right/);
  assert.match(centerAlignRule, /text-align\s*:\s*center/);
  assert.match(aiTableWrapRule, /border-color\s*:\s*var\(--wb-ai-border\)/);
});

test("agent conversation reserves visible space above the composer", () => {
  const panelRule = ruleBody(".wb-ai-panel");
  const conversationRule = ruleBody(".wb-ai-conversation");
  const composerRule = ruleBody(".wb-ai-composer");
  const cellPanelRule = ruleBody(".wb-ai-cell-panel");
  const approvalStackRule = ruleBody(".wb-ai-approval-stack");
  const planStackRule = ruleBody(".wb-ai-plan-stack");
  const scrollBottomRule = ruleBody(".wb-ai-scroll-bottom");

  assert.match(panelRule, /--wb-ai-conversation-bottom-pad\s*:/);
  assert.match(panelRule, /min-height\s*:\s*0/);
  assert.match(conversationRule, /min-height\s*:\s*0/);
  assert.match(conversationRule, /overflow-y\s*:\s*auto/);
  assert.match(conversationRule, /padding\s*:\s*14px 12px var\(--wb-ai-conversation-bottom-pad\)/);
  assert.match(composerRule, /flex\s*:\s*0 0 auto/);
  assert.match(composerRule, /margin\s*:\s*0 10px 10px/);
  assert.doesNotMatch(composerRule, /position\s*:\s*absolute/);
  assert.doesNotMatch(cellPanelRule, /position\s*:\s*absolute/);
  assert.match(cellPanelRule, /flex\s*:\s*0 0 auto/);
  assert.match(approvalStackRule, /flex\s*:\s*0 0 auto/);
  assert.match(approvalStackRule, /max-height\s*:\s*min\(42%,\s*260px\)/);
  assert.match(approvalStackRule, /overflow-y\s*:\s*auto/);
  assert.doesNotMatch(approvalStackRule, /position\s*:\s*absolute/);
  assert.match(planStackRule, /flex\s*:\s*0 0 auto/);
  assert.match(planStackRule, /max-height\s*:\s*min\(42%,\s*260px\)/);
  assert.match(planStackRule, /overflow-y\s*:\s*auto/);
  assert.doesNotMatch(planStackRule, /position\s*:\s*absolute/);
  assert.match(scrollBottomRule, /bottom\s*:\s*8px/);
});

test("data grid filter mode is embedded in the search field as a single dropdown", () => {
  assert.match(dataGridVue, /function\s+setFilterMode\(mode\)/);
  assert.match(dataGridVue, /import ToolbarSplitButton/);
  assert.match(dataGridVue, /filterModeItems/);
  assert.match(dataGridVue, /id:\s*"filter-fuzzy"/);
  assert.match(dataGridVue, /id:\s*"filter-continuous"/);
  assert.match(dataGridVue, /id:\s*"filter-exact"/);
  assert.ok(
    dataGridVue.indexOf('id: "filter-continuous"') < dataGridVue.indexOf('id: "filter-exact"'),
    "连续模式应排在精确模式前",
  );
  assert.match(dataGridVue, /class="wb-search-mode-control"/);
  assert.match(dataGridVue, /primary-opens-menu/);
  assert.match(dataGridVue, /single-trigger/);
  assert.match(dataGridVue, /openToolbarMenu === 'filter'/);
  assert.match(dataGridVue, /placeholder="搜索当前表"/);
  assert.match(toolbarSplitButtonVue, /singleTrigger/);
  assert.match(toolbarSplitButtonVue, /class="wb-toolbar-menu-button"/);
  assert.match(toolbarSplitButtonVue, /class="wb-toolbar-action-menu wb-floating-themed"/);
  assert.match(css, /\.wb-table-toolbar \.wb-search-mode-control \.wb-toolbar-menu-button\s*\{[^}]*font-size:\s*13px/s);
  // 旧的双按钮分段控件已移除
  assert.doesNotMatch(dataGridVue, /class="wb-filter-mode-segment"/);
  assert.doesNotMatch(dataGridVue, /class="wb-filter-mode-option"/);
});

test("data grid hierarchy keeps header, hover, selection, editing, and insert states distinct", () => {
  const rootRule = ruleBody(":root");
  const darkRule = ruleBody('.mysql-workbench[data-theme="dark"]');
  const thRule = ruleBody(".wb-grid th");
  const hoverRule = ruleBody(".wb-grid-row:hover td:not(.wb-row-index)");
  const selectedRowRule = ruleBody(".wb-grid-row.row-selected td:not(.wb-row-index)");
  const insertRowRule = ruleBody(".wb-insert-row td");
  const unsavedInsertRule = ruleBody(".wb-insert-row.is-unsaved td");
  const insertMarkerRule = ruleBody(".wb-row-insert-marker");
  const editingRule = ruleBody(".wb-grid td.selected.editing");

  assert.match(rootRule, /--wb-row-hover:\s*color-mix\(in srgb, var\(--wb-accent\) 12%, var\(--wb-grid-row\)\)/);
  assert.match(rootRule, /--wb-row-selected:\s*color-mix\(in srgb, var\(--wb-accent\) 20%, var\(--wb-grid-row\)\)/);
  assert.match(darkRule, /--wb-row-hover:\s*color-mix\(in srgb, var\(--wb-accent\) 16%, var\(--wb-grid-row\)\)/);
  assert.match(darkRule, /--wb-row-selected:\s*color-mix\(in srgb, var\(--wb-accent\) 28%, var\(--wb-grid-row\)\)/);
  assert.match(thRule, /background\s*:\s*var\(--wb-grid-header\)/);
  assert.match(thRule, /border-bottom-color\s*:\s*var\(--wb-border-strong\)/);
  assert.match(thRule, /font-weight\s*:\s*650/);
  assert.match(hoverRule, /background\s*:\s*var\(--wb-row-hover\)/);
  assert.match(selectedRowRule, /background\s*:\s*var\(--wb-row-selected\)/);
  assert.match(insertRowRule, /background\s*:\s*var\(--wb-insert-row\) !important/);
  assert.match(rootRule, /--wb-insert-row:\s*color-mix\(in srgb, var\(--wb-warning-surface\) 62%, var\(--wb-grid-row\)\)/);
  assert.match(darkRule, /--wb-insert-row:\s*color-mix\(in srgb, var\(--wb-warning-surface\) 52%, var\(--wb-grid-row\)\)/);
  assert.match(unsavedInsertRule, /border-bottom-color\s*:\s*color-mix\(in srgb, var\(--wb-warning-border\) 38%, var\(--wb-line\)\)/);
  assert.match(insertMarkerRule, /box-shadow\s*:\s*inset 3px 0 0 var\(--wb-insert-unsaved-accent\)/);
  assert.match(editingRule, /box-shadow\s*:\s*inset 0 0 0 2px var\(--wb-accent\)/);
  assert.doesNotMatch(editingRule, /outline\s*:\s*2px solid var\(--wb-accent-strong\)/);
});

test("custom row and column highlight color overrides both theme defaults", () => {
  const rootRule = ruleBody(":root");
  const darkRule = ruleBody('.mysql-workbench[data-theme="dark"]');

  assert.match(rootRule, /--wb-cell-highlight:\s*var\(--wb-cell-highlight-custom,\s*#3b82f6\)/);
  assert.match(darkRule, /--wb-cell-highlight:\s*var\(--wb-cell-highlight-custom,\s*#60a5fa\)/);
});

test("titlebar icon controls expose visible tokenized tooltips", () => {
  assert.match(orchestratorVue, /class="wb-ai-entry-button"[\s\S]*:title=/);
  assert.match(orchestratorVue, /class="wb-pin-entry-button"[\s\S]*:title=/);
  assert.match(orchestratorVue, /class="wb-update-button"[\s\S]*:title=/);
  assert.match(orchestratorVue, /class="wb-titlebar-button"[\s\S]*title="最小化"/);
  assert.match(orchestratorVue, /class="wb-titlebar-button"[\s\S]*title="最大化或还原"/);
  assert.match(orchestratorVue, /class="wb-titlebar-button is-close"[\s\S]*title="关闭"/);
  assert.match(css, /\.wb-ai-entry-button::after,\s*\n\.wb-pin-entry-button::after,\s*\n\.wb-update-button::after,\s*\n\.wb-titlebar-button::after/);
  assert.match(ruleBody(".wb-ai-entry-button::after"), /content\s*:\s*attr\(aria-label\)/);
  assert.match(ruleBody(".wb-pin-entry-button::after"), /content\s*:\s*attr\(aria-label\)/);
  assert.match(ruleBody(".wb-ai-entry-button::after"), /background\s*:\s*var\(--wb-glass-strong\)/);
  assert.match(ruleBody(".wb-ai-entry-button:hover::after"), /opacity\s*:\s*1/);
  assert.match(ruleBody(".wb-ai-entry-button:focus-visible::after"), /opacity\s*:\s*1/);
});

test("titlebar minimize and maximize buttons use quiet light and dark interaction tokens", () => {
  const rootRule = ruleBody(":root");
  const darkRule = ruleBody('.mysql-workbench[data-theme="dark"]');
  const buttonRule = ruleBody(".wb-titlebar-button");
  const hoverRule = ruleBody(".wb-titlebar-button:not(.is-close):hover");
  const focusRule = ruleBody(".wb-titlebar-button:not(.is-close):focus-visible");
  const activeRule = ruleBody(".wb-titlebar-button:not(.is-close).is-pinned");

  for (const rule of [rootRule, darkRule]) {
    assert.match(rule, /--wb-window-control-text\s*:/);
    assert.match(rule, /--wb-window-control-text-hover\s*:/);
    assert.match(rule, /--wb-window-control-hover\s*:/);
    assert.match(rule, /--wb-window-control-active\s*:/);
    assert.match(rule, /--wb-window-control-active-hover\s*:/);
  }

  assert.match(buttonRule, /color\s*:\s*var\(--wb-window-control-text\)/);
  for (const rule of [hoverRule, focusRule]) {
    assert.match(rule, /background\s*:\s*var\(--wb-window-control-hover\)/);
    assert.doesNotMatch(rule, /box-shadow\s*:/);
    assert.match(rule, /color\s*:\s*var\(--wb-window-control-text-hover\)/);
  }
  assert.match(activeRule, /background\s*:\s*var\(--wb-window-control-active\)/);
  assert.doesNotMatch(activeRule, /box-shadow\s*:/);
});

test("pane table tabs stay above each pane toolbar", () => {
  const rootRule = ruleBody(".mysql-workbench");
  const collapsedInspectorWorkbenchRule = ruleBody(".mysql-workbench.is-inspector-collapsed");
  const titlebarRule = ruleBody(".wb-titlebar");
  const quickOpenEntryRule = ruleBody(".wb-quick-open-entry");
  const workspaceRule = ruleBody(".wb-workspace");
  const mainRule = ruleBody(".wb-main");
  const sidebarRule = ruleBody(".wb-sidebar");
  const inspectorRule = ruleBody(".wb-inspector");
  const titlebarSidebarRule = ruleBody(".wb-titlebar-sidebar");
  const titlebarInspectorRule = ruleBody(".wb-titlebar-inspector-controls");
  const updateRule = ruleBody(".wb-update-button");
  const pinRule = ruleBody(".wb-pin-entry-button");
  const windowControlsRule = ruleBody(".wb-titlebar-controls");
  const paneRule = ruleBody(".wb-workbench-pane");
  const paneTabbarRule = ruleBody(".wb-pane-tabbar");
  const paneChildTabbarRule = ruleBody(".wb-workbench-pane > .wb-pane-tabbar");
  const paneObjectTabsRule = ruleBody(".wb-pane-tabbar .wb-object-tabs");
  const singlePaneObjectTabsRule = ruleBody(".wb-pane-tabbar.is-left-edge-pane.is-right-edge-pane .wb-object-tabs");
  const tableToolbarRule = ruleBody(".wb-table-toolbar");

  assert.match(rootRule, /grid-template-rows\s*:\s*minmax\(0,\s*1fr\)/);
  assert.match(rootRule, /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/);
  assert.match(rootRule, /--wb-quick-open-entry-clearance:\s*150px/);
  assert.match(rootRule, /--wb-titlebar-tab-right-clearance:\s*var\(--wb-quick-open-entry-clearance\)/);
  assert.match(rootRule, /--wb-titlebar-collapsed-controls-clearance:\s*284px/);
  assert.match(collapsedInspectorWorkbenchRule, /--wb-titlebar-tab-right-clearance:\s*calc\(var\(--wb-titlebar-collapsed-controls-clearance\) \+ var\(--wb-quick-open-entry-clearance\)\)/);
  assert.match(titlebarRule, /grid-column\s*:\s*1/);
  assert.match(titlebarRule, /grid-row\s*:\s*1/);
  assert.doesNotMatch(titlebarRule, /z-index/);
  assert.match(quickOpenEntryRule, /z-index\s*:\s*40/);
  for (const rule of [titlebarSidebarRule, titlebarInspectorRule, updateRule, pinRule, windowControlsRule]) {
    assert.match(rule, /z-index\s*:\s*40/);
  }
  assert.match(workspaceRule, /grid-column\s*:\s*1/);
  assert.match(workspaceRule, /grid-row\s*:\s*1/);
  assert.match(workspaceRule, /padding-top\s*:\s*var\(--wb-titlebar-height\)/);
  assert.match(workspaceRule, /pointer-events\s*:\s*none/);
  assert.match(mainRule, /margin-top\s*:\s*calc\(-1 \* var\(--wb-titlebar-height\)\)/);
  assert.match(mainRule, /margin-bottom\s*:\s*6px/);
  assert.doesNotMatch(mainRule, /margin-right\s*:\s*6px/);
  assert.match(mainRule, /pointer-events\s*:\s*auto/);
  assert.match(sidebarRule, /pointer-events\s*:\s*auto/);
  assert.match(inspectorRule, /pointer-events\s*:\s*auto/);
  assert.doesNotMatch(sidebarRule, /margin-top\s*:\s*calc\(-1 \* var\(--wb-titlebar-height\)\)/);
  assert.doesNotMatch(inspectorRule, /margin-top\s*:\s*calc\(-1 \* var\(--wb-titlebar-height\)\)/);
  assert.match(paneRule, /flex-direction\s*:\s*column/);
  assert.match(paneTabbarRule, /flex\s*:\s*0 0 auto/);
  assert.match(paneTabbarRule, /position\s*:\s*relative/);
  assert.match(paneTabbarRule, /z-index\s*:\s*25/);
  assert.match(paneTabbarRule, /min-height\s*:\s*var\(--wb-titlebar-height\)/);
  assert.match(paneTabbarRule, /height\s*:\s*var\(--wb-titlebar-height\)/);
  assert.match(paneChildTabbarRule, /order\s*:\s*0/);
  assert.match(paneObjectTabsRule, /min-height\s*:\s*var\(--wb-titlebar-height\)/);
  assert.match(paneTabbarRule, /align-items\s*:\s*center/);
  assert.match(paneTabbarRule, /overflow\s*:\s*visible/);
  assert.match(paneObjectTabsRule, /align-items\s*:\s*center/);
  assert.match(paneObjectTabsRule, /overflow-y\s*:\s*hidden/);
  assert.match(paneObjectTabsRule, /padding\s*:\s*4px 0 0\s*;/);
  assert.match(paneObjectTabsRule, /margin-right:\s*0/);
  assert.match(singlePaneObjectTabsRule, /margin-right:\s*calc\(var\(--wb-sidebar-tab-offset\) \+ var\(--wb-titlebar-tab-right-clearance\)\)/);
  assert.match(css, /\.wb-pane-tabbar\.is-right-edge-pane \.wb-object-tabs\s*\{[^}]*margin-right:\s*var\(--wb-titlebar-tab-right-clearance\)/s);
  assert.match(tableToolbarRule, /min-height\s*:\s*38px/);
  assert.match(css, /\.wb-workbench-pane\s*>\s*\.wb-table-panel,[\s\S]*?z-index\s*:\s*0/s);
  assert.match(css, /\.wb-pane-tabbar \.wb-tab\.active\s*\{[^}]*z-index\s*:\s*3/s);
  assert.doesNotMatch(css, /\.wb-topbar-pane-tabs/);
});

test("collapsed sidebar titlebar shows only the expand toggle and clears pane tabs", () => {
  const titlebarSidebarRule = ruleBody(".wb-titlebar-sidebar");
  const collapsedRule = ruleBody(".wb-titlebar-sidebar.is-collapsed");
  const hiddenActionsRule = ruleBody(".wb-titlebar-sidebar.is-retracted .wb-sidebar-actions");
  const collapseButtonRule = ruleBody(".wb-titlebar-sidebar.is-collapsed .wb-topbar-collapse-btn");
  const sidebarRule = ruleBody(".wb-sidebar");
  const leftEdgePaneObjectTabsRule = ruleBody(".wb-pane-tabbar.is-left-edge-pane .wb-object-tabs");
  const workbenchRule = ruleBody(".mysql-workbench");
  assert.match(titlebarSidebarRule, /width:\s*var\(--wb-sidebar-titlebar-width\)/);
  assert.match(collapsedRule, /position\s*:\s*absolute/);
  assert.match(collapsedRule, /justify-content\s*:\s*center/);
  assert.match(collapsedRule, /padding\s*:\s*0/);
  assert.match(collapsedRule, /transition\s*:\s*none/);
  assert.match(hiddenActionsRule, /max-width\s*:\s*0/);
  assert.match(hiddenActionsRule, /opacity\s*:\s*0/);
  assert.match(collapseButtonRule, /width\s*:\s*32px/);
  assert.match(css, /\.wb-sidebar-slot\s*\{[^}]*width:\s*var\(--wb-sidebar-slot-width\)/s);
  assert.match(css, /\.wb-sidebar-slot\s*\{[^}]*transition:\s*width var\(--wb-pane-collapse-duration\)/s);
  assert.match(sidebarRule, /contain\s*:\s*layout paint/);
  assert.match(sidebarRule, /width:\s*var\(--wb-sidebar-content-width\)/);
  assert.match(sidebarRule, /min-width:\s*var\(--wb-sidebar-content-width\)/);
  assert.match(css, /@property --wb-sidebar-content-width/);
  assert.doesNotMatch(css, /@keyframes wb-sidebar-push-flash/);
  assert.doesNotMatch(css, /filter:\s*brightness/);
  assert.doesNotMatch(css, /\.wb-sidebar\.is-expanding\s*\{[^}]*min-width:\s*var\(--wb-sidebar-titlebar-width\)/s);
  assert.match(css, /\.wb-sidebar\.is-pane-animating:not\(\.is-expanding\) \.wb-source-tree/s);
  assert.match(css, /\.wb-sidebar\.is-pane-animating\.is-expanding \.wb-source-tree/s);
  assert.match(leftEdgePaneObjectTabsRule, /transform:\s*translateX\(var\(--wb-sidebar-tab-offset\)\)/);
  assert.match(css, /--wb-sidebar-tab-clearance:\s*32px/);
  assert.doesNotMatch(ruleBody(":root"), /--wb-sidebar-tab-offset/);
  assert.match(workbenchRule, /--wb-sidebar-tab-offset:\s*max\(0px, calc\(var\(--wb-sidebar-tab-clearance\) - var\(--wb-sidebar-slot-width\)\)\)/);
});

test("tab dragging cursor stays scoped to tab bodies, not the shifted tabbar gap", () => {
  const paneTabbarRule = ruleBody(".wb-pane-tabbar");
  const objectTabsRule = ruleBody(".wb-object-tabs");
  const tabListRule = ruleBody(".wb-tab-list");
  const draggableTabRule = ruleBody('.wb-tab[draggable="true"]');

  assert.doesNotMatch(paneTabbarRule, /cursor\s*:\s*grab/);
  assert.doesNotMatch(objectTabsRule, /cursor\s*:\s*grab/);
  assert.doesNotMatch(tabListRule, /cursor\s*:\s*grab/);
  assert.match(draggableTabRule, /cursor\s*:\s*grab/);
});

test("collapsed inspector toggle docks left of the pin and Agent buttons", () => {
  const workbenchRule = ruleBody(".mysql-workbench");
  const titlebarInspectorRule = ruleBody(".wb-titlebar-inspector-controls");
  const collapsedRule = ruleBody(".wb-titlebar-inspector-controls.is-collapsed");
  const aiEntryRule = ruleBody(".wb-ai-entry-button");
  const pinEntryRule = ruleBody(".wb-pin-entry-button");
  const collapseButtonRule = ruleBody(".wb-topbar-collapse-btn");

  assert.match(workbenchRule, /--wb-titlebar-agent-right:\s*176px/);
  assert.match(workbenchRule, /--wb-titlebar-pin-right:\s*210px/);
  assert.match(workbenchRule, /--wb-titlebar-inspector-toggle-right:\s*244px/);
  assert.match(aiEntryRule, /right\s*:\s*var\(--wb-titlebar-agent-right\)/);
  assert.match(pinEntryRule, /right\s*:\s*var\(--wb-titlebar-pin-right\)/);
  assert.match(orchestratorVue, /Math\.max\(inspectorWidth\.value, INSPECTOR_MIN_WIDTH\)/);
  assert.doesNotMatch(orchestratorVue, /inspectorTitlebarNarrow|'is-narrow'/);
  assert.match(titlebarInspectorRule, /transition:[^;]*width var\(--wb-pane-collapse-duration\)/);
  assert.match(collapsedRule, /position\s*:\s*absolute/);
  assert.match(collapsedRule, /right\s*:\s*var\(--wb-titlebar-inspector-toggle-right\)/);
  assert.match(collapsedRule, /z-index\s*:\s*40/);
  assert.match(collapsedRule, /padding\s*:\s*0/);
  assert.match(collapsedRule, /justify-content\s*:\s*center/);
  assert.match(collapsedRule, /background\s*:\s*transparent/);
  assert.doesNotMatch(css, /\.wb-titlebar-inspector-controls\.is-narrow/);
  assert.match(collapseButtonRule, /min-width\s*:\s*30px/);
});

test("readability tokens keep metadata and disabled text legible in both themes", () => {
  const rootRule = ruleBody(":root");
  const darkRule = ruleBody('.mysql-workbench[data-theme="dark"]');
  const disabledDangerRule = ruleBody(".wb-database-sync-danger:disabled");

  assert.match(rootRule, /--wb-disabled:\s*#6f7782/);
  assert.match(rootRule, /--wb-field-placeholder:\s*#5f6670/);
  assert.match(rootRule, /--wb-quiet-text:\s*#4f5661/);
  assert.match(rootRule, /--wb-remark-text:\s*#3f4650/);
  assert.match(darkRule, /--wb-disabled:\s*#9ba3af/);
  assert.match(darkRule, /--wb-field-placeholder:\s*#a9b0ba/);
  assert.match(darkRule, /--wb-quiet-text:\s*#a8b0ba/);
  assert.match(darkRule, /--wb-remark-text:\s*#c2c8d0/);
  assert.match(disabledDangerRule, /border-color:\s*var\(--wb-danger-border\)/);
  assert.match(disabledDangerRule, /background:\s*var\(--wb-danger-surface\)/);
  assert.match(disabledDangerRule, /color:\s*var\(--wb-danger-text\)/);
  assert.match(disabledDangerRule, /opacity:\s*1/);
  // 发送表是非破坏性操作（重名自动 _copy），主按钮用 accent 主色而非危险色。
  assert.match(
    tableCopyDialogVue,
    /class="wb-dialog-primary"\s*:disabled="!copy\.canExecute\.value \|\| isBusy"/,
  );
  assert.doesNotMatch(tableCopyDialogVue, /wb-database-sync-danger/);
});

test("grid and inspector typography favor long-session readability", () => {
  const gridRule = ruleBody(".wb-grid");
  const thRule = ruleBody(".wb-grid th");
  const commentRule = ruleBody(".wb-schema-field-comment");
  const detailRule = ruleBody(".wb-detail-input");
  const tableCommentRule = ruleBody(".wb-inspector-table-comment");
  const cellIdentityRule = ruleBody(".wb-cell-identity");

  assert.match(gridRule, /font-size\s*:\s*13\.5px/);
  assert.match(thRule, /font-size\s*:\s*13px/);
  assert.match(thRule, /font-weight\s*:\s*650/);
  assert.match(commentRule, /font-size\s*:\s*12\.5px/);
  assert.match(commentRule, /line-height\s*:\s*1\.6/);
  assert.match(detailRule, /font-size\s*:\s*13px/);
  assert.match(tableCommentRule, /font-size\s*:\s*12\.5px/);
  assert.match(cellIdentityRule, /font-size\s*:\s*11px/);
});

test("field comment text wraps within its adjustable row and clamps overflow", () => {
  const commentRule = ruleBody(".wb-field-comment-text");

  assert.match(commentRule, /white-space\s*:\s*normal/);
  assert.match(commentRule, /overflow-wrap\s*:\s*anywhere/);
  assert.match(commentRule, /-webkit-line-clamp\s*:\s*var\(--wb-field-comment-lines,\s*1\)/);
});

test("table design grid keeps controls hit-testable in short split panes", () => {
  const bodyRule = ruleBody(".wb-design-body");
  const wrapRule = ruleBody(".wb-design-grid-wrap");
  const expandRule = ruleBody(".wb-design-comment-expand");
  const addColumnRule = ruleBody(".wb-design-add-column");

  assert.match(bodyRule, /overflow\s*:\s*auto/);
  assert.match(wrapRule, /flex\s*:\s*1 1 180px/);
  assert.match(wrapRule, /min-height\s*:\s*160px/);
  assert.match(expandRule, /min-width\s*:\s*36px/);
  assert.match(expandRule, /white-space\s*:\s*nowrap/);
  assert.match(addColumnRule, /width\s*:\s*100%/);
  assert.match(addColumnRule, /min-height\s*:\s*38px/);
});

test("dark grid canvas blends with row surfaces instead of reading as a black hole", () => {
  const darkRule = ruleBody('.mysql-workbench[data-theme="dark"]');

  // 深色下空画布（最后一列右侧/末行下方）与行表面统一为同一画布色，不再黑成“破洞”
  assert.match(darkRule, /--wb-workspace-mist-canvas:\s*#0f0f11/);
  assert.match(ruleBody(".wb-grid-shell"), /background:\s*var\(--wb-workspace-mist-canvas\)/);
  assert.match(ruleBody(".wb-grid-wrap"), /background:\s*var\(--wb-workspace-mist-canvas\)/);
});

test("NULL cell tint is tokenized and strengthened in dark theme", () => {
  const rootRule = ruleBody(":root");
  const darkRule = ruleBody('.mysql-workbench[data-theme="dark"]');
  const nullRule = ruleBody(".wb-grid td.is-null");

  assert.match(rootRule, /--wb-null-cell-tint:\s*color-mix\(in srgb, var\(--wb-quiet-text\) 7%, transparent\)/);
  assert.match(darkRule, /--wb-null-cell-tint:\s*color-mix\(in srgb, var\(--wb-quiet-text\) 16%, transparent\)/);
  assert.match(nullRule, /background-image:\s*linear-gradient\(\s*var\(--wb-null-cell-tint\),\s*var\(--wb-null-cell-tint\)\s*\)/);
  assert.doesNotMatch(nullRule, /7%, transparent/);
});

test("context menus use a near-opaque tokenized menu surface in both themes", () => {
  const rootRule = ruleBody(":root");
  const darkRule = ruleBody('.mysql-workbench[data-theme="dark"]');

  assert.match(rootRule, /--wb-menu-surface:\s*rgba\(255, 255, 255, 0\.98\)/);
  assert.match(darkRule, /--wb-menu-surface:\s*rgba\(18, 18, 20, 0\.96\)/);
  assert.match(ruleBody(".wb-context-menu"), /background:\s*var\(--wb-menu-surface\)/);
});

test("settings drawer uses an opaque dialog surface", () => {
  assert.match(ruleBody(".wb-sidebar-settings-sheet"), /background:\s*var\(--wb-dialog-surface\)/);
});

test("collapsed settings drawer is removed from keyboard and screen-reader navigation", () => {
  const sidebarVue = readFileSync(join(__dirname, "components", "WorkbenchSidebar.vue"), "utf8");
  const sheet = sidebarVue.match(/<section[\s\S]{0,240}id="wb-sidebar-settings-sheet"[\s\S]*?>/)?.[0] || "";

  assert.match(sidebarVue, /<Transition name="wb-sidebar-settings-sheet">\s*<section/);
  assert.match(sheet, /v-if="settingsOpen"/);
  assert.match(sheet, /:aria-hidden="!settingsOpen"/);
  assert.match(sheet, /:inert="!settingsOpen"/);
  assert.match(sidebarVue, /closeSettings\(\{ restoreFocus: true \}\)/);
  assert.match(sidebarVue, /restoreFocus\) nextTick\(\(\) => settingsTriggerRef\.value\?\.focus/);
});

test("save errors remain visible for four seconds while success feedback stays brief", () => {
  assert.match(ruleBody(".wb-save-reminder"), /--wb-save-reminder-duration:\s*1300ms/);
  assert.match(ruleBody(".wb-save-reminder"), /animation:\s*wb-save-reminder-float var\(--wb-save-reminder-duration\)/);
  assert.match(ruleBody(".wb-save-reminder.is-error"), /--wb-save-reminder-duration:\s*4000ms/);
  assert.match(orchestratorVue, /SAVE_REMINDER_DURATION_MS\s*=\s*Object\.freeze\(\{ default: 1300, error: 4000, warning: 4000 \}\)/);
  assert.equal((orchestratorVue.match(/saveReminderDuration\(kind\)/g) || []).length, 3);
});

test("sidebar settings gear is an inline SVG instead of theme-switched bitmaps", () => {
  const sidebarVue = readFileSync(join(__dirname, "components", "WorkbenchSidebar.vue"), "utf8");

  assert.doesNotMatch(sidebarVue, /settings(-white)?\.png/);
  assert.doesNotMatch(sidebarVue, /<img[\s\S]{0,200}wb-sidebar-settings-icon/);
  assert.match(sidebarVue, /<svg[\s\S]{0,300}class="wb-sidebar-settings-icon"/);
  assert.match(sidebarVue, /class="wb-sidebar-settings-icon"[\s\S]{0,300}stroke="currentColor"/);
});

test("cell detail collapse bar uses theme tokens and pane-collapse motion", () => {
  const headerRule = ruleBody(".wb-cell-detail-header");
  const collapsedHoverRule = ruleBody(".wb-cell-detail-header.is-collapsed:hover");
  const toggleRule = ruleBody(".wb-cell-detail-toggle");
  const toggleHoverRule = ruleBody(".wb-cell-detail-toggle:hover");
  const titleRule = ruleBody(".wb-cell-detail-title");
  const contentRule = ruleBody(".wb-cell-detail-content");
  const resizingContentRule = ruleBody(".wb-cell-detail.is-resizing .wb-cell-detail-content");

  // 27px bar + 1px border-top on .wb-cell-detail = the 28px collapsed strip.
  assert.match(headerRule, /height:\s*27px/);
  assert.match(headerRule, /color:\s*var\(--wb-quiet-text\)/);
  assert.match(collapsedHoverRule, /background:\s*var\(--wb-control-hover\)/);
  assert.match(collapsedHoverRule, /color:\s*var\(--wb-text\)/);
  assert.match(toggleRule, /color:\s*var\(--wb-muted\)/);
  assert.match(toggleHoverRule, /background:\s*var\(--wb-accent-soft\)/);
  assert.match(titleRule, /font-family:\s*var\(--wb-font-ui\)/);

  // Only height/opacity animate, on the shared pane-collapse duration/ease.
  assert.match(contentRule, /overflow:\s*hidden/);
  assert.match(contentRule, /transition:[^;]*height var\(--wb-pane-collapse-duration\) var\(--wb-pane-collapse-ease\)/s);
  assert.match(contentRule, /opacity calc\(var\(--wb-pane-collapse-duration\) \* 0\.85\) var\(--wb-pane-collapse-ease\)/);
  assert.match(resizingContentRule, /transition:\s*none/);
});

test("confirm dialog danger button binds the class the stylesheet actually styles", () => {
  const confirmVue = readFileSync(join(__dirname, "components", "ConfirmDialog.vue"), "utf8");

  // Regression: the component used to bind `wb-dialog-danger`, a class with no
  // rules anywhere, so destructive confirms looked identical to normal ones.
  // The styled rule is `.wb-dialog-primary.danger` (same recipe as
  // `.wb-database-sync-danger`), so the component must bind `danger`.
  assert.doesNotMatch(confirmVue, /wb-dialog-danger/);
  assert.match(confirmVue, /:class="\{ danger \}"/);
  assert.match(ruleBody(".wb-dialog-primary.danger"), /background:\s*var\(--wb-danger\)/);
  assert.match(ruleBody(".wb-dialog-primary.danger"), /color:\s*#fff/);
  assert.match(ruleBody(".wb-dialog-primary.danger:hover:not(:disabled)"), /color-mix\(in srgb, var\(--wb-danger\) 86%, #000\)/);
});

test("batch export keeps its pending cancel action legible while preventing duplicate requests", () => {
  const busyRule = ruleBody(".wb-batch-transfer-actions .wb-dialog-primary.is-busy:disabled");

  assert.match(batchExportDialogVue, /:class="\{ 'is-busy': batch\.cancelRequested \}"/);
  assert.match(batchExportDialogVue, /:aria-busy="batch\.cancelRequested"/);
  assert.match(busyRule, /background:\s*var\(--wb-accent-control-busy\)/);
  assert.match(busyRule, /color:\s*var\(--wb-accent-control-text\)/);
  assert.match(busyRule, /cursor:\s*wait/);
  assert.match(busyRule, /opacity:\s*1/);
});

test("batch export exposes a reversible homepage-selection focus and an export-location action", () => {
  assert.match(batchExportDialogVue, /仅显示首页预选的/);
  assert.match(batchExportDialogVue, /取消预选，选择其他表/);
  assert.match(batchExportDialogVue, /function cancelHomepageSelection\(\)[\s\S]*query\.value = ""/);
  assert.match(batchExportDialogVue, /transfer\.visibleExportTables\.value/);
  assert.match(batchExportDialogVue, /transfer\.openBatchExportSavedPath/);
  assert.match(batchExportDialogVue, /打开位置/);
  assert.match(ruleBody(".wb-batch-selection-focus"), /background:\s*color-mix/);
  assert.match(ruleBody(".wb-batch-result-summary > .wb-batch-result-path"), /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
});

test("database display separates icon and name colors with theme-following defaults", () => {
  const sidebarVue = readFileSync(join(__dirname, "components", "WorkbenchSidebar.vue"), "utf8");

  assert.match(databaseDisplayDialogVue, /v-model="textColorDraft"[\s\S]*label="名称颜色"/);
  assert.match(databaseDisplayDialogVue, /v-model="colorDraft" label="图标颜色"/);
  assert.match(databaseDisplayDialogVue, /DATABASE_TEXT_COLOR_PRESETS/);
  assert.match(databaseDisplayDialogVue, /自定义颜色不会随主题切换/);
  assert.match(databaseColorPickerVue, /跟随主题/);
  assert.match(sidebarVue, /databaseTextStyle\(connection\.id, database\)/);
  assert.match(sidebarVue, /class="wb-table-name" :style="databaseTextStyle\(connection\.id, database\)"/);
  assert.match(databaseDisplayDialogVue, /:is="previewTableIcon"/);
  assert.equal((databaseDisplayDialogVue.match(/hint="库、首页、子表"/g) || []).length, 2);
  assert.match(databaseHomeVue, /useDatabaseDecorations\(\)/);
  assert.match(databaseHomeVue, /databaseLabel\(props\.tab\.connectionId, props\.tab\.database\)/);
  assert.match(databaseHomeVue, /:is="databaseHomeIcon"/);
  assert.match(databaseHomeVue, /:style="databaseHomeDecorationStyle"/);
  assert.match(databaseHomeVue, /:database-decoration="databaseDecoration"/);
  assert.match(databaseTableListVue, /databaseTableIconComponent\(props\.databaseDecoration\)/);
  assert.match(databaseTableListVue, /:is="tableIcon"/);
  assert.match(tabsVue, /useDatabaseDecorations\(\)/);
  assert.match(tabsVue, /:is="tabDatabaseIcon\(tab\)"/);
  assert.match(tabsVue, /v-if="tabDatabaseDecoration\(tab\)"/);
  assert.match(tabsVue, /<svg v-else class="wb-tab-db-icon"/);
  assert.match(tabsVue, /:style="tabDatabaseDecorationStyle\(tab\)"/);
  assert.match(ruleBody(".wb-dbhome-title h2"), /color:\s*var\(--wb-dbhome-name-color, var\(--wb-text\)\)/);
  assert.match(ruleBody(".wb-dbhome-title-icon"), /color:\s*var\(--wb-dbhome-icon-color, var\(--wb-accent-strong\)\)/);
  assert.match(ruleBody(".wb-dbhome-table-icon"), /color:\s*var\(--wb-dbhome-icon-color, currentColor\)/);
  assert.match(ruleBody(".wb-dbhome-object-name-button"), /color:\s*var\(--wb-dbhome-name-color, var\(--wb-text\)\)/);
  assert.match(ruleBody(".wb-dbhome-object-row.is-selected .wb-dbhome-object-name-button"), /color:\s*var\(--wb-dbhome-name-color, var\(--wb-text\)\)/);
  assert.match(ruleBody(".wb-dbhome-object-row.is-box-selected .wb-dbhome-object-name-button"), /color:\s*var\(--wb-dbhome-name-color, var\(--wb-text\)\)/);
  assert.match(ruleBody(".wb-dbhome-rename-input"), /color:\s*var\(--wb-dbhome-name-color, var\(--wb-text\)\)/);
  assert.match(ruleBody(".wb-tab-db-icon"), /color:\s*var\(--wb-tab-database-icon-color, currentColor\)/);
  assert.match(ruleBody(".wb-tab-db-icon.is-decorated"), /opacity:\s*1/);
  assert.match(ruleBody(".wb-tab-db"), /color:\s*var\(--wb-tab-database-name-color, currentColor\)/);
  assert.match(ruleBody(".wb-database-color-setting"), /grid-template-columns:\s*86px minmax\(0, 1fr\)/);
  for (const [name, light, dark] of [
    ["slate", "#475569", "#cbd5e1"],
    ["teal", "#0f766e", "#5eead4"],
    ["blue", "#1d4ed8", "#93c5fd"],
    ["violet", "#6d28d9", "#c4b5fd"],
    ["amber", "#92400e", "#fbbf24"],
    ["orange", "#9a3412", "#fdba74"],
    ["rose", "#9f1239", "#fda4af"],
    ["green", "#166534", "#86efac"],
  ]) {
    assert.match(css, new RegExp(`--wb-database-name-${name}:\\s*${light}`));
    assert.match(css, new RegExp(`--wb-database-name-${name}:\\s*${dark}`));
  }
});

test("context menu items lay out icon + label in a flex row", () => {
  const itemRule = ruleBody(".wb-context-menu button");
  assert.match(itemRule, /display:\s*flex/);
  assert.match(itemRule, /align-items:\s*center/);
  assert.match(itemRule, /gap:\s*8px/);
  assert.match(itemRule, /border-radius:\s*5px/);
  assert.match(ruleBody(".wb-context-menu"), /min-width:\s*176px/);
  const iconRule = ruleBody(".wb-context-menu button .wb-context-icon");
  assert.match(iconRule, /flex:\s*none/);
  assert.match(iconRule, /opacity:\s*0\.82/);
});

test("context menu row group combines a bounded count with above and below insertion", () => {
  const menuVue = readFileSync(join(__dirname, "components", "ContextMenu.vue"), "utf8");

  assert.match(menuVue, /grid-row-insert-below/);
  assert.doesNotMatch(menuVue, /grid-row-insert-multiple/);
  assert.match(menuVue, /ArrowUpToLine/);
  assert.match(menuVue, /ArrowDownToLine/);
  assert.match(menuVue, /normalizedInsertRowCount/);
  assert.match(menuVue, /min="1"/);
  assert.match(menuVue, /max="99"/);
});

test("row insert count uses a compact tokenized stepper inside the menu", () => {
  assert.match(ruleBody(".wb-context-count-control"), /grid-template-columns:\s*24px 34px 24px/);
  assert.match(ruleBody(".wb-context-count-control"), /background:\s*var\(--wb-field-surface\)/);
  assert.match(ruleBody(".wb-context-count-control:focus-within"), /border-color:\s*var\(--wb-accent\)/);
});

test("numeric columns render right-aligned with tabular figures", () => {
  const cellRule = ruleBody(".wb-grid th.is-numeric-col");
  assert.match(cellRule, /text-align:\s*right/);
  assert.match(cellRule, /font-variant-numeric:\s*tabular-nums/);
  assert.match(ruleBody(".wb-grid td.is-numeric-col input"), /text-align:\s*right/);
  assert.match(dataGridVue, /'is-numeric-col': columnMeta\.isNumeric/);
});

test("settings drawer offers a color-theme picker row", () => {
  const sidebarVue = readFileSync(join(__dirname, "components", "WorkbenchSidebar.vue"), "utf8");

  assert.match(sidebarVue, /wb-sidebar-theme-options/);
  assert.match(sidebarVue, /emit\('set-color-theme', theme\.id\)/);
  const activeRule = ruleBody(".wb-sidebar-theme-option.active");
  assert.match(activeRule, /border-color:\s*var\(--wb-accent\)/);
  assert.match(activeRule, /background:\s*var\(--wb-accent-soft\)/);
});

test("sidebar tree nodes use lucide icons for connection, database, and table", () => {
  const sidebarVue = readFileSync(join(__dirname, "components", "WorkbenchSidebar.vue"), "utf8");

  assert.match(sidebarVue, /<Server :size="15" class="wb-tree-kind-icon"/);
  assert.match(sidebarVue, /:is="databaseTreeIcon\(connection\.id, database\)"/);
  assert.match(sidebarVue, /:is="tableTreeIcon\(connection\.id, database\)"/);
  assert.match(sidebarVue, /:style="databaseMarkerStyle\(connection\.id, database\)"/);
  assert.doesNotMatch(sidebarVue, /data-kind="connection"/);
  assert.doesNotMatch(sidebarVue, /data-kind="database"/);
  assert.doesNotMatch(css, /data-kind="table"/);
});

test("sidebar table rows lay out icon and label on a single line", () => {
  assert.match(ruleBody(".wb-table-item"), /grid-template-columns:\s*var\(--wb-tree-icon-width\) minmax\(0, 1fr\)/);
});

test("SQL workspace keeps canvas, chrome bands, and editor content on distinct layers", () => {
  assert.match(ruleBody(".wb-sql-workspace"), /background:\s*var\(--wb-workspace-mist-canvas\)/);
  assert.match(ruleBody(".wb-sql-toolbar"), /background:\s*var\(--wb-workspace-mist-raised\)/);
  assert.match(ruleBody(".wb-sql-filebar"), /background:\s*var\(--wb-workspace-mist-raised\)/);
  assert.match(ruleBody(".wb-sql-editor-pane"), /background:\s*var\(--wb-table-surface\)/);
  assert.match(ruleBody(".wb-sql-output"), /background:\s*var\(--wb-workspace-mist-canvas\)/);
  assert.match(ruleBody(".wb-sql-resize"), /background:\s*var\(--wb-chrome-surface\)/);
  assert.match(ruleBody(".wb-sql-output-tabs"), /background:\s*var\(--wb-chrome-surface\)/);
  assert.match(ruleBody(".wb-sql-library-header"), /background:\s*var\(--wb-workspace-mist-raised\)/);
  assert.match(ruleBody('.mysql-workbench[data-theme="dark"]'), /--wb-empty-text:\s*#9299a3/);
});

test("quick open entry stacks above the top-edge pane tabbar that overlaps the titlebar", () => {
  // .wb-main 上探到标题栏下方，顶沿 pane 页签条 z-index 32 会盖住标题栏区域；
  // 快速打开按钮与标题栏其他控件同档 40，否则被不透明背景遮罩而不可见、不可点。
  assert.match(ruleBody(".wb-quick-open-entry"), /z-index:\s*40/);
  assert.match(ruleBody(".wb-pane-tabbar.is-top-edge-pane"), /z-index:\s*32/);
});
