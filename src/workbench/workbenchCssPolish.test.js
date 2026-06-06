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
  const paneHeaderRule = ruleBody(".wb-pane-header");
  const toolbarRule = ruleBody(".wb-table-toolbar");

  assert.match(tabStripRule, /overflow-x\s*:\s*auto/);
  assert.doesNotMatch(tabStripRule, /overflow-x\s*:\s*scroll/);
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
  assert.match(closeRule, /min-height\s*:\s*24px/);
  assert.match(closeRule, /line-height\s*:\s*1/);
  assert.match(closeRule, /padding\s*:\s*0/);
});
