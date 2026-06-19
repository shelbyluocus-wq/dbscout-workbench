import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, "workbench.css"), "utf8");
const orchestratorVue = readFileSync(join(__dirname, "MySqlWorkbench.vue"), "utf8");
const splitLayoutVue = readFileSync(join(__dirname, "components", "WorkbenchSplitLayout.vue"), "utf8");
const tabsVue = readFileSync(join(__dirname, "components", "WorkbenchTabs.vue"), "utf8");

function ruleBodies(selector) {
  const bodies = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rulePattern.exec(css))) {
    const selectors = match[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2]);
  }
  assert.ok(bodies.length > 0, `Expected ${selector} rule to exist`);
  return bodies;
}

function ruleBody(selector) {
  return ruleBodies(selector).join("\n");
}

test("pane edges use structural inset lines instead of side borders", () => {
  assert.doesNotMatch(ruleBody(".wb-main"), /border-left\s*:/);
  assert.doesNotMatch(ruleBody(".wb-inspector"), /border-left\s*:/);
  assert.match(ruleBody(".wb-main"), /box-shadow\s*:\s*inset 1px 0 0 var\(--wb-line\)/);
  assert.match(ruleBody(".wb-inspector"), /box-shadow\s*:\s*inset 1px 0 0 var\(--wb-line\)/);
});

