import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, "workbench.css"), "utf8");

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

test("keyboard focus states are explicit for polish-critical controls", () => {
  for (const selector of [
    ".wb-tab:focus-visible",
    ".wb-tab-close:focus-visible",
    ".wb-pane-toggle:focus-visible",
    ".wb-context-menu button:focus-visible",
  ]) {
    const body = ruleBody(selector);
    assert.match(body, /outline\s*:/, `${selector} should define an outline`);
    assert.match(body, /outline-offset\s*:/, `${selector} should define an outline offset`);
  }
});

test("open table chrome avoids competing horizontal divider lines", () => {
  const tabStripRule = ruleBody(".wb-object-tabs");
  const tabListRule = ruleBody(".wb-tab-list");
  const tabRule = ruleBody(".wb-tab");
  const paneHeaderRule = ruleBody(".wb-pane-header");
  const toolbarRule = ruleBody(".wb-table-toolbar");

  assert.match(tabStripRule, /overflow-x\s*:\s*auto/);
  assert.match(tabListRule, /flex\s*:\s*0\s+0\s+auto/);
  assert.match(tabListRule, /min-width\s*:\s*0/);
  assert.match(tabRule, /display\s*:\s*inline-flex/);
  assert.match(tabRule, /flex\s*:\s*0\s+0\s+auto/);
  assert.match(tabRule, /min-width\s*:\s*0/);
  assert.match(tabRule, /max-width\s*:\s*220px/);
  assert.doesNotMatch(tabRule, /container-type\s*:/);
  assert.doesNotMatch(css, /@container\s*\(max-width:\s*88px\)/);
  assert.doesNotMatch(css, /@container\s*\(max-width:\s*72px\)/);
  assert.match(ruleBody(".wb-tab-title"), /flex\s*:\s*0\s+1\s+auto/);
  assert.match(ruleBody(".wb-tab-close"), /flex\s*:\s*0\s+0\s+22px/);
  assert.doesNotMatch(tabStripRule, /border-bottom\s*:/);
  assert.doesNotMatch(paneHeaderRule, /border-bottom\s*:/);
  assert.doesNotMatch(toolbarRule, /border-bottom\s*:/);
});

test("inspector detail editor sits flush with the bottom workspace edge", () => {
  const textPanelRule = ruleBody(".wb-text-panel");
  const detailEditorRule = ruleBody(".wb-detail-editor");

  assert.match(textPanelRule, /padding-bottom\s*:\s*0/);
  assert.match(detailEditorRule, /flex\s*:\s*1/);
  assert.match(detailEditorRule, /min-height\s*:\s*0/);
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
  const statusRule = ruleBody(".wb-grid-statusbar");

  assert.match(gridRule, /font-size\s*:\s*13\.5px/);
  assert.match(thRule, /font-size\s*:\s*13px/);
  assert.match(thRule, /font-weight\s*:\s*700/);
  assert.match(commentRule, /font-size\s*:\s*12\.5px/);
  assert.match(commentRule, /line-height\s*:\s*1\.6/);
  assert.match(detailRule, /font-size\s*:\s*13px/);
  assert.match(statusRule, /font-size\s*:\s*12px/);
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
