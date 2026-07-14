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
  assert.match(tabs, /:draggable="!tab\.opening && tabKind\(tab\) !== 'home'"/);
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

test("homepage direct typing is scoped to the focused pane and scrolls to its match", () => {
  const pane = read("./components/WorkbenchPane.vue");
  const home = read("./components/DatabaseHome.vue");
  const tableList = read("./components/DatabaseTableList.vue");

  assert.match(pane, /:active="isFocused"/);
  assert.match(home, /createHomepageTypeahead/);
  assert.match(home, /isEditableTypeaheadTarget/);
  assert.match(home, /document\.addEventListener\("keydown",\s*handleTypeaheadKeydown,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /scrollTableIntoView/);
  assert.match(home, /class="wb-dbhome-typeahead"/);
  assert.match(tableList, /function\s+scrollTableIntoView\(name\)/);
});

test("homepage releases search focus and keeps direct typing active after non-control clicks", () => {
  const home = read("./components/DatabaseHome.vue");
  const styles = read("./workbench.css");

  assert.match(home, /function\s+handleHomeSurfaceClick\(event\)/);
  assert.match(home, /homeRootRef\.value\?\.focus\?\.\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(home, /function\s+handleDocumentPointerDown\(event\)/);
  assert.match(home, /input\.setSelectionRange\?\.\(end,\s*end\)/);
  assert.match(home, /input\.blur\(\)/);
  assert.match(home, /document\.addEventListener\("pointerdown",\s*handleDocumentPointerDown,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /document\.removeEventListener\("pointerdown",\s*handleDocumentPointerDown,\s*\{\s*capture:\s*true\s*\}\)/);
  assert.match(home, /tabindex="-1"/);
  assert.match(home, /@click\.capture="handleHomeSurfaceClick"/);
  assert.match(styles, /\.wb-database-home:focus\s*\{[^}]*outline:\s*none/s);
});

test("homepage omits selection summaries and the footer action bar", () => {
  const home = read("./components/DatabaseHome.vue");

  assert.doesNotMatch(home, /\{\{\s*selectedCount\s*\}\}\s*已选/);
  assert.doesNotMatch(home, /wb-dbhome-status/);
  assert.doesNotMatch(home, /打开选中/);
  assert.doesNotMatch(home, /function\s+openSelectedTables/);
});

test("homepage context menu deletes the complete multi-table selection after confirmation", () => {
  const home = read("./components/DatabaseHome.vue");
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(home, /deleteMenuLabel\s*=\s*computed\(\(\)\s*=>\s*menu\.selectedNames\.length\s*>\s*1\s*\?\s*`删除 \$\{menu\.selectedNames\.length\} 张表`\s*:\s*"删除表"\)/);
  assert.match(home, /menu\.selectedNames\s*=\s*\[\.\.\.controller\.selectedNames\.value\]/);
  assert.match(home, /<button[^>]*class="danger"[^>]*@click="deleteSelection\(menu\.tableName, menu\.selectedNames\)"[^>]*>\{\{ deleteMenuLabel \}\}<\/button>/);
  assert.match(home, /if\s*\(tableName\s*&&\s*!controller\.selectedSet\.value\.has\(tableName\)\)\s*controller\.selectTable\(tableName,\s*\{\}\)/);
  assert.match(home, /tableNames,\s*\n\s*\}\)/);
  assert.match(orchestrator, /const\s+confirmed\s*=\s*await\s+confirmDialogConfirm\(/);
  assert.match(orchestrator, /title:\s*tableNames\.length\s*===\s*1\s*\?\s*"删除表"\s*:\s*`删除 \$\{tableNames\.length\} 张表`/);
  assert.match(orchestrator, /message:\s*`即将从 \$\{source\.database\} 删除以下表`/);
  assert.match(orchestrator, /items:\s*tableNames/);
  assert.match(orchestrator, /note:\s*"删除表会同时移除数据和结构，此操作不可撤销。"/);
  assert.match(orchestrator, /if\s*\(!confirmed\)\s*return/);
  assert.match(orchestrator, /invokeWorkbench\("drop_tables",\s*\{[\s\S]*?tables:\s*tableNames/);
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