test("titlebar avoids standalone vertical divider lines", () => {
  assert.doesNotMatch(orchestratorVue, /wb-titlebar-divider/);
  assert.doesNotMatch(css, /\.wb-titlebar-divider\s*\{/);
  assert.match(ruleBody(".wb-titlebar-tabs"), /box-shadow\s*:\s*none/);
  assert.match(ruleBody(".wb-titlebar-inspector-controls"), /box-shadow\s*:\s*none/);
});

test("focused split pane avoids a full pane outline", () => {
  const focusedPaneRule = ruleBody(".wb-workbench-pane.is-focused");
  const focusedPaneTabbarRule = ruleBody(".wb-pane-tabbar.is-focused-pane");

  assert.match(focusedPaneRule, /box-shadow\s*:\s*none/);
  assert.match(focusedPaneTabbarRule, /background\s*:/);
});

test("split resize handles appear only on hover or active drag", () => {
  assert.match(splitLayoutVue, /'is-resizing':\s*draggingSplit\?\.id\s*===\s*layout\.id/);
  assert.match(ruleBody(".wb-split-layout"), /background\s*:\s*transparent/);
  assert.match(ruleBody(".wb-split-divider"), /background\s*:\s*transparent/);
  const splitDividerRule = ruleBody(".wb-split-divider");
  const splitDividerMarkerRule = ruleBody(".wb-split-divider::before");
  assert.match(splitDividerRule, /flex\s*:\s*0 0 5px/);
  assert.match(splitDividerMarkerRule, /inset\s*:\s*0/);
  assert.match(splitDividerMarkerRule, /background\s*:\s*var\(--wb-accent-soft\)/);
  assert.match(splitDividerMarkerRule, /opacity\s*:\s*0/);
  assert.match(ruleBody(".wb-split-divider:hover::before"), /opacity\s*:\s*1/);
  assert.match(ruleBody(".wb-split-layout.is-resizing > .wb-split-divider::before"), /opacity\s*:\s*1/);
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

test("open table chrome shrinks tabs instead of showing a horizontal scrollbar", () => {
  const tabStripRule = ruleBody(".wb-object-tabs");
  const tabListRule = ruleBody(".wb-tab-list");
  const tabRule = ruleBody(".wb-tab");

  assert.match(tabStripRule, /overflow-x\s*:\s*hidden/);
  assert.match(tabListRule, /flex\s*:\s*1\s+1\s+auto/);
  assert.match(tabListRule, /min-width\s*:\s*0/);
  assert.match(tabRule, /display\s*:\s*inline-flex/);
  assert.match(tabRule, /flex\s*:\s*1\s+1\s+122px/);
  assert.match(tabRule, /min-width\s*:\s*28px/);
  assert.match(tabRule, /max-width\s*:\s*220px/);
  assert.match(tabRule, /position\s*:\s*relative/);
  assert.match(tabRule, /padding\s*:\s*0 32px 0 8px/);
  assert.match(tabRule, /overflow\s*:\s*hidden/);
  assert.match(tabRule, /container-type\s*:\s*inline-size/);
  assert.match(css, /@container\s*\(max-width:\s*88px\)/);
  assert.match(ruleBody(".wb-tab-title"), /flex\s*:\s*1\s+1\s+auto/);
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
  assert.match(closeRule, /width\s*:\s*28px/);
  assert.match(closeRule, /height\s*:\s*28px/);
  assert.match(closeRule, /min-height\s*:\s*28px/);
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
  assert.match(tabListRule, /flex\s*:\s*1\s+1\s+auto/);
  assert.match(tabListRule, /min-width\s*:\s*0/);
  assert.match(tabRule, /display\s*:\s*inline-flex/);
  assert.match(tabRule, /flex\s*:\s*1\s+1\s+122px/);
  assert.match(tabRule, /min-width\s*:\s*28px/);
  assert.match(tabRule, /max-width\s*:\s*220px/);
  assert.match(tabRule, /overflow\s*:\s*hidden/);
  assert.doesNotMatch(activeTabRule, /border-bottom\s*:/);
  assert.match(activeTabRule, /box-shadow\s*:\s*inset 0 -2px 0 var\(--wb-accent\)/);
  assert.doesNotMatch(tabStripRule, /border-bottom\s*:/);
  assert.doesNotMatch(paneHeaderRule, /border-bottom\s*:/);
  assert.doesNotMatch(toolbarRule, /border-bottom\s*:/);
});

test("inspector cell identity panel floats over the pulled-down detail editor", () => {
  const textPanelRule = ruleBody(".wb-text-panel");
  const detailEditorRule = ruleBody(".wb-detail-editor");
  const cellPanelRule = ruleBody(".wb-inspector-cell-panel");
  const aiCellPanelRule = ruleBody(".wb-ai-cell-panel");
  const cellIdentityRule = ruleBody(".wb-cell-identity.is-panel");

  assert.match(textPanelRule, /position\s*:\s*relative/);
  assert.match(textPanelRule, /padding\s*:\s*8px/);
  assert.match(detailEditorRule, /flex\s*:\s*1/);
  assert.match(detailEditorRule, /min-height\s*:\s*0/);
  assert.match(cellPanelRule, /position\s*:\s*absolute/);
  assert.match(cellPanelRule, /left\s*:\s*16px/);
  assert.match(cellPanelRule, /bottom\s*:\s*12px/);
  assert.match(cellPanelRule, /right\s*:\s*20px/);
  assert.doesNotMatch(cellPanelRule, /background\s*:\s*var\(--wb-status-surface\)/);
  assert.doesNotMatch(cellPanelRule, /border-radius\s*:\s*10px/);
  assert.match(cellIdentityRule, /border-radius\s*:\s*10px/);
  assert.match(cellIdentityRule, /background\s*:\s*var\(--wb-status-surface\)/);
  assert.match(cellIdentityRule, /min-height\s*:\s*32px/);

  // The agent panel's cell pill must use the exact same offsets as the
  // inspector's so switching tabs doesn't visibly shift the pill.
  assert.match(aiCellPanelRule, /position\s*:\s*absolute/);
  assert.match(aiCellPanelRule, /left\s*:\s*16px/);
  assert.match(aiCellPanelRule, /bottom\s*:\s*12px/);
  assert.match(aiCellPanelRule, /right\s*:\s*20px/);
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

test("table copy dialog rows are flat and the viewport fills dialog space", () => {
  const viewportRule = css.match(/(?:^|\r?\n)\.wb-table-copy-viewport\s*\{([^}]*)\}/s)?.[1] || "";
  const rowRule = css.match(/(?:^|\r?\n)\.wb-table-copy-row\s*\{([^}]*)\}/s)?.[1] || "";

  assert.ok(viewportRule, "Expected .wb-table-copy-viewport rule to exist");
  assert.ok(rowRule, "Expected .wb-table-copy-row rule to exist");
  assert.match(viewportRule, /flex\s*:\s*1 1 auto/);
  assert.doesNotMatch(viewportRule, /max-height\s*:\s*380px/);
  assert.match(rowRule, /padding\s*:\s*0 18px/);
  assert.doesNotMatch(rowRule, /padding\s*:\s*0 18px 0 36px/);
  assert.doesNotMatch(css, /\.wb-table-copy-group-header|\.wb-table-copy-chevron|\.wb-table-copy-group-checkbox/);
});

test("sidebar table search remains visible while scrolling table lists", () => {
  const sourceTreeRule = ruleBody(".wb-source-tree");
  const tableSearchRule = ruleBody(".wb-table-search");
  const searchPanelRule = ruleBody(".wb-sidebar-search-panel");

  assert.match(sourceTreeRule, /overflow\s*:\s*auto/);
  assert.doesNotMatch(searchPanelRule, /position\s*:\s*sticky/);
  assert.match(tableSearchRule, /position\s*:\s*sticky/);
  assert.match(tableSearchRule, /top\s*:\s*0/);
  assert.match(tableSearchRule, /z-index\s*:/);
  assert.match(tableSearchRule, /background\s*:\s*var\(--wb-chrome-surface\)/);
});

test("table toolbar stays readable in split panes without wrapping controls", () => {
  const toolbarRule = ruleBody(".wb-table-toolbar");
  const inputRule = ruleBody(".wb-table-toolbar input");
  const navRule = ruleBody(".wb-search-nav-btn");
  const modeRule = ruleBody(".wb-filter-mode-btn");
  const splitMoreRule = ruleBody(".wb-split-more-btn");
  const toolbarSplitMoreRule = ruleBody(".wb-table-toolbar .wb-split-more-btn");
  const dotsRule = ruleBody(".wb-split-more-dots");

  assert.match(toolbarRule, /overflow-x\s*:\s*auto/);
  assert.match(toolbarRule, /flex-wrap\s*:\s*nowrap/);
  assert.match(toolbarRule, /scrollbar-width\s*:\s*thin/);
  assert.match(inputRule, /flex\s*:\s*1 0 168px/);
  assert.match(inputRule, /min-width\s*:\s*168px/);
  for (const rule of [navRule, modeRule]) {
    assert.match(rule, /flex\s*:\s*0 0 auto/);
    assert.match(rule, /height\s*:\s*28px/);
    assert.match(rule, /min-height\s*:\s*28px/);
    assert.match(rule, /white-space\s*:\s*nowrap/);
  }
  assert.match(splitMoreRule, /width\s*:\s*28px/);
  assert.match(splitMoreRule, /height\s*:\s*28px/);
  assert.match(splitMoreRule, /min-height\s*:\s*28px/);
  assert.match(splitMoreRule, /border\s*:\s*none/);
  assert.match(splitMoreRule, /box-shadow\s*:\s*none/);
  assert.match(toolbarSplitMoreRule, /position\s*:\s*sticky/);
  assert.match(toolbarSplitMoreRule, /right\s*:\s*0/);
  assert.match(toolbarSplitMoreRule, /z-index\s*:/);
  assert.match(dotsRule, /display\s*:\s*grid/);
  assert.match(dotsRule, /grid-template-rows\s*:\s*repeat\(3,\s*3px\)/);
  assert.match(dotsRule, /width\s*:\s*3px/);
  assert.match(dotsRule, /height\s*:\s*15px/);
});

test("pane table tabs stay above each pane toolbar", () => {
  const rootRule = ruleBody(".mysql-workbench");
  const titlebarRule = ruleBody(".wb-titlebar");
  const workspaceRule = ruleBody(".wb-workspace");
  const mainRule = ruleBody(".wb-main");
  const sidebarRule = ruleBody(".wb-sidebar");
  const inspectorRule = ruleBody(".wb-inspector");
  const titlebarSidebarRule = ruleBody(".wb-titlebar-sidebar");
  const titlebarInspectorRule = ruleBody(".wb-titlebar-inspector-controls");
  const updateRule = ruleBody(".wb-update-button");
  const windowControlsRule = ruleBody(".wb-titlebar-controls");
  const paneRule = ruleBody(".wb-workbench-pane");
  const paneTabbarRule = ruleBody(".wb-pane-tabbar");
  const paneChildTabbarRule = ruleBody(".wb-workbench-pane > .wb-pane-tabbar");
  const paneObjectTabsRule = ruleBody(".wb-pane-tabbar .wb-object-tabs");
  const tableToolbarRule = ruleBody(".wb-table-toolbar");

  assert.match(rootRule, /grid-template-rows\s*:\s*minmax\(0,\s*1fr\)/);
  assert.match(rootRule, /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/);
  assert.match(titlebarRule, /grid-column\s*:\s*1/);
  assert.match(titlebarRule, /grid-row\s*:\s*1/);
  assert.doesNotMatch(titlebarRule, /z-index\s*:/);
  for (const rule of [titlebarSidebarRule, titlebarInspectorRule, updateRule, windowControlsRule]) {
    assert.match(rule, /z-index\s*:\s*40/);
  }
  assert.match(workspaceRule, /grid-column\s*:\s*1/);
  assert.match(workspaceRule, /grid-row\s*:\s*1/);
  assert.match(workspaceRule, /padding-top\s*:\s*32px/);
  assert.match(workspaceRule, /pointer-events\s*:\s*none/);
  assert.match(mainRule, /margin-top\s*:\s*-32px/);
  assert.match(mainRule, /min-height\s*:\s*calc\(100%\s*\+\s*32px\)/);
  assert.match(mainRule, /pointer-events\s*:\s*auto/);
  assert.match(sidebarRule, /pointer-events\s*:\s*auto/);
  assert.match(inspectorRule, /pointer-events\s*:\s*auto/);
  assert.doesNotMatch(sidebarRule, /margin-top\s*:\s*-32px/);
  assert.doesNotMatch(inspectorRule, /margin-top\s*:\s*-32px/);
  assert.match(paneRule, /flex-direction\s*:\s*column/);
  assert.match(paneTabbarRule, /flex\s*:\s*0 0 auto/);
  assert.match(paneTabbarRule, /position\s*:\s*relative/);
  assert.match(paneTabbarRule, /z-index\s*:\s*25/);
  assert.match(paneTabbarRule, /min-height\s*:\s*32px/);
  assert.match(paneTabbarRule, /height\s*:\s*32px/);
  assert.match(paneChildTabbarRule, /order\s*:\s*0/);
  assert.match(paneObjectTabsRule, /min-height\s*:\s*32px/);
  assert.match(paneObjectTabsRule, /padding\s*:\s*4px 7px 0/);
  assert.match(tableToolbarRule, /min-height\s*:\s*38px/);
  assert.doesNotMatch(css, /\.wb-topbar-pane-tabs/);
});

test("collapsed sidebar titlebar shows only the expand toggle and clears pane tabs", () => {
  const titlebarSidebarRule = ruleBody(".wb-titlebar-sidebar");
  const collapsedRule = ruleBody(".wb-titlebar-sidebar.is-collapsed");
  const hiddenActionsRule = ruleBody(".wb-titlebar-sidebar.is-retracted .wb-sidebar-actions");
  const collapseButtonRule = ruleBody(".wb-titlebar-sidebar.is-collapsed .wb-topbar-collapse-btn");
  const sidebarRule = ruleBody(".wb-sidebar");
  const paneObjectTabsRule = ruleBody(".wb-pane-tabbar .wb-object-tabs");
  assert.match(titlebarSidebarRule, /width:\s*var\(--wb-sidebar-titlebar-width\)/);
  assert.match(collapsedRule, /position\s*:\s*absolute/);
  assert.match(collapsedRule, /justify-content\s*:\s*center/);
  assert.match(collapsedRule, /padding\s*:\s*0/);
  assert.match(collapsedRule, /transition\s*:\s*none/);
  assert.match(hiddenActionsRule, /max-width\s*:\s*0/);
  assert.match(hiddenActionsRule, /opacity\s*:\s*0/);
  assert.match(collapseButtonRule, /width\s*:\s*32px/);
  assert.match(css, /\.wb-sidebar-slot\s*\{[^}]*width:\s*var\(--wb-sidebar-slot-width\)/s);
  assert.match(sidebarRule, /contain\s*:\s*layout paint/);
  assert.match(css, /@keyframes wb-sidebar-push-flash/);
  assert.match(css, /\.wb-sidebar-slot\.is-pane-animating\.is-expanding/);
  assert.match(css, /\.wb-sidebar\.is-expanding\s*\{[^}]*min-width:\s*var\(--wb-sidebar-titlebar-width\)/s);
  assert.match(css, /\.wb-sidebar\.is-pane-animating:not\(\.is-expanding\) \.wb-source-tree/s);
  assert.match(paneObjectTabsRule, /transform:\s*translateX\(var\(--wb-sidebar-tab-offset\)\)/);
  assert.match(css, /--wb-sidebar-tab-offset:\s*max\(0px, calc\(36px - var\(--wb-sidebar-slot-width\)\)\)/);
});

test("collapsed inspector toggle docks left of the AI entry button", () => {
  const titlebarInspectorRule = ruleBody(".wb-titlebar-inspector-controls");
  const collapsedRule = ruleBody(".wb-titlebar-inspector-controls.is-collapsed");
  const aiEntryRule = ruleBody(".wb-ai-entry-button");
  const collapseButtonRule = ruleBody(".wb-topbar-collapse-btn");

  assert.match(aiEntryRule, /right\s*:\s*176px/);
  assert.match(titlebarInspectorRule, /transition:[^;]*width var\(--wb-pane-collapse-duration\)/);
  assert.match(collapsedRule, /position\s*:\s*absolute/);
  assert.match(collapsedRule, /right\s*:\s*calc\(176px \+ 30px \+ 4px\)/);
  assert.match(collapsedRule, /z-index\s*:\s*40/);
  assert.match(collapsedRule, /padding\s*:\s*0/);
  assert.match(collapsedRule, /justify-content\s*:\s*center/);
  assert.match(collapsedRule, /background\s*:\s*transparent/);
  assert.match(collapseButtonRule, /min-width\s*:\s*28px/);
});

test("readability tokens keep metadata and disabled text legible in both themes", () => {
  const rootRule = ruleBody(":root");
  const darkRule = ruleBody('.mysql-workbench[data-theme="dark"]');

  assert.match(rootRule, /--wb-disabled:\s*#6f7782/);
  assert.match(rootRule, /--wb-field-placeholder:\s*#5f6670/);
  assert.match(rootRule, /--wb-quiet-text:\s*#4f5661/);
  assert.match(rootRule, /--wb-remark-text:\s*#3f4650/);
  assert.match(darkRule, /--wb-disabled:\s*#9ba3af/);
  assert.match(darkRule, /--wb-field-placeholder:\s*#a9b0ba/);
  assert.match(darkRule, /--wb-quiet-text:\s*#a8b0ba/);
  assert.match(darkRule, /--wb-remark-text:\s*#c2c8d0/);
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
  assert.match(thRule, /font-weight\s*:\s*700/);
  assert.match(commentRule, /font-size\s*:\s*12\.5px/);
  assert.match(commentRule, /line-height\s*:\s*1\.6/);
  assert.match(detailRule, /font-size\s*:\s*13px/);
  assert.match(tableCommentRule, /font-size\s*:\s*12\.5px/);
  assert.match(cellIdentityRule, /font-size\s*:\s*11px/);
});

test("table design grid keeps controls hit-testable in short split panes", () => {
  const bodyRule = ruleBody(".wb-design-body");
  const wrapRule = ruleBody(".wb-design-grid-wrap");
  const expandRule = ruleBody(".wb-design-comment-expand");

  assert.match(bodyRule, /overflow\s*:\s*auto/);
  assert.match(wrapRule, /flex\s*:\s*1 1 180px/);
  assert.match(wrapRule, /min-height\s*:\s*160px/);
  assert.match(expandRule, /min-width\s*:\s*36px/);
  assert.match(expandRule, /white-space\s*:\s*nowrap/);
});
