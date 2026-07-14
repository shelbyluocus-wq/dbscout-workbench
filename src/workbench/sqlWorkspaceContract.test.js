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
