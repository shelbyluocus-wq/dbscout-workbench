import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("data table toolbar exposes direct actions and dropdown choices", () => {
  const grid = read("./components/DataGrid.vue");

  assert.match(grid, /ToolbarSplitButton/);
  assert.match(grid, /label="导出"[\s\S]*?@primary="emit\('export'\)"/);
  assert.match(grid, /label="导入"[\s\S]*?@primary="emit\('import'\)"/);
  assert.match(grid, /label="分屏"[\s\S]*?@primary="emit\('split-pane', 'right'\)"/);
  assert.match(grid, /批量导出/);
  assert.match(grid, /批量导入/);
  assert.match(grid, /左右分屏/);
  assert.match(grid, /上下分屏/);
  assert.doesNotMatch(grid, /wb-split-more-btn/);
});

test("freeze sits between match mode and export with direct and menu actions", () => {
  const grid = read("./components/DataGrid.vue");

  assert.match(
    grid,
    /primary-opens-menu[\s\S]*?label="冻结"[\s\S]*?label="导出"/,
  );
  assert.match(grid, /label="冻结"[\s\S]*?@primary="applyDefaultFreeze"/);
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

  for (const icon of ["freeze-cell", "freeze-row", "freeze-column", "unfreeze"]) {
    assert.match(grid, new RegExp(`icon: "${icon}"`));
    assert.match(component, new RegExp(`item\\.icon === '${icon}'`));
  }
});

test("toolbar dropdowns share one accessible floating menu component", () => {
  const component = read("./components/ToolbarSplitButton.vue");
  const styles = read("./workbench.css");

  assert.match(component, /<Teleport to="body">/);
  assert.match(component, /role="menu"/);
  assert.match(component, /aria-haspopup="menu"/);
  assert.match(component, /aria-expanded/);
  assert.match(component, /Escape/);
  assert.match(styles, /\.wb-toolbar-split-button/);
  assert.match(styles, /\.wb-toolbar-action-menu/);
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
