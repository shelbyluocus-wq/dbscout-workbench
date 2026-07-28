import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dialog = readFileSync(join(__dirname, "components", "BatchExportDialog.vue"), "utf8");
const transfer = readFileSync(join(__dirname, "composables", "useBatchTransfer.js"), "utf8");

test("batch export can replace its selection with the current search results", () => {
  assert.match(dialog, /仅选搜索结果/);
  assert.match(dialog, /:indeterminate="allSelectionIndeterminate"/);
  assert.match(dialog, /setExportTableSelection\(value \? selectionScope\.value : \[\]\)/);
  assert.match(dialog, /匹配 \$\{filteredTables\.value\.length\}/);
  assert.match(dialog, /导出 \$\{selectedCount\} 张表/);
  assert.match(transfer, /function setExportTableSelection\(tableNames = \[\]\)/);
});
