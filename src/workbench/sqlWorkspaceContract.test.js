import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(here, path), "utf8");

test("SQL workspace locks transaction targets and refreshes completion schema", () => {
  const workspace = read("./components/SqlQueryWorkspace.vue");

  assert.equal((workspace.match(/:disabled="tab\.running \|\| hasTransaction"/g) || []).length, 2);
  assert.match(workspace, /invokeWorkbench\("list_tables"/);
  assert.match(workspace, /invokeWorkbench\("get_table_schemas"/);
  assert.match(workspace, /:schema="completionSchema"/);
  assert.match(workspace, /:database="tab\.database"/);
  assert.match(workspace, /completionSchema\.value = placeholders\.map/);
});

test("SQL history and result controls expose keyboard-safe interaction contracts", () => {
  const history = read("./components/SqlHistoryDialog.vue");
  const results = read("./components/SqlResultGrid.vue");
  const workspace = read("./components/SqlQueryWorkspace.vue");

  assert.match(history, /useEscClose\(\(\) => props\.open/);
  assert.match(history, /class="wb-sql-history-open"/);
  assert.match(history, />最近文件 <small>/);
  assert.match(history, /aria-label="重命名收藏"/);
  assert.match(history, /Array\.isArray\(renameInputRef\.value\)/);
  assert.match(history, /emit\('open-file', file\)/);
  assert.doesNotMatch(history, /<i\s+role="button"/);
  assert.match(results, /:aria-sort="sortAria\(column\)"/);
  assert.match(results, /@keydown="handleGridKeydown"/);
  assert.match(results, /resultScrollRef\.value\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(results, /ref="resultScrollRef"/);
  assert.match(results, /@pointerenter="extendSelection/);
  assert.match(workspace, /aria-label="调整编辑器和结果区高度"/);
  assert.match(workspace, /@keydown\.up\.prevent="resizeWithKeyboard/);
  assert.match(workspace, /query\.historyOpen\.value = false;\s+void query\.openRecentFile/);
});

test("SQL workspace shows a write outcome instead of the idle placeholder", () => {
  const workspace = read("./components/SqlQueryWorkspace.vue");

  assert.match(workspace, /sqlResultPane/);
  assert.match(workspace, /resultPane === 'summary'/);
  assert.match(workspace, /sqlResultStatusText\(query\.currentResult\.value\)/);
  assert.match(workspace, /wb-sql-result-summary/);
  assert.match(workspace, /class="wb-sql-output-empty">执行查询后，结果会显示在这里/);
});

test("SQL toolbar responds to workspace width without squeezing controls", () => {
  const styles = read("./workbench.css");
  const workspaceRule = styles.match(/\.wb-sql-workspace\s*\{[^}]*\}/)?.[0] || "";
  const toolbarItemsRule = styles.match(/\.wb-sql-toolbar\s*>\s*button,\s*\.wb-sql-toolbar\s*>\s*label\s*\{[^}]*\}/)?.[0] || "";

  assert.match(workspaceRule, /container-type:\s*inline-size/);
  assert.match(toolbarItemsRule, /flex:\s*0 0 auto/);
  assert.match(styles, /@container\s*\(max-width:\s*860px\)[\s\S]*?\.wb-sql-toolbar\s*>\s*button\s*\{[^}]*width:\s*28px/);
  assert.doesNotMatch(styles, /@media\s*\(max-width:\s*860px\)/);
});
