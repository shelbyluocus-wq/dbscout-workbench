import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(__dirname, path), "utf8");

test("homepage tab stays first across restoration and tab dragging", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const tabs = read("./components/WorkbenchTabs.vue");

  assert.match(orchestrator, /normalizeHomeTabOrder\(workspace\)/);
  assert.match(tabs, /:draggable="tabKind\(tab\) !== 'home'"/);
  assert.match(tabs, /function\s+pinHomeTabFirst\(tabs\)/);
  assert.match(tabs, /function\s+normalizeDropPosition\(tabId, position\)/);
  assert.match(tabs, /tabKind\(targetTab\)\s*===\s*["']home["']/);
  assert.match(tabs, /pinHomeTabFirst\(previewDragOrder/);
});

test("homepage box selection starts outside the table-name column", () => {
  const tableList = read("./components/DatabaseTableList.vue");
  const beginBoxSelection = tableList.match(/function\s+beginBoxSelection\(event\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(beginBoxSelection, /\.wb-dbhome-object-name/);
  assert.match(beginBoxSelection, /\.wb-dbhome-table-header/);
  assert.match(beginBoxSelection, /\.wb-dbhome-empty-list/);
  assert.doesNotMatch(beginBoxSelection, /\.wb-dbhome-object-row/);
  assert.match(beginBoxSelection, /event\.preventDefault\(\)/);
  assert.match(tableList, /box\.width\s*<\s*4\s*\|\|\s*box\.height\s*<\s*4/);
});

test("homepage selection clears after clicks elsewhere without cancelling box selection", () => {
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");

  assert.match(home, /createHomepageSelectionDismissal/);
  assert.match(home, /document\.addEventListener\("click",\s*selectionDismissal\.handleDocumentClick,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /document\.removeEventListener\("click",\s*selectionDismissal\.handleDocumentClick,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /@box-selection-complete="selectionDismissal\.markBoxSelectionComplete"/);
  assert.match(tableList, /emit\("box-selection-complete"\)/);
});

test("homepage tab keeps the normal arrow cursor", () => {
  const styles = read("./workbench.css");
  const homeCursorRule = styles.match(
    /\.wb-tab\[data-kind="home"\],\s*\n\.wb-tab\[data-kind="home"\] \*\s*\{([^}]*)\}/s,
  )?.[1] || "";

  assert.match(homeCursorRule, /cursor:\s*default/);
  assert.match(homeCursorRule, /user-select:\s*none/);
});

test("tab drag preview keeps its transform transition after base tab styles", () => {
  const tabs = read("./components/WorkbenchTabs.vue");
  const styles = read("./workbench.css");
  const moveRule = styles.match(/\.wb-tab\.wb-tab-reorder-move\s*\{([^}]*)\}/s)?.[1] || "";

  assert.match(tabs, /<TransitionGroup name="wb-tab-reorder"/);
  assert.match(tabs, /@dragover\.prevent\.stop="markTabDragTarget\(tab\.id, \$event\)"/);
  assert.match(moveRule, /transform\s+0\.18s\s+cubic-bezier\(0\.25,\s*1,\s*0\.5,\s*1\)/);
});
